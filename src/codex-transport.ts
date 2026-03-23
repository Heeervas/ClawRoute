/**
 * Codex OAuth Transport for ClawRoute
 *
 * Translates OpenAI Chat Completions API requests into the ChatGPT
 * Codex Responses API format used by the ChatGPT subscription endpoint.
 *
 * Protocol details:
 * - Upstream URL: https://chatgpt.com/backend-api/codex/responses
 * - Auth: Bearer <access_token> + chatgpt-account-id header
 * - Request: OpenAI Responses API format (input[] instead of messages[])
 * - Response: SSE events with response.output_text.delta etc.
 *
 * Reference: https://github.com/EvanZhouDev/openai-oauth
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { ProxyAgent } from 'undici';

// ── Types ──────────────────────────────────────────────────────────

interface CodexAuth {
    accessToken: string;
    accountId: string;
    refreshToken?: string;
    idToken?: string;
    sourcePath?: string;
}

interface ChatMessage {
    role: string;
    content: unknown;
    tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

// ── Auth Loading ───────────────────────────────────────────────────

/**
 * Parse JWT claims without validation (we only need the expiry and account_id).
 */
function parseJwtClaims(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
        const payload = Buffer.from(padded, 'base64url').toString('utf-8');
        const parsed = JSON.parse(payload);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Derive the ChatGPT account ID from an id_token JWT.
 */
function deriveAccountId(idToken: string | undefined): string | undefined {
    if (!idToken) return undefined;
    const claims = parseJwtClaims(idToken);
    if (!claims) return undefined;
    const authClaim = claims['https://api.openai.com/auth'];
    if (typeof authClaim === 'object' && authClaim !== null) {
        const accountId = (authClaim as Record<string, unknown>)['chatgpt_account_id'];
        if (typeof accountId === 'string' && accountId.length > 0) return accountId;
    }
    return undefined;
}

/**
 * Check if the access_token JWT is expired or about to expire.
 */
function isTokenExpired(accessToken: string): boolean {
    const claims = parseJwtClaims(accessToken);
    if (!claims || typeof claims['exp'] !== 'number') return false;
    const expiryMs = (claims['exp'] as number) * 1000;
    return expiryMs <= Date.now() + REFRESH_MARGIN_MS;
}

/**
 * Resolve the auth file path.
 */
function resolveAuthPath(): string {
    if (process.env['OPENAI_CODEX_AUTH_PATH']) {
        return process.env['OPENAI_CODEX_AUTH_PATH'];
    }
    const codexHome = process.env['CODEX_HOME'];
    if (codexHome) return join(codexHome, 'auth.json');
    return join(homedir(), '.codex', 'auth.json');
}

/**
 * Read and parse the auth.json file.
 */
function readAuthFile(path: string): Record<string, unknown> | null {
    try {
        if (!existsSync(path)) return null;
        const content = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(content);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Refresh the access token using the OAuth refresh_token flow.
 */
async function refreshTokens(
    refreshToken: string,
    proxyAgent: ProxyAgent | null,
): Promise<{ accessToken: string; idToken?: string; refreshToken: string; accountId?: string } | null> {
    try {
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: OAUTH_CLIENT_ID,
                scope: 'openid profile email offline_access',
            }),
        };
        if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

        const response = await fetch(OAUTH_TOKEN_URL, fetchOptions as RequestInit);
        if (!response.ok) return null;

        const payload = await response.json() as Record<string, unknown>;
        const newAccessToken = payload['access_token'];
        if (typeof newAccessToken !== 'string') return null;

        const newIdToken = typeof payload['id_token'] === 'string' ? payload['id_token'] : undefined;
        const newRefreshToken = typeof payload['refresh_token'] === 'string'
            ? payload['refresh_token']
            : refreshToken;

        return {
            accessToken: newAccessToken,
            idToken: newIdToken,
            refreshToken: newRefreshToken,
            accountId: deriveAccountId(newIdToken),
        };
    } catch (err) {
        console.warn('[codex-transport] Token refresh failed:', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Write updated tokens back to auth.json.
 */
function writeAuthFile(
    path: string,
    authData: Record<string, unknown>,
    tokens: Record<string, string | undefined>,
): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const updated = {
            ...authData,
            tokens: {
                ...(authData['tokens'] as Record<string, unknown> ?? {}),
                ...tokens,
            },
            last_refresh: new Date().toISOString(),
        };
        writeFileSync(path, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch {
        // Best-effort write
    }
}

// Cached auth to avoid re-reading the file on every request
let cachedAuth: CodexAuth | null = null;

/**
 * Load and optionally refresh the Codex OAuth credentials.
 * Returns null if no valid credentials are found.
 */
export async function loadCodexAuth(proxyAgent: ProxyAgent | null): Promise<CodexAuth | null> {
    // Fast path: use cached auth if token is still valid
    if (cachedAuth && !isTokenExpired(cachedAuth.accessToken)) {
        return cachedAuth;
    }

    const authPath = resolveAuthPath();
    const authData = readAuthFile(authPath);
    if (!authData) return null;

    const tokens = authData['tokens'] as Record<string, unknown> | undefined;
    let accessToken = tokens?.['access_token'] as string | undefined;
    let idToken = tokens?.['id_token'] as string | undefined;
    let refreshToken = tokens?.['refresh_token'] as string | undefined;
    let accountId = (tokens?.['account_id'] as string | undefined) ?? deriveAccountId(idToken);

    if (!accessToken) return null;

    // Refresh if expired or about to expire
    if (isTokenExpired(accessToken) && refreshToken) {
        console.log('[codex-transport] Access token expired, refreshing...');
        const refreshed = await refreshTokens(refreshToken, proxyAgent);
        if (refreshed) {
            accessToken = refreshed.accessToken;
            idToken = refreshed.idToken ?? idToken;
            refreshToken = refreshed.refreshToken;
            accountId = refreshed.accountId ?? accountId;

            writeAuthFile(authPath, authData, {
                access_token: accessToken,
                id_token: idToken,
                refresh_token: refreshToken,
                account_id: accountId,
            });
            console.log('[codex-transport] Token refreshed successfully');
        } else {
            console.warn('[codex-transport] Token refresh failed, using existing token');
        }
    }

    if (!accountId) {
        console.warn('[codex-transport] No account_id found — Codex requests may fail');
        return null;
    }

    cachedAuth = { accessToken, accountId, refreshToken, idToken, sourcePath: authPath };
    return cachedAuth;
}

// ── Request Translation ────────────────────────────────────────────

/**
 * Extract plain text from OpenAI message content (string or content parts array).
 */
function textContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((p: { type?: string; text?: string }) => p.type === 'text' && p.text)
        .map((p: { text: string }) => p.text)
        .join('');
}

/**
 * Convert OpenAI Chat Completions messages to Responses API input items.
 *
 * Chat Completions format:
 *   [{role: "system", content: "..."}, {role: "user", content: "..."}, ...]
 *
 * Responses API input format:
 *   [{role: "developer", content: "..."}, {role: "user", content: "..."},
 *    {type: "function_call", ...}, {type: "function_call_output", ...}]
 */
function chatMessagesToResponsesInput(messages: ChatMessage[]): unknown[] {
    const input: unknown[] = [];

    for (const msg of messages) {
        switch (msg.role) {
            case 'system':
            case 'developer':
                input.push({ role: 'developer', content: textContent(msg.content) });
                break;

            case 'user': {
                // Preserve multimodal content arrays (images etc.)
                if (Array.isArray(msg.content)) {
                    const parts = [];
                    for (const item of msg.content as Array<Record<string, unknown>>) {
                        if (item.type === 'text' && typeof item.text === 'string') {
                            parts.push({ type: 'input_text', text: item.text });
                        } else if (item.type === 'image_url' && typeof (item.image_url as Record<string, unknown>)?.url === 'string') {
                            parts.push({ type: 'input_image', image_url: (item.image_url as Record<string, unknown>).url });
                        }
                    }
                    input.push({ role: 'user', content: parts.length === 1 && parts[0]?.type === 'input_text' ? (parts[0] as { text: string }).text : parts });
                } else {
                    input.push({ role: 'user', content: textContent(msg.content) });
                }
                break;
            }

            case 'assistant': {
                const text = textContent(msg.content);
                if (text) {
                    input.push({
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text }],
                    });
                }
                // Tool calls become separate function_call items
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        input.push({
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        });
                    }
                }
                break;
            }

            case 'tool':
                if (msg.tool_call_id) {
                    input.push({
                        type: 'function_call_output',
                        call_id: msg.tool_call_id,
                        output: typeof msg.content === 'string'
                            ? msg.content
                            : JSON.stringify(msg.content),
                    });
                }
                break;
        }
    }

    return input;
}

/**
 * Build the Codex Responses API request body from a Chat Completions request.
 */
export function buildCodexRequestBody(
    request: Record<string, unknown>,
    modelName: string,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: modelName,
        input: chatMessagesToResponsesInput(request['messages'] as ChatMessage[]),
        stream: true, // Always stream from upstream; we'll collect for non-stream clients
        instructions: '',
        store: false,
    };

    // Forward compatible parameters
    if (request['temperature'] !== undefined) body['temperature'] = request['temperature'];
    if (request['top_p'] !== undefined) body['top_p'] = request['top_p'];
    if (request['tools']) {
        // Translate Chat Completions tool format → Responses API format.
        // CC: {type: "function", function: {name, description, parameters}}
        // RA: {type: "function", name, description, parameters, strict}
        const ccTools = request['tools'] as Array<Record<string, unknown>>;
        body['tools'] = ccTools.map(tool => {
            if (tool['type'] === 'function' && tool['function']) {
                const fn = tool['function'] as Record<string, unknown>;
                return {
                    type: 'function',
                    name: fn['name'],
                    ...(fn['description'] !== undefined ? { description: fn['description'] } : {}),
                    ...(fn['parameters'] !== undefined ? { parameters: fn['parameters'] } : {}),
                    ...(fn['strict'] !== undefined ? { strict: fn['strict'] } : {}),
                };
            }
            return tool; // Already in Responses API format or unknown — pass through
        });
    }
    if (request['tool_choice']) body['tool_choice'] = request['tool_choice'];
    if (request['reasoning_effort']) {
        body['reasoning'] = { effort: request['reasoning_effort'] };
    }
    // max_tokens → not directly supported; omit (Responses API has max_output_tokens
    // but the Codex endpoint strips it anyway per openai-oauth source)

    return body;
}

// ── Response Translation ───────────────────────────────────────────

interface SSEEvent {
    event?: string;
    data?: string;
}

/**
 * Parse SSE events from a ReadableStream.
 */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? '';

            for (const block of blocks) {
                if (!block.trim()) continue;
                const event: SSEEvent = {};
                const dataLines: string[] = [];

                for (const line of block.split(/\r?\n/)) {
                    if (line.startsWith('event:')) {
                        event.event = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        dataLines.push(line.slice(5).trimStart());
                    }
                }

                if (dataLines.length > 0) {
                    event.data = dataLines.join('\n');
                }
                yield event;
            }
        }

        // Process remaining buffer
        if (buffer.trim()) {
            const event: SSEEvent = {};
            const dataLines: string[] = [];
            for (const line of buffer.split(/\r?\n/)) {
                if (line.startsWith('event:')) {
                    event.event = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }
            if (dataLines.length > 0) {
                event.data = dataLines.join('\n');
                yield event;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Map a Responses API finish reason to Chat Completions format.
 */
function mapFinishReason(responseStatus: string | undefined): string {
    switch (responseStatus) {
        case 'completed': return 'stop';
        case 'incomplete': return 'length';
        case 'cancelled': return 'stop';
        default: return 'stop';
    }
}

/**
 * Transform a Codex Responses API SSE stream into an OpenAI Chat Completions SSE stream.
 *
 * Responses API events → Chat Completions chunks:
 *   response.output_text.delta      → delta.content
 *   response.output_item.added      → (tool call start) delta.tool_calls
 *   response.function_call_arguments.delta → delta.tool_calls[].function.arguments
 *   response.completed              → finish_reason + usage + [DONE]
 */
export function codexResponseToStream(
    upstreamBody: ReadableStream<Uint8Array>,
    model: string,
    wantsStream: boolean,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const chatId = `chatcmpl_${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Track tool call indices — key is call_id OR item_id (both map to same index)
    const toolIndexByCallId = new Map<string, number>();
    // Map item_id → call_id for non-streaming argument accumulation
    const itemIdToCallId = new Map<string, string>();
    let nextToolIndex = 0;

    // For non-streaming: collect all text and tool calls, emit as single response
    let collectedText = '';
    const collectedToolCalls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }> = [];
    let collectedUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
    let finishReason = 'stop';

    const sseIter = parseSSE(upstreamBody);

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                if (wantsStream) {
                    // Emit initial role chunk
                    controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({
                            id: chatId, object: 'chat.completion.chunk', created, model,
                            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                        })}\n\n`
                    ));
                }

                for await (const sse of sseIter) {
                    if (!sse.data || !sse.event) continue;

                    let parsed: Record<string, unknown>;
                    try {
                        parsed = JSON.parse(sse.data);
                    } catch {
                        continue;
                    }

                    switch (sse.event) {
                        case 'response.output_text.delta': {
                            const delta = parsed['delta'] as string | undefined;
                            if (!delta) break;
                            if (wantsStream) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                                    })}\n\n`
                                ));
                            } else {
                                collectedText += delta;
                            }
                            break;
                        }

                        case 'response.output_item.added': {
                            // Tool call start — data is nested under parsed['item']
                            const item = parsed['item'] as Record<string, unknown> | undefined;
                            const itemType = item?.['type'] as string | undefined;
                            if (itemType === 'function_call' && item) {
                                const callId = item['call_id'] as string;
                                const itemId = item['id'] as string | undefined;
                                const name = item['name'] as string;
                                const idx = nextToolIndex++;
                                toolIndexByCallId.set(callId, idx);
                                // argument delta events reference item_id, not call_id
                                if (itemId) {
                                    toolIndexByCallId.set(itemId, idx);
                                    itemIdToCallId.set(itemId, callId);
                                }

                                if (wantsStream) {
                                    controller.enqueue(encoder.encode(
                                        `data: ${JSON.stringify({
                                            id: chatId, object: 'chat.completion.chunk', created, model,
                                            choices: [{
                                                index: 0,
                                                delta: {
                                                    tool_calls: [{
                                                        index: idx, id: callId, type: 'function',
                                                        function: { name, arguments: '' },
                                                    }],
                                                },
                                                finish_reason: null,
                                            }],
                                        })}\n\n`
                                    ));
                                } else {
                                    collectedToolCalls.push({
                                        id: callId, type: 'function',
                                        function: { name, arguments: '' },
                                    });
                                }
                            }
                            break;
                        }

                        case 'response.function_call_arguments.delta': {
                            const delta = parsed['delta'] as string | undefined;
                            // The call identifier is 'item_id' in argument delta events
                            const itemId = parsed['item_id'] as string | undefined;
                            if (!delta || !itemId) break;
                            // Look up index by item_id; fall back to using it as call_id
                            const callId = itemId;

                            const idx = toolIndexByCallId.get(callId);
                            if (wantsStream && idx !== undefined) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                tool_calls: [{
                                                    index: idx,
                                                    function: { arguments: delta },
                                                }],
                                            },
                                            finish_reason: null,
                                        }],
                                    })}\n\n`
                                ));
                            } else {
                                // Append to collected tool call arguments
                                // item_id → call_id lookup for non-streaming
                                const resolvedCallId = itemIdToCallId.get(callId) ?? callId;
                                const tc = collectedToolCalls.find(t => t.id === resolvedCallId);
                                if (tc) tc.function.arguments += delta;
                            }
                            break;
                        }

                        case 'response.completed': {
                            const response = parsed['response'] as Record<string, unknown> | undefined;
                            const usage = response?.['usage'] as Record<string, unknown> | undefined;

                            if (usage) {
                                collectedUsage = {
                                    prompt_tokens: usage['input_tokens'] as number | undefined,
                                    completion_tokens: usage['output_tokens'] as number | undefined,
                                    total_tokens: ((usage['input_tokens'] as number) ?? 0) + ((usage['output_tokens'] as number) ?? 0),
                                };
                            }

                            finishReason = mapFinishReason(response?.['status'] as string | undefined);
                            // If tool calls were emitted, override to 'tool_calls'
                            if (nextToolIndex > 0) finishReason = 'tool_calls';

                            if (wantsStream) {
                                // Finish chunk
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                                        ...(Object.keys(collectedUsage).length > 0 ? { usage: collectedUsage } : {}),
                                    })}\n\n`
                                ));
                                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            }
                            break;
                        }

                        case 'error': {
                            const msg = parsed['message'] as string ?? 'Codex upstream error';
                            if (wantsStream) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        error: { message: msg, type: 'upstream_error', code: 'codex_error' },
                                    })}\n\n`
                                ));
                                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            }
                            break;
                        }

                        // Ignore other event types (response.created, response.in_progress,
                        // response.output_text.done, response.output_item.done, etc.)
                    }
                }

                // For non-streaming: emit the full chat completion response
                if (!wantsStream) {
                    const message: Record<string, unknown> = {
                        role: 'assistant',
                        content: collectedText.length > 0 ? collectedText : null,
                    };
                    if (collectedToolCalls.length > 0) {
                        message['tool_calls'] = collectedToolCalls;
                    }

                    const responseJson = JSON.stringify({
                        id: chatId,
                        object: 'chat.completion',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            message,
                            finish_reason: collectedToolCalls.length > 0 ? 'tool_calls' : finishReason,
                        }],
                        usage: collectedUsage,
                    });

                    controller.enqueue(encoder.encode(responseJson));
                }

                controller.close();
            } catch (err) {
                controller.error(err);
            }
        },
    });
}

// ── Main Request Handler ───────────────────────────────────────────

/**
 * Execute a request through the Codex ChatGPT subscription endpoint.
 *
 * This replaces the normal makeProviderRequest flow for codex/ models.
 * Returns a Response that looks like a standard OpenAI Chat Completions
 * response (either streaming SSE or JSON), so the rest of ClawRoute's
 * executor pipeline (pipeStream, usage tracking) works unchanged.
 */
export async function makeCodexRequest(
    request: Record<string, unknown>,
    modelId: string,
    proxyAgent: ProxyAgent | null,
): Promise<Response> {
    // 1. Load auth
    const auth = await loadCodexAuth(proxyAgent);
    if (!auth) {
        return new Response(
            JSON.stringify({
                error: {
                    message: 'Codex OAuth credentials not found. Run `codex login` or set OPENAI_CODEX_AUTH_PATH.',
                    type: 'auth_error',
                    code: 'codex_auth_missing',
                },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
    }

    // 2. Extract model name (strip codex/ prefix)
    const modelName = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;

    // 3. Build the Responses API request body
    const body = buildCodexRequestBody(request, modelName);
    const wantsStream = request['stream'] === true;

    // 4. Call the Codex endpoint
    const url = `${CODEX_BASE_URL}/responses`;
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${auth.accessToken}`,
            'chatgpt-account-id': auth.accountId,
            'OpenAI-Beta': 'responses=experimental',
        },
        body: JSON.stringify(body),
    };
    if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    fetchOptions.signal = controller.signal;

    try {
        const upstream = await fetch(url, fetchOptions as RequestInit);
        clearTimeout(timeoutId);

        if (!upstream.ok) {
            // Pass through error response
            const errorBody = await upstream.text();
            return new Response(
                JSON.stringify({
                    error: {
                        message: `Codex API error (${upstream.status}): ${errorBody}`,
                        type: 'upstream_error',
                        code: `codex_${upstream.status}`,
                    },
                }),
                { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
            );
        }

        if (!upstream.body) {
            return new Response(
                JSON.stringify({ error: { message: 'No response body from Codex', type: 'server_error' } }),
                { status: 502, headers: { 'Content-Type': 'application/json' } },
            );
        }

        // 5. Transform the Responses API SSE stream to Chat Completions format
        const transformedBody = codexResponseToStream(upstream.body, modelName, wantsStream);

        if (wantsStream) {
            return new Response(transformedBody, {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                },
            });
        } else {
            // For non-streaming: the transform collects everything and emits JSON
            // Read the full body and return as application/json
            const reader = transformedBody.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const jsonBody = new TextDecoder().decode(
                new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0)).buffer
                    ? Buffer.concat(chunks)
                    : new Uint8Array(),
            );

            return new Response(jsonBody, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (err) {
        clearTimeout(timeoutId);
        const message = err instanceof Error ? err.message : 'Codex request failed';
        return new Response(
            JSON.stringify({ error: { message, type: 'server_error', code: 'codex_error' } }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }
}
