## Context

`AcpSessionRuntime.make` spawns the agent through `ChildProcessSpawner` and hands the child to
`EffectAcpClient.layerChildProcess(child, ...)`. That layer wires stdin and stdout into the JSON-RPC
transport. `child.stderr` is available on the spawned process but nothing subscribes to it, so the
pipe fills or drains into nothing depending on the platform.

The current Kimi workaround is instructive about the cost. `readKimiAcpFailureSince` is called twice
per turn — once when the prompt fails and once when it succeeds — and each call re-reads a log file
from disk and string-scans it. It works today, and it produced real user-visible error messages, but
it is coupled to two things the vendor never promised: the on-disk session layout and the exact
wording `acp: turn ended with failed reason`.

## Goals / Non-Goals

**Goals:**

- Make an agent's own diagnostics available at the moment T3 Code reports a failure.
- Give spawn and startup failures an explanation; today they have none.
- Reduce Kimi's dependence on scraping a private log file, without deleting a mechanism that
  currently works.

**Non-Goals:**

- Streaming agent stderr into the user-facing thread timeline. This is diagnostic material, not
  conversation.
- Replacing the native event log, or changing how JSON-RPC traffic is recorded.
- Parsing structured meaning out of stderr. It is captured as text.

## Decisions

### Bounded retention, most recent wins

Keep a fixed-size window — a byte or line cap — of the most recent stderr per session, dropping the
oldest. An agent that logs verbosely at a high rate must not grow server memory without bound, and
the useful content at failure time is the tail, not the head.

### Consume unconditionally, under the runtime scope

The stderr reader is started when the runtime is built and interrupted when its scope closes. It
cannot be opt-in per provider: an unconsumed stderr pipe is a platform-dependent hazard, and leaving
it unread is what created this gap.

### Attach to errors, do not replace them

Adapter errors keep their existing shape and message. The stderr window is additional context on the
error, not a substitute for the mapped error type. Callers that already match on error tags are
unaffected.

### Kimi's log scraper is demoted, not deleted

Prefer the stderr window when it yields a failure message; fall back to `KimiAcpDiagnostics` when it
does not. Record which source produced the message. Deleting the scraper before confirming stderr
carries the same detail would trade a fragile mechanism for a missing one — and the fragility is
currently invisible precisely because its fallback message reads like a real diagnosis.

### Redaction is a real concern and must be decided before shipping

Agents may write request URLs, headers, or tokens to stderr. The native event log is written to
disk. Either the capture is redacted, or the retention is explicitly documented as sensitive. This
is not optional given that at least one provider's auth flow is a device-code exchange.

## Risks / Trade-offs

- Capturing stderr means it can end up in the native event log and in error payloads that reach the
  client. Redaction has to be settled first; see the open question.
- A chatty agent could make the native event log substantially larger. The bounded window limits
  in-memory growth but not log volume, so stderr logging may need its own throttle.

## Open Questions

- What redaction applies to captured stderr before it is logged or attached to an error? A denylist
  of token-shaped patterns is the obvious first pass, but the decision should be explicit.
- Should the recent stderr window be surfaced in the provider card's error state, or only in the
  native event log and server logs?
- Once stderr is in place, is Kimi's log scraper still producing messages stderr does not? That
  answer determines whether it is eventually removed.
