import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function hashAccountKey(accountId: string): string {
    return createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

function createTestConfig(authToken = ADMIN_TOKEN): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        baselineModel: 'openai/gpt-5.2',
        providerProfile: null,
        proxyPort: 18799,
        proxyHost: '127.0.0.1',
        authToken,
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

function authHeaders(token = ADMIN_TOKEN): HeadersInit {
    return { Authorization: `Bearer ${token}` };
}

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-usage-api-'));
    tempDirs.push(dir);
    return dir;
}

function writeAuth(dir: string, name: string, accessToken: string, accountId: string): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ tokens: { access_token: accessToken, account_id: accountId } }));
    return path;
}

function authHeader(init?: RequestInit): string {
    return String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
}

function usageResponse(accountId: string, usedPercent: number): Response {
    return new Response(JSON.stringify({
        account_id: accountId,
        primary_window: { limit_window_seconds: 18_000, used_percent: usedPercent, resets_at: 1_800_018_000 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function createTestApp(authToken = ADMIN_TOKEN): Promise<Hono> {
    resetModelRegistry();
    const { resetRotationState } = await import('../src/codex-transport.js');
    resetRotationState();
    const { createApp } = await import('../src/server.js');
    return createApp(createTestConfig(authToken));
}

beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', '');
    vi.stubEnv('OPENAI_CODEX_AUTH_PATH', '');
    vi.stubEnv('OPENAI_CODEX_TOKEN', '');
    vi.stubEnv('CODEX_HOME', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(() => {
    vi.restoreAllMocks();
});

describe('GET /api/codex/usage', () => {
    it('keeps the route behind bearer auth and returns partial sanitized JSON when one slot times out after authorization', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-live');
        const secondPath = writeAuth(dir, 'second.json', 'token-second', 'acct-timeout');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);
        mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (authHeader(init) === 'Bearer token-first') return usageResponse('acct-live', 17);
            if (authHeader(init) === 'Bearer token-second') throw new Error('slot 1 timed out');
            throw new Error(`Unexpected Authorization header: ${authHeader(init)}`);
        });
        const app = await createTestApp();

        const missing = await app.request('/api/codex/usage');
        expect(missing.status).toBe(401);
        expect(await missing.json()).toEqual(UNAUTHORIZED);

        const response = await app.request('/api/codex/usage', { headers: authHeaders() });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({
            partial: true,
            accounts: [expect.objectContaining({ accountKey: hashAccountKey('acct-live'), slotIndex: 0 })],
            slotErrors: [expect.objectContaining({ slotIndex: 1, message: expect.stringMatching(/timed out/i) })],
        });
    });

    it('returns sanitized dashboard JSON without auth when CLAWROUTE_TOKEN is unset', async () => {
        const dir = makeTempDir();
        const authPath = writeAuth(dir, 'auth.json', 'token-open', 'acct-open');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', authPath);
        mockFetch.mockResolvedValueOnce(usageResponse('acct-open', 29));
        const app = await createTestApp('');

        const response = await app.request('/api/codex/usage');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({
            partial: false,
            accounts: [expect.objectContaining({ accountKey: hashAccountKey('acct-open'), slotIndex: 0 })],
        });
    });
});

describe('GET /dashboard-codex', () => {
    it('serves a public HTML shell with codex usage UI markers for the next slice', async () => {
        const app = await createTestApp();

        const response = await app.request('/dashboard-codex');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/text\/html/i);
        const html = await response.text();
        expect(html).toContain('/api/codex/usage');
        expect(html).toMatch(/sessionStorage/i);
        expect(html).toMatch(/401|Authorization/i);
        expect(html).toMatch(/5h|5-hour/i);
        expect(html).toMatch(/weekly/i);
        expect(html).toMatch(/account-rows|accounts-list|accounts-body/i);
        expect(html).toMatch(/stale|partial/i);
        expect(html).toMatch(/last sync|last updated/i);
        expect(html).toMatch(/authCard\.classList\.contains\('hidden'\)\s*\|\|\s*sessionStorage\.getItem\(TOKEN_KEY\)/);
    });
});

describe('GET /dashboard2', () => {
    it('includes a discoverable link to the codex usage dashboard', async () => {
        const app = await createTestApp();

        const response = await app.request('/dashboard2');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/text\/html/i);
        expect(await response.text()).toMatch(/href=["'][^"']*\/dashboard-codex["']/i);
    });
});
