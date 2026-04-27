import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getModelEntry } from '../src/models.js';

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
});