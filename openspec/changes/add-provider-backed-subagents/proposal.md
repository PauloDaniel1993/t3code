## Why

T3 Code can run multiple provider instances and already exposes provider-scoped MCP tools, but a running model cannot ask T3 Code to delegate work to another configured provider/model as a durable, inspectable subagent. Users need cross-provider delegation that is reliable under restarts, visible in the UI, and bounded for cost, safety, and load.

## What Changes

- Add first-class Subagents: durable child threads launched from a parent thread and backed by configured provider/model selections.
- Expose provider-callable async Subagent MCP tools for tool-capable parent providers: launch, status, read, and cancel.
- Add UI launch and management surfaces for the same backend capability.
- Add subagent profiles for reusable model/instruction/timeout/summary defaults while preserving ad hoc per-launch overrides.
- Add server-side policy enforcement for feature gating, provider readiness, target allowlists, concurrency, runtime mode, approvals, timeouts, cancellation, and depth limits.
- Add parent/child thread linkage, lifecycle events, projection fields, compact parent activity rows, sidebar hierarchy, and replay-safe result summaries.
- Keep v1 conservative: feature flag default off, read-only by default, policy-based approval for write-capable or risky launches, no nested subagents, no automatic retry.

## Capabilities

### New Capabilities

- `provider-backed-subagents`: Defines durable provider-backed subagent child threads, async MCP tools, UI management, settings/profiles, policy enforcement, persistence, and replay behavior.

### Modified Capabilities

- None.

## Impact

- Affected contracts:
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/settings.ts`
  - `packages/contracts/src/providerRuntime.ts`
- Affected server systems:
  - orchestration commands, events, decider, projector, and projection persistence
  - provider command reactor and parent interrupt behavior
  - MCP session capabilities and toolkit registration
  - provider-scoped MCP credential issuance
  - text generation / summary model resolution
  - server settings validation and persistence
  - observability metrics and structured logs
- Affected client runtime:
  - command helpers and state derivation for subagent launch/status/cancel flows
- Affected web systems:
  - active thread subagents panel
  - compact parent timeline activity rendering
  - sidebar child-thread hierarchy and status indicators
  - settings UI for feature flag, defaults, target allowlist, and profiles
- Affected persistence:
  - additive migration for child linkage, subagent status, and summary/result metadata
- Required verification:
  - focused contract, server, MCP, and web tests
  - `vp check`
  - `vp run typecheck`
