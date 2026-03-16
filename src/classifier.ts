/**
 * ClawRoute Request Classifier
 *
 * 100% local classification of requests based on heuristics.
 * No external API calls, <5ms per classification.
 *
 * Classification tiers:
 * - HEARTBEAT: ping/status checks, simple greetings
 * - SIMPLE: acknowledgments, short replies, brief questions
 * - MODERATE: general conversation — the wide default bucket
 * - COMPLEX: clear analytical/technical tasks
 * - FRONTIER: explicit user opt-in only ("use frontier" / "#frontier")
 *
 * Design goals for OpenClaw:
 * - OpenClaw always sends 17 tool schemas → tools alone are NOT a signal
 * - OpenClaw accumulates large context quickly → token count is NOT a signal
 * - Message count grows fast in agent loops → msg count is NOT a signal
 * - Frontier is rare and expensive — user must opt in explicitly
 */

import {
    ChatCompletionRequest,
    ClassificationResult,
    TaskTier,
    TIER_ORDER,
    ClawRouteConfig,
} from './types.js';
import {
    getLastUserMessage,
} from './utils.js';

// === Classification Patterns ===

/** * Explicit tier override hashtags — highest priority, short-circuit all heuristics.
 * #mode-simple | #mode-moderate | #mode-complex | #mode-frontier
 * Also accepts the legacy aliases: #frontier / "use frontier" for frontier.
 */
const MODE_TAG: Record<string, TaskTier> = {
    'mode-simple':   TaskTier.SIMPLE,
    'mode-moderate': TaskTier.MODERATE,
    'mode-complex':  TaskTier.COMPLEX,
    'mode-frontier': TaskTier.FRONTIER,
};
const MODE_TAG_PATTERN = /#(mode-simple|mode-moderate|mode-complex|mode-frontier)\b/i;

/** * Explicit opt-in to frontier tier. User must include one of these phrases.
 */
const FRONTIER_EXPLICIT = /\buse frontier\b|#frontier\b/i;

/**
 * Patterns for heartbeat/ping detection.
 */
const HEARTBEAT_PATTERNS = [
    /^(ping|status|alive|check|heartbeat|hey|hi|hello|test|yo)\s*[?!.]*$/i,
    /^are you (there|up|alive|ok|ready)\s*[?!.]*$/i,
    /^(can you hear me|you there|testing)\s*[?!.]*$/i,
];

/**
 * Simple acknowledgment and short-reply patterns.
 * Intentionally broad — short replies should be cheap.
 */
const ACKNOWLEDGMENT_PATTERNS = [
    /^(thanks|thank you|thx|ty|cheers)\s*[!.,]*$/i,
    /^(ok|okay|k|kk|alright|sure|yes|no|yep|nope|yeah|nah|got it)\s*[!.,]*$/i,
    /^(sounds good|cool|great|nice|perfect|awesome|agreed|right|makes sense)\s*[!.,]*$/i,
    /^(lol|haha|hehe|lmao|rofl|lmfao)\s*[!.,]*$/i,
    /^(done|continue|go ahead|proceed|next|skip)\s*[!.,]*$/i,
    /^(no worries|np|no problem|don'?t worry)\s*[!.,]*$/i,
    /^[👍🙏😊👌✅❤️🎉👏]+$/,
];

/**
 * Keywords indicating complex analytical tasks.
 * Checked against the actual user message (after metadata stripping).
 */
const COMPLEX_KEYWORDS =
    /\b(explain|compare|analyze|analyse|research|summarize|summarise|evaluate|assess|review|describe|elaborate|discuss|contrast|outline|list the (pros|cons|differences|advantages|disadvantages))\b/i;

/**
 * Technical implementation intent — verb paired with a tech noun → complex.
 * (These were previously frontier; moved down since gemini-flash handles them well.)
 */
const TECHNICAL_VERB =
    /\b(implement|refactor|debug|optimize|optimise|architect|migrate|integrate|scaffold|deploy|build|create|write|generate|fix|rewrite)\b/i;

const TECHNICAL_NOUN =
    /\b(function|class|module|component|service|api|endpoint|algorithm|data.?struct(ure)?|tree|graph|heap|queue|stack|linked.?list|hash.?map|database|schema|pipeline|microservice|middleware|interface|generic|hook|query|mutation|resolver|worker|parser|compiler|lexer|sdk|cli|cron|daemon|script|test|spec|migration)\b/i;

// === Classification Functions ===

/**
 * FRONTIER: explicit opt-in only.
 * User must write "use frontier" or "#frontier" in their message.
 */
function isFrontier(
    lastMessage: string
): { match: boolean; confidence: number; signals: string[] } {
    if (FRONTIER_EXPLICIT.test(lastMessage)) {
        return { match: true, confidence: 0.99, signals: ['explicit_opt_in'] };
    }
    return { match: false, confidence: 0, signals: [] };
}

/**
 * COMPLEX: clear technical or analytical intent from the message content.
 * Does NOT use token count or message count — both are unreliable for OpenClaw.
 */
function isComplex(
    lastMessage: string
): { match: boolean; confidence: number; signals: string[] } {
    const signals: string[] = [];

    // Explicit analytical/research task
    if (COMPLEX_KEYWORDS.test(lastMessage)) {
        signals.push('analytical_keywords');
        return { match: true, confidence: 0.8, signals };
    }

    // Technical verb + technical noun pair — genuine implementation request
    if (TECHNICAL_VERB.test(lastMessage) && TECHNICAL_NOUN.test(lastMessage)) {
        signals.push('technical_task');
        return { match: true, confidence: 0.8, signals };
    }

    // Long detailed message — multi-part question or detailed instructions
    // Threshold 600 chars ≈ 3–4 sentences. Short follow-ups won't trigger this.
    if (lastMessage.length > 600) {
        signals.push('long_message');
        return { match: true, confidence: 0.75, signals };
    }

    return { match: false, confidence: 0, signals };
}

/**
 * HEARTBEAT: ultra-short ping/status patterns.
 */
function isHeartbeat(
    lastMessage: string,
    messageCount: number,
    hasTools: boolean
): { match: boolean; confidence: number } {
    for (const pattern of HEARTBEAT_PATTERNS) {
        if (pattern.test(lastMessage.trim())) {
            return { match: true, confidence: 0.95 };
        }
    }
    // Very short + fresh conversation + no tools
    if (lastMessage.length < 25 && messageCount <= 2 && !hasTools) {
        return { match: true, confidence: 0.8 };
    }
    return { match: false, confidence: 0 };
}

/**
 * SIMPLE: acknowledgment, short reply, or brief factual question.
 * Intentionally catches more than before — cheap model handles these fine.
 */
function isSimple(
    lastMessage: string
): { match: boolean; confidence: number } {
    const trimmed = lastMessage.trim();

    // Acknowledgment patterns
    for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { match: true, confidence: 0.9 };
        }
    }

    // Short message (≤ 40 chars) that isn't a complex/technical request
    // — safety net for very short one-liners that aren't in acknowledgment patterns.
    // Kept tight so genuine factual questions (47+ chars) fall through to MODERATE.
    if (trimmed.length <= 40 && !COMPLEX_KEYWORDS.test(trimmed) && !TECHNICAL_VERB.test(trimmed)) {
        return { match: true, confidence: 0.8 };
    }

    return { match: false, confidence: 0 };
}

/**
 * Classify a chat completion request.
 *
 * @param request - The chat completion request
 * @param config - The ClawRoute configuration
 * @returns Classification result with tier, confidence, and signals
 */
export function classifyRequest(
    request: ChatCompletionRequest,
    config: ClawRouteConfig
): ClassificationResult {
    const messages = request.messages;
    const lastMessage = getLastUserMessage(messages);
    const messageCount = messages.length;
    const hasTools = Boolean(request.tools && request.tools.length > 0);

    const signals: string[] = [];
    let tier: TaskTier = TaskTier.MODERATE;
    let confidence = 0.85;
    let reason = 'default classification';

    // RULE GROUP 0 (PRIORITY): explicit #mode-* tag — overrides everything
    const modeTagMatch = lastMessage.match(MODE_TAG_PATTERN);
    if (modeTagMatch) {
        const tag = modeTagMatch[1]!.toLowerCase();
        tier = MODE_TAG[tag]!;
        confidence = 0.99;
        reason = `explicit tag: #${tag}`;
        signals.push('mode_tag_override');
        return {
            tier,
            confidence,
            reason,
            signals,
            toolsDetected: hasTools,
            safeToRetry: tier === TaskTier.HEARTBEAT || tier === TaskTier.SIMPLE,
        };
    }

    // Check for model name hints (opportunistic)
    const modelLower = request.model.toLowerCase();
    if (
        modelLower.includes('heartbeat') ||
        modelLower.includes('cron') ||
        modelLower.includes('health')
    ) {
        signals.push('model_name_hint');
        tier = TaskTier.HEARTBEAT;
        confidence = 0.85;
        reason = 'model name indicates heartbeat';
    }

    // RULE GROUP 1: HEARTBEAT
    if (tier === TaskTier.MODERATE) {
        const heartbeatCheck = isHeartbeat(lastMessage, messageCount, hasTools);
        if (heartbeatCheck.match) {
            tier = TaskTier.HEARTBEAT;
            confidence = heartbeatCheck.confidence;
            reason = 'heartbeat pattern detected';
            signals.push('heartbeat_pattern');
        }
    }

    // RULE GROUP 2: SIMPLE — check before complex so short replies aren't mis-classified
    if (tier === TaskTier.MODERATE) {
        const simpleCheck = isSimple(lastMessage);
        if (simpleCheck.match) {
            tier = TaskTier.SIMPLE;
            confidence = simpleCheck.confidence;
            reason = 'simple acknowledgment or short reply';
            signals.push('simple_pattern');
        }
    }

    // RULE GROUP 3: COMPLEX
    if (tier === TaskTier.MODERATE) {
        const complexCheck = isComplex(lastMessage);
        if (complexCheck.match) {
            tier = TaskTier.COMPLEX;
            confidence = complexCheck.confidence;
            reason = `complex: ${complexCheck.signals.join(', ')}`;
            signals.push(...complexCheck.signals);
        }
    }

    // RULE GROUP 4: FRONTIER — explicit opt-in only; overrides all tiers
    const frontierCheck = isFrontier(lastMessage);
    if (frontierCheck.match) {
        tier = TaskTier.FRONTIER;
        confidence = frontierCheck.confidence;
        reason = `frontier: ${frontierCheck.signals.join(', ')}`;
        signals.push(...frontierCheck.signals);
    }

    // RULE GROUP 5: MODERATE (already default)
    if (tier === TaskTier.MODERATE && signals.length === 0) {
        reason = 'general conversation';
        signals.push('default_moderate');
    }

    // === POST-CLASSIFICATION ADJUSTMENTS ===

    // Tool-aware routing: only escalate when tool use is FORCED (tool_choice
    // === 'required' or a specific function object). Agents like OpenClaw
    // always pass tool definitions in every request, so the bare presence of
    // tools is not a reliable complexity signal.
    if (config.classification.toolAwareRouting && hasTools) {
        const tc = request.tool_choice;
        const forcedToolUse =
            tc === 'required' ||
            (typeof tc === 'object' && tc !== null && 'type' in tc);
        if (forcedToolUse && TIER_ORDER[tier] < TIER_ORDER[TaskTier.COMPLEX]) {
            const oldTier = tier;
            tier = TaskTier.COMPLEX;
            reason = `escalated from ${oldTier}: forced tool use`;
            signals.push('tool_aware_escalation');
            confidence = Math.min(confidence, 0.8);
        }
    }

    // Conservative mode: low confidence -> escalate
    if (config.classification.conservativeMode) {
        if (confidence < config.classification.minConfidence) {
            // Escalate one tier
            const currentOrder = TIER_ORDER[tier];
            const nextOrder = Math.min(currentOrder + 1, TIER_ORDER[TaskTier.FRONTIER]);
            const nextTier = (Object.entries(TIER_ORDER).find(
                ([, order]) => order === nextOrder
            )?.[0] ?? TaskTier.FRONTIER) as TaskTier;

            if (nextTier !== tier) {
                const oldTier = tier;
                tier = nextTier;
                reason = `escalated from ${oldTier}: low confidence (${confidence.toFixed(2)})`;
                signals.push('low_confidence_escalation');
            }
        }

        // Very low confidence -> escalate to frontier
        if (confidence < 0.5 && tier !== TaskTier.FRONTIER) {
            tier = TaskTier.FRONTIER;
            reason = `escalated to frontier: very low confidence (${confidence.toFixed(2)})`;
            signals.push('very_low_confidence_escalation');
        }
    }

    // Determine if safe to retry
    // Safe only for HEARTBEAT or SIMPLE (no tool side-effects expected)
    let safeToRetry = tier === TaskTier.HEARTBEAT || tier === TaskTier.SIMPLE;

    // If tools are present, never safe to retry (tools might have side effects)
    if (hasTools) {
        safeToRetry = false;
    }

    return {
        tier,
        confidence,
        reason,
        signals,
        toolsDetected: hasTools,
        safeToRetry,
    };
}

/**
 * Get a human-readable explanation of the classification.
 *
 * @param result - The classification result
 * @returns Human-readable description
 */
export function explainClassification(result: ClassificationResult): string {
    const tierNames: Record<TaskTier, string> = {
        [TaskTier.HEARTBEAT]: 'Heartbeat (ping/status)',
        [TaskTier.SIMPLE]: 'Simple (acknowledgment/short question)',
        [TaskTier.MODERATE]: 'Moderate (general conversation)',
        [TaskTier.COMPLEX]: 'Complex (analytical/tools)',
        [TaskTier.FRONTIER]: 'Frontier (explicit opt-in)',

    };

    return `${tierNames[result.tier]} - ${result.reason} (confidence: ${(result.confidence * 100).toFixed(0)}%)`;
}
