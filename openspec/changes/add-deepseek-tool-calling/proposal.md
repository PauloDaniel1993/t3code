## Why

DeepSeek currently runs as a local Chat Completions loop and explicitly cannot use T3 Code tools,
which means DeepSeek sessions cannot use MCP-backed affordances such as structured user input,
preview automation, or future provider-callable tools. Adding tool calling would make DeepSeek a
more complete provider option while preserving the current local-session architecture.

## What Changes

- Add DeepSeek tool-call support for OpenAI-compatible chat completion tool request/response
  shapes.
- Expose eligible T3 Code MCP tools to DeepSeek sessions through the same provider-scoped
  capability and credential model used by other providers.
- Extend the DeepSeek local turn loop so it can execute bounded tool-call rounds, append tool
  results to the model transcript, and continue streaming the final assistant response.
- Preserve typed unsupported behavior when DeepSeek is disabled, the selected model or endpoint
  does not support tool calls, a tool is not eligible for the session, or a tool call is malformed.
- Keep file-edit and approval semantics explicit: tool support does not automatically imply
  provider-native file editing or approval bypass.
- Add regression coverage for successful tool calls, unsupported models/endpoints, malformed tool
  calls, bounded loop termination, resume cursors, and provider runtime events.

## Capabilities

### New Capabilities

<!-- None. DeepSeek tool calling changes the existing DeepSeek provider capability. -->

### Modified Capabilities

- `deepseek-provider`: Replace the v1 "tools unsupported" boundary with scoped, bounded
  DeepSeek tool-call support while keeping unsupported responses for unavailable or unauthorized
  tool capabilities.

## Impact

- `apps/server/src/provider/deepseek/DeepSeekApi.ts`: request/response types for tool
  definitions, tool calls, and tool result messages.
- `apps/server/src/provider/Layers/DeepSeekAdapter.ts`: local turn loop, tool-call execution,
  transcript/resume cursor persistence, runtime events, interruption, and error handling.
- `apps/server/src/provider/Drivers/DeepSeekDriver.ts` and provider capability metadata:
  advertise tool support only when the provider instance and selected model can use it.
- `apps/server/src/mcp` and provider-scoped MCP credential paths: expose only eligible tools to
  DeepSeek sessions.
- `packages/contracts` provider runtime contracts only if new event metadata or capability flags
  are needed.
- Tests for DeepSeek API parsing, adapter behavior, MCP capability gating, provider runtime
  ingestion, and strict OpenSpec validation.
