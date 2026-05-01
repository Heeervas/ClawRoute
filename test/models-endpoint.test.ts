/**
 * ClawRoute Model Endpoints Tests
 *
 * Tests for OpenAI-compatible /v1/models endpoints,
 * internal /api/models, context overrides, and stub endpoints.
 *
 * RED state: These tests should FAIL until implementation is done.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskTier, ClawRouteConfig, ModelEntry } from '../src/types.js';
import { getAllModels, getModelEntry, registerModel, getEnabledModels, applyContextOverrides, DEFAULT_MODELS } from '../src/models.js';

// Mock fetch for provider calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        proxyPort: 18799,
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
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-5-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-6', fallback: 'openai/gpt-5.2' },
            [TaskTier.FRONTIER_SONNET]: { primary: 'anthropic/claude-sonnet-4-6', fallback: 'openai/gpt-5' },
            [TaskTier.FRONTIER_OPUS]: { primary: 'anthropic/claude-opus-4-6', fallback: 'openai/o3' },
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
            codex: 'test-key',
            google: 'test-key',
            deepseek: 'test-key',
            openrouter: '',
            ollama: '',
            'x-ai': '',
            stepfun: '',
        },
        alerts: {},
    } as ClawRouteConfig;
}

describe('Model Endpoints', () => {
    let app: Hono;

    beforeAll(async () => {
        const { createApp } = await import('../src/server.js');
        app = createApp(createTestConfig());
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        mockFetch.mockReset();
    });

    // ─── GET /v1/models ─────────────────────────────────────────────

    describe('GET /v1/models', () => {
        it('should return 200 with OpenAI list format', async () => {
            const res = await app.request('/v1/models');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.object).toBe('list');
            expect(Array.isArray(body.data)).toBe(true);
            expect(body.data.length).toBeGreaterThan(0);
        });

        it('should include required OpenAI fields on each model', async () => {
            const res = await app.request('/v1/models');
            const body = await res.json();
            const model = body.data[0];

            expect(model).toHaveProperty('id');
            expect(model.object).toBe('model');
            expect(typeof model.created).toBe('number');
            expect(typeof model.owned_by).toBe('string');
        });

        it('should include extension fields on each model', async () => {
            const res = await app.request('/v1/models');
            const body = await res.json();
            const model = body.data[0];

            expect(typeof model.max_context).toBe('number');
            expect(typeof model.context_length).toBe('number');
            expect(typeof model.max_model_len).toBe('number');
            expect(model.context_length).toBe(model.max_context);
            expect(model.max_model_len).toBe(model.max_context);
            expect(typeof model.tool_capable).toBe('boolean');
            expect(typeof model.multimodal).toBe('boolean');
        });

        it('should expose bundled codex/gpt-5.5 in the resolved catalog', async () => {
            const res = await app.request('/v1/models');
            const body = await res.json();

            const model = body.data.find((entry: { id: string }) => entry.id === 'codex/gpt-5.5');

            expect(model).toMatchObject({
                id: 'codex/gpt-5.5',
                owned_by: 'codex',
                tool_capable: true,
            });
        });

        it('should only return enabled models', async () => {
            // Register a disabled model
            registerModel({
                id: 'test/disabled-model',
                provider: 'openai',
                inputCostPer1M: 0,
                outputCostPer1M: 0,
                maxContext: 4096,
                toolCapable: false,
                multimodal: false,
                enabled: false,
            });

            const res = await app.request('/v1/models');
            const body = await res.json();

            const disabledModel = body.data.find((m: { id: string }) => m.id === 'test/disabled-model');
            expect(disabledModel).toBeUndefined();
        });
    });

    // ─── GET /v1/models/:id ─────────────────────────────────────────

    describe('GET /v1/models/:id', () => {
        it('should return 200 with a single model for a known ID', async () => {
            const res = await app.request('/v1/models/codex/gpt-5.4');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.id).toBe('codex/gpt-5.4');
            expect(body.object).toBe('model');
            expect(typeof body.created).toBe('number');
            expect(typeof body.owned_by).toBe('string');
            expect(body.context_length).toBe(body.max_context);
            expect(body.max_model_len).toBe(body.max_context);
        });

        it('should handle multi-slash model IDs (e.g., openrouter/google/gemini-2.5-flash)', async () => {
            const res = await app.request('/v1/models/openrouter/google/gemini-2.5-flash');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.id).toBe('openrouter/google/gemini-2.5-flash');
            expect(body.object).toBe('model');
        });

        it('should return 404 for an unknown model ID', async () => {
            const res = await app.request('/v1/models/nonexistent/model-xyz');
            const body = await res.json();

            expect(res.status).toBe(404);
            expect(body.error).toBeDefined();
            expect(body.error.type).toBe('invalid_request_error');
        });

        it('should NOT fuzzy-match partial model IDs', async () => {
            // 'gpt' alone should not match any model
            const res = await app.request('/v1/models/gpt');

            expect(res.status).toBe(404);
        });
    });

    // ─── GET /api/models ────────────────────────────────────────────

    describe('GET /api/models', () => {
        it('should return 200 with { models: [...] } format', async () => {
            const res = await app.request('/api/models');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(Array.isArray(body.models)).toBe(true);
            expect(body.models.length).toBeGreaterThan(0);
        });

        it('should include full model info on each entry', async () => {
            const res = await app.request('/api/models');
            const body = await res.json();
            const model = body.models[0];

            expect(model).toHaveProperty('id');
            expect(model).toHaveProperty('provider');
            expect(typeof model.maxContext).toBe('number');
            expect(typeof model.inputCostPer1M).toBe('number');
            expect(typeof model.outputCostPer1M).toBe('number');
            expect(typeof model.toolCapable).toBe('boolean');
            expect(typeof model.multimodal).toBe('boolean');
            expect(typeof model.enabled).toBe('boolean');
        });
    });

    // ─── Stub endpoints ─────────────────────────────────────────────

    describe('Stub endpoints', () => {
        it('POST /v1/completions should return 400 with helpful message', async () => {
            const res = await app.request('/v1/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-5', prompt: 'Hello' }),
            });
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error).toBeDefined();
            expect(body.error.message).toMatch(/chat\/completions/i);
        });

        it('POST /v1/embeddings should return 400 with helpful message', async () => {
            const res = await app.request('/v1/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'text-embedding-3-small', input: 'Hello' }),
            });
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error).toBeDefined();
            expect(body.error.message).toMatch(/not supported/i);
        });
    });
});

// ─── Context Override Functions ─────────────────────────────────────

describe('Context Overrides', () => {
    // Snapshot original maxContext values so we can restore after override tests
    const originalContextValues = new Map<string, number>();

    beforeEach(() => {
        for (const m of getAllModels()) {
            originalContextValues.set(m.id, m.maxContext);
        }
    });

    afterEach(() => {
        // Restore original maxContext values
        for (const [id, maxCtx] of originalContextValues) {
            const entry = getModelEntry(id);
            if (entry) entry.maxContext = maxCtx;
        }
        originalContextValues.clear();
    });

    describe('getEnabledModels()', () => {
        it('should return only models with enabled: true', () => {
            // Register a disabled model for the test
            registerModel({
                id: 'test/override-disabled',
                provider: 'openai',
                inputCostPer1M: 0,
                outputCostPer1M: 0,
                maxContext: 4096,
                toolCapable: false,
                multimodal: false,
                enabled: false,
            });

            const enabled = getEnabledModels();
            const allModels = getAllModels();

            expect(enabled.length).toBeLessThan(allModels.length);
            expect(enabled.every((m: ModelEntry) => m.enabled === true)).toBe(true);

            const found = enabled.find((m: ModelEntry) => m.id === 'test/override-disabled');
            expect(found).toBeUndefined();
        });
    });

    describe('applyContextOverrides()', () => {
        it('should change maxContext on a known model', () => {
            const overrides = { 'anthropic/claude-sonnet-4-6': 180000 };
            applyContextOverrides(overrides);

            const entry = getModelEntry('anthropic/claude-sonnet-4-6');
            expect(entry).not.toBeNull();
            expect(entry!.maxContext).toBe(180000);
        });

        it('should warn and ignore unknown model IDs', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const overrides = { 'nonexistent/fake-model-999': 50000 };
            applyContextOverrides(overrides);

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('nonexistent/fake-model-999'),
            );

            warnSpy.mockRestore();
        });

        it('should reflect updated maxContext in /v1/models response', async () => {
            const { createApp } = await import('../src/server.js');
            const app = createApp(createTestConfig());

            // Apply an override
            applyContextOverrides({ 'anthropic/claude-sonnet-4-6': 150000 });

            const res = await app.request('/v1/models');
            const body = await res.json();

            const model = body.data.find((m: { id: string }) => m.id === 'anthropic/claude-sonnet-4-6');
            expect(model).toBeDefined();
            expect(model.max_context).toBe(150000);
        });
    });
});
