# Kimi

Choose **Kimi Code (supported)** in Settings to use your local Kimi Code CLI and membership through ACP. Install `@moonshot-ai/kimi-code`, run `kimi login`, then enable the provider and refresh its status. The ACP Registry's **Kimi CLI** entry is a separate legacy integration; the built-in driver supports Kimi Code, rather than the older Python `kimi-cli` package.

If the server cannot find `kimi`, set **Binary path** to its absolute executable path. On Windows, `where.exe kimi` lists the installed commands. If the CLI needs a different shell, configure `KIMI_SHELL_PATH` in the provider instance's environment.

To use another membership, set **KIMI_CODE_HOME path** to a separate home directory. Authenticate that same home first:

```powershell
$env:KIMI_CODE_HOME = "$env:USERPROFILE\.kimi-code-work"
kimi login
```

The Kimi default model follows the CLI's current selection. Opening a conversation discovers available models and thinking options. T3 remembers that catalog for this provider instance across server restarts, so tasks can use a named model before another Kimi conversation runs. A new instance or changed account needs its first conversation to discover models. A resumed session that omits model options keeps its native model and the last known catalog; switching models in that session may be unavailable until the CLI reports those options. T3's plan toggle selects Kimi's read-only mode. T3 retains permission handling even under full access, so autonomous CLI modes cannot override saved approval policy.

Kimi can generate titles, branch names, commit messages, and change request descriptions when selected as the system model. These helpers use fresh read-only sessions. Kimi may retain their native session records in its home directory.

T3 disables Kimi's automatic updates while managing its processes. npm and WinGet installations use their owning package manager. A native Windows installation requires a manual update using the vendor's installer:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

## Windows verification after installation and sign-in

These checks require a working Kimi Code installation. Use a disposable project and a separate authenticated Kimi home. Record the CLI version and installation path with the results.

1. **Executable.** Run `where.exe kimi`, then `kimi --version`. Look for the Kimi Code npm `kimi.cmd` shim, WinGet link, or `$env:USERPROFILE\.kimi-code\bin\kimi.exe`. If both integrations are installed, set the built-in provider's Binary path explicitly so it uses Kimi Code.
2. **Status and update.** Enable **Kimi Code (supported)** in Settings and refresh. Expect ready, authenticated, and a version. The updater should match the install: npm uses `npm install -g`, WinGet uses `winget upgrade --id MoonshotAI.KimiCodeCLI`, and native Windows requires the manual installer above.
3. **Separate sign-in.** Set KIMI_CODE_HOME path to an empty test directory and refresh. Expect not authenticated and guidance to run `kimi login`. Set `$env:KIMI_CODE_HOME` to that directory in PowerShell, run `kimi login`, then refresh. Expect ready; your original Kimi home should remain unchanged.
4. **Handshake and compatibility probe.** Run the optional probe below. Expect ACP protocol 1 or 2 and native resume or load support. Record authentication method types, image support, and MCP capabilities. Its raw setup observations record whether resume has `configOptions` and the model/mode options' `id`, `name`, and `category`, before T3 normalizes them.
5. **Model discovery.** Open a Kimi thread and send a short turn. Expect the real models and thinking options in the picker, with no separate Mode picker or autonomous mode option. Keep one discovered, non-default model ID for the later checks.
6. **Approvals.** Under approval-required, ask Kimi to run `git status`. Expect an approval card showing `git status`, without the CLI's `Requesting approval to Running:` prefix. Decline and confirm the command does not run. Under full-access, repeat and expect automatic approval. The ACP log should show supervised `default` mode, never `auto` or `yolo`.
7. **Plan and implementation.** Ask for a plan, then ask Kimi to implement it. Expect native mode to enter `plan` and return to `default`. The planning turn should execute no tools. A normal turn on a carried-over thread with an old saved plan selection should also run in `default`.
8. **Questions.** Ask Kimi to ask a scope question, including under full-access. Expect a question card that accepts your answer. Record whether the CLI used `AskUserQuestion` or `session/elicitation`; the optional interaction probe records their redacted shapes and cancels them.
9. **Cancellation.** Start a long turn and stop it. Expect interrupted status. In Task Manager, check that the Kimi process belonging to that turn exits and leaves no child process behind.
10. **Named-model delegation immediately after restart.** After step 5, restart the T3 server. Before opening or sending a turn in any Kimi thread, ask a Codex or Claude agent to delegate to `driverKind: "kimi"` with the discovered model ID explicitly supplied. Expect the task to start and its result to return, without a model-not-advertised error. A newly configured account without a saved catalog first needs step 5.
11. **Resume a chosen model.** Pick the non-default model in a Kimi thread, send a turn, restart the T3 server, and send another turn in that same thread. Expect `session/resume` (or `session/load` only on a load-only CLI), successful completion, and the same chosen model. If the raw resume response omits `configOptions`, expect the model catalog to remain available and no attempt to reselect the model. History should not duplicate or replay. Delegate another task with that explicit model afterwards; expect it to start and return its result.
12. **Failure diagnostics.** When a provider failure occurs, such as quota exhaustion or a network failure, expect a redacted reason and failed status. Compare with `<KIMI_CODE_HOME>\sessions\<id>\logs\kimi-code.log` and its `acp: turn ended with failed reason error=` line. Do not share credentials from logs.
13. **Images.** Attach a PNG. With advertised image support, expect Kimi to receive it. Without that support, expect a clear rejection.
14. **Text generation.** Select Kimi as the system text-generation model and generate a thread title, branch name, commit message, and change request description. Expect valid output, no tool execution, and no remaining `%TEMP%\t3-kimi-text-*` workspace. Native helper session records may remain in the Kimi home.
15. **Delegation and MCP bridge.** Delegate from Codex or Claude with the model omitted, then with the discovered model explicitly supplied. Expect both children to run and report a result. In a child, ask Kimi to call `t3_environment_read` and quote a field returned by the tool; verify an actual tool event, rather than a prose claim. Does this CLI accept T3's local stdio MCP bridge? The earlier integration supplied HTTP MCP and its captured fixture advertised HTTP support; that does not establish stdio support. Record the result and the handshake's `mcpCapabilities`. Supplying unsupported `options: [{id: "reasoningEffort", value: "high"}]` should return `invalid_request`.
16. **Process environment.** Inspect the Kimi child in Process Explorer. Expect `KIMI_CODE_NO_AUTO_UPDATE=1` and the configured `KIMI_CODE_HOME`.
17. **Windows shell.** Run a harmless shell tool. Expect output and a completed turn. If shell discovery fails, set `KIMI_SHELL_PATH` in this provider's environment to your shell's absolute executable path and retry.

### Optional CLI probe

From `apps/server` in a source checkout, opt in explicitly:

```powershell
$env:T3_KIMI_ACP_PROBE = "1"
$env:T3_KIMI_CODE_HOME = "C:\path\to\authenticated-test-home"
# Optional when Kimi Code is not the default executable on PATH:
$env:T3_KIMI_BINARY = "C:\path\to\kimi.cmd"
./node_modules/.bin/vp test run src/provider/acp/KimiAcpCliProbe.test.ts
```

Expect a passing authenticate/create/prompt/resume check and redacted `Kimi ACP compatibility observations`. The probe uses a temporary workspace, requests no tools, and offers no MCP servers. It does not test the child's MCP bridge; use step 15 for that. Set `$env:T3_KIMI_ACP_INTERACTION_PROBE = "1"` and repeat to request question/permission exchanges; every observed request is cancelled. Remove the probe variables afterwards with `Remove-Item Env:T3_KIMI_ACP_PROBE, Env:T3_KIMI_ACP_INTERACTION_PROBE, Env:T3_KIMI_CODE_HOME, Env:T3_KIMI_BINARY -ErrorAction SilentlyContinue`. Without `T3_KIMI_ACP_PROBE=1`, this test is skipped and never launches Kimi.
