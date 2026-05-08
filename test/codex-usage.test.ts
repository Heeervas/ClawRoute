import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;
const NOW = Date.parse('2026-05-03T10:00:00.000Z');

function hashAccountKey(accountId: string): string {
    return createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

function iso(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString();
}

function usageWindow(limitWindowSeconds: number, usedPercent: number, resetsAt: number) {
    return { limit_window_seconds: limitWindowSeconds, used_percent: usedPercent, resets_at: resetsAt };
}

function usageWindowResetAt(limitWindowSeconds: number, usedPercent: number, resetAt: number) {
    return { limit_window_seconds: limitWindowSeconds, used_percent: usedPercent, reset_at: resetAt };
}

function usagePayload(
    accountId: string,
    primaryWindow: Record<string, number> | null,
    secondaryWindow?: Record<string, number> | null,
) {
    return {
        account_id: accountId,
        primary_window: primaryWindow,
        ...(secondaryWindow === undefined ? {} : { secondary_window: secondaryWindow }),
    };
}

function usagePayloadRateLimit(
    accountId: string,
    primaryWindow: Record<string, number> | null,
    secondaryWindow?: Record<string, number> | null,
) {
    return {
        account_id: accountId,
        rate_limit: {
            primary_window: primaryWindow,
            ...(secondaryWindow === undefined ? {} : { secondary_window: secondaryWindow }),
        },
    };
}

async function loadSubject() {
    return import('../src/codex-usage.js');
}

async function createService(overrides: Record<string, unknown> = {}) {
    const { createCodexUsageService } = await loadSubject();
    const deps = {
        now: () => NOW,
        cacheTtlMs: 60_000,
        listSlots: vi.fn(async () => [{ slotIndex: 0, accountId: 'acct-default' }]),
        fetchUsage: vi.fn(async () => usagePayload(
            'acct-default',
            usageWindow(FIVE_HOURS, 12, 1_800_000_000),
            usageWindow(SEVEN_DAYS, 48, 1_800_604_800),
        )),
        readLatestSnapshots: vi.fn(async () => []),
        writeSnapshots: vi.fn(async () => undefined),
        getCooldownState: vi.fn(() => []),
        ...overrides,
    };
    return { service: createCodexUsageService(deps), deps };
}

async function getSelectorSnapshot(service: unknown, input: {
    slots: Array<{
        slotIndex: number;
        slotPath: string | null;
        accountKey: string | null;
        rateLimitedUntil: number;
    }>;
    persistedMaxAgeMs?: number;
    refreshThrottleMs?: number;
}) {
    return await (service as {
        getSelectorSnapshot: (input: typeof input) => Promise<{
            accounts: Array<Record<string, unknown>>;
            unknownAccountSlotIndexes: number[];
            missingUsageSlotIndexes: number[];
            staleAccountKeys: string[];
            triggeredBackgroundRefresh: boolean;
        }>;
    }).getSelectorSnapshot(input);
}

beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
});

describe('Codex usage normalization', () => {
    it('normalizes a 5h primary window and 7d secondary window into canonical fiveHour and weekly shapes', async () => {
        const { normalizeCodexUsageSnapshot } = await loadSubject();
        const normalized = normalizeCodexUsageSnapshot({
            slotIndex: 2,
            fetchedAt: new Date(NOW).toISOString(),
            payload: usagePayload(
                'acct-primary-123',
                usageWindow(FIVE_HOURS, 23, 1_800_018_000),
                usageWindow(SEVEN_DAYS, 61, 1_800_604_800),
            ),
        });

        expect(normalized).toMatchObject({
            accountKey: hashAccountKey('acct-primary-123'),
            slotIndex: 2,
            fiveHour: { usedPercent: 23, windowMinutes: 300, resetAt: iso(1_800_018_000) },
            weekly: { usedPercent: 61, windowMinutes: 10_080, resetAt: iso(1_800_604_800) },
        });
    });

    it('treats a weekly-only primary window as weekly when the secondary window is absent', async () => {
        const { normalizeCodexUsageSnapshot } = await loadSubject();
        const normalized = normalizeCodexUsageSnapshot({
            slotIndex: 1,
            fetchedAt: new Date(NOW).toISOString(),
            payload: usagePayload('acct-weekly-only', usageWindow(SEVEN_DAYS, 72, 1_800_604_800)),
        });

        expect(normalized.fiveHour ?? null).toBeNull();
        expect(normalized.weekly).toMatchObject({
            usedPercent: 72,
            windowMinutes: 10_080,
            resetAt: iso(1_800_604_800),
        });
    });

    it('keeps fiveHour data when secondary_window is missing instead of inventing a weekly value', async () => {
        const { normalizeCodexUsageSnapshot } = await loadSubject();
        const normalized = normalizeCodexUsageSnapshot({
            slotIndex: 0,
            fetchedAt: new Date(NOW).toISOString(),
            payload: usagePayload('acct-no-secondary', usageWindow(FIVE_HOURS, 19, 1_800_018_000)),
        });

        expect(normalized.fiveHour).toMatchObject({
            usedPercent: 19,
            windowMinutes: 300,
            resetAt: iso(1_800_018_000),
        });
        expect(normalized.weekly ?? null).toBeNull();
    });

    it('normalizes rate_limit primary and secondary windows from the current upstream payload shape', async () => {
        const { normalizeCodexUsageSnapshot } = await loadSubject();
        const normalized = normalizeCodexUsageSnapshot({
            slotIndex: 4,
            fetchedAt: new Date(NOW).toISOString(),
            payload: usagePayloadRateLimit(
                'acct-rate-limit-shape',
                usageWindowResetAt(FIVE_HOURS, 0, 1_800_018_000),
                usageWindowResetAt(SEVEN_DAYS, 100, 1_800_604_800),
            ),
        });

        expect(normalized.fiveHour).toMatchObject({
            usedPercent: 0,
            windowMinutes: 300,
            resetAt: iso(1_800_018_000),
        });
        expect(normalized.weekly).toMatchObject({
            usedPercent: 100,
            windowMinutes: 10_080,
            resetAt: iso(1_800_604_800),
        });
    });
});

describe('Codex usage service', () => {
    it('hashes account_id into accountKey and never leaks the raw account_id in returned or persisted shapes', async () => {
        const rawAccountId = 'acct-private-raw';
        const { service, deps } = await createService({
            listSlots: vi.fn(async () => [{ slotIndex: 0, accountId: rawAccountId }]),
            fetchUsage: vi.fn(async () => usagePayload(
                rawAccountId,
                usageWindow(FIVE_HOURS, 41, 1_800_018_000),
                usageWindow(SEVEN_DAYS, 63, 1_800_604_800),
            )),
        });
        const result = await service.getUsageSnapshot();
        const serialized = JSON.stringify({ result, writes: deps.writeSnapshots.mock.calls });

        expect(result.accounts[0]).toMatchObject({ accountKey: hashAccountKey(rawAccountId) });
        expect(serialized).toContain(hashAccountKey(rawAccountId));
        expect(serialized).not.toContain(rawAccountId);
    });

    it('returns 200 partial true when one slot succeeds and another times out', async () => {
        const { service } = await createService({
            listSlots: vi.fn(async () => [
                { slotIndex: 0, accountId: 'acct-live' },
                { slotIndex: 1, accountId: 'acct-timeout' },
            ]),
            fetchUsage: vi.fn(async ({ slotIndex }: { slotIndex: number }) => {
                if (slotIndex === 0) {
                    return usagePayload('acct-live', usageWindow(FIVE_HOURS, 15, 1_800_018_000));
                }
                throw new Error('codex usage timed out after 10000ms');
            }),
        });
        const result = await service.getUsageSnapshot();

        expect(result.status).toBe(200);
        expect(result.partial).toBe(true);
        expect(result.accounts).toEqual([
            expect.objectContaining({ accountKey: hashAccountKey('acct-live'), slotIndex: 0 }),
        ]);
        expect(result.slotErrors).toEqual([
            expect.objectContaining({ slotIndex: 1, message: expect.stringMatching(/timed out/i) }),
        ]);
    });

    it('merges duplicate slots for the same account into one account row with slotIndexes as secondary context', async () => {
        const { service } = await createService({
            listSlots: vi.fn(async () => [
                { slotIndex: 0, path: '/.codex/auth.json', accountId: 'acct-shared' },
                { slotIndex: 2, path: '/.codex/auth_milo.json', accountId: 'acct-shared' },
            ]),
            fetchUsage: vi.fn(async ({ slotIndex }: { slotIndex: number }) => usagePayload(
                'acct-shared',
                usageWindow(FIVE_HOURS, slotIndex === 0 ? 17 : 19, 1_800_018_000 + slotIndex),
                usageWindow(SEVEN_DAYS, slotIndex === 0 ? 57 : 59, 1_800_604_800 + slotIndex),
            )),
        });

        const result = await service.getUsageSnapshot();

        expect(result.status).toBe(200);
        expect(result.partial).toBe(false);
        expect(result.accounts).toEqual([
            expect.objectContaining({
                accountKey: hashAccountKey('acct-shared'),
                slotIndex: 0,
                slotIndexes: [0, 2],
                slotPaths: ['/.codex/auth.json', '/.codex/auth_milo.json'],
                fiveHour: expect.objectContaining({ usedPercent: 19 }),
                weekly: expect.objectContaining({ usedPercent: 59 }),
            }),
        ]);
    });

    it('times out a hanging slot and still returns partial when another slot succeeds', async () => {
        const { service } = await createService({
            timeoutMs: 5,
            listSlots: vi.fn(async () => [
                { slotIndex: 0, accountId: 'acct-fast' },
                { slotIndex: 1, accountId: 'acct-hang' },
            ]),
            fetchUsage: vi.fn(async ({ slotIndex }: { slotIndex: number }) => {
                if (slotIndex === 0) {
                    return usagePayload('acct-fast', usageWindow(FIVE_HOURS, 11, 1_800_018_000));
                }
                return await new Promise<never>(() => undefined);
            }),
        });

        const result = await Promise.race([
            service.getUsageSnapshot(),
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('service hung')), 100)),
        ]);

        expect(result.status).toBe(200);
        expect(result.partial).toBe(true);
        expect(result.accounts).toEqual([
            expect.objectContaining({ accountKey: hashAccountKey('acct-fast'), slotIndex: 0 }),
        ]);
        expect(result.slotErrors).toEqual([
            expect.objectContaining({ slotIndex: 1, message: expect.stringMatching(/timed out/i) }),
        ]);
    });

    it('returns a cache hit without re-fetching or writing a second snapshot', async () => {
        const { service, deps } = await createService();

        await service.getUsageSnapshot();
        deps.writeSnapshots.mockClear();
        const second = await service.getUsageSnapshot();

        expect(deps.fetchUsage).toHaveBeenCalledTimes(1);
        expect(deps.writeSnapshots).not.toHaveBeenCalled();
        expect(second.status).toBe(200);
    });

    it('retains payload-derived account identity for degraded fallback when slot metadata starts empty', async () => {
        let persisted: Array<{
            accountKey: string;
            slotIndex: number;
            window: 'fiveHour' | 'weekly';
            usedPercent: number;
            resetAt: string;
            windowMinutes: number;
            updatedAt: string;
        }> = [];
        const fetchUsage = vi.fn(async () => usagePayload(
            'acct-token-mode',
            usageWindow(FIVE_HOURS, 44, 1_800_018_000),
            usageWindow(SEVEN_DAYS, 66, 1_800_604_800),
        ));
        const { service } = await createService({
            cacheTtlMs: 0,
            listSlots: vi.fn(async () => [{ slotIndex: 0, path: null, accountId: null }]),
            fetchUsage,
            readLatestSnapshots: vi.fn(async () => persisted),
            writeSnapshots: vi.fn(async (records) => {
                persisted = records;
            }),
        });

        const first = await service.getUsageSnapshot();
        fetchUsage.mockImplementationOnce(async () => {
            throw new Error('network unavailable');
        });
        const second = await service.getUsageSnapshot();

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.partial).toBe(true);
        expect(second.accounts).toEqual([
            expect.objectContaining({
                accountKey: hashAccountKey('acct-token-mode'),
                source: expect.stringMatching(/cache|persisted/),
            }),
        ]);
    });

    it('skips the snapshot write when a fresh normalized fetch matches the latest persisted snapshot', async () => {
        const accountKey = hashAccountKey('acct-unchanged');
        const { service, deps } = await createService({
            listSlots: vi.fn(async () => [{ slotIndex: 0, accountId: 'acct-unchanged' }]),
            fetchUsage: vi.fn(async () => usagePayload(
                'acct-unchanged',
                usageWindow(FIVE_HOURS, 33, 1_800_018_000),
                usageWindow(SEVEN_DAYS, 55, 1_800_604_800),
            )),
            readLatestSnapshots: vi.fn(async () => [
                { accountKey, slotIndex: 0, window: 'fiveHour', usedPercent: 33, resetAt: iso(1_800_018_000), windowMinutes: 300 },
                { accountKey, slotIndex: 0, window: 'weekly', usedPercent: 55, resetAt: iso(1_800_604_800), windowMinutes: 10_080 },
            ]),
        });
        const result = await service.getUsageSnapshot();

        expect(result.status).toBe(200);
        expect(deps.fetchUsage).toHaveBeenCalledTimes(1);
        expect(deps.writeSnapshots).not.toHaveBeenCalled();
    });

    it('skips snapshot rewrites when duplicate slots for the same account produce an unchanged merged snapshot', async () => {
        let persisted: Array<{
            accountKey: string;
            slotIndex: number;
            window: 'fiveHour' | 'weekly';
            usedPercent: number;
            resetAt: string;
            windowMinutes: number;
            updatedAt: string;
        }> = [];
        const writeSnapshots = vi.fn(async (records: typeof persisted) => {
            const merged = new Map<string, (typeof persisted)[number]>();
            for (const record of [...persisted, ...records]) {
                merged.set(`${record.accountKey}:${record.window}`, record);
            }
            persisted = Array.from(merged.values());
        });
        const fetchUsage = vi.fn(async ({ slotIndex }: { slotIndex: number }) => usagePayload(
            'acct-shared-stable',
            usageWindow(FIVE_HOURS, slotIndex === 0 ? 31 : 34, 1_800_018_000 + slotIndex),
            usageWindow(SEVEN_DAYS, slotIndex === 0 ? 61 : 64, 1_800_604_800 + slotIndex),
        ));
        const { service } = await createService({
            cacheTtlMs: 0,
            listSlots: vi.fn(async () => [
                { slotIndex: 0, accountId: 'acct-shared-stable' },
                { slotIndex: 2, accountId: 'acct-shared-stable' },
            ]),
            fetchUsage,
            readLatestSnapshots: vi.fn(async () => persisted),
            writeSnapshots,
        });

        const first = await service.getUsageSnapshot();
        writeSnapshots.mockClear();
        const second = await service.getUsageSnapshot();

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(writeSnapshots).not.toHaveBeenCalled();
    });

    it('uses cooldown-only fallback without inventing usedPercent for fiveHour or weekly', async () => {
        const cooldownUntil = '2026-05-03T12:00:00.000Z';
        const { service, deps } = await createService({
            listSlots: vi.fn(async () => [{ slotIndex: 4, accountId: 'acct-cooldown' }]),
            fetchUsage: vi.fn(async () => {
                throw new Error('all live usage fetches timed out');
            }),
            getCooldownState: vi.fn(() => [
                { slotIndex: 4, accountId: 'acct-cooldown', cooldownUntil },
            ]),
        });
        const result = await service.getUsageSnapshot();
        const account = result.accounts[0];

        expect(result.status).toBe(200);
        expect(result.partial).toBe(true);
        expect(account).toMatchObject({
            accountKey: hashAccountKey('acct-cooldown'),
            slotIndex: 4,
            cooldownUntil,
        });
        expect(account.fiveHour ?? null).toBeNull();
        expect(account.weekly ?? null).toBeNull();
        expect(JSON.stringify(account)).not.toContain('usedPercent');
        expect(deps.writeSnapshots).not.toHaveBeenCalled();
    });

    it('does not reuse slot-index persisted fallback when account identity is unknown', async () => {
        const { service } = await createService({
            listSlots: vi.fn(async () => [{ slotIndex: 3, accountId: null }]),
            fetchUsage: vi.fn(async () => {
                throw new Error('slot failed before account identity was known');
            }),
            readLatestSnapshots: vi.fn(async () => [
                {
                    accountKey: hashAccountKey('acct-stale-other'),
                    slotIndex: 3,
                    window: 'fiveHour',
                    usedPercent: 88,
                    resetAt: iso(1_800_018_000),
                    windowMinutes: 300,
                    updatedAt: new Date(NOW - 60_000).toISOString(),
                },
            ]),
        });

        const result = await service.getUsageSnapshot();

        expect(result.status).toBe(502);
        expect(result.partial).toBe(false);
        expect(result.accounts).toEqual([]);
        expect(result.slotErrors).toEqual([
            expect.objectContaining({ slotIndex: 3, source: 'none' }),
        ]);
    });
});

describe('Codex selector snapshot input', () => {
    it('returns fresh cached live rows for selector input without refetching when session context is absent', async () => {
        const { service, deps } = await createService();
        const accountKey = hashAccountKey('acct-default');

        await service.getUsageSnapshot();
        deps.fetchUsage.mockClear();
        const snapshot = await getSelectorSnapshot(service, {
            slots: [{ slotIndex: 0, slotPath: null, accountKey, rateLimitedUntil: 0 }],
        });

        expect(deps.fetchUsage).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({
            accounts: [
                expect.objectContaining({
                    accountKey,
                    source: 'cache',
                    stale: false,
                }),
            ],
            unknownAccountSlotIndexes: [],
            missingUsageSlotIndexes: [],
            staleAccountKeys: [],
            triggeredBackgroundRefresh: false,
        });
    });

    it('treats fresh persisted rows as selector-eligible when local slot identity is known', async () => {
        const accountKey = hashAccountKey('acct-selector-persisted');
        const { service, deps } = await createService({
            fetchUsage: vi.fn(async () => {
                throw new Error('selector path should not fetch live usage');
            }),
            readLatestSnapshots: vi.fn(async () => [
                {
                    accountKey,
                    slotIndex: 2,
                    window: 'fiveHour',
                    usedPercent: 22,
                    resetAt: iso(1_800_018_000),
                    windowMinutes: 300,
                    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
                },
                {
                    accountKey,
                    slotIndex: 2,
                    window: 'weekly',
                    usedPercent: 44,
                    resetAt: iso(1_800_604_800),
                    windowMinutes: 10_080,
                    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
                },
            ]),
        });

        const snapshot = await getSelectorSnapshot(service, {
            slots: [{ slotIndex: 2, slotPath: '/profiles/work/auth.json', accountKey, rateLimitedUntil: 0 }],
            persistedMaxAgeMs: 15 * 60_000,
        });

        expect(deps.fetchUsage).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({
            accounts: [
                expect.objectContaining({
                    accountKey,
                    source: 'persisted',
                    stale: false,
                    slotIndexes: [2],
                }),
            ],
            unknownAccountSlotIndexes: [],
            missingUsageSlotIndexes: [],
            staleAccountKeys: [],
            triggeredBackgroundRefresh: false,
        });
    });

    it('falls back when persisted selector snapshots are older than the freshness threshold', async () => {
        const accountKey = hashAccountKey('acct-selector-stale');
        const { service, deps } = await createService({
            fetchUsage: vi.fn(async () => {
                throw new Error('selector path should not fetch live usage');
            }),
            readLatestSnapshots: vi.fn(async () => [
                {
                    accountKey,
                    slotIndex: 5,
                    window: 'fiveHour',
                    usedPercent: 61,
                    resetAt: iso(1_800_018_000),
                    windowMinutes: 300,
                    updatedAt: new Date(NOW - 16 * 60_000).toISOString(),
                },
            ]),
        });

        const snapshot = await getSelectorSnapshot(service, {
            slots: [{ slotIndex: 5, slotPath: '/profiles/stale/auth.json', accountKey, rateLimitedUntil: 0 }],
            persistedMaxAgeMs: 15 * 60_000,
        });

        expect(snapshot).toMatchObject({
            accounts: [],
            unknownAccountSlotIndexes: [],
            missingUsageSlotIndexes: [],
            staleAccountKeys: [accountKey],
            triggeredBackgroundRefresh: true,
        });
    });

    it('falls back when the current slot identity is unknown instead of guessing from persisted slot_index', async () => {
        const accountKey = hashAccountKey('acct-selector-unknown');
        const { service, deps } = await createService({
            fetchUsage: vi.fn(async () => {
                throw new Error('selector path should not fetch live usage');
            }),
            readLatestSnapshots: vi.fn(async () => [
                {
                    accountKey,
                    slotIndex: 3,
                    window: 'fiveHour',
                    usedPercent: 18,
                    resetAt: iso(1_800_018_000),
                    windowMinutes: 300,
                    updatedAt: new Date(NOW - 60_000).toISOString(),
                },
            ]),
        });

        const snapshot = await getSelectorSnapshot(service, {
            slots: [{ slotIndex: 3, slotPath: '/profiles/unknown/auth.json', accountKey: null, rateLimitedUntil: 0 }],
            persistedMaxAgeMs: 15 * 60_000,
        });

        expect(deps.fetchUsage).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({
            accounts: [],
            unknownAccountSlotIndexes: [3],
            missingUsageSlotIndexes: [],
            staleAccountKeys: [],
            triggeredBackgroundRefresh: false,
        });
    });
});
