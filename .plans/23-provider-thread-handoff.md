# Provider Thread Handoff

## Goal

Add first-class handoff between LLM provider instances by creating a new target thread, importing
the useful source-thread transcript, and bootstrapping the first target-provider turn with bounded
handoff context.

This is a T3 Code native implementation. It must preserve the current provider-instance
architecture, where routing is based on `ProviderInstanceId`, not only provider kind. It must not
transfer provider-native session state, resume cursors, or hidden driver state across providers.

## Current Architecture Fit

- T3 Code already treats each provider instance as the owner of its own adapter, snapshot, and text
  generation implementation.
- Started threads currently reject provider-driver changes inside the same thread. That guard
  remains correct.
- The compatible handoff shape is:
  1. Source thread remains unchanged.
  2. New target thread is created in the same project.
  3. Source transcript is imported as marked messages.
  4. First native user turn in the target thread is wrapped with bounded handoff context.
- Existing provider-native `resumeCursor` values remain provider-local and are never copied from
  source thread to target thread.

## Product Decisions

- Handoff is a thread-level action available from the active chat header.
- A handoff always creates a new target thread.
- The target thread title is deterministic: `Handoff: <source title>`.
- The target thread copies the source project, branch, worktree path, runtime mode, and interaction
  mode for v1.
- Runtime mode, interaction mode, title, branch, and worktree editing are deferred follow-ups.
- The source thread is unchanged.
- Imported messages are visible in the target timeline and marked as imported.
- Imported messages are not sent to the target provider as ordinary chat turns.
- The first native target-thread user message gets a one-shot handoff wrapper.
- If the first target-provider send fails before a successful response, the handoff bootstrap stays
  pending and can be retried.
- If the first target-provider send succeeds, bootstrap completion is recorded through a
  deterministic internal command.
- Target choices include enabled provider instances that are configured and ready.
- Enabled but not-ready instances are shown disabled with a reason.
- Disabled providers are hidden by default.
- The exact same provider instance is shown disabled as `Already using this provider`.
- The same provider driver with a different instance is allowed.
- At least one importable source message is required.
- Handoff chains are allowed only after the source thread has at least one native message after its
  previous imported block.

## Non-Goals

- No live provider session transfer.
- No cross-provider resume cursor transfer.
- No attempt to call provider-native fork APIs across different drivers.
- No weakening of the existing started-thread model/provider switch guard.
- No Gemini, Kilo, Pi, or other new provider drivers as part of this change.
- No transcript-wide summarization in v1.
- No multi-source merge UI.
- No sidebar context-menu entry until the active chat flow is stable.
- No debug UI for generated handoff summaries in v1.

## DeepSeek Provider

DeepSeek is part of this implementation as a first-class built-in provider.

### Provider Shape

- Provider id: `deepseek`.
- Built-in models:
  - `deepseek-v4-pro`
  - `deepseek-v4-flash`
- Default chat model: `deepseek-v4-pro`.
- Default handoff compression model: `deepseek-v4-flash`.
- DeepSeek appears in normal provider selection and handoff target selection when enabled and ready.
- DeepSeek v1 includes both:
  - chat/session adapter
  - text generation implementation
- DeepSeek v1 does not support tools, file edits, approvals, or user-input requests.
- DeepSeek must never emit approval or user-input events.
- Unsupported capabilities return typed unsupported responses rather than partial fake behavior.

### Provider Settings

Add `DeepSeekSettings` to `packages/contracts/src/settings.ts`.

Fields:

```ts
{
  enabled: boolean; // hidden, default false
  baseUrl: string;
  contextLimit: number;
  customModels: readonly ProviderModelDefinition[]; // hidden, default []
}
```

Sensitive provider environment:

- `DEEPSEEK_API_KEY`

Environment override:

- `DEEPSEEK_BASE_URL`

Readiness rules:

- Enabled + API key + base URL + at least one model = ready.
- Enabled but missing API key or base URL = not ready with an actionable disabled reason.
- No startup API probe in v1. Readiness is configuration based.
- `requiresNewThreadForModelChange: false`.
- `showInteractionModeToggle: false`.

### API Client

Use Effect `HttpClient`, not an OpenAI SDK wrapper.

Recommended files:

- `apps/server/src/provider/Layers/DeepSeekApi.ts`
- `apps/server/src/provider/Layers/DeepSeekAdapter.ts`
- `apps/server/src/provider/Drivers/DeepSeekDriver.ts`
- `apps/server/src/textGeneration/DeepSeekTextGeneration.ts`

Rules:

- Use OpenAI-compatible Chat Completions.
- Normalize the base URL:
  - trim trailing slashes
  - if it already ends in `/chat/completions`, use it as-is
  - otherwise append `/chat/completions`
- Headers:
  - `Authorization: Bearer <DEEPSEEK_API_KEY>`
  - `Content-Type: application/json`
- Chat uses streaming.
- Text generation uses non-streaming.
- Parse SSE `data:` lines.
- Ignore SSE comments and keepalive lines.
- Stop on `[DONE]`.
- Read assistant text from `choices[].delta.content`.
- Read stop reason from `finish_reason`.
- Capture usage when returned.
- No retry for chat turns.
- One transient retry for text generation and handoff compression.
- Chat timeout: 10 minutes.
- Text generation/compression timeout: 90 seconds.
- Do not rely on provider JSON schema mode.
- Validate structured outputs locally.
- Never log API keys, full request bodies, full prompts, full completions, or generated summaries.

### DeepSeek Adapter Semantics

- `startSession` creates a local session and does not call the remote API.
- The adapter emits session started/state ready events after local session creation.
- `resumeCursor` is versioned JSON:

```ts
{
  "version": 1,
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

- Corrupt cursors fail `startSession` with a clear provider runtime error.
- `sendTurn` rejects concurrent sends for the same DeepSeek session.
- `sendTurn` resolves only after the streamed assistant response completes.
- Successful sends append the user and assistant exchange to the cursor.
- Failed or interrupted sends do not update the cursor.
- The built-in system prompt is injected at request time, not stored in the cursor.
- Old conversation is trimmed by `contextLimit`, preserving the latest user turn and handoff
  bootstrap context as much as possible.
- Current attachments are sent as metadata only in v1.

Normal event sequence:

```text
session.started
session.state.changed(running)
turn.started
content.delta...
item.completed(assistant_message)
turn.completed(completed)
session.state.changed(ready)
```

Failure sequence:

```text
runtime.error
turn.completed(failed)
session.state.changed(ready)
```

Interrupt sequence:

```text
turn.aborted
turn.completed(interrupted)
session.state.changed(ready)
```

## Text Generation Model Selection

Existing `textGenerationModelSelection` is a server settings value of type `ModelSelection`:

```ts
{
  instanceId: ProviderInstanceId;
  model: string;
  options?: ...
}
```

It currently chooses which provider instance/model handles auxiliary text-generation tasks such as
commit messages, PR descriptions, branch names, and thread titles. The picker is instance-aware: it
uses enabled/ready provider instances and their available models rather than hard-coding provider
kind.

This change keeps `textGenerationModelSelection` for existing tasks and adds a separate optional
handoff compression setting:

```ts
handoffCompressionModelSelection: ModelSelection | null
```

Resolution rules:

1. If `handoffCompressionModelSelection` points to an enabled/ready instance and model, use it.
2. If it is `null`, auto-resolve to the ready DeepSeek default instance with
   `deepseek-v4-flash` when available.
3. If DeepSeek is not ready, fall back to `textGenerationModelSelection`.
4. If an explicit compression selection becomes unavailable, fall back to auto resolution and log a
   warning.

The Settings UI adds a `Handoff compression model` row under `Text generation model` using the
existing `ProviderModelPicker`. `null` is exposed as automatic selection and the UI should show the
resolved model when possible.

## Contracts

### Message Source

Expose strict message sources:

```ts
type OrchestrationMessageSource =
  | "user"
  | "provider"
  | "system"
  | "handoff-import";
```

Add fields to `OrchestrationMessage` and `ThreadMessageSentPayload`:

```ts
{
  source: OrchestrationMessageSource;
  sourceThreadId?: ThreadId;
  sourceMessageId?: MessageId;
}
```

Historical event fallback:

- user role -> `user`
- assistant role -> `provider`
- system role -> `system`

Imported messages use:

- `source: "handoff-import"`
- `sourceThreadId`: immediate source thread id
- `sourceMessageId`: original source message id when available

### Handoff Metadata

Add versioned handoff metadata to `packages/contracts/src/orchestration.ts`.

```ts
type ThreadHandoffBootstrapStatus = "pending" | "completed" | "skipped";

type HandoffThreadMetadata = {
  schemaVersion: 1;
  sourceThreadId: ThreadId;
  sourceTitle: string;
  sourceProviderInstanceId: ProviderInstanceId;
  targetProviderInstanceId: ProviderInstanceId;
  importedMessageCount: number;
  visibleImportCapped?: boolean;
  bootstrapStatus: ThreadHandoffBootstrapStatus;
  bootstrapMessageId: MessageId | null;
  bootstrapCompletedAt?: IsoDateTime;
  bootstrapSkippedAt?: IsoDateTime;
  bootstrapSkipReason?: string;
  compression?: {
    summaries: ReadonlyArray<{
      sourceMessageId: MessageId;
      modelSelection: ModelSelection;
      sourceTextHash: string;
      summary: string;
      createdAt: IsoDateTime;
    }>;
  };
};
```

Add `handoff: HandoffThreadMetadata | null` to:

- `OrchestrationThread`
- `OrchestrationThreadShell`

Non-handoff threads project `handoff: null`.

### Commands

Client-dispatchable command:

```ts
{
  type: "thread.handoff.create";
  commandId: CommandId;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  targetModelSelection: ModelSelection;
  createdAt: IsoDateTime;
}
```

The command does not accept:

- project id
- title
- runtime mode
- interaction mode
- branch
- worktree path
- transcript

The server derives those values from the source thread/read model.

Internal commands:

```ts
{
  type: "thread.handoff.bootstrap.complete";
  commandId: CommandId;
  threadId: ThreadId;
  bootstrapMessageId: MessageId;
  providerTurnId: ProviderTurnId;
  completedAt: IsoDateTime;
}
```

Completion command id:

```text
server:handoff-bootstrap-complete:<threadId>:<messageId>
```

Optional skip command:

```ts
{
  type: "thread.handoff.bootstrap.skip";
  commandId: CommandId;
  threadId: ThreadId;
  reason: string;
  skippedAt: IsoDateTime;
}
```

### Events

`thread.handoff.create` emits, atomically and deterministically:

1. `thread.created` with handoff metadata.
2. Imported `thread.message-sent` events in chronological order.
3. `thread.activity-appended` with `Imported from <source title>`.

Bootstrap events:

- `thread.handoff-bootstrap-completed`
- optional `thread.handoff-bootstrap-skipped`

All handoff-create events aggregate the target thread id. The source thread is unchanged.

## Persistence

Add migration `999_ProviderThreadHandoff`.

This repo is a fork, so `999+` is the fork-local migration range for now. If this change is
upstreamed or rebased onto a main repo migration with a conflicting strategy, renumber to the next
upstream migration id before merging. The Effect migrator rejects duplicate numeric ids in one
build, so duplicate `033`-style ids must not coexist.

Storage changes:

- `projection_threads.handoff_json TEXT NULL`
- `projection_thread_messages.source TEXT NULL`
- `projection_thread_messages.source_thread_id TEXT NULL`
- `projection_thread_messages.source_message_id TEXT NULL`
- index on `projection_thread_messages.source_thread_id`

Backfill/read behavior:

- Existing rows decode source from role when `source` is null.
- Do not expose `"unknown"` as a public source.
- Projection code may backfill source values opportunistically, but contract output must use the
  strict source union.

## Import Rules

- Visible import cap: 2,000 messages.
- Bootstrap context budget: 80,000 chars before final provider request clamping.
- Import completed user, assistant, and system messages with text or attachments.
- Import attachment-only messages.
- Skip streaming assistant messages.
- Skip transient UI-only optimistic messages.
- Preserve imported message original `createdAt` and `updatedAt` in payload.
- Use handoff creation time for the emitted event `occurredAt` so the target thread becomes recent.
- Sort imported messages by original timestamp, then generated imported message id.
- Imported message ids are deterministic from target thread id and source message id, for example:

```text
handoff:<targetThreadId>:<sourceMessageId>
```

- Imported messages use `turnId: null`.
- Chain handoffs import the visible transcript, including previous imported messages.
- `sourceThreadId` always points to the immediate source thread.
- Imported user messages do not count for:
  - `latestUserMessageAt`
  - first-user title generation
  - branch generation
  - revert eligibility
- Target `updatedAt` advances to handoff creation time.

## Bootstrap Context

Recommended helper:

- `apps/server/src/orchestration/threadHandoff/bootstrapContext.ts`

Responsibilities:

- pure text construction
- deterministic trimming
- escaping/fencing imported content
- attachment metadata formatting
- small Effect wrapper for compression/cache integration

Injection point:

- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- after `ensureSessionForThread`
- before `toNonEmptyProviderInput`

Wrap when all are true:

- target thread has `handoff.bootstrapStatus === "pending"`
- current user message is the first non-imported user message after import
- no bootstrap is already in flight for the target thread

Do not mutate stored messages. Only the provider input is wrapped.

Wrapper shape:

```xml
<handoff_context>
Source title: ...
Source provider instance: ...
Target provider instance: ...
Branch: ...
Worktree: ...
...
</handoff_context>
<latest_user_message>
...
</latest_user_message>
```

Include:

- source title
- source provider instance id
- target provider instance id
- branch and worktree
- trimming notice when relevant
- recent imported messages
- imported attachment metadata only
- terminal/element context blocks already present on the latest user message

Limits:

- Initial bootstrap context budget: 80,000 chars.
- Existing final provider input clamp remains `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`.
- If the latest user message is large, shrink handoff context first.
- Escape/fence imported content to reduce instruction spoofing.
- Never log full context.

In-flight behavior:

- Track `handoffBootstrapInFlight` in memory by target thread id.
- Add before wrapped send.
- Remove only if context construction or `sendTurn` fails before successful response.
- Do not remove after a successful first response.
- A second user message while the first turn is running must not be wrapped.

Completion behavior:

- Existing ACP-style adapters return from `sendTurn` after provider completion, so mark bootstrap
  completed after `sendTurn` resolves successfully.
- If dispatching the completion command fails, log and retry the deterministic internal command
  with backoff while the reactor is alive.

## Handoff Compression

Extend the `TextGeneration` service with:

```ts
generateHandoffSummary(input): Effect<{ summary: string }, ...>
```

Input:

```ts
{
  cwd: string;
  sourceThreadTitle: string;
  role: "user" | "assistant" | "system";
  messageText: string;
  attachmentMetadata: readonly string[];
  modelSelection: ModelSelection;
}
```

Output:

```ts
{ summary: string }
```

Implementation:

- Add `buildHandoffSummaryPrompt` to `TextGenerationPrompts.ts`.
- Add `sanitizeHandoffSummary` to `TextGenerationUtils.ts`.
- Summary max: 4,000 chars.
- Feed the summarizer a bounded head/tail sample around 80,000 chars, not unbounded full text.
- Prompt must preserve:
  - file paths
  - commands
  - error messages
  - design decisions
  - constraints
  - unresolved tasks
- Compress only oversized individual imported messages in v1.
- Compression is lazy on the first bootstrap send, not during `thread.handoff.create`.
- Use cached summaries from target thread handoff metadata when the cache key matches.
- Cache key:
  - `sourceMessageId`
  - `modelSelection`
  - `sourceTextHash`
- `sourceTextHash` is SHA-256 hex of role, text, and attachment metadata.
- On malformed JSON or transient summarizer failure, retry once.
- On final failure, use deterministic head/tail truncation with a warning line.
- If cache write fails, log and continue; the next retry can regenerate.
- Summaries are not visible in the UI in v1.

## Server Implementation

Recommended areas:

- `apps/server/src/provider/builtInDrivers.ts`
- `apps/server/src/provider/ProviderDriver.ts`
- `apps/server/src/provider/Layers/DeepSeekApi.ts`
- `apps/server/src/provider/Layers/DeepSeekAdapter.ts`
- `apps/server/src/provider/Drivers/DeepSeekDriver.ts`
- `apps/server/src/textGeneration/DeepSeekTextGeneration.ts`
- `apps/server/src/textGeneration/TextGeneration.ts`
- `apps/server/src/textGeneration/TextGenerationPrompts.ts`
- `apps/server/src/textGeneration/TextGenerationUtils.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/commandInvariants.ts`
- `apps/server/src/orchestration/threadHandoff/*`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/persistence/migrations/999_ProviderThreadHandoff.ts`

Server requirements:

- Validate source thread exists, is not deleted, and has importable messages.
- Validate target thread id is absent.
- Validate target provider readiness.
- Validate `targetModelSelection.instanceId` matches the selected target instance.
- Create target thread in same project.
- Derive target title, runtime mode, interaction mode, branch, and worktree from source.
- Emit imported messages after `thread.created`.
- Keep command handling idempotent through command receipts.
- Ensure projection replay is deterministic.
- Ensure shell summary/latest-user logic ignores imported user messages.
- Ensure branch/title generation uses native user messages only.
- Ensure revert is hidden or blocked for imported user messages.

## Web And Client Runtime

Client runtime:

- Add `handoffThread` in `packages/client-runtime/src/operations/commands.ts`.
- Expose `threadEnvironment.handoff` in
  `packages/client-runtime/src/state/threadCommands.ts`.
- Use command concurrency keyed by `sourceThreadId`.
- UI generates `targetThreadId`.
- Server rejects existing target ids.

Web domain helpers:

- Add pure helpers under `apps/web/src/threadHandoff/`.
- Resolve target instances from existing provider instance derivation and settings helpers.
- Eligibility and target selection must be testable without React rendering.

Target initial selection precedence:

1. Sticky target instance choice for the source provider instance.
2. Project default when ready and not the same instance.
3. First ready target instance.

Model selection precedence:

1. Sticky model for selected target instance.
2. Project default model if it belongs to the selected target instance.
3. Target instance default model.

Store sticky target instance/model client-side, keyed by source provider instance.

UI:

- Add a `ThreadActionsMenu` to the active chat header.
- Use `MoreHorizontalIcon` for the menu button.
- First action: `Hand off to...` with `ArrowRightLeftIcon`.
- Show disabled state and reason when source thread is not eligible.
- Add `apps/web/src/components/threadHandoff/ThreadHandoffDialog.tsx`.
- Dialog shows:
  - source title
  - current provider instance
  - target provider instances
  - target model picker
  - disabled reasons
  - importable message count
- No transcript preview in v1.
- No runtime/mode/branch/worktree/title controls in v1.
- Dispatch command, close after command ack, then wait up to 3 seconds for the target shell/detail.
- Navigate to the target thread when it appears.
- On timeout, toast and remain on the source thread.
- Copy source unsent composer draft to the target draft after target appears.
- Do not clear the source draft.

Timeline rendering:

- Imported messages render expanded by default.
- Show a subtle `Imported` marker near timestamp/meta.
- Copy controls remain.
- Hide revert for imported user messages.
- Imported assistant messages do not show turn diff/change files/running/copy-streaming behavior.
- Show activity row `Imported from <source title>`.

Deferred UI:

- Sidebar thread context menu handoff.
- Debug view for handoff context and generated summaries.
- Target title/branch/worktree/runtime editing.

## Testing

Contract tests:

- Existing/historical message payloads decode with role-derived source.
- Handoff command schema validates target model selection.
- Handoff metadata round-trips.
- Imported message events preserve source metadata.
- DeepSeek settings decode defaults and readiness fields.
- `handoffCompressionModelSelection` decodes `null` as automatic.

Server tests:

- `thread.handoff.create` creates target thread plus imported messages.
- Reject missing source, deleted source, empty source, wrong project, and existing target id.
- Reject not-ready target provider.
- Projection replay produces stable target detail and shell snapshots.
- Shell latest-user metadata ignores imported user messages.
- Bootstrap helper trims deterministically.
- Bootstrap helper preserves latest user message and attachment metadata.
- Provider command reactor wraps the first native target turn exactly once.
- Provider command reactor leaves bootstrap pending if `sendTurn` fails.
- Provider command reactor records completion after successful `sendTurn`.
- Source thread `resumeCursor` is never passed to target provider.
- DeepSeek adapter streams content, persists cursor on success, and skips cursor update on failure.
- DeepSeek text generation handles successful output, malformed output retry, and fallback.

Web tests:

- Eligibility blocks running, approval-waiting, input-waiting, archived, deleted, and empty source
  threads.
- Handoff chain guard requires a native message after prior imports.
- Target provider list is instance-aware.
- Current exact provider instance is disabled.
- Enabled not-ready target instances show reasons.
- Initial target selection follows sticky, project default, then first ready.
- Target model selection follows sticky, project default, then default model.
- Dispatch payload includes only source thread id, target thread id, target model selection, and
  createdAt.
- Dialog navigates after target appears and toasts on timeout.
- Imported messages render with imported marker and no revert action.

Required checks:

- `vp check`
- `vp run typecheck`

If native mobile code changes:

- `vp run lint:mobile`

## Manual Verification

Use a separate `--base-dir` or `T3CODE_HOME` so the current installed runtime state is not touched.

1. Configure an existing provider instance and a DeepSeek instance.
2. Set DeepSeek API key and base URL through the provider secret/environment path.
3. Confirm DeepSeek appears in provider selection when enabled and ready.
4. Create a source thread and complete at least one assistant response.
5. Hand off to DeepSeek.
6. Confirm the target thread contains imported transcript messages.
7. Send the first target-thread message and confirm the provider receives handoff context.
8. Send a second target-thread message and confirm the context is not re-wrapped.
9. Interrupt or fail a first target send and confirm the next attempt retries bootstrap context.
10. Attempt in-thread provider switching on a started source thread and confirm the existing guard
    still blocks incompatible switches.
11. Configure handoff compression explicitly, then disable that target and confirm auto fallback.

## Implementation Order

1. Add contracts for DeepSeek settings, handoff metadata, message source, commands, events, and
   handoff compression model selection.
2. Add migration `999_ProviderThreadHandoff` and projection storage/read fallback.
3. Implement DeepSeek API, adapter, driver, text generation, settings metadata, and provider
   registration.
4. Extend text generation with handoff summary prompts, sanitizer, compression resolver, and
   provider implementations.
5. Implement server handoff decider/projector logic and imported transcript projection.
6. Implement bootstrap context helper and deterministic trimming/compression cache.
7. Integrate bootstrap wrapping/completion into `ProviderCommandReactor`.
8. Add client runtime handoff command helpers.
9. Add web handoff domain helpers and tests.
10. Add active chat header menu, handoff dialog, navigation behavior, and imported-message
    rendering.
11. Run automated checks and isolated manual verification.

## Deferred Follow-Up Plan

Track these for a later implementation pass:

- Sidebar thread context-menu handoff action.
- Target title, branch, worktree, runtime mode, and interaction mode controls in the handoff dialog.
- Debug UI for handoff bootstrap context and generated summaries.
- Transcript-wide summarization when many medium-sized messages exceed the bootstrap budget.
- Provider capability matrix for handoff-specific target filtering beyond basic readiness.
- Import pruning UI for users who want to exclude specific source messages.
- Upstream migration renumbering if this fork-local `999` migration is proposed upstream.
- Server-side target provider readiness validation once provider readiness is available to the
  orchestration decider without coupling command handling to live adapter state.
- Source-thread pending approval/user-input validation beyond the current projected running-turn
  guard when those waiting states are available in the read model.
- Broader bootstrap retry and concurrent-send UX coverage, including failed first sends,
  completion-dispatch retry visibility, and user messaging when bootstrap remains pending.
- Optional target auto-start or first-message follow-up flow after handoff navigation.

## Open Questions

No blocking product questions remain for v1. Unspecified details should follow the recommendations
captured in this plan and the existing T3 Code provider/session architecture.
