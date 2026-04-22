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
});