## Why

ACP agents advertise their own commands through `session/update` with
`sessionUpdate: "available_commands_update"`. `parseSessionUpdateEvent` in
`apps/server/src/provider/acp/AcpRuntimeModel.ts` has no case for that variant, so the
notification falls through `default: break` and is discarded. No ACP-backed provider (Kimi, Cursor,
Grok) exposes agent commands in T3 Code, even though every one of them advertises some.

A live `kimi acp` handshake against Kimi Code CLI 0.29 pushes `available_commands_update`
immediately after `session/new`, including `compact` ("Compact the conversation context") with an
optional custom-summarization hint. This is the sharpest case: T3 Code derives no context-window
telemetry for Kimi, so a user with a long Kimi thread has neither a usage indicator nor any way to
compact it from inside T3 Code. Their only option is to abandon the thread or drive the CLI from
their own terminal, which desynchronizes the native session from the T3 thread.

This is tech debt deferred from the Kimi ACP correctness work; it was explicitly listed as
out of scope there because it needs composer UI and command dispatch, not just a parser fix.

## What Changes

- Parse `available_commands_update` into a typed runtime event carrying each command's name,
  description, and input hint.
- Track the current command set per ACP session and republish it when the agent pushes a new one, so
  the list follows mode and model changes rather than freezing at session start.
- Expose available commands on the thread's session state so clients can render them.
- Offer the commands in the composer as slash commands, dispatching the selected command through
  the existing prompt path with its argument, since ACP has no separate command RPC.
- Apply this uniformly to every ACP provider rather than special-casing Kimi.

## Capabilities

### New Capabilities

- `acp-agent-commands`: Discovery, currency, and invocation of agent-advertised commands for
  ACP-backed providers.

### Modified Capabilities

None.

## Impact

- `apps/server/src/provider/acp/AcpRuntimeModel.ts`: parse the notification variant.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`: hold and expose the current command set.
- ACP adapters (`KimiAdapter`, `CursorAdapter`, `GrokAdapter`): emit the runtime event and keep it
  outside the active-turn gate, since commands arrive before any turn starts.
- `packages/contracts`: runtime event payload and session-state field for available commands.
- `apps/web`: composer slash-command affordance and argument entry.
- No provider gains a command it did not already advertise; providers that advertise none are
  unaffected.
