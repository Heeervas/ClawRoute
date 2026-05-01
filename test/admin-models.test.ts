import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const tempDirs: string[] = [];

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

function deleteRequest(token = ADMIN_TOKEN): RequestInit {
    return { method: 'DELETE', headers: authHeaders(token) };
}

function makeTempProjectRoot(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), 'admin-models-'));
    tempDirs.push(projectRoot);
    return projectRoot;
}

function writeJson(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedProjectRoot(projectRoot: string): void {
    writeJson(join(projectRoot, 'config', 'default.json'), {
        providerProfile: 'openrouter',
        baselineModel: 'openai/gpt-5.2',
        models: createTestConfig().models,
    });
    writeJson(join(projectRoot, 'config', 'clawroute.json'), {
        providerProfile: 'openrouter',
        baselineModel: 'openai/gpt-5.2',
        models: createTestConfig().models,
    });
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('Admin model management', () => {
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

    it('returns the existing 401 payload without auth, rejects incomplete add payloads, and exposes a fully added model in both catalogs', async () => {
        const modelId = 'openai/gpt-admin-preview';
        const missing = await app.request('/api/admin/models', { method: 'POST' });
        expect(missing.status).toBe(401);
        expect(await missing.json()).toEqual(UNAUTHORIZED);

        const invalid = await app.request('/api/admin/models', postJson({ id: modelId }, 'wrong-token'));
        expect(invalid.status).toBe(401);
        expect(await invalid.json()).toEqual(UNAUTHORIZED);

        const incomplete = await app.request('/api/admin/models', postJson({ id: modelId, provider: 'openai' }));
        expect(incomplete.status).toBe(400);
        const incompleteBody = await incomplete.json();
        expect(incompleteBody.missingFields).toEqual(expect.arrayContaining(['maxContext', 'toolCapable', 'multimodal', 'enabled', 'inputCostPer1M', 'outputCostPer1M']));

        const added = await app.request('/api/admin/models', postJson({ id: modelId, provider: 'openai', maxContext: 128000, toolCapable: true, multimodal: true, enabled: true, inputCostPer1M: 0.75, outputCostPer1M: 3.0 }));
        expect(added.status).toBe(200);

        const apiModels = await app.request('/api/models', { headers: authHeaders() });
        const v1Models = await app.request('/v1/models');
        expect(apiModels.status).toBe(200);
        expect(v1Models.status).toBe(200);

        const apiBody = await apiModels.json();
        const v1Body = await v1Models.json();
        expect(apiBody.models.find((model: { id: string }) => model.id === modelId)).toBeDefined();
        expect(v1Body.data.find((model: { id: string }) => model.id === modelId)).toBeDefined();
    });

    it('rejects invalid numeric metadata instead of coercing it into a persisted model', async () => {
        const invalid = await app.request('/api/admin/models', postJson({
            id: 'openai/gpt-bad-metadata',
            provider: 'openai',
            maxContext: 0,
            toolCapable: true,
            multimodal: false,
            enabled: true,
            inputCostPer1M: -1,
            outputCostPer1M: Number.NaN,
        }));

        expect(invalid.status).toBe(400);
        const body = await invalid.json();
        expect(body.error.message).toMatch(/invalid/i);
        expect(body.invalidFields).toEqual(expect.arrayContaining(['maxContext', 'inputCostPer1M', 'outputCostPer1M']));
    });

    it('rejects unknown provider ids before persisting a model', async () => {
        const response = await app.request('/api/admin/models', postJson({
            id: 'foo/gpt-preview',
            provider: 'foo',
            maxContext: 128000,
            toolCapable: true,
            multimodal: false,
            enabled: true,
            inputCostPer1M: 0.2,
            outputCostPer1M: 0.8,
        }));
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe('invalid_provider');
    });

    it('rejects tier updates that target discovery-only or incomplete model ids', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-tier-preview' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const discover = await app.request('/api/admin/models/discover', postJson({ provider: 'openai' }));
        expect(discover.status).toBe(200);

        const setTier = await app.request('/api/admin/tiers/complex', postJson({ primary: 'openai/gpt-tier-preview', fallback: 'openai/gpt-5.2' }));
        expect(setTier.status).toBe(400);
        const body = await setTier.json();
        expect(body.error.message).toMatch(/discovery-only|incomplete/i);
    });

    it('blocks removal while a model is still referenced by a tier and removes it once the reference is cleared', async () => {
        const modelId = 'openai/gpt-removable-preview';
        const encodedId = encodeURIComponent(modelId);

        const added = await app.request('/api/admin/models', postJson({ id: modelId, provider: 'openai', maxContext: 64000, toolCapable: true, multimodal: false, enabled: true, inputCostPer1M: 0.4, outputCostPer1M: 1.6 }));
        expect(added.status).toBe(200);

        const referenced = await app.request('/api/admin/tiers/complex', postJson({ primary: modelId, fallback: 'openai/gpt-5.2' }));
        expect(referenced.status).toBe(200);

        const blockedDelete = await app.request(`/api/admin/models/${encodedId}`, deleteRequest());
        expect(blockedDelete.status).toBe(409);
        const blockedBody = await blockedDelete.json();
        expect(blockedBody.error.message).toMatch(/referenced/i);

        const cleared = await app.request('/api/admin/tiers/complex', postJson({ primary: 'anthropic/claude-sonnet-4-6', fallback: 'openai/gpt-5.2' }));
        expect(cleared.status).toBe(200);

        const deleted = await app.request(`/api/admin/models/${encodedId}`, deleteRequest());
        expect(deleted.status).toBe(200);

        const apiModels = await app.request('/api/models', { headers: authHeaders() });
        const v1Models = await app.request('/v1/models');
        const apiBody = await apiModels.json();
        const v1Body = await v1Models.json();
        expect(apiBody.models.find((model: { id: string }) => model.id === modelId)).toBeUndefined();
        expect(v1Body.data.find((model: { id: string }) => model.id === modelId)).toBeUndefined();
    });

    it('persists admin model additions to config/model-registry.json and tier updates to config/clawroute.json when runtime state is wired', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot);

        const { createRuntimeStateManager } = await import('../src/runtime-state.js');
        const runtimeState = createRuntimeStateManager({ projectRoot });
        const { createApp } = await import('../src/server.js');
        const runtimeApp = createApp(createTestConfig(), { projectRoot, runtimeState });

        const modelId = 'openai/gpt-persisted-admin';
        const added = await runtimeApp.request('/api/admin/models', postJson({ id: modelId, provider: 'openai', maxContext: 128000, toolCapable: true, multimodal: false, enabled: true, inputCostPer1M: 0.3, outputCostPer1M: 1.2 }));
        expect(added.status).toBe(200);

        const updatedTier = await runtimeApp.request('/api/admin/tiers/complex', postJson({ primary: modelId, fallback: 'openai/gpt-5.2' }));
        expect(updatedTier.status).toBe(200);

        const registryContent = JSON.parse(readFileSync(join(projectRoot, 'config', 'model-registry.json'), 'utf-8')) as { models: Record<string, unknown> };
        const userConfig = JSON.parse(readFileSync(join(projectRoot, 'config', 'clawroute.json'), 'utf-8')) as { models: Record<string, { primary: string; fallback: string }> };

        expect(registryContent.models[modelId]).toBeDefined();
        expect(userConfig.models.complex).toEqual({ primary: modelId, fallback: 'openai/gpt-5.2' });

        runtimeState.stop();
    });

    it('rolls back runtime-backed admin writes when reload validation fails', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot);

        const { createRuntimeStateManager } = await import('../src/runtime-state.js');
        const runtimeState = createRuntimeStateManager({ projectRoot });
        const { createApp } = await import('../src/server.js');
        const runtimeApp = createApp(createTestConfig(), { projectRoot, runtimeState });

        const response = await runtimeApp.request('/api/admin/models', postJson({
            id: 'openai/gpt-5-mini',
            provider: 'openai',
            maxContext: 128000,
            toolCapable: true,
            multimodal: true,
            enabled: false,
            inputCostPer1M: 0.15,
            outputCostPer1M: 0.6,
        }));

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error.message).toMatch(/reload|disabled|fallback/i);

        const registryPath = join(projectRoot, 'config', 'model-registry.json');
        const registryContent = readFileSync(registryPath, 'utf-8');
        expect(registryContent).not.toContain('"openai/gpt-5-mini"');
        expect(runtimeState.getSnapshot().models[TaskTier.MODERATE].fallback).toBe('openai/gpt-5-mini');

        runtimeState.stop();
    });
});