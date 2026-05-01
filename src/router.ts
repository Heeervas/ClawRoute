import {
    ChatCompletionRequest,
    ClassificationResult,
    ClawRouteConfig,
    ModelEntry,
    RoutingDecision,
    TaskTier,
} from './types.js';
import { hasApiKey } from './config.js';
import { calculateCost, calculateCostFromCatalog, getModelEntryStrict, getModelEntryStrictFromCatalog, getProviderForModel, getProviderForModelFromCatalog } from './models.js';
import { estimateMessagesTokens } from './utils.js';



/**
 * Make a routing decision based on classification.
 *
 * @param request - The original request
 * @param classification - The classification result
 * @param config - The ClawRoute configuration
 * @returns The routing decision
 */
export function routeRequest(
    request: ChatCompletionRequest,
    classification: ClassificationResult,
    config: ClawRouteConfig,
    modelCatalog?: ModelEntry[]
): RoutingDecision {
    const originalModel = request.model;
    const estimatedTokens = estimateMessagesTokens(request.messages);

    // Tier-aware output token estimates for cost reporting.
    // Caps mirror what executor.ts injects as max_tokens per tier.
    const ESTIMATED_OUTPUT_BY_TIER: Record<TaskTier, number> = {
        [TaskTier.HEARTBEAT]: 100,
        [TaskTier.SIMPLE]:    300,
        [TaskTier.MODERATE]: 1000,
        [TaskTier.COMPLEX]:         2500,
        [TaskTier.FRONTIER_SONNET]: 3000,
        [TaskTier.FRONTIER_OPUS]:   3000,
    };
    const estimatedOutputTokens = ESTIMATED_OUTPUT_BY_TIER[classification.tier] ?? 2000;

    // Default decision structure
    let routedModel = originalModel;
    let reason = 'passthrough';
    let isOverride = false;
    let isDryRun = config.dryRun;
    let isPassthrough = false;

    // 1. Check if ClawRoute is disabled
    if (!config.enabled) {
        return {
            originalModel,
            routedModel: originalModel,
            tier: classification.tier,
            reason: 'ClawRoute disabled',
            confidence: classification.confidence,
            isDryRun: false,
            isOverride: false,
            isPassthrough: true,
            estimatedSavingsUsd: 0,
            safeToRetry: classification.safeToRetry,
        };
    }

    // 2. Check global force override
    if (config.overrides.globalForceModel) {
        routedModel = config.overrides.globalForceModel;
        reason = `global override: ${routedModel}`;
        isOverride = true;
    }

    // 3. Check session override (would need session ID from request - skip for now)
    // Session overrides would be handled via headers or other mechanisms

    // 4. Normal routing based on tier (if no override)
    if (!isOverride) {
        // 3b. Client-specified model bypass (skip for clawroute/* models)
        if (!request.model.startsWith('clawroute/')) {
            const entry = modelCatalog
                ? getModelEntryStrictFromCatalog(request.model, modelCatalog)
                : getModelEntryStrict(request.model);
            if (entry && entry.enabled) {
                const provider = modelCatalog
                    ? getProviderForModelFromCatalog(request.model, modelCatalog)
                    : getProviderForModel(request.model);
                if (hasApiKey(config, provider)) {
                    routedModel = request.model;
                    reason = `client-specified: ${request.model}`;
                }
            }
        }

        // Normal tier routing (only if bypass didn't match)
        if (reason === 'passthrough') {
        const tier = classification.tier;
        const tierConfig = config.models[tier];

        // Normal tier routing (Any tier)
        if (tierConfig) {
            // Try primary model
            const primaryProvider = modelCatalog
                ? getProviderForModelFromCatalog(tierConfig.primary, modelCatalog)
                : getProviderForModel(tierConfig.primary);
            if (hasApiKey(config, primaryProvider)) {
                routedModel = tierConfig.primary;
                reason = `tier ${tier}: primary model`;
            } else {
                // Try fallback model
                const fallbackProvider = modelCatalog
                    ? getProviderForModelFromCatalog(tierConfig.fallback, modelCatalog)
                    : getProviderForModel(tierConfig.fallback);
                if (hasApiKey(config, fallbackProvider)) {
                    routedModel = tierConfig.fallback;
                    reason = `tier ${tier}: fallback model (primary unavailable)`;
                } else {
                    // No models available for this tier, passthrough
                    routedModel = originalModel;
                    reason = `tier ${tier}: no API keys for configured models, passthrough`;
                    isPassthrough = true;
                }
            }
        } else {
            // No tier config, passthrough
            routedModel = originalModel;
            reason = `tier ${tier}: no config, passthrough`;
            isPassthrough = true;
        }
        } // end tier routing guard
    }

    // 5. Dry-run mode: use original model but log what would have been used
    if (isDryRun) {
        const wouldHaveRouted = routedModel;
        routedModel = originalModel;
        reason = `dry-run: would route to ${wouldHaveRouted}`;
    }

    // 6. Calculate estimated savings
    const comparisonModel = config.baselineModel || originalModel;
    const originalCost = modelCatalog
        ? calculateCostFromCatalog(comparisonModel, estimatedTokens, estimatedOutputTokens, modelCatalog)
        : calculateCost(comparisonModel, estimatedTokens, estimatedOutputTokens);
    const routedCost = modelCatalog
        ? calculateCostFromCatalog(routedModel, estimatedTokens, estimatedOutputTokens, modelCatalog)
        : calculateCost(routedModel, estimatedTokens, estimatedOutputTokens);
    const estimatedSavingsUsd = Math.max(0, originalCost - routedCost);

    return {
        originalModel,
        routedModel,
        tier: classification.tier,
        reason,
        confidence: classification.confidence,
        isDryRun,
        isOverride,
        isPassthrough,
        estimatedSavingsUsd,
        safeToRetry: classification.safeToRetry,
    };
}

/**
 * Get the next tier model for escalation.
 *
 * @param currentTier - The current tier
 * @param config - The ClawRoute configuration
 * @returns The next tier's primary model, or null if at maximum
 */
export function getEscalatedModel(
    currentTier: TaskTier,
    config: ClawRouteConfig,
    modelCatalog?: ModelEntry[]
): { model: string; tier: TaskTier } | null {
    const tierOrder: TaskTier[] = [
        TaskTier.HEARTBEAT,
        TaskTier.SIMPLE,
        TaskTier.MODERATE,
        TaskTier.COMPLEX,
        TaskTier.FRONTIER_SONNET,
        TaskTier.FRONTIER_OPUS,
    ];

    const currentIndex = tierOrder.indexOf(currentTier);
    if (currentIndex === -1) {
        // Unknown tier
        return null;
    }

    // Try current tier's own fallback first (e.g. openrouter when Ollama fails)
    const currentTierConfig = config.models[currentTier];
    if (currentTierConfig) {
        const fallbackProvider = modelCatalog
            ? getProviderForModelFromCatalog(currentTierConfig.fallback, modelCatalog)
            : getProviderForModel(currentTierConfig.fallback);
        if (hasApiKey(config, fallbackProvider)) {
            return { model: currentTierConfig.fallback, tier: currentTier };
        }
    }

    if (currentIndex >= tierOrder.length - 1) {
        // Already at max tier and fallback was tried above
        return null;
    }

    // Try each higher tier until we find one with an available model
    for (let i = currentIndex + 1; i < tierOrder.length; i++) {
        const nextTier = tierOrder[i];
        if (!nextTier) continue;

        const tierConfig = config.models[nextTier];
        if (!tierConfig) continue;

        // Try primary
        const primaryProvider = modelCatalog
            ? getProviderForModelFromCatalog(tierConfig.primary, modelCatalog)
            : getProviderForModel(tierConfig.primary);
        if (hasApiKey(config, primaryProvider)) {
            return { model: tierConfig.primary, tier: nextTier };
        }

        // Try fallback
        const fallbackProvider = modelCatalog
            ? getProviderForModelFromCatalog(tierConfig.fallback, modelCatalog)
            : getProviderForModel(tierConfig.fallback);
        if (hasApiKey(config, fallbackProvider)) {
            return { model: tierConfig.fallback, tier: nextTier };
        }
    }

    return null;
}

/**
 * Check if a model can be used (has API key).
 *
 * @param modelId - The model ID
 * @param config - The ClawRoute configuration
 * @returns Whether the model can be used
 */
export function canUseModel(modelId: string, config: ClawRouteConfig): boolean {
    const provider = getProviderForModel(modelId);
    return hasApiKey(config, provider);
}

/**
 * Get all available models for routing.
 *
 * @param config - The ClawRoute configuration
 * @returns Array of available model IDs
 */
export function getAvailableModels(config: ClawRouteConfig): string[] {
    const models: string[] = [];

    for (const tier of Object.values(TaskTier)) {
        const tierConfig = config.models[tier];
        if (!tierConfig) continue;

        const primaryProvider = getProviderForModel(tierConfig.primary);
        if (hasApiKey(config, primaryProvider)) {
            if (!models.includes(tierConfig.primary)) {
                models.push(tierConfig.primary);
            }
        }

        const fallbackProvider = getProviderForModel(tierConfig.fallback);
        if (hasApiKey(config, fallbackProvider)) {
            if (!models.includes(tierConfig.fallback)) {
                models.push(tierConfig.fallback);
            }
        }
    }

    return models;
}

/**
 * Get the model map configuration for display.
 *
 * @param config - The ClawRoute configuration
 * @returns Map of tier to primary model
 */
export function getModelMap(config: ClawRouteConfig): Record<TaskTier, string> {
    const map: Record<TaskTier, string> = {
        [TaskTier.HEARTBEAT]: config.models[TaskTier.HEARTBEAT]?.primary ?? 'unknown',
        [TaskTier.SIMPLE]: config.models[TaskTier.SIMPLE]?.primary ?? 'unknown',
        [TaskTier.MODERATE]: config.models[TaskTier.MODERATE]?.primary ?? 'unknown',
        [TaskTier.COMPLEX]:         config.models[TaskTier.COMPLEX]?.primary         ?? 'unknown',
        [TaskTier.FRONTIER_SONNET]: config.models[TaskTier.FRONTIER_SONNET]?.primary ?? 'unknown',
        [TaskTier.FRONTIER_OPUS]:   config.models[TaskTier.FRONTIER_OPUS]?.primary   ?? 'unknown',
    };

    return map;
}
