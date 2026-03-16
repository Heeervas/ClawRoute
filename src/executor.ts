/**
 * ClawRoute Request Executor
 *
 * Handles LLM API calls with proper safety for streaming and tool calls.
 * Implements escalation logic with strict rules:
 * - Streaming responses are NEVER interrupted once started
 * - Tool calls in responses block retry (no duplicate side effects)
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ClawRouteConfig,
    ExecutionResult,
    RoutingDecision,
    ClassificationResult,
    TaskTier,
} from './types.js';
import { getApiBaseUrl, getAuthHeader, calculateCost, getProviderForModel } from './models.js';
import { getApiKey } from './config.js';
import { getEscalatedModel } from './router.js';
import { validateResponse } from './validator.js';
import { pipeStream, pipeOllamaStream, adaptOllamaResponse, getSSEHeaders, StreamResult } from './streaming.js';
import { ProxyAgent } from 'undici';

// Lazily-created proxy agent for external LLM API calls.
// Node 20's native fetch (undici) does NOT read http_proxy/https_proxy env vars
// automatically — we must pass a ProxyAgent explicitly for external providers.
const _httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
let _proxyAgent: ProxyAgent | null = null;
function getProxyAgent(): ProxyAgent | null {
    if (!_httpsProxy) return null;
    if (!_proxyAgent) _proxyAgent = new ProxyAgent(_httpsProxy);
    return _proxyAgent;
}
import { sleep, estimateMessagesTokens, safeJsonParse } from './utils.js';

/**
 * Check if escalation is allowed based on plan and tier.
 * Free plan can only escalate within cheap tiers (HEARTBEAT → SIMPLE).
 *
 * @param currentTier - The current tier
 * @param config - The config
 * @returns True if escalation is allowed
 */
function canEscalate(_currentTier: TaskTier, _config: ClawRouteConfig): boolean {
    // Community Edition: Escalation always allowed (logic handled by config settings)
    return true;
}

/**
 * Execute a request through the routing layer.
 *
 * @param request - The original chat completion request
 * @param routingDecision - The routing decision made
 * @param classification - The classification result
 * @param config - The ClawRoute configuration
 * @returns Execution result with response and metadata
 */
export async function executeRequest(
    request: ChatCompletionRequest,
    routingDecision: RoutingDecision,
    _classification: ClassificationResult,
    config: ClawRouteConfig
): Promise<ExecutionResult> {
    const startTime = Date.now();
    const escalationChain: string[] = [];
    let currentModel = routingDecision.routedModel;
    let escalated = false;
    let response: Response;
    let hadToolCalls = false;
    let inputTokens = estimateMessagesTokens(request.messages);
    let outputTokens = 0;

    // Track current tier for escalation
    let currentTier = routingDecision.tier;

    // Add initial model to chain
    escalationChain.push(currentModel);

    if (request.stream) {
        // STREAMING REQUEST
        // We can only retry BEFORE streaming starts
        // Once we start streaming, we're committed

        let retryCount = 0;
        const maxRetries = config.escalation.enabled ? config.escalation.maxRetries : 0;

        while (retryCount <= maxRetries) {
            try {
                // Make the request to the current model
                response = await makeProviderRequest(request, currentModel, config, currentTier);

                // Check if we got an error BEFORE streaming starts
                if (!response.ok) {
                    // Can retry if we haven't started streaming
                    // v1.1: Also check canEscalate for Free plan restrictions
                    if (
                        config.escalation.enabled &&
                        retryCount < maxRetries &&
                        routingDecision.safeToRetry &&
                        canEscalate(currentTier, config)
                    ) {
                        const escalation = getEscalatedModel(currentTier, config);
                        if (escalation) {
                            await sleep(config.escalation.retryDelayMs);
                            currentModel = escalation.model;
                            currentTier = escalation.tier;
                            escalationChain.push(currentModel);
                            escalated = true;
                            retryCount++;
                            continue;
                        }
                    }

                    // Can't retry or no escalation available
                    // Fall back to original model if configured
                    if (config.escalation.alwaysFallbackToOriginal && currentModel !== routingDecision.originalModel) {
                        currentModel = routingDecision.originalModel;
                        escalationChain.push(currentModel);
                        response = await makeProviderRequest(request, currentModel, config, currentTier);
                    }
                }

                // We have a response (success or final failure)
                // For streaming, we need to pipe it through
                break;
            } catch (error) {
                // Network error or similar
                if (
                    config.escalation.enabled &&
                    retryCount < maxRetries &&
                    routingDecision.safeToRetry
                ) {
                    const escalation = getEscalatedModel(currentTier, config);
                    if (escalation) {
                        await sleep(config.escalation.retryDelayMs);
                        currentModel = escalation.model;
                        currentTier = escalation.tier;
                        escalationChain.push(currentModel);
                        escalated = true;
                        retryCount++;
                        continue;
                    }
                }

                // Fall back to original model
                if (config.escalation.alwaysFallbackToOriginal) {
                    currentModel = routingDecision.originalModel;
                    escalationChain.push(currentModel);
                    try {
                        response = await makeProviderRequest(request, currentModel, config, currentTier);
                        break;
                    } catch {
                        // Even original model failed - return error response
                        response = createErrorResponse('All models failed to respond');
                        break;
                    }
                }

                response = createErrorResponse(error instanceof Error ? error.message : 'Request failed');
                break;
            }
        }

        // Ollama first-token probe — must happen BEFORE committing to the stream.
        //
        // Problem: Ollama returns HTTP 200 immediately (connection accepted) even
        // when it is about to hang (CPU-starved, overloaded, or processing a very
        // large prompt).  The escalation logic in the retry loop above only fires
        // on !response.ok or a network exception.  Once we call
        //   return new Response(readable, { status: 200 })
        // we have committed — escalation becomes impossible.
        //
        // Fix: peek for the very first byte of data from Ollama with a 30-second
        // timeout.  If nothing arrives within 30 s we abort and try the tier's
        // fallback model (e.g. openrouter/google/gemini-2.5-flash) instead.
        if (response!.ok && response!.body) {
            if (getProviderForModel(currentModel) === 'ollama') {
                const peeked = await peekFirstOllamaChunk(response!.body, 15_000);
                if (peeked === null) {
                    // No bytes in 15 s — attempt the tier's fallback model.
                    console.log(`[stream] Ollama first-token timeout (15s) for ${currentModel} — escalating`);
                    const escalation =
                        config.escalation.enabled && canEscalate(currentTier, config)
                            ? getEscalatedModel(currentTier, config)
                            : null;
                    if (escalation) {
                        console.log(`[stream] Escalating to ${escalation.model} (tier: ${escalation.tier})`);
                        await sleep(config.escalation.retryDelayMs);
                        currentModel = escalation.model;
                        currentTier = escalation.tier;
                        escalationChain.push(currentModel);
                        escalated = true;
                        try {
                            response = await makeProviderRequest(
                                request, currentModel, config, currentTier,
                            );
                        } catch (err) {
                            response = createErrorResponse(
                                err instanceof Error ? err.message : 'Fallback failed',
                            );
                        }
                    } else {
                        response = createErrorResponse(
                            'Ollama timed out: no response within 15 s',
                        );
                    }
                } else {
                    // Got first chunk — swap body with reassembled stream.
                    response = new Response(peeked, {
                        status: response!.status,
                        statusText: response!.statusText,
                        headers: new Headers(),
                    });
                }
            }
        }

        // Create streaming response with token counting
        if (response!.ok && response!.body) {
            const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
            const writer = writable.getWriter();

            // Build the result object first so the streamPromise closure can update it
            // once the stream is fully consumed and final token counts are known.
            const streamResponse = new Response(readable, {
                status: response!.status,
                statusText: response!.statusText,
                headers: {
                    ...getSSEHeaders(),
                    'X-ClawRoute-Model': currentModel,
                    'X-ClawRoute-Tier': currentTier,
                    'X-ClawRoute-Escalated': String(escalated),
                },
            });
            const execResult = buildExecutionResult(
                streamResponse,
                routingDecision,
                currentModel,
                escalated,
                escalationChain,
                inputTokens,
                outputTokens,
                hadToolCalls,
                startTime
            );

            // Start piping in the background
            const provider = getProviderForModel(currentModel);
            (provider === 'ollama'
                ? pipeOllamaStream(response!, writer, currentModel)
                : pipeStream(response!, writer)
            ).then(async (streamResult: StreamResult) => {
                hadToolCalls = streamResult.hadToolCalls;
                if (streamResult.inputTokens > 0) inputTokens = streamResult.inputTokens;
                if (streamResult.outputTokens > 0) outputTokens = streamResult.outputTokens;
                // Close writer; ignore if client already disconnected
                await writer.close().catch(() => {});
            }).catch(() => {
                // Stream error — writer may already be errored/closed
            }).finally(() => {
                // Always back-fill costs and log, even on client disconnect or stream error.
                // This ensures every upstream API call is recorded in the DB.
                execResult.inputTokens = inputTokens;
                execResult.outputTokens = outputTokens;
                execResult.hadToolCalls = hadToolCalls;
                execResult.originalCostUsd = calculateCost(routingDecision.originalModel, inputTokens, outputTokens);
                execResult.actualCostUsd = calculateCost(currentModel, inputTokens, outputTokens);
                execResult.savingsUsd = Math.max(0, execResult.originalCostUsd - execResult.actualCostUsd);
                execResult.logWhenDone?.();
            });

            return execResult;
        }

        // Non-streaming response or error.
        // Raw fetch responses have "immutable" headers guard (Fetch spec § 7.1);
        // Hono's CORS middleware crashes if it tries to set headers on them.
        // Wrap in a fresh Response with mutable headers before returning.
        const errHeaders = new Headers();
        errHeaders.set('Content-Type', response!.headers.get('Content-Type') ?? 'application/json');
        errHeaders.set('X-ClawRoute-Model', currentModel);
        errHeaders.set('X-ClawRoute-Tier', currentTier);
        errHeaders.set('X-ClawRoute-Escalated', String(escalated));
        const wrappedStreamError = new Response(response!.body, {
            status: response!.status,
            statusText: response!.statusText,
            headers: errHeaders,
        });
        return buildExecutionResult(
            wrappedStreamError,
            routingDecision,
            currentModel,
            escalated,
            escalationChain,
            inputTokens,
            outputTokens,
            hadToolCalls,
            startTime
        );
    } else {
        // NON-STREAMING REQUEST
        // We can fully validate and retry since nothing has been sent to the client

        let retryCount = 0;
        const maxRetries = config.escalation.enabled ? config.escalation.maxRetries : 0;
        let responseBody: ChatCompletionResponse | null = null;
        let finalBodyText: string | null = null;

        while (retryCount <= maxRetries) {
            try {
                response = await makeProviderRequest(request, currentModel, config, currentTier);

                // Parse response body for validation
                if (response.ok) {
                    let bodyText = await response.text();

                    // Adapt Ollama native response to OpenAI format
                    const currentProvider = getProviderForModel(currentModel);
                    if (currentProvider === 'ollama') {
                        bodyText = adaptOllamaResponse(bodyText, currentModel);
                    }
                    responseBody = safeJsonParse<ChatCompletionResponse>(bodyText);

                    // Validate the response
                    const validation = validateResponse(response, responseBody, request, currentTier);
                    hadToolCalls = validation.hadToolCalls;

                    if (!validation.valid) {
                        // Response is invalid - can we retry?
                        // CRITICAL: Don't retry if there were tool calls
                        if (
                            validation.hadToolCalls ||
                            !routingDecision.safeToRetry ||
                            !config.escalation.onlyRetryWithoutToolCalls
                        ) {
                            // Can't retry - tool calls may have been executed
                            // Return the response as-is
                            break;
                        }

                        if (config.escalation.enabled && retryCount < maxRetries) {
                            const escalation = getEscalatedModel(currentTier, config);
                            if (escalation) {
                                await sleep(config.escalation.retryDelayMs);
                                currentModel = escalation.model;
                                currentTier = escalation.tier;
                                escalationChain.push(currentModel);
                                escalated = true;
                                retryCount++;
                                continue;
                            }
                        }
                    }

                    // Valid response or can't retry
                    // Recreate response from body text (since we consumed it)
                    finalBodyText = bodyText;
                    response = new Response(bodyText, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                    break;
                } else {
                    // HTTP error
                    if (
                        config.escalation.enabled &&
                        retryCount < maxRetries &&
                        routingDecision.safeToRetry
                    ) {
                        const escalation = getEscalatedModel(currentTier, config);
                        if (escalation) {
                            await sleep(config.escalation.retryDelayMs);
                            currentModel = escalation.model;
                            currentTier = escalation.tier;
                            escalationChain.push(currentModel);
                            escalated = true;
                            retryCount++;
                            continue;
                        }
                    }

                    // Fall back to original
                    if (config.escalation.alwaysFallbackToOriginal && currentModel !== routingDecision.originalModel) {
                        currentModel = routingDecision.originalModel;
                        escalationChain.push(currentModel);
                        response = await makeProviderRequest(request, currentModel, config, currentTier);
                    }
                    break;
                }
            } catch (error) {
                // Network error or timeout (AbortController fires after 30s for Ollama)
                console.log(`[non-stream] ${currentModel} error: ${error instanceof Error ? error.message : error} — attempting escalation`);
                if (
                    config.escalation.enabled &&
                    retryCount < maxRetries &&
                    routingDecision.safeToRetry
                ) {
                    const escalation = getEscalatedModel(currentTier, config);
                    if (escalation) {
                        console.log(`[non-stream] Escalating to ${escalation.model} (tier: ${escalation.tier})`);
                        await sleep(config.escalation.retryDelayMs);
                        currentModel = escalation.model;
                        currentTier = escalation.tier;
                        escalationChain.push(currentModel);
                        escalated = true;
                        retryCount++;
                        continue;
                    }
                }

                // Fall back to original
                if (config.escalation.alwaysFallbackToOriginal) {
                    currentModel = routingDecision.originalModel;
                    escalationChain.push(currentModel);
                    try {
                        response = await makeProviderRequest(request, currentModel, config, currentTier);
                        break;
                    } catch {
                        response = createErrorResponse('All models failed');
                        break;
                    }
                }

                response = createErrorResponse(error instanceof Error ? error.message : 'Request failed');
                break;
            }
        }

        // Extract token counts from response
        if (responseBody?.usage) {
            inputTokens = responseBody.usage.prompt_tokens;
            outputTokens = responseBody.usage.completion_tokens;
        }

        // Check for tool calls in response
        if (responseBody?.choices?.[0]?.message?.tool_calls) {
            hadToolCalls = true;
        }

        // Add headers to response.
        // Only carry safe application-level headers from the upstream response —
        // NOT hop-by-hop headers (Transfer-Encoding, Connection, Content-Length)
        // which confuse undici's extractBody and cause "body locked" errors.
        const headers = new Headers();
        headers.set('Content-Type', response!.headers.get('Content-Type') ?? 'application/json');
        headers.set('X-ClawRoute-Model', currentModel);
        headers.set('X-ClawRoute-Tier', currentTier);
        headers.set('X-ClawRoute-Escalated', String(escalated));

        const finalResponse = new Response(finalBodyText ?? response!.body, {
            status: response!.status,
            statusText: response!.statusText,
            headers,
        });

        return buildExecutionResult(
            finalResponse,
            routingDecision,
            currentModel,
            escalated,
            escalationChain,
            inputTokens,
            outputTokens,
            hadToolCalls,
            startTime
        );
    }
}

/**
 * Make a request to an LLM provider.
 */
async function makeProviderRequest(
    request: ChatCompletionRequest,
    modelId: string,
    config: ClawRouteConfig,
    tier?: TaskTier
): Promise<Response> {
    const provider = getProviderForModel(modelId);
    const apiKey = getApiKey(config, provider);

    // Ollama is local — no API key required
    if (!apiKey && provider !== 'ollama') {
        throw new Error(`No API key configured for provider: ${provider}`);
    }

    const baseUrl = getApiBaseUrl(provider);
    const authHeaders = getAuthHeader(provider, apiKey);

    // Build the request body with the routed model
    const body: Record<string, unknown> = {
        ...request,
        model: extractModelName(modelId),
    };

    if (provider === 'ollama') {
        // Force num_ctx to at least 8192. OpenClaw sends its own num_ctx (often 4096
        // based on its internal model config) which would override OLLAMA_NUM_CTX.
        // The authoritative value is baked into the Modelfile; this guard ensures
        // callers never downgrade it below 8192.
        const existingOptions = (body['options'] as Record<string, unknown>) ?? {};
        const callerNumCtx = existingOptions['num_ctx'] as number | undefined;
        if (!callerNumCtx || callerNumCtx < 8192) {
            body['options'] = { ...existingOptions, num_ctx: 8192 };
        }

        // Strip tool schemas from ALL Ollama requests regardless of tier.
        // Tool schemas account for ~7K tokens per request — on CPU-only hardware
        // this overwhelms the KV cache and causes 60s+ timeouts even for short replies.
        // Requests that genuinely need tools will time out here and escalate to Gemini.
        delete body['tools'];
        delete body['tool_choice'];

        // Ollama native /api/chat requires content to be a plain string.
        // OpenAI-format content can be an array of ContentParts (multimodal).
        // Flatten any array content to a single string by joining text parts.
        const flattenContent = (msgs: typeof request.messages) =>
            msgs.map(m => {
                if (!Array.isArray(m.content)) return m;
                const text = (m.content as Array<{ type: string; text?: string }>)
                    .filter(p => p.type === 'text' && p.text)
                    .map(p => p.text!)
                    .join('');
                return { ...m, content: text };
            });

        // For heartbeat/simple tiers also trim message history to last 3 turns.
        if (tier === TaskTier.HEARTBEAT || tier === TaskTier.SIMPLE) {
            // Keep system message + last 3 user/assistant turns only.
            const msgs = request.messages;
            const systemMsgs = msgs.filter(m => m.role === 'system');
            const nonSystemMsgs = msgs.filter(m => m.role !== 'system');
            const trimmed = nonSystemMsgs.slice(-3);
            body['messages'] = flattenContent([...systemMsgs, ...trimmed]);
        } else {
            body['messages'] = flattenContent(request.messages);
        }
    }

    // Determine the endpoint
    let url: string;
    if (provider === 'ollama') {
        const ollamaBase = process.env.OLLAMA_ENDPOINT ?? 'http://ollama:11434';
        url = `${ollamaBase}/api/chat`;
    } else if (provider === 'anthropic') {
        url = `${baseUrl}/messages`;
    } else {
        url = `${baseUrl}/chat/completions`;
    }

    // Ollama runs on CPU — keep a tight timeout so failures escalate quickly.
    // Simple prompts finish in 5-15s; anything longer is likely hung. After 15s
    // the AbortController fires, the catch block runs escalation to the tier
    // fallback (e.g. gemini-flash via OpenRouter).
    // 15s balances warm-Ollama viability vs. agentic multi-turn latency.
    const timeoutMs = provider === 'ollama' ? 15_000 : 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Route external provider requests through Tinyproxy (HTTPS_PROXY env var).
    // Ollama is on the internal Docker network — bypass the proxy.
    const proxyAgent = provider !== 'ollama' ? getProxyAgent() : null;

    try {
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        };
        if (proxyAgent) fetchOptions.dispatcher = proxyAgent;
        const response = await fetch(url, fetchOptions as RequestInit);
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Extract the model name without provider prefix.
 */
function extractModelName(modelId: string): string {
    if (modelId.includes('/')) {
        return modelId.split('/').slice(1).join('/');
    }
    return modelId;
}

/**
 * Create an error response.
 */
function createErrorResponse(message: string): Response {
    return new Response(
        JSON.stringify({
            error: {
                message,
                type: 'server_error',
                code: 'internal_error',
            },
        }),
        {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );
}

/**
 * Build the execution result from response and metadata.
 */
/**
 * Peek at the first chunk from an Ollama NDJSON stream with a timeout.
 *
 * Ollama accepts the HTTP connection with 200 OK immediately — even when it is
 * about to hang (large prompt, CPU-starved, etc.).  By awaiting the first byte
 * before returning the streaming Response to the client, we preserve the
 * escalation window: if nothing arrives within `timeoutMs` we return null and
 * the caller can escalate to a fallback model.
 *
 * When the first chunk arrives in time, we return a new ReadableStream that
 * prepends that chunk and then drains the original reader transparently.
 */
async function peekFirstOllamaChunk(
    body: ReadableStream<Uint8Array>,
    timeoutMs: number,
): Promise<ReadableStream<Uint8Array> | null> {
    const reader = body.getReader();

    // Wrap reader.read() to prevent unhandled rejection if we cancel first.
    const readPromise = reader
        .read()
        .catch(() => ({ done: true as const, value: undefined }));

    const timeoutPromise: Promise<null> = new Promise(resolve =>
        setTimeout(() => resolve(null), timeoutMs),
    );

    const peeked = await Promise.race([readPromise, timeoutPromise]);

    if (peeked === null || peeked.done || !peeked.value) {
        // Timeout or immediate EOF — abort the reader.
        reader.cancel('peek-timeout').catch(() => {});
        return null;
    }

    const firstChunk = peeked.value;

    // Reassemble: start with the already-consumed firstChunk, then drain reader.
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(firstChunk);
        },
        async pull(controller) {
            const { done, value } = await reader
                .read()
                .catch(() => ({ done: true as const, value: undefined }));
            if (done || !value) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        cancel(reason) {
            reader.cancel(reason).catch(() => {});
        },
    });
}

function buildExecutionResult(
    response: Response,
    routingDecision: RoutingDecision,
    actualModel: string,
    escalated: boolean,
    escalationChain: string[],
    inputTokens: number,
    outputTokens: number,
    hadToolCalls: boolean,
    startTime: number
): ExecutionResult {
    const responseTimeMs = Date.now() - startTime;

    const originalCostUsd = calculateCost(
        routingDecision.originalModel,
        inputTokens,
        outputTokens
    );
    const actualCostUsd = calculateCost(actualModel, inputTokens, outputTokens);
    const savingsUsd = Math.max(0, originalCostUsd - actualCostUsd);

    return {
        response,
        routingDecision,
        actualModel,
        escalated,
        escalationChain,
        inputTokens,
        outputTokens,
        originalCostUsd,
        actualCostUsd,
        savingsUsd,
        responseTimeMs,
        hadToolCalls,
    };
}

/**
 * Execute a passthrough request (when ClawRoute is disabled or errored).
 */
export async function executePassthrough(
    request: ChatCompletionRequest,
    config: ClawRouteConfig
): Promise<Response> {
    const provider = getProviderForModel(request.model);
    const apiKey = getApiKey(config, provider);

    if (!apiKey) {
        return createErrorResponse(`No API key for provider: ${provider}`);
    }

    try {
        return await makeProviderRequest(request, request.model, config);
    } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : 'Passthrough failed');
    }
}
