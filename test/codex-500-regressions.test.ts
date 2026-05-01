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
});