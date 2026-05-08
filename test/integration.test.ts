/**
 * ClawRoute Integration Tests
 *
 * End-to-end tests for the proxy server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { TaskTier, ClawRouteConfig } from '../src/types.js';

// Mock fetch for provider calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        proxyPort: 18799, // Different port for tests
        proxyHost: '127.0.0.1',
        authToken: null,
        classification: {
            conservativeMode: true,
            minConfidence: 0.7,
            toolAwareRouting: true,
        },
        escalation: {
            enabled: true,
            maxRetries: 2,
            retryDelayMs: 10,
            onlyRetryBeforeStreaming: true,
            onlyRetryWithoutToolCalls: true,
            alwaysFallbackToOriginal: true,
        },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'google/gemini-2.5-flash-lite', fallback: 'deepseek/deepseek-chat' },
            [TaskTier.SIMPLE]: { primary: 'deepseek/deepseek-chat', fallback: 'google/gemini-2.5-flash' },
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-4o-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
            [TaskTier.FRONTIER]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
        },
        logging: {
            dbPath: ':memory:',
            logContent: false,
            logSystemPrompts: false,
            debugMode: false,
            retentionDays: 30,
        },
        dashboard: { enabled: true },
        overrides: { globalForceModel: null, sessions: {} },
        apiKeys: {
            anthropic: 'test-key',
            openai: 'test-key',
            google: 'test-key',
            deepseek: 'test-key',
            openrouter: '',
            ollama: '',
        },
        alerts: {},
    };
}

function createMockExecutionResult(actualModel: string) {
    return {
        response: new Response(
            JSON.stringify({
                id: 'mock-id',
                object: 'chat.completion',
                created: Date.now(),
                model: actualModel,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'mocked' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
        routingDecision: {
            originalModel: actualModel,
            routedModel: actualModel,
            tier: TaskTier.MODERATE,
            reason: 'mocked execution',
            confidence: 1,
            isDryRun: false,
            isOverride: false,
            isPassthrough: false,
            estimatedSavingsUsd: 0,
            safeToRetry: true,
        },
        actualModel,
        escalated: false,
        escalationChain: [actualModel],
        inputTokens: 5,
        outputTokens: 2,
        originalCostUsd: 0,
        actualCostUsd: 0,
        savingsUsd: 0,
        responseTimeMs: 1,
        hadToolCalls: false,
    };
}

describe('Integration Tests', () => {
    let app: Hono;

    beforeAll(async () => {
        // Import createApp after setting up mocks
        const { createApp } = await import('../src/server.js');
        app = createApp(createTestConfig());
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe('Health Endpoint', () => {
        it('should return health status', async () => {
            const res = await app.request('/health');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.status).toBe('ok');
            expect(body.version).toBe('1.1.0');
        });
    });

    describe('Stats Endpoint', () => {
        it('should return stats', async () => {
            const res = await app.request('/stats');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body).toHaveProperty('today');
            expect(body).toHaveProperty('thisWeek');
            expect(body).toHaveProperty('thisMonth');
            expect(body).toHaveProperty('allTime');
        });
    });

    describe('Config Endpoint', () => {
        it('should return redacted config', async () => {
            const res = await app.request('/api/config');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.apiKeys.openai).toBe('[REDACTED]');
        });
    });

    describe('Enable/Disable Endpoints', () => {
        it('should enable ClawRoute', async () => {
            const res = await app.request('/api/enable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.enabled).toBe(true);
        });

        it('should disable ClawRoute', async () => {
            const res = await app.request('/api/disable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.enabled).toBe(false);

            // Re-enable for other tests
            await app.request('/api/enable', { method: 'POST' });
        });
    });

    describe('Dry-Run Endpoints', () => {
        it('should enable dry-run', async () => {
            const res = await app.request('/api/dry-run/enable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.dryRun).toBe(true);
        });

        it('should disable dry-run', async () => {
            const res = await app.request('/api/dry-run/disable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.dryRun).toBe(false);
        });
    });

    describe('Global Override Endpoints', () => {
        it('should set global override', async () => {
            const res = await app.request('/api/override/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'openai/gpt-4o' }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.globalForceModel).toBe('openai/gpt-4o');
        });

        it('should remove global override', async () => {
            const res = await app.request('/api/override/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.globalForceModel).toBeNull();
        });
    });

    describe('Session Override Endpoints', () => {
        it('should set session override', async () => {
            const res = await app.request('/api/override/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: 'test-session', model: 'openai/gpt-4o', turns: 5 }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.sessionId).toBe('test-session');
        });

        it('should remove session override', async () => {
            const res = await app.request('/api/override/session', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: 'test-session' }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
        });
    });

    describe('Proxy Endpoint', () => {
        it('should handle chat completion request', async () => {
            // Mock successful provider response
            mockFetch.mockResolvedValueOnce(new Response(
                JSON.stringify({
                    id: 'test-id',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content: 'Hello!' },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));

            const res = await app.request('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'anthropic/claude-sonnet-4-5',
                    messages: [{ role: 'user', content: 'ping' }],
                }),
            });

            expect(res.status).toBe(200);
            expect(mockFetch).toHaveBeenCalled();
        });
    });

    describe('Codex Session Context', () => {
        it('threads the hashed sender session into execution before Codex selection runs', async () => {
            vi.resetModules();
            const executeRequestMock = vi.fn(async () => createMockExecutionResult('codex/gpt-5.4-mini'));
            vi.doMock('../src/executor.js', () => ({
                executeRequest: executeRequestMock,
                executePassthrough: vi.fn(async () => new Response('passthrough', { status: 200 })),
            }));

            const { createApp } = await import('../src/server.js');
            const localApp = createApp(createTestConfig());
            const senderId = '123456789';
            const expectedSessionId = createHash('sha256').update(senderId).digest('hex').slice(0, 8);

            const response = await localApp.request('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'codex/gpt-5.4-mini',
                    messages: [
                        { role: 'system', content: `{"sender_id":"${senderId}"}` },
                        { role: 'user', content: 'continue the same session' },
                    ],
                }),
            });

            const executionContext = executeRequestMock.mock.calls[0]?.[5] as { sessionId?: string | null } | undefined;

            expect(response.status).toBe(200);
            expect(executionContext).toMatchObject({ sessionId: expectedSessionId });
        });

        it('passes a null session context into execution when sender_id is absent', async () => {
            vi.resetModules();
            const executeRequestMock = vi.fn(async () => createMockExecutionResult('codex/gpt-5.4-mini'));
            vi.doMock('../src/executor.js', () => ({
                executeRequest: executeRequestMock,
                executePassthrough: vi.fn(async () => new Response('passthrough', { status: 200 })),
            }));

            const { createApp } = await import('../src/server.js');
            const localApp = createApp(createTestConfig());

            const response = await localApp.request('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'codex/gpt-5.4-mini',
                    messages: [{ role: 'user', content: 'first turn without sender metadata' }],
                }),
            });

            const executionContext = executeRequestMock.mock.calls[0]?.[5] as { sessionId?: string | null } | undefined;

            expect(response.status).toBe(200);
            expect(executionContext).toMatchObject({ sessionId: null });
        });
    });

    describe('Unknown Endpoints', () => {
        it('should return 404 for unknown routes', async () => {
            const res = await app.request('/unknown/endpoint');

            expect(res.status).toBe(404);
        });
    });

    describe('Anthropic Format Placeholder', () => {
        it('should return error for /v1/messages', async () => {
            const res = await app.request('/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'claude-3', messages: [] }),
            });
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error.code).toBe('unsupported_format');
        });
    });
});
