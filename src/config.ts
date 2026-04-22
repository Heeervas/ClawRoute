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

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
    ClawRouteConfig,
    TaskTier,
    TierModelConfig,
    ProviderType,
    AlertsConfig,
} from './types.js';
import { applyContextOverrides } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the project root directory.
 */
function getProjectRoot(): string {
    // Go up from src/ or dist/ to project root
    return join(__dirname, '..');
}

/**
 * Load JSON config file safely.
 *
 * @param path - Path to the config file
 * @returns Parsed JSON or null if not found/invalid
 */
function loadJsonConfig(path: string): Record<string, unknown> | null {
    try {
        if (!existsSync(path)) {
            return null;
        }
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
        console.warn(`Warning: Failed to load config from ${path}:`, error);
        return null;
    }
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

    // Start with defaults
    let config: ClawRouteConfig = {
        ...DEFAULT_CONFIG,
        apiKeys: loadApiKeys(),
        overrides: {
            globalForceModel: null,
            sessions: {},
        },
    };

    // Load bundled default config
    const defaultConfigPath = join(projectRoot, 'config', 'default.json');
    const defaultJson = loadJsonConfig(defaultConfigPath);
    if (defaultJson) {
        config = deepMerge(config, defaultJson as Partial<ClawRouteConfig>);
    }

    // Load user config (if exists)
    const userConfigPath = join(projectRoot, 'config', 'clawroute.json');
    const userJson = loadJsonConfig(userConfigPath);
    if (userJson) {
        config = deepMerge(config, userJson as Partial<ClawRouteConfig>);
    }

    // Resolve provider profile: env var > JSON config > null
    // This must happen AFTER the JSON files are merged so default.json's providerProfile is visible,
    // but BEFORE env vars so CLAWROUTE_PROVIDER can still override it.
    const resolvedProfile = process.env['CLAWROUTE_PROVIDER'] || (config.providerProfile ?? null);
    if (resolvedProfile) {
        const profilePath = join(projectRoot, 'config', 'providers', `${resolvedProfile}.json`);
        const profileJson = loadJsonConfig(profilePath);
        if (profileJson) {
            config = deepMerge(config, profileJson as Partial<ClawRouteConfig>);
        } else {
            console.warn(`⚠️  Provider profile "${resolvedProfile}" not found at ${profilePath}. Ignoring.`);
        }
    }

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

    // Apply per-model maxContext overrides from config
    if (config.contextOverrides && Object.keys(config.contextOverrides).length > 0) {
        applyContextOverrides(config.contextOverrides);
        if (config.logging.debugMode) {
            console.log(`📏 Applied ${Object.keys(config.contextOverrides).length} context overrides`);
        }
    }

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
