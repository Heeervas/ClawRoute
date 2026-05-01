/**
 * ClawRoute HTTP Server
 *
 * Hono-based HTTP proxy server with all routes.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    ChatCompletionRequest,
    ClawRouteConfig,
    LogEntry,
    ModelEntry,
    ProviderType,
    RoutingSnapshot,
    TaskTier,
    isProviderType,
} from './types.js';
import { createAuthMiddleware } from './auth.js';
import { classifyRequest, explainClassification } from './classifier.js';
import { routeRequest } from './router.js';
import { executeRequest, executePassthrough } from './executor.js';
import { cloneModelCatalog, deleteModel, getEnabledModelsFromCatalog, getModelEntryFromCatalog, getModelEntryStrictFromCatalog, registerModel } from './models.js';
import { logRouting } from './logger.js';
import { getStatsResponse } from './stats.js';
import { getRedactedConfig, persistModelRegistryEntry, persistModelRemoval, persistTierSelection } from './config.js';
import { generateRequestId, nowIso, stripMetadataPreamble } from './utils.js';
import { responsesBodyToChatCompletions, chatCompletionToResponsesBody, responsesBodyToSSEResponse } from './responses-adapter.js';
import { discoverProviderModels, DiscoveredModelCandidate, getCandidateMissingFields } from './provider-discovery.js';
import { RuntimeStateManager } from './runtime-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create the Hono application.
 *
 * @param config - The ClawRoute configuration
 * @returns Configured Hono app
 */
type CreateAppOptions = {
    projectRoot?: string;
    runtimeState?: RuntimeStateManager;
};

export function createApp(config: ClawRouteConfig, options: CreateAppOptions = {}): Hono {
    const app = new Hono();
    const discoveredCandidates = new Map<string, DiscoveredModelCandidate>();

    function getRuntimeSnapshot(): RoutingSnapshot {
        if (!options.runtimeState) {
            return {
                providerProfile: config.providerProfile,
                baselineModel: config.baselineModel,
                models: config.models,
                contextOverrides: config.contextOverrides,
                modelCatalog: cloneModelCatalog(),
            };
        }

        return options.runtimeState.getSnapshot();
    }

    function getRuntimeConfigFromSnapshot(snapshot: RoutingSnapshot): ClawRouteConfig {
        return {
            ...config,
            providerProfile: snapshot.providerProfile,
            baselineModel: snapshot.baselineModel,
            models: snapshot.models,
            contextOverrides: snapshot.contextOverrides,
        };
    }

    function getRuntimeConfig(): ClawRouteConfig {
        return getRuntimeConfigFromSnapshot(getRuntimeSnapshot());
    }

    async function reloadRuntime(reason: string): Promise<void> {
        if (!options.runtimeState) {
            return;
        }
        await options.runtimeState.reloadNow(reason);
    }

    function getMissingFields(body: Partial<ModelEntry>): DiscoveredModelCandidate['missingFields'] {
        return getCandidateMissingFields(body);
    }

    function getInvalidFields(body: Partial<ModelEntry>): string[] {
        const invalidFields: string[] = [];
        if (body.maxContext !== undefined) {
            if (typeof body.maxContext !== 'number' || !Number.isFinite(body.maxContext) || body.maxContext <= 0) {
                invalidFields.push('maxContext');
            }
        }
        if (body.inputCostPer1M !== undefined) {
            if (typeof body.inputCostPer1M !== 'number' || !Number.isFinite(body.inputCostPer1M) || body.inputCostPer1M < 0) {
                invalidFields.push('inputCostPer1M');
            }
        }
        if (body.outputCostPer1M !== undefined) {
            if (typeof body.outputCostPer1M !== 'number' || !Number.isFinite(body.outputCostPer1M) || body.outputCostPer1M < 0) {
                invalidFields.push('outputCostPer1M');
            }
        }
        if (body.toolCapable !== undefined && typeof body.toolCapable !== 'boolean') {
            invalidFields.push('toolCapable');
        }
        if (body.multimodal !== undefined && typeof body.multimodal !== 'boolean') {
            invalidFields.push('multimodal');
        }
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
            invalidFields.push('enabled');
        }
        return invalidFields;
    }

    async function applyPersistentChange(
        write: () => () => void,
        reason: string
    ): Promise<void> {
        const rollback = write();
        try {
            await reloadRuntime(reason);
        } catch (error) {
            rollback();
            try {
                await reloadRuntime(`${reason} rollback`);
            } catch {
                // Best effort to restore the last known-good snapshot.
            }
            throw error;
        }
    }

    function isConfiguredTier(tier: string): tier is TaskTier {
        return Object.values(TaskTier).includes(tier as TaskTier);
    }

    function isDiscoveryOnly(modelId: string): boolean {
        const candidate = discoveredCandidates.get(modelId);
        return candidate?.discoveryOnly ?? false;
    }

    function isAllowedModel(modelId: string): boolean {
        const entry = getModelEntryFromCatalog(modelId, getRuntimeSnapshot().modelCatalog);
        if (!entry || !entry.enabled) return false;
        return !isDiscoveryOnly(modelId);
    }

    function hasModelReference(modelId: string): boolean {
        const runtimeConfig = getRuntimeConfig();
        if (runtimeConfig.baselineModel === modelId) {
            return true;
        }

        return Object.values(TaskTier).some((tier) => {
            const tierConfig = runtimeConfig.models[tier];
            return tierConfig.primary === modelId || tierConfig.fallback === modelId;
        });
    }

    // CORS for dashboard
    app.use('*', cors());

    // Auth middleware (model listing is exempt — read-only discovery on internal network)
    app.use('/v1/*', createAuthMiddleware(config, ['/v1/models']));
    app.use('/api/*', createAuthMiddleware(config));

    // Health check
    app.get('/health', (c) => {
        return c.json({
            status: 'ok',
            version: '1.1.0',
            enabled: config.enabled,
            dryRun: config.dryRun,
            timestamp: nowIso(),
        });
    });

    // Stats API
    app.get('/stats', (c) => {
        const stats = getStatsResponse(config);
        return c.json(stats);
    });

    // Dashboard (v2.0)
    app.get('/dashboard2', (c) => {
        try {
            const filename = 'dashboard2.html';
            
            // Try to load from web/ directory
            const dashboardPath = join(__dirname, '..', 'web', filename);
            if (existsSync(dashboardPath)) {
                const html = readFileSync(dashboardPath, 'utf-8');
                return c.html(html);
            }

            // Fallback: try dist/web
            const distPath = join(__dirname, '..', 'dist', 'web', filename);
            if (existsSync(distPath)) {
                const html = readFileSync(distPath, 'utf-8');
                return c.html(html);
            }

            return c.html(`<html><body><h1>Dashboard v2 not found</h1><p>Expected file: web/${filename}</p></body></html>`);
        } catch (error) {
            return c.html('<html><body><h1>Error loading dashboard</h1></body></html>');
        }
    });

    // Legacy Dashboard (v1.0)
    app.get('/dashboard', (c) => {
        try {
            const filename = 'dashboard.html';
            
            // Try to load from web/ directory
            const dashboardPath = join(__dirname, '..', 'web', filename);
            if (existsSync(dashboardPath)) {
                const html = readFileSync(dashboardPath, 'utf-8');
                return c.html(html);
            }

            // Fallback: try dist/web
            const distPath = join(__dirname, '..', 'dist', 'web', filename);
            if (existsSync(distPath)) {
                const html = readFileSync(distPath, 'utf-8');
                return c.html(html);
            }

            return c.html(`<html><body><h1>Dashboard v1 not found</h1><p>Expected file: web/${filename}</p></body></html>`);
        } catch (error) {
            return c.html('<html><body><h1>Error loading dashboard</h1></body></html>');
        }
    });

    // Config API (redacted)
    app.get('/api/config', (c) => {
        const redacted = getRedactedConfig(config);
        return c.json(redacted);
    });

    app.post('/api/admin/models/discover', async (c) => {
        try {
            const body = await c.req.json() as { provider?: ProviderType };
            if (!body.provider) {
                return c.json({ error: { message: 'Provide provider', type: 'invalid_request_error', code: 'invalid_body' } }, 400);
            }
            if (!isProviderType(body.provider)) {
                return c.json({ error: { message: `Unknown provider: ${String(body.provider)}`, type: 'invalid_request_error', code: 'invalid_provider' } }, 400);
            }

            const candidates = await discoverProviderModels(body.provider, getRuntimeConfig());
            for (const candidate of candidates) {
                discoveredCandidates.set(candidate.id, candidate);
            }
            return c.json({ candidates });
        } catch (error) {
            return c.json({
                error: {
                    message: error instanceof Error ? error.message : 'Failed to discover models',
                    type: 'invalid_request_error',
                    code: 'discovery_failed',
                },
            }, 400);
        }
    });

    app.post('/api/admin/models', async (c) => {
        let body: Partial<ModelEntry>;
        try {
            body = await c.req.json() as Partial<ModelEntry>;
        } catch {
            return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_json' } }, 400);
        }

        try {
            if (!body.id || !body.provider) {
                return c.json({
                    error: {
                        message: 'Provide id and provider',
                        type: 'invalid_request_error',
                        code: 'invalid_body',
                    },
                    missingFields: body.id ? ['provider'] : ['id', 'provider'],
                }, 400);
            }
            if (!isProviderType(body.provider)) {
                return c.json({
                    error: {
                        message: `Unknown provider: ${String(body.provider)}`,
                        type: 'invalid_request_error',
                        code: 'invalid_provider',
                    },
                }, 400);
            }

            const missingFields = getMissingFields(body);
            if (missingFields.length > 0) {
                discoveredCandidates.set(body.id, {
                    id: body.id,
                    provider: body.provider,
                    discoveryOnly: true,
                    missingFields,
                });
                return c.json({
                    error: {
                        message: 'Incomplete model metadata',
                        type: 'invalid_request_error',
                        code: 'incomplete_model',
                    },
                    missingFields,
                }, 400);
            }

            const invalidFields = getInvalidFields(body);
            if (invalidFields.length > 0) {
                return c.json({
                    error: {
                        message: 'Invalid model metadata',
                        type: 'invalid_request_error',
                        code: 'invalid_model',
                    },
                    invalidFields,
                }, 400);
            }

            const model: ModelEntry = {
                id: body.id,
                provider: body.provider,
                inputCostPer1M: body.inputCostPer1M ?? 0,
                outputCostPer1M: body.outputCostPer1M ?? 0,
                maxContext: body.maxContext ?? 0,
                toolCapable: body.toolCapable ?? false,
                multimodal: body.multimodal ?? false,
                enabled: body.enabled ?? false,
            };

            if (options.projectRoot) {
                await applyPersistentChange(
                    () => persistModelRegistryEntry(options.projectRoot!, model),
                    `admin add model ${model.id}`
                );
            } else {
                registerModel(model);
            }
            discoveredCandidates.delete(model.id);
            return c.json({ success: true, model });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid JSON body';
            return c.json({ error: { message, type: 'invalid_request_error', code: 'reload_failed' } }, 400);
        }
    });

    app.post('/api/admin/tiers/:tier', async (c) => {
        let body: { primary?: string; fallback?: string };
        try {
            const tier = c.req.param('tier');
            if (!isConfiguredTier(tier)) {
                return c.json({ error: { message: `Unknown tier: ${tier}`, type: 'invalid_request_error', code: 'unknown_tier' } }, 404);
            }

            try {
                body = await c.req.json() as { primary?: string; fallback?: string };
            } catch {
                return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_json' } }, 400);
            }
            if (!body.primary || !body.fallback) {
                return c.json({ error: { message: 'Provide primary and fallback', type: 'invalid_request_error', code: 'invalid_body' } }, 400);
            }

            if (!isAllowedModel(body.primary) || !isAllowedModel(body.fallback)) {
                return c.json({
                    error: {
                        message: 'Tier assignments must target complete, enabled, non-discovery-only models',
                        type: 'invalid_request_error',
                        code: 'invalid_model_target',
                    },
                }, 400);
            }

            const nextConfig = { primary: body.primary, fallback: body.fallback };
            if (options.projectRoot) {
                await applyPersistentChange(
                    () => persistTierSelection(options.projectRoot!, tier, nextConfig),
                    `admin update tier ${tier}`
                );
            } else {
                config.models[tier] = nextConfig;
            }
            return c.json({ success: true, tier, config: nextConfig });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update tier';
            return c.json({ error: { message, type: 'invalid_request_error', code: 'reload_failed' } }, 400);
        }
    });

    app.delete('/api/admin/models/:id{.+}', async (c) => {
        const modelId = c.req.param('id');
        if (hasModelReference(modelId)) {
            return c.json({
                error: {
                    message: `Model ${modelId} is still referenced by baselineModel or tier config`,
                    type: 'invalid_request_error',
                    code: 'model_referenced',
                },
            }, 409);
        }

        discoveredCandidates.delete(modelId);
        if (options.projectRoot) {
            try {
                await applyPersistentChange(
                    () => persistModelRemoval(options.projectRoot!, modelId),
                    `admin remove model ${modelId}`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to remove model';
                return c.json({ error: { message, type: 'invalid_request_error', code: 'reload_failed' } }, 400);
            }
        } else {
            deleteModel(modelId);
        }
        return c.json({ success: true, id: modelId });
    });

    // Enable/disable controls
    app.post('/api/enable', (c) => {
        config.enabled = true;
        console.log('✅ ClawRoute enabled');
        return c.json({ success: true, enabled: true });
    });

    app.post('/api/disable', (c) => {
        config.enabled = false;
        console.log('⏸️  ClawRoute disabled (passthrough mode)');
        return c.json({ success: true, enabled: false });
    });

    // Dry-run controls
    app.post('/api/dry-run/enable', (c) => {
        config.dryRun = true;
        console.log('🔬 Dry-run mode enabled');
        return c.json({ success: true, dryRun: true });
    });

    app.post('/api/dry-run/disable', (c) => {
        config.dryRun = false;
        console.log('🚀 Dry-run mode disabled (live mode)');
        return c.json({ success: true, dryRun: false });
    });

    // Global override
    app.post('/api/override/global', async (c) => {
        try {
            const body = await c.req.json() as { model?: string; enabled?: boolean };

            if (body.enabled === false) {
                config.overrides.globalForceModel = null;
                console.log('🔄 Global override removed');
                return c.json({ success: true, globalForceModel: null });
            }

            if (body.model) {
                config.overrides.globalForceModel = body.model;
                console.log(`🎯 Global override set: ${body.model}`);
                return c.json({ success: true, globalForceModel: body.model });
            }

            return c.json({ error: 'Provide model or enabled: false' }, 400);
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    // Session override
    app.post('/api/override/session', async (c) => {
        try {
            const body = await c.req.json() as {
                sessionId?: string;
                model?: string;
                turns?: number;
            };

            if (!body.sessionId || !body.model) {
                return c.json({ error: 'Provide sessionId and model' }, 400);
            }

            config.overrides.sessions[body.sessionId] = {
                model: body.model,
                remainingTurns: body.turns ?? null,
                createdAt: nowIso(),
            };

            console.log(`📌 Session override set: ${body.sessionId} → ${body.model}`);
            return c.json({ success: true, sessionId: body.sessionId, model: body.model });
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    app.delete('/api/override/session', async (c) => {
        try {
            const body = await c.req.json() as { sessionId?: string };

            if (!body.sessionId) {
                return c.json({ error: 'Provide sessionId' }, 400);
            }

            delete config.overrides.sessions[body.sessionId];
            console.log(`🗑️  Session override removed: ${body.sessionId}`);
            return c.json({ success: true, sessionId: body.sessionId });
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    // Main proxy endpoint - OpenAI compatible
    app.post('/v1/chat/completions', async (c) => {
        const requestId = generateRequestId();

        try {
            // Parse request body
            const body = await c.req.json() as ChatCompletionRequest;
            const runtimeSnapshot = getRuntimeSnapshot();
            const runtimeConfig = getRuntimeConfigFromSnapshot(runtimeSnapshot);

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Incoming request for model: ${body.model}`);
            }

            // If ClawRoute is disabled, passthrough
            if (!runtimeConfig.enabled) {
                if (config.logging.debugMode) {
                    console.log(`[${requestId}] Passthrough (disabled)`);
                }
                const response = await executePassthrough(body, runtimeConfig, runtimeSnapshot.modelCatalog);
                return response;
            }

            // Classify the request
            const classification = classifyRequest(body, runtimeConfig);

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Classification: ${explainClassification(classification)}`);
            }

            // Route to model
            const routing = routeRequest(body, classification, runtimeConfig, runtimeSnapshot.modelCatalog);

            if (config.logging.debugMode) {
                console.log(
                    `[${requestId}] Routing: ${routing.originalModel} → ${routing.routedModel} (${routing.reason})`
                );
            }

            // Execute the request
            const result = await executeRequest(body, routing, classification, runtimeConfig, runtimeSnapshot.modelCatalog);

            // Build the log entry for this request.
            // For streaming: called by executor after stream completes (accurate tokens).
            // For non-streaming: called via setImmediate (tokens already correct in result).
            const buildAndLog = () => {
                const lastUserMsg = [...(body.messages ?? [])]
                    .reverse()
                    .find((m) => m.role === 'user');
                const rawText = typeof lastUserMsg?.content === 'string'
                    ? lastUserMsg.content
                    : Array.isArray(lastUserMsg?.content)
                        ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
                            .filter((p) => p.type === 'text')
                            .map((p) => p.text ?? '')
                            .join(' ')
                        : null;

                // P7: Strip untrusted metadata preamble blocks so prompt_preview
                // shows the actual user message, not OpenClaw metadata JSON.
                const cleanText = rawText ? stripMetadataPreamble(rawText) : '';
                const promptPreview = cleanText ? cleanText.slice(0, 300) : null;

                const contextInfo = JSON.stringify({
                    msg_count: (body.messages ?? []).length,
                    has_system: (body.messages ?? []).some((m) => m.role === 'system'),
                    tool_count: (body.tools ?? []).length,
                    last_role: (body.messages ?? []).at(-1)?.role ?? null,
                });

                // P3b: Extract session ID from system prompt sender_id (hashed for privacy)
                const sysMsg = (body.messages ?? []).find((m) => m.role === 'system');
                const sysContent = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
                const senderMatch = sysContent.match(/"sender_id"\s*:\s*"(\d+)"/);
                const senderId = senderMatch?.[1];
                const sessionId = senderId
                    ? createHash('sha256').update(senderId).digest('hex').slice(0, 8)
                    : null;

                const logEntry: LogEntry = {
                    timestamp: nowIso(),
                    original_model: routing.originalModel,
                    routed_model: routing.routedModel,
                    actual_model: result.actualModel,
                    tier: routing.tier,
                    classification_reason: classification.reason,
                    confidence: classification.confidence,
                    input_tokens: result.inputTokens,
                    output_tokens: result.outputTokens,
                    original_cost_usd: result.originalCostUsd,
                    actual_cost_usd: result.actualCostUsd,
                    savings_usd: result.savingsUsd,
                    escalated: result.escalated,
                    escalation_chain: JSON.stringify(result.escalationChain),
                    response_time_ms: result.responseTimeMs,
                    had_tool_calls: result.hadToolCalls,
                    is_dry_run: routing.isDryRun,
                    is_override: routing.isOverride,
                    session_id: sessionId,
                    error: null,
                    prompt_preview: promptPreview,
                    context_info: contextInfo,
                };
                logRouting(logEntry);

                if (config.logging.debugMode) {
                    console.log(
                        `[${requestId}] Complete: ${result.responseTimeMs}ms, saved $${result.savingsUsd.toFixed(4)}`
                    );
                }
            };

            // P1: For streaming, fire log callback after stream ends (executor back-fills tokens).
            //     For non-streaming, log asynchronously via setImmediate (tokens already correct).
            if (body.stream) {
                result.logWhenDone = buildAndLog;
            } else {
                setImmediate(buildAndLog);
            }

            return result.response;
        } catch (error) {
            // Any error in ClawRoute logic → fall back to passthrough
            console.error(`[${requestId}] Error in ClawRoute, falling back to passthrough:`, error);

            try {
                const body = await c.req.json() as ChatCompletionRequest;
                const response = await executePassthrough(body, config, getRuntimeSnapshot().modelCatalog);
                return response;
            } catch {
                return c.json(
                    {
                        error: {
                            message: 'Failed to process request',
                            type: 'server_error',
                            code: 'internal_error',
                        },
                    },
                    500
                );
            }
        }
    });

    // OpenAI Responses API endpoint
    app.post('/v1/responses', async (c) => {
        const requestId = generateRequestId();
        let wantsStream = false;

        try {
            const body = await c.req.json();
            wantsStream = body.stream === true;
            const runtimeSnapshot = getRuntimeSnapshot();
            const runtimeConfig = getRuntimeConfigFromSnapshot(runtimeSnapshot);

            if (!body.model) {
                return c.json(
                    { error: { message: 'model is required', type: 'invalid_request_error' } },
                    400
                );
            }
            if (!body.input) {
                return c.json(
                    { error: { message: 'input is required', type: 'invalid_request_error' } },
                    400
                );
            }
            // Accept input as string (shorthand) or array of messages
            if (typeof body.input === 'string') {
                body.input = [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }];
            } else if (!Array.isArray(body.input)) {
                return c.json(
                    { error: { message: 'input must be a string or array', type: 'invalid_request_error' } },
                    400
                );
            }

            // Translate Responses API → Chat Completions
            const ccRequest = responsesBodyToChatCompletions(body);

            // Always execute non-streaming internally; we wrap into SSE if the client wants streaming.
            ccRequest.stream = false;

            if (config.logging.debugMode) {
                console.log(`[${requestId}] /v1/responses → CC for model: ${ccRequest.model} (stream=${wantsStream})`);
            }

            // If ClawRoute is disabled, passthrough
            if (!runtimeConfig.enabled) {
                const response = await executePassthrough(ccRequest, runtimeConfig, runtimeSnapshot.modelCatalog);
                const ccJson = await response.json() as Record<string, unknown>;
                const responsesBody = chatCompletionToResponsesBody(ccJson);
                return wantsStream ? responsesBodyToSSEResponse(responsesBody) : c.json(responsesBody);
            }

            // Classify → Route → Execute
            const classification = classifyRequest(ccRequest, runtimeConfig);
            const routing = routeRequest(ccRequest, classification, runtimeConfig, runtimeSnapshot.modelCatalog);
            const result = await executeRequest(ccRequest, routing, classification, runtimeConfig, runtimeSnapshot.modelCatalog);

            // Translate CC response back to Responses API format
            const ccJson = await result.response.json() as Record<string, unknown>;
            const responsesBody = chatCompletionToResponsesBody(ccJson);
            return wantsStream ? responsesBodyToSSEResponse(responsesBody) : c.json(responsesBody);
        } catch (error) {
            console.error(`[${requestId}] Error in /v1/responses:`, error);
            const errorBody = {
                id: `resp_err_${requestId}`,
                object: 'response',
                status: 'failed',
                output: [],
                error: {
                    message: 'Failed to process request',
                    type: 'server_error',
                    code: 'internal_error',
                },
            };
            // When client wants SSE, return SSE-formatted error so the SDK parser
            // doesn't choke on raw JSON where it expects event-stream events.
            if (wantsStream) {
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(
                            `event: error\ndata: ${JSON.stringify(errorBody)}\n\n`
                        ));
                        controller.close();
                    },
                });
                return new Response(stream, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                    },
                });
            }
            return c.json(errorBody, 500);
        }
    });

    // Anthropic-compatible endpoint placeholder
    app.post('/v1/messages', async (c) => {
        // For now, return a helpful error
        // Full Anthropic format support coming in v1.1
        return c.json(
            {
                error: {
                    message:
                        'Anthropic native format not yet supported in v1.0. Use OpenAI-compatible format or OpenRouter.',
                    type: 'invalid_request_error',
                    code: 'unsupported_format',
                },
            },
            400
        );
    });

    // Legacy license endpoints removed

    // OpenAI-compatible: List models
    app.get('/v1/models', (c) => {
        const runtimeSnapshot = getRuntimeSnapshot();
        const models = getEnabledModelsFromCatalog(runtimeSnapshot.modelCatalog);

        // Virtual model: clawroute/auto — agents can select this to let
        // ClawRoute classify and route to the best model automatically.
        const autoModel = {
            id: 'clawroute/auto',
            object: 'model' as const,
            created: 1700000000,
            owned_by: 'clawroute',
            max_context: 1000000,
            context_length: 1000000,
            max_model_len: 1000000,
            tool_capable: true,
            multimodal: true,
            description: 'Auto-routes to the best model based on request complexity',
        };

        return c.json({
            object: 'list',
            data: [
                autoModel,
                ...models.map(m => ({
                    id: m.id,
                    object: 'model',
                    created: 1700000000,
                    owned_by: m.provider,
                    // Extension fields for ClawRoute-aware clients
                    max_context: m.maxContext,
                    context_length: m.maxContext,
                    max_model_len: m.maxContext,
                    tool_capable: m.toolCapable,
                    multimodal: m.multimodal,
                })),
            ],
        });
    });

    // OpenAI-compatible: Retrieve model
    app.get('/v1/models/:id{.+}', (c) => {
        const runtimeSnapshot = getRuntimeSnapshot();
        const modelId = c.req.param('id');

        // Virtual model: clawroute/auto
        if (modelId === 'clawroute/auto') {
            return c.json({
                id: 'clawroute/auto',
                object: 'model',
                created: 1700000000,
                owned_by: 'clawroute',
                max_context: 1000000,
                context_length: 1000000,
                max_model_len: 1000000,
                tool_capable: true,
                multimodal: true,
                description: 'Auto-routes to the best model based on request complexity',
            });
        }

        const entry = getModelEntryStrictFromCatalog(modelId, runtimeSnapshot.modelCatalog);
        if (!entry || !entry.enabled) {
            return c.json({
                error: {
                    message: `The model '${modelId}' does not exist`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            }, 404);
        }
        return c.json({
            id: entry.id,
            object: 'model',
            created: 1700000000,
            owned_by: entry.provider,
            max_context: entry.maxContext,
            context_length: entry.maxContext,
            max_model_len: entry.maxContext,
            tool_capable: entry.toolCapable,
            multimodal: entry.multimodal,
        });
    });

    // ClawRoute-specific: Full model info with costs
    app.get('/api/models', (c) => {
        const runtimeSnapshot = getRuntimeSnapshot();
        const models = getEnabledModelsFromCatalog(runtimeSnapshot.modelCatalog);
        return c.json({
            models: models.map(m => ({
                id: m.id,
                provider: m.provider,
                maxContext: m.maxContext,
                inputCostPer1M: m.inputCostPer1M,
                outputCostPer1M: m.outputCostPer1M,
                toolCapable: m.toolCapable,
                multimodal: m.multimodal,
                enabled: m.enabled,
            })),
        });
    });

    // Legacy completions API (not supported)
    app.post('/v1/completions', (c) => {
        return c.json({
            error: {
                message: 'Legacy completions API not supported. Use /v1/chat/completions instead.',
                type: 'invalid_request_error',
                code: 'unsupported_endpoint',
            },
        }, 400);
    });

    // Embeddings API (not supported)
    app.post('/v1/embeddings', (c) => {
        return c.json({
            error: {
                message: 'Embeddings API not supported by ClawRoute.',
                type: 'invalid_request_error',
                code: 'unsupported_endpoint',
            },
        }, 400);
    });

    // Catch-all for unknown routes
    app.all('*', (c) => {
        return c.json(
            {
                error: {
                    message: `Unknown endpoint: ${c.req.method} ${c.req.path}`,
                    type: 'invalid_request_error',
                    code: 'unknown_endpoint',
                },
            },
            404
        );
    });

    return app;
}
