## Why

T3 Code can only reattach to agent sessions it created itself. Each provider mints a resume cursor
when it starts a session and stores it on the thread; a session started anywhere else is invisible.
If a user works in their own terminal and then wants to continue that conversation in T3 Code, they
cannot — they start over.

The protocol already supports this. Kimi Code CLI 0.29 advertises `sessionCapabilities.list`, and a
live `session/list` returns usable records:

```json
{
  "sessions": [
    {
      "sessionId": "session_e536a5b5-...",
      "cwd": "I:/projects/Personal/t3code",
      "title": "New Session",
      "updatedAt": "2026-07-25T14:12:30.296Z"
    }
  ]
}
```

T3 Code never calls it. `AcpSessionRuntime` exposes no listing operation, and no provider consults
the capability.

This is tech debt deferred from the Kimi ACP correctness work, where it was listed as out of scope
because it needs a browsing surface and an adoption path, not just a protocol call.

## What Changes

- Add a `listSessions` operation to the ACP session runtime, gated on the agent advertising
  `sessionCapabilities.list`.
- Expose native sessions for a provider instance through the server so clients can browse them.
- Let a user adopt a native session into a new T3 Code thread, reusing the existing resume path and
  resume-cursor format rather than inventing a second attachment mechanism.
- Show each session's working directory and last-updated time, and make the working-directory
  mismatch explicit when adopting a session from a different directory.
- Be honest about what adoption does and does not recover: T3 Code gains the agent's conversation
  context, not a reconstructed T3 Code transcript.

## Capabilities

### New Capabilities

- `acp-native-sessions`: Discovery of agent-owned sessions and their adoption into T3 Code threads
  for ACP-backed providers.

### Modified Capabilities

None.

## Impact

- `apps/server/src/provider/acp/AcpSessionRuntime.ts`: a capability-gated `session/list` call.
- Provider adapters and `ProviderAdapter` service shape: expose native session listing for providers
  whose agent supports it.
- `packages/contracts`: native session record and the request/response for listing them.
- `apps/web`: a browsing surface and an adoption action that creates a thread bound to the chosen
  session.
- Kimi is the initial consumer. Cursor, Grok, and OpenCode are unaffected unless their agents
  advertise the same capability.
- No new persistence: an adopted session reuses the provider's existing resume cursor shape.
