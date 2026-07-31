## 1. Runtime operation

- [ ] 1.1 Add a capability-gated `listSessions` to `AcpSessionRuntime` that issues `session/list`
      and returns typed records
- [ ] 1.2 Return an explicit unsupported result when `sessionCapabilities.list` is absent, without
      sending a request
- [ ] 1.3 Add focused runtime tests against the mock ACP agent for supported, unsupported, empty,
      and failing cases

## 2. Contracts and adapter surface

- [ ] 2.1 Add a native session record (session id, cwd, title, updatedAt) to `packages/contracts`
- [ ] 2.2 Expose native session listing on the provider adapter shape for ACP-backed providers
- [ ] 2.3 Implement it for Kimi; confirm by live handshake whether Cursor, Grok, or OpenCode
      advertise the capability before implementing theirs
- [ ] 2.4 Update contract and adapter tests

## 3. Adoption path

- [ ] 3.1 Create a thread whose provider resume cursor names the chosen session, reusing the
      existing cursor shape rather than adding a second mechanism
- [ ] 3.2 Detect a session already bound to an existing thread and surface that thread instead
- [ ] 3.3 Mark the thread as adopted so the client can explain the missing history
- [ ] 3.4 Add focused server tests including the already-bound case

## 4. Browsing surface

- [ ] 4.1 List sessions ordered by last update, with working directory and timestamp
- [ ] 4.2 Fall back from placeholder titles to directory and timestamp
- [ ] 4.3 Decide the open question of whether to filter to the current project's directory by
      default, and record it in `design.md`
- [ ] 4.4 Show the working-directory mismatch before adoption
- [ ] 4.5 Report empty and failed listings distinctly
- [ ] 4.6 Add focused web tests

## 5. Adopted-thread presentation

- [ ] 5.1 Show that the thread was adopted and that prior turns are not in its history
- [ ] 5.2 Assert replayed session updates do not become thread activity
- [ ] 5.3 Confirm this change does not foreclose a later read-only imported transcript

## 6. Verification

- [ ] 6.1 Run the focused server and web tests for the touched files
- [ ] 6.2 Verify end to end with a Kimi session started outside T3 Code, using the `test-t3-app`
      skill
- [ ] 6.3 Document adoption and its history limits in `docs/providers/kimi.md`
