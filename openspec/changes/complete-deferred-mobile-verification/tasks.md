## 1. Provision a Representative Mobile Runtime

- [ ] 1.1 Select one viable iOS Simulator or Android Emulator host and record the host, platform,
      OS/runtime version, device identifier, and available SDK tooling.
- [ ] 1.2 Confirm that `com.t3tools.t3code.dev` is installed and compatible with the current Expo
      SDK and native configuration; build a development client only if compatibility requires it.
- [ ] 1.3 Confirm an authenticated Kimi CLI test home is available without reading, copying, or
      logging credential-file contents.

## 2. Launch an Isolated Current-Worktree Environment

- [ ] 2.1 Create a disposable T3 base directory and seed a disposable Git project plus deterministic
      thread fixtures for bounded history, stable activity upserts, retry, and stale running state
      while no backend owns the database.
- [ ] 2.2 Start one backend against the disposable base directory and one development-identity Metro
      server from `apps/mobile`, using explicit ports and origins appropriate to the selected device.
- [ ] 2.3 Launch the exact current-worktree `t3code-dev` URL, issue a fresh single-use pairing
      credential, pair the device, and confirm the seeded project appears before testing features.

## 3. Verify Mobile History and Recovery

- [ ] 3.1 Open the large seeded thread, load at least one older page, and verify chronological
      prepend with no missing or duplicated activity identities.
- [ ] 3.2 Deliver a live append and stable upsert while an older page is pending, then verify the
      historical page stays at the beginning, the live tail stays at the end, and terminal activity
      does not regress to a running state.
- [ ] 3.3 Cause one older-page request to fail, retry after connectivity is restored, and verify the
      fresh success merges instead of immediately redisplaying cached failure.
- [ ] 3.4 Restart the disposable backend while a turn is visibly active, reconnect mobile, and
      verify the stale turn is interrupted, the thread is not indefinitely working, and the
      composer permits a subsequent send.
- [ ] 3.5 Send a recovery follow-up and verify resumable provider state is reused or safely
      re-established without duplicating the interrupted request or visible history.

## 4. Verify Kimi on Mobile

- [ ] 4.1 Enable the authenticated Kimi instance, select `kimi-default` on mobile, and verify Kimi
      identity and provider-instance routing with no unrelated provider fallback.
- [ ] 4.2 Run a deterministic Kimi prompt and verify streamed assistant rendering, one terminal turn
      state, and return to a sendable composer.
- [ ] 4.3 In approval-required mode, trigger a harmless local tool request in the disposable project,
      resolve it from mobile, and verify pending-request cleanup plus terminal tool rendering.
- [ ] 4.4 Interrupt an active Kimi turn, wait for ready state, send a follow-up, and verify exactly
      one interrupted terminal plus a successful resumed turn without duplicate content.

## 5. Record Evidence and Close the Debt

- [ ] 5.1 Run the focused mobile state/presentation tests, mobile typecheck, and native static check
      relevant to the verified surfaces and record their commands and results.
- [ ] 5.2 Create `verification.md` with device/runtime details, secret-safe origins, scenario results,
      focused commands, and retained screenshot or log paths; inspect every retained artifact for
      tokens, credentials, account data, prompt dumps, and raw protocol payloads.
- [ ] 5.3 Remove test-owned pairings, reverse-port rules, Metro, backend, simulator streaming, and
      disposable state, documenting any deliberately retained reproduction evidence.
- [ ] 5.4 Only after every required scenario passes, mark task 8.6 in
      `fix-provider-event-backpressure-recovery` and task 9.6 in
      `add-kimi-subscription-provider` complete with references to `verification.md`.
- [ ] 5.5 Strictly validate this change and both originating OpenSpec changes, leaving any failed or
      unavailable scenario and its originating task explicitly incomplete.
