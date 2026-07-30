## ADDED Requirements

### Requirement: A DPoP access token is issued with a refresh token

The token exchange SHALL return a refresh token alongside a DPoP-bound access token, bound to the
same proof key and carrying the scopes already granted. The access token SHALL keep a short
lifetime.

#### Scenario: Exchange returns both tokens

- **WHEN** a client exchanges a bootstrap credential and presents a proof key
- **THEN** the response carries an access token, its `expires_in`, and a refresh token

#### Scenario: Bearer exchange is unchanged

- **WHEN** a client exchanges without a proof key
- **THEN** the response is exactly as before, with no refresh token

### Requirement: A refresh token renews an access token without a human

`/oauth/token` SHALL accept `grant_type=refresh_token` and return a new access token for the scopes
already granted, without any re-pairing or user interaction.

#### Scenario: Renewal before expiry

- **WHEN** a client presents a valid refresh token with a matching proof key
- **THEN** a new access token is issued and the client continues uninterrupted

#### Scenario: Renewal after the access token has expired

- **WHEN** the access token has already expired but the refresh token has not
- **THEN** renewal still succeeds, because an expired access token is the normal reason to refresh

#### Scenario: Scopes are never widened

- **WHEN** a refresh request asks for scopes beyond those granted
- **THEN** the request is rejected rather than being silently narrowed or widened

#### Scenario: Proof key must match

- **WHEN** a refresh token is presented with a different proof key than it was bound to
- **THEN** the request is rejected

### Requirement: Refresh tokens rotate, and replay revokes the lineage

Each successful renewal SHALL issue a new refresh token and invalidate the one presented. Presenting
an already-rotated token SHALL revoke every token descended from the same original grant.

#### Scenario: Rotation on renewal

- **WHEN** a refresh succeeds
- **THEN** the presented refresh token is no longer usable and a new one is returned

#### Scenario: A rotated token is replayed

- **WHEN** a refresh token that was already used is presented again
- **THEN** the request is rejected and the whole lineage is revoked, so a stolen copy cannot
  outlive its detection

#### Scenario: Revoking a session revokes its refresh tokens

- **WHEN** a client session is revoked
- **THEN** refresh tokens issued under it stop working immediately

### Requirement: A client distinguishes an ended session from an unauthenticated one

A client whose refresh fails SHALL be able to tell that its session ended, rather than reporting the
same state as one that was never authenticated.

#### Scenario: Refresh fails on an expired refresh token

- **WHEN** renewal is refused because the refresh token itself expired
- **THEN** the failure is reported as an ended session, so the surface can ask for re-pairing
  deliberately rather than appearing never to have connected

## Notes

Deferred to refinement, and deliberately not specified here: the refresh token's own lifetime and
whether it slides on use; whether the thirty-day plain-bearer TTL should be reduced once DPoP
renewal exists; and whether the relay path needs the same renewal or already re-pairs by other
means. See the open questions in the proposal.
