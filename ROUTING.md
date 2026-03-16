# ClawRoute Routing Guide

ClawRoute classifies every incoming LLM request into one of five complexity tiers and routes it to the most cost-effective model that can handle the task. This document explains how that works and how Ollama fits in.

---

## The 5 Tiers

| Tier | Intent | Primary Model | Fallback |
|---|---|---|---|
| **heartbeat** | Health checks, trivial pings | `google/gemini-2.5-flash-lite` | `deepseek/deepseek-chat` |
| **simple** | Short Q&A, single-turn completions, factual lookups | `deepseek/deepseek-chat` | `google/gemini-2.5-flash` |
| **moderate** | Multi-turn conversation, summarisation, moderate reasoning | `google/gemini-2.5-flash` | `openai/gpt-5-mini` |
| **complex** | Coding, multi-step reasoning, tool-calling tasks | `anthropic/claude-sonnet-4-6` | `openai/gpt-5.2` |
| **frontier** | Hardest problems, large context, safety-critical output | `anthropic/claude-opus-4-6` | `openai/o3` |

---

## What Triggers Each Tier

ClawRoute inspects the request's last user message and several signals to choose a tier:

### heartbeat
- Message is empty, very short (≤ 5 chars), or matches patterns like `"ping"`, `"hi"`, `"test"`, `"ok"`
- Model name contains `"heartbeat"`

### simple
- Single-turn request (no prior conversation)
- Short message (≤ 100 chars)
- Factual / lookup language: *"what is"*, *"how do I"*, *"define"*

### moderate
- Conversational depth (3+ messages)
- Summarisation or explanation language: *"summarise"*, *"explain"*, *"compare"*
- Medium-length messages (100–500 chars)

### complex
- Code or implementation language: *"implement"*, *"write a function"*, *"refactor"*, *"debug"*
- Tool definitions present in the request
- Long messages or multi-file context

### frontier
- Extreme reasoning: *"prove"*, *"derive"*, *"architect"*, *"design system"*
- Very long context (> 50k tokens estimated)
- Safety-critical or compliance language

> **Conservative mode** (enabled by default): if confidence < 0.7, ClawRoute escalates to the next tier rather than gambling on a cheaper model.

---

## Example: "Write me a script to process CSV files"

1. Classifier sees: *"write"* + *"script"* + coding context → **FRONTIER** (code block signal)
2. ClawRoute routes to `anthropic/claude-opus-4-6`
3. If Anthropic API key is missing → fallback to `openai/o3`
4. Routing decision logged to the dashboard

---

## Ollama: Explicit Routing Only

Ollama is **not** in the auto-tier table. It is only used when you explicitly set the model name with the `ollama/` prefix:

```
ollama/granite4:350m
```

When ClawRoute sees an `ollama/` prefix, it:
1. Sets provider = `ollama`
2. Routes to `$OLLAMA_ENDPOINT/v1` (default: `http://ollama:11434/v1`)
3. Sends no API key (Ollama doesn't require one)
4. Does **not** apply tier classification — the model is used as-is

**Why explicit-only?** CPU inference on Ollama is slow (~5–15 tok/s on a 2014 MacBook Pro). Auto-routing would silently degrade response quality for tasks that need speed or tool-calling.

---

## Overrides

You can force a specific model for all requests or a single session:

```bash
# Global override (all sessions)
curl -X POST http://clawroute:18790/api/override/global \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-2.5-flash"}'

# Clear the global override
curl -X DELETE http://clawroute:18790/api/override/global
```

Dry-run mode classifies and logs without actually rerouting — useful for tuning:

```bash
CLAWROUTE_DRY_RUN=true
```

---

## Dashboard

When running via `docker compose`, inspect routing decisions at:

```bash
# Port-forward ClawRoute to localhost
docker exec -it openclaw_clawroute wget -qO- http://127.0.0.1:18790/health
```

Or view the full dashboard HTML by opening `http://127.0.0.1:18790/dashboard` after adding a temporary port mapping to `docker-compose.override.yml`:

```yaml
services:
  clawroute:
    ports:
      - "18790:18790"
```

---

## Changing the Tier Models

Edit `ClawRoute/config/clawroute.json` (create if absent) to override specific tiers without touching `default.json`:

```json
{
  "models": {
    "complex": {
      "primary": "google/gemini-2.5-pro",
      "fallback": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

Changes take effect on next ClawRoute restart.
