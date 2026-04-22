import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCodexRequest, resetRotationState } from '../src/codex-transport.js';

const tempDirs: string[] = [];
const baseRequest = {
    messages: [{ role: 'user', content: 'codex 429 regression coverage' }],
    stream: false,
};

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-429-'));
    tempDirs.push(dir);
    return dir;
}

function writeAuth(dir: string, name: string, accessToken: string, accountId: string): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ tokens: { access_token: accessToken, account_id: accountId } }));
    return path;
}

function writeInvalidAuth(dir: string, name: string): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ tokens: { access_token: 'stale-token' } }));
    return path;
}

function authHeader(init?: RequestInit): string {
    return String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
}

function codex429(message: string, type: string, metadata: Record<string, number> = {}): Response {
    return new Response(JSON.stringify({ error: { message, type, ...metadata } }), {
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

describe('makeCodexRequest 429 regressions', () => {
    it('does not rotate or cool down the slot for a 429 that is not usage_limit_reached', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-first');
        const secondPath = writeAuth(dir, 'second.json', 'token-second', 'acct-second');
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);

        let firstSlotCalls = 0;
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                firstSlotCalls += 1;
                if (firstSlotCalls === 1) {
                    return codex429('burst rate limit', 'request_rate_limited');
                }
                return successResponse('slot 0 handled the next request');
            }
            if (authorization === 'Bearer token-second') {
                return successResponse('slot 1 should stay unused');
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const firstResponse = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const secondResponse = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const secondBody = await secondResponse.json() as Record<string, unknown>;
        const choices = secondBody['choices'] as Array<Record<string, unknown>>;
        const message = choices[0]?.['message'] as Record<string, unknown>;

        expect(firstResponse.status).toBe(429);
        expect(secondResponse.status).toBe(200);
        expect(message['content']).toBe('slot 0 handled the next request');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(([, init]) => authHeader(init))).toEqual([
            'Bearer token-first',
            'Bearer token-first',
        ]);
    });

    it('returns the earliest reset metadata when every slot is already cooling down', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-first');
        const secondPath = writeAuth(dir, 'second.json', 'token-second', 'acct-second');
        const earliestResetAt = Math.floor(Date.now() / 1000) + 90;
        const laterResetAt = earliestResetAt + 300;
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                return codex429('slot 0 exhausted', 'usage_limit_reached', {
                    resets_at: earliestResetAt,
                    resets_in_seconds: 90,
                });
            }
            if (authorization === 'Bearer token-second') {
                return codex429('slot 1 exhausted', 'usage_limit_reached', {
                    resets_at: laterResetAt,
                    resets_in_seconds: 390,
                });
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const exhaustedResponse = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const coolingResponse = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const coolingBody = await coolingResponse.json() as { error: Record<string, unknown> };

        expect(exhaustedResponse.status).toBe(429);
        expect(coolingResponse.status).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(coolingBody.error['resets_at']).toBe(earliestResetAt);
    });

    it('returns the 429 cooldown metadata when the fallback slot auth file is invalid', async () => {
        const dir = makeTempDir();
        const firstPath = writeAuth(dir, 'first.json', 'token-first', 'acct-first');
        const stalePath = writeInvalidAuth(dir, 'stale.json');
        const resetAt = Math.floor(Date.now() / 1000) + 180;
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${stalePath}`);

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                return codex429('slot 0 exhausted', 'usage_limit_reached', {
                    resets_at: resetAt,
                    resets_in_seconds: 180,
                });
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as { error: Record<string, unknown> };

        expect(response.status).toBe(429);
        expect(body.error['resets_at']).toBe(resetAt);
        expect(body.error['resets_in_seconds']).toBeGreaterThan(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});