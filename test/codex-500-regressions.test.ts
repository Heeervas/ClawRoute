import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCodexRequest, resetRotationState } from '../src/codex-transport.js';

const tempDirs: string[] = [];
const baseRequest = { messages: [{ role: 'user', content: 'check 500 retry routing' }], stream: false };

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codex-500-'));
    tempDirs.push(dir);
    return dir;
}

function writeAuth(path: string, tokens: Record<string, string>): void {
    writeFileSync(path, JSON.stringify({ tokens }));
}

function createSseResponse(events: Array<{ event: string; data: Record<string, unknown> }>): Response {
    const encoder = new TextEncoder();
    const body = events
        .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        .join('');

    return new Response(encoder.encode(body), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

function authHeader(init?: RequestInit): string {
    return String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
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

async function importTransportWithBalanceLoaderMocks(options: {
    selectorSnapshot: Record<string, unknown>;
    selectorResult: Record<string, unknown>;
}) {
    vi.resetModules();
    const getCodexUsageSelectorSnapshot = vi.fn(async () => options.selectorSnapshot);
    const selectCodexBalanceCandidate = vi.fn(() => options.selectorResult);

    vi.doMock('../src/codex-usage.js', async () => {
        const actual = await vi.importActual<Record<string, unknown>>('../src/codex-usage.js');
        return {
            ...actual,
            getCodexUsageSelectorSnapshot,
        };
    });
    vi.doMock('../src/codex-balance-loader.js', () => ({ selectCodexBalanceCandidate }));

    return {
        transport: await import('../src/codex-transport.js'),
        getCodexUsageSelectorSnapshot,
        selectCodexBalanceCandidate,
    };
}

beforeEach(() => {
    resetRotationState();
    vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', '');
    vi.stubEnv('OPENAI_CODEX_AUTH_PATH', '');
    vi.stubEnv('OPENAI_CODEX_TOKEN', '');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    resetRotationState();
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('makeCodexRequest 500 regressions', () => {
    it('does not retry the same slot after a 500 when the fallback auth file is invalid', async () => {
        const dir = makeTempDir();
        const firstPath = join(dir, 'first.json');
        const stalePath = join(dir, 'stale.json');
        writeAuth(firstPath, { access_token: 'token-first', account_id: 'acct-first' });
        writeAuth(stalePath, { access_token: 'token-stale' });
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${stalePath}`);

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'slot 0 failed' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as { error: Record<string, unknown> };

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(500);
        expect(body.error['message']).toContain('slot 0 failed');
    });

    it('includes slot and the real auth error code on direct HTTP auth failures', async () => {
        const dir = makeTempDir();
        const firstPath = join(dir, 'expired.json');
        writeAuth(firstPath, { access_token: 'token-expired', account_id: 'acct-expired' });
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', firstPath);

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            error: {
                message: 'Session expired',
                code: 'invalid_api_key',
                type: 'auth_error',
            },
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as { error: Record<string, unknown> };

        expect(response.status).toBe(401);
        expect(body.error).toMatchObject({
            code: 'invalid_api_key',
            type: 'auth_error',
            slot: 0,
        });
        expect(body.error).not.toHaveProperty('path');
        expect(body.error).not.toHaveProperty('slot_path');
        expect(body.error['message']).toBe('Codex API error (401): Session expired [slot:0 code:invalid_api_key]');
    });

    it('returns non-2xx for non-streaming terminal error events after a 200 upstream response', async () => {
        const dir = makeTempDir();
        const firstPath = join(dir, 'expired.json');
        writeAuth(firstPath, { access_token: 'token-expired', account_id: 'acct-expired' });
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', firstPath);

        const fetchMock = vi.fn(async () => createSseResponse([
            {
                event: 'error',
                data: {
                    error: {
                        message: 'Session expired',
                        code: 'invalid_api_key',
                        type: 'auth_error',
                    },
                },
            },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const response = await makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as { error: Record<string, unknown> };

        expect(response.status).toBe(401);
        expect(body.error).toMatchObject({
            code: 'invalid_api_key',
            type: 'auth_error',
            slot: 0,
        });
        expect(body.error).not.toHaveProperty('path');
    });

    it('retries the next slot after a 500 when selector-on starts from the chosen account', async () => {
        const dir = makeTempDir();
        const firstPath = join(dir, 'first.json');
        const secondPath = join(dir, 'second.json');
        writeAuth(firstPath, { access_token: 'token-first', account_id: 'acct-first' });
        writeAuth(secondPath, { access_token: 'token-second', account_id: 'acct-second' });
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${firstPath},${secondPath}`);
        vi.stubEnv('CODEX_BALANCE_LOADER_MODE', 'on');

        const { transport, getCodexUsageSelectorSnapshot, selectCodexBalanceCandidate } = await importTransportWithBalanceLoaderMocks({
            selectorSnapshot: {
                fallbackReason: null,
                accounts: [
                    {
                        accountKey: 'acct-second-key',
                        slotIndex: 1,
                        slotIndexes: [1],
                        slotPaths: [secondPath],
                        source: 'persisted',
                        stale: false,
                        cooldownUntil: null,
                        lastFetchedAt: null,
                        updatedAt: new Date().toISOString(),
                        fiveHour: { usedPercent: 15, resetAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(), window: 'fiveHour', windowMinutes: 300 },
                        weekly: { usedPercent: 20, resetAt: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: new Date().toISOString(), window: 'weekly', windowMinutes: 10_080 },
                    },
                ],
            },
            selectorResult: {
                fallbackReason: null,
                selectedAccountKey: 'acct-second-key',
                selectedSlotIndex: 1,
                affinityApplied: false,
            },
        });
        transport.resetRotationState();

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-second') {
                return new Response(JSON.stringify({ error: { message: 'slot 1 failed' } }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (authorization === 'Bearer token-first') {
                return successResponse('slot 0 recovered after the selector-picked slot failed');
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await transport.makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as Record<string, unknown>;
        const choices = body['choices'] as Array<Record<string, unknown>>;
        const message = choices[0]?.['message'] as Record<string, unknown>;

        expect(getCodexUsageSelectorSnapshot).toHaveBeenCalledTimes(1);
        expect(selectCodexBalanceCandidate).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(([, init]) => authHeader(init))).toEqual([
            'Bearer token-second',
            'Bearer token-first',
        ]);
        expect(response.status).toBe(200);
        expect(message['content']).toBe('slot 0 recovered after the selector-picked slot failed');
    });

    it('keeps auth-load fallback semantics when selector-on points at an unreadable slot', async () => {
        const dir = makeTempDir();
        const validPath = join(dir, 'valid.json');
        const unreadablePath = join(dir, 'unreadable.json');
        writeAuth(validPath, { access_token: 'token-first', account_id: 'acct-first' });
        writeAuth(unreadablePath, { access_token: 'token-unreadable' });
        vi.stubEnv('OPENAI_CODEX_AUTH_PATHS', `${validPath},${unreadablePath}`);
        vi.stubEnv('CODEX_BALANCE_LOADER_MODE', 'on');

        const { transport, getCodexUsageSelectorSnapshot, selectCodexBalanceCandidate } = await importTransportWithBalanceLoaderMocks({
            selectorSnapshot: {
                fallbackReason: null,
                accounts: [
                    {
                        accountKey: 'acct-unreadable-key',
                        slotIndex: 1,
                        slotIndexes: [1],
                        slotPaths: [unreadablePath],
                        source: 'persisted',
                        stale: false,
                        cooldownUntil: null,
                        lastFetchedAt: null,
                        updatedAt: new Date().toISOString(),
                        fiveHour: { usedPercent: 10, resetAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(), window: 'fiveHour', windowMinutes: 300 },
                        weekly: { usedPercent: 12, resetAt: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: new Date().toISOString(), window: 'weekly', windowMinutes: 10_080 },
                    },
                ],
            },
            selectorResult: {
                fallbackReason: null,
                selectedAccountKey: 'acct-unreadable-key',
                selectedSlotIndex: 1,
                affinityApplied: false,
            },
        });
        transport.resetRotationState();

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const authorization = authHeader(init);
            if (authorization === 'Bearer token-first') {
                return successResponse('slot 0 handled the auth-load fallback');
            }
            throw new Error(`Unexpected Authorization header: ${authorization}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const response = await transport.makeCodexRequest(baseRequest, 'codex/gpt-5.4-mini', null);
        const body = await response.json() as Record<string, unknown>;
        const choices = body['choices'] as Array<Record<string, unknown>>;
        const message = choices[0]?.['message'] as Record<string, unknown>;

        expect(getCodexUsageSelectorSnapshot).toHaveBeenCalledTimes(1);
        expect(selectCodexBalanceCandidate).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(([, init]) => authHeader(init))).toEqual(['Bearer token-first']);
        expect(response.status).toBe(200);
        expect(message['content']).toBe('slot 0 handled the auth-load fallback');
    });
});