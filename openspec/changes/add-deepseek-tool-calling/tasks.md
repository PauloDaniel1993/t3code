## 1. Compatibility And Capability Discovery

- [ ] 1.1 Verify the exact DeepSeek/OpenAI-compatible tool-call request and response shape for the configured API endpoint.
- [ ] 1.2 Decide whether DeepSeek tool support is enabled by explicit provider setting, model metadata, endpoint probing, or a combination.
- [ ] 1.3 Add provider/model capability metadata for DeepSeek tool support without advertising tools when support is unknown.
- [ ] 1.4 Add tests for DeepSeek capability defaults, enabled tool-capable models, and unsupported custom model or endpoint states.

## 2. Tool Metadata Bridge

- [ ] 2.1 Extract a server-owned tool metadata source that can produce both MCP tool definitions and DeepSeek/OpenAI-compatible tool definitions.
- [ ] 2.2 Convert eligible `preview` and `user-input` tools into DeepSeek tool schemas without exposing bearer tokens or internal MCP session data.
- [ ] 2.3 Enforce provider-scoped MCP capabilities before including any DeepSeek tool definition.
- [ ] 2.4 Add schema conversion tests for supported tools, unsupported capabilities, and malformed tool metadata.

## 3. DeepSeek API Types And Parsing

- [ ] 3.1 Extend `DeepSeekChatMessage` and request encoding to support assistant `tool_calls` and `tool` result messages.
- [ ] 3.2 Extend streaming and non-streaming response parsing to detect final assistant text versus tool-call requests.
- [ ] 3.3 Preserve existing SSE text streaming behavior for responses that do not request tools.
- [ ] 3.4 Add API-layer tests for tool-call parsing, mixed text/tool-call responses, malformed JSON arguments, and unknown tool-call ids.

## 4. Adapter Tool Loop

- [ ] 4.1 Update `DeepSeekAdapter.sendTurn` to send eligible tool definitions when the session and model allow tools.
- [ ] 4.2 Implement a bounded tool-call loop that executes authorized tool calls, appends tool results, and requests the next DeepSeek completion.
- [ ] 4.3 Add timeout, interruption, max-round, and max-tool-result-size handling for each tool-call turn.
- [ ] 4.4 Emit canonical runtime events for tool-call start, completion, failure, final assistant output, and failed/interrupted turn completion.
- [ ] 4.5 Keep failed and interrupted tool-call turns from updating the DeepSeek resume cursor.

## 5. Resume Cursor And Session Semantics

- [ ] 5.1 Version or extend the DeepSeek resume cursor to store assistant tool-call messages and tool result messages.
- [ ] 5.2 Decode older text-only cursors without migration failures.
- [ ] 5.3 Persist successful tool transcripts in model-visible order after the final assistant response.
- [ ] 5.4 Add resume tests for text-only cursors, successful tool-call cursors, corrupt tool-call cursors, and interrupted tool turns.

## 6. User Input And Preview Tool Coverage

- [ ] 6.1 Verify DeepSeek can call the T3 MCP `request_user_input` tool through the bridge and receive the answer map before continuing the turn.
- [ ] 6.2 Verify DeepSeek can call eligible preview tools only when the session has the `preview` capability.
- [ ] 6.3 Reject unauthorized, unknown, or schema-invalid DeepSeek tool calls with provider-visible errors and no side effects.
- [ ] 6.4 Add provider runtime ingestion or projection tests if new tool-call events require UI-visible activity changes.

## 7. Verification

- [ ] 7.1 Run targeted DeepSeek API, adapter, provider capability, MCP metadata, and provider runtime tests.
- [ ] 7.2 Run `openspec validate add-deepseek-tool-calling --strict`.
- [ ] 7.3 Run `vp run typecheck`.
- [ ] 7.4 Run `vp check`.
- [ ] 7.5 Manually verify a DeepSeek session can call a small enabled tool and complete the turn with the tool result reflected in the final answer.
