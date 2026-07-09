## 1. Contracts

- [ ] 1.1 Extend `ModelReroutedPayload` in `packages/contracts/src/providerRuntime.ts` (~555-560) with optional `category` and `explanation` fields
- [ ] 1.2 Add exported `MessageModelReroute` struct (`fromModel`, `toModel`, `reason`, optional `category`/`explanation`) in `packages/contracts/src/orchestration.ts`
- [ ] 1.3 Add optional `modelReroute` to `OrchestrationMessage` wire+value schemas (~242-268), `ThreadMessageSentPayload` wire+value (~1017-1062), and the `thread.message.assistant.complete` command schema
- [ ] 1.4 Add contract round-trip tests: decode `ThreadMessageSentPayload`/`OrchestrationMessage` with and without `modelReroute` (mirror handoff-source tests in `orchestration.test.ts` ~423-451)

## 2. Persistence

- [ ] 2.1 Create migration `apps/server/src/persistence/Migrations/033_ProjectionThreadMessagesModelReroute.ts`: `ALTER TABLE projection_thread_messages ADD COLUMN model_reroute_json TEXT` (match style of `007`); register it alongside existing migrations
- [ ] 2.2 Add `modelReroute` to the `ProjectionThreadMessage` schema in `apps/server/src/persistence/Services/ProjectionThreadMessages.ts` (~25-38)
- [ ] 2.3 In `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`: add `model_reroute_json` to the row schema (JSON-string codec), include it in insert and COALESCE-preserving upsert (mirror `attachments_json` at ~84-91, 105-108), and in all SELECTs + `toProjectionThreadMessage`
- [ ] 2.4 Add `model_reroute_json` to `ProjectionSnapshotQuery.ts`: `ProjectionThreadMessageDbRowSchema` (~73-81), `mapMessageRow` (~263-276), and both message SELECT statements (~441, ~808)

## 3. Orchestration pipeline

- [ ] 3.1 In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`: add a reroute stash keyed `${threadId}:${turnId}` (mirror `bufferedProposedPlanById` ~834-856) and a handler for `event.type === "model.rerouted"` that stores the payload when `turnId` is present
- [ ] 3.2 In `finalizeAssistantMessage` (~920-964): attach the stashed `modelReroute` to the `thread.message.assistant.complete` command and invalidate the stash on first attachment (exactly one badged message per turn)
- [ ] 3.3 Clear leftover stashes on `turn.completed` (~1542-1576) and `session.exited` (~1578-1580)
- [ ] 3.4 In `apps/server/src/orchestration/decider.ts` (~765-791): copy `command.modelReroute` into the `thread.message-sent` payload (optional spread)
- [ ] 3.5 In `apps/server/src/orchestration/projector.ts` (~384-441): include `modelReroute` when building `OrchestrationMessage`; preserve prior value in the existing-entry merge when the new payload omits it (same style as `attachments`)
- [ ] 3.6 In `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (~863-905): pass `modelReroute` to the repo upsert with fallback to `previousMessage?.modelReroute` (mirror `nextAttachments` ~880-885)
- [ ] 3.7 Ingestion tests: `model.rerouted` then assistant completion → command carries `modelReroute` exactly once per turn; stash cleared on `turn.completed`
- [ ] 3.8 Pipeline test: message-sent with `modelReroute` followed by a streaming upsert without it → column preserved

## 4. Claude adapter detection

- [ ] 4.1 Add mutable `modelReroute` field to `ClaudeTurnState` in `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~125-140)
- [ ] 4.2 Add `case "model_refusal_fallback":` to `handleSystemMessage` (before `default:` at ~2783): stash `{fromModel: original_model, toModel: fallback_model, reason: "refusal", category: api_refusal_category, explanation: api_refusal_explanation}` on turn state and emit `model.rerouted`
- [ ] 4.3 Add the per-turn served-model check in `handleAssistantMessage` (~2461): only for `parent_tool_use_id === null`, when no reroute is stashed for the turn and `context.currentApiModelId` is set; compare served `message.message.model` against the requested slug (strip `[1m]` suffix, prefix match); on mismatch stash + emit once with `reason: "session-model-swap"`
- [ ] 4.4 Adapter tests with a fake SDK stream: (a) fallback system message → one `model.rerouted` with from/to/category; (b) top-level assistant on another model family → one event per turn, not repeated; (c) `parent_tool_use_id` set → no event; (d) prefix match incl. `[1m]`-suffixed requested model → no event

## 5. Web UI

- [ ] 5.1 In `apps/web/src/components/chat/MessagesTimeline.logic.ts`: add `getMessageModelReroute(message)` and `formatRerouteModelName(modelId)` (prefix table: `claude-opus-4-8*` → "Opus 4.8", `claude-fable-5*` → "Fable 5", `claude-opus-4-7*` → "Opus 4.7"; fallback to raw id), next to `isImportedHandoffTimelineMessage` (~192-194)
- [ ] 5.2 In `MessagesTimeline.tsx`: add `ModelRerouteMarker` component modeled on `ImportedMessageMarker` (~1093-1102) — pill badge, icon, "Rerouted to {name}", tooltip with "Request to {fromModel} was served by {toModel}" plus category/explanation when present
- [ ] 5.3 Render the marker in `AssistantTimelineRow` (~1049-1091) next to the handoff marker (~1057), gated on `row.message.modelReroute`
- [ ] 5.4 Logic tests: `formatRerouteModelName` mapping and badge-presence derivation

## 6. Verification

- [ ] 6.1 Run server, contracts, and web test suites
- [ ] 6.2 Manual: run migration against an existing dev DB (additive, no errors) and load an old thread (no badges, no decode errors)

## 7. Optional follow-ups (not required for apply completion)

- [ ] 7.1 Attach the stashed `modelReroute` to assistant delta commands (`ProviderRuntimeIngestion.ts` ~1387-1405 and `flushBufferedAssistantMessage`) so the badge appears while the fallback leg is still streaming
- [ ] 7.2 Mobile: render the reroute indicator in `apps/mobile` thread detail (no badge infra exists there today)
