import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getRotationState,
    initializeSlots,
    makeCodexRequest,
    performRotation,
    releaseCodexAuth,
    resetRotationState,
    resolveAuthPaths,
    shouldRotate,
} from '../src/codex-transport.js';

const tempDirs: string[] = [];
const baseRequest = {
    messages: [{ role: 'user', content: 'hello from the regression test' }],
    stream: false,
};

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rotation-'));
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

function rateLimitResponse(message: string, metadata: Record<string, number> = {}): Response {
    return new Response(JSON.stringify({ error: { message, type: 'usage_limit_reached', ...metadata } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
    });
}

function successResponse(text: string): Response {
    const body = [
        'event: response.output_text.delta',
        `data: ${JSON.stringify({ delta: text })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 5 } } })}`,
        '',
    ].join('\n');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
    resetRotationState();
    vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', '');
    vi.stubEnv('OPENAI_CODEX_AUTH_PATH', '');
    vi.stubEnv('OPENAI_CODEX_TOKEN', '');
    vi.stubEnv('CODEX_HOME', '');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRotationState();
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('resolveAuthPaths', () => {
    it('prefers OPENAI_CODEX_AUTH_PATHS and trims whitespace', () => {
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', ' /a.json , /b.json ');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATH', '/single.json');
        expect(resolveAuthPaths()).toEqual(['/a.json', '/b.json']);
    });

    it('falls back to the single auth path', () => {
        vi.stubEnv('OPENAI_CODEX_AUTH_PATH', '/single.json');
        expect(resolveAuthPaths()).toEqual(['/single.json']);
    });

    it('returns no auth paths in token mode', () => {
        vi.stubEnv('OPENAI_CODEX_TOKEN', 'sess-token');
        expect(resolveAuthPaths()).toEqual([]);
    });

    it('uses the default codex auth file when env vars are absent', () => {
        expect(resolveAuthPaths()[0]).toMatch(/\.codex\/auth\.json$/);
    });
});

describe('rotation helpers', () => {
    it('keeps rotation disabled when only one slot exists', () => {
        initializeSlots(['/a.json']);
        expect(shouldRotate()).toBe(false);
    });

    it('rotates round-robin and records the new index', () => {
        initializeSlots(['/a.json', '/b.json', '/c.json']);
        performRotation();
        performRotation();
        performRotation();
        expect(getRotationState().currentSlotIndex).toBe(0);
    });

    it('updates lastQueryEndTime without letting activeRequests go negative', () => {
        initializeSlots(['/a.json']);
        const before = getRotationState().lastQueryEndTime;
        releaseCodexAuth();
        const after = getRotationState();
        expect(after.lastQueryEndTime).toBeGreaterThanOrEqual(before);
        expect(after.activeRequests).toBe(0);
    });
});

describe('makeCodexRequest regressions', () => {
    it('retries the second auth slot on the same first cold-start request after slot 0 returns 429', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-first');
        const secondPath = writeAuth(dir, 'second.json', 'token-second', 'acct-second');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                return rateLimitResponse('slot 0 exhausted', { resets_in_seconds: 45 });
            }
            if (authorization === 'Bearer token-second') {
                return successResponse('slot 1 answered after the retry');
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(([, init]) => authHeader(init))).toEqual([
            'Bearer token-first',
            'Bearer token-second',
        ]);
        expect(response.status).toBe(200);
        const body = await response.json() as Record<string, unknown>;
        const choices = body['choices'] as Array<Record<string, unknown>>;
        const message = choices[0]?.['message'] as Record<string, unknown>;
        expect(message['content']).toBe('slot 1 answered after the retry');
    });

    it('returns a single-wrapped exhausted-slots 429 that preserves cooldown metadata from upstream JSON', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-first');
        const secondPath = writeAuth(dir, 'second.json', 'token-second', 'acct-second');
        const resetsAt = Math.floor(Date.now() / 1000) + 600;
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);
        initializeSlots([firstPath, secondPath]);

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                return rateLimitResponse('slot 0 exhausted', { resets_in_seconds: 30 });
            }
            if (authorization === 'Bearer token-second') {
                return rateLimitResponse('slot 1 exhausted', {
                    resets_at: resetsAt,
                    resets_in_seconds: 600,
                });
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as { error: Record<string, unknown> };

        expect(response.status).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(body.error['resets_at']).toBe(resetsAt);
        expect(body.error['resets_in_seconds']).toBe(600);
        expect(body.error['message']).toContain('slot 1 exhausted');
        expect(body.error['message']).not.toContain('{"error":');
    });

    it('uses a single attempt in token mode even when auth paths are also configured', async () => {
        vi.stubEnv('OPENAI_CODEX_TOKEN', 'sess-token');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', '/unused/first.json,/unused/second.json');
        const fetchMock = vi.fn(async () => rateLimitResponse('token mode quota', { resets_in_seconds: 30 }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('chatgpt-account-id');
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty('Authorization', 'Bearer sess-token');
        expect(response.status).toBe(429);
    });
});
