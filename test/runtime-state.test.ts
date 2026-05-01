import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskTier } from '../src/types.js';
import { getModelEntry } from '../src/models.js';

const tempDirs: string[] = [];

const OPENROUTER_MODELS = {
    heartbeat: { primary: 'openrouter/google/gemini-2.5-flash-lite', fallback: 'openrouter/google/gemini-2.5-flash' },
    simple: { primary: 'openrouter/google/gemini-2.5-flash', fallback: 'openrouter/google/gemini-2.5-flash-lite' },
    moderate: { primary: 'openrouter/google/gemini-2.5-flash', fallback: 'openai/gpt-5-mini' },
    complex: { primary: 'openrouter/anthropic/claude-sonnet-4.6', fallback: 'openai/gpt-5.2' },
    'frontier-sonnet': { primary: 'openrouter/anthropic/claude-sonnet-4.6', fallback: 'openai/gpt-5.2' },
    'frontier-opus': { primary: 'openrouter/anthropic/claude-opus-4.6', fallback: 'openai/o3' },
};

const CODEX_MODELS = {
    heartbeat: { primary: 'codex/gpt-5.4-mini', fallback: 'codex/gpt-5.4-mini' },
    simple: { primary: 'codex/gpt-5.4-mini', fallback: 'codex/gpt-5.4-mini' },
    moderate: { primary: 'codex/gpt-5.5', fallback: 'codex/gpt-5.5' },
    complex: { primary: 'codex/gpt-5.5', fallback: 'codex/gpt-5.5' },
    'frontier-sonnet': { primary: 'codex/gpt-5.5', fallback: 'codex/gpt-5.5' },
    'frontier-opus': { primary: 'codex/gpt-5.5', fallback: 'codex/gpt-5.5' },
};

function makeTempProjectRoot(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-state-'));
    tempDirs.push(projectRoot);
    return projectRoot;
}

function writeJson(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedProjectRoot(projectRoot: string, userConfig: Record<string, unknown>): void {
    writeJson(join(projectRoot, 'config', 'default.json'), {
        providerProfile: 'openrouter',
        baselineModel: 'openrouter/anthropic/claude-sonnet-4.6',
        models: OPENROUTER_MODELS,
    });
    writeJson(join(projectRoot, 'config', 'providers', 'openrouter.json'), {
        baselineModel: 'openrouter/anthropic/claude-sonnet-4.6',
        models: OPENROUTER_MODELS,
    });
    writeJson(join(projectRoot, 'config', 'providers', 'codex.json'), {
        baselineModel: 'codex/gpt-5.5',
        models: CODEX_MODELS,
    });
    writeJson(join(projectRoot, 'config', 'clawroute.json'), userConfig);
}

async function createRuntimeState(projectRoot: string) {
    const { createRuntimeStateManager } = await import('../src/runtime-state.js');
    return createRuntimeStateManager({ projectRoot });
}

async function stopRuntimeState(runtimeState: { stop?: () => Promise<void> | void }): Promise<void> {
    await runtimeState.stop?.();
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('Runtime state hot reload', () => {
    it('hot-reloads providerProfile file changes on the runtime snapshot path', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, { providerProfile: 'openrouter' });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            const initialSnapshot = runtimeState.getSnapshot();
            expect(initialSnapshot.providerProfile).toBe('openrouter');
            expect(initialSnapshot.models[TaskTier.COMPLEX].primary).toBe('openrouter/anthropic/claude-sonnet-4.6');

            writeJson(join(projectRoot, 'config', 'clawroute.json'), { providerProfile: 'codex' });
            await runtimeState.reloadNow('test provider profile switch');

            const reloadedSnapshot = runtimeState.getSnapshot();
            expect(reloadedSnapshot.providerProfile).toBe('codex');
            expect(reloadedSnapshot.models[TaskTier.COMPLEX].primary).toBe('codex/gpt-5.5');
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });

    it('keeps config/clawroute.json baselineModel after providerProfile changes because local overrides win on reload', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, {
            providerProfile: 'openrouter',
            baselineModel: 'openai/gpt-5.2',
        });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            writeJson(join(projectRoot, 'config', 'clawroute.json'), {
                providerProfile: 'codex',
                baselineModel: 'openai/gpt-5.2',
            });
            await runtimeState.reloadNow('test baseline precedence');

            const reloadedSnapshot = runtimeState.getSnapshot();
            expect(reloadedSnapshot.providerProfile).toBe('codex');
            expect(reloadedSnapshot.baselineModel).toBe('openai/gpt-5.2');
            expect(reloadedSnapshot.models[TaskTier.COMPLEX].primary).toBe('codex/gpt-5.5');
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });

    it('reloads a standalone baselineModel edit from config/clawroute.json without restart', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, {
            providerProfile: 'openrouter',
            baselineModel: 'openrouter/anthropic/claude-sonnet-4.6',
        });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            writeJson(join(projectRoot, 'config', 'clawroute.json'), {
                providerProfile: 'openrouter',
                baselineModel: 'codex/gpt-5.5',
            });
            await runtimeState.reloadNow('test baseline model edit');

            const reloadedSnapshot = runtimeState.getSnapshot();
            expect(reloadedSnapshot.providerProfile).toBe('openrouter');
            expect(reloadedSnapshot.baselineModel).toBe('codex/gpt-5.5');
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });

    it('applies config/model-registry.json additions and bundled disables on reload', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, { providerProfile: 'openrouter' });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            writeJson(join(projectRoot, 'config', 'model-registry.json'), {
                models: {
                    'openai/gpt-runtime-preview': {
                        provider: 'openai',
                        maxContext: 64000,
                        toolCapable: true,
                        multimodal: false,
                        enabled: true,
                        inputCostPer1M: 0.4,
                        outputCostPer1M: 1.6,
                    },
                    'codex/gpt-4.1-mini': {
                        enabled: false,
                    },
                },
            });
            await runtimeState.reloadNow('test model-registry overlay');

            expect(getModelEntry('openai/gpt-runtime-preview')?.enabled).toBe(true);
            expect(getModelEntry('codex/gpt-4.1-mini')?.enabled).toBe(false);
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });

    it('keeps the last known-good snapshot when a watched JSON file becomes invalid', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, {
            providerProfile: 'codex',
            baselineModel: 'codex/gpt-5.5',
        });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            expect(runtimeState.getSnapshot().providerProfile).toBe('codex');

            writeFileSync(join(projectRoot, 'config', 'clawroute.json'), '{"providerProfile":');
            await expect(runtimeState.reloadNow('test invalid json rollback')).rejects.toThrow();

            const snapshot = runtimeState.getSnapshot();
            expect(snapshot.providerProfile).toBe('codex');
            expect(snapshot.baselineModel).toBe('codex/gpt-5.5');
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });

    it('keeps a frozen model catalog per snapshot across reloads', async () => {
        const projectRoot = makeTempProjectRoot();
        seedProjectRoot(projectRoot, { providerProfile: 'openrouter' });

        const runtimeState = await createRuntimeState(projectRoot);

        try {
            const firstSnapshot = runtimeState.getSnapshot() as unknown as {
                modelCatalog: Array<{ id: string; enabled: boolean }>;
            };

            writeJson(join(projectRoot, 'config', 'model-registry.json'), {
                models: {
                    'codex/gpt-4.1-mini': { enabled: false },
                },
            });
            await runtimeState.reloadNow('test snapshot catalog isolation');

            const secondSnapshot = runtimeState.getSnapshot() as unknown as {
                modelCatalog: Array<{ id: string; enabled: boolean }>;
            };

            expect(firstSnapshot.modelCatalog.find((model) => model.id === 'codex/gpt-4.1-mini')?.enabled).toBe(true);
            expect(secondSnapshot.modelCatalog.find((model) => model.id === 'codex/gpt-4.1-mini')?.enabled).toBe(false);
        } finally {
            await stopRuntimeState(runtimeState);
        }
    });
});