/**
 * ClawRoute Executor Tests
 *
 * Tests for execution logic with mocked HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskTier, ClassificationResult, RoutingDecision, ClawRouteConfig } from '../src/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        proxyPort: 18790,
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
            retryDelayMs: 10, // Fast for tests
            onlyRetryBeforeStreaming: true,
            onlyRetryWithoutToolCalls: true,
            alwaysFallbackToOriginal: true,
        },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'google/gemini-2.5-flash-lite', fallback: 'deepseek/deepseek-chat' },
            [TaskTier.SIMPLE]: { primary: 'deepseek/deepseek-chat', fallback: 'google/gemini-2.5-flash' },
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-4o-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
            [TaskTier.FRONTIER]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
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
            google: 'test-key',
            deepseek: 'test-key',
            openrouter: '',
            ollama: '',
        },
        alerts: {},
    };
}

function createClassification(tier: TaskTier, safeToRetry: boolean = true): ClassificationResult {
    return {
        tier,
        confidence: 0.9,
        reason: 'test',
        signals: ['test'],
        toolsDetected: false,
        safeToRetry,
    };
}

function createRoutingDecision(
    originalModel: string,
    routedModel: string,
    tier: TaskTier,
    safeToRetry: boolean = true
): RoutingDecision {
    return {
        originalModel,
        routedModel,
        tier,
        reason: 'test routing',
        confidence: 0.9,
        isDryRun: false,
        isOverride: false,
        isPassthrough: false,
        estimatedSavingsUsd: 0.01,
        safeToRetry,
    };
}

function createSuccessResponse(content: string = 'Test response'): Response {
    return new Response(
        JSON.stringify({
            id: 'test-id',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-model',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}

function createErrorResponse(status: number, message: string): Response {
    return new Response(
        JSON.stringify({ error: { message, type: 'error', code: 'error' } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

function createToolCallResponse(): Response {
    return new Response(
        JSON.stringify({
            id: 'test-id',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-model',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'test_action', arguments: '{}' },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}

describe('Executor Logic', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Successful Routing', () => {
        it('should successfully route to cheap model', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());

            // Import executor after mocking
            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT
            );
            const classification = createClassification(TaskTier.HEARTBEAT);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            expect(result.actualModel).toBe('google/gemini-2.5-flash-lite');
            expect(result.escalated).toBe(false);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Codex Transport', () => {
        it('should keep codex/gpt-5.5 on the Codex transport path', async () => {
            vi.resetModules();
            const makeCodexRequest = vi.fn().mockResolvedValue(createSuccessResponse('Codex gpt-5.5 response'));
            vi.doMock('../src/codex-transport.js', () => ({ makeCodexRequest }));

            try {
                const { executeRequest } = await import('../src/executor.js');

                const request = {
                    model: 'codex/gpt-5.5',
                    messages: [{ role: 'user' as const, content: 'test codex path' }],
                    stream: false,
                };
                const routing = createRoutingDecision(
                    'codex/gpt-5.5',
                    'codex/gpt-5.5',
                    TaskTier.MODERATE,
                );
                const classification = createClassification(TaskTier.MODERATE);
                const config = createTestConfig();

                const result = await executeRequest(request, routing, classification, config);
                const codexCall = makeCodexRequest.mock.calls[0];

                expect(makeCodexRequest).toHaveBeenCalledTimes(1);
                expect(codexCall?.[0]).toMatchObject({ model: 'codex/gpt-5.5' });
                expect(codexCall?.[1]).toBe('codex/gpt-5.5');
                expect(mockFetch).not.toHaveBeenCalled();
                expect(result.actualModel).toBe('codex/gpt-5.5');
                expect(result.actualCostUsd).toBe(0);
            } finally {
                vi.doUnmock('../src/codex-transport.js');
                vi.resetModules();
            }
        });
    });

    describe('Escalation on Error', () => {
        it('should escalate on HTTP error when safe to retry', async () => {
            // First call fails, second succeeds
            mockFetch
                .mockResolvedValueOnce(createErrorResponse(500, 'Server error'))
                .mockResolvedValueOnce(createSuccessResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
                true // safeToRetry
            );
            const classification = createClassification(TaskTier.HEARTBEAT, true);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            expect(result.escalated).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('Tool Call Retry Blocking', () => {
        it('should NOT retry when response has tool calls', async () => {
            // This tests that tool calls block retry even if response seems bad
            mockFetch.mockResolvedValueOnce(createToolCallResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'do action' }],
                tools: [
                    {
                        type: 'function' as const,
                        function: { name: 'test_action', description: 'Test action' }
                    }
                ],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash',
                TaskTier.COMPLEX,
                false // NOT safeToRetry because tools
            );
            const classification = createClassification(TaskTier.COMPLEX, false);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            // Should not escalate because tool call was received
            expect(result.hadToolCalls).toBe(true);
            // Only one call made
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Fallback to Original', () => {
        it('should fallback to original when all escalations fail', async () => {
            // All calls fail except the last (original model)
            mockFetch
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 1'))
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 2'))
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 3'))
                .mockResolvedValueOnce(createSuccessResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
                true
            );
            const classification = createClassification(TaskTier.HEARTBEAT, true);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            // Should have fallen back to original model
            expect(result.escalated).toBe(true);
            expect(result.escalationChain.length).toBeGreaterThan(1);
        });
    });

    describe('Passthrough Mode', () => {
        it('should passthrough when ClawRoute errors', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());

            const { executePassthrough } = await import('../src/executor.js');

            const request = {
                model: 'openai/gpt-4o',
                messages: [{ role: 'user' as const, content: 'test' }],
            };
            const config = createTestConfig();

            const response = await executePassthrough(request, config);

            expect(response.ok).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Cost Optimizations', () => {
        it('should inject max_tokens=256 for HEARTBEAT tier', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());
            const { executeRequest } = await import('../src/executor.js');

            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
            );
            await executeRequest(
                { model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'ping' }], stream: false },
                routing,
                createClassification(TaskTier.HEARTBEAT),
                createTestConfig(),
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.max_tokens).toBe(256);
        });

        it('should inject max_tokens=800 for SIMPLE tier', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'deepseek/deepseek-chat',
                TaskTier.SIMPLE,
            );
            await executeRequest(
                { model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'hi' }], stream: false },
                routing,
                createClassification(TaskTier.SIMPLE),
                createTestConfig(),
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.max_tokens).toBe(800);
        });

        it('should inject max_tokens=4096 for MODERATE tier', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash',
                TaskTier.MODERATE,
            );
            await executeRequest(
                { model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'explain this' }], stream: false },
                routing,
                createClassification(TaskTier.MODERATE),
                createTestConfig(),
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.max_tokens).toBe(4096);
        });

        it('should NOT inject max_tokens for COMPLEX tier', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'anthropic/claude-sonnet-4-5',
                TaskTier.COMPLEX,
            );
            await executeRequest(
                { model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'complex task' }], stream: false },
                routing,
                createClassification(TaskTier.COMPLEX),
                createTestConfig(),
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.max_tokens).toBeUndefined();
        });

        it('should NOT override max_tokens already set by client', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());
            const { executeRequest } = await import('../src/executor.js');

            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
            );
            await executeRequest(
                { model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'ping' }], max_tokens: 50, stream: false },
                routing,
                createClassification(TaskTier.HEARTBEAT),
                createTestConfig(),
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.max_tokens).toBe(50);
        });

        it('should inject provider.sort=price for HEARTBEAT on OpenRouter', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());
            const { executeRequest } = await import('../src/executor.js');

            const config = createTestConfig();
            config.apiKeys.openrouter = 'or-test-key';

            const routing = createRoutingDecision(
                'openrouter/anthropic/claude-sonnet-4-5',
                'openrouter/google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
            );
            await executeRequest(
                { model: 'openrouter/anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'ping' }], stream: false },
                routing,
                createClassification(TaskTier.HEARTBEAT),
                config,
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.provider?.sort).toBe('price');
            expect(sentBody.provider?.allow_fallbacks).toBe(true);
        });

        it('should NOT inject provider.sort for MODERATE on OpenRouter', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const config = createTestConfig();
            config.apiKeys.openrouter = 'or-test-key';

            const routing = createRoutingDecision(
                'openrouter/anthropic/claude-sonnet-4-5',
                'openrouter/google/gemini-2.5-flash',
                TaskTier.MODERATE,
            );
            await executeRequest(
                { model: 'openrouter/anthropic/claude-sonnet-4-5', messages: [{ role: 'user' as const, content: 'explain this text' }], stream: false },
                routing,
                createClassification(TaskTier.MODERATE),
                config,
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.provider).toBeUndefined();
        });

        it('should inject cache_control for Claude via OpenRouter on multi-turn with large context', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const config = createTestConfig();
            config.apiKeys.openrouter = 'or-test-key';

            const longContent = 'a'.repeat(9000); // ~2250 tokens, > 2048 min for claude-sonnet-4-6
            const routing = createRoutingDecision(
                'openrouter/anthropic/claude-sonnet-4-5',
                'openrouter/anthropic/claude-sonnet-4.6',
                TaskTier.COMPLEX,
            );
            await executeRequest(
                {
                    model: 'openrouter/anthropic/claude-sonnet-4-5',
                    messages: [
                        { role: 'system' as const, content: longContent },
                        { role: 'user' as const, content: 'first question' },
                        { role: 'assistant' as const, content: 'first answer' },
                        { role: 'user' as const, content: 'second question' },
                    ],
                    stream: false,
                },
                routing,
                createClassification(TaskTier.COMPLEX),
                config,
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
        });

        it('should NOT inject cache_control for Claude single-turn short context', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const config = createTestConfig();
            config.apiKeys.openrouter = 'or-test-key';

            const routing = createRoutingDecision(
                'openrouter/anthropic/claude-sonnet-4-5',
                'openrouter/anthropic/claude-sonnet-4.6',
                TaskTier.COMPLEX,
            );
            await executeRequest(
                {
                    model: 'openrouter/anthropic/claude-sonnet-4-5',
                    messages: [{ role: 'user' as const, content: 'hello' }],
                    stream: false,
                },
                routing,
                createClassification(TaskTier.COMPLEX),
                config,
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.cache_control).toBeUndefined();
        });

        it('should NOT inject cache_control for non-Claude OpenRouter model', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse('This is a sufficient length response.'));
            const { executeRequest } = await import('../src/executor.js');

            const config = createTestConfig();
            config.apiKeys.openrouter = 'or-test-key';

            const longContent = 'a'.repeat(9000);
            const routing = createRoutingDecision(
                'openrouter/google/gemini-2.5-flash',
                'openrouter/google/gemini-2.5-flash',
                TaskTier.MODERATE,
            );
            await executeRequest(
                {
                    model: 'openrouter/google/gemini-2.5-flash',
                    messages: [
                        { role: 'system' as const, content: longContent },
                        { role: 'user' as const, content: 'q1' },
                        { role: 'assistant' as const, content: 'a1' },
                        { role: 'user' as const, content: 'q2' },
                    ],
                    stream: false,
                },
                routing,
                createClassification(TaskTier.MODERATE),
                config,
            );

            const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
            expect(sentBody.cache_control).toBeUndefined();
        });
    });
});
