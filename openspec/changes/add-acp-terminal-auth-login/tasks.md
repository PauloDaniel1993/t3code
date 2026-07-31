## 1. Capture the advertised auth method

- [ ] 1.1 Retain `authMethods` from `initialize` in the ACP probe result rather than only
      `agentCapabilities`
- [ ] 1.2 Parse the `_meta["terminal-auth"]` descriptor into a typed shape, treating a missing or
      commandless descriptor as absent
- [ ] 1.3 Add focused parsing tests including the malformed case

## 2. Contracts and snapshot

- [ ] 2.1 Add an optional terminal auth method (label, command, args) to the provider snapshot in
      `packages/contracts`
- [ ] 2.2 Populate it from the Kimi readiness probe; confirm whether Cursor and Grok advertise the
      descriptor and populate theirs if so
- [ ] 2.3 Update contract and provider-snapshot tests

## 3. Supervised login execution

- [ ] 3.1 Resolve the login environment as instance environment overlaid with descriptor entries
- [ ] 3.2 Launch the command in the interactive terminal surface with no execution timeout — do not
      route it through `providerMaintenanceRunner`, whose piped, timed-out model is wrong for an
      interactive flow
- [ ] 3.3 Decide the open question of thread terminal versus settings-scoped terminal, and record
      the decision in `design.md` before implementing
- [ ] 3.4 Re-probe provider readiness once on process exit and publish the snapshot
- [ ] 3.5 Decide whether instances sharing a home are re-probed together

## 4. Provider card

- [ ] 4.1 Offer the login action only when installed, unauthenticated, and a descriptor exists
- [ ] 4.2 Show the resolved command before running, requiring an explicit activation
- [ ] 4.3 Reflect running and finished states without a manual refresh
- [ ] 4.4 Add focused web tests

## 5. Credential boundary

- [ ] 5.1 Confirm no login output is written into provider state, settings, or server logs
- [ ] 5.2 Add a regression test asserting the login path stores nothing from the process output

## 6. Verification

- [ ] 6.1 Run the focused server and web tests for the touched files
- [ ] 6.2 Verify a real unauthenticated-to-authenticated transition against a scratch agent home
      using the `test-t3-app` skill
- [ ] 6.3 Update `docs/providers/kimi.md` to describe the in-app login and when manual `kimi login`
      is still needed
