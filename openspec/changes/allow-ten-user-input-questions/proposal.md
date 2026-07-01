## Why

The current `request_user_input` affordance caps a prompt at three questions, which forces agents to split decision-complete planning into multiple prompt cycles even when the user explicitly wants a larger bounded batch. Allowing up to ten questions keeps the interaction controlled while reducing unnecessary back-and-forth for implementation-order and acceptance-criteria decisions.

## What Changes

- Raise the supported `request_user_input` question batch size from three to ten.
- Ensure provider runtime ingestion, pending-input projection, web UI answer flow, and mobile pending-input rendering preserve and answer all ten questions without truncation.
- Keep existing per-question constraints intact: each question still has an id, header, prompt text, options, and optional multi-select behavior.
- Add regression coverage that a ten-question prompt can be parsed, displayed/progressed, answered, and resolved as one pending input request.

## Capabilities

### New Capabilities

- `user-input-question-batches`: Defines the supported batch size and end-to-end handling requirements for structured user-input prompts.

### Modified Capabilities

<!-- None: no existing OpenSpec capability currently defines structured user-input prompt batching. -->

## Impact

- `apps/server/src/provider/CodexDeveloperInstructions.ts` and any provider/tool metadata that advertises or constrains `request_user_input` batch size.
- Provider adapters that translate native ask-user-input events into `user-input.requested`, especially `apps/server/src/provider/Layers/CodexAdapter.ts`, `ClaudeAdapter.ts`, `CursorAdapter.ts`, `GrokAdapter.ts`, and `OpenCodeAdapter.ts`.
- Projection and persistence paths for pending user input events under `apps/server/src/orchestration` and `apps/server/src/persistence`.
- Web pending-input flow in `apps/web/src/session-logic.ts`, `apps/web/src/pendingUserInput.ts`, and `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`.
- Mobile pending-input flow in `apps/mobile/src/lib/threadActivity.ts`, `apps/mobile/src/state/use-selected-thread-requests.ts`, and `apps/mobile/src/features/threads/PendingUserInputCard.tsx`.
- Contract tests in `packages/contracts/src/providerRuntime.test.ts` and Codex app-server protocol tests in `packages/effect-codex-app-server/src`.
