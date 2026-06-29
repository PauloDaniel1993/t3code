## Context

T3 Code routes provider work through provider instances. A `ProviderInstance` owns its adapter,
snapshot, and text generation implementation, and started threads intentionally reject incompatible
provider changes inside the same thread. That makes an in-place "switch this thread to another LLM"
unsafe: native session cursors, hidden provider state, tool state, and continuation semantics are
not portable across providers.

The compatible design is a new-thread handoff. The source thread remains intact, the target thread
imports visible transcript history as marked data, and the first native target-provider turn gets a
bounded context wrapper that explains the imported history.

The change also introduces DeepSeek as a first-class provider. DeepSeek is the preferred default
for handoff compression when configured, but it must still behave like any other provider instance
in normal chat and target selection.

## Goals / Non-Goals

**Goals:**

- Preserve provider-instance and started-thread invariants.
- Create target threads through server-authoritative orchestration commands and events.
- Make imported transcript history visible and distinguishable from native target-provider output.
- Bootstrap the first target-provider turn with deterministic, bounded, retryable context.
- Add DeepSeek as a first-class provider with chat/session and text-generation support.
- Add a separate handoff compression model setting that can auto-resolve to DeepSeek flash.
- Keep implementation testable through contract, server, and web domain tests.

**Non-Goals:**

- No live provider session transfer.
- No cross-provider resume cursor transfer.
- No provider-native fork API integration across drivers.
- No weakening of the in-thread model/provider switch guard.
- No transcript-wide summarization in v1.
- No sidebar handoff entry in v1.
- No target title, branch, worktree, runtime mode, or interaction mode editing in v1.

## Decisions

### 1. Handoff creates a new target thread

The system will represent a handoff as `source thread -> target thread`, not as an in-place provider
switch. The target thread is created in the same project and copies source runtime mode,
interaction mode, branch, and worktree path for v1.

Alternatives considered:

- In-place provider switch: rejected because existing session state and `resumeCursor` values are
  provider-native and not portable.
- Provider-specific fork APIs: rejected for v1 because they would create uneven behavior across
  providers and would not solve cross-provider transfer.

### 2. The server derives all handoff state

The client dispatches only source thread id, target thread id, target model selection, command id,
and timestamp. The server derives the source project, title, branch, worktree, runtime mode,
interaction mode, and transcript from the read model.

Alternatives considered:

- Client-supplied transcript: rejected because the server is the authoritative event source and the
  client could be stale or partially hydrated.
- Client-supplied title/runtime overrides: deferred to keep v1 deterministic and smaller.

### 3. Imported messages are first-class projected data

Imported messages use strict source metadata: `handoff-import`, immediate `sourceThreadId`, and
original `sourceMessageId` when available. Existing historical rows decode source from role.
Projection storage gains nullable source columns and `handoff_json` on projected threads.

Alternatives considered:

- Store imported transcript only in handoff metadata: rejected because timeline rendering,
  replay, and copy behavior should work from the normal message model.
- Expose an `unknown` source for old rows: rejected because public contracts should remain
  meaningful; role-derived fallback is sufficient.

### 4. Bootstrap context is one-shot and retryable

The first native target-thread user message is wrapped while handoff bootstrap is pending. The
stored message is not mutated. The reactor wraps only provider input, tracks in-flight bootstrap by
thread id, and records completion after `sendTurn` resolves successfully. If construction or send
fails before success, the bootstrap remains pending.

Alternatives considered:

- Mark complete immediately after dispatch acceptance: rejected because existing adapters usually
  resolve after a complete provider turn, and retrying after a failed first response is more useful.
- Import messages as provider turns: rejected because it would pretend the target provider had
  participated in prior conversation and would bloat provider session history.

### 5. DeepSeek is a normal provider, not a hidden compression service

DeepSeek is registered as a built-in provider with `deepseek-v4-pro` and `deepseek-v4-flash`.
It appears in normal provider selection and handoff target selection when enabled and ready.
The only special default is that handoff compression auto-selects DeepSeek flash when available.

Alternatives considered:

- Compression-only DeepSeek integration: rejected because users also want to hand off to DeepSeek
  and because provider architecture already has first-class driver boundaries.
- OpenAI SDK wrapper: rejected in favor of Effect `HttpClient` so the implementation matches local
  runtime patterns and avoids adding a broad dependency.

### 6. Compression gets its own model setting

The existing `textGenerationModelSelection` continues to power existing auxiliary generation.
Handoff compression uses `handoffCompressionModelSelection: ModelSelection | null`, where `null`
means automatic resolution: DeepSeek flash when ready, otherwise existing text generation model.

Alternatives considered:

- Reuse `textGenerationModelSelection` directly: rejected because handoff compression has a
  different cost/latency profile and should default to a cheaper model when available.
- Hard-code DeepSeek for compression: rejected because handoff must still work without DeepSeek.

### 7. UI starts in the active chat header

The v1 UI adds `Hand off to...` to an active thread actions menu, opens a compact dialog, dispatches
the command, waits briefly for the target shell/detail, and navigates. Sidebar context menus are
deferred until the core flow is stable.

Alternatives considered:

- Sidebar-first UX: rejected for v1 because active chat has the freshest eligibility context and
  fewer competing menu interactions.
- Auto-send after handoff creation: rejected because the user should decide the first native target
  prompt.

### 8. Use fork-local migration id 999

The migration is named `999_ProviderThreadHandoff`. This fork can reserve `999+` as a local range
while upstream continues normal numbering. If upstreaming later, the migration must be renumbered
to the next upstream id because the migrator rejects duplicate numeric ids in one build.

Alternatives considered:

- `033_0ProviderThreadHandoff`: rejected because it creates a high collision risk during rebase
  and duplicate numeric ids cannot coexist.

## Risks / Trade-offs

- [Large transcripts exceed provider limits] -> Use an 80,000 char bootstrap budget, final
  provider input clamping, per-message compression, and deterministic trimming.
- [Imported history is mistaken for target-provider output] -> Mark imported messages in data and
  UI, hide target-provider-only actions for imported assistant messages, and render an import
  activity row.
- [Failed first target send could lose bootstrap] -> Record completion only after successful
  `sendTurn`; keep pending on construction/send failure.
- [Compression failures block handoff] -> Retry once, then deterministic head/tail fallback with a
  warning line.
- [DeepSeek API compatibility differs from the OpenAI shape] -> Keep the API layer small, validate
  locally, and write adapter tests around streaming, malformed events, and errors.
- [Fork migration id conflicts later] -> Document the `999+` range and renumber before upstreaming.

## Migration Plan

1. Add contracts for handoff metadata, message source, commands, events, DeepSeek settings, and
   handoff compression model selection.
2. Add projection storage migration `999_ProviderThreadHandoff`.
3. Backfill or read-fallback message source from role for existing rows.
4. Implement DeepSeek provider and text generation support behind normal provider readiness.
5. Implement handoff command handling, projection, imported messages, and replay stability.
6. Add bootstrap context wrapping, compression, and completion dispatch.
7. Add client runtime command helpers and web UI.
8. Verify with `vp check`, `vp run typecheck`, and isolated manual runtime state.

Rollback strategy:

- Before user data depends on the feature, disable/hide the handoff UI and DeepSeek provider
  registration if needed.
- The persistence migration is additive. Older code will not understand handoff metadata, so a true
  rollback after use requires either keeping the columns unused or migrating the runtime state back
  from backup.

## Open Questions

No blocking v1 questions remain. Deferred follow-ups are sidebar handoff actions, target
title/branch/worktree/runtime editing, debug UI for handoff context/summaries, transcript-wide
summarization, import pruning, and upstream migration renumbering.
