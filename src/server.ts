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
} from './types.js';
import { createAuthMiddleware } from './auth.js';
import { classifyRequest, explainClassification } from './classifier.js';
import { routeRequest } from './router.js';
import { executeRequest, executePassthrough } from './executor.js';
import { logRouting } from './logger.js';
import { getStatsResponse } from './stats.js';
import { getRedactedConfig } from './config.js';
import { generateRequestId, nowIso, stripMetadataPreamble } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create the Hono application.
 *
 * @param config - The ClawRoute configuration
 * @returns Configured Hono app
 */
export function createApp(config: ClawRouteConfig): Hono {
    const app = new Hono();

    // CORS for dashboard
    app.use('*', cors());

    // Auth middleware
    app.use('/v1/*', createAuthMiddleware(config));
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

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Incoming request for model: ${body.model}`);
            }

            // If ClawRoute is disabled, passthrough
            if (!config.enabled) {
                if (config.logging.debugMode) {
                    console.log(`[${requestId}] Passthrough (disabled)`);
                }
                const response = await executePassthrough(body, config);
                return response;
            }

            // Classify the request
            const classification = classifyRequest(body, config);

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Classification: ${explainClassification(classification)}`);
            }

            // Route to model
            const routing = routeRequest(body, classification, config);

            if (config.logging.debugMode) {
                console.log(
                    `[${requestId}] Routing: ${routing.originalModel} → ${routing.routedModel} (${routing.reason})`
                );
            }

            // Execute the request
            const result = await executeRequest(body, routing, classification, config);

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
                const response = await executePassthrough(body, config);
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
