## Context

DeepSeek is currently implemented as a local OpenAI-compatible Chat Completions loop. The adapter
owns local session state, sends user/assistant messages directly to DeepSeek, streams text deltas
back into canonical provider runtime events, and stores a versioned resume cursor after successful
turns. The main `deepseek-provider` spec explicitly says v1 does not support tools, file edits,
approvals, or user-input requests.

Other providers receive provider-scoped MCP credentials before session start. The MCP registry
currently issues scoped credentials with `preview` and `user-input` capabilities, and provider
adapters such as Codex, Claude, Cursor, Grok, and OpenCode pass the T3 MCP server to their native
runtime. DeepSeek cannot use that same pass-through approach because it is not a CLI/runtime that
connects to MCP; T3 Code must translate between DeepSeek's Chat Completions tool-call protocol and
repo-owned tool handlers.

## Goals / Non-Goals

**Goals:**

- Let eligible DeepSeek sessions call T3 Code tools through OpenAI-compatible Chat Completions
  `tools`, assistant `tool_calls`, and `tool` result messages.
- Reuse provider-scoped MCP capability decisions so DeepSeek sees the same tool eligibility as other
  providers.
- Keep the DeepSeek adapter's local session and resume-cursor model intact.
- Bound tool-call loops so malformed or repetitive tool calls cannot hang a turn indefinitely.
- Emit canonical runtime events for tool call start, completion, failure, and final assistant output
  where current provider runtime contracts support them.

**Non-Goals:**

- Provider-native file editing for DeepSeek.
- Approval bypass or new runtime permission semantics.
- Exposing every MCP tool by default without session capability gating.
- Building a generic OpenAI Chat Completions provider abstraction for all providers in this change.
- Implementing tool calls for DeepSeek endpoints or custom models that do not support the
  OpenAI-compatible tool-call shape.

## Decisions

### Decision: Bridge MCP tools inside the DeepSeek adapter

The DeepSeek adapter should read the provider-scoped MCP session for the thread, resolve the
credential scope, and convert eligible repo-owned tools into OpenAI-compatible tool definitions for
the DeepSeek request. When DeepSeek returns assistant `tool_calls`, the adapter should execute those
calls through the same server-side handlers that back MCP, append `tool` result messages to the
local transcript, and continue the completion loop.

Rationale: DeepSeek does not run a provider process that can connect to T3's MCP server. Bridging in
the adapter keeps the behavior local, testable, and aligned with the current DeepSeek architecture.

Alternatives considered:

- Ask DeepSeek to call the MCP HTTP server directly. Rejected because Chat Completions tool calls are
  model outputs, not network-capable client calls, and exposing bearer credentials in prompts would
  be unsafe.
- Add a DeepSeek-specific tool registry separate from MCP. Rejected because it would duplicate
  capability gates and tool schemas.

### Decision: Advertise tools only when the selected model and endpoint are tool-capable

Provider/model metadata should expose DeepSeek tool support only when settings or capability probing
establishes that the selected model and endpoint accept tool definitions. If capability is unknown,
the adapter should default to the current safe behavior: no tools advertised and typed unsupported
responses for tool-dependent paths.

Rationale: OpenAI-compatible endpoints vary in their tool-call support. A false-positive capability
would make normal DeepSeek turns fail at runtime.

Alternatives considered:

- Always send tools and rely on DeepSeek errors. Rejected because it makes ordinary chat fragile and
  turns configuration drift into user-visible failures.
- Hard-code tool support for all built-in DeepSeek models. Rejected until the exact DeepSeek endpoint
  contract is verified during implementation.

### Decision: Preserve DeepSeek resume cursors with tool transcripts

Successful DeepSeek turns should persist the full local message history needed to resume future
turns, including assistant tool-call messages and corresponding tool result messages. Failed or
interrupted turns should not update the resume cursor.

Rationale: A later turn must have the same model-visible context that produced the final assistant
answer. The existing cursor rule already avoids persisting failed partial state.

Alternatives considered:

- Persist only user and final assistant messages. Rejected because the model would lose the tool
  observations that shaped the answer.
- Persist pending tool calls before execution. Rejected because interrupted or failed tool calls
  would become hard to replay deterministically.

### Decision: Bound loop depth and tool result size

The adapter should enforce a small configurable maximum number of tool-call rounds per turn and
limit tool result payload size before appending results to the DeepSeek transcript. Over-limit loops
and oversized results should produce provider-visible runtime errors rather than silently dropping
tool calls.

Rationale: Tool calling introduces a feedback loop between model output and server-side work. Bounds
protect latency, cost, memory, and provider stability.

Alternatives considered:

- Let the model call tools until it stops. Rejected because a malformed model response can loop
  forever.
- Truncate tool results silently. Rejected because the model may make incorrect decisions from
  incomplete observations.

## Risks / Trade-offs

- [DeepSeek endpoint compatibility differs by model or provider gateway] -> Add capability flags or a
  lightweight probe before advertising tool support, and keep unsupported as the default.
- [Tool schemas diverge between MCP and OpenAI Chat Completions] -> Derive DeepSeek tool definitions
  from the same source metadata used by MCP, with focused schema conversion tests.
- [Tool calls can trigger long-running server work] -> Enforce timeout, cancellation, loop-depth, and
  result-size limits in the adapter.
- [Tool results may contain sensitive local data] -> Reuse MCP capability gating and existing tool
  authorization; do not expose bearer tokens or full internal request state to DeepSeek.
- [Runtime event contracts may lack exact tool-call event shapes] -> Prefer existing canonical item
  events where possible; add contract fields only if the UI needs new structured display behavior.

## Migration Plan

Ship behind conservative capability defaults. Existing DeepSeek sessions continue without tools until
tool support is explicitly enabled or detected for the selected model/endpoint. Rollback is disabling
the capability flag/probe and returning DeepSeek to the current unsupported-tool behavior; existing
resume cursors remain readable if the cursor schema is versioned and old cursors continue to decode.

## Open Questions

- Which DeepSeek models and configured base URLs should be considered tool-capable by default?
- Should tool support be controlled by an explicit provider setting, automatic endpoint probing, or
  both?
- What exact maximum tool-call rounds and tool result byte limits should be used?
- Which MCP capabilities should DeepSeek receive initially: only `user-input`, `preview`, both, or a
  smaller pilot set?
- Do current provider runtime events sufficiently represent DeepSeek tool calls in the UI, or should
  contract events be extended first?
