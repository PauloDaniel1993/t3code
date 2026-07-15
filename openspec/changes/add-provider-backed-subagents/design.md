## Context

T3 Code routes provider work through configured provider instances, server-authoritative orchestration commands/events, provider session bindings, and projection read models. The current system already has:

- provider instance routing through `ModelSelection.instanceId`
- provider-scoped MCP credentials with capability gates
- a preview MCP toolkit
- provider runtime events for tool and collaboration activity
- durable thread handoff that preserves provider-session invariants by creating new target threads

Subagents must fit those boundaries. A subagent is not a transferred provider session and not a hidden one-off completion. It is a normal child thread with additional parent/child metadata, launched and managed through server-owned orchestration so state survives restarts and replay.

## Goals / Non-Goals

**Goals:**

- Let a tool-capable parent provider asynchronously launch child work on any ready configured provider/model.
- Let users launch and manage the same durable child work from the UI.
- Represent every subagent as a durable child thread with normal provider runtime events, messages, checkpoints, and provider session behavior.
- Keep parent/child linkage queryable from thread shells so the sidebar can render hierarchy without hydrating every child detail.
- Enforce feature gating, target allowlists, provider readiness, concurrency limits, timeouts, runtime policy, approval policy, and depth limits on the server.
- Provide async MCP tools for launch, status, read, and cancel.
- Provide bounded parent context and bounded child result summaries without importing full parent transcripts as visible child messages.
- Preserve replay and rolling decode compatibility for existing threads and clients.

**Non-Goals:**

- No nested subagent launches in v1.
- No live provider session transfer.
- No provider-native cross-provider fork API integration.
- No automatic retry of failed child runs.
- No ephemeral-only completion mode.
- No full sandbox profile model in v1; profiles include instructions and operational defaults only.
- No guarantee that non-tool-capable parent providers can launch subagents from inside a model turn.

## Decisions

### 1. Subagents are durable child threads

Each subagent launch creates a normal thread in the same project with `parentThreadId`, `parentTurnId`, `subagentRunId`, optional profile id, status, and result metadata. The child thread uses the standard provider session and turn machinery.

Alternatives considered:

- Ephemeral provider calls: rejected because they are hard to inspect, cancel, resume, or replay.
- In-place provider delegation inside the parent session: rejected because provider-native session state and tool streams are not portable or reliably attributable.

### 2. Launch is always async

`subagent_launch` returns a launch receipt immediately. Parent models use `subagent_status` and `subagent_read` later to observe results. UI launch follows the same async backend.

Alternatives considered:

- Blocking launch until child completion: rejected because long child runs can exceed provider/tool timeouts and block parent progress.
- Configurable sync/async: deferred to keep v1 smaller and to avoid ambiguous timeout behavior.

### 3. The server owns all policy decisions

The caller may request a profile, model selection override, runtime mode, timeout, and cancellation policy, but the server resolves and validates the effective launch. The server rejects or gates launches based on feature flag, child depth, target readiness, allowlist, concurrency, runtime mode, and approval policy.

Alternatives considered:

- Client-only gating: rejected because model-initiated MCP calls must be safe without trusting UI state.
- Provider-supplied policy: rejected because policy must be consistent across providers and restarts.

### 4. Provider-callable tools use the existing MCP capability model

Add a `subagents` MCP capability and a `SubagentToolkit` registered beside the preview toolkit. Provider-scoped MCP credentials include `subagents` only when the feature is enabled, the parent provider session is eligible, and the parent thread is not itself a subagent child.

Alternatives considered:

- A provider adapter-specific tool path: rejected because it would duplicate MCP plumbing and create uneven provider behavior.
- UI-only launch: rejected because the primary goal is one model call delegating to other provider models.

### 5. Context is bounded and summarized

The child prompt contains the explicit task prompt, profile instructions, parent metadata, and a bounded parent context summary. The parent transcript is not copied into the child as visible imported messages.

Alternatives considered:

- Full transcript injection: rejected because it increases cost, latency, and cross-provider leakage.
- Prompt only: rejected because it often lacks enough continuity for useful delegation.
- Handoff-style imported messages: rejected because subagents are task-scoped helpers, not provider handoffs.

### 6. Profiles are settings-backed shortcuts plus ad hoc overrides

Subagent profiles live in server settings and include display name, target model selection, instructions, default runtime mode, timeout, result summary budget, and enabled state. Launches may reference a profile or provide ad hoc overrides.

Alternatives considered:

- Ad hoc only: rejected because reusable roles such as reviewer, researcher, or Opus reviewer are core ergonomics.
- Profiles only: rejected because model callers need one-off delegation flexibility.
- Full sandbox profiles: deferred to a later spec because tool policy and workspace isolation need broader design.

### 7. Read-only by default, write-capable launches require approval

Subagents default to read-only runtime. Requests for write-capable runtime or other risky policy changes create a parent-thread approval request unless server settings explicitly allow them.

Alternatives considered:

- Inherit parent runtime: rejected because parallel write-capable agents can conflict in the same workspace.
- Separate worktree per writing child: deferred because lifecycle, cleanup, and merge UX are larger than v1.

### 8. Parent/child UI is projected data

Parent thread panels and sidebar hierarchy read from projection fields and lifecycle events, not from ad hoc in-memory state. Parent timeline rows are compact activities that link to child threads and summarize status changes.

Alternatives considered:

- Sidebar-only hierarchy: rejected because active parent threads need immediate visibility into running child work.
- Inline child result messages in parent transcript: rejected because it blurs provider-native parent conversation history.

### 9. Result reads are bounded summaries with links

`subagent_read` returns status, child thread id/title, final summary, key bounded excerpts, and diagnostics. Full child transcript stays in the child thread.

Alternatives considered:

- Full transcript return: rejected because MCP/tool payloads can become too large and leak unnecessary detail.
- Final message only: rejected because failures and tool evidence need structured diagnostics.

### 10. Additive persistence migration

Projection storage gains nullable linkage/status/result fields and indexes for child lookup. Existing rows decode with null/default subagent data.

Alternatives considered:

- JSON-only metadata: rejected because sidebar hierarchy and active child queries need efficient lookup.
- No persistence changes: rejected because subagents must survive restart and replay.

## Risks / Trade-offs

- [Concurrent child runs overload providers or the host] -> Enforce per-parent-turn and global concurrency caps with bounded settings.
- [Parallel write-capable children conflict in one workspace] -> Default to read-only and require approval for write-capable launches.
- [Parent model cannot use result in same turn] -> Provide explicit async status/read tools and UI visibility.
- [Cross-provider context leaks sensitive transcript data] -> Send bounded summaries by default, not full transcripts.
- [Child failure is hard to diagnose] -> Preserve child transcript, record structured status, and return diagnostics from `subagent_read`.
- [Older clients see new fields/events] -> Keep fields optional/null and preserve decode-safe defaults.
- [MCP credentials expose tools too broadly] -> Gate `subagents` capability per provider session and deny child-thread launch capability.
- [Sidebar hierarchy becomes expensive] -> Store parent linkage on shell projection rows and index parent/status fields.

## Migration Plan

1. Add decode-safe contracts for settings, profiles, run ids, statuses, commands, events, MCP tool inputs/outputs, and thread projection metadata.
2. Add an additive projection migration for parent/child linkage, subagent status, and result metadata.
3. Implement projector replay so existing threads project null subagent fields.
4. Add server settings defaults with Subagents disabled.
5. Implement the server subagent domain service and orchestration integration behind the feature flag.
6. Register the MCP toolkit only when the capability is present.
7. Add web surfaces and settings after backend state is stable.
8. Roll out disabled by default; users enable Subagents explicitly.

Rollback strategy:

- Disable the feature flag to hide provider-callable tools and UI launch controls.
- Existing child threads remain normal threads with inert metadata.
- Additive columns can remain unused if the feature is rolled back.

## Open Questions

No blocking v1 questions remain. Deferred follow-ups are full sandbox profiles, nested subagents, separate worktree isolation for write-capable children, synchronous launch mode, automatic retry policy, and richer cost budgeting.
