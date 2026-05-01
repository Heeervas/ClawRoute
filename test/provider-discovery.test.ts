import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ClawRouteConfig, TaskTier } from '../src/types.js';
import { resetModelRegistry } from '../src/models.js';

const ADMIN_TOKEN = 'admin-secret';
const UNAUTHORIZED = {
    error: {
        message: 'Unauthorized. Provide Bearer token in Authorization header or token query param.',
        type: 'authentication_error',
        code: 'unauthorized',
    },
};

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        baselineModel: 'openai/gpt-5.2',
        providerProfile: null,
        proxyPort: 18799,
        proxyHost: '127.0.0.1',
        authToken: ADMIN_TOKEN,
        classification: { conservativeMode: true, minConfidence: 0.7, toolAwareRouting: true },
        escalation: { enabled: true, maxRetries: 2, retryDelayMs: 10, onlyRetryBeforeStreaming: true, onlyRetryWithoutToolCalls: true, alwaysFallbackToOriginal: true },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'google/gemini-2.5-flash-lite', fallback: 'deepseek/deepseek-chat' },
            [TaskTier.SIMPLE]: { primary: 'deepseek/deepseek-chat', fallback: 'google/gemini-2.5-flash' },
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-5-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-6', fallback: 'openai/gpt-5.2' },
            [TaskTier.FRONTIER_SONNET]: { primary: 'anthropic/claude-sonnet-4-6', fallback: 'openai/gpt-5' },
            [TaskTier.FRONTIER_OPUS]: { primary: 'anthropic/claude-opus-4-6', fallback: 'openai/o3' },
        },
        logging: { dbPath: ':memory:', logContent: false, logSystemPrompts: false, debugMode: false, retentionDays: 30 },
        dashboard: { enabled: true },
        overrides: { globalForceModel: null, sessions: {} },
        apiKeys: { anthropic: 'test-key', openai: 'test-key', codex: 'test-key', google: 'test-key', deepseek: 'test-key', openrouter: '', ollama: '', 'x-ai': '', stepfun: '' },
        alerts: {},
    } as ClawRouteConfig;
}

function postJson(body: unknown, token = ADMIN_TOKEN): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    };
}

function authHeaders(token = ADMIN_TOKEN): HeadersInit {
    return { Authorization: `Bearer ${token}` };
}

describe('Provider discovery', () => {
    let app: Hono;

    beforeEach(async () => {
        mockFetch.mockReset();
        resetModelRegistry();
        const { createApp } = await import('../src/server.js');
        app = createApp(createTestConfig());
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    it('keeps discover protected with the existing 401 payload and leaves the live catalogs unchanged until add persists a candidate', async () => {
        const missing = await app.request('/api/admin/models/discover', { method: 'POST' });
        expect(missing.status).toBe(401);
        expect(await missing.json()).toEqual(UNAUTHORIZED);

        const invalid = await app.request('/api/admin/models/discover', postJson({ provider: 'openai' }, 'wrong-token'));
        expect(invalid.status).toBe(401);
        expect(await invalid.json()).toEqual(UNAUTHORIZED);

        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-5.2' }, { id: 'gpt-discovery-preview' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const beforeApi = await app.request('/api/models', { headers: authHeaders() });
        expect(beforeApi.status).toBe(200);
        const beforeBody = await beforeApi.json();

        const discover = await app.request('/api/admin/models/discover', postJson({ provider: 'openai' }));
        expect(discover.status).toBe(200);
        const discoverBody = await discover.json();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(discoverBody.candidates.map((candidate: { id: string }) => candidate.id)).toContain('openai/gpt-discovery-preview');

        const afterApi = await app.request('/api/models', { headers: authHeaders() });
        const afterV1 = await app.request('/v1/models');
        expect(afterApi.status).toBe(200);
        expect(afterV1.status).toBe(200);

        const afterApiBody = await afterApi.json();
        const afterV1Body = await afterV1.json();

        expect(beforeBody.models.find((model: { id: string }) => model.id === 'openai/gpt-discovery-preview')).toBeUndefined();
        expect(afterApiBody.models.find((model: { id: string }) => model.id === 'openai/gpt-discovery-preview')).toBeUndefined();
        expect(afterV1Body.data.find((model: { id: string }) => model.id === 'openai/gpt-discovery-preview')).toBeUndefined();
    });

    it('rejects unknown provider ids before discovery runs', async () => {
        const response = await app.request('/api/admin/models/discover', postJson({ provider: 'foo' }));
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe('invalid_provider');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('marks incomplete discovered candidates as discoveryOnly and reports the missing metadata fields', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-incomplete-preview' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const discover = await app.request('/api/admin/models/discover', postJson({ provider: 'openai' }));
        expect(discover.status).toBe(200);
        const body = await discover.json();

        expect(body.candidates).toContainEqual(expect.objectContaining({
            id: 'openai/gpt-incomplete-preview',
            provider: 'openai',
            discoveryOnly: true,
            missingFields: expect.arrayContaining(['maxContext', 'toolCapable', 'multimodal', 'enabled', 'inputCostPer1M', 'outputCostPer1M']),
        }));
    });
});