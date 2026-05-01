import { describe, expect, it } from 'vitest';
import { codexResponseToStream } from '../src/codex-transport.js';

function createSseStream(events: Array<{ event: string; data: Record<string, unknown> }>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const body = events
        .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        .join('');

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        },
    });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseSsePayloads(body: string): Array<Record<string, unknown>> {
    return body
        .split(/\n\n/)
        .filter((chunk) => chunk.startsWith('data: ') && chunk !== 'data: [DONE]')
        .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

describe('codexResponseToStream error handling', () => {
    it('forwards upstream object errors with real code and slot metadata only', async () => {
        const upstreamBody = createSseStream([
            {
                event: 'error',
                data: {
                    error: {
                        message: 'Session expired',
                        code: 'invalid_api_key',
                        type: 'auth_error',
                        token: 'SECRET',
                        internal: 'hidden',
                    },
                },
            },
        ]);

        const body = await readStream(codexResponseToStream(
            upstreamBody,
            'gpt-5.4',
            true,
            { slot: 2, path: '/home/mbpro/.codex/auth_piti.json' },
        ));
        const payloads = parseSsePayloads(body);
        const errorPayload = payloads.find((payload) => 'error' in payload) as { error: Record<string, unknown> } | undefined;

        expect(errorPayload?.error).toMatchObject({
            code: 'invalid_api_key',
            type: 'auth_error',
            slot: 2,
        });
        expect(errorPayload?.error.message).toBe('Session expired [slot:2 code:invalid_api_key]');
        expect(errorPayload?.error).not.toHaveProperty('path');
        expect(errorPayload?.error).not.toHaveProperty('slot_path');
        expect(errorPayload?.error).not.toHaveProperty('token');
        expect(errorPayload?.error).not.toHaveProperty('internal');
        expect(body).toContain('data: [DONE]');
    });

    it('keeps legacy string errors but enriches them with slot and code context', async () => {
        const upstreamBody = createSseStream([
            {
                event: 'error',
                data: {
                    message: 'Codex upstream error',
                },
            },
        ]);

        const body = await readStream(codexResponseToStream(
            upstreamBody,
            'gpt-5.4',
            true,
            { slot: 0, path: '/home/mbpro/.codex/auth.json' },
        ));
        const payloads = parseSsePayloads(body);
        const errorPayload = payloads.find((payload) => 'error' in payload) as { error: Record<string, unknown> } | undefined;

        expect(errorPayload?.error).toMatchObject({
            code: 'codex_error',
            type: 'upstream_error',
            slot: 0,
        });
        expect(errorPayload?.error.message).toBe('Codex upstream error [slot:0 code:codex_error]');
        expect(errorPayload?.error).not.toHaveProperty('path');
        expect(errorPayload?.error).not.toHaveProperty('slot_path');
    });

    it('returns an error JSON body for non-streaming error events instead of a fake empty completion', async () => {
        const upstreamBody = createSseStream([
            {
                event: 'error',
                data: {
                    error: {
                        message: 'Account unauthorized',
                        code: 'invalid_api_key',
                        type: 'auth_error',
                    },
                },
            },
        ]);

        const body = await readStream(codexResponseToStream(
            upstreamBody,
            'gpt-5.4',
            false,
            { slot: 1, path: '/home/mbpro/.codex/auth_ah18.json' },
        ));
        const parsed = JSON.parse(body) as { error?: Record<string, unknown>; choices?: unknown[] };

        expect(parsed.error).toMatchObject({
            message: 'Account unauthorized [slot:1 code:invalid_api_key]',
            code: 'invalid_api_key',
            type: 'auth_error',
            slot: 1,
        });
        expect(parsed.error).not.toHaveProperty('path');
        expect(parsed.error).not.toHaveProperty('slot_path');
        expect(parsed.choices).toBeUndefined();
    });
});
