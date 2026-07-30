> **Priority: 1 (highest).** Accepted in principle, to be refined before implementation. A stopgap
> shipped separately raises the DPoP access-token lifetime so the interruptions stop today; that
> stopgap is what this change removes.

## Why

A DPoP-bound access token is issued with a one-hour lifetime, and nothing can renew it:

```ts
// apps/server/src/auth/EnvironmentAuth.ts
...(input?.proofKeyThumbprint
  ? { proofKeyThumbprint: input.proofKeyThumbprint, ttl: Duration.hours(1) }
  : {}),
```

`grep -rn "refresh_token\|refreshToken" apps/server/src/auth/` returns nothing. The token response
carries `access_token`, `token_type`, `expires_in` and `scope`, and `/oauth/token` has no
`grant_type=refresh_token` branch. So when the hour is up a client's only recovery is the full
pairing flow, which needs a human at the keyboard.

The observed cost is an MCP client that dies roughly hourly with
`requires re-authorization (token expired)`. Reconnecting does not help: the transport reopens
against a credential that is already dead. In a headless or long-running session there is no human
to re-pair, so the capability is simply lost for the rest of the run.

The shape of the bug is worth stating plainly: the same endpoint gives a plain bearer token
`DEFAULT_SESSION_TTL` — thirty days — while the DPoP-bound token, which is the _more_ secure of the
two because it is proof-of-possession, gets one hour. The stricter mechanism ends up the less usable
one. That asymmetry reads like a short TTL chosen with a refresh flow in mind that was never built.

## What Changes

- Issue a refresh token alongside a DPoP access token, bound to the same proof key.
- Add a `grant_type=refresh_token` branch to `/oauth/token` that mints a new access token, and
  rotates the refresh token as it does.
- Keep the access-token lifetime short. Short-lived proof-of-possession tokens are the point of
  DPoP; the defect is the missing renewal, not the hour.
- Revoke a refresh token's whole lineage when a rotated token is replayed, so a stolen token is
  detectable rather than silently useful.
- Restore the DPoP access-token TTL to a short value once refresh works, undoing the stopgap.

## Non-goals

- No change to browser-session cookies or the pairing flow itself.
- No new consent or scope-elevation surface: a refresh returns the scopes already granted, never
  more.
- Not a general OAuth authorization-server implementation. This covers the grant types T3 Code
  actually issues.

## Capabilities

### New Capabilities

- `environment-auth-refresh`: Issuing, presenting, rotating and revoking refresh tokens for
  environment access tokens, and the renewal path that keeps a long-lived client authenticated
  without a human.

### Modified Capabilities

None.

## Impact

- `apps/server/src/auth/EnvironmentAuth.ts`: issue a refresh token on exchange; handle the refresh
  grant.
- `apps/server/src/auth/SessionStore.ts`: persist refresh tokens with their lineage, rotation state,
  and proof-key binding; a store that can detect replay of a rotated token.
- `packages/contracts/src/auth.ts`: `refresh_token` on the token result, and the refresh request.
- `packages/contracts/src/environmentHttp.ts`: the `/oauth/token` refresh grant.
- Clients that hold a token: the MCP client and any relay-side consumer must renew rather than
  re-pair.
- Persisted sessions: additive, so existing tokens keep working until they expire.

## Open questions for refinement

- **Refresh lifetime, and whether it slides.** A fixed long expiry is simpler; a sliding one keeps an
  active client alive forever but never expires an abandoned credential on a shared machine.
- **Rotation on every refresh, or reuse?** Rotation is what makes replay detectable, and costs a
  write per renewal.
- **What a client does when refresh fails** — re-pair, or surface a distinct "session ended" state
  separate from "never authenticated".
- **Whether plain bearer tokens keep their thirty days.** Fixing DPoP renewal removes the reason to
  compensate with a long bearer TTL, and the asymmetry is worth revisiting.
- **Whether the relay path needs the same treatment**, or already re-pairs by other means.
