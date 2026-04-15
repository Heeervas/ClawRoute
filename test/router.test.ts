/**
 * ClawRoute Router Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { routeRequest, getEscalatedModel, canUseModel, getModelMap } from '../src/router.js';
import { TaskTier, ClassificationResult, ChatCompletionRequest, ClawRouteConfig } from '../src/types.js';

function createTestConfig(overrides: Partial<ClawRouteConfig> = {}): ClawRouteConfig {
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
            retryDelayMs: 100,
            onlyRetryBeforeStreaming: true,
            onlyRetryWithoutToolCalls: true,
            alwaysFallbackToOriginal: true,
        },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'google/gemini-2.5-flash-lite', fallback: 'deepseek/deepseek-chat' },
            [TaskTier.SIMPLE]: { primary: 'deepseek/deepseek-chat', fallback: 'google/gemini-2.5-flash' },
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-4o-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
            [TaskTier.FRONTIER_SONNET]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
            [TaskTier.FRONTIER_OPUS]:   { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
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
        ...overrides,
    };
}

function createClassification(
    tier: TaskTier,
    confidence: number = 0.9,
    safeToRetry: boolean = true
): ClassificationResult {
    return {
        tier,
        confidence,
        reason: 'test classification',
        signals: ['test'],
        toolsDetected: false,
        safeToRetry,
    };
}

function createRequest(model: string): ChatCompletionRequest {
    return {
        model,
        messages: [{ role: 'user', content: 'test' }],
    };
}

describe('Router', () => {
    describe('Model Selection', () => {
        it('should route heartbeat tier to heartbeat model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('google/gemini-2.5-flash-lite');
            expect(decision.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should route simple tier to simple model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.SIMPLE);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('deepseek/deepseek-chat');
        });

        it('should route moderate tier to moderate model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.MODERATE);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('google/gemini-2.5-flash');
        });

        it('should route complex tier to complex model', () => {
            const config = createTestConfig();
            const request = createRequest('openai/gpt-4o');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
        });
    });

    describe('Fallback Behavior', () => {
        it('should use fallback when primary model API key is missing', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: 'test-key',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                    ollama: '',
                },
            });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            // Should fall back to openai/gpt-4o since anthropic key is missing
            expect(decision.routedModel).toBe('openai/gpt-4o');
        });

        it('should passthrough when no models available', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: '',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                    ollama: '',
                },
            });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isPassthrough).toBe(true);
        });
    });

    describe('Override Behavior', () => {
        it('should use global override when set', () => {
            const config = createTestConfig();
            config.overrides.globalForceModel = 'openai/gpt-4o';

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('openai/gpt-4o');
            expect(decision.isOverride).toBe(true);
        });
    });

    describe('Dry-Run Mode', () => {
        it('should return original model in dry-run mode', () => {
            const config = createTestConfig({ dryRun: true });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isDryRun).toBe(true);
            expect(decision.reason).toContain('dry-run');
        });
    });

    describe('Disabled State', () => {
        it('should passthrough when disabled', () => {
            const config = createTestConfig({ enabled: false });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isPassthrough).toBe(true);
        });
    });

    describe('Savings Calculation', () => {
        it('should calculate positive savings when routing to cheaper model', () => {
            const config = createTestConfig();

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.estimatedSavingsUsd).toBeGreaterThan(0);
        });

        it('should have zero savings when using original model', () => {
            const config = createTestConfig({ dryRun: true });

            const request = createRequest('google/gemini-2.5-flash-lite');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // In dry-run, uses original model
            expect(decision.estimatedSavingsUsd).toBe(0);
        });
    });

    describe('Escalation', () => {
        it('should try current tier fallback first', () => {
            const config = createTestConfig();

            const result = getEscalatedModel(TaskTier.SIMPLE, config);

            expect(result).not.toBeNull();
            // Should return SIMPLE tier's own fallback before walking up
            expect(result?.tier).toBe(TaskTier.SIMPLE);
            expect(result?.model).toBe('google/gemini-2.5-flash');
        });

        it('should return fallback at max tier', () => {
            const config = createTestConfig();

            const result = getEscalatedModel(TaskTier.FRONTIER_OPUS, config);

            // Now tries the tier's own fallback instead of returning null
            expect(result).not.toBeNull();
            expect(result?.tier).toBe(TaskTier.FRONTIER_OPUS);
            expect(result?.model).toBe('openai/gpt-4o');
        });

        it('should return null at max tier with no fallback key', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: '',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                    ollama: '',
                },
            });

            const result = getEscalatedModel(TaskTier.FRONTIER_OPUS, config);

            expect(result).toBeNull();
        });
    });

    describe('Model Availability', () => {
        it('should return true for available models', () => {
            const config = createTestConfig();

            expect(canUseModel('openai/gpt-4o', config)).toBe(true);
        });

        it('should return false for unavailable models', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: '',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                    ollama: '',
                },
            });

            expect(canUseModel('openai/gpt-4o', config)).toBe(false);
        });
    });

    describe('Model Map', () => {
        it('should return correct model map', () => {
            const config = createTestConfig();

            const map = getModelMap(config);

            expect(map[TaskTier.HEARTBEAT]).toBe('google/gemini-2.5-flash-lite');
            expect(map[TaskTier.COMPLEX]).toBe('anthropic/claude-sonnet-4-5');
        });
    });

    describe('Tier-Aware Output Estimation', () => {
        it('should produce higher estimated savings for complex tier than heartbeat (same routed model)', () => {
            // Both tiers route to the same cheap model (deepseek), but the output token
            // estimate differs: heartbeat=100, complex=2500. Since output tokens are much
            // more expensive than input, complex should show ~25x more estimated savings.
            const config = createTestConfig({
                models: {
                    [TaskTier.HEARTBEAT]: { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.SIMPLE]:    { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.MODERATE]:  { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.COMPLEX]:   { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.FRONTIER_SONNET]: { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.FRONTIER_OPUS]:   { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                },
            });

            // Use an expensive original model so savings vs deepseek are meaningful
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const heartbeat = routeRequest(request, createClassification(TaskTier.HEARTBEAT), config);
            const complex  = routeRequest(request, createClassification(TaskTier.COMPLEX),   config);

            // Both should save money (routing to cheap deepseek)
            expect(heartbeat.estimatedSavingsUsd).toBeGreaterThan(0);
            expect(complex.estimatedSavingsUsd).toBeGreaterThan(0);

            // Complex estimate uses 2500 output tokens vs heartbeat's 100 — savings should be
            // substantially higher (at least 5x, actually ~25x given $13.88 output diff/M)
            expect(complex.estimatedSavingsUsd).toBeGreaterThan(heartbeat.estimatedSavingsUsd * 5);
        });

        it('should not use flat 4000 output estimate for cheap tiers', () => {
            // With a SHORT message, old code gave estimatedOutput = Math.min(~5, 4000) = ~5 for all tiers.
            // New code gives 100 for heartbeat and 1000 for moderate.
            // Input tokens are tiny (~5) so output dominates the savings calculation →
            // moderate savings should be substantially larger than heartbeat savings.
            const config = createTestConfig({
                models: {
                    [TaskTier.HEARTBEAT]: { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.SIMPLE]:    { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.MODERATE]:  { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.COMPLEX]:   { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.FRONTIER_SONNET]: { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                    [TaskTier.FRONTIER_OPUS]:   { primary: 'deepseek/deepseek-chat', fallback: 'deepseek/deepseek-chat' },
                },
            });

            // Very SHORT message — input tokens are negligible, output estimate dominates
            const shortRequest = createRequest('anthropic/claude-sonnet-4-5');

            const heartbeatShort  = routeRequest(shortRequest, createClassification(TaskTier.HEARTBEAT),  config);
            const moderateShort   = routeRequest(shortRequest, createClassification(TaskTier.MODERATE),   config);

            // Moderate output estimate (1000) is 10x heartbeat (100) →
            // savings should be substantially higher for moderate
            expect(moderateShort.estimatedSavingsUsd).toBeGreaterThan(heartbeatShort.estimatedSavingsUsd * 5);
        });
    });

    describe('Client-Specified Model Bypass', () => {
        it('should bypass tier routing when client specifies a known model with API key', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // Should route to the client-specified model, NOT the heartbeat tier model
            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-6');
            expect(decision.reason).toContain('client-specified');
        });

        it('should use tier routing when model is clawroute/auto', () => {
            const config = createTestConfig();
            const request = createRequest('clawroute/auto');
            const classification = createClassification(TaskTier.SIMPLE);

            const decision = routeRequest(request, classification, config);

            // clawroute/auto should trigger normal tier routing
            expect(decision.routedModel).toBe('deepseek/deepseek-chat');
            expect(decision.reason).not.toContain('client-specified');
        });

        it('should fall through to tier routing for unknown models', () => {
            const config = createTestConfig();
            const request = createRequest('some-random-model/foo');
            const classification = createClassification(TaskTier.SIMPLE);

            const decision = routeRequest(request, classification, config);

            // Unknown model not in registry → tier routing picks the tier model
            expect(decision.routedModel).toBe('deepseek/deepseek-chat');
            expect(decision.reason).not.toContain('client-specified');
        });

        it('should let global override take precedence over client-specified model', () => {
            const config = createTestConfig();
            config.overrides.globalForceModel = 'openai/gpt-4o';

            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // Global override wins over client-specified model
            expect(decision.routedModel).toBe('openai/gpt-4o');
            expect(decision.isOverride).toBe(true);
        });

        it('should respect dry-run with client-specified model', () => {
            const config = createTestConfig({ dryRun: true });
            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // Dry-run: use original model, but reason indicates what would have been used
            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-6');
            expect(decision.isDryRun).toBe(true);
            expect(decision.reason).toContain('dry-run');
            expect(decision.reason).toContain('anthropic/claude-sonnet-4-6');
        });

        it('should fall through to tier routing when client-specified model has no API key', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',       // No key for the client-specified model
                    openai: 'test-key',
                    google: 'test-key',
                    deepseek: 'test-key',
                    openrouter: '',
                    ollama: '',
                },
            });

            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.SIMPLE);

            const decision = routeRequest(request, classification, config);

            // No API key for anthropic → fall through to tier routing
            // SIMPLE tier primary is deepseek (has key)
            expect(decision.routedModel).toBe('deepseek/deepseek-chat');
        });

        it('should calculate savings correctly with bypass', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // When bypassing, savings compare client-specified model vs baseline
            expect(decision.estimatedSavingsUsd).toBeDefined();
            expect(typeof decision.estimatedSavingsUsd).toBe('number');
        });

        it('should indicate client-specified in the reason field', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-6');
            const classification = createClassification(TaskTier.MODERATE);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-6');
            expect(decision.reason).toContain('client-specified');
        });
    });
});
