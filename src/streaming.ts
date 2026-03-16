/**
 * ClawRoute Streaming Handler
 *
 * SSE (Server-Sent Events) transparent passthrough with zero-latency streaming.
 * Parses chunks to extract token counts for logging.
 */

import { safeJsonParse } from './utils.js';

/**
 * Result of streaming a response.
 */
export interface StreamResult {
    /** Estimated input tokens (from usage in final chunk if available) */
    inputTokens: number;
    /** Estimated output tokens (from usage or chunk count) */
    outputTokens: number;
    /** Whether tool calls were detected in the stream */
    hadToolCalls: boolean;
    /** Any error that occurred during streaming */
    error: string | null;
}

/**
 * Stream an SSE response from upstream to the client.
 *
 * This function pipes chunks with zero buffering delay.
 *
 * @param upstreamResponse - The response from the upstream LLM provider
 * @param writer - The writable stream to write to
 * @returns Streaming result with token counts
 */
export async function pipeStream(
    upstreamResponse: Response,
    writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<StreamResult> {
    const result: StreamResult = {
        inputTokens: 0,
        outputTokens: 0,
        hadToolCalls: false,
        error: null,
    };

    const body = upstreamResponse.body;
    if (!body) {
        result.error = 'No response body';
        return result;
    }

    const reader = body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let chunkCount = 0;
    let buffer = '';
    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => reader.cancel('idle timeout'), 45_000);

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (idleTimer) { clearTimeout(idleTimer); }

            if (done) {
                // Process any remaining buffer
                if (buffer.trim()) {
                    processSSEBuffer(buffer, result);
                }
                break;
            }

            idleTimer = setTimeout(() => reader.cancel('idle timeout'), 45_000);

            // Write immediately to client (zero buffering)
            await writer.write(value);

            // Decode and process for token counting
            buffer += decoder.decode(value, { stream: true });
            chunkCount++;

            // Process complete SSE messages from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

            for (const line of lines) {
                processSSELine(line, result);
            }
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : 'Stream error';

        // Try to send a [DONE] marker to cleanly close the stream
        try {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch {
            // Ignore errors closing the stream
        }
    } finally {
        if (idleTimer) { clearTimeout(idleTimer); }
        try {
            reader.releaseLock();
        } catch {
            // Ignore
        }
    }

    // If no usage data was found, estimate from chunk count
    if (result.outputTokens === 0 && chunkCount > 0) {
        // Rough estimate: ~1-2 tokens per chunk on average
        result.outputTokens = Math.ceil(chunkCount * 1.5);
    }

    return result;
}

/**
 * Process a single SSE line for token counting.
 */
function processSSELine(line: string, result: StreamResult): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith('data:')) {
        return;
    }

    const data = trimmed.slice(5).trim();

    if (data === '[DONE]') {
        return;
    }

    const parsed = safeJsonParse<StreamChunk>(data);
    if (!parsed) {
        return;
    }

    // Check for tool calls
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.tool_calls && delta.tool_calls.length > 0) {
        result.hadToolCalls = true;
    }

    // Check for usage (usually in the final chunk)
    if (parsed.usage) {
        if (parsed.usage.prompt_tokens) {
            result.inputTokens = parsed.usage.prompt_tokens;
        }
        if (parsed.usage.completion_tokens) {
            result.outputTokens = parsed.usage.completion_tokens;
        }
    }
}

/**
 * Process remaining buffer for any usage data.
 */
function processSSEBuffer(buffer: string, result: StreamResult): void {
    const lines = buffer.split('\n');
    for (const line of lines) {
        processSSELine(line, result);
    }
}

/**
 * Streaming chunk structure (partial).
 */
interface StreamChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: Array<{
        index: number;
        delta: {
            content?: string;
            role?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

/**
 * Stream an Ollama native NDJSON response, converting to OpenAI SSE format.
 */
export async function pipeOllamaStream(
    upstreamResponse: Response,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    modelId: string
): Promise<StreamResult> {
    const result: StreamResult = {
        inputTokens: 0,
        outputTokens: 0,
        hadToolCalls: false,
        error: null,
    };

    const body = upstreamResponse.body;
    if (!body) {
        result.error = 'No response body';
        return result;
    }

    const reader = body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => reader.cancel('idle timeout'), 45_000);

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (idleTimer) { clearTimeout(idleTimer); }

            if (done) {
                if (buffer.trim()) {
                    await processOllamaLine(buffer.trim(), result, writer, encoder, modelId);
                }
                break;
            }

            idleTimer = setTimeout(() => reader.cancel('idle timeout'), 45_000);

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    await processOllamaLine(trimmed, result, writer, encoder, modelId);
                }
            }
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : 'Stream error';

        try {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch {
            // Ignore
        }
    } finally {
        if (idleTimer) { clearTimeout(idleTimer); }
        try {
            reader.releaseLock();
        } catch {
            // Ignore
        }
    }

    return result;
}

async function processOllamaLine(
    line: string,
    result: StreamResult,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: InstanceType<typeof TextEncoder>,
    modelId: string
): Promise<void> {
    const parsed = safeJsonParse<OllamaChunk>(line);
    if (!parsed) return;

    const msg = parsed.message;
    const isDone = parsed.done === true;

    // Build OpenAI-compatible SSE chunk
    const toolCalls = msg?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
        result.hadToolCalls = true;
    }

    const delta: Record<string, unknown> = {};
    if (msg?.role) delta.role = msg.role;
    if (msg?.content) delta.content = msg.content;
    if (toolCalls && toolCalls.length > 0) {
        delta.tool_calls = toolCalls.map((tc, i) => ({
            index: i,
            id: `call_${i}`,
            type: 'function' as const,
            function: {
                name: tc.function?.name ?? '',
                arguments: typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments ?? {}),
            },
        }));
    }

    const finishReason = isDone ? (parsed.done_reason ?? 'stop') : null;

    const chunk: Record<string, unknown> = {
        id: 'chatcmpl-ollama',
        object: 'chat.completion.chunk',
        model: modelId,
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason,
        }],
    };

    if (isDone && parsed.prompt_eval_count != null) {
        const inputTokens = parsed.prompt_eval_count;
        const outputTokens = parsed.eval_count ?? 0;
        result.inputTokens = inputTokens;
        result.outputTokens = outputTokens;
        chunk.usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
        };
    }

    const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
    await writer.write(encoder.encode(sseData));

    if (isDone) {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
    }
}

interface OllamaChunk {
    model?: string;
    created_at?: string;
    message?: {
        role?: string;
        content?: string;
        tool_calls?: Array<{
            function?: {
                name?: string;
                arguments?: unknown;
            };
        }>;
    };
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
}

/**
 * Convert an Ollama non-streaming response to OpenAI format.
 */
export function adaptOllamaResponse(rawBody: string, modelId: string): string {
    const parsed = safeJsonParse<OllamaChunk>(rawBody);
    if (!parsed) return rawBody;

    const msg = parsed.message;
    const message: Record<string, unknown> = {
        role: msg?.role ?? 'assistant',
        content: msg?.content ?? '',
    };

    if (msg?.tool_calls && msg.tool_calls.length > 0) {
        message.tool_calls = msg.tool_calls.map((tc, i) => ({
            id: `call_${i}`,
            type: 'function',
            function: {
                name: tc.function?.name ?? '',
                arguments: typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments ?? {}),
            },
        }));
    }

    const inputTokens = parsed.prompt_eval_count ?? 0;
    const outputTokens = parsed.eval_count ?? 0;

    const openaiResponse = {
        id: 'chatcmpl-ollama',
        object: 'chat.completion',
        model: modelId,
        choices: [{
            index: 0,
            message,
            finish_reason: parsed.done_reason ?? 'stop',
        }],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
        },
    };

    return JSON.stringify(openaiResponse);
}

/**
 * Get SSE headers for streaming responses.
 *
 * @returns Headers object for SSE
 */
export function getSSEHeaders(): Record<string, string> {
    return {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Prevents nginx buffering
    };
}

/**
 * Create a streaming response from a readable stream.
 *
 * @param stream - The readable stream
 * @param headers - Additional headers to include
 * @returns A Response object
 */
export function createStreamingResponse(
    stream: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {}
): Response {
    return new Response(stream, {
        status: 200,
        headers: {
            ...getSSEHeaders(),
            ...headers,
        },
    });
}

/**
 * Create a TransformStream that counts tokens while passing through data.
 *
 * @param onChunk - Callback for each chunk (for token counting)
 * @returns TransformStream
 */
export function createTokenCountingStream(
    onChunk: (text: string) => void
): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();

    return new TransformStream({
        transform(chunk, controller) {
            // Pass through immediately
            controller.enqueue(chunk);

            // Decode for counting (async after passthrough)
            const text = decoder.decode(chunk, { stream: true });
            onChunk(text);
        },
    });
}
