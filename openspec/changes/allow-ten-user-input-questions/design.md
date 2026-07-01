## Context

Structured user input currently flows through provider adapters into `user-input.requested` runtime events, then through projection/persistence into web and mobile pending-input views. The shared contract schema accepts `questions: Array(UserInputQuestion)` without a length cap, and the generated Codex app-server schema also models `request_user_input` questions as an array. The practical three-question limit is therefore an advertised/tooling constraint and a missing acceptance-test boundary, not a required protocol migration.

The current web composer presents one active question at a time with a progress counter, while mobile renders every pending question in the card. Both shapes can support ten questions, but the implementation needs explicit tests so future layout or parser changes do not accidentally reintroduce a smaller limit.

## Goals / Non-Goals

**Goals:**

- Make ten questions the documented and enforced maximum for one `request_user_input` prompt.
- Preserve all questions and answers in order for prompts containing between one and ten questions.
- Keep the existing `user-input.requested` and `user-input.resolved` event payload shapes unchanged.
- Add focused regression tests for the ten-question boundary in server, contracts, web, and mobile-relevant logic.

**Non-Goals:**

- Supporting unbounded or paginated prompt batches.
- Changing the answer wire shape or adding new question types.
- Redesigning the pending-input UI beyond any small responsive adjustments needed for ten questions.
- Moving runtime helpers into `packages/contracts`; that package stays schema-only.

## Decisions

### Decision: Define a shared runtime limit of ten

Add a small shared runtime module, for example `@t3tools/shared/userInput`, that exports `MAX_USER_INPUT_QUESTIONS = 10` and any tiny validation helper needed by server/client code. Use an explicit subpath export to match existing `packages/shared` conventions.

Rationale: the limit is product behavior shared by providers and clients. Centralizing it prevents `3`, `10`, or other local constants from drifting.

Alternatives considered:

- Keep the number inline near each adapter/UI path. Rejected because it makes future limit changes harder to audit and contradicts the repo preference for shared logic.
- Put the constant in `packages/contracts`. Rejected because project rules keep that package schema-only.

### Decision: Enforce the cap at provider/tool boundaries and preserve arrays internally

Provider-facing tool metadata and developer instructions should advertise one to ten questions per prompt. Runtime adapters should preserve valid batches as-is. If a provider or tool request supplies more than ten questions, the server should fail the request predictably instead of silently truncating answers or showing a partial prompt.

Rationale: a hard cap must be visible where agents form tool calls, while internal event schemas can remain stable. Rejecting over-limit requests is safer than partial display because each omitted question could be a required decision.

Alternatives considered:

- Silently truncate to ten. Rejected because it can lose required user decisions with no clear feedback to the agent.
- Accept unlimited arrays internally while only advertising ten. Rejected because accidental oversized prompts would remain untested and could degrade the pending-input UI under load.

### Decision: Keep the web one-question-at-a-time flow

For web, keep `ComposerPendingUserInputPanel` showing one active question with `n/total` progress and keyboard shortcuts for the active question only. Ten-question support should come from the existing progression logic and answer builder, with tests around ten-item batches.

Rationale: this keeps the composer compact and avoids a new scrolling interaction inside the composer. It also makes ten questions usable without crowding the active prompt.

Alternatives considered:

- Render all ten web questions at once. Rejected because the composer area is constrained and mobile already uses the multi-question card shape where there is more vertical scrolling space.

## Risks / Trade-offs

- [Provider tool schema is generated outside the obvious adapter code] -> Locate the source-of-truth metadata first during implementation, update the generated or static definition there, and add a test that inspects the exposed max.
- [Rejecting over-limit external-provider prompts breaks a provider that currently sends more than ten] -> Emit a clear runtime/provider error with the observed count and maximum so failures are actionable.
- [Mobile all-at-once rendering gets tall with ten questions] -> Keep mobile behavior for now but verify it scrolls naturally in the thread view; only make layout tweaks if tests or manual verification show clipping.
- [Keyboard shortcuts only cover nine options per active question] -> Keep this unchanged because the requested limit is question count, not option count; document it as unaffected behavior.

## Migration Plan

No persisted data migration is required because the event payload shape does not change. Implement as a normal application update: add the shared limit, update provider/tool metadata and boundary validation, expand tests, then run `vp check` and `vp run typecheck`. Rollback is reverting the shared limit and validation/metadata changes; existing persisted pending-input events remain readable.

## Open Questions

- None for the proposal. Implementation should default to a hard maximum of ten, preserve question order, and reject over-limit batches with a clear error rather than truncating.
