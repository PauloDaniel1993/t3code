> Not ready to start. The open questions in the proposal — refresh lifetime and sliding, rotation
> cost, and what a client shows when refresh fails — should be settled first, since they change the
> store's shape.

## 1. Contracts

- [ ] 1.1 Add `refresh_token` to the token result, optional so existing responses still decode
- [ ] 1.2 Add the refresh grant request shape and wire it into the `/oauth/token` endpoint contract
- [ ] 1.3 Decoding tests covering a response with and without a refresh token

## 2. Session store

- [ ] 2.1 Persist refresh tokens with their proof-key binding, lineage id, and rotation state
- [ ] 2.2 Rotate on use: invalidate the presented token as the replacement is issued, in one
      transaction so a crash cannot leave two live tokens
- [ ] 2.3 Detect replay of a rotated token and revoke the whole lineage
- [ ] 2.4 Revoke a session's refresh tokens when the session itself is revoked
- [ ] 2.5 Focused store tests: rotation, replay, expiry, revocation cascade, and the crash window

## 3. Token endpoint

- [ ] 3.1 Issue a refresh token alongside a DPoP access token
- [ ] 3.2 Handle `grant_type=refresh_token`, rejecting a mismatched proof key and any scope widening
- [ ] 3.3 Distinguish "refresh token expired" from "refresh token invalid" in the error surface
- [ ] 3.4 Focused endpoint tests for each rejection path

## 4. Clients

- [ ] 4.1 Renew ahead of expiry rather than after a failed call, so no request is lost to a race
- [ ] 4.2 Report an ended session distinctly from never having been authenticated
- [ ] 4.3 Confirm the relay path either renews or re-pairs deliberately

## 5. Remove the stopgap

- [ ] 5.1 Restore the DPoP access-token TTL to a short lifetime
- [ ] 5.2 Remove the stopgap comment in `EnvironmentAuth.ts` pointing at this change
- [ ] 5.3 Verify a long-running MCP client survives well past the access-token lifetime without a
      human
