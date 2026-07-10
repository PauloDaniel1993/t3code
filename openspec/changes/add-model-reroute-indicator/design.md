## Context

Requests to `claude-fable-5` can be declined by its safety classifiers. The Claude Agent SDK (installed: `@anthropic-ai/claude-agent-sdk` v0.3.170) handles this internally: it retries the turn once on `claude-opus-4-8` and makes the swap persistent for the rest of the CLI session. The app currently drops every signal of this:

- The SDK emits `SDKModelRefusalFallbackMessage` (`sdk.d.ts:3692`, part of the `SDKMessage` union at `:3651`) with `original_model`, `fallback_model`, `api_refusal_category`, `api_refusal_explanation`, `retracted_message_uuids`. It lands in `ClaudeAdapter.handleSystemMessage`'s `default:` branch (`ClaudeAdapter.ts:~2783`) and is discarded.
- Every `SDKAssistantMessage` carries the actual serving model at `message.message.model`, plus `parent_tool_use_id` (non-null ⇒ subagent/tool-nested).
- `packages/contracts/src/providerRuntime.ts:241,555-560` already defines the `model.rerouted` runtime event (`{fromModel, toModel, reason}`). `CodexAdapter.ts:1060-1076` emits it; nothing consumes it — verified zero references in ingestion, web, and mobile.

Persistence context: `projection_thread_messages` has no model metadata. The `attachments_json` column (migration 007) established the pattern for nullable JSON columns with COALESCE-preserving upserts (`persistence/Layers/ProjectionThreadMessages.ts:84-91,105-108`). The web `ChatMessage` type extends `OrchestrationMessage` (`apps/web/src/types.ts:41`), so contract fields reach the UI without query changes. The badge precedent is `ImportedMessageMarker` (`MessagesTimeline.tsx:1093-1102`) keyed off `message.source`.

## Goals / Non-Goals

**Goals:**

- Detect every turn served by a model other than the requested one — the first rerouted turn (explicit SDK signal) and all subsequent turns of a sticky session swap (implicit per-turn check).
- Persist the reroute on exactly one assistant message per affected turn, surviving reloads and streaming upserts.
- Display a compact, persistent badge in the web chat timeline with the refusal reason when available.

**Non-Goals:**

- Retracting or evicting the refused partial output (`retracted_message_uuids` / `supersedes`) — no message-delete command exists; refusal legs typically carry little text.
- Mobile UI (mobile doesn't render the handoff badge today either; follow-up).
- Toast/live-notification infrastructure for runtime events.
- Detection via `SDKResultMessage.modelUsage`.

## Decisions

### D1: Two-signal detection in `ClaudeAdapter`

**Primary — explicit SDK message.** New `case "model_refusal_fallback":` in `handleSystemMessage` (before the `default:` branch at `:~2783`): stash `{fromModel: original_model, toModel: fallback_model, reason: "refusal", category, explanation}` on `ClaudeTurnState` (mutable fields already exist, `:125-140`) and emit the `model.rerouted` runtime event (the `base` event object at `:2576-2589` already carries `turnId`).

**Secondary — per-turn served-model check.** The SDK docs state the swap is persistent for the session, and no further fallback message is emitted on later turns. So in `handleAssistantMessage` (`:~2461`), when `parent_tool_use_id === null`, no reroute is stashed for the turn yet, and `context.currentApiModelId` (`:188`) is set: compare the served model against the requested one. Requested ids are slugs (optionally suffixed `[1m]`, via `resolveClaudeApiModelId`, `ClaudeProvider.ts:373-379`) while served ids are fully versioned — strip the suffix and compare by prefix (`served.startsWith(requestedBase)`). On mismatch, stash + emit once per turn with `reason: "session-model-swap"`.

**Alternative considered — `modelUsage` keys on `SDKResultMessage`.** Rejected: it aggregates subagent usage (subagents legitimately run on other models), and it cannot say which model served the main loop. The `parent_tool_use_id === null` guard on the secondary check is the load-bearing subagent filter.

### D2: Reuse the existing `model.rerouted` event, extended

Extend `ModelReroutedPayload` (`providerRuntime.ts:555-560`) with optional `category` and `explanation`. Backward compatible; the Codex emitter is untouched. Alternative — a new event type — rejected: the semantic already exists and Codex-originated reroutes get persistence for free later.

### D3: Message-level `model_reroute_json` column

One nullable TEXT column on `projection_thread_messages` holding `{fromModel, toModel, reason, category?, explanation?}`.

- Mirrors the proven `attachments_json` pattern exactly — critical because reroute info arrives on one command while later streaming upserts for the same message must not wipe it (COALESCE-preserve).
- Message-level matches the badge precedent and rides the existing `OrchestrationMessage → ChatMessage` inheritance; no join or query-shape changes.
- **Alternative — turn-level storage** (`ProjectionTurns`): rejected; would require new joins in `ProjectionSnapshotQuery` and web-side turn→message stitching that doesn't exist.
- **Alternative — reuse `runtimePayload` on `ProviderSessionRuntime`**: rejected; session-scoped, not message-scoped, and not queried by the timeline.

### D4: Attach-once semantics in ingestion

`ProviderRuntimeIngestion` gets a stash keyed `${threadId}:${turnId}` (mirroring `bufferedProposedPlanById`, `:834-856`). On `model.rerouted` with a `turnId`, store the payload. In `finalizeAssistantMessage` (`:920-964`), attach it to the `thread.message.assistant.complete` command and **invalidate the stash on first attachment**, so exactly one message per turn carries the badge — no client-side dedupe. Clear leftovers on `turn.completed` (`:1542-1576`) and `session.exited` (`:1578-1580`). Decider (`decider.ts:765-791`) copies it into the `thread.message-sent` payload; projector (`projector.ts:384-441`) and `ProjectionPipeline` (`:863-905`) preserve prior values when a later payload omits it (same style as `attachments`).

### D5: UI as a persistent pill badge

`ModelRerouteMarker` in `MessagesTimeline.tsx`, modeled on `ImportedMessageMarker`: pill with icon + `Rerouted to {formatRerouteModelName(toModel)}`, wrapped in the already-imported Tooltip components; tooltip shows "Request to {fromModel} was served by {toModel}" plus category/explanation when present. Rendered in `AssistantTimelineRow` next to the handoff marker (`:1057`). `formatRerouteModelName` is a dumb prefix table in `MessagesTimeline.logic.ts` matching `BUILT_IN_MODELS` display names (`ClaudeProvider.ts:56-113`), falling back to the raw id.

Streaming: v1 badges on message completion (seconds after the reroute). Attaching the stash to assistant _delta_ commands (`ProviderRuntimeIngestion.ts:1387-1405`) is an optional enhancement — the preserve logic already supports it.

## Risks / Trade-offs

- [SDK type drift — `model_refusal_fallback` shape changes across SDK upgrades] → Detection is additive and guarded; the secondary per-turn check catches reroutes even if the explicit message disappears. Adapter tests pin the handled shape.
- [False positive on model-id aliasing (slug vs versioned id, `[1m]` suffix)] → Prefix comparison after suffix strip; tests cover the `[1m]` case and same-family versioned ids. Unknown served ids are recorded raw and displayed raw.
- [Refused-leg partial text remains in the timeline] → Documented limitation (non-goal); the `turn.completed` finalize sweep prevents dangling streaming messages.
- [Turn produces no assistant message (e.g., pure error)] → Reroute info dropped from projections; still present in the raw runtime event log. Acceptable.
- [Reroute event without `turnId`] → Skipped (no stash key). Acceptable; main-loop fallback messages carry turn context in practice.
- [Historical rows / rollback] → Column is additive and nullable; absent field decodes as `undefined`; old servers ignore the extra JSON column. No backfill, no rollback script needed.

## Migration Plan

1. Ship migration `033_ProjectionThreadMessagesModelReroute.ts` (`ALTER TABLE projection_thread_messages ADD COLUMN model_reroute_json TEXT`) — additive, runs on startup like 007.
2. Deploy contracts + server + web together (single repo; optional fields keep old payloads decodable).
3. No data backfill: pre-existing rerouted turns are undetectable retroactively and simply show no badge.

## Open Questions

- None blocking. Optional follow-ups tracked in tasks.md: streaming-delta badge, mobile display.
