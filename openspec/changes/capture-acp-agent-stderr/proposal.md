## Why

T3 Code spawns every ACP agent as a child process and reads only its stdout, which carries the
JSON-RPC stream. `EffectAcpClient.layerChildProcess` never consumes stderr, so everything the agent
writes there is discarded for every ACP provider. That is where agents put their diagnostics: the
`kimi acp` reference states that logs route to stderr and to the agent's log directory.

Losing stderr has two costs. A spawn or startup failure produces no explanation beyond a generic
transport error. And to recover a per-turn failure message, the Kimi driver reads the agent's
private on-disk log instead: `KimiAcpDiagnostics` resolves
`<KIMI_CODE_HOME>/session_index.jsonl`, walks to `<sessionDir>/logs/kimi-code.log`, and scans for
the literal string `acp: turn ended with failed reason` followed by `error=`. That is an
undocumented file layout plus a hardcoded log message. If either changes upstream, every Kimi turn
error silently degrades to "Kimi could not complete the turn because its ACP session failed" — the
failure is invisible because the fallback looks like a real message.

This is tech debt deferred from the Kimi ACP correctness work, where it was listed as out of scope
because it needs plumbing through the `effect-acp` child-process layer.

## What Changes

- Consume the ACP child's stderr in the session runtime and retain a bounded, most-recent window of
  it per session.
- Record stderr in the native event log alongside the JSON-RPC traffic, so a session transcript
  shows what the agent reported.
- Attach the recent stderr window to adapter errors, so spawn failures, startup failures, and turn
  failures carry the agent's own explanation.
- Keep Kimi's log-file scraper as a fallback rather than deleting it, until stderr is confirmed to
  carry the same failure detail; prefer stderr when both produce a message, and record when the
  scraper was the only source.

## Capabilities

### New Capabilities

- `acp-agent-diagnostics`: Capture, retention, and attribution of ACP agent process diagnostics.

### Modified Capabilities

None.

## Impact

- `packages/effect-acp`: expose the child's stderr stream from the child-process client layer.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`: consume stderr into a bounded buffer under the
  runtime scope, and expose the recent window.
- `apps/server/src/provider/acp/AcpNativeLogging.ts`: record stderr lines as native events.
- `apps/server/src/provider/acp/AcpAdapterSupport.ts` and the ACP adapters: include the recent window
  in mapped errors.
- `apps/server/src/provider/acp/KimiAcpDiagnostics.ts`: demoted to a fallback behind stderr.
- Benefits Kimi, Cursor, and Grok equally; no provider behavior changes when an agent writes nothing
  to stderr.
