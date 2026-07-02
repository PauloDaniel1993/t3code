## 1. Contracts And Settings

- [ ] 1.1 Add `SubagentRunId`, `SubagentRunStatus`, launch/status/read/cancel schemas, profile schemas, and settings schemas to `packages/contracts`
- [ ] 1.2 Add decode-safe defaults for disabled Subagents, conservative concurrency, read-only runtime, null default model, null summary model, target allowlist, and empty profiles
- [ ] 1.3 Add child-thread metadata fields to thread shell/detail contracts with null historical defaults
- [ ] 1.4 Add subagent lifecycle command and event schemas for launch requested, launched, status changed, result summarized, and cancel requested
- [ ] 1.5 Extend MCP-related contract types with `subagents` capability and Subagent toolkit input/output payloads
- [ ] 1.6 Add contract tests for new schemas, defaults, historical decode behavior, and invalid payload rejection

## 2. Persistence And Projection

- [ ] 2.1 Add additive migration for parent thread id, parent turn id, subagent run id, profile id, status, metadata JSON, and result JSON projection fields
- [ ] 2.2 Add indexes for children by parent thread id, active children by parent turn/status, and run id lookup
- [ ] 2.3 Update projection writes and reads for new thread shell/detail fields
- [ ] 2.4 Update replay projection so existing threads produce null subagent metadata
- [ ] 2.5 Add projection query helpers for parent child lists and active child runs
- [ ] 2.6 Add migration, projection, and replay tests for existing rows, child lookup, status updates, and result metadata

## 3. Server Domain Service

- [ ] 3.1 Add a server subagent domain module for effective launch resolution, profile lookup, default model resolution, target allowlist checks, and provider readiness checks
- [ ] 3.2 Implement feature flag, depth limit, deleted/archived parent, missing target, disabled profile, and unready provider rejection paths
- [ ] 3.3 Implement per-parent-turn and global concurrency accounting with bounded settings validation
- [ ] 3.4 Implement launch approval policy for write-capable runtime and other restricted launch requests
- [ ] 3.5 Implement deterministic child thread title and subagent run id handling
- [ ] 3.6 Add domain tests for resolution, rejection reasons, allowlist behavior, profile overrides, defaults, and concurrency bounds

## 4. Orchestration Integration

- [ ] 4.1 Add decider handling for subagent launch, approval acceptance/decline, status changes, result summary, and cancellation events
- [ ] 4.2 Ensure successful launch emits child `thread.created`, child user `thread.message-sent`, child `thread.turn-start-requested`, and parent activity events in deterministic order
- [ ] 4.3 Ensure launch approvals create parent-thread pending request/activity and do not start child provider work before acceptance
- [ ] 4.4 Ensure declined approvals mark the run rejected or cancelled without starting a child provider turn
- [ ] 4.5 Add parent activity rows for launch, running, completed, failed, cancelled, and timed-out states
- [ ] 4.6 Add orchestration tests for successful launch, approval gating, decline, event order, idempotent command receipts, and replay stability

## 5. Context And Summary Generation

- [ ] 5.1 Add pure builder for child task prompt with task input, profile instructions, parent metadata, and bounded parent context summary
- [ ] 5.2 Reuse existing text generation infrastructure to resolve `subagents.summaryModelSelection`, falling back to `textGenerationModelSelection` when null
- [ ] 5.3 Add bounded parent-context summarization with deterministic fallback when summary generation fails
- [ ] 5.4 Add child-result summarization with summary budget, bounded excerpts, diagnostics, and deterministic fallback
- [ ] 5.5 Ensure full parent transcript is not copied into child visible messages
- [ ] 5.6 Add tests for prompt construction, context bounds, summary model resolution, fallback behavior, and transcript non-import

## 6. MCP Toolkit And Capability Gating

- [ ] 6.1 Extend `McpCapability` with `subagents` and update provider-scoped credential issuance to include it only for eligible parent sessions
- [ ] 6.2 Add `SubagentToolkit` with `subagent_launch`, `subagent_status`, `subagent_read`, and `subagent_cancel`
- [ ] 6.3 Wire toolkit handlers to the server subagent domain service and orchestration dispatch path
- [ ] 6.4 Ensure child threads never receive launch capability while still allowing other eligible MCP capabilities
- [ ] 6.5 Return structured MCP errors for disabled feature, ineligible parent, invalid target, approval pending, unknown run, and permission denied
- [ ] 6.6 Add MCP tests for capability presence/absence, schema validation, successful launch receipt, status/read/cancel behavior, and error mapping

## 7. Timeout, Cancellation, And Reactor Behavior

- [ ] 7.1 Add server-side timeout scheduling for effective child run timeouts
- [ ] 7.2 Mark timed-out runs, interrupt provider work when possible, preserve partial transcript, and append parent activity
- [ ] 7.3 Implement explicit child-only cancellation from UI and MCP tools
- [ ] 7.4 Implement configurable parent-interrupt cascade for active child runs associated with the parent turn
- [ ] 7.5 Ensure failed provider turns mark child runs failed and preserve diagnostics
- [ ] 7.6 Add tests for timeout, explicit cancellation, parent cascade enabled, parent cascade disabled, provider failure, and partial transcript preservation

## 8. Client Runtime

- [ ] 8.1 Add client-runtime command helpers for UI-launched subagents and cancellation
- [ ] 8.2 Add thread state derivation helpers for child lists, active child counts, terminal statuses, and disabled launch reasons
- [ ] 8.3 Add settings patch helpers for Subagents feature flag, defaults, allowlist, concurrency, summary model, and profiles
- [ ] 8.4 Add client-runtime tests for command payload shape, concurrency state derivation, child hierarchy derivation, and settings patch behavior

## 9. Web UI

- [ ] 9.1 Add active thread Subagents panel with child status, provider/model, profile, elapsed time, open-thread, cancel, and read-summary controls
- [ ] 9.2 Add UI launch flow from the parent thread using the same server policy and disabled-reason helpers
- [ ] 9.3 Add compact parent timeline activity rows for subagent lifecycle events with child-thread links
- [ ] 9.4 Add sidebar hierarchy for child threads using shell projection data and status indicators
- [ ] 9.5 Add settings UI for feature flag, default target model, summary model, concurrency, target allowlist, and profile management
- [ ] 9.6 Add web tests for launch gating, panel rendering, cancel/read actions, timeline activities, sidebar nesting, and settings/profile editing

## 10. Observability And Operations

- [ ] 10.1 Add structured logs for launch accepted, rejected, approval pending, started, completed, failed, cancelled, and timed out
- [ ] 10.2 Add metrics for launch counts, active child count, durations, terminal statuses, rejection reasons, provider instance, model, and profile labels
- [ ] 10.3 Ensure logs and metrics avoid sensitive prompt or summary content
- [ ] 10.4 Add focused tests for observability attributes where local metric/log helpers support assertions

## 11. Verification

- [ ] 11.1 Run focused contract tests for new schemas and defaults
- [ ] 11.2 Run focused server tests for domain, orchestration, projection, MCP, timeout, cancellation, and summary behavior
- [ ] 11.3 Run focused web/client-runtime tests for UI/domain/settings behavior
- [ ] 11.4 Run `vp check`
- [ ] 11.5 Run `vp run typecheck`
- [ ] 11.6 Manually verify with an isolated runtime state directory that an enabled Subagents setup can launch, inspect, read, cancel, and replay durable child threads
