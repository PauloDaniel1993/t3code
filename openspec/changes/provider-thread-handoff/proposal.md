## Why

T3 Code can run multiple provider instances, but a started thread is intentionally bound to its
provider session. Users need a predictable way to continue useful context with a different provider
without weakening provider-session invariants or copying incompatible native resume state.

## What Changes

- Add provider thread handoff as a first-class thread action that creates a new target thread from
  a source thread.
- Import the source transcript into the target thread as marked imported messages while leaving the
  source thread unchanged.
- Bootstrap the first native target-provider turn with bounded handoff context instead of sending
  imported messages as normal provider turns.
- Add handoff metadata, message source tagging, commands, events, projection storage, and a
  fork-local `999_ProviderThreadHandoff` migration.
- Add DeepSeek as a first-class built-in provider with `deepseek-v4-pro` and
  `deepseek-v4-flash`, including chat/session adapter and text generation support.
- Add a separate handoff compression model setting that defaults automatically to DeepSeek flash
  when available and falls back to the existing text generation model selection.
- Add active-chat UI for `Hand off to...`, a target provider/model dialog, target navigation, and
  imported-message timeline rendering.
- Preserve the current in-thread provider switch guard; handoff is a new-thread workflow, not a
  model switch inside an existing provider session.

## Capabilities

### New Capabilities

- `provider-thread-handoff`: Creates a target thread from a source thread, imports transcript
  history, records handoff state, and bootstraps the first target turn with bounded context.
- `deepseek-provider`: Adds DeepSeek as a built-in provider with first-class settings, readiness,
  chat/session adapter behavior, streaming, cursor persistence, and text generation support.
- `handoff-compression`: Adds model selection, summary generation, caching, and fallback behavior
  for oversized imported messages used in handoff bootstrap context.

### Modified Capabilities

No existing OpenSpec capabilities are modified.

## Impact

- Affected contracts:
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/settings.ts`
- Affected client runtime:
  - `packages/client-runtime/src/operations/commands.ts`
  - `packages/client-runtime/src/state/threadCommands.ts`
- Affected server systems:
  - provider driver registration and settings metadata
  - DeepSeek API/adapter/text generation layers
  - orchestration commands, events, decider, projector, and command reactor
  - projection persistence migrations and replay behavior
  - text generation prompts, utilities, model selection, and provider implementations
- Affected web systems:
  - active chat header actions
  - handoff dialog and domain helpers
  - provider/model picker integration
  - imported-message timeline rendering
  - settings UI for handoff compression model selection
- Required verification:
  - `vp check`
  - `vp run typecheck`
  - isolated manual verification with a separate `--base-dir` or `T3CODE_HOME`
