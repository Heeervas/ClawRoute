/**
 * ClawRoute Responses API Adapter
 *
 * Translates between OpenAI Responses API format and Chat Completions format.
 * Used by the /v1/responses endpoint.
 */

import type { ChatMessage, ChatCompletionRequest, ContentPart, ToolDefinition } from './types.js';

/**
 * Convert Responses API input items to Chat Completions messages.
 *
 * Handles: developer, user (text + multimodal), assistant messages,
 * function_call (with adjacent merging), and function_call_output.
 */
export function responsesInputToChatMessages(input: unknown[]): ChatMessage[] {
    const messages: ChatMessage[] = [];

    for (const item of input) {
        const obj = item as Record<string, unknown>;

        // developer → system
        if (obj.role === 'developer') {
            messages.push({ role: 'system', content: obj.content as string });
            continue;
        }

        // user message (string or multimodal array)
        if (obj.role === 'user') {
            const content = obj.content;
            if (typeof content === 'string') {
                messages.push({ role: 'user', content });
            } else if (Array.isArray(content)) {
                // Convert Responses API content parts to CC format
                const ccParts: ContentPart[] = content.map((part: Record<string, unknown>) => {
                    if (part.type === 'input_text') {
                        return { type: 'text' as const, text: part.text as string };
                    }
                    if (part.type === 'input_image') {
                        return {
                            type: 'image_url' as const,
                            image_url: { url: part.image_url as string },
                        };
                    }
                    return part as unknown as ContentPart;
                });
                messages.push({ role: 'user', content: ccParts });
            }
            continue;
        }

        // assistant message with output_text
        if (obj.type === 'message' && obj.role === 'assistant') {
            const contentArr = obj.content as Array<Record<string, unknown>>;
            const textPart = contentArr?.find((p) => p.type === 'output_text');
            messages.push({
                role: 'assistant',
                content: (textPart?.text as string) ?? null,
            });
            continue;
        }

        // function_call → assistant message with tool_calls (merge adjacent)
        if (obj.type === 'function_call') {
            const toolCall = {
                id: obj.call_id as string,
                type: 'function' as const,
                function: {
                    name: obj.name as string,
                    arguments: obj.arguments as string,
                },
            };

            // Merge into previous assistant message if it has tool_calls
            const prev = messages[messages.length - 1];
            if (prev && prev.role === 'assistant' && prev.tool_calls) {
                prev.tool_calls.push(toolCall);
            } else {
                messages.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: [toolCall],
                });
            }
            continue;
        }

        // function_call_output → tool message
        if (obj.type === 'function_call_output') {
            messages.push({
                role: 'tool',
                tool_call_id: obj.call_id as string,
                content: obj.output as string,
            });
            continue;
        }
    }

    return messages;
}

/**
 * Translate a full Responses API request body to a Chat Completions request.
 */
export function responsesBodyToChatCompletions(
    body: Record<string, unknown>,
): ChatCompletionRequest {
    const messages = responsesInputToChatMessages(body.input as unknown[]);

    // Prepend instructions as system message if present
    if (typeof body.instructions === 'string' && body.instructions.length > 0) {
        messages.unshift({ role: 'system', content: body.instructions });
    }

    const ccRequest: ChatCompletionRequest = {
        model: body.model as string,
        messages,
    };

    // Optional scalar fields
    if (body.temperature !== undefined) ccRequest.temperature = body.temperature as number;
    if (body.max_output_tokens !== undefined) ccRequest.max_tokens = body.max_output_tokens as number;
    if (body.top_p !== undefined) ccRequest.top_p = body.top_p as number;
    if (body.stream !== undefined) ccRequest.stream = body.stream as boolean;

    // Tools: flat Responses format → nested CC format
    if (Array.isArray(body.tools)) {
        ccRequest.tools = (body.tools as Array<Record<string, unknown>>).map((t) => ({
            type: 'function' as const,
            function: {
                name: t.name as string,
                description: t.description as string | undefined,
                parameters: t.parameters as object | undefined,
                strict: t.strict as boolean | undefined,
            },
        })) as ToolDefinition[];
    }

    if (body.tool_choice !== undefined) ccRequest.tool_choice = body.tool_choice as string | object;

    return ccRequest;
}

/**
 * Convert a Chat Completions response to Responses API format (non-streaming).
 */
export function chatCompletionToResponsesBody(
    ccResponse: Record<string, unknown>,
): Record<string, unknown> {
    const choices = ccResponse.choices as Array<Record<string, unknown>> | undefined;
    const firstChoice = choices?.[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;

    const output: unknown[] = [];

    if (message) {
        const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;

        if (toolCalls && toolCalls.length > 0) {
            // Tool call response → function_call items
            for (const tc of toolCalls) {
                const fn = tc.function as Record<string, unknown>;
                output.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: fn.name,
                    arguments: fn.arguments,
                });
            }
        } else {
            // Text response → message with output_text
            output.push({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: message.content as string }],
            });
        }
    }

    const usage = ccResponse.usage as Record<string, number> | undefined;

    return {
        id: ccResponse.id,
        object: 'response',
        model: ccResponse.model,
        status: 'completed',
        output,
        ...(usage && {
            usage: {
                input_tokens: usage.prompt_tokens,
                output_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
            },
        }),
    };
}
