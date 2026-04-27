import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getRecentDecisions, initDb, logRouting } from '../src/logger.js';
import { ClawRouteConfig, LogEntry, TaskTier } from '../src/types.js';

const tempDirs: string[] = [];

function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'clawroute-logger-'));
    tempDirs.push(dir);
    return dir;
}

function createTestConfig(dbPath: string): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        baselineModel: 'openrouter/anthropic/claude-sonnet-4.6',
        providerProfile: null,
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
            dbPath,
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
            ollama: '',
            'x-ai': '',
            stepfun: '',
        },
        alerts: {},
    };
}

function createLogEntry(): LogEntry {
    return {
        timestamp: new Date().toISOString(),
        original_model: 'openai/gpt-5-mini',
        routed_model: 'deepseek/deepseek-chat',
        actual_model: 'deepseek/deepseek-chat',
        tier: TaskTier.SIMPLE,
        classification_reason: 'test',
        confidence: 0.9,
        input_tokens: 12,
        output_tokens: 8,
        original_cost_usd: 0.1,
        actual_cost_usd: 0.01,
        savings_usd: 0.09,
        escalated: false,
        escalation_chain: '[]',
        response_time_ms: 25,
        had_tool_calls: false,
        is_dry_run: false,
        is_override: false,
        session_id: null,
        error: null,
        prompt_preview: null,
        context_info: null,
    };
}

afterEach(() => {
    closeDb();
    vi.restoreAllMocks();

    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('logger startup recovery', () => {
    it('recreates a fresh database when the persisted file is malformed', async () => {
        const dataDir = createTempDir();
        const dbPath = join(dataDir, 'clawroute.db');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = createTestConfig(dbPath);

        writeFileSync(dbPath, 'not a sqlite database');

        await expect(initDb(config)).resolves.toBeUndefined();

        logRouting(createLogEntry());

        const backupFiles = readdirSync(dataDir).filter((name) =>
            name.startsWith('clawroute.db.corrupt-')
        );

        expect(backupFiles).toHaveLength(1);
        expect(getRecentDecisions(10)).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Recovered corrupted ClawRoute database')
        );
    });
});