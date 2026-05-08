import {
    CodexBalanceLoaderAccountScore,
    CodexBalanceLoaderAffinityStatus,
    CodexBalanceLoaderRequest,
    CodexBalanceLoaderResult,
    CodexUsageAccountRow,
    CodexUsageSelectorSlotIdentity,
} from './types.js';

const DEFAULT_PERSISTED_MAX_AGE_MS = 15 * 60_000;
const FIVE_HOUR_MS = 18_000_000;
const AFFINITY_SCORE_BAND = 0.05;
const AFFINITY_BOTTLENECK_FLOOR = 0.20;
const AFFINITY_SINGLE_WINDOW_FLOOR = 0.25;

type ScoredAccount = CodexBalanceLoaderAccountScore & { slotCandidates: CodexUsageSelectorSlotIdentity[] };
type LegacyBalanceLoaderSlot = {
    slotIndex: number;
    accountKey: string;
    pendingLeases?: number;
    lastSelectedAt?: string | null;
    rateLimitedUntil?: number;
};
type LegacyBalanceLoaderRequest = {
    now: number;
    provider: CodexBalanceLoaderRequest['provider'];
    accounts: CodexUsageAccountRow[];
    slots: LegacyBalanceLoaderSlot[];
    excludedSlotIndexes?: ReadonlySet<number> | readonly number[];
    excludedAccountKeys?: ReadonlySet<string> | readonly string[];
    sessionAffinity?: {
        sessionId: string | null;
        cacheEligible: boolean;
        preferredProvider: CodexBalanceLoaderRequest['provider'];
        preferredAccountKey: string;
    } | null;
};

function toSet<T>(input?: ReadonlySet<T> | readonly T[]): Set<T> {
    return input instanceof Set ? new Set(input) : new Set(input ?? []);
}

function clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function getResidual(usedPercent?: number | null): number | null {
    return typeof usedPercent === 'number' ? clamp(1 - (usedPercent / 100)) : null;
}

function isPersistedStale(account: CodexUsageAccountRow, now: number, maxAgeMs: number): boolean {
    if (account.source !== 'persisted' || !account.updatedAt) return false;
    return (now - Date.parse(account.updatedAt)) > maxAgeMs;
}

function isExcluded(
    slot: CodexUsageSelectorSlotIdentity,
    excludedSlots: Set<number>,
    excludedAccounts: Set<string>,
): boolean {
    return excludedSlots.has(slot.slotIndex) || (slot.accountKey ? excludedAccounts.has(slot.accountKey) : false);
}

function groupEligibleSlots(
    slots: CodexUsageSelectorSlotIdentity[],
    now: number,
    excludedSlots: Set<number>,
    excludedAccounts: Set<string>,
): Map<string, CodexUsageSelectorSlotIdentity[]> {
    const grouped = new Map<string, CodexUsageSelectorSlotIdentity[]>();
    for (const slot of slots) {
        if (!slot.accountKey || slot.rateLimitedUntil > now || isExcluded(slot, excludedSlots, excludedAccounts)) continue;
        grouped.set(slot.accountKey, [...(grouped.get(slot.accountKey) ?? []), slot]);
    }
    return grouped;
}

function getRelevantSlotIndexes(
    slots: CodexUsageSelectorSlotIdentity[],
    now: number,
    excludedSlots: Set<number>,
    excludedAccounts: Set<string>,
): number[] {
    return slots
        .filter((slot) => !isExcluded(slot, excludedSlots, excludedAccounts) && slot.rateLimitedUntil <= now)
        .map((slot) => slot.slotIndex);
}

function hasRelevantUnknownAccount(
    slots: CodexUsageSelectorSlotIdentity[],
    now: number,
    excludedSlots: Set<number>,
    excludedAccounts: Set<string>,
): boolean {
    return slots.some((slot) => !slot.accountKey && !isExcluded(slot, excludedSlots, excludedAccounts) && slot.rateLimitedUntil <= now);
}

function getScore(account: CodexUsageAccountRow, pendingLeases: number, now: number): number | null {
    const r5 = getResidual(account.fiveHour?.usedPercent);
    const rw = getResidual(account.weekly?.usedPercent);
    const penalty = account.source === 'persisted' ? 0.10 : 0;
    if (r5 === null && rw === null) return null;
    if (r5 !== null && rw !== null) {
        const resetAt = Date.parse(account.fiveHour?.resetAt ?? '');
        const t5 = clamp(Number.isFinite(resetAt) ? ((resetAt - now) / FIVE_HOUR_MS) : 1);
        const harmony = (2 * r5 * rw) / (r5 + rw + 0.01);
        return (0.65 * Math.min(r5, rw)) + (0.25 * harmony) + (0.10 * r5 * (1 - t5)) - (0.15 * pendingLeases) - penalty;
    }
    if (r5 !== null) return (0.70 * r5) - (0.15 * pendingLeases) - penalty;
    return (0.55 * rw!) - (0.15 * pendingLeases) - penalty;
}

function scoreAccounts(
    request: CodexBalanceLoaderRequest,
    eligibleSlots: Map<string, CodexUsageSelectorSlotIdentity[]>,
): ScoredAccount[] {
    const maxAgeMs = request.persistedMaxAgeMs ?? DEFAULT_PERSISTED_MAX_AGE_MS;
    const scores: ScoredAccount[] = [];

    for (const account of request.snapshot.accounts) {
        const slotCandidates = eligibleSlots.get(account.accountKey);
        if (!slotCandidates || isPersistedStale(account, request.now, maxAgeMs)) continue;
        const pendingLeases = request.pendingLeasesByAccountKey?.[account.accountKey] ?? 0;
        const baseScore = getScore(account, pendingLeases, request.now);
        if (account.source === 'cooldown' || baseScore === null) continue;
        scores.push({
            accountKey: account.accountKey,
            slotIndexes: slotCandidates.map((slot) => slot.slotIndex).sort((left, right) => left - right),
            baseScore,
            source: account.source,
            pendingLeases,
            bottleneckResidual: Math.min(getResidual(account.fiveHour?.usedPercent) ?? 1, getResidual(account.weekly?.usedPercent) ?? 1),
            fiveHourResidual: getResidual(account.fiveHour?.usedPercent),
            weeklyResidual: getResidual(account.weekly?.usedPercent),
            slotCandidates,
        });
    }

    return scores.sort((left, right) => right.baseScore - left.baseScore || left.slotIndexes[0]! - right.slotIndexes[0]!);
}

function hasHealthyAffinityCandidate(score: ScoredAccount): boolean {
    const residuals = [score.fiveHourResidual, score.weeklyResidual].filter((value): value is number => value !== null);
    if (residuals.length === 0) return false;
    if (residuals.length === 1) return (residuals[0] ?? 0) >= AFFINITY_SINGLE_WINDOW_FLOOR;
    return (score.bottleneckResidual ?? 0) >= AFFINITY_BOTTLENECK_FLOOR;
}

function chooseAffinityAccount(
    scores: ScoredAccount[],
    request: CodexBalanceLoaderRequest,
): { status: CodexBalanceLoaderAffinityStatus; winner: ScoredAccount } {
    const winner = scores[0]!;
    const affinity = request.affinity;
    if (!affinity?.sessionId || !affinity.preferred) return { status: 'not_requested', winner };
    if (!affinity.cacheEligible) return { status: 'cache_hint_missing', winner };
    if (affinity.preferred.provider !== request.provider) return { status: 'provider_mismatch', winner };
    if (winner.accountKey === affinity.preferred.accountKey) return { status: 'best_score', winner };

    const preferred = scores.find((score) => score.accountKey === affinity.preferred!.accountKey);
    if (!preferred) {
        const seen = request.snapshot.accounts.some((account) => account.accountKey === affinity.preferred!.accountKey);
        return { status: seen ? 'preferred_ineligible' : 'preferred_missing', winner };
    }
    if (!hasHealthyAffinityCandidate(preferred)) return { status: 'preferred_low_headroom', winner };
    if ((winner.baseScore - preferred.baseScore) > AFFINITY_SCORE_BAND) return { status: 'score_gap', winner };
    return { status: 'applied', winner: preferred };
}

function chooseSlot(
    slots: CodexUsageSelectorSlotIdentity[],
    slotPendingLeasesByIndex?: Readonly<Record<number, number>>,
    slotLastSelectedAtByIndex?: Readonly<Record<number, number>>,
): number {
    return [...slots]
        .sort((left, right) => {
            const leftPending = slotPendingLeasesByIndex?.[left.slotIndex] ?? 0;
            const rightPending = slotPendingLeasesByIndex?.[right.slotIndex] ?? 0;
            if (leftPending !== rightPending) return leftPending - rightPending;
            const leftSelectedAt = slotLastSelectedAtByIndex?.[left.slotIndex] ?? 0;
            const rightSelectedAt = slotLastSelectedAtByIndex?.[right.slotIndex] ?? 0;
            return leftSelectedAt - rightSelectedAt || left.slotIndex - right.slotIndex;
        })[0]!.slotIndex;
}

function emptyResult(
    fallbackReason: CodexBalanceLoaderResult['fallbackReason'],
): CodexBalanceLoaderResult {
    return { selection: null, fallbackReason, affinityStatus: 'not_requested', scores: [] };
}

export function selectCodexBalanceSlot(request: CodexBalanceLoaderRequest): CodexBalanceLoaderResult {
    const excludedSlots = toSet(request.excludedSlotIndexes);
    const excludedAccounts = toSet(request.excludedAccountKeys);
    const relevantSlotIndexes = getRelevantSlotIndexes(request.snapshot.slots, request.now, excludedSlots, excludedAccounts);
    if (relevantSlotIndexes.length === 0) {
        const hasCooldown = request.snapshot.slots.some((slot) => !isExcluded(slot, excludedSlots, excludedAccounts) && slot.rateLimitedUntil > request.now);
        return emptyResult(hasCooldown ? 'cooldown_only' : 'no_eligible_slot');
    }
    if (hasRelevantUnknownAccount(request.snapshot.slots, request.now, excludedSlots, excludedAccounts)) return emptyResult('unknown_account');
    if (request.snapshot.missingUsageSlotIndexes.some((slotIndex) => relevantSlotIndexes.includes(slotIndex))) return emptyResult('missing_usage');

    const maxAgeMs = request.persistedMaxAgeMs ?? DEFAULT_PERSISTED_MAX_AGE_MS;
    const eligibleSlots = groupEligibleSlots(request.snapshot.slots, request.now, excludedSlots, excludedAccounts);
    const hasStaleAccount = request.snapshot.staleAccountKeys.some((accountKey) => eligibleSlots.has(accountKey))
        || request.snapshot.accounts.some((account) => eligibleSlots.has(account.accountKey) && isPersistedStale(account, request.now, maxAgeMs));
    if (hasStaleAccount) return emptyResult('stale_usage');

    const scores = scoreAccounts(request, eligibleSlots);
    if (scores.length === 0) return emptyResult('missing_usage');

    const affinity = chooseAffinityAccount(scores, request);
    const slotIndex = chooseSlot(affinity.winner.slotCandidates, request.slotPendingLeasesByIndex, request.slotLastSelectedAtByIndex);
    return {
        selection: {
            accountKey: affinity.winner.accountKey,
            slotIndex,
            slotIndexes: affinity.winner.slotIndexes,
            baseScore: affinity.winner.baseScore,
        },
        fallbackReason: null,
        affinityStatus: affinity.status,
        scores: scores.map(({ slotCandidates, ...score }) => score),
    };
}

export function selectCodexBalanceCandidate(request: LegacyBalanceLoaderRequest): {
    fallbackReason: CodexBalanceLoaderResult['fallbackReason'];
    selectedAccountKey: string | null;
    selectedSlotIndex: number | null;
    affinityApplied: boolean;
    affinityStatus: CodexBalanceLoaderAffinityStatus;
    scores: CodexBalanceLoaderAccountScore[];
} {
    const pendingLeasesByAccountKey = request.slots.reduce<Record<string, number>>((accumulator, slot) => {
        accumulator[slot.accountKey] = (accumulator[slot.accountKey] ?? 0) + (slot.pendingLeases ?? 0);
        return accumulator;
    }, {});
    const slotPendingLeasesByIndex = request.slots.reduce<Record<number, number>>((accumulator, slot) => {
        accumulator[slot.slotIndex] = slot.pendingLeases ?? 0;
        return accumulator;
    }, {});
    const slotLastSelectedAtByIndex = request.slots.reduce<Record<number, number>>((accumulator, slot) => {
        const parsed = slot.lastSelectedAt ? Date.parse(slot.lastSelectedAt) : 0;
        accumulator[slot.slotIndex] = Number.isFinite(parsed) ? parsed : 0;
        return accumulator;
    }, {});

    const result = selectCodexBalanceSlot({
        now: request.now,
        provider: request.provider,
        snapshot: {
            slots: request.slots.map((slot) => ({
                slotIndex: slot.slotIndex,
                slotPath: null,
                accountKey: slot.accountKey,
                rateLimitedUntil: slot.rateLimitedUntil ?? 0,
            })),
            accounts: request.accounts,
            unknownAccountSlotIndexes: [],
            missingUsageSlotIndexes: [],
            staleAccountKeys: [],
            triggeredBackgroundRefresh: false,
        },
        excludedSlotIndexes: request.excludedSlotIndexes,
        excludedAccountKeys: request.excludedAccountKeys,
        pendingLeasesByAccountKey,
        slotPendingLeasesByIndex,
        slotLastSelectedAtByIndex,
        affinity: request.sessionAffinity
            ? {
                sessionId: request.sessionAffinity.sessionId,
                cacheEligible: request.sessionAffinity.cacheEligible,
                preferred: request.sessionAffinity.preferredAccountKey
                    ? {
                        provider: request.sessionAffinity.preferredProvider,
                        accountKey: request.sessionAffinity.preferredAccountKey,
                    }
                    : null,
            }
            : null,
    });

    return {
        fallbackReason: result.fallbackReason,
        selectedAccountKey: result.selection?.accountKey ?? null,
        selectedSlotIndex: result.selection?.slotIndex ?? null,
        affinityApplied: result.affinityStatus === 'applied',
        affinityStatus: result.affinityStatus,
        scores: result.scores,
    };
}