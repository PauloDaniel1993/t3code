## Why

When a turn requested on `claude-fable-5` is declined by its safety classifiers, the Claude Agent SDK transparently retries the turn on `claude-opus-4-8` and keeps that swap for the rest of the session. Today t3code surfaces nothing — the user believes Fable 5 produced the response, which misrepresents provenance, quality expectations, and cost. The SDK already emits the signals needed to detect this (`model_refusal_fallback` system message plus the serving model on every assistant message), and the runtime contract already defines a `model.rerouted` event that nothing consumes yet.

## What Changes

- `ClaudeAdapter` detects model reroutes two ways: the explicit `model_refusal_fallback` SDK system message (first rerouted turn), and a per-turn comparison of the serving model on top-level assistant messages against the requested model (subsequent turns of a sticky session swap). Subagent messages never trigger detection.
- The adapter emits the existing `model.rerouted` provider-runtime event (extended with optional `category`/`explanation` fields) — its first real consumer.
- Orchestration ingestion attaches the reroute info to exactly one assistant message per rerouted turn via the `thread.message.assistant.complete` command; the decider/projector/projection pipeline persist it.
- New nullable `model_reroute_json` column on `projection_thread_messages` (additive migration, COALESCE-preserving upsert like `attachments_json`).
- `OrchestrationMessage` contract gains an optional `modelReroute` field, flowing to the web client automatically.
- Web chat timeline renders a persistent pill badge on the affected assistant message ("Rerouted to Opus 4.8") with a tooltip showing the refusal category/explanation when available.

Non-goals: retracting/evicting the refused partial output (`retracted_message_uuids`), a mobile badge, toast/notification infrastructure, and any use of `modelUsage` aggregates for detection.

## Capabilities

### New Capabilities

- `model-reroute-indicator`: detecting when a turn was served by a different model than requested (safety-refusal fallback and sticky session swap), persisting that fact on the assistant message, and displaying it in the chat UI.

### Modified Capabilities

<!-- none — no existing spec's requirements change -->

## Impact

- **Server**: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (detection + event emission), `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (per-turn stash + command attachment), `decider.ts`, `projector.ts`, `ProjectionPipeline.ts`, `persistence/Services|Layers/ProjectionThreadMessages.ts`, `ProjectionSnapshotQuery.ts`, new migration `033_ProjectionThreadMessagesModelReroute.ts`.
- **Contracts**: `packages/contracts/src/providerRuntime.ts` (`ModelReroutedPayload` optional fields), `packages/contracts/src/orchestration.ts` (`MessageModelReroute`, `OrchestrationMessage`, `ThreadMessageSentPayload`, assistant-complete command).
- **Web**: `apps/web/src/components/chat/MessagesTimeline.tsx` + `MessagesTimeline.logic.ts` (badge component and helpers).
- **Database**: one additive nullable column; historical rows unaffected (no badge).
- **Dependencies**: none added; relies on `@anthropic-ai/claude-agent-sdk` ≥ 0.3.x types already installed (`SDKModelRefusalFallbackMessage`, `SDKAssistantMessage.message.model`).
