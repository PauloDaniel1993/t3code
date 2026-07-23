## 1. Upstream Compatibility and Shared Prerequisites

- [x] 1.1 Before editing server Effect code, read `.repos/effect-smol/LLMS.md` and inspect the existing Cursor/Grok ACP layers for the repository's current Effect patterns.
- [x] 1.2 Rebase or sequence this change after `handoff-spec-alignment` supplies `TextGenerationShared.ts`, and confirm the current attachment changes expose the `acpAttachments` APIs Kimi will consume.
- [x] 1.3 Add an opt-in real-CLI probe for the current Node-based Kimi Code CLI that redacts payloads and records initialize/authentication, `session/new` configuration options, prompt settlement, permission/question shapes, resume behavior, and negotiated attachment/MCP capabilities.
- [x] 1.4 Convert the verified real-CLI exchanges into a deterministic mock ACP fixture and document which capabilities remain gated, including steering and SSE MCP forwarding.

## 2. Contracts and Compatibility

- [x] 2.1 Add annotated `KimiSettings` with disabled-by-default `enabled`, `binaryPath`, `homePath`, and hidden `customModels` fields in `packages/contracts/src/settings.ts`.
- [x] 2.2 Add `providers.kimi`, `KimiSettingsPatch`, and the required contracts exports while preserving opaque provider-instance envelopes and legacy settings defaults.
- [x] 2.3 Add the synthetic `kimi-default` model identity/display metadata and extend any closed text-generation provider discriminants that must recognize `kimi`.
- [x] 2.4 Add focused contracts tests for old-settings decode, Kimi defaults, patch decode/round-trip, explicit Kimi instances, custom models, and unchanged unknown-driver compatibility.

## 3. Kimi ACP Process and Provider Status

- [x] 3.1 Implement a Kimi process-environment helper that resolves `homePath` into `KIMI_CODE_HOME`, preserves per-instance environment entries, and forces `KIMI_CODE_NO_AUTO_UPDATE=1` for T3-managed children.
- [x] 3.2 Add `provider/acp/KimiAcpSupport.ts` to spawn `<binaryPath> acp`, authenticate with method `login`, expose negotiated configuration/capability state, and map ACP errors through existing typed helpers.
- [x] 3.3 Add focused Kimi ACP support tests for exact command/arguments, working directory, custom home isolation, environment precedence, authentication-required mapping, process cleanup, and redacted diagnostics.
- [x] 3.4 Add an instance-scoped Kimi model-state primitive seeded with `kimi-default` and custom models, then support publishing normalized provider-reported model/thinking/mode options after a real session starts.
- [x] 3.5 Implement `Layers/KimiProvider.ts` with disabled, missing-binary, version, incompatible-ACP, unauthenticated, and ready snapshots using `kimi --version` plus initialize/authenticate without `session/new`.
- [x] 3.6 Add Kimi provider tests proving status probes do not initiate login, create a native session, consume a prompt, read credential files, or make update-check failure block an otherwise ready provider.
- [x] 3.7 Register conservative maintenance capabilities for `@moonshot-ai/kimi-code`, native/custom install guidance, serialized explicit updates, post-update refresh, and manual-only fallbacks where `kimi upgrade` cannot be supervised safely.

## 4. Kimi Session Adapter

- [x] 4.1 Add the Kimi adapter shape and `Layers/KimiAdapter.ts` with per-thread scoped ACP runtimes, canonical session lifecycle events, and a versioned `{ schemaVersion, instanceId, sessionId }` resume cursor.
- [x] 4.2 Implement new-session and `session/resume` paths, reject malformed or cross-instance cursors, avoid `session/load` history replay, and terminate processes without assuming upstream `session/close`.
- [x] 4.3 Normalize Kimi ACP model/thinking/mode configuration options, update instance model state, apply concrete selections before prompts, preserve `kimi-default` as no override, and fail rejected selections without silent fallback.
- [x] 4.4 Map assistant chunks, plans, tool lifecycle/configuration updates, completion results, failures, cancellation, and unknown non-critical updates into ordered canonical events with exactly one terminal turn event.
- [x] 4.5 Decode `session/request_permission` into either tool approval or structured user input, preserve upstream option IDs, enforce T3 runtime policy, and settle all pending requests on interrupt/stop.
- [x] 4.6 Capability-gate image/text-resource delivery and MCP forwarding through `acpAttachments`, rejecting unsupported audio/video/binary inputs before any partial prompt and keeping unverified SSE disabled.
- [x] 4.7 Enforce single-send behavior until the real probe proves steering safe; if steering is verified, add the same logical-turn accounting and completion guarantees used by existing ACP providers.
- [x] 4.8 Add focused adapter tests for start/resume/cross-instance rejection, model and mode selection, streaming/tools/plans, approvals, multiple questions, policy modes, attachments/MCP, interruption, concurrent send behavior, malformed updates, and scope cleanup.

## 5. Driver and Auxiliary Text Generation

- [x] 5.1 Implement `KimiTextGeneration.ts` as a scoped Kimi transport for the shared JSON text-generation factory, with independent native sessions, timeouts, cancellation, output collection, validation, retry policy, and secret-safe logging.
- [x] 5.2 Add Kimi text-generation tests for each shared operation, selected/default model behavior, malformed or empty output, authentication loss, timeout, interruption, cleanup, and the documented upstream native-session persistence limitation.
- [x] 5.3 Implement `Drivers/KimiDriver.ts` to bundle the instance-scoped status, adapter, model state, text generation, continuation identity, environment, maintenance, and display identity.
- [x] 5.4 Register `KimiDriver` and its environment in `builtInDrivers.ts`, update default-instance hydration/registry expectations, and prove disabled and explicit multiple-instance configurations reconcile independently.
- [x] 5.5 Add focused driver/registry tests confirming Kimi routing, per-instance homes, model-state publication, handoff readiness, text-generation eligibility, and decode-safe downgrade to an unavailable unknown driver.

## 6. Web Client Surface

- [x] 6.1 Add a Kimi icon and register `KimiSettings`, label, badge decision, and schema-driven definition in `providerDriverMeta.ts` and provider icon utilities.
- [x] 6.2 Register Kimi in `session-logic.ts` so ready Kimi instances participate in the model picker, favorites, generation settings, and provider-generic handoff UI.
- [x] 6.3 Add focused web tests for the add-instance driver option, binary/home settings fields, Kimi status/auth/version rows, icon mapping, `kimi-default`, discovered model options, and actionable unavailable reasons.
- [x] 6.4 Verify unknown drivers and all existing provider ordering, icons, settings forms, and picker behavior remain unchanged after Kimi registration.

## 7. Mobile Client Surface

- [x] 7.1 Add explicit Kimi rendering to `apps/mobile/src/components/ProviderIcon.tsx` and Kimi fallback labels to `apps/mobile/src/lib/modelOptions.ts` without changing generic instance routing.
- [x] 7.2 Add focused mobile tests proving Kimi threads/models use Kimi identity instead of the OpenAI fallback and existing providers retain their presentation.

## 8. Documentation

- [x] 8.1 Add provider documentation for installing the current Kimi Code CLI, enabling the Kimi instance, running `kimi login`, configuring `KIMI_CODE_HOME`, refreshing status, updating, and Windows/macOS executable-path caveats.
- [x] 8.2 Document that T3 uses membership-owned CLI OAuth state, does not manage tokens, does not support the legacy Python CLI or Platform API keys, and that Kimi executes approved shell commands locally rather than through ACP terminal delegation.
- [x] 8.3 Update the README/docs provider inventory and link the Kimi guide without altering unrelated marketing claims.

## 9. Focused Verification and Integrated Client Checks

- [x] 9.1 Run the changed contracts tests with `vp test run` and the contracts package typecheck; fix all failures.
- [x] 9.2 Run the new Kimi ACP/provider/adapter/driver/text-generation tests plus only directly affected shared ACP/registry tests with `vp test run`; run the server package typecheck.
- [x] 9.3 Run the changed web and mobile test files with `vp test run`, then run targeted web/mobile typechecks, mobile native static checks when applicable, icon export checks, lint, and formatting for the changed scope.
- [x] 9.4 Run the gated real Kimi CLI compatibility probe against an authenticated test home, confirm no secrets appear in captured output, and reconcile the mock fixture or capability gates with the observed protocol.
- [x] 9.5 Use the `test-t3-app` skill to launch one isolated web environment, authenticate through its pairing URL, and verify enabling Kimi, readiness/login guidance, instance configuration, model selection, a streamed turn, approval, interrupt/resume, and handoff eligibility; stop all launched processes afterward.
- [ ] 9.6 Use the `test-t3-mobile` skill with one representative simulator/emulator connected to an isolated environment and verify Kimi identity, model selection, streamed thread rendering, approval, and resume; stop all launched processes afterward.
- [x] 9.7 Reproduce the long-turn stall caused by unread ACP child stderr, drain provider diagnostics without logging their contents, add shared ACP and Kimi adapter backpressure regressions, and rerun the authenticated Kimi interaction probe.

## 10. Review Remediation

- [x] 10.1 Validate empty prompts before lifecycle emission, reject overlapping sends, and remove
      unreachable steering state.
- [x] 10.2 Restrict structured-question detection to explicit Kimi question requests so ordinary
      approvals retain full-access policy behavior.
- [x] 10.3 Make resume tolerate absent model configuration, serialize interruption state, and
      guarantee one terminal event for cancellation, late notifications, and malformed updates.
- [x] 10.4 Run a live isolated web pass that enables and authenticates Kimi, selects `kimi-default`,
      observes startup recovery after a server restart, resumes the provider session, and completes
      a subsequent turn.

## 11. Supervised Kimi Subagents

- [x] 11.1 Capture real Kimi ACP evidence for foreground and detached `Agent` behavior, then align
      the proposal, design, and provider requirement with the upstream lifecycle boundary.
- [x] 11.2 Keep result-dependent Kimi subagents inside the active ACP prompt and classify ACP
      `Agent` invocations as canonical collaboration-agent tool activities.
- [x] 11.3 Add focused supervision/classification regressions, document the foreground/background
      boundary, and run the affected server tests, formatting, and typecheck.
