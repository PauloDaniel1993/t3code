## Context

ACP models agent commands as advertisement plus ordinary prompting. The agent pushes an
`available_commands_update` session notification; the client renders the list and, when the user
picks one, sends it back through `session/prompt`. There is no dedicated command RPC, so this is a
presentation and dispatch concern, not a new protocol surface.

Observed from a live `kimi acp` (0.29) session, immediately after `session/new`:

```json
{
  "sessionUpdate": "available_commands_update",
  "availableCommands": [
    {
      "name": "compact",
      "description": "Compact the conversation context",
      "input": { "hint": "<optional custom summarization ...>" }
    }
  ]
}
```

`AvailableCommand` is already generated into `packages/effect-acp/src/_generated/schema.gen.ts`, so
the notification decodes today — it is simply dropped by the parser.

## Goals / Non-Goals

**Goals:**

- Surface agent commands for every ACP provider, kept current as the agent republishes them.
- Give Kimi threads a working `/compact`, which is currently unreachable from T3 Code.
- Keep the dispatch path identical to a normal user turn so approvals, steering, interruption, and
  activity recording all behave as they already do.

**Non-Goals:**

- T3 Code's own slash commands, or any client-side command registry.
- Context-window telemetry for Kimi. Compaction becoming reachable does not imply T3 Code can
  measure when it is needed; that is separate work.
- Inventing commands for agents that advertise none.

## Decisions

### Commands are session state, not provider state

An agent may republish its command set mid-session — Kimi does so alongside `config_option_update`
when the mode or model changes. Storing commands on the provider snapshot would make one session's
list leak across threads on the same instance. They belong on the thread's session state, refreshed
from the notification.

### The command set must survive the adapter's active-turn gate

`KimiAdapter` (and `GrokAdapter`) drop parsed events when `activeTurnId === undefined`, because
untracked notifications cannot be attributed to a turn. `available_commands_update` arrives before
the first turn exists, so it has to bypass that gate the same way `ConfigOptionsChanged` does.

### Dispatch as a prompt, with the argument appended

ACP command invocation is `session/prompt` with the command text. The client sends
`/<name> <argument>` as the prompt's leading text block. Commands whose `input.hint` is present
accept an optional argument; commands without one take none. This keeps a command turn
indistinguishable from a user turn for interruption and approval handling.

### Unknown or stale commands fail as ordinary prompts

If the agent removes a command between advertisement and invocation, the prompt is still sent and
the agent answers however it chooses. T3 Code does not maintain a shadow validity check that could
disagree with the agent.

## Risks / Trade-offs

- A command's effect is entirely agent-defined; `/compact` rewrites conversation context in the
  native session while T3 Code's own thread history is unchanged. The thread will show the compaction
  turn but retain its full transcript. This is honest — T3 Code's history is its own — but the
  divergence should be visible in the activity record rather than silent.
- Slash-command entry in the composer competes with plain text starting with `/`. The affordance
  must be dismissible and must not capture a literal leading slash the user intended.

## Open Questions

- Should a command turn be visually distinguished from a user message in the timeline, or recorded
  as an ordinary user turn whose text happens to start with `/`?
- Do Cursor and Grok advertise commands worth surfacing, or is the initial user-visible value
  Kimi-only? This needs a live handshake against each before the composer work is scoped.
