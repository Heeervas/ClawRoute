/**
 * ClawRoute Model Registry
 *
 * Static registry of supported models with their costs and capabilities.
 * Users can override via config, but these are sensible defaults.
 */

import { ModelEntry, ProviderType } from './types.js';

/**
 * Default models with their costs and capabilities.
 * Costs are in USD per 1M tokens (as of February 2026).
 */
export const DEFAULT_MODELS: ModelEntry[] = [
    // Ultra-cheap tier (heartbeat/simple)
    {
        id: 'openrouter/stepfun/step-3.5-flash:free',
        provider: 'openrouter',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 32000,
        toolCapable: true,
        multimodal: false,
        enabled: true,
    },
    {
        id: 'openrouter/google/gemini-3.1-flash-lite-preview',
        provider: 'openrouter',
        inputCostPer1M: 0.25,
        outputCostPer1M: 1.50,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'google/gemini-2.5-flash-lite',
        provider: 'google',
        inputCostPer1M: 0.10,
        outputCostPer1M: 0.40,
        maxContext: 1000000,
        toolCapable: false,
        multimodal: false,
        enabled: true,
    },
    {
        id: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        inputCostPer1M: 0.28,
        outputCostPer1M: 1.12,
        maxContext: 64000,
        toolCapable: true,
        multimodal: false,
        enabled: true,
    },

    // Mid-tier (moderate)
    {
        id: 'google/gemini-2.5-flash',
        provider: 'google',
        inputCostPer1M: 0.30,
        outputCostPer1M: 2.50,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openai/gpt-5-mini',
        provider: 'openai',
        inputCostPer1M: 0.15,
        outputCostPer1M: 0.60,
        maxContext: 128000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openrouter/x-ai/grok-4.1-fast',
        provider: 'openrouter',
        inputCostPer1M: 0.20,
        outputCostPer1M: 0.50,
        maxContext: 128000,
        toolCapable: true,
        multimodal: false,
        enabled: true,
    },

    // High-tier (complex)
    {
        id: 'openrouter/google/gemini-3.1-pro-preview',
        provider: 'openrouter',
        inputCostPer1M: 2.00,
        outputCostPer1M: 12.00,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openrouter/anthropic/claude-sonnet-4.6',
        provider: 'openrouter',
        inputCostPer1M: 3.00,
        outputCostPer1M: 15.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        inputCostPer1M: 3.00,
        outputCostPer1M: 15.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'google/gemini-2.5-pro',
        provider: 'google',
        inputCostPer1M: 1.25,
        outputCostPer1M: 10.00,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openai/gpt-5.2',
        provider: 'openai',
        inputCostPer1M: 1.75,
        outputCostPer1M: 14.00,
        maxContext: 128000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },

    // Local / Ollama (explicit routing only — not in auto-tier table)
    {
        id: 'ollama/llama3.2:1b',
        provider: 'ollama',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 32768,
        toolCapable: false,
        multimodal: false,
        enabled: true,
    },

    // Frontier tier
    {
        id: 'openai/o3',
        provider: 'openai',
        inputCostPer1M: 2.00,
        outputCostPer1M: 8.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'anthropic/claude-opus-4-6',
        provider: 'anthropic',
        inputCostPer1M: 5.00,
        outputCostPer1M: 25.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openrouter/anthropic/claude-opus-4.6',
        provider: 'openrouter',
        inputCostPer1M: 5.00,
        outputCostPer1M: 25.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },

    // OpenRouter-prefixed variants (same model, cost tracked via OpenRouter)
    {
        id: 'openrouter/google/gemini-2.5-flash-lite',
        provider: 'openrouter',
        inputCostPer1M: 0.10,
        outputCostPer1M: 0.40,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openrouter/google/gemini-2.5-flash',
        provider: 'openrouter',
        inputCostPer1M: 0.30,
        outputCostPer1M: 2.50,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openrouter/google/gemini-2.5-pro',
        provider: 'openrouter',
        inputCostPer1M: 1.25,
        outputCostPer1M: 10.00,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },

    // Codex subscription models (billed via ChatGPT Plus/Pro subscription, not per-token).
    // Cost fields are $0 because subscription cost is flat; set non-zero only if you want
    // ClawRoute's savings tracking to compare against a baseline.
    {
        id: 'codex/gpt-5.4-mini',
        provider: 'codex',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'codex/gpt-5.4',
        provider: 'codex',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    // Keep gpt-4.1 variants registered in case the subscription also allows them
    {
        id: 'codex/gpt-4.1-mini',
        provider: 'codex',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'codex/gpt-4.1',
        provider: 'codex',
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
];

/**
 * Model registry mapping model IDs to their entries.
 */
const modelRegistry = new Map<string, ModelEntry>();

// Initialize the registry with default models
for (const model of DEFAULT_MODELS) {
    modelRegistry.set(model.id, model);
}

/**
 * Get a model entry by its ID.
 *
 * @param modelId - The model ID to look up
 * @returns The model entry or null if not found
 */
export function getModelEntry(modelId: string): ModelEntry | null {
    // First try exact match
    const exact = modelRegistry.get(modelId);
    if (exact) return exact;

    // Try without provider prefix
    for (const [id, entry] of modelRegistry) {
        if (id.endsWith(`/${modelId}`) || modelId.endsWith(`/${id.split('/')[1]}`)) {
            return entry;
        }
    }

    // Try fuzzy match on model name
    const normalizedId = modelId.toLowerCase();
    for (const [id, entry] of modelRegistry) {
        const normalizedEntryId = id.toLowerCase();
        if (normalizedEntryId.includes(normalizedId) || normalizedId.includes(normalizedEntryId)) {
            return entry;
        }
    }

    return null;
}

/**
 * Extract the provider from a model ID.
 *
 * @param modelId - The model ID (e.g., "anthropic/claude-sonnet-4-6")
 * @returns The provider type
 */
export function getProviderForModel(modelId: string): ProviderType {
    // Check if model ID has provider prefix
    if (modelId.includes('/')) {
        const prefix = modelId.split('/')[0]?.toLowerCase();
        if (prefix === 'anthropic' || prefix === 'openai' || prefix === 'codex' || prefix === 'google' || prefix === 'deepseek' || prefix === 'openrouter' || prefix === 'ollama' || prefix === 'x-ai' || prefix === 'stepfun') {
            return prefix as ProviderType;
        }
    }

    // Look up in registry
    const entry = getModelEntry(modelId);
    if (entry) return entry.provider;

    // Default heuristics based on model name
    const lowerModelId = modelId.toLowerCase();
    if (lowerModelId.includes('claude')) return 'anthropic';
    if (lowerModelId.includes('gpt') || lowerModelId.includes('o3') || lowerModelId.includes('o1')) return 'openai';
    if (lowerModelId.includes('gemini')) return 'google';
    if (lowerModelId.includes('deepseek')) return 'deepseek';

    // Default to OpenAI-compatible
    return 'openai';
}

/**
 * Calculate the cost for a request.
 *
 * @param modelId - The model ID
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost in USD
 */
export function calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): number {
    const entry = getModelEntry(modelId);

    if (!entry) {
        // Unknown model - use a conservative estimate (GPT-5.2 pricing)
        const defaultInputCost = 1.75;
        const defaultOutputCost = 14.00;
        return (inputTokens / 1_000_000) * defaultInputCost + (outputTokens / 1_000_000) * defaultOutputCost;
    }

    const inputCost = (inputTokens / 1_000_000) * entry.inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * entry.outputCostPer1M;

    return inputCost + outputCost;
}

/**
 * Get the API base URL for a provider.
 *
 * @param provider - The provider type
 * @returns The API base URL
 */
export function getApiBaseUrl(provider: ProviderType): string {
    switch (provider) {
        case 'anthropic':
            return 'https://api.anthropic.com/v1';
        case 'openai':
            return 'https://api.openai.com/v1';
        case 'codex':
            return 'https://chatgpt.com/backend-api/codex';
        case 'google':
            return 'https://generativelanguage.googleapis.com/v1beta/openai';
        case 'deepseek':
            return 'https://api.deepseek.com/v1';
        case 'x-ai':
            return 'https://api.x.ai/v1';
        case 'stepfun':
            return 'https://api.stepfun.com/v1';
        case 'openrouter':
            return 'https://openrouter.ai/api/v1';
        case 'ollama':
            return process.env.OLLAMA_ENDPOINT ?? 'http://ollama:11434';
        default:
            return 'https://api.openai.com/v1';
    }
}

/**
 * Get the authentication headers for a provider.
 *
 * @param provider - The provider type
 * @param apiKey - The API key
 * @returns Headers object
 */
export function getAuthHeader(
    provider: ProviderType,
    apiKey: string
): Record<string, string> {
    switch (provider) {
        case 'ollama':
            // Ollama runs locally — no API key required
            return {};
        case 'anthropic':
            return {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            };
        case 'x-ai':
        case 'stepfun':
        case 'openai':
        case 'codex':
        case 'deepseek':
        case 'openrouter':
        case 'google':
        default:
            return {
                'Authorization': `Bearer ${apiKey}`,
            };
    }
}

/**
 * Check if a model is tool-capable.
 *
 * @param modelId - The model ID
 * @returns Whether the model supports tool calling
 */
export function isToolCapable(modelId: string): boolean {
    const entry = getModelEntry(modelId);
    return entry?.toolCapable ?? true; // Assume capable if unknown
}

/**
 * Register a custom model.
 *
 * @param model - The model entry to register
 */
export function registerModel(model: ModelEntry): void {
    modelRegistry.set(model.id, model);
}

/**
 * Get all registered models.
 *
 * @returns Array of all model entries
 */
export function getAllModels(): ModelEntry[] {
    return Array.from(modelRegistry.values());
}

/**
 * Get only enabled models from the registry.
 */
export function getEnabledModels(): ModelEntry[] {
    return getAllModels().filter(m => m.enabled);
}

/**
 * Get a model entry by exact or prefix match only (no fuzzy).
 * Used by API endpoints where fuzzy matching could be misleading.
 */
export function getModelEntryStrict(modelId: string): ModelEntry | null {
    // Exact match
    const exact = modelRegistry.get(modelId);
    if (exact) return exact;

    // Try without provider prefix (e.g., "google/gemini-2.5-flash" matches "openrouter/google/gemini-2.5-flash")
    for (const [id, entry] of modelRegistry) {
        if (id.endsWith(`/${modelId}`) || modelId.endsWith(`/${id.split('/')[1]}`)) {
            return entry;
        }
    }

    return null;
}

/**
 * Apply maxContext overrides to the model registry.
 * Called once at startup from config loading.
 */
export function applyContextOverrides(overrides: Record<string, number>): void {
    for (const [modelId, maxContext] of Object.entries(overrides)) {
        const entry = modelRegistry.get(modelId);
        if (entry) {
            entry.maxContext = maxContext;
        } else {
            console.warn(`contextOverrides: unknown model "${modelId}", skipping`);
        }
    }
}
