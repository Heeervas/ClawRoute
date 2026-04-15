/**
 * ClawRoute Responses API Adapter Tests
 *
 * Tests for the /v1/responses endpoint and its translation functions:
 * - responsesInputToChatMessages()
 * - responsesBodyToChatCompletions()
 * - chatCompletionToResponsesBody()
 *
 * RED state: These tests should FAIL until responses-adapter.ts is implemented.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskTier, ClawRouteConfig } from '../src/types.js';
import {
    responsesInputToChatMessages,
    responsesBodyToChatCompletions,
    chatCompletionToResponsesBody,
} from '../src/responses-adapter.js';

// ─── Unit Tests: responsesInputToChatMessages ───────────────────────

describe('responsesInputToChatMessages', () => {
    it('should convert developer message to system message', () => {
        const input = [{ role: 'developer', content: 'system prompt' }];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([{ role: 'system', content: 'system prompt' }]);
    });

    it('should pass through user text message', () => {
        const input = [{ role: 'user', content: 'hello' }];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('should convert user multimodal content to CC format', () => {
        const input = [
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'look' },
                    { type: 'input_image', image_url: 'https://example.com/img.png' },
                ],
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
                ],
            },
        ]);
    });

    it('should convert assistant message with output_text', () => {
        const input = [
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hi' }],
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([{ role: 'assistant', content: 'hi' }]);
    });

    it('should convert function_call to assistant message with tool_calls', () => {
        const input = [
            {
                type: 'function_call',
                call_id: 'c1',
                name: 'search',
                arguments: '{}',
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'search', arguments: '{}' },
                    },
                ],
            },
        ]);
    });

    it('should merge adjacent function_call items into single assistant message', () => {
        const input = [
            {
                type: 'function_call',
                call_id: 'c1',
                name: 'search',
                arguments: '{"q":"lobster"}',
            },
            {
                type: 'function_call',
                call_id: 'c2',
                name: 'read_page',
                arguments: '{"url":"https://example.com"}',
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'search', arguments: '{"q":"lobster"}' },
                },
                {
                    id: 'c2',
                    type: 'function',
                    function: { name: 'read_page', arguments: '{"url":"https://example.com"}' },
                },
            ],
        });
    });

    it('should convert function_call_output to tool message', () => {
        const input = [
            {
                type: 'function_call_output',
                call_id: 'c1',
                output: 'result text',
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([
            { role: 'tool', tool_call_id: 'c1', content: 'result text' },
        ]);
    });

    it('should handle full conversation round-trip', () => {
        const input = [
            { role: 'developer', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Search for lobsters' },
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'I will search for that.' }],
            },
            {
                type: 'function_call',
                call_id: 'fc1',
                name: 'web_search',
                arguments: '{"query":"lobsters"}',
            },
            {
                type: 'function_call_output',
                call_id: 'fc1',
                output: 'Found 10 results about lobsters.',
            },
        ];
        const result = responsesInputToChatMessages(input);

        expect(result).toEqual([
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Search for lobsters' },
            { role: 'assistant', content: 'I will search for that.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'fc1',
                        type: 'function',
                        function: { name: 'web_search', arguments: '{"query":"lobsters"}' },
                    },
                ],
            },
            { role: 'tool', tool_call_id: 'fc1', content: 'Found 10 results about lobsters.' },
        ]);
    });
});

// ─── Unit Tests: responsesBodyToChatCompletions ─────────────────────

describe('responsesBodyToChatCompletions', () => {
    it('should translate basic Responses API body to CC request', () => {
        const body = {
            model: 'anthropic/claude-sonnet-4-6',
            input: [{ role: 'user', content: 'hello' }],
            temperature: 0.7,
        };
        const result = responsesBodyToChatCompletions(body);

        expect(result.model).toBe('anthropic/claude-sonnet-4-6');
        expect(result.messages).toEqual([{ role: 'user', content: 'hello' }]);
        expect(result.temperature).toBe(0.7);
    });

    it('should translate tools from flat Responses format to nested CC format', () => {
        const body = {
            model: 'anthropic/claude-sonnet-4-6',
            input: [{ role: 'user', content: 'search' }],
            tools: [
                {
                    type: 'function',
                    name: 'web_search',
                    description: 'Search the web',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                    },
                    strict: true,
                },
            ],
        };
        const result = responsesBodyToChatCompletions(body);

        expect(result.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'web_search',
                    description: 'Search the web',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                    },
                    strict: true,
                },
            },
        ]);
    });

    it('should use defaults for missing optional fields', () => {
        const body = {
            model: 'google/gemini-2.5-flash',
            input: [{ role: 'user', content: 'hi' }],
        };
        const result = responsesBodyToChatCompletions(body);

        expect(result.model).toBe('google/gemini-2.5-flash');
        expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(result.tools).toBeUndefined();
        expect(result.temperature).toBeUndefined();
    });
});

// ─── Unit Tests: chatCompletionToResponsesBody ──────────────────────

describe('chatCompletionToResponsesBody', () => {
    it('should convert text response to Responses API format', () => {
        const ccResponse = {
            id: 'chatcmpl-123',
            model: 'anthropic/claude-sonnet-4-6',
            choices: [
                {
                    message: { role: 'assistant', content: 'Hello there!' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        const result = chatCompletionToResponsesBody(ccResponse);

        expect(result.id).toBe('chatcmpl-123');
        expect(result.object).toBe('response');
        expect(result.model).toBe('anthropic/claude-sonnet-4-6');
        expect(result.status).toBe('completed');
        expect(result.output).toEqual([
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello there!' }],
            },
        ]);
    });

    it('should convert tool call response to function_call items', () => {
        const ccResponse = {
            id: 'chatcmpl-456',
            model: 'anthropic/claude-sonnet-4-6',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'tc1',
                                type: 'function',
                                function: { name: 'search', arguments: '{"q":"test"}' },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        };
        const result = chatCompletionToResponsesBody(ccResponse);

        expect(result.output).toEqual([
            {
                type: 'function_call',
                call_id: 'tc1',
                name: 'search',
                arguments: '{"q":"test"}',
            },
        ]);
    });

    it('should map usage fields correctly', () => {
        const ccResponse = {
            id: 'chatcmpl-789',
            model: 'google/gemini-2.5-flash',
            choices: [
                {
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
        const result = chatCompletionToResponsesBody(ccResponse);

        expect(result.usage).toEqual({
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
        });
    });
});

// ─── Integration Tests: POST /v1/responses ──────────────────────────

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
            openrouter: 'test-key',
            ollama: 'test-key',
            'x-ai': 'test-key',
            stepfun: 'test-key',
        },
        alerts: {},
    } as ClawRouteConfig;
}

describe('POST /v1/responses', () => {
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

    it('should return 200 with valid Responses API body', async () => {
        // Mock the provider returning a CC response
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: 'chatcmpl-test',
                    model: 'deepseek/deepseek-chat',
                    choices: [
                        {
                            message: { role: 'assistant', content: 'Hello!' },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const res = await app.request('/v1/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'clawroute/auto',
                input: [{ role: 'user', content: 'hi' }],
            }),
        });

        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.object).toBe('response');
        expect(body.status).toBe('completed');
        expect(body.output).toBeDefined();
        expect(Array.isArray(body.output)).toBe(true);
    });

    it('should return 400 for missing model', async () => {
        const res = await app.request('/v1/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(400);

        const body = await res.json();
        expect(body.error).toBeDefined();
        expect(body.error.type).toBe('invalid_request_error');
    });

    it('should return 400 for missing input', async () => {
        const res = await app.request('/v1/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'clawroute/auto' }),
        });

        expect(res.status).toBe(400);

        const body = await res.json();
        expect(body.error).toBeDefined();
        expect(body.error.type).toBe('invalid_request_error');
    });
});
