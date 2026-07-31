## Why

ACP agents describe how to authenticate themselves. A live `kimi acp` (0.29) `initialize` response
returns:

```json
"authMethods":[{"id":"login","type":"terminal","name":"Login with Kimi account",
  "description":"Open the device-code login flow in a terminal.",
  "_meta":{"terminal-auth":{"type":"terminal","label":"Login with Kimi account",
    "command":"C:/Users/<user>/.kimi-code/bin/kimi","args":["login"],"env":{}}}}]
```

T3 Code discards all of it. When a provider is installed but unauthenticated, the card shows a
sentence telling the user to run `kimi login` themselves, with the right `KIMI_CODE_HOME`, in a
terminal T3 Code does not own. Getting that wrong is easy and the failure is silent: the user
authenticates a different home than the provider instance points at, then sees the same
"not authenticated" status and no explanation.

T3 Code already runs terminals for threads, so the missing piece is wiring the agent's own
advertised command into that surface. This is tech debt deferred from the Kimi ACP correctness
work, where it was called out as a feature rather than a fix.

## What Changes

- Capture `authMethods` and the `_meta["terminal-auth"]` descriptor during the ACP readiness probe
  and carry them on the provider snapshot.
- Offer a login action on the provider card for any provider instance that is installed,
  unauthenticated, and advertises a terminal auth method.
- Run the advertised command in T3 Code's terminal surface with the provider instance's resolved
  environment, so the login lands in the home the instance actually uses.
- Show the exact command before running it, and run nothing the agent did not advertise.
- Re-probe provider readiness when the login process exits, so the card reflects the new state
  without a manual refresh.
- Continue to never read, store, forward, or display the resulting credentials.

## Capabilities

### New Capabilities

- `acp-terminal-auth`: Discovery and supervised execution of an ACP agent's advertised terminal
  authentication flow, and the readiness transition that follows it.

### Modified Capabilities

None.

## Impact

- `apps/server/src/provider/acp/AcpSessionRuntime.ts` and the per-provider ACP probes: retain
  `authMethods` from `initialize` instead of discarding the response body.
- `packages/contracts`: provider snapshot fields describing the available auth method.
- `apps/server`: a supervised action that launches the advertised command in the existing terminal
  infrastructure and triggers a readiness re-probe on exit.
- `apps/web`: login affordance on the provider card, and the command preview.
- Applies to every ACP provider that advertises a terminal auth method; Cursor's `cursor_login` and
  Grok's cached-token flow benefit from the same path if they advertise the descriptor.
- Providers that advertise no terminal auth method keep today's manual instructions.
