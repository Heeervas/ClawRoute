import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProjectRoot, buildRoutingSnapshot } from '../src/config.js';
import { getModelEntry } from '../src/models.js';
import { TaskTier } from '../src/types.js';

type DefaultConfig = {
    contextOverrides?: Record<string, number>;
};

function readDefaultConfig(): DefaultConfig {
    const content = readFileSync(join(process.cwd(), 'config', 'default.json'), 'utf-8');
    return JSON.parse(content) as DefaultConfig;
}

describe('Codex model metadata', () => {
    it('keeps GPT-5.4 family context windows aligned with current OpenAI docs', () => {
        const config = readDefaultConfig();

        expect(getModelEntry('codex/gpt-5.4-mini')?.maxContext).toBe(400000);
        expect(config.contextOverrides?.['codex/gpt-5.4-mini']).toBe(400000);
        expect(getModelEntry('codex/gpt-5.4')?.maxContext).toBe(1050000);
        expect(config.contextOverrides?.['codex/gpt-5.4']).toBe(1050000);
    });

    it('builds a valid codex routing snapshot from the checked-in provider profile', () => {
        const snapshot = buildRoutingSnapshot(getProjectRoot(), {
            ...process.env,
            CLAWROUTE_PROVIDER: 'codex',
        });

        expect(snapshot.providerProfile).toBe('codex');
        expect(snapshot.baselineModel).toBe('codex/gpt-5.5');
        expect(snapshot.models[TaskTier.MODERATE]).toEqual({
            primary: 'codex/gpt-5.5',
            fallback: 'codex/gpt-5.4',
        });
        expect(snapshot.models[TaskTier.COMPLEX]).toEqual({
            primary: 'codex/gpt-5.5',
            fallback: 'codex/gpt-5.4',
        });
        expect(snapshot.modelCatalog.some((model) => model.id === 'codex/gpt-5.5' && model.enabled)).toBe(true);
    });
});