> **Priority: 1 (highest).** Accepted in principle, to be refined before implementation. A
> seven-day stopgap applies to DPoP access tokens exchanged from the reusable dev credential.

## Why

An unattended MCP client using an environment access token can lose access when the token expires.
Reconnecting with the same nonrenewable credential still fails. The fork originally raised the
DPoP token lifetime from one hour to seven days to reduce these interruptions.

Plain pairing links now issue one-hour DPoP tokens with a 30-day idle renewal window. The client
uses its access token and the matching proof key in a token exchange at `/oauth/token`. The reusable
dev exchange still issues a fixed-lifetime child token. A client holding only that child token
cannot self-renew and needs the reusable dev credential again when the token expires. Its
seven-day lifetime reduces interruptions at the cost of a longer validity window for a
compromised token and proof key.

The environment token exchange has no `refresh_token` grant and issues no refresh token. The
separate MCP authorization-code flow issues a bearer token.

## What Changes

- Issue a refresh token alongside a DPoP access token, bound to the same proof key.
- Add a `grant_type=refresh_token` branch to `/oauth/token` that mints a new access token, and
  rotates the refresh token as it does.
- Keep the access-token lifetime short. Short-lived proof-of-possession tokens are the point of
  DPoP; the defect is the missing renewal, not the hour.
- Revoke a refresh token's whole lineage when a rotated token is replayed, so a stolen token is
  detectable rather than silently useful.
- Restore the reusable dev DPoP access-token lifetime to one hour once its clients can renew.

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
