/**
 * ClawRoute Configuration
 *
 * Handles loading and validating configuration from:
 * 1. config/default.json (bundled defaults)
 * 2. config/clawroute.json (user customizations, if exists)
 * 3. Environment variables (highest priority)
 *
 * API keys are ONLY loaded from environment variables.
 */

import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
    ClawRouteConfig,
    ModelEntry,
    RoutingSnapshot,
    TaskTier,
    TierModelConfig,
    ProviderType,
    AlertsConfig,
} from './types.js';
import { DEFAULT_MODELS, applyContextOverrides, cloneModelCatalog, getModelEntry, registerModel, resetModelRegistry } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the project root directory.
 */
export function getProjectRoot(): string {
    // Go up from src/ or dist/ to project root
    return join(__dirname, '..');
}

type PersistedModelRegistry = {
    models?: Record<string, Partial<ModelEntry>>;
};

/**
 * Load JSON config file safely.
 *
 * @param path - Path to the config file
 * @returns Parsed JSON or null if not found
 */
function loadJsonConfig(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) {
        return null;
    }

    const content = readFileSync(path, 'utf-8');
    try {
        return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse config from ${path}: ${message}`);
    }
}

function cloneTierModels(
    models: Record<TaskTier, TierModelConfig>
): Record<TaskTier, TierModelConfig> {
    return {
        [TaskTier.HEARTBEAT]: { ...models[TaskTier.HEARTBEAT] },
        [TaskTier.SIMPLE]: { ...models[TaskTier.SIMPLE] },
        [TaskTier.MODERATE]: { ...models[TaskTier.MODERATE] },
        [TaskTier.COMPLEX]: { ...models[TaskTier.COMPLEX] },
        [TaskTier.FRONTIER_SONNET]: { ...models[TaskTier.FRONTIER_SONNET] },
        [TaskTier.FRONTIER_OPUS]: { ...models[TaskTier.FRONTIER_OPUS] },
    };
}

function getResolvedProfile(
    defaultJson: Record<string, unknown> | null,
    userJson: Record<string, unknown> | null,
    env: NodeJS.ProcessEnv
): string | null {
    const envProfile = env['CLAWROUTE_PROVIDER'];
    if (envProfile) return envProfile;

    const userProfile = userJson?.['providerProfile'];
    if (typeof userProfile === 'string' && userProfile.length > 0) {
        return userProfile;
    }

    const defaultProfile = defaultJson?.['providerProfile'];
    if (typeof defaultProfile === 'string' && defaultProfile.length > 0) {
        return defaultProfile;
    }

    return null;
}

function loadProfileJson(
    projectRoot: string,
    profile: string | null
): Record<string, unknown> | null {
    if (!profile) return null;
    const profilePath = join(projectRoot, 'config', 'providers', `${profile}.json`);
    const profileJson = loadJsonConfig(profilePath);
    if (!profileJson) {
        console.warn(`⚠️  Provider profile "${profile}" not found at ${profilePath}. Ignoring.`);
    }
    return profileJson;
}

function getUserConfigPath(projectRoot: string): string {
    return join(projectRoot, 'config', 'clawroute.json');
}

function getModelRegistryPath(projectRoot: string): string {
    return join(projectRoot, 'config', 'model-registry.json');
}

function loadPersistedModelRegistry(projectRoot: string): PersistedModelRegistry {
    const registry = loadJsonConfig(getModelRegistryPath(projectRoot));
    return (registry as PersistedModelRegistry | null) ?? {};
}

function writeJsonFile(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, path);
}

function restoreFile(path: string, previous: string | null, fallback: unknown): void {
    if (previous === null) {
        writeJsonFile(path, fallback);
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, previous);
}

function isValidMaxContext(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidCost(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCompleteModelEntry(model: Partial<ModelEntry>): model is ModelEntry {
    return typeof model.id === 'string'
        && typeof model.provider === 'string'
        && isValidMaxContext(model.maxContext)
        && typeof model.toolCapable === 'boolean'
        && typeof model.multimodal === 'boolean'
        && typeof model.enabled === 'boolean'
        && isValidCost(model.inputCostPer1M)
        && isValidCost(model.outputCostPer1M);
}

function applyPersistedModelRegistry(projectRoot: string): void {
    const persisted = loadPersistedModelRegistry(projectRoot).models ?? {};
    for (const [id, override] of Object.entries(persisted)) {
        const existing = getModelEntry(id);
        if (existing) {
            const merged = { ...existing, ...override, id, provider: override.provider ?? existing.provider };
            if (!isCompleteModelEntry(merged)) {
                throw new Error(`model-registry entry for ${id} is invalid`);
            }
            registerModel(merged);
            continue;
        }

        const candidate = { ...override, id };
        if (isCompleteModelEntry(candidate)) {
            registerModel(candidate);
            continue;
        }

        throw new Error(`model-registry entry for ${id} is incomplete`);
    }
}

function hasEnabledModel(modelId: string): boolean {
    const entry = getModelEntry(modelId);
    return entry !== null && entry.enabled;
}

function loadWritableJson(path: string): Record<string, unknown> {
    return loadJsonConfig(path) ?? {};
}

export function persistModelRegistryEntry(projectRoot: string, model: ModelEntry): () => void {
    const registryPath = getModelRegistryPath(projectRoot);
    const previous = existsSync(registryPath) ? readFileSync(registryPath, 'utf-8') : null;
    const current = loadPersistedModelRegistry(projectRoot);
    const models = { ...(current.models ?? {}) };
    models[model.id] = { ...model };
    writeJsonFile(registryPath, { models });
    return () => restoreFile(registryPath, previous, { models: {} });
}

export function persistModelRemoval(projectRoot: string, modelId: string): () => void {
    const registryPath = getModelRegistryPath(projectRoot);
    const previous = existsSync(registryPath) ? readFileSync(registryPath, 'utf-8') : null;
    const current = loadPersistedModelRegistry(projectRoot);
    const models = { ...(current.models ?? {}) };
    const isBundled = DEFAULT_MODELS.some((model) => model.id === modelId);

    if (isBundled) {
        models[modelId] = { ...(models[modelId] ?? {}), enabled: false };
    } else {
        delete models[modelId];
    }

    writeJsonFile(registryPath, { models });
    return () => restoreFile(registryPath, previous, { models: {} });
}

export function persistTierSelection(
    projectRoot: string,
    tier: TaskTier,
    tierConfig: TierModelConfig
): () => void {
    const userConfigPath = getUserConfigPath(projectRoot);
    const previous = existsSync(userConfigPath) ? readFileSync(userConfigPath, 'utf-8') : null;
    const current = loadWritableJson(userConfigPath);
    const models = {
        ...((current['models'] as Record<string, unknown> | undefined) ?? {}),
        [tier]: tierConfig,
    };
    writeJsonFile(userConfigPath, { ...current, models });
    return () => restoreFile(userConfigPath, previous, {});
}

function validateRoutingSnapshot(snapshot: RoutingSnapshot): void {
    for (const tier of Object.values(TaskTier)) {
        const tierConfig = snapshot.models[tier];
        if (!tierConfig?.primary || !tierConfig?.fallback) {
            throw new Error(`Missing routing model configuration for tier: ${tier}`);
        }
        if (!hasEnabledModel(tierConfig.primary)) {
            throw new Error(`Unknown or disabled primary model for tier ${tier}: ${tierConfig.primary}`);
        }
        if (!hasEnabledModel(tierConfig.fallback)) {
            throw new Error(`Unknown or disabled fallback model for tier ${tier}: ${tierConfig.fallback}`);
        }
    }

    if (!hasEnabledModel(snapshot.baselineModel)) {
        throw new Error(`Unknown or disabled baseline model: ${snapshot.baselineModel}`);
    }
}

export function buildRoutingSnapshot(
    projectRoot: string,
    env: NodeJS.ProcessEnv = process.env
): RoutingSnapshot {
    const defaultConfigPath = join(projectRoot, 'config', 'default.json');
    const userConfigPath = join(projectRoot, 'config', 'clawroute.json');
    const defaultJson = loadJsonConfig(defaultConfigPath);
    const userJson = loadJsonConfig(userConfigPath);
    const resolvedProfile = getResolvedProfile(defaultJson, userJson, env);
    const profileJson = loadProfileJson(projectRoot, resolvedProfile);

    let snapshot: RoutingSnapshot = {
        providerProfile: DEFAULT_CONFIG.providerProfile,
        baselineModel: DEFAULT_CONFIG.baselineModel,
        models: cloneTierModels(DEFAULT_TIER_MODELS),
        contextOverrides: undefined,
        modelCatalog: [],
    };

    if (defaultJson) {
        snapshot = deepMerge(snapshot, defaultJson as Partial<RoutingSnapshot>);
    }
    if (profileJson) {
        snapshot = deepMerge(snapshot, profileJson as Partial<RoutingSnapshot>);
    }
    if (userJson) {
        snapshot = deepMerge(snapshot, userJson as Partial<RoutingSnapshot>);
    }

    snapshot.providerProfile = resolvedProfile;
    if (env['CLAWROUTE_BASELINE_MODEL']) {
        snapshot.baselineModel = env['CLAWROUTE_BASELINE_MODEL'];
    }

    resetModelRegistry();
    applyPersistedModelRegistry(projectRoot);
    if (snapshot.contextOverrides && Object.keys(snapshot.contextOverrides).length > 0) {
        applyContextOverrides(snapshot.contextOverrides);
    }
    snapshot.modelCatalog = cloneModelCatalog();

    validateRoutingSnapshot(snapshot);
    return snapshot;
}

/**
 * Parse a boolean from environment variable.
 *
 * @param value - String value from env
 * @param defaultValue - Default if not set or invalid
 * @returns Parsed boolean
 */
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined || value === '') return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse an integer from environment variable.
 *
 * @param value - String value from env
 * @param defaultValue - Default if not set or invalid
 * @returns Parsed integer
 */
function parseIntEnv(value: string | undefined, defaultValue: number): number {
    if (value === undefined || value === '') return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Deep merge two objects.
 *
 * @param target - Target object
 * @param source - Source object to merge
 * @returns Merged object
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
    if (target === null || target === undefined) return source as T;
    if (source === null || source === undefined) return target;

    const result = { ...target } as T;

    for (const key of Object.keys(source) as Array<keyof T>) {
        const sourceValue = source[key];
        const targetValue = (target as Record<string, unknown>)[key as string];

        if (
            sourceValue !== null &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue !== null &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)
        ) {
            (result as Record<string, unknown>)[key as string] = deepMerge(
                targetValue,
                sourceValue as Partial<typeof targetValue>
            );
        } else if (sourceValue !== undefined) {
            (result as Record<string, unknown>)[key as string] = sourceValue;
        }
    }

    return result;
}

/**
 * Default tier model configurations.
 */
const DEFAULT_TIER_MODELS: Record<TaskTier, TierModelConfig> = {
    [TaskTier.HEARTBEAT]: {
        primary: 'google/gemini-2.5-flash-lite',
        fallback: 'deepseek/deepseek-chat',
    },
    [TaskTier.SIMPLE]: {
        primary: 'deepseek/deepseek-chat',
        fallback: 'google/gemini-2.5-flash',
    },
    [TaskTier.MODERATE]: {
        primary: 'google/gemini-2.5-flash',
        fallback: 'openai/gpt-5-mini',
    },
    [TaskTier.COMPLEX]: {
        primary: 'anthropic/claude-sonnet-4-6',
        fallback: 'openai/gpt-5.2',
    },
    [TaskTier.FRONTIER_SONNET]: {
        primary: 'anthropic/claude-sonnet-4-6',
        fallback: 'openai/gpt-5',
    },
    [TaskTier.FRONTIER_OPUS]: {
        primary: 'anthropic/claude-opus-4-6',
        fallback: 'openai/o3',
    },
};

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Omit<ClawRouteConfig, 'apiKeys' | 'overrides'> = {
    enabled: true,
    dryRun: false,
    baselineModel: 'openrouter/anthropic/claude-sonnet-4.6',
    providerProfile: null,
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

    models: DEFAULT_TIER_MODELS,

    logging: {
        dbPath: './data/clawroute.db',
        logContent: false,
        logSystemPrompts: false,
        debugMode: false,
        retentionDays: 30,
    },

    dashboard: {
        enabled: true,
    },

    // v1.1: Alerts defaults (disabled)
    alerts: {},
};

/**
 * Load alerts config from environment.
 *
 * @returns AlertsConfig
 */
function loadAlertsConfig(): AlertsConfig {
    return {
        email: process.env['CLAWROUTE_ALERT_EMAIL'],
        slackWebhook: process.env['CLAWROUTE_ALERT_SLACK_WEBHOOK'],
    };
}

/**
 * Load the Codex OAuth token.
 *
 * Priority:
 * 1. OPENAI_CODEX_TOKEN env var (explicit sess- token)
 * 2. OPENAI_CODEX_AUTH_PATH env var (path to a codex auth.json)
 * 3. Default path: ~/.codex/auth.json (written by `codex login`)
 *
 * @returns The Codex bearer token or empty string
 */
function loadCodexToken(): string {
    if (process.env['OPENAI_CODEX_TOKEN']) {
        return process.env['OPENAI_CODEX_TOKEN'];
    }
    try {
        const multiPaths = process.env['OPENAI_CODEX_AUTH_PATHS'];
        const authPath = multiPaths
            ? multiPaths.split(',')[0]?.trim() ?? ''
            : (process.env['OPENAI_CODEX_AUTH_PATH'] || join(homedir(), '.codex', 'auth.json'));
        if (existsSync(authPath)) {
            const content = readFileSync(authPath, 'utf-8');
            const auth = JSON.parse(content) as Record<string, unknown>;
            // Current codex CLI stores token at tokens.access_token.
            // Older/docs format used chatgpt_access_token — keep as fallback.
            const tokensObj = auth['tokens'] as Record<string, unknown> | undefined;
            const token = (tokensObj?.['access_token'] as string | undefined)
                ?? (auth['chatgpt_access_token'] as string | undefined);
            if (typeof token === 'string' && token.length > 0) {
                return token;
            }
        }
    } catch {
        // Auth file not found or invalid
    }
    return '';
}

/**
 * Load API keys from environment variables.
 *
 * @returns Record of provider to API key
 */
function loadApiKeys(): Record<ProviderType, string> {
    return {
        anthropic: process.env['ANTHROPIC_API_KEY'] ?? '',
        openai: process.env['OPENAI_API_KEY'] ?? '',
        codex: loadCodexToken(),
        google: process.env['GOOGLE_API_KEY'] ?? '',
        deepseek: process.env['DEEPSEEK_API_KEY'] ?? '',
        openrouter: process.env['OPENROUTER_API_KEY'] ?? '',
        ollama: '', // Local — no API key required
        'x-ai': process.env['XAI_API_KEY'] ?? '',
        stepfun: process.env['STEPFUN_API_KEY'] ?? '',
    };
}

/**
 * Check if at least one API key is configured.
 *
 * @param apiKeys - The API keys record
 * @returns True if at least one key is set
 */
function hasAnyApiKey(apiKeys: Record<ProviderType, string>): boolean {
    // Ollama is local and requires no API key — treat a set OLLAMA_ENDPOINT as configured
    if (process.env['OLLAMA_ENDPOINT']) return true;
    return Object.entries(apiKeys)
        .filter(([provider]) => provider !== 'ollama')
        .some(([, key]) => key && key.length > 0);
}

/**
 * Validate the configuration.
 *
 * @param config - The configuration to validate
 * @throws Error if configuration is invalid
 */
function validateConfig(config: ClawRouteConfig): void {
    // Check for at least one API key
    if (!hasAnyApiKey(config.apiKeys)) {
        throw new Error(
            'No API keys configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_CODEX_TOKEN, GOOGLE_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY (or run `codex login` for Codex subscription access)'
        );
    }

    // Validate port
    if (config.proxyPort < 1 || config.proxyPort > 65535) {
        throw new Error(`Invalid port: ${config.proxyPort}. Must be between 1 and 65535.`);
    }

    // Validate retention days
    if (config.logging.retentionDays < 1) {
        throw new Error(`Invalid retention days: ${config.logging.retentionDays}. Must be at least 1.`);
    }

    // Validate min confidence
    if (config.classification.minConfidence < 0 || config.classification.minConfidence > 1) {
        throw new Error(
            `Invalid minConfidence: ${config.classification.minConfidence}. Must be between 0 and 1.`
        );
    }

    // Validate model configs
    for (const tier of Object.values(TaskTier)) {
        const tierConfig = config.models[tier];
        if (!tierConfig) {
            throw new Error(`Missing model configuration for tier: ${tier}`);
        }
        if (!tierConfig.primary) {
            throw new Error(`Missing primary model for tier: ${tier}`);
        }
        if (!tierConfig.fallback) {
            throw new Error(`Missing fallback model for tier: ${tier}`);
        }
    }
}

/**
 * Load the complete ClawRoute configuration.
 *
 * Priority order:
 * 1. Default values (lowest)
 * 2. config/default.json
 * 3. config/clawroute.json (user customizations)
 * 4. Environment variables (highest)
 *
 * @returns The loaded configuration
 * @throws Error if configuration is invalid
 */
export function loadConfig(): ClawRouteConfig {
    const projectRoot = getProjectRoot();
    const defaultConfigPath = join(projectRoot, 'config', 'default.json');
    const userConfigPath = join(projectRoot, 'config', 'clawroute.json');
    const defaultJson = loadJsonConfig(defaultConfigPath);
    const userJson = loadJsonConfig(userConfigPath);
    const resolvedProfile = getResolvedProfile(defaultJson, userJson, process.env);
    const profileJson = loadProfileJson(projectRoot, resolvedProfile);

    // Start with defaults
    let config: ClawRouteConfig = {
        ...DEFAULT_CONFIG,
        models: cloneTierModels(DEFAULT_TIER_MODELS),
        apiKeys: loadApiKeys(),
        overrides: {
            globalForceModel: null,
            sessions: {},
        },
    };

    // Load bundled default config
    if (defaultJson) {
        config = deepMerge(config, defaultJson as Partial<ClawRouteConfig>);
    }

    if (profileJson) {
        config = deepMerge(config, profileJson as Partial<ClawRouteConfig>);
    }

    // Load user config (if exists)
    if (userJson) {
        config = deepMerge(config, userJson as Partial<ClawRouteConfig>);
    }

    config.providerProfile = resolvedProfile;

    // Apply environment variable overrides
    config.enabled = parseBoolEnv(process.env['CLAWROUTE_ENABLED'], config.enabled);
    config.dryRun = parseBoolEnv(process.env['CLAWROUTE_DRY_RUN'], config.dryRun);
    config.baselineModel = process.env['CLAWROUTE_BASELINE_MODEL'] || config.baselineModel;
    config.proxyPort = parseIntEnv(process.env['CLAWROUTE_PORT'], config.proxyPort);

    if (process.env['CLAWROUTE_HOST']) {
        config.proxyHost = process.env['CLAWROUTE_HOST'];
    }

    if (process.env['CLAWROUTE_TOKEN']) {
        config.authToken = process.env['CLAWROUTE_TOKEN'];
    }

    config.logging.debugMode = parseBoolEnv(
        process.env['CLAWROUTE_DEBUG'],
        config.logging.debugMode
    );

    config.logging.logContent = parseBoolEnv(
        process.env['CLAWROUTE_LOG_CONTENT'],
        config.logging.logContent
    );

    // Reload API keys (in case they were updated)
    config.apiKeys = loadApiKeys();

    // v1.1: Load alerts configuration from environment
    config.alerts = loadAlertsConfig();

    const routingSnapshot = buildRoutingSnapshot(projectRoot);
    config.providerProfile = routingSnapshot.providerProfile;
    config.baselineModel = routingSnapshot.baselineModel;
    config.models = cloneTierModels(routingSnapshot.models);
    config.contextOverrides = routingSnapshot.contextOverrides;

    // Validate the final configuration
    validateConfig(config);

    return config;
}

/**
 * Get a redacted version of the config for display.
 * Removes API keys and sensitive values.
 *
 * @param config - The configuration to redact
 * @returns Redacted configuration
 */
export function getRedactedConfig(
    config: ClawRouteConfig
): Omit<ClawRouteConfig, 'apiKeys'> & { apiKeys: Record<ProviderType, string> } {
    const redactedKeys: Record<ProviderType, string> = {
        anthropic: config.apiKeys.anthropic ? '[REDACTED]' : '',
        openai: config.apiKeys.openai ? '[REDACTED]' : '',
        codex: config.apiKeys.codex ? '[REDACTED]' : '',
        google: config.apiKeys.google ? '[REDACTED]' : '',
        deepseek: config.apiKeys.deepseek ? '[REDACTED]' : '',
        openrouter: config.apiKeys.openrouter ? '[REDACTED]' : '',
        ollama: '', // No API key for Ollama
        'x-ai': config.apiKeys['x-ai'] ? '[REDACTED]' : '',
        stepfun: config.apiKeys.stepfun ? '[REDACTED]' : '',
    };

    return {
        ...config,
        authToken: config.authToken ? '[REDACTED]' : null,
        apiKeys: redactedKeys,
    };
}

/**
 * Check if a specific provider's API key is available.
 *
 * @param config - The configuration
 * @param provider - The provider to check
 * @returns True if the provider's API key is set
 */
export function hasApiKey(config: ClawRouteConfig, provider: ProviderType): boolean {
    // Ollama is local — always available without an API key
    if (provider === 'ollama') return true;
    const key = config.apiKeys[provider];
    return key !== undefined && key.length > 0;
}

/**
 * Get the API key for a provider.
 *
 * @param config - The configuration
 * @param provider - The provider
 * @returns The API key or empty string
 */
export function getApiKey(config: ClawRouteConfig, provider: ProviderType): string {
    return config.apiKeys[provider] ?? '';
}

// Singleton config instance
let configInstance: ClawRouteConfig | null = null;

/**
 * Get the global configuration instance.
 * Loads the config on first call.
 *
 * @returns The configuration
 */
export function getConfig(): ClawRouteConfig {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

/**
 * Reset the config instance (for testing).
 */
export function resetConfig(): void {
    configInstance = null;
}

/**
 * Update the runtime configuration.
 * Only updates runtime-modifiable fields.
 *
 * @param updates - Partial config updates
 */
export function updateConfig(updates: Partial<Pick<ClawRouteConfig, 'enabled' | 'dryRun' | 'overrides'>>): void {
    const config = getConfig();

    if (updates.enabled !== undefined) {
        config.enabled = updates.enabled;
    }

    if (updates.dryRun !== undefined) {
        config.dryRun = updates.dryRun;
    }

    if (updates.overrides !== undefined) {
        config.overrides = updates.overrides;
    }
}
