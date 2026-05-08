import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-05-03T10:00:00.000Z');
const UPDATED_AT = new Date(NOW).toISOString();

async function loadSubject() {
    return import('../src/' + 'codex-balance-loader.js');
}

function futureIso(hoursFromNow: number): string {
    return new Date(NOW + hoursFromNow * 3_600_000).toISOString();
}

function makeWindow(window: 'fiveHour' | 'weekly', usedPercent: number, resetAt: string) {
    return {
        window,
        usedPercent,
        resetAt,
        updatedAt: UPDATED_AT,
        windowMinutes: window === 'fiveHour' ? 300 : 10_080,
    };
}

function makeAccount(accountKey: string, options: {
    slotIndexes: number[];
    fiveHour?: number | null;
    weekly?: number | null;
    fiveHourResetHours?: number;
    source?: 'live' | 'cache' | 'persisted';
    stale?: boolean;
}) {
    return {
        accountKey,
        slotIndex: options.slotIndexes[0] ?? 0,
        slotIndexes: options.slotIndexes,
        slotPaths: options.slotIndexes.map((slotIndex) => `/.codex/auth-${slotIndex}.json`),
        source: options.source ?? 'live',
        stale: options.stale ?? false,
        cooldownUntil: null,
        lastFetchedAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        fiveHour: options.fiveHour === null
            ? null
            : makeWindow('fiveHour', options.fiveHour ?? 30, futureIso(options.fiveHourResetHours ?? 1)),
        weekly: options.weekly === null
            ? null
            : makeWindow('weekly', options.weekly ?? 30, futureIso(72)),
    };
}

function makeSlot(slotIndex: number, accountKey: string, overrides: Record<string, unknown> = {}) {
    return {
        slotIndex,
        accountKey,
        pendingLeases: 0,
        lastSelectedAt: new Date(NOW - slotIndex * 60_000).toISOString(),
        rateLimitedUntil: 0,
        ...overrides,
    };
}

describe('Codex balance loader', () => {
    it('ranks balanced accounts above skewed ones and picks the least-loaded duplicate slot', async () => {
        const { selectCodexBalanceCandidate } = await loadSubject();
        const result = selectCodexBalanceCandidate({
            now: NOW,
            provider: 'codex',
            accounts: [
                makeAccount('acct-skewed-short', { slotIndexes: [0], fiveHour: 5, weekly: 80 }),
                makeAccount('acct-balanced', { slotIndexes: [1, 3], fiveHour: 30, weekly: 30 }),
                makeAccount('acct-skewed-weekly', { slotIndexes: [2], fiveHour: 80, weekly: 5 }),
            ],
            slots: [
                makeSlot(0, 'acct-skewed-short'),
                makeSlot(1, 'acct-balanced', { pendingLeases: 1, lastSelectedAt: new Date(NOW - 60_000).toISOString() }),
                makeSlot(2, 'acct-skewed-weekly'),
                makeSlot(3, 'acct-balanced', { pendingLeases: 0, lastSelectedAt: new Date(NOW - 600_000).toISOString() }),
            ],
            excludedSlotIndexes: new Set<number>(),
            sessionAffinity: null,
        });

        expect(result).toMatchObject({
            fallbackReason: null,
            selectedAccountKey: 'acct-balanced',
            selectedSlotIndex: 3,
            affinityApplied: false,
        });
    });

    it('lets remembered affinity win only inside the 0.05 score band', async () => {
        const { selectCodexBalanceCandidate } = await loadSubject();
        const result = selectCodexBalanceCandidate({
            now: NOW,
            provider: 'codex',
            accounts: [
                makeAccount('acct-preferred', { slotIndexes: [0], fiveHour: 35, weekly: 35, fiveHourResetHours: 1 }),
                makeAccount('acct-slightly-better', { slotIndexes: [1], fiveHour: 32, weekly: 34, fiveHourResetHours: 1 }),
            ],
            slots: [makeSlot(0, 'acct-preferred'), makeSlot(1, 'acct-slightly-better')],
            excludedSlotIndexes: new Set<number>(),
            sessionAffinity: {
                sessionId: 'session-1',
                cacheEligible: true,
                preferredProvider: 'codex',
                preferredAccountKey: 'acct-preferred',
            },
        });

        expect(result).toMatchObject({
            fallbackReason: null,
            selectedAccountKey: 'acct-preferred',
            selectedSlotIndex: 0,
            affinityApplied: true,
        });
    });

    it('drops remembered affinity when the preferred account falls below the safety floor', async () => {
        const { selectCodexBalanceCandidate } = await loadSubject();
        const result = selectCodexBalanceCandidate({
            now: NOW,
            provider: 'codex',
            accounts: [
                makeAccount('acct-exhausted', { slotIndexes: [0], fiveHour: 85, weekly: 81, fiveHourResetHours: 1 }),
                makeAccount('acct-healthy', { slotIndexes: [1], fiveHour: 42, weekly: 43, fiveHourResetHours: 1 }),
            ],
            slots: [makeSlot(0, 'acct-exhausted'), makeSlot(1, 'acct-healthy')],
            excludedSlotIndexes: new Set<number>(),
            sessionAffinity: {
                sessionId: 'session-2',
                cacheEligible: true,
                preferredProvider: 'codex',
                preferredAccountKey: 'acct-exhausted',
            },
        });

        expect(result).toMatchObject({
            fallbackReason: null,
            selectedAccountKey: 'acct-healthy',
            selectedSlotIndex: 1,
            affinityApplied: false,
        });
    });

    it('drops remembered affinity when lease pressure pushes another healthy account ahead', async () => {
        const { selectCodexBalanceCandidate } = await loadSubject();
        const result = selectCodexBalanceCandidate({
            now: NOW,
            provider: 'codex',
            accounts: [
                makeAccount('acct-preferred', { slotIndexes: [0], fiveHour: 34, weekly: 36, fiveHourResetHours: 1 }),
                makeAccount('acct-healthier', { slotIndexes: [1], fiveHour: 33, weekly: 35, fiveHourResetHours: 1 }),
            ],
            slots: [
                makeSlot(0, 'acct-preferred', { pendingLeases: 1 }),
                makeSlot(1, 'acct-healthier', { pendingLeases: 0 }),
            ],
            excludedSlotIndexes: new Set<number>(),
            sessionAffinity: {
                sessionId: 'session-3',
                cacheEligible: true,
                preferredProvider: 'codex',
                preferredAccountKey: 'acct-preferred',
            },
        });

        expect(result).toMatchObject({
            fallbackReason: null,
            selectedAccountKey: 'acct-healthier',
            selectedSlotIndex: 1,
            affinityApplied: false,
        });
    });

    it('treats a missing session like quota-only selection even when a preferred account is supplied', async () => {
        const { selectCodexBalanceCandidate } = await loadSubject();
        const result = selectCodexBalanceCandidate({
            now: NOW,
            provider: 'codex',
            accounts: [
                makeAccount('acct-preferred', { slotIndexes: [0], fiveHour: 36, weekly: 36, fiveHourResetHours: 1 }),
                makeAccount('acct-best', { slotIndexes: [1], fiveHour: 25, weekly: 26, fiveHourResetHours: 1 }),
            ],
            slots: [makeSlot(0, 'acct-preferred'), makeSlot(1, 'acct-best')],
            excludedSlotIndexes: new Set<number>(),
            sessionAffinity: {
                sessionId: null,
                cacheEligible: true,
                preferredProvider: 'codex',
                preferredAccountKey: 'acct-preferred',
            },
        });

        expect(result).toMatchObject({
            fallbackReason: null,
            selectedAccountKey: 'acct-best',
            selectedSlotIndex: 1,
            affinityApplied: false,
        });
    });
});