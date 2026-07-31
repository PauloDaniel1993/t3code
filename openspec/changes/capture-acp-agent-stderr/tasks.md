## 1. Decide redaction first

- [ ] 1.1 Decide what redaction applies to captured stderr before retention, logging, or error
      attachment, and record it in `design.md`
- [ ] 1.2 Do not merge capture without this decision — at least one provider's auth flow is a
      device-code exchange that may print to stderr

## 2. Expose stderr from the client layer

- [ ] 2.1 Expose the child's stderr stream from `EffectAcpClient.layerChildProcess` in
      `packages/effect-acp`
- [ ] 2.2 Keep the JSON-RPC transport behavior on stdin/stdout unchanged
- [ ] 2.3 Add focused tests in `packages/effect-acp`

## 3. Capture in the session runtime

- [ ] 3.1 Consume stderr into a bounded most-recent window in `AcpSessionRuntime`, forked under the
      runtime scope
- [ ] 3.2 Apply the agreed redaction at capture time
- [ ] 3.3 Expose the recent window to adapters
- [ ] 3.4 Confirm the reader is interrupted on scope close
- [ ] 3.5 Add focused runtime tests using the mock ACP agent, including a verbose agent that
      overflows the window

## 4. Native event log

- [ ] 4.1 Record stderr as process diagnostics, distinguishable from JSON-RPC traffic
- [ ] 4.2 Decide whether stderr logging needs its own throttle for a chatty agent
- [ ] 4.3 Add focused logging tests

## 5. Error attribution

- [ ] 5.1 Attach the recent window to mapped errors in `AcpAdapterSupport`, preserving existing error
      types and messages
- [ ] 5.2 Cover spawn failure, startup failure, and prompt failure
- [ ] 5.3 Decide whether the window is surfaced in the provider card's error state or kept to logs
- [ ] 5.4 Add focused adapter tests

## 6. Demote the Kimi log scraper

- [ ] 6.1 Prefer a stderr-derived failure message in `KimiAdapter`, falling back to
      `KimiAcpDiagnostics`
- [ ] 6.2 Record which source produced the message
- [ ] 6.3 Add a test asserting the fallback still works when stderr is silent
- [ ] 6.4 After a period of real use, evaluate whether the scraper still produces messages stderr
      does not, and open a follow-up to remove it if not

## 7. Verification

- [ ] 7.1 Run the focused tests for `packages/effect-acp` and the touched server files
- [ ] 7.2 Verify a real Kimi turn failure surfaces its reason from stderr
- [ ] 7.3 Verify a deliberately broken binary path produces a spawn error carrying the agent's own
      output
