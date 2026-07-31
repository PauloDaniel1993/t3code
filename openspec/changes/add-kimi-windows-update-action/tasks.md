## 1. Make the decision

- [ ] 1.1 Choose between candidate A (supervised vendor install script), B (steer to WinGet), and
      C (stay manual), and record the rationale in `design.md`
- [ ] 1.2 If A is chosen, record explicitly that T3 Code now executes vendor-hosted code fetched at
      run time, and what precedent that sets for other providers
- [ ] 1.3 Do not implement the Kimi-specific part before 1.1 is recorded

## 2. Outcome surfacing — proceeds regardless of the decision above

- [ ] 2.1 Consume `updateState` in `ProviderInstanceCard` and render succeeded, unchanged, failed,
      queued, and running states
- [ ] 2.2 Make the captured update output available for unchanged and failed outcomes, and handle
      the empty-output case
- [ ] 2.3 Scope the outcome to the instance the update ran on
- [ ] 2.4 Add focused web tests for each outcome

## 3. No-op exit codes

- [ ] 3.1 Decide whether `providerMaintenanceRunner` maps a known "nothing to do" exit code to
      `unchanged` rather than `failed`
- [ ] 3.2 If so, implement it for WinGet's no-available-upgrade status and add a focused test

## 4. Competing installations

- [ ] 4.1 Detect a second installation of the same provider alongside the resolved one
- [ ] 4.2 Report which installation is in use and that another exists, without modifying either
- [ ] 4.3 Add focused tests for the one-install and two-install cases

## 5. Implement the chosen Kimi path

- [ ] 5.1 Implement the recorded decision in `KimiDriver`
- [ ] 5.2 If a new capability shape is required beyond the existing `update` and `manualCommand`,
      extend `providerMaintenance` accordingly
- [ ] 5.3 Extend `KimiDriver.test.ts`, which already covers all six install sources
- [ ] 5.4 Update the update-path table in `docs/providers/kimi.md`

## 6. Verification

- [ ] 6.1 Run the focused server and web tests for the touched files
- [ ] 6.2 Verify the outcome surfacing against a real update that completes without changing the
      version — a native Windows Kimi install reproduces this exactly
- [ ] 6.3 Verify a successful update still reports success and a new version
