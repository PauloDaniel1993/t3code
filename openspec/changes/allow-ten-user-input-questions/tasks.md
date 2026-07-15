## 1. Shared Limit And Tool Surface

- [ ] 1.1 Add a shared runtime module/export for `MAX_USER_INPUT_QUESTIONS = 10` without adding runtime helpers to `packages/contracts`.
- [ ] 1.2 Update repo-owned provider developer instructions so the advertised maximum is ten questions per prompt.
- [ ] 1.3 Add a focused test or snapshot that fails if repo-owned exposed instructions regress to a three-question maximum.
- [ ] 1.4 Add a repo-owned T3 MCP `request_user_input` tool with agent-facing schema/metadata advertising one to ten questions, and update provider instructions to prefer it over provider-native fallbacks with smaller caps.
- [ ] 1.5 Add a regression check for the T3 MCP `request_user_input` tool metadata source so the exposed maximum cannot regress below ten.
- [ ] 1.6 Force provider-native structured question tools to return a provider-visible denial when the T3 MCP `request_user_input` tool is attached to the provider session.
- [ ] 1.7 Add explicit DeepSeek coverage: the local Chat Completions adapter has no provider-native structured-question or MCP tool-call path, so user-input responses return clear T3 MCP/tool-capability guidance.

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

Verification note: focused non-layer regression tests pass. Direct `vp test` against Effect-layer provider adapter files still fails during suite collection with the existing `@effect/vitest` direct-run config issue; the same failure reproduces on unrelated existing Effect tests. Manual integrated-browser verification passed for Cursor mock thread `95b1e456-f54f-4bea-b842-5c4d1a588440`: the web UI progressed through questions 1/10 to 10/10, submitted one response, and the provider/projection recorded `user-input.resolved` with ten answers (`scope-1` through `scope-10`) before `turn.completed`.

Additional MCP metadata verification: `vp test apps/server/src/mcp/toolkits/userInput/tools.test.ts apps/server/src/provider/CodexDeveloperInstructions.test.ts packages/contracts/src/providerRuntime.test.ts packages/shared/src/userInput.test.ts`, `vp check`, `vp run typecheck`, and `openspec validate allow-ten-user-input-questions --strict` pass. `openspec instructions apply --change allow-ten-user-input-questions --json` reports 25/25 complete. The server package-script test path still reproduces the same existing `@effect/vitest` suite-collection issue for `ProviderService.test.ts` and `McpSessionRegistry.test.ts`, while the new MCP metadata regression test runs through the regular Vite+ harness.

Metadata note: the repo now owns a T3 MCP `request_user_input` tool exposed by the `t3-code` MCP server. Its tool schema advertises one to ten questions, provider instructions require it when available, and ProviderService brokers the MCP request through the canonical `user-input.requested` / `user-input.resolved` UI flow. Native host/provider tool metadata remains externally owned: the Codex app-server collaboration settings do not expose a tool-schema override for the built-in host `request_user_input`, and the installed `@anthropic-ai/claude-agent-sdk@0.3.170` `AskUserQuestion` metadata still advertises 1-4 items with no max-question override. Fresh sessions with T3 MCP attached now reject the provider-native structured question tools and direct the model to the T3 MCP tool instead.

Force-mode verification note: `vp run typecheck`, `vp check`, and `vp test apps/server/src/provider/CodexDeveloperInstructions.test.ts apps/server/src/mcp/toolkits/userInput/tools.test.ts apps/server/src/provider/Layers/DeepSeekAdapter.userInput.test.ts` pass. Direct `vp test` on `apps/server/src/provider/Layers/CodexAdapter.test.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, and `apps/server/src/provider/Layers/DeepSeekProvider.test.ts` still fails during suite collection with the existing `@effect/vitest` layer config issue before running tests.
