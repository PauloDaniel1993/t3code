## 1. Shared Limit And Tool Surface

- [ ] 1.1 Add a shared runtime module/export for `MAX_USER_INPUT_QUESTIONS = 10` without adding runtime helpers to `packages/contracts`.
- [ ] 1.2 Update agent-facing `request_user_input` tool metadata and developer instructions so the advertised maximum is ten questions per prompt.
- [ ] 1.3 Add a focused test or snapshot that fails if exposed tool metadata or instructions regress to a three-question maximum.

## 2. Provider Boundary Validation

- [ ] 2.1 Add validation for structured user-input question batches at provider/runtime boundaries: accept 1-10 valid questions and reject zero valid questions.
- [ ] 2.2 Reject over-limit batches with a clear provider-visible error that includes the observed count and `MAX_USER_INPUT_QUESTIONS`.
- [ ] 2.3 Ensure Codex, Claude, Cursor, Grok, and OpenCode adapter paths preserve the original order of valid ten-question batches.
- [ ] 2.4 Add adapter tests for ten-question acceptance and eleven-question rejection where each provider path can emit structured user input.

## 3. Projection And Persistence

- [ ] 3.1 Verify `user-input.requested` projection and pending-input persistence store all ten questions without truncation.
- [ ] 3.2 Add or update projection/persistence tests for a ten-question pending input request and its resolved answer event.
- [ ] 3.3 Confirm existing migrations and cleanup logic continue to tolerate older pending-input payloads.

## 4. Web Client Behavior

- [ ] 4.1 Add pending-input logic tests proving ten questions can be answered, counted, progressed, and resolved as one answer map.
- [ ] 4.2 Add component or interaction coverage for `ComposerPendingUserInputPanel` showing `1/10` through `10/10` progression while preserving earlier answers.
- [ ] 4.3 Confirm incomplete ten-question prompts cannot be submitted and complete ten-question prompts submit all answers for the original request id.

## 5. Mobile Client Behavior

- [ ] 5.1 Add mobile thread-activity tests for parsing and building answers for ten-question pending input requests.
- [ ] 5.2 Verify `PendingUserInputCard` renders ten questions with answer controls in the thread scroll context without clipping the submit control.
- [ ] 5.3 If rendering shows clipping or unusable spacing, make the smallest layout adjustment needed while preserving the existing card structure.

## 6. Verification

- [ ] 6.1 Run targeted tests for shared user-input helpers, provider adapters, projection/persistence, web pending-input logic, and mobile thread activity.
- [ ] 6.2 Run `vp check`.
- [ ] 6.3 Run `vp run typecheck`.
- [ ] 6.4 Because mobile code is touched, run `vp run lint:mobile`.
- [ ] 6.5 Manually verify a ten-question prompt in the web UI: answer all ten, submit once, and confirm the provider receives ten answers.
