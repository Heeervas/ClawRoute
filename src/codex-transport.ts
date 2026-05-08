/**
 * Codex OAuth Transport for ClawRoute
 *
 * Translates OpenAI Chat Completions API requests into the ChatGPT
 * Codex Responses API format used by the ChatGPT subscription endpoint.
 *
 * Protocol details:
 * - Upstream URL: https://chatgpt.com/backend-api/codex/responses
 * - Auth: Bearer <access_token> + chatgpt-account-id header
 * - Request: OpenAI Responses API format (input[] instead of messages[])
 * - Response: SSE events with response.output_text.delta etc.
 *
 * Reference: https://github.com/EvanZhouDev/openai-oauth
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { ProxyAgent } from 'undici';
import { CodexSessionAccountAffinity, RequestExecutionContext } from './types.js';

// ── Types ──────────────────────────────────────────────────────────

export interface CodexAuth {
    accessToken: string;
    accountId: string;
    refreshToken?: string;
    idToken?: string;
    sourcePath?: string;
}

export interface CodexAuthSlotSnapshot {
    slotIndex: number;
    path: string | null;
    rateLimitedUntil: number;
}

interface ChatMessage {
    role: string;
    content: unknown;
    tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

interface CodexAuthSlot {
    path: string;
    auth: CodexAuth | null;
    lastLoadAttempt: number;
    rateLimitedUntil: number; // epoch ms — skip this slot until then
}

interface CodexErrorContext {
    slot?: number;
    path?: string;
}

type BalanceLoaderMode = 'off' | 'shadow' | 'on';
type CodexSelectionLease = {
    accountKey: string | null;
    slotIndex: number;
    selectedAt: number;
};

// ── Rotation State ─────────────────────────────────────────────────
let authSlots: CodexAuthSlot[] = [];
let currentSlotIndex = 0;
let lastRotationTime = 0;
let lastQueryEndTime = 0;
let activeRequests = 0;
const sessionAffinities = new Map<string, CodexSessionAccountAffinity>();
const pendingLeasesByAccountKey = new Map<string, number>();
const pendingLeasesBySlotIndex = new Map<number, number>();
const slotLastSelectedAtByIndex = new Map<number, number>();

// Configurable via env vars (read once on first use)
let rotationIntervalMs = -1;  // -1 = not yet loaded
let rotationIdleMs = -1;

function getRotationIntervalMs(): number {
    if (rotationIntervalMs < 0) {
        const hours = parseFloat(process.env['CODEX_ROTATION_INTERVAL_HOURS'] ?? '2');
        rotationIntervalMs = (isNaN(hours) ? 2 : hours) * 3_600_000;
    }
    return rotationIntervalMs;
}

function getRotationIdleMs(): number {
    if (rotationIdleMs < 0) {
        const minutes = parseFloat(process.env['CODEX_ROTATION_IDLE_MINUTES'] ?? '30');
        rotationIdleMs = (isNaN(minutes) ? 30 : minutes) * 60_000;
    }
    return rotationIdleMs;
}

function getBalanceLoaderMode(): BalanceLoaderMode {
    const configured = (process.env['CODEX_BALANCE_LOADER_MODE'] ?? 'off').trim().toLowerCase();
    if (configured === 'on' || configured === 'shadow') return configured;
    return 'off';
}

// ── Constants ──────────────────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

function resolveAuthPathEntry(pathOrHome: string | undefined): string {
    const candidate = pathOrHome?.trim() ?? '';
    if (!candidate) return '';
    return candidate.endsWith('.json') ? candidate : join(candidate, 'auth.json');
}

function hashAccountKey(accountId: string): string {
    return createHash('sha256').update(accountId).digest('hex').slice(0, 16);
}

function extractSessionIdFromRequest(request: Record<string, unknown>): string | null {
    const messages = Array.isArray(request['messages']) ? request['messages'] as Array<Record<string, unknown>> : [];
    const systemMessage = messages.find((message) => message['role'] === 'system');
    const systemContent = typeof systemMessage?.['content'] === 'string' ? systemMessage['content'] : '';
    const senderMatch = systemContent.match(/"sender_id"\s*:\s*"(\d+)"/);
    const senderId = senderMatch?.[1];
    return senderId ? createHash('sha256').update(senderId).digest('hex').slice(0, 8) : null;
}

function getSlotAccountId(slot: CodexAuthSlot): string | null {
    if (slot.auth?.accountId) return slot.auth.accountId;
    const authData = readAuthFile(slot.path);
    if (!authData) return null;
    const tokens = authData['tokens'] as Record<string, unknown> | undefined;
    const explicitAccountId = tokens?.['account_id'];
    if (typeof explicitAccountId === 'string' && explicitAccountId.length > 0) return explicitAccountId;
    const idToken = typeof tokens?.['id_token'] === 'string' ? tokens['id_token'] : undefined;
    return deriveAccountId(idToken) ?? null;
}

function getSlotAccountKey(slot: CodexAuthSlot): string | null {
    const accountId = getSlotAccountId(slot);
    return accountId ? hashAccountKey(accountId) : null;
}

function incrementLeaseCounter(map: Map<string | number, number>, key: string | number): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementLeaseCounter(map: Map<string | number, number>, key: string | number): void {
    const next = (map.get(key) ?? 0) - 1;
    if (next > 0) {
        map.set(key, next);
    } else {
        map.delete(key);
    }
}

function claimSelectionLease(accountKey: string | null, slotIndex: number): CodexSelectionLease {
    const selectedAt = Date.now();
    if (accountKey) incrementLeaseCounter(pendingLeasesByAccountKey, accountKey);
    incrementLeaseCounter(pendingLeasesBySlotIndex, slotIndex);
    slotLastSelectedAtByIndex.set(slotIndex, selectedAt);
    return { accountKey, slotIndex, selectedAt };
}

function releaseSelectionLease(
    lease: CodexSelectionLease | null,
    sessionId: string | null,
    rememberAffinity: boolean,
): void {
    if (!lease) return;
    if (lease.accountKey) decrementLeaseCounter(pendingLeasesByAccountKey, lease.accountKey);
    decrementLeaseCounter(pendingLeasesBySlotIndex, lease.slotIndex);
    if (!rememberAffinity || !sessionId || !lease.accountKey) return;
    sessionAffinities.set(sessionId, {
        provider: 'codex',
        accountKey: lease.accountKey,
        slotIndex: lease.slotIndex,
        lastSelectedAt: new Date(lease.selectedAt).toISOString(),
        lastCompletedAt: new Date().toISOString(),
    });
}

function getSessionAffinityContext(sessionId: string | null) {
    if (!sessionId) return null;
    const preferred = sessionAffinities.get(sessionId);
    return {
        sessionId,
        cacheEligible: true,
        preferredProvider: 'codex' as const,
        preferredAccountKey: preferred?.accountKey ?? '',
    };
}

async function getBalanceLoaderSelection(input: {
    now: number;
    sessionId: string | null;
    excludedSlotIndexes: Set<number>;
    excludedAccountKeys: Set<string>;
}): Promise<{
    selectedSlotIndex: number | null;
    selectedAccountKey: string | null;
    affinityApplied: boolean;
    fallbackReason: string | null;
}> {
    if (process.env['OPENAI_CODEX_TOKEN']) {
        return { selectedSlotIndex: null, selectedAccountKey: null, affinityApplied: false, fallbackReason: 'missing_usage' };
    }

    ensureCodexSlots();
    const slotIdentities = authSlots.map((slot, slotIndex) => ({
        slotIndex,
        slotPath: slot.path,
        accountKey: getSlotAccountKey(slot),
        rateLimitedUntil: slot.rateLimitedUntil,
    }));

    const { getCodexUsageSelectorSnapshot } = await import('./codex-usage.js');
    const selectorSnapshot = await getCodexUsageSelectorSnapshot({ slots: slotIdentities });
    const explicitFallback = typeof (selectorSnapshot as unknown as { fallbackReason?: unknown }).fallbackReason === 'string'
        ? (selectorSnapshot as unknown as { fallbackReason: string }).fallbackReason
        : null;
    if (explicitFallback) {
        return { selectedSlotIndex: null, selectedAccountKey: null, affinityApplied: false, fallbackReason: explicitFallback };
    }

    const relevantSlots = slotIdentities.filter((slot) => {
        if (slot.rateLimitedUntil > input.now) return false;
        if (input.excludedSlotIndexes.has(slot.slotIndex)) return false;
        return !(slot.accountKey && input.excludedAccountKeys.has(slot.accountKey));
    });
    const relevantSlotIndexes = new Set(relevantSlots.map((slot) => slot.slotIndex));
    const relevantAccountKeys = new Set(relevantSlots.map((slot) => slot.accountKey).filter((accountKey): accountKey is string => Boolean(accountKey)));
    if ((selectorSnapshot.unknownAccountSlotIndexes ?? []).some((slotIndex) => relevantSlotIndexes.has(slotIndex))) {
        return { selectedSlotIndex: null, selectedAccountKey: null, affinityApplied: false, fallbackReason: 'unknown_account' };
    }
    if ((selectorSnapshot.missingUsageSlotIndexes ?? []).some((slotIndex) => relevantSlotIndexes.has(slotIndex))) {
        return { selectedSlotIndex: null, selectedAccountKey: null, affinityApplied: false, fallbackReason: 'missing_usage' };
    }
    if ((selectorSnapshot.staleAccountKeys ?? []).some((accountKey) => relevantAccountKeys.has(accountKey))) {
        return { selectedSlotIndex: null, selectedAccountKey: null, affinityApplied: false, fallbackReason: 'stale_usage' };
    }

    const { selectCodexBalanceCandidate } = await import('./codex-balance-loader.js');
    const result = selectCodexBalanceCandidate({
        now: input.now,
        provider: 'codex',
        accounts: selectorSnapshot.accounts,
        slots: relevantSlots
            .filter((slot) => slot.accountKey)
            .map((slot) => ({
                slotIndex: slot.slotIndex,
                accountKey: slot.accountKey!,
                pendingLeases: pendingLeasesBySlotIndex.get(slot.slotIndex) ?? 0,
                lastSelectedAt: slotLastSelectedAtByIndex.get(slot.slotIndex)
                    ? new Date(slotLastSelectedAtByIndex.get(slot.slotIndex)!).toISOString()
                    : null,
                rateLimitedUntil: slot.rateLimitedUntil,
            })),
        excludedSlotIndexes: input.excludedSlotIndexes,
        excludedAccountKeys: input.excludedAccountKeys,
        sessionAffinity: getSessionAffinityContext(input.sessionId),
    });

    return {
        selectedSlotIndex: result.selectedSlotIndex,
        selectedAccountKey: result.selectedAccountKey,
        affinityApplied: result.affinityApplied,
        fallbackReason: result.fallbackReason,
    };
}

// ── Auth Loading ───────────────────────────────────────────────────

/**
 * Parse JWT claims without validation (we only need the expiry and account_id).
 */
function parseJwtClaims(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
        const payload = Buffer.from(padded, 'base64url').toString('utf-8');
        const parsed = JSON.parse(payload);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Derive the ChatGPT account ID from an id_token JWT.
 */
function deriveAccountId(idToken: string | undefined): string | undefined {
    if (!idToken) return undefined;
    const claims = parseJwtClaims(idToken);
    if (!claims) return undefined;
    const authClaim = claims['https://api.openai.com/auth'];
    if (typeof authClaim === 'object' && authClaim !== null) {
        const accountId = (authClaim as Record<string, unknown>)['chatgpt_account_id'];
        if (typeof accountId === 'string' && accountId.length > 0) return accountId;
    }
    return undefined;
}

/**
 * Check if the access_token JWT is expired or about to expire.
 */
function isTokenExpired(accessToken: string): boolean {
    const claims = parseJwtClaims(accessToken);
    if (!claims || typeof claims['exp'] !== 'number') return false;
    const expiryMs = (claims['exp'] as number) * 1000;
    return expiryMs <= Date.now() + REFRESH_MARGIN_MS;
}

/**
 * Resolve auth file paths (supports multi-key rotation and CODEX_HOME-style dirs).
 */
export function resolveAuthPaths(): string[] {
    const multiPaths = process.env['OPENAI_CODEX_AUTH_PATHS'];
    if (multiPaths && multiPaths.trim()) {
        return multiPaths.split(',').map(resolveAuthPathEntry).filter(Boolean);
    }
    if (process.env['OPENAI_CODEX_AUTH_PATH']) {
        return [resolveAuthPathEntry(process.env['OPENAI_CODEX_AUTH_PATH'])];
    }
    if (process.env['OPENAI_CODEX_TOKEN']) {
        return []; // Token mode, no file-based rotation
    }
    const codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex');
    return [resolveAuthPathEntry(codexHome)];
}

/**
 * Read and parse the auth.json file.
 */
function readAuthFile(path: string): Record<string, unknown> | null {
    try {
        if (!existsSync(path)) return null;
        const content = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(content);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Refresh the access token using the OAuth refresh_token flow.
 */
async function refreshTokens(
    refreshToken: string,
    proxyAgent: ProxyAgent | null,
    timeoutMs?: number,
): Promise<{ accessToken: string; idToken?: string; refreshToken: string; accountId?: string } | null> {
    const controller = new AbortController();
    const timeoutId = timeoutMs && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: OAUTH_CLIENT_ID,
                scope: 'openid profile email offline_access',
            }),
            signal: controller.signal,
        };
        if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

        const response = await fetch(OAUTH_TOKEN_URL, fetchOptions as RequestInit);
        if (!response.ok) return null;

        const payload = await response.json() as Record<string, unknown>;
        const newAccessToken = payload['access_token'];
        if (typeof newAccessToken !== 'string') return null;

        const newIdToken = typeof payload['id_token'] === 'string' ? payload['id_token'] : undefined;
        const newRefreshToken = typeof payload['refresh_token'] === 'string'
            ? payload['refresh_token']
            : refreshToken;

        return {
            accessToken: newAccessToken,
            idToken: newIdToken,
            refreshToken: newRefreshToken,
            accountId: deriveAccountId(newIdToken),
        };
    } catch (err) {
        console.warn('[codex-transport] Token refresh failed:', err instanceof Error ? err.message : err);
        return null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

/**
 * Write updated tokens back to auth.json.
 */
function writeAuthFile(
    path: string,
    authData: Record<string, unknown>,
    tokens: Record<string, string | undefined>,
): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const updated = {
            ...authData,
            tokens: {
                ...(authData['tokens'] as Record<string, unknown> ?? {}),
                ...tokens,
            },
            last_refresh: new Date().toISOString(),
        };
        writeFileSync(path, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch {
        // Best-effort write
    }
}

/**
 * Load auth from a specific file path (read, check expiry, refresh if needed).
 * Returns null if no valid credentials are found.
 */
async function loadAuthFromFile(path: string, proxyAgent: ProxyAgent | null, timeoutMs?: number): Promise<CodexAuth | null> {
    const authData = readAuthFile(path);
    if (!authData) return null;

    const tokens = authData['tokens'] as Record<string, unknown> | undefined;
    let accessToken = tokens?.['access_token'] as string | undefined;
    let idToken = tokens?.['id_token'] as string | undefined;
    let refreshToken = tokens?.['refresh_token'] as string | undefined;
    let accountId = (tokens?.['account_id'] as string | undefined) ?? deriveAccountId(idToken);

    if (!accessToken) return null;

    // Refresh if expired or about to expire
    if (isTokenExpired(accessToken) && refreshToken) {
        console.log(`[codex-transport] Access token expired for ${path}, refreshing...`);
        const refreshed = await refreshTokens(refreshToken, proxyAgent, timeoutMs);
        if (refreshed) {
            accessToken = refreshed.accessToken;
            idToken = refreshed.idToken ?? idToken;
            refreshToken = refreshed.refreshToken;
            accountId = refreshed.accountId ?? accountId;

            writeAuthFile(path, authData, {
                access_token: accessToken,
                id_token: idToken,
                refresh_token: refreshToken,
                account_id: accountId,
            });
            console.log('[codex-transport] Token refreshed successfully');
        } else {
            console.warn('[codex-transport] Token refresh failed, using existing token');
        }
    }

    if (!accountId) {
        console.warn(`[codex-transport] No account_id found in ${path} — skipping`);
        return null;
    }

    return { accessToken, accountId, refreshToken, idToken, sourcePath: path };
}

function ensureCodexSlots(): void {
    if (process.env['OPENAI_CODEX_TOKEN']) return;
    if (authSlots.length === 0) initializeSlots(resolveAuthPaths());
}

export function getCodexAuthSlots(): CodexAuthSlotSnapshot[] {
    if (process.env['OPENAI_CODEX_TOKEN']) {
        return [{ slotIndex: 0, path: null, rateLimitedUntil: 0 }];
    }

    ensureCodexSlots();
    return authSlots.map((slot, slotIndex) => ({
        slotIndex,
        path: slot.path,
        rateLimitedUntil: slot.rateLimitedUntil,
    }));
}

export async function loadCodexUsageAuthSlot(
    slot: CodexAuthSlotSnapshot,
    proxyAgent: ProxyAgent | null,
    timeoutMs?: number,
): Promise<CodexAuth | null> {
    if (process.env['OPENAI_CODEX_TOKEN']) {
        const accessToken = process.env['OPENAI_CODEX_TOKEN'];
        return accessToken ? { accessToken, accountId: '' } : null;
    }

    ensureCodexSlots();
    const existing = authSlots[slot.slotIndex];
    if (!existing) return null;
    if (existing.auth && !isTokenExpired(existing.auth.accessToken)) {
        return existing.auth;
    }

    const auth = await loadAuthFromFile(existing.path, proxyAgent, timeoutMs);
    if (auth) {
        existing.auth = auth;
        existing.lastLoadAttempt = Date.now();
    }
    return auth;
}

// ── Rotation Helpers ───────────────────────────────────────────────

export function resetRotationState(): void {
    authSlots = [];
    currentSlotIndex = 0;
    lastRotationTime = 0;
    lastQueryEndTime = 0;
    activeRequests = 0;
    sessionAffinities.clear();
    pendingLeasesByAccountKey.clear();
    pendingLeasesBySlotIndex.clear();
    slotLastSelectedAtByIndex.clear();
    rotationIntervalMs = -1;
    rotationIdleMs = -1;
}

export function getRotationState(): {
    currentSlotIndex: number;
    activeRequests: number;
    lastRotationTime: number;
    lastQueryEndTime: number;
    slotCount: number;
} {
    return {
        currentSlotIndex,
        activeRequests,
        lastRotationTime,
        lastQueryEndTime,
        slotCount: authSlots.length,
    };
}

export function initializeSlots(paths: string[]): void {
    authSlots = paths.map(path => ({
        path,
        auth: null,
        lastLoadAttempt: 0,
        rateLimitedUntil: 0,
    }));
    const now = Date.now();
    if (lastRotationTime === 0) lastRotationTime = now;
    if (lastQueryEndTime === 0) lastQueryEndTime = now;
    console.log(`[codex-rotation] Initialized ${authSlots.length} auth slot(s)`);
}

export function shouldRotate(): boolean {
    if (authSlots.length <= 1) return false;
    if (activeRequests > 0) return false;
    const now = Date.now();
    return (now - lastRotationTime) >= getRotationIntervalMs()
        && (now - lastQueryEndTime) >= getRotationIdleMs();
}

export function performRotation(): void {
    const oldIndex = currentSlotIndex;
    currentSlotIndex = (currentSlotIndex + 1) % authSlots.length;
    const now = Date.now();
    const idleMinutes = Math.round((now - lastQueryEndTime) / 60_000);
    const sinceRotation = formatDuration(now - lastRotationTime);
    lastRotationTime = now;
    const newSlot = authSlots[currentSlotIndex];
    if (newSlot) newSlot.auth = null;
    console.log(
        `[codex-rotation] Rotated from slot ${oldIndex} to slot ${currentSlotIndex}`
        + ` (idle: ${idleMinutes}m, since rotation: ${sinceRotation})`,
    );
}

function formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

export function releaseCodexAuth(): void {
    if (activeRequests > 0) activeRequests--;
    lastQueryEndTime = Date.now();
}

/**
 * Advance to the next slot without imposing a rate-limit cooldown.
 * Used after transient errors (e.g. 500) so the next attempt tries a different account.
 */
function advanceSlot(): void {
    if (authSlots.length <= 1) return;
    const oldIndex = currentSlotIndex;
    currentSlotIndex = (currentSlotIndex + 1) % authSlots.length;
    console.log(`[codex-rotation] Advanced from slot ${oldIndex} to slot ${currentSlotIndex} (transient error)`);
}

type AuthResult =
    | { ok: true; auth: CodexAuth }
    | { ok: false; reason: 'all_rate_limited' | 'auth_missing' };

/**
 * Get the active Codex auth, handling slot rotation and fallback.
 * Increments activeRequests on success — caller MUST call releaseCodexAuth() when done.
 */
export async function getActiveCodexAuth(
    proxyAgent: ProxyAgent | null,
    excludedSlotIndexes = new Set<number>(),
    preferredSlotIndex?: number,
    excludedAccountKeys = new Set<string>(),
): Promise<AuthResult> {
    // Fast path: explicit token (no rotation)
    if (process.env['OPENAI_CODEX_TOKEN']) {
        activeRequests++;
        return {
            ok: true,
            auth: {
                accessToken: process.env['OPENAI_CODEX_TOKEN'],
                accountId: '', // Token mode — account ID derived at request time
            },
        };
    }

    // Initialize slots on first call
    if (authSlots.length === 0) {
        initializeSlots(resolveAuthPaths());
    }
    if (authSlots.length === 0) return { ok: false, reason: 'auth_missing' };

    // Check rotation BEFORE starting the request unless the selector requested a specific starting slot.
    if (preferredSlotIndex !== undefined && authSlots[preferredSlotIndex] && !excludedSlotIndexes.has(preferredSlotIndex)) {
        currentSlotIndex = preferredSlotIndex;
    } else if (shouldRotate()) {
        performRotation();
    }

    // Increment BEFORE async work (prevents race conditions)
    activeRequests++;

    // Try current slot, then rotate through others on failure
    const now = Date.now();
    let sawRateLimitedSlot = false;
    for (let attempt = 0; attempt < authSlots.length; attempt++) {
        const slotIndex = (currentSlotIndex + attempt) % authSlots.length;
        if (excludedSlotIndexes.has(slotIndex)) continue;
        const slot = authSlots[slotIndex]!;
        const slotAccountKey = getSlotAccountKey(slot);
        if (slotAccountKey && excludedAccountKeys.has(slotAccountKey)) continue;

        // Skip slots that are currently rate-limited
        if (slot.rateLimitedUntil > now) {
            sawRateLimitedSlot = true;
            const remainMin = Math.ceil((slot.rateLimitedUntil - now) / 60_000);
            console.log(`[codex-rotation] Slot ${slotIndex} rate-limited for ${remainMin}m, skipping`);
            continue;
        }

        // Use cached slot auth if token still valid
        if (slot.auth && !isTokenExpired(slot.auth.accessToken)) {
            if (attempt > 0) {
                currentSlotIndex = slotIndex;
                console.log(`[codex-rotation] Slot ${slotIndex} selected after ${attempt} skip(s)`);
            }
            return { ok: true, auth: slot.auth };
        }

        // Load from file
        const auth = await loadAuthFromFile(slot.path, proxyAgent);
        if (auth) {
            slot.auth = auth;
            slot.lastLoadAttempt = Date.now();
            if (attempt > 0) currentSlotIndex = slotIndex;
            return { ok: true, auth };
        }

        console.warn(`[codex-rotation] Slot ${slotIndex} (${slot.path}): auth load failed, trying next`);
    }

    // All slots failed
    activeRequests--;
    return { ok: false, reason: sawRateLimitedSlot ? 'all_rate_limited' : 'auth_missing' };
}

// ── Request Translation ────────────────────────────────────────────

/**
 * Extract plain text from OpenAI message content (string or content parts array).
 */
function textContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((p: { type?: string; text?: string }) => p.type === 'text' && p.text)
        .map((p: { text: string }) => p.text)
        .join('');
}

function assistantReasoningContent(message: ChatMessage): string | undefined {
    const rawMessage = message as ChatMessage & Record<string, unknown>;
    const reasoningContent = rawMessage['reasoning_content'];
    if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
        return reasoningContent;
    }

    const reasoning = rawMessage['reasoning'];
    if (typeof reasoning === 'string' && reasoning.length > 0) {
        return reasoning;
    }

    return undefined;
}

/**
 * Convert OpenAI Chat Completions messages to Responses API input items.
 *
 * Chat Completions format:
 *   [{role: "system", content: "..."}, {role: "user", content: "..."}, ...]
 *
 * Responses API input format:
 *   [{role: "developer", content: "..."}, {role: "user", content: "..."},
 *    {type: "function_call", ...}, {type: "function_call_output", ...}]
 */
function chatMessagesToResponsesInput(messages: ChatMessage[]): unknown[] {
    const input: unknown[] = [];

    for (const msg of messages) {
        switch (msg.role) {
            case 'system':
            case 'developer':
                input.push({ role: 'developer', content: textContent(msg.content) });
                break;

            case 'user': {
                // Preserve multimodal content arrays (images etc.)
                if (Array.isArray(msg.content)) {
                    const parts = [];
                    for (const item of msg.content as Array<Record<string, unknown>>) {
                        if (item.type === 'text' && typeof item.text === 'string') {
                            parts.push({ type: 'input_text', text: item.text });
                        } else if (item.type === 'image_url' && typeof (item.image_url as Record<string, unknown>)?.url === 'string') {
                            parts.push({ type: 'input_image', image_url: (item.image_url as Record<string, unknown>).url });
                        }
                    }
                    input.push({ role: 'user', content: parts.length === 1 && parts[0]?.type === 'input_text' ? (parts[0] as { text: string }).text : parts });
                } else {
                    input.push({ role: 'user', content: textContent(msg.content) });
                }
                break;
            }

            case 'assistant': {
                const rawMessage = msg as ChatMessage & Record<string, unknown>;
                const reasoningContent = assistantReasoningContent(msg);
                if (reasoningContent) {
                    input.push({
                        type: 'reasoning',
                        id: typeof rawMessage['reasoning_item_id'] === 'string' && rawMessage['reasoning_item_id'].length > 0
                            ? rawMessage['reasoning_item_id']
                            : `rs_replay_${input.length}`,
                        summary: [{ type: 'summary_text', text: reasoningContent }],
                    });
                }

                const text = textContent(msg.content);
                if (text) {
                    const assistantItem: Record<string, unknown> = {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text }],
                    };
                    if (typeof rawMessage['phase'] === 'string' && rawMessage['phase'].length > 0) {
                        assistantItem['phase'] = rawMessage['phase'];
                    }
                    input.push(assistantItem);
                }
                // Tool calls become separate function_call items
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        input.push({
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        });
                    }
                }
                break;
            }

            case 'tool':
                if (msg.tool_call_id) {
                    input.push({
                        type: 'function_call_output',
                        call_id: msg.tool_call_id,
                        output: typeof msg.content === 'string'
                            ? msg.content
                            : JSON.stringify(msg.content),
                    });
                }
                break;
        }
    }

    return input;
}

/**
 * Build the Codex Responses API request body from a Chat Completions request.
 */
export function buildCodexRequestBody(
    request: Record<string, unknown>,
    modelName: string,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: modelName,
        input: chatMessagesToResponsesInput(request['messages'] as ChatMessage[]),
        stream: true, // Always stream from upstream; we'll collect for non-stream clients
        instructions: '',
        store: false,
    };

    // Forward compatible parameters
    // Note: temperature is intentionally omitted — Codex endpoint rejects it as unsupported.
    if (request['top_p'] !== undefined) body['top_p'] = request['top_p'];
    if (request['tools']) {
        // Translate Chat Completions tool format → Responses API format.
        // CC: {type: "function", function: {name, description, parameters}}
        // RA: {type: "function", name, description, parameters, strict}
        const ccTools = request['tools'] as Array<Record<string, unknown>>;
        body['tools'] = ccTools.map(tool => {
            if (tool['type'] === 'function' && tool['function']) {
                const fn = tool['function'] as Record<string, unknown>;
                return {
                    type: 'function',
                    name: fn['name'],
                    ...(fn['description'] !== undefined ? { description: fn['description'] } : {}),
                    ...(fn['parameters'] !== undefined ? { parameters: fn['parameters'] } : {}),
                    ...(fn['strict'] !== undefined ? { strict: fn['strict'] } : {}),
                };
            }
            return tool; // Already in Responses API format or unknown — pass through
        });
    }
    if (request['tool_choice']) body['tool_choice'] = request['tool_choice'];
    if (request['reasoning_effort']) {
        body['reasoning'] = { effort: request['reasoning_effort'] };
    }
    // max_tokens → not directly supported; omit (Responses API has max_output_tokens
    // but the Codex endpoint strips it anyway per openai-oauth source)

    return body;
}

// ── Response Translation ───────────────────────────────────────────

interface SSEEvent {
    event?: string;
    data?: string;
}

/**
 * Parse SSE events from a ReadableStream.
 */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? '';

            for (const block of blocks) {
                if (!block.trim()) continue;
                const event: SSEEvent = {};
                const dataLines: string[] = [];

                for (const line of block.split(/\r?\n/)) {
                    if (line.startsWith('event:')) {
                        event.event = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        dataLines.push(line.slice(5).trimStart());
                    }
                }

                if (dataLines.length > 0) {
                    event.data = dataLines.join('\n');
                }
                yield event;
            }
        }

        // Process remaining buffer
        if (buffer.trim()) {
            const event: SSEEvent = {};
            const dataLines: string[] = [];
            for (const line of buffer.split(/\r?\n/)) {
                if (line.startsWith('event:')) {
                    event.event = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }
            if (dataLines.length > 0) {
                event.data = dataLines.join('\n');
                yield event;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Map a Responses API finish reason to Chat Completions format.
 */
function mapFinishReason(responseStatus: string | undefined): string {
    switch (responseStatus) {
        case 'completed': return 'stop';
        case 'incomplete': return 'length';
        case 'cancelled': return 'stop';
        default: return 'stop';
    }
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asErrorCode(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function getErrorRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getCodexErrorSlot(errorRecord: Record<string, unknown> | null, errorContext?: CodexErrorContext): number | undefined {
    const slot = errorRecord?.['slot'];
    if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0) {
        return slot;
    }
    return errorContext?.slot;
}

function formatCodexErrorMessage(
    message: string,
    code: string | undefined,
    slot: number | undefined,
): string {
    const parts: string[] = [];
    if (slot !== undefined) {
        parts.push(`slot:${slot}`);
    }
    if (code) {
        parts.push(`code:${code}`);
    }
    return parts.length > 0 ? `${message} [${parts.join(' ')}]` : message;
}

function buildCodexErrorPayload(
    errorValue: unknown,
    fallbackMessage: string,
    fallbackCode: string,
    fallbackType: string,
    errorContext?: CodexErrorContext,
): Record<string, unknown> {
    const errorRecord = getErrorRecord(errorValue);
    const code = asErrorCode(errorRecord?.['code']) ?? fallbackCode;
    const type = asNonEmptyString(errorRecord?.['type']) ?? fallbackType;
    const stack = asNonEmptyString(errorRecord?.['stack']);
    const slot = getCodexErrorSlot(errorRecord, errorContext);
    const baseMessage = typeof errorValue === 'string'
        ? errorValue
        : asNonEmptyString(errorRecord?.['message']) ?? fallbackMessage;

    const error: Record<string, unknown> = {
        message: formatCodexErrorMessage(baseMessage, code, slot),
        type,
        code,
    };
    if (stack) {
        error['stack'] = stack;
    }
    if (slot !== undefined) {
        error['slot'] = slot;
    }
    return error;
}

function getCodexErrorResponseRecord(body: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return getErrorRecord(parsed['error']);
    } catch {
        return null;
    }
}

function getCodexResponseStatus(body: string): number {
    const error = getCodexErrorResponseRecord(body);
    if (!error) {
        return 200;
    }

    const code = asErrorCode(error['code']);
    const type = asNonEmptyString(error['type']);
    if (type === 'auth_error' || code === 'invalid_api_key' || code === 'unauthorized') {
        return 401;
    }
    if (type === 'rate_limit_error' || type === 'usage_limit_reached' || code === 'rate_limit_exceeded' || code === 'usage_limit_reached' || code === 'codex_429') {
        return 429;
    }
    return 502;
}

/**
 * Transform a Codex Responses API SSE stream into an OpenAI Chat Completions SSE stream.
 *
 * Responses API events → Chat Completions chunks:
 *   response.output_text.delta      → delta.content
 *   response.output_item.added      → (tool call start) delta.tool_calls
 *   response.function_call_arguments.delta → delta.tool_calls[].function.arguments
 *   response.completed              → finish_reason + usage + [DONE]
 */
export function codexResponseToStream(
    upstreamBody: ReadableStream<Uint8Array>,
    model: string,
    wantsStream: boolean,
    errorContext: CodexErrorContext = {},
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const chatId = `chatcmpl_${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Track tool call indices — key is call_id OR item_id (both map to same index)
    const toolIndexByCallId = new Map<string, number>();
    // Map item_id → call_id for non-streaming argument accumulation
    const itemIdToCallId = new Map<string, string>();
    let nextToolIndex = 0;

    // For non-streaming: collect all text and tool calls, emit as single response
    let collectedText = '';
    const collectedToolCalls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }> = [];
    let collectedUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
    let finishReason = 'stop';
    const itemsWithTextDelta = new Set<string>();
    const itemsWithDoneText = new Set<string>();
    const toolCallsWithArgumentDelta = new Set<string>();
    let collectedReasoning = '';
    let terminalErrorPayload: Record<string, unknown> | null = null;
    const reasoningPartKeysWithDelta = new Set<string>();
    const reasoningPartKeysWithDone = new Set<string>();
    const reasoningItemsWithEvents = new Set<string>();

    const sseIter = parseSSE(upstreamBody);

    function reasoningPartKey(
        itemId: string | undefined,
        partKind: 'content' | 'summary',
        partIndex: number | undefined,
    ): string | undefined {
        if (!itemId) return undefined;
        return `${itemId}:${partKind}:${String(partIndex ?? 0)}`;
    }

    function collectDoneText(
        itemId: string | undefined,
        text: string | undefined,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): void {
        if (!text) return;
        if (itemId && (itemsWithTextDelta.has(itemId) || itemsWithDoneText.has(itemId))) {
            return;
        }

        if (itemId) itemsWithDoneText.add(itemId);

        if (wantsStream) {
            controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                    id: chatId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })}\n\n`
            ));
            return;
        }

        collectedText += text;
    }

    function emitToolCallStart(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        idx: number,
        callId: string,
        name: string,
    ): void {
        controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
                id: chatId, object: 'chat.completion.chunk', created, model,
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: idx, id: callId, type: 'function',
                            function: { name, arguments: '' },
                        }],
                    },
                    finish_reason: null,
                }],
            })}\n\n`
        ));
    }

    function ensureToolCall(
        callId: string,
        itemId: string | undefined,
        name: string,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): number {
        let idx = toolIndexByCallId.get(callId);
        if (idx === undefined && itemId) {
            idx = toolIndexByCallId.get(itemId);
        }

        if (idx === undefined) {
            idx = nextToolIndex++;
            if (wantsStream) {
                emitToolCallStart(controller, encoder, chatId, created, model, idx, callId, name);
            } else {
                collectedToolCalls.push({
                    id: callId,
                    type: 'function',
                    function: { name, arguments: '' },
                });
            }
        }

        toolIndexByCallId.set(callId, idx);
        if (itemId) {
            toolIndexByCallId.set(itemId, idx);
            itemIdToCallId.set(itemId, callId);
        }

        if (!wantsStream && !collectedToolCalls.some(t => t.id === callId)) {
            collectedToolCalls.push({
                id: callId,
                type: 'function',
                function: { name, arguments: '' },
            });
        }

        return idx;
    }

    function collectDoneToolArguments(
        callId: string,
        itemId: string | undefined,
        name: string,
        args: string | undefined,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): void {
        const idx = ensureToolCall(callId, itemId, name, controller, encoder, chatId, created, model, wantsStream);
        if (!args) return;

        if (wantsStream) {
            const hasArgumentDelta = toolCallsWithArgumentDelta.has(callId)
                || (itemId ? toolCallsWithArgumentDelta.has(itemId) : false);
            if (!hasArgumentDelta) {
                controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                        id: chatId, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: idx,
                                    function: { arguments: args },
                                }],
                            },
                            finish_reason: null,
                        }],
                    })}\n\n`
                ));
            }
            return;
        }

        const tc = collectedToolCalls.find(t => t.id === callId);
        if (tc) tc.function.arguments = args;
    }

    function collectReasoning(
        text: string | undefined,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): void {
        if (!text) return;

        if (wantsStream) {
            controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                    id: chatId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
                })}\n\n`
            ));
            return;
        }

        collectedReasoning += text;
    }

    function collectReasoningDelta(
        itemId: string | undefined,
        partKey: string | undefined,
        text: string | undefined,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): void {
        if (partKey) reasoningPartKeysWithDelta.add(partKey);
        if (itemId) reasoningItemsWithEvents.add(itemId);
        collectReasoning(text, controller, encoder, chatId, created, model, wantsStream);
    }

    function collectDoneReasoning(
        itemId: string | undefined,
        partKey: string | undefined,
        text: string | undefined,
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        chatId: string,
        created: number,
        model: string,
        wantsStream: boolean,
    ): void {
        if (!text) return;
        if (partKey && (reasoningPartKeysWithDelta.has(partKey) || reasoningPartKeysWithDone.has(partKey))) {
            return;
        }

        if (partKey) reasoningPartKeysWithDone.add(partKey);
        if (itemId) reasoningItemsWithEvents.add(itemId);
        collectReasoning(text, controller, encoder, chatId, created, model, wantsStream);
    }

    function extractDoneItemText(item: Record<string, unknown> | undefined): string | undefined {
        const content = item?.['content'];
        if (!Array.isArray(content)) return undefined;

        const text = content
            .map(part => {
                if (typeof part !== 'object' || part === null) return '';
                return part['type'] === 'output_text' && typeof part['text'] === 'string'
                    ? part['text']
                    : '';
            })
            .join('');

        return text.length > 0 ? text : undefined;
    }

    function extractDoneItemReasoning(item: Record<string, unknown> | undefined): string | undefined {
        const summary = item?.['summary'];
        const content = item?.['content'];
        const parts: string[] = [];

        if (Array.isArray(summary)) {
            const summaryText = summary
                .map(part => {
                    if (typeof part !== 'object' || part === null) return '';
                    return part['type'] === 'summary_text' && typeof part['text'] === 'string'
                        ? part['text']
                        : '';
                })
                .join('');
            if (summaryText.length > 0) parts.push(summaryText);
        }

        if (Array.isArray(content)) {
            const reasoningText = content
                .map(part => {
                    if (typeof part !== 'object' || part === null) return '';
                    return part['type'] === 'reasoning_text' && typeof part['text'] === 'string'
                        ? part['text']
                        : '';
                })
                .join('');
            if (reasoningText.length > 0) parts.push(reasoningText);
        }

        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }

    function extractDoneFunctionCall(
        item: Record<string, unknown> | undefined,
    ): { callId: string; itemId: string | undefined; name: string; arguments: string | undefined } | undefined {
        if (item?.['type'] !== 'function_call') return undefined;

        const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : itemId;
        const name = typeof item['name'] === 'string' ? item['name'] : undefined;
        const args = typeof item['arguments'] === 'string' ? item['arguments'] : undefined;

        if (!callId || !name) return undefined;

        return { callId, itemId, name, arguments: args };
    }

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                if (wantsStream) {
                    // Emit initial role chunk
                    controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({
                            id: chatId, object: 'chat.completion.chunk', created, model,
                            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                        })}\n\n`
                    ));
                }

                for await (const sse of sseIter) {
                    if (!sse.data || !sse.event) continue;

                    let parsed: Record<string, unknown>;
                    try {
                        parsed = JSON.parse(sse.data);
                    } catch {
                        continue;
                    }

                    switch (sse.event) {
                        case 'response.output_text.delta': {
                            const delta = parsed['delta'] as string | undefined;
                            const itemId = parsed['item_id'] as string | undefined;
                            if (!delta) break;
                            if (itemId) itemsWithTextDelta.add(itemId);
                            if (wantsStream) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                                    })}\n\n`
                                ));
                            } else {
                                collectedText += delta;
                            }
                            break;
                        }

                        case 'response.output_text.done': {
                            collectDoneText(
                                parsed['item_id'] as string | undefined,
                                parsed['text'] as string | undefined,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.reasoning_text.delta': {
                            const itemId = parsed['item_id'] as string | undefined;
                            collectReasoningDelta(
                                itemId,
                                reasoningPartKey(itemId, 'content', parsed['content_index'] as number | undefined),
                                parsed['delta'] as string | undefined,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.reasoning_text.done': {
                            const itemId = parsed['item_id'] as string | undefined;
                            collectDoneReasoning(
                                itemId,
                                reasoningPartKey(itemId, 'content', parsed['content_index'] as number | undefined),
                                parsed['text'] as string | undefined,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.reasoning_summary_text.delta': {
                            const itemId = parsed['item_id'] as string | undefined;
                            collectReasoningDelta(
                                itemId,
                                reasoningPartKey(itemId, 'summary', parsed['summary_index'] as number | undefined),
                                parsed['delta'] as string | undefined,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.reasoning_summary_text.done': {
                            const itemId = parsed['item_id'] as string | undefined;
                            collectDoneReasoning(
                                itemId,
                                reasoningPartKey(itemId, 'summary', parsed['summary_index'] as number | undefined),
                                parsed['text'] as string | undefined,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.output_item.added': {
                            // Tool call start — data is nested under parsed['item']
                            const item = parsed['item'] as Record<string, unknown> | undefined;
                            const itemType = item?.['type'] as string | undefined;
                            if (itemType === 'function_call' && item) {
                                const callId = item['call_id'] as string;
                                const itemId = item['id'] as string | undefined;
                                const name = item['name'] as string;
                                ensureToolCall(callId, itemId, name, controller, encoder, chatId, created, model, wantsStream);
                            }
                            break;
                        }

                        case 'response.output_item.done': {
                            const item = parsed['item'] as Record<string, unknown> | undefined;
                            const itemType = item?.['type'] as string | undefined;
                            if (itemType === 'message') {
                                collectDoneText(
                                    item?.['id'] as string | undefined,
                                    extractDoneItemText(item),
                                    controller,
                                    encoder,
                                    chatId,
                                    created,
                                    model,
                                    wantsStream,
                                );
                            }
                            if (itemType === 'reasoning' && !reasoningItemsWithEvents.has(item?.['id'] as string | undefined ?? '')) {
                                const itemId = item?.['id'] as string | undefined;
                                collectDoneReasoning(
                                    itemId,
                                    reasoningPartKey(itemId, 'summary', undefined),
                                    extractDoneItemReasoning(item),
                                    controller,
                                    encoder,
                                    chatId,
                                    created,
                                    model,
                                    wantsStream,
                                );
                            }
                            if (itemType === 'function_call') {
                                const doneToolCall = extractDoneFunctionCall(item);
                                if (doneToolCall) {
                                    collectDoneToolArguments(
                                        doneToolCall.callId,
                                        doneToolCall.itemId,
                                        doneToolCall.name,
                                        doneToolCall.arguments,
                                        controller,
                                        encoder,
                                        chatId,
                                        created,
                                        model,
                                        wantsStream,
                                    );
                                }
                            }
                            break;
                        }

                        case 'response.function_call_arguments.delta': {
                            const delta = parsed['delta'] as string | undefined;
                            // The call identifier is 'item_id' in argument delta events
                            const itemId = parsed['item_id'] as string | undefined;
                            if (!delta || !itemId) break;
                            // Look up index by item_id; fall back to using it as call_id
                            const callId = itemId;
                            const resolvedCallId = itemIdToCallId.get(callId) ?? callId;
                            toolCallsWithArgumentDelta.add(resolvedCallId);
                            toolCallsWithArgumentDelta.add(itemId);

                            const idx = toolIndexByCallId.get(callId) ?? toolIndexByCallId.get(resolvedCallId);
                            if (wantsStream && idx !== undefined) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                tool_calls: [{
                                                    index: idx,
                                                    function: { arguments: delta },
                                                }],
                                            },
                                            finish_reason: null,
                                        }],
                                    })}\n\n`
                                ));
                            } else {
                                // Append to collected tool call arguments
                                // item_id → call_id lookup for non-streaming
                                const tc = collectedToolCalls.find(t => t.id === resolvedCallId);
                                if (tc) tc.function.arguments += delta;
                            }
                            break;
                        }

                        case 'response.function_call_arguments.done': {
                            const itemId = parsed['item_id'] as string | undefined;
                            const name = parsed['name'] as string | undefined;
                            const args = parsed['arguments'] as string | undefined;
                            if (!itemId || !name) break;

                            const callId = itemIdToCallId.get(itemId) ?? itemId;
                            collectDoneToolArguments(
                                callId,
                                itemId,
                                name,
                                args,
                                controller,
                                encoder,
                                chatId,
                                created,
                                model,
                                wantsStream,
                            );
                            break;
                        }

                        case 'response.completed':
                        case 'response.incomplete': {
                            const response = parsed['response'] as Record<string, unknown> | undefined;
                            const usage = response?.['usage'] as Record<string, unknown> | undefined;

                            if (usage) {
                                collectedUsage = {
                                    prompt_tokens: usage['input_tokens'] as number | undefined,
                                    completion_tokens: usage['output_tokens'] as number | undefined,
                                    total_tokens: ((usage['input_tokens'] as number) ?? 0) + ((usage['output_tokens'] as number) ?? 0),
                                };
                            }

                            finishReason = mapFinishReason(response?.['status'] as string | undefined);
                            // If tool calls were emitted, override to 'tool_calls'
                            if (nextToolIndex > 0) finishReason = 'tool_calls';

                            if (wantsStream) {
                                // Finish chunk
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({
                                        id: chatId, object: 'chat.completion.chunk', created, model,
                                        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                                        ...(Object.keys(collectedUsage).length > 0 ? { usage: collectedUsage } : {}),
                                    })}\n\n`
                                ));
                                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            }
                            break;
                        }

                        case 'error': {
                            const err = parsed['error'] ?? parsed; // allow both { error: ... } and flat
                            const errorPayload = buildCodexErrorPayload(
                                err,
                                'Codex upstream error',
                                'codex_error',
                                'upstream_error',
                                errorContext,
                            );
                            terminalErrorPayload = errorPayload;
                            if (wantsStream) {
                                controller.enqueue(encoder.encode(
                                    `data: ${JSON.stringify({ error: errorPayload })}\n\n`
                                ));
                                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                                controller.close();
                                return;
                            }
                            break;
                        }

                        // Ignore other event types (response.created, response.in_progress,
                        // response.output_text.done, response.output_item.done, etc.)
                    }
                }

                // For non-streaming: emit the full chat completion response
                if (!wantsStream) {
                    if (terminalErrorPayload) {
                        controller.enqueue(encoder.encode(JSON.stringify({ error: terminalErrorPayload })));
                        controller.close();
                        return;
                    }

                    const message: Record<string, unknown> = {
                        role: 'assistant',
                        content: collectedText.length > 0 ? collectedText : null,
                    };
                    if (collectedReasoning.length > 0) {
                        message['reasoning_content'] = collectedReasoning;
                    }
                    if (collectedToolCalls.length > 0) {
                        message['tool_calls'] = collectedToolCalls;
                    }

                    const responseJson = JSON.stringify({
                        id: chatId,
                        object: 'chat.completion',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            message,
                            finish_reason: collectedToolCalls.length > 0 ? 'tool_calls' : finishReason,
                        }],
                        usage: collectedUsage,
                    });

                    controller.enqueue(encoder.encode(responseJson));
                }

                controller.close();
            } catch (err) {
                controller.error(err);
            }
        },
    });
}

// ── Main Request Handler ───────────────────────────────────────────

/**
 * Parse the structured Codex error payload when the upstream body is JSON.
 */
function parseCodexError(errorBody: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(errorBody);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const nestedError = (parsed as Record<string, unknown>)['error'] ?? parsed;
        return typeof nestedError === 'object' && nestedError !== null
            ? nestedError as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

/**
 * Normalize upstream Codex errors into the existing ClawRoute envelope.
 */
function buildCodexErrorBody(status: number, errorBody: string, errorContext: CodexErrorContext = {}): string {
    const parsedError = parseCodexError(errorBody);
    const upstreamMessage = typeof parsedError?.['message'] === 'string'
        ? parsedError['message']
        : errorBody.trim();
    const message = upstreamMessage
        ? `Codex API error (${status}): ${upstreamMessage}`
        : `Codex API error (${status})`;
    const error = buildCodexErrorPayload(
        parsedError ?? undefined,
        message,
        `codex_${status}`,
        'upstream_error',
        errorContext,
    );
    error['message'] = formatCodexErrorMessage(
        message,
        asNonEmptyString(error['code']),
        typeof error['slot'] === 'number' ? error['slot'] : undefined,
    );
    if (typeof parsedError?.['resets_at'] === 'number') {
        error['resets_at'] = parsedError['resets_at'];
    }
    if (typeof parsedError?.['resets_in_seconds'] === 'number') {
        error['resets_in_seconds'] = parsedError['resets_in_seconds'];
    }
    return JSON.stringify({ error });
}

/**
 * Mark the current slot as rate-limited and extract resets_at from error body.
 */
function markSlotRateLimited(slotIndex: number, errorBody: string): void {
    const slot = authSlots[slotIndex];
    if (!slot) return;

    // Try to extract resets_at from the Codex error JSON
    let resetsAt = 0;
    const parsedError = parseCodexError(errorBody);
    if (typeof parsedError?.['resets_at'] === 'number') {
        resetsAt = parsedError['resets_at'] * 1000; // seconds → ms
    } else if (typeof parsedError?.['resets_in_seconds'] === 'number') {
        resetsAt = Date.now() + parsedError['resets_in_seconds'] * 1000;
    }

    // Fallback: 15 minute cooldown if no resets_at found
    slot.rateLimitedUntil = resetsAt > 0 ? resetsAt : Date.now() + 15 * 60_000;
    const cooldownMin = Math.ceil((slot.rateLimitedUntil - Date.now()) / 60_000);
    console.log(
        `[codex-rotation] Slot ${slotIndex} (${slot.path}) marked rate-limited for ${cooldownMin}m`,
    );
}

function getCodexUpstreamType(errorBody: string): string | null {
    const parsedError = parseCodexError(errorBody);
    if (typeof parsedError?.['upstream_type'] === 'string') return parsedError['upstream_type'];
    return typeof parsedError?.['type'] === 'string' ? parsedError['type'] : null;
}

function shouldRetryCodexError(status: number, errorBody: string): boolean {
    if (status === 500) return true;
    return status === 429 && getCodexUpstreamType(errorBody) === 'usage_limit_reached';
}

function getEarliestRateLimitInfo(): { resetsAt: number; resetsInSeconds: number } | null {
    const now = Date.now();
    const futureResets = authSlots.map(slot => slot.rateLimitedUntil).filter(resetAt => resetAt > now);
    if (futureResets.length === 0) return null;
    const earliestReset = Math.min(...futureResets);
    return {
        resetsAt: Math.ceil(earliestReset / 1000),
        resetsInSeconds: Math.ceil((earliestReset - now) / 1000),
    };
}

/**
 * Execute a single Codex request with the given auth.
 * Returns the Response (success or error).
 */
async function executeCodexCall(
    auth: CodexAuth,
    body: Record<string, unknown>,
    modelName: string,
    wantsStream: boolean,
    proxyAgent: ProxyAgent | null,
    errorContext: CodexErrorContext = {},
): Promise<Response> {
    const url = `${CODEX_BASE_URL}/responses`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.accessToken}`,
        'OpenAI-Beta': 'responses=experimental',
    };
    if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    };
    if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    fetchOptions.signal = controller.signal;

    try {
        const upstream = await fetch(url, fetchOptions as RequestInit);
        clearTimeout(timeoutId);

        if (!upstream.ok) {
            const errorBody = await upstream.text();
            return new Response(
                buildCodexErrorBody(upstream.status, errorBody, errorContext),
                { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
            );
        }

        if (!upstream.body) {
            return new Response(
                JSON.stringify({ error: { message: 'No response body from Codex', type: 'server_error' } }),
                { status: 502, headers: { 'Content-Type': 'application/json' } },
            );
        }

        const transformedBody = codexResponseToStream(upstream.body, modelName, wantsStream, errorContext);

        if (wantsStream) {
            return new Response(transformedBody, {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                },
            });
        } else {
            const reader = transformedBody.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const jsonBody = new TextDecoder().decode(
                new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0)).buffer
                    ? Buffer.concat(chunks)
                    : new Uint8Array(),
            );

            return new Response(jsonBody, {
                status: getCodexResponseStatus(jsonBody),
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (err) {
        clearTimeout(timeoutId);
        const message = err instanceof Error ? err.message : 'Codex request failed';
        return new Response(
            JSON.stringify({
                error: buildCodexErrorPayload(
                    message,
                    'Codex request failed',
                    'codex_error',
                    'server_error',
                    errorContext,
                ),
            }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }
}

/**
 * Execute a request through the Codex ChatGPT subscription endpoint.
 *
 * This replaces the normal makeProviderRequest flow for codex/ models.
 * Returns a Response that looks like a standard OpenAI Chat Completions
 * response (either streaming SSE or JSON), so the rest of ClawRoute's
 * executor pipeline (pipeStream, usage tracking) works unchanged.
 *
 * On 429 (usage_limit_reached), rotates to the next auth slot and retries
 * before returning the error to the caller.
 */
export async function makeCodexRequest(
    request: Record<string, unknown>,
    modelId: string,
    proxyAgent: ProxyAgent | null,
    executionContext: RequestExecutionContext = { sessionId: null },
): Promise<Response> {
    // 1. Extract model name (strip codex/ prefix)
    const modelName = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
    const sessionId = executionContext.sessionId ?? extractSessionIdFromRequest(request);
    const balanceLoaderMode = getBalanceLoaderMode();

    // 2. Build the Responses API request body
    const body = buildCodexRequestBody(request, modelName);
    const wantsStream = request['stream'] === true;

    // 3. Try each available slot (current first, then rotate on 429)
    let lastErrorResponse: Response | null = null;
    const triedSlotIndexes = new Set<number>();
    const excludedAccountKeys = new Set<string>();
    let preferredSlotIndex: number | undefined;
    let preferredAccountKey: string | null = null;
    const configuredSlotCount = process.env['OPENAI_CODEX_TOKEN']
        ? 1
        : (authSlots.length > 0 ? authSlots.length : resolveAuthPaths().length);
    const slotCount = Math.max(configuredSlotCount, 1); // at least 1 attempt

    for (let attempt = 0; attempt < slotCount; attempt++) {
        if (attempt === 0 && balanceLoaderMode !== 'off' && !process.env['OPENAI_CODEX_TOKEN']) {
            try {
                const selection = await getBalanceLoaderSelection({
                    now: Date.now(),
                    sessionId,
                    excludedSlotIndexes: triedSlotIndexes,
                    excludedAccountKeys,
                });
                preferredAccountKey = selection.selectedAccountKey;
                if (balanceLoaderMode === 'on' && selection.fallbackReason === null && selection.selectedSlotIndex !== null) {
                    preferredSlotIndex = selection.selectedSlotIndex;
                }
            } catch {
                // Legacy rotation remains the compatibility fallback.
            }
        }

        const result = await getActiveCodexAuth(proxyAgent, triedSlotIndexes, preferredSlotIndex, excludedAccountKeys);
        if (!result.ok) {
            if (result.reason === 'all_rate_limited') {
                const resetInfo = getEarliestRateLimitInfo();
                return lastErrorResponse ?? new Response(
                    JSON.stringify({
                        error: {
                            message: 'All Codex auth slots are currently rate-limited. Try again later.',
                            type: 'upstream_error',
                            code: 'codex_429',
                            ...(resetInfo ? {
                                resets_at: resetInfo.resetsAt,
                                resets_in_seconds: resetInfo.resetsInSeconds,
                            } : {}),
                        },
                    }),
                    { status: 429, headers: { 'Content-Type': 'application/json' } },
                );
            }
            return lastErrorResponse ?? new Response(
                JSON.stringify({
                    error: {
                        message: 'Codex OAuth credentials not found. Run `codex login` or set OPENAI_CODEX_AUTH_PATH.',
                        type: 'auth_error',
                        code: 'codex_auth_missing',
                    },
                }),
                { status: 401, headers: { 'Content-Type': 'application/json' } },
            );
        }

        const slotUsed = currentSlotIndex;
        const accountKeyUsed = result.auth.accountId
            ? hashAccountKey(result.auth.accountId)
            : preferredAccountKey;
        const lease = claimSelectionLease(accountKeyUsed, slotUsed);
        const response = await executeCodexCall(
            result.auth,
            body,
            modelName,
            wantsStream,
            proxyAgent,
            {
                slot: slotUsed,
                path: result.auth.sourcePath ?? authSlots[slotUsed]?.path,
            },
        );
        releaseCodexAuth();

        // Success or non-retriable error → return immediately
        if (response.status !== 429 && response.status !== 500) {
            releaseSelectionLease(lease, sessionId, response.ok);
            return response;
        }

        // 429 or 500 → rotate to next slot and retry
        const errBody = await response.text();
        releaseSelectionLease(lease, sessionId, false);
        if (!shouldRetryCodexError(response.status, errBody)) {
            return new Response(
                errBody,
                {
                    status: response.status,
                    headers: {
                        'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
                    },
                },
            );
        }
        triedSlotIndexes.add(slotUsed);
        if (response.status === 429) {
            console.warn(
                `[codex-rotation] Slot ${slotUsed} returned 429, rotating...`
                + (attempt + 1 < slotCount ? ` (attempt ${attempt + 1}/${slotCount})` : ' (no more slots)'),
            );
            markSlotRateLimited(slotUsed, errBody);
            if (accountKeyUsed) excludedAccountKeys.add(accountKeyUsed);
        } else {
            // 500 — server error, may be account-specific; try next slot without rate-limit penalty
            console.warn(
                `[codex-rotation] Slot ${slotUsed} returned 500, trying next slot...`
                + (attempt + 1 < slotCount ? ` (attempt ${attempt + 1}/${slotCount})` : ' (no more slots)'),
            );
            advanceSlot();
        }

        // Preserve last error response to return if all slots exhausted
        lastErrorResponse = new Response(
            errBody,
            {
                status: response.status,
                headers: {
                    'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
                },
            },
        );
    }

    // All slots exhausted
    return lastErrorResponse ?? new Response(
        JSON.stringify({
            error: {
                message: 'All Codex auth slots failed (rate-limited or server error)',
                type: 'upstream_error',
                code: 'codex_all_failed',
            },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
}
