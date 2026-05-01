# ClawRoute Routing Guide

ClawRoute separates startup config from the live routing snapshot. Request routing and model catalogs can reload without restarting the process; listener binding, auth wiring, stats, and config readouts still stay startup-bound.

## Tier Routing

ClawRoute currently classifies requests into six tiers:

| Tier | Typical workload |
|---|---|
| `heartbeat` | Pings, trivial checks, very short prompts |
| `simple` | Short single-turn questions and direct lookups |
| `moderate` | Multi-turn chat, summarization, medium reasoning |
| `complex` | Coding, tool-heavy, or multi-step reasoning |
| `frontier-sonnet` | Hard tasks that need a stronger first frontier pass |
| `frontier-opus` | Highest-cost fallback tier |

Per request, ClawRoute does this:

1. Captures the current routing snapshot once.
2. Classifies the request into a tier.
3. Honors any in-memory override first.
4. If the caller requested a known enabled model directly, routes to that model as-is except for `clawroute/*` virtual IDs.
5. Otherwise uses the tier's primary model, then its fallback.

Model choices come from the active routing snapshot, not from hardcoded values in this guide. `codex/*` model IDs still use the dedicated Codex Responses transport, not the standard OpenAI-compatible provider path.

## Request Mutation Map

ClawRoute is not a pure passthrough proxy. After routing chooses the upstream model, ClawRoute may rewrite or inject request fields to match provider requirements, keep costs bounded, or preserve reasoning/tool continuity.

In the lobster-cage integration, Hermes currently talks to ClawRoute through `/v1/chat/completions`, so that is the live path to keep in mind when debugging request-shape issues.

```mermaid
flowchart TD
	H[Hermes or client] --> CC[/v1/chat/completions]
	CC --> RT[routeRequest<br/>choose routedModel]
	RT --> EX[makeProviderRequest]
	EX --> BASE[Clone request body<br/>overwrite model]

	R[/v1/responses] --> RA[responses-adapter<br/>Responses -> Chat Completions]
	RA --> CC

	BASE --> P{provider}
	P -->|codex| CX[codex-transport<br/>CC -> Responses bridge<br/>preserve reasoning_content]
	P -->|ollama| OL[Ollama rewrite<br/>strip tools<br/>flatten content<br/>trim short-tier history]
	P -->|other remote providers| STD[Standard provider path<br/>optional caps and cache hints]

	CX --> UP1[Upstream Codex Responses API]
	OL --> UP2[Upstream Ollama /api/chat]
	STD --> UP3[Upstream /chat/completions or /messages]
```

### Fields ClawRoute Rewrites

- `model` is always overwritten with the routed upstream model id.
- On `/v1/responses`, `input`, `instructions`, `tools`, and `tool_choice` are translated into Chat Completions fields before routing.
- On `/v1/responses`, `stream` is forced to `false` internally and ClawRoute re-wraps the final result as Responses SSE only at the edge.
- On the Codex bridge, `reasoning_effort` is remapped to Responses `reasoning.effort`.
- On the Codex bridge, assistant `reasoning_content` is replayed as Responses `reasoning` items on subsequent turns.
- On Ollama requests, `options.num_ctx` is raised to a minimum floor if the caller asked for less.
- On Ollama requests, `tools` and `tool_choice` are removed entirely.
- On Ollama requests, multimodal/message-part arrays are flattened into plain text strings.
- On Ollama heartbeat/simple tiers, message history is trimmed to system messages plus the last three non-system turns.
- On non-Ollama requests, ClawRoute may inject a tier-based `max_tokens` cap if the caller did not set one.
- On cheap OpenRouter tiers, ClawRoute may inject a `provider` preference that sorts by price and allows fallbacks.
- On Claude via OpenRouter, ClawRoute may inject top-level `cache_control` when the conversation is long enough to benefit from Anthropic prompt caching.

### Reasoning Continuity

For the live Hermes path (`/v1/chat/completions`), ClawRoute preserves Codex reasoning summaries instead of discarding them:

- streaming Codex reasoning is emitted back to the client as `delta.reasoning_content`
- completed Codex reasoning is preserved on the final assistant message as `message.reasoning_content`
- replayed assistant `reasoning_content` is converted back into Responses `reasoning` items when ClawRoute talks to the Codex upstream

For `/v1/responses`, ClawRoute now preserves both reasoning content and effort during the Responses -> Chat Completions translation:

- Responses `reasoning` items become assistant messages with `reasoning_content` and `reasoning_item_id`
- Responses `reasoning.effort` becomes Chat Completions `reasoning_effort`

This means the operational answer to "only the model should change" is no: model selection is the main mutation, but request shape is also normalized per provider.

## Live Routing Snapshot

The live snapshot is rebuilt once per second and on successful admin writes.

Hot-reloaded files:

- `config/default.json`
- `config/clawroute.json`
- `config/providers/*.json`
- `config/model-registry.json`

Snapshot precedence:

1. Bundled defaults
2. `config/default.json`
3. The selected provider profile from `config/providers/<providerProfile>.json`
4. `config/clawroute.json`
5. `CLAWROUTE_BASELINE_MODEL` for `baselineModel`

`providerProfile` selection precedence is:

1. `CLAWROUTE_PROVIDER`
2. `config/clawroute.json.providerProfile`
3. `config/default.json.providerProfile`

Important boundaries:

- `config/clawroute.json` wins over the selected provider profile for keys it sets.
- Invalid JSON or invalid model references keep the last known-good snapshot in service.
- Runtime-only toggles such as enable/disable, dry-run, and global/session overrides stay in memory and survive snapshot swaps.

## Restart-Only Surfaces

These still require a process restart for file edits to take effect:

- `proxyHost` and `proxyPort`
- `authToken` and auth middleware exemptions
- Startup banner and logger bootstrap
- `/stats` and `/api/config`

`/health` reflects the current in-memory enable and dry-run flags, but editing those keys in JSON is not part of the live-reload contract. Use the control endpoints for those runtime toggles.

## Codex Defaults

The bundled model catalog now includes:

- `codex/gpt-5.5`
- `codex/gpt-5.4`
- `codex/gpt-5.4-mini`
- `codex/gpt-4.1`
- `codex/gpt-4.1-mini`

The Codex provider profile defaults are now:

| Tier | Primary | Fallback |
|---|---|---|
| `heartbeat` | `codex/gpt-5.4-mini` | `codex/gpt-5.4-mini` |
| `simple` | `codex/gpt-5.4-mini` | `codex/gpt-5.4-mini` |
| `moderate` | `codex/gpt-5.4` | `codex/gpt-5.4-mini` |
| `complex` | `codex/gpt-5.4` | `codex/gpt-5.4-mini` |
| `frontier-sonnet` | `codex/gpt-5.4` | `codex/gpt-5.4-mini` |
| `frontier-opus` | `codex/gpt-5.4` | `codex/gpt-5.4-mini` |

The default context overrides pin `codex/gpt-5.5` and `codex/gpt-5.4` to 1,050,000 tokens and `codex/gpt-5.4-mini` to 400,000.

`codex/gpt-5.5` remains enabled in the catalog and available through `/v1/models` for explicit client-side selection.

## Admin Model Management

Protected admin requests use the same shared auth token as the rest of the protected API. The CLI reads `CLAWROUTE_TOKEN` and sends it as `Authorization: Bearer <token>`.

Available commands:

- `clawroute models discover <provider>`
- `clawroute models add <model-id> --provider <provider> --max-context <n> --input-cost <n> --output-cost <n> [--tool-capable false] [--multimodal true] [--enabled false]`
- `clawroute models remove <model-id>`
- `clawroute tiers set <tier> --primary <model-id> --fallback <model-id>`

Persistence rules:

| Operation | Writes | Notes |
|---|---|---|
| `models discover` | none | Enumerates candidates only |
| `models add` | `config/model-registry.json` | Persists a complete model entry |
| `models remove` | `config/model-registry.json` | Deletes custom models or writes `enabled: false` for bundled ones |
| `tiers set` | `config/clawroute.json` | Persists tier primary and fallback |

After a successful add, remove, or tier update, ClawRoute reloads the live routing snapshot immediately when runtime state is enabled.

## Discovery Workflow

Discovery is intentionally enumerate-only.

- A discovered model does not appear in `/api/models` or `/v1/models` until `models add` persists a complete entry.
- Incomplete candidates are returned as `discoveryOnly: true` with a `missingFields` array.
- Tier assignments reject discovery-only, incomplete, disabled, or unknown model IDs.
- Model removal is blocked while a model is still referenced by `baselineModel` or any tier mapping.

Required metadata for persistence is:

- `provider`
- `maxContext`
- `toolCapable`
- `multimodal`
- `enabled`
- `inputCostPer1M`
- `outputCostPer1M`

Codex discovery is intentionally pragmatic: `clawroute models discover codex` enumerates the locally registered Codex catalog instead of calling an upstream Codex models endpoint. In this project, the upstream Codex listing is not treated as reliable enough to drive operator-facing discovery or persistence.
