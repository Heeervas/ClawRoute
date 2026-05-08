import { createHash } from 'node:crypto';
import { CodexAuth, CodexAuthSlotSnapshot, getCodexAuthSlots, loadCodexUsageAuthSlot } from './codex-transport.js';
import { getProxyAgent } from './http-proxy.js';
import { getCodexUsageSnapshots, upsertCodexUsageSnapshots } from './logger.js';
import {
    CodexUsageAccountRow,
    CodexUsageRawResponse,
    CodexUsageSelectorRequest,
    CodexUsageSelectorSnapshot,
    CodexUsageSnapshotRecord,
    CodexUsageSlotError,
    CodexUsageWindowSnapshot,
} from './types.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_SELECTOR_PERSISTED_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_SELECTOR_REFRESH_THROTTLE_MS = 60_000;

type ServiceSlot = {
    slotIndex: number;
    path?: string | null;
    accountId: string | null;
    rateLimitedUntil?: number;
    auth?: CodexAuth | null;
};
type CooldownState = { slotIndex: number; accountId: string; cooldownUntil: string };
type SnapshotResult = {
    status: number;
    partial: boolean;
    accounts: CodexUsageAccountRow[];
    slotErrors: CodexUsageSlotError[];
    error?: { message: string };
};
type ServiceDeps = {
    now?: () => number;
    cacheTtlMs?: number;
    timeoutMs?: number;
    listSlots?: () => Promise<ServiceSlot[]> | ServiceSlot[];
    fetchUsage?: (slot: ServiceSlot) => Promise<CodexUsageRawResponse>;
    readLatestSnapshots?: () => Promise<CodexUsageSnapshotRecord[]> | CodexUsageSnapshotRecord[];
    writeSnapshots?: (records: CodexUsageSnapshotRecord[]) => Promise<void> | void;
    getCooldownState?: () => Promise<CooldownState[]> | CooldownState[];
};
type CachedAccount = { expiresAt: number; account: CodexUsageAccountRow };
type SlotBinding = { slotIndex: number; slotPath?: string | null };

function cleanSlotPaths(paths: Array<string | null | undefined>): string[] {
    return Array.from(new Set(paths.filter((path): path is string => Boolean(path && path.trim()))));
}

function getUsageWindows(payload: CodexUsageRawResponse): [CodexUsageRawResponse['primary_window'], CodexUsageRawResponse['secondary_window']] {
    return [
        payload.primary_window ?? payload.rate_limit?.primary_window,
        payload.secondary_window ?? payload.rate_limit?.secondary_window,
    ];
}

function hashAccountKey(accountId: string): string {
    return createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

function toWindowSnapshot(window: CodexUsageRawResponse['primary_window'], fetchedAt: string): CodexUsageWindowSnapshot | null {
    const resetAtEpoch = window?.resets_at ?? window?.reset_at;
    if (!window || typeof window.used_percent !== 'number' || typeof resetAtEpoch !== 'number') return null;
    if (window.limit_window_seconds !== FIVE_HOURS && window.limit_window_seconds !== SEVEN_DAYS) return null;
    return {
        window: window.limit_window_seconds === FIVE_HOURS ? 'fiveHour' : 'weekly',
        usedPercent: window.used_percent,
        resetAt: new Date(resetAtEpoch * 1000).toISOString(),
        windowMinutes: Math.round(window.limit_window_seconds / 60),
        updatedAt: fetchedAt,
    };
}

export function normalizeCodexUsageSnapshot(input: {
    slotIndex: number;
    slotPath?: string | null;
    fetchedAt: string;
    payload: CodexUsageRawResponse;
    accountId?: string | null;
}): CodexUsageAccountRow {
    const accountId = input.payload.account_id ?? input.accountId;
    if (!accountId) throw new Error('Codex usage payload missing account_id');

    const account: CodexUsageAccountRow = {
        accountKey: hashAccountKey(accountId),
        slotIndex: input.slotIndex,
        slotIndexes: [input.slotIndex],
        slotPaths: cleanSlotPaths([input.slotPath]),
        source: 'live',
        stale: false,
        cooldownUntil: null,
        lastFetchedAt: input.fetchedAt,
        updatedAt: input.fetchedAt,
        fiveHour: null,
        weekly: null,
    };

    for (const window of getUsageWindows(input.payload).map((usageWindow) => toWindowSnapshot(usageWindow, input.fetchedAt))) {
        if (!window) continue;
        if (window.window === 'fiveHour') account.fiveHour = window;
        if (window.window === 'weekly') account.weekly = window;
    }

    return account;
}

export const normalizeCodexUsageRow = (payload: CodexUsageRawResponse, options: {
    slotIndex: number;
    slotPath?: string | null;
    fetchedAt: string;
    accountId?: string | null;
}) => normalizeCodexUsageSnapshot({ ...options, payload });

function snapshotKey(accountKey: string, window: string): string {
    return `${accountKey}:${window}`;
}

function toSnapshotRecords(account: CodexUsageAccountRow): CodexUsageSnapshotRecord[] {
    return [account.fiveHour, account.weekly]
        .filter((window): window is CodexUsageWindowSnapshot => Boolean(window))
        .map((window) => ({
            accountKey: account.accountKey,
            slotIndex: account.slotIndex,
            window: window.window,
            usedPercent: window.usedPercent,
            resetAt: window.resetAt,
            windowMinutes: window.windowMinutes,
            updatedAt: window.updatedAt,
        }));
}

function snapshotChanged(live: CodexUsageSnapshotRecord, persisted?: CodexUsageSnapshotRecord): boolean {
    return !persisted
        || live.slotIndex !== persisted.slotIndex
        || live.usedPercent !== persisted.usedPercent
        || live.resetAt !== persisted.resetAt
        || live.windowMinutes !== persisted.windowMinutes;
}

function accountFromSnapshots(records: CodexUsageSnapshotRecord[], slotIndex: number, slotPath?: string | null): CodexUsageAccountRow | null {
    if (records.length === 0) return null;
    const account: CodexUsageAccountRow = {
        accountKey: records[0]!.accountKey,
        slotIndex,
        slotIndexes: [slotIndex],
        slotPaths: cleanSlotPaths([slotPath]),
        source: 'persisted',
        stale: true,
        cooldownUntil: null,
        lastFetchedAt: null,
        updatedAt: records[0]!.updatedAt ?? null,
        fiveHour: null,
        weekly: null,
    };

    for (const record of records) {
        const window = {
            window: record.window,
            usedPercent: record.usedPercent,
            resetAt: record.resetAt,
            windowMinutes: record.windowMinutes,
            updatedAt: record.updatedAt ?? '',
        };
        if (record.window === 'fiveHour') account.fiveHour = window;
        if (record.window === 'weekly') account.weekly = window;
    }

    return account;
}

function bindAccountToSlot(
    account: CodexUsageAccountRow,
    slot: SlotBinding,
    overrides: Partial<Pick<CodexUsageAccountRow, 'source' | 'stale' | 'cooldownUntil'>> = {},
): CodexUsageAccountRow {
    const slotIndexes = Array.from(new Set([...account.slotIndexes, slot.slotIndex])).sort((left, right) => left - right);
    return {
        ...account,
        ...overrides,
        slotIndex: slotIndexes[0] ?? slot.slotIndex,
        slotIndexes,
        slotPaths: cleanSlotPaths([...account.slotPaths, slot.slotPath]),
    };
}

function isSelectorPersistedStale(account: CodexUsageAccountRow, now: number, maxAgeMs: number): boolean {
    if (account.source !== 'persisted' || !account.updatedAt) return false;
    return (now - Date.parse(account.updatedAt)) > maxAgeMs;
}

function createSelectorCooldownAccount(
    accountKey: string,
    slotIndex: number,
    slotPath: string | null,
    cooldownUntil: number,
): CodexUsageAccountRow {
    return {
        accountKey,
        slotIndex,
        slotIndexes: [slotIndex],
        slotPaths: cleanSlotPaths([slotPath]),
        source: 'cooldown',
        stale: true,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
        lastFetchedAt: null,
        updatedAt: null,
        fiveHour: null,
        weekly: null,
    };
}

const sourceRank: Record<CodexUsageAccountRow['source'], number> = {
    live: 0,
    cache: 1,
    persisted: 2,
    cooldown: 3,
};

function laterIso(...values: Array<string | null | undefined>): string | null {
    let latest: string | null = null;
    for (const value of values) {
        if (!value) continue;
        if (!latest || Date.parse(value) >= Date.parse(latest)) latest = value;
    }
    return latest;
}

function newerWindow(
    candidate: CodexUsageWindowSnapshot | null,
    current: CodexUsageWindowSnapshot | null,
): CodexUsageWindowSnapshot | null {
    if (!candidate) return current;
    if (!current) return candidate;
    return Date.parse(candidate.updatedAt || '') >= Date.parse(current.updatedAt || '') ? candidate : current;
}

function preferredSource(candidate: CodexUsageAccountRow, current: CodexUsageAccountRow): boolean {
    const candidateRank = sourceRank[candidate.source] ?? 9;
    const currentRank = sourceRank[current.source] ?? 9;
    return candidateRank < currentRank
        || (candidateRank === currentRank && Number(candidate.stale) < Number(current.stale));
}

function mergeAccountRows(rows: CodexUsageAccountRow[]): CodexUsageAccountRow[] {
    const grouped = new Map<string, CodexUsageAccountRow>();

    for (const row of rows) {
        const rowSlotIndexes = row.slotIndexes.length ? row.slotIndexes : [row.slotIndex];
        const current = grouped.get(row.accountKey);

        if (!current) {
            grouped.set(row.accountKey, {
                ...row,
                slotIndex: Math.min(...rowSlotIndexes),
                slotIndexes: [...rowSlotIndexes].sort((left, right) => left - right),
            });
            continue;
        }

        const slotIndexes = Array.from(new Set([...current.slotIndexes, ...rowSlotIndexes])).sort((left, right) => left - right);
        current.slotIndexes = slotIndexes;
        current.slotIndex = slotIndexes[0] ?? current.slotIndex;
        current.slotPaths = cleanSlotPaths([...current.slotPaths, ...row.slotPaths]);
        current.fiveHour = newerWindow(row.fiveHour, current.fiveHour);
        current.weekly = newerWindow(row.weekly, current.weekly);
        current.lastFetchedAt = laterIso(current.lastFetchedAt, row.lastFetchedAt);
        current.updatedAt = laterIso(current.updatedAt, row.updatedAt);
        current.cooldownUntil = laterIso(current.cooldownUntil, row.cooldownUntil);
        current.stale = current.stale && row.stale;
        if (preferredSource(row, current)) current.source = row.source;
    }

    return Array.from(grouped.values()).sort((left, right) => left.slotIndex - right.slotIndex);
}

async function defaultListSlots(): Promise<ServiceSlot[]> {
    return getCodexAuthSlots().map((slot) => ({
        slotIndex: slot.slotIndex,
        path: slot.path,
        accountId: null,
        rateLimitedUntil: slot.rateLimitedUntil,
        auth: null,
    }));
}

async function defaultFetchUsage(slot: ServiceSlot, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CodexUsageRawResponse> {
    const dispatcher = getProxyAgent();
    const auth = slot.auth ?? await loadCodexUsageAuthSlot({
        slotIndex: slot.slotIndex,
        path: slot.path ?? null,
        rateLimitedUntil: slot.rateLimitedUntil ?? 0,
    } as CodexAuthSlotSnapshot, dispatcher, timeoutMs);
    if (!auth) throw new Error('Codex auth missing');

    slot.auth = auth;
    slot.accountId = auth.accountId || slot.accountId || null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
        },
        signal: controller.signal,
    };
    if (dispatcher) fetchOptions.dispatcher = dispatcher;

    try {
        const response = await fetch(USAGE_URL, fetchOptions as RequestInit);
        if (!response.ok) throw new Error(`Codex usage HTTP ${response.status}`);
        return await response.json() as CodexUsageRawResponse;
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error(`codex usage timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) return promise;

    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise
            .then((value) => resolve(value))
            .catch((error) => reject(error))
            .finally(() => clearTimeout(timeoutId));
    });
}

function defaultCooldownState(slots: ServiceSlot[]): CooldownState[] {
    return slots
        .filter((slot) => slot.accountId && (slot.rateLimitedUntil ?? 0) > Date.now())
        .map((slot) => ({
            slotIndex: slot.slotIndex,
            accountId: slot.accountId!,
            cooldownUntil: new Date(slot.rateLimitedUntil!).toISOString(),
        }));
}

export function createCodexUsageService(deps: ServiceDeps = {}) {
    let responseCache: { expiresAt: number; signature: string; result: SnapshotResult } | null = null;
    const slotCache = new Map<string, CachedAccount>();
    const tokenSlotIdentityCache = new Map<number, string>();
    let selectorRefreshStartedAt = 0;
    let selectorRefreshPromise: Promise<void> | null = null;

    async function getUsageSnapshot(): Promise<SnapshotResult> {
        const now = deps.now?.() ?? Date.now();
        const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const slots = await Promise.resolve((deps.listSlots ?? defaultListSlots)());
        const signature = JSON.stringify(slots.map((slot) => [slot.slotIndex, slot.path ?? null, slot.accountId, slot.rateLimitedUntil ?? 0]));
        if (responseCache && responseCache.signature === signature && responseCache.expiresAt > now) {
            return responseCache.result;
        }

        const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        const persisted = await Promise.resolve((deps.readLatestSnapshots ?? getCodexUsageSnapshots)());
        const persistedByKey = new Map(persisted.map((record) => [snapshotKey(record.accountKey, record.window), record]));
        const persistedByAccountKey = new Map<string, CodexUsageSnapshotRecord[]>();
        for (const record of persisted) {
            persistedByAccountKey.set(record.accountKey, [...(persistedByAccountKey.get(record.accountKey) ?? []), record]);
        }

        const fetchUsage = deps.fetchUsage ?? ((slot: ServiceSlot) => defaultFetchUsage(slot, timeoutMs));
        const settled = await Promise.allSettled(slots.map(async (slot) => {
            const fetchedAt = new Date(now).toISOString();
            const payload = await withTimeout(
                Promise.resolve(fetchUsage(slot)),
                timeoutMs,
                `codex usage timed out after ${timeoutMs}ms`,
            );
            slot.accountId = payload.account_id || slot.accountId || null;

            return normalizeCodexUsageSnapshot({
                slotIndex: slot.slotIndex,
                slotPath: slot.path,
                fetchedAt,
                payload,
                accountId: slot.accountId,
            });
        }));
        const cooldownMap = new Map((await Promise.resolve((deps.getCooldownState ?? (() => defaultCooldownState(slots)))())).map((item) => [item.slotIndex, item]));

        const accounts: CodexUsageAccountRow[] = [];
        const liveAccounts: CodexUsageAccountRow[] = [];
        const slotErrors: CodexUsageSlotError[] = [];

        for (const [index, result] of settled.entries()) {
            const slot = slots[index]!;
            if (result.status === 'fulfilled') {
                const account = result.value;
                accounts.push(account);
                liveAccounts.push(account);
                slotCache.set(account.accountKey, { account, expiresAt: now + cacheTtlMs });
                if (slot.path === null) tokenSlotIdentityCache.set(slot.slotIndex, account.accountKey);
                continue;
            }

            const accountKey = slot.accountId
                ? hashAccountKey(slot.accountId)
                : slot.path === null
                    ? tokenSlotIdentityCache.get(slot.slotIndex) ?? null
                    : null;
            const cached = accountKey ? slotCache.get(accountKey) : null;
            const fallbackFromIdentity: CodexUsageAccountRow | null = cached && cached.expiresAt > now
                ? {
                    ...cached.account,
                    slotIndex: Math.min(...new Set([...(cached.account.slotIndexes ?? [cached.account.slotIndex]), slot.slotIndex])),
                    slotIndexes: Array.from(new Set([...(cached.account.slotIndexes ?? [cached.account.slotIndex]), slot.slotIndex])).sort((left, right) => left - right),
                    slotPaths: cleanSlotPaths([...(cached.account.slotPaths ?? []), slot.path]),
                    source: 'cache',
                    stale: false,
                }
                : accountKey
                    ? accountFromSnapshots(persistedByAccountKey.get(accountKey) ?? [], slot.slotIndex, slot.path)
                    : null;
            const fallback: CodexUsageAccountRow | null = fallbackFromIdentity ?? (() => {
                    const cooldown = cooldownMap.get(slot.slotIndex);
                    if (!cooldown) return null;
                    return {
                        accountKey: hashAccountKey(cooldown.accountId),
                        slotIndex: slot.slotIndex,
                        slotIndexes: [slot.slotIndex],
                        slotPaths: cleanSlotPaths([slot.path]),
                        source: 'cooldown',
                        stale: true,
                        cooldownUntil: cooldown.cooldownUntil,
                        lastFetchedAt: null,
                        updatedAt: null,
                        fiveHour: null,
                        weekly: null,
                    } satisfies CodexUsageAccountRow;
                })();

            slotErrors.push({
                slotIndex: slot.slotIndex,
                message: result.reason instanceof Error ? result.reason.message : String(result.reason),
                source: fallback?.source ?? 'none',
            });
            if (fallback) accounts.push(fallback);
        }

        const changed = mergeAccountRows(liveAccounts)
            .flatMap((account) => toSnapshotRecords(account))
            .filter((record) => snapshotChanged(record, persistedByKey.get(snapshotKey(record.accountKey, record.window))));

        if (changed.length > 0) {
            await Promise.resolve((deps.writeSnapshots ?? upsertCodexUsageSnapshots)(changed));
        }

        if (accounts.length === 0) {
            return {
                status: 502,
                partial: false,
                accounts: [],
                slotErrors,
                error: { message: 'No Codex usage data available' },
            };
        }

        const result: SnapshotResult = {
            status: 200,
            partial: slotErrors.length > 0,
            accounts: mergeAccountRows(accounts),
            slotErrors,
        };
        responseCache = { expiresAt: now + cacheTtlMs, signature, result };
        return result;
    }

    function triggerSelectorRefresh(now: number, refreshThrottleMs: number): boolean {
        if (selectorRefreshPromise || (now - selectorRefreshStartedAt) < refreshThrottleMs) return false;
        selectorRefreshStartedAt = now;
        selectorRefreshPromise = Promise.resolve(getUsageSnapshot())
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
                selectorRefreshPromise = null;
            });
        return true;
    }

    async function getSelectorSnapshot(input: CodexUsageSelectorRequest): Promise<CodexUsageSelectorSnapshot> {
        const now = deps.now?.() ?? Date.now();
        const persisted = await Promise.resolve((deps.readLatestSnapshots ?? getCodexUsageSnapshots)());
        const persistedByAccountKey = new Map<string, CodexUsageSnapshotRecord[]>();
        const persistedMaxAgeMs = input.persistedMaxAgeMs ?? DEFAULT_SELECTOR_PERSISTED_MAX_AGE_MS;
        const refreshThrottleMs = input.refreshThrottleMs ?? DEFAULT_SELECTOR_REFRESH_THROTTLE_MS;

        for (const record of persisted) {
            persistedByAccountKey.set(record.accountKey, [...(persistedByAccountKey.get(record.accountKey) ?? []), record]);
        }

        const accounts: CodexUsageAccountRow[] = [];
        const unknownAccountSlotIndexes: number[] = [];
        const missingUsageSlotIndexes: number[] = [];
        const staleAccountKeys = new Set<string>();

        for (const slot of input.slots) {
            if (!slot.accountKey) {
                unknownAccountSlotIndexes.push(slot.slotIndex);
                continue;
            }

            const cached = slotCache.get(slot.accountKey);
            if (cached && cached.expiresAt > now) {
                accounts.push(bindAccountToSlot(cached.account, { slotIndex: slot.slotIndex, slotPath: slot.slotPath }, {
                    source: 'cache',
                    stale: false,
                }));
                continue;
            }

            const persistedAccount = accountFromSnapshots(persistedByAccountKey.get(slot.accountKey) ?? [], slot.slotIndex, slot.slotPath);
            if (persistedAccount) {
                if (isSelectorPersistedStale(persistedAccount, now, persistedMaxAgeMs)) {
                    staleAccountKeys.add(slot.accountKey);
                    continue;
                }
                accounts.push({
                    ...persistedAccount,
                    stale: false,
                });
                continue;
            }

            if (slot.rateLimitedUntil > now) {
                accounts.push(createSelectorCooldownAccount(slot.accountKey, slot.slotIndex, slot.slotPath, slot.rateLimitedUntil));
                continue;
            }

            missingUsageSlotIndexes.push(slot.slotIndex);
        }

        const triggeredBackgroundRefresh = (staleAccountKeys.size > 0 || missingUsageSlotIndexes.length > 0)
            ? triggerSelectorRefresh(now, refreshThrottleMs)
            : false;

        return {
            slots: input.slots.map((slot) => ({ ...slot })),
            accounts: mergeAccountRows(accounts),
            unknownAccountSlotIndexes,
            missingUsageSlotIndexes,
            staleAccountKeys: [...staleAccountKeys].sort(),
            triggeredBackgroundRefresh,
        };
    }

    function reset(): void {
        responseCache = null;
        slotCache.clear();
        tokenSlotIdentityCache.clear();
        selectorRefreshStartedAt = 0;
        selectorRefreshPromise = null;
    }

    return { getUsageSnapshot, getSelectorSnapshot, reset };
}

const defaultService = createCodexUsageService();

export async function getCodexUsage(): Promise<{ status: number; body: Omit<SnapshotResult, 'status'> }> {
    const result = await defaultService.getUsageSnapshot();
    const { status, ...body } = result;
    return { status, body };
}

export async function getCodexUsageSelectorSnapshot(input: CodexUsageSelectorRequest): Promise<CodexUsageSelectorSnapshot> {
    return defaultService.getSelectorSnapshot(input);
}

export function resetCodexUsageState(): void {
    defaultService.reset();
}