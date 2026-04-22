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

/**
 * Convert a completed Responses API body into an SSE Response
 * suitable for clients that called with stream: true.
 *
 * Emits the minimum event sequence the OpenAI Python SDK expects:
 *   response.created → output items → response.completed
 *
 * Each event's data payload must include:
 *   - `type` matching the SSE event name (SDK uses this for discriminated union)
 *   - `sequence_number` (incrementing integer)
 *   - `item_id` on content/text/function_call events
 *
 * `response.created` and `response.completed` wrap the body under a `response` key.
 */
export function responsesBodyToSSEResponse(
    body: Record<string, unknown>,
): Response {
    const encoder = new TextEncoder();
    const events: string[] = [];
    let seq = 0;

    // Build a Response-shaped object with required SDK fields
    const now = Date.now() / 1000;
    const responseBase = {
        ...body,
        created_at: (body.created_at as number) ?? now,
        tools: (body.tools as unknown[]) ?? [],
        tool_choice: (body.tool_choice as string) ?? 'auto',
        parallel_tool_calls: (body.parallel_tool_calls as boolean) ?? true,
    };

    // 1. response.created — response with in_progress status, empty output
    const createdResponse = { ...responseBase, status: 'in_progress', output: [] };
    events.push(`event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', sequence_number: seq++, response: createdResponse,
    })}\n\n`);

    // 2. Per-output-item events
    const output = (body.output || []) as Array<Record<string, unknown>>;
    for (let oi = 0; oi < output.length; oi++) {
        const item = output[oi]!;
        const itemId = (item.id as string) ?? `item_${oi}`;

        if (item.type === 'message') {
            const itemWithId = { ...item, id: itemId, content: [] };
            events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
                type: 'response.output_item.added', sequence_number: seq++,
                output_index: oi, item: itemWithId,
            })}\n\n`);

            const content = (item.content || []) as Array<Record<string, unknown>>;
            for (let ci = 0; ci < content.length; ci++) {
                const part = content[ci]!;
                if (part.type === 'output_text') {
                    events.push(`event: response.content_part.added\ndata: ${JSON.stringify({
                        type: 'response.content_part.added', sequence_number: seq++,
                        output_index: oi, content_index: ci, item_id: itemId,
                        part: { type: 'output_text', text: '', annotations: [] },
                    })}\n\n`);
                    events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({
                        type: 'response.output_text.delta', sequence_number: seq++,
                        output_index: oi, content_index: ci, item_id: itemId,
                        delta: part.text,
                    })}\n\n`);
                    events.push(`event: response.output_text.done\ndata: ${JSON.stringify({
                        type: 'response.output_text.done', sequence_number: seq++,
                        output_index: oi, content_index: ci, item_id: itemId,
                        text: part.text,
                    })}\n\n`);
                    events.push(`event: response.content_part.done\ndata: ${JSON.stringify({
                        type: 'response.content_part.done', sequence_number: seq++,
                        output_index: oi, content_index: ci, item_id: itemId,
                        part: { ...part, annotations: [] },
                    })}\n\n`);
                }
            }

            const doneItem = { ...item, id: itemId };
            events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
                type: 'response.output_item.done', sequence_number: seq++,
                output_index: oi, item: doneItem,
            })}\n\n`);
        } else if (item.type === 'function_call') {
            const itemWithId = { ...item, id: itemId, arguments: '' };
            events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
                type: 'response.output_item.added', sequence_number: seq++,
                output_index: oi, item: itemWithId,
            })}\n\n`);
            events.push(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
                type: 'response.function_call_arguments.delta', sequence_number: seq++,
                output_index: oi, item_id: itemId,
                delta: item.arguments,
            })}\n\n`);
            events.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
                type: 'response.function_call_arguments.done', sequence_number: seq++,
                output_index: oi, item_id: itemId,
                name: item.name,
                arguments: item.arguments,
            })}\n\n`);
            const doneItem = { ...item, id: itemId };
            events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
                type: 'response.output_item.done', sequence_number: seq++,
                output_index: oi, item: doneItem,
            })}\n\n`);
        }
    }

    // 3. response.completed — full response with completed status
    const completedResponse = { ...responseBase, status: 'completed' };
    events.push(`event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', sequence_number: seq++, response: completedResponse,
    })}\n\n`);

    const stream = new ReadableStream({
        start(controller) {
            for (const ev of events) {
                controller.enqueue(encoder.encode(ev));
            }
            controller.close();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
