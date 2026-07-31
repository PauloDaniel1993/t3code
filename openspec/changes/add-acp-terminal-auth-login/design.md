## Context

T3 Code's provider readiness probe for an ACP agent calls `initialize` then `authenticate`, and
keeps only the protocol version and agent capabilities. `probeKimiAcpAuthentication` in
`apps/server/src/provider/acp/KimiAcpSupport.ts` returns `{ initializeResult, agentCapabilities }`,
so `authMethods` is technically reachable but nothing consumes it.

The failure mode this addresses is specific. A Kimi provider instance can point at a custom
`KIMI_CODE_HOME`. `docs/providers/kimi.md` therefore tells the user to run `kimi login` with that
environment variable set. If they instead run a bare `kimi login`, they authenticate the default
home, the instance stays unauthenticated, and nothing explains why. The agent already told us the
exact command; T3 Code already knows the instance's environment.

## Goals / Non-Goals

**Goals:**

- Let a user authenticate a provider instance from T3 Code, in the environment that instance uses.
- Keep the credential boundary exactly where it is: the CLI owns tokens, T3 Code never touches them.
- Reuse the agent's advertised command rather than hardcoding per-provider login invocations.

**Non-Goals:**

- Implementing OAuth, device-code polling, or any token exchange inside T3 Code.
- Supporting auth method types other than `terminal`. Other types are left to their existing
  manual instructions until one is actually encountered.
- Managing multiple accounts, switching accounts, or logging out.

## Decisions

### Only run what the agent advertised

The command, args, and env come from `_meta["terminal-auth"]`. T3 Code does not synthesize a login
command, does not fall back to a guessed binary name, and does not accept a command from settings.
If the descriptor is absent or malformed, the card keeps today's manual instructions. This keeps the
blast radius equal to "the agent T3 Code was already going to spawn".

### Merge the instance environment, with the descriptor winning

The command runs with the provider instance's resolved environment — the same one used to spawn
`kimi acp`, including `KIMI_CODE_HOME` — overlaid with the descriptor's `env`. That is the whole
point: authenticating the home the instance will actually use. The descriptor's own entries take
precedence because the agent knows its own requirements.

### The command is shown before it runs

An interactive login is a visible, consequential action. The card shows the resolved command and
requires an explicit click; it does not auto-launch on detecting an unauthenticated provider.

### Readiness is re-probed on process exit, not polled

The login process exiting is the signal. On exit, re-run the provider status check once. A device-code
flow that the user abandons exits non-zero or leaves the provider unauthenticated, and the card
simply returns to its prior state.

## Risks / Trade-offs

- Terminal auth is interactive by nature; the provider maintenance runner's non-interactive, piped,
  timed-out execution model is wrong for it. This must use the thread terminal surface, which
  already handles a live PTY, rather than the maintenance runner.
- A login can legitimately take minutes (the user switches to a browser). There must be no timeout
  that kills a valid flow.
- Running a login for one instance while another instance shares the same home can change the
  second instance's auth state as a side effect. The card should not claim otherwise.

## Open Questions

- Should the login terminal be a thread terminal, or a dedicated settings-scoped terminal? A thread
  terminal implies a thread; provider login happens in settings, possibly with no thread open.
- If several provider instances share a home, should a successful login re-probe all of them or only
  the one the user acted on?
