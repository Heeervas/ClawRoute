import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

type CliResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};

type RequestCapture = {
    count: number;
    method?: string;
    url?: string;
    authorization?: string;
};

const unauthorizedPayload = {
    error: {
        message: 'Unauthorized. Provide Bearer token in Authorization header or token query param.',
        type: 'authentication_error',
        code: 'unauthorized',
    },
};

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', './src/cli.ts', ...args], {
            cwd: process.cwd(),
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function startServer(status: number, body: unknown) {
    const capture: RequestCapture = { count: 0 };
    const server = createServer((req, res) => {
        capture.count += 1;
        capture.method = req.method;
        capture.url = req.url ?? undefined;
        capture.authorization = typeof req.headers.authorization === 'string'
            ? req.headers.authorization
            : undefined;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return {
        capture,
        host: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}

describe('CLI admin contract', () => {
    it('sends Authorization Bearer token from CLAWROUTE_TOKEN for models discover', async () => {
        const server = await startServer(200, { candidates: [] });

        try {
            const result = await runCli(['models', 'discover', 'codex'], {
                CLAWROUTE_HOST: server.host,
                CLAWROUTE_TOKEN: 'admin-token',
            });

            expect(result.code).toBe(0);
            expect(server.capture.count).toBe(1);
            expect(server.capture.method).toBe('POST');
            expect(server.capture.url).toBe('/api/admin/models/discover');
            expect(server.capture.authorization).toBe('Bearer admin-token');
        } finally {
            await server.close();
        }
    });

    it('exits non-zero for models discover when CLAWROUTE_TOKEN is missing and the server returns 401', async () => {
        const server = await startServer(401, unauthorizedPayload);

        try {
            const result = await runCli(['models', 'discover', 'codex'], {
                CLAWROUTE_HOST: server.host,
                CLAWROUTE_TOKEN: '',
            });

            expect(result.code).toBe(1);
            expect(server.capture.count).toBe(1);
            expect(server.capture.url).toBe('/api/admin/models/discover');
            expect(server.capture.authorization).toBeUndefined();
            expect(result.stderr).toContain('authentication_error');
            expect(result.stderr).toContain(unauthorizedPayload.error.message);
        } finally {
            await server.close();
        }
    });

    it('prints the existing 401 auth payload and exits non-zero without retrying', async () => {
        const server = await startServer(401, unauthorizedPayload);

        try {
            const result = await runCli(['models', 'discover', 'codex'], {
                CLAWROUTE_HOST: server.host,
                CLAWROUTE_TOKEN: 'wrong-token',
            });

            expect(result.code).toBe(1);
            expect(server.capture.count).toBe(1);
            expect(server.capture.authorization).toBe('Bearer wrong-token');
            expect(result.stderr).toContain('authentication_error');
            expect(result.stderr).toContain(unauthorizedPayload.error.code);
        } finally {
            await server.close();
        }
    });
});