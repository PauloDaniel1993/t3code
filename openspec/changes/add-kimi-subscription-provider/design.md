## Context

T3 Code's provider-instance architecture already separates an open `ProviderDriverKind` from user-defined instance identities. Built-in drivers bundle status, adapter, and text-generation services, while `ProviderInstanceRegistryHydration` still mirrors every built-in driver through the legacy `ServerSettings.providers` object. Cursor and Grok demonstrate ACP-backed drivers, and the server already has shared ACP process/session, event, attachment, logging, snapshot, and maintenance primitives.

The supported upstream is the current Node-based Kimi Code CLI distributed as `@moonshot-ai/kimi-code` or through Kimi's native installer. The legacy Python `kimi-cli` is being retired and is not an integration target. The current CLI exposes `kimi acp`, uses Kimi Code membership OAuth credentials created by `kimi login`, stores its state beneath `KIMI_CODE_HOME`, and negotiates session model/thinking/mode options through ACP. ACP authentication validates existing credentials; it does not run the device-code login flow. ACP also lacks `session/close` and terminal reverse-RPC, so subprocess cleanup and local-shell security must be explicit.

This change overlaps active work in `handoff-spec-alignment`, which is introducing `TextGenerationShared.ts`, and attachment changes that are consolidating attachment delivery. Kimi should consume those shared seams rather than fork their behavior or modify their capabilities.

## Goals / Non-Goals

**Goals:**

- Add a built-in, subscription-backed `kimi` driver that behaves like a normal provider instance across server, web, and mobile.
- Keep authentication and credential refresh owned by the Kimi Code CLI while surfacing precise readiness states.
- Reuse the standard ACP surface for sessions, models, streaming, tools, permissions, questions, attachments, interruption, and resume.
- Preserve Kimi's ability to delegate substantial work to subagents while keeping result-dependent delegation observable inside the active ACP prompt.
- Support multiple Kimi instances with deterministic `KIMI_CODE_HOME` isolation.
- Provide focused mocked protocol tests plus an opt-in real-CLI compatibility probe.

**Non-Goals:**

- Calling Kimi's OpenAI-compatible or Anthropic-compatible HTTP APIs directly.
- Accepting or storing Moonshot/Kimi Platform API keys in T3 Code.
- Supporting the retired Python `kimi-cli` protocol or data layout.
- Implementing Kimi account creation, OAuth login, or logout inside T3 Code; users authenticate the selected home with `kimi login`.
- Exposing Kimi-only experimental ACP methods, its web UI, detached background-agent rosters, plugins, or scheduled tasks as new T3 concepts.
- Refactoring the existing Cursor and Grok adapters wholesale while adding Kimi.

## Decisions

### 1. Integrate the official Kimi Code CLI through standard ACP

Add `KimiDriver`, `KimiProvider`, `KimiAdapter`, `KimiAcpSupport`, and `KimiTextGeneration` modules and register the driver as `kimi`. `KimiAcpSupport` launches the configured executable with `acp` and supplies authentication method `login` to `AcpSessionRuntime`. Kimi-specific code reuses `AcpSessionRuntime`, `AcpAdapterSupport`, `AcpRuntimeModel`, `AcpCoreRuntimeEvents`, `AcpNativeLogging`, and `acpAttachments`.

The adapter remains Kimi-specific at the lifecycle boundary. Cursor has proprietary plan/question extensions and Grok has xAI completion extensions; extracting a universal adapter during this change would mix materially different behavior. Small generic helpers may be extracted only where Kimi needs functionality already implemented identically twice.

Alternatives considered:

- **Direct subscription API key:** rejected because it requires separate key management and provides raw model access rather than Kimi's agent, session, tool, and permission behavior.
- **Legacy Python CLI:** rejected because upstream is winding it down and its home/config/protocol differ from the current product.
- **Reuse the Grok adapter:** rejected because Kimi's documented `session/prompt` completes normally and has no xAI extension requirement.

### 2. Add decode-safe settings and isolate state with `KIMI_CODE_HOME`

Add `KimiSettings` to contracts with:

- `enabled`, default `false` for the synthesized built-in instance;
- `binaryPath`, default `kimi`;
- `homePath`, blank by default and mapped to `KIMI_CODE_HOME` when set;
- hidden `customModels`, default `[]`, for explicit compatibility fallbacks.

Add `providers.kimi` and `KimiSettingsPatch` while retaining opaque `providerInstances[*].config` behavior. The driver advertises multiple-instance support. Each child environment is produced through `mergeProviderInstanceEnvironment`, then receives the resolved Kimi home consistently for version/auth probes, chat, and text generation. The provider binding and resume cursor prevent a native session from being resumed through a different instance even when homes are shared deliberately.

T3-spawned Kimi processes set `KIMI_CODE_NO_AUTO_UPDATE=1` after environment merging. This prevents the executable from changing underneath an active ACP session; updates remain explicit through provider maintenance. T3 does not read Kimi credential files or copy them between homes.

Alternative considered: rely only on the generic environment-variable editor. Rejected because account/session isolation is central to multiple subscription instances and deserves a discoverable, consistently applied setting like Codex and Claude home paths.

### 3. Probe readiness without creating sessions or performing login

Status checking has two bounded phases:

1. Run the configured executable with `--version` to distinguish missing/invalid binaries and parse the installed version.
2. Start `kimi acp`, negotiate `initialize`, verify required capabilities, and call `authenticate` with method `login`; then terminate the probe without `session/new`.

This distinguishes disabled, missing, incompatible ACP, unauthenticated, and ready states without consuming subscription quota, starting device login, or leaving discovery sessions in Kimi's persistent session index. Error mapping recognizes ACP `authRequired` separately from process/protocol failures. Native payload diagnostics use the existing redacted logger policy and never record full prompts, completions, environments, or credentials.

Alternative considered: inspect `~/.kimi-code` or its credential JSON directly. Rejected because it couples T3 to a private storage schema and increases credential exposure.

### 4. Bootstrap model selection, then make ACP configuration options authoritative

Readiness probing intentionally does not call `session/new`, but Kimi exposes account-specific model/thinking/mode choices in that response. The initial ready snapshot therefore exposes a synthetic `kimi-default` selection labeled `Kimi default` plus explicit `customModels`; choosing the synthetic value means "leave Kimi's configured default unchanged." It does not claim entitlement to a named upstream model.

On a real `session/new` or `session/resume`, the adapter captures the returned ACP configuration options, normalizes model options into `ServerProviderModel` entries, and publishes them through a small instance-scoped model state shared with `KimiProvider`. Provider-reported identifiers and labels replace speculative choices, while `kimi-default` remains available as the explicit no-override selection. Thinking and mode choices become normal `ProviderOptionSelection` values.

For a concrete selection, the adapter validates the requested value against the active configuration options and calls stable `session/set_config_option` before prompting. Compatibility fallbacks to `session/set_mode` or unstable `session/set_model` are used only when capability/fixture evidence requires them. A concrete rejected selection is an actionable error, never a silent fallback.

Alternatives considered:

- **Hard-code the current public Kimi model list:** rejected because membership entitlements and model names change.
- **Create a native session during every status refresh:** rejected because upstream has no `session/close`, so probing would pollute persistent history.
- **Parse Kimi config TOML:** rejected because configured models are not equivalent to account entitlement and the format is upstream-owned.

### 5. Use a versioned, instance-bound native session cursor

Each T3 thread owns one scoped Kimi ACP subprocess and a cursor shaped like `{ schemaVersion: 1, instanceId, sessionId }`. New threads use `session/new`. Resume uses `session/resume`, not `session/load`, because T3 already persists and renders its canonical history; replaying Kimi history would duplicate events. Cursor decoding validates all fields and the bound instance before any ACP request.

The Kimi adapter maps standard ACP assistant chunks, plans, tool updates, and configuration updates through canonical event helpers. It tracks one active turn, pending approvals, pending user-input requests, and the last successful resume cursor. Concurrent prompts are rejected by default. Steering may be enabled only after the real-CLI probe demonstrates that overlapping `session/prompt` requests preserve a single coherent turn.

On interrupt or stop, the adapter sends `session/cancel` when applicable, settles all pending deferred requests, emits terminal events once, closes the child scope, and terminates the subprocess. No `session/close` call is assumed.

### 6. Preserve Kimi permission choices and capability-gate external inputs

`session/request_permission` is decoded as either tool approval or question elicitation based on its payload. Approval option IDs are preserved and mapped to T3 decisions; the adapter does not invent allow outcomes. Full-access auto-approval selects only an upstream option that explicitly represents an allowed outcome. Approval-required mode always surfaces the request. Read-only policy rejects mutating operations even if Kimi offers an allow option.

Images and text resources reuse `acpAttachments` only when the initialized Kimi agent advertises those prompt capabilities. Unsupported binary, audio, and video inputs fail before dispatch. MCP forwarding is the intersection of T3 support and Kimi's negotiated capabilities; initial implementation supports verified stdio and HTTP behavior and does not promise SSE until the compatibility probe resolves conflicting upstream documentation.

Kimi shell commands execute locally inside the Kimi subprocess because upstream does not implement ACP terminal reverse-RPC. The adapter must not present those commands as sandboxed or client-delegated; normal permission events and the provider instance's working directory/environment remain the security boundary.

### 7. Build auxiliary generation on the shared JSON factory

Sequence Kimi text generation after the `handoff-spec-alignment` factory work, or include the equivalent factory commit first. `KimiTextGeneration` provides only the ACP transport to `makeJsonTextGeneration`: create a scoped authenticated Kimi runtime, open a dedicated auxiliary native session, send the generated prompt, collect assistant chunks, and let the shared factory handle JSON extraction, schema validation, sanitization, timeout, and retry policy.

Auxiliary sessions never attach to a user-visible T3 thread and never reuse its conversational context. Because upstream lacks `session/close` or delete, each successfully created auxiliary native session may remain in Kimi's own session store after the subprocess exits. The implementation records this limitation and avoids manipulating upstream session files directly. If the real probe shows `kimi -p --output-format stream-json` can provide isolated, non-persistent generation, that transport may replace ACP without changing the public driver contract.

Alternative considered: reuse the active chat session for titles and handoff summaries. Rejected because unrelated hidden prompts would contaminate user context and resume history.

### 8. Use managed snapshots and conservative maintenance

`KimiDriver` follows the managed snapshot pattern used by Cursor/Grok/OpenCode. Maintenance metadata recognizes the official npm package `@moonshot-ai/kimi-code`; known package-manager installs can use the package update path. Native or custom executable paths expose the documented `kimi upgrade` action only when the maintenance coordinator can supervise its foreground interaction safely; otherwise they show manual update guidance. Unknown latest-version information is advisory and does not make a capability-compatible installation unready.

Windows status guidance mentions Git for Windows or `KIMI_SHELL_PATH` only when launch diagnostics indicate the shell dependency. Custom absolute binary paths remain supported for GUI-launched macOS/Windows clients that do not inherit a terminal `PATH`.

### 9. Register Kimi presentation once per client surface

Web adds `KimiSettings` to `providerDriverMeta`, `Kimi` to `PROVIDER_OPTIONS`, and a dedicated icon mapping. The generic settings form, provider-instance cards, add-instance dialog, status rows, model picker, and handoff UI then consume the normal provider snapshot without Kimi-specific branches.

Mobile routing remains provider-generic, but `ProviderIcon.tsx` and fallback model labels gain explicit Kimi presentation so Kimi is not rendered as OpenAI. README/provider documentation explains supported CLI installation, `kimi login`, `KIMI_CODE_HOME`, and the distinction between Kimi Code membership and Platform API access.

### 10. Keep result-dependent subagents inside the active ACP prompt

The current Kimi Code CLI can launch `Agent` subagents in either foreground or detached background
mode. Real-CLI evidence shows that a detached subagent returns a running task receipt through the
active ACP prompt, but its later completion is injected into Kimi's private session as an
autonomous turn. Kimi can read and summarize that result internally, yet no corresponding
`session/update` or `session/prompt` response is sent to T3 Code because the original ACP request
has already ended. T3 therefore cannot durably supervise or render that autonomous response.

The adapter prepends concise provider-only supervision guidance to non-empty Kimi prompts. Kimi
may and should use subagents, including issuing independent `Agent` calls together, but it must
keep any subagent whose result is required for the current request in foreground mode. It must
synthesize those returned results before ending `session/prompt`. A later user turn also instructs
Kimi to report any completed background-task notifications already present in native session
context before starting unrelated status work.

ACP tool calls whose input identifies an agent delegation are rendered canonically as
`collab_agent_tool_call` activities. A detached launch is presented as a completed launch action,
not as a durably running T3 task, because upstream ACP provides no authoritative terminal event.
If a future Kimi ACP release publishes task-started/progress/completed notifications, T3 can map
those to the existing canonical task lifecycle without changing this foreground correctness rule.

Alternatives considered:

- **Disable subagents:** rejected because delegation is valuable for parallel review and focused
  codebase exploration.
- **Poll Kimi's private task files:** rejected because it couples T3 to an undocumented home and
  session layout, bypasses ACP, and would be unsafe across custom homes and upstream upgrades.
- **Auto-send repeated status prompts:** rejected because it consumes subscription quota, can race
  Kimi's autonomous loop, and still cannot prove task terminality.

## Risks / Trade-offs

- **[Risk] ACP behavior changes independently of T3 releases.** → Negotiate capabilities, parse unknown non-critical updates defensively, maintain a mocked protocol fixture, and keep an opt-in real-CLI probe.
- **[Risk] Pre-session account models are not discoverable without creating a persistent session.** → Use the explicit `kimi-default` sentinel, publish authoritative options only after a real session, and never create status-only native sessions.
- **[Risk] Auxiliary generation leaves native Kimi session records.** → Keep them separate from T3 chat, avoid direct vendor-file deletion, document the upstream limitation, and prefer a verified non-persistent transport if one becomes available.
- **[Risk] Kimi permission payloads use the same channel for approvals and questions.** → Parse both shapes explicitly and test multi-question, cancel, unknown-option, and stop cleanup paths.
- **[Risk] `KIMI_CODE_HOME` isolates Kimi state but not the process.** → Preserve T3 runtime policy and approval handling, disclose local shell execution, and never describe the home boundary as a sandbox.
- **[Risk] Kimi's built-in updater races with provider sessions.** → Disable background update in managed children and serialize explicit maintenance through the existing coordinator.
- **[Risk] Active handoff/attachment changes create merge conflicts.** → Land or rebase on `handoff-spec-alignment`, reuse its text-generation factory and current attachment helpers, and avoid changing provider-generic specs.

- **[Risk] Detached Kimi subagent completions are invisible to ACP clients.** → Keep
  result-dependent subagents in the foreground, identify their tool activities canonically, and
  do not claim detached task supervision until upstream emits an authoritative lifecycle.

## Migration Plan

1. Land after, or rebase onto, the shared text-generation factory from `handoff-spec-alignment` and the current attachment helper changes.
2. Add decode-safe contracts and the disabled legacy Kimi settings entry; existing settings require no rewrite.
3. Register the driver and status probe behind its disabled-by-default configuration.
4. Add mocked ACP compatibility tests, then run an opt-in probe against the current authenticated Kimi Code CLI before enabling the client option.
5. Add web/mobile presentation and documentation, run focused package verification, then perform the required integrated web and representative mobile client passes.

Rollback removes Kimi from the built-in driver/client catalogs while leaving persisted `providerInstances` envelopes intact. Because driver kinds and config payloads are open, older builds preserve Kimi entries as unavailable instances instead of failing settings decode. No Kimi credential or session migration is performed by T3 Code.

## Open Questions

- What exact model/thinking/mode option shapes and permission option IDs does the current `kimi acp` return for each supported subscription tier? The gated compatibility probe must capture redacted fixtures before final adapter mapping.
- Does the current CLI settle `session/prompt` and support safe steering exactly as documented, or must Kimi remain single-send until upstream behavior changes?
- Can `kimi upgrade` be driven non-interactively for every native install source, especially Windows, or should those sources remain manual-only?
- Does current Kimi ACP actually accept SSE MCP entries? Until verified, the provider advertises only the intersection proven by fixture/integration tests.
