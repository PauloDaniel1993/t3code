# Kimi

T3 Code's Kimi provider uses a local installation of the current, Node-based Kimi Code CLI and
your Kimi Code membership. It starts the CLI through `kimi acp`; it does not call the Moonshot or
Kimi Platform API directly.

## Install and authenticate

Install the current Kimi Code CLI so the `kimi` command is on the server's `PATH`. One supported
installation method is npm:

```bash
npm install -g @moonshot-ai/kimi-code
kimi --version
kimi login
```

The upstream [Kimi Code CLI installation guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
also documents native installers. T3 Code does not support the older Python `kimi-cli` package.

After login, open T3 Code Settings, find the built-in Kimi provider, enable it, and refresh provider
status. A ready card shows the detected CLI version and authenticated state. If it remains
unavailable, use the card's installation, login, or compatibility message rather than starting a
new session repeatedly.

The default settings are:

```text
Binary path: kimi
KIMI_CODE_HOME path: empty
```

An empty home path lets the CLI use its normal Kimi Code home. T3 Code asks the CLI to validate its
existing membership login, but it does not open the login flow itself. Run `kimi login` in a local
terminal whenever the selected home needs authentication.

## Use a separate Kimi membership or home

Each Kimi provider instance can point at a different `KIMI_CODE_HOME`. Authenticate the exact home
before selecting it in T3 Code.

On macOS or Linux:

```bash
mkdir -p ~/.kimi-code-work
KIMI_CODE_HOME=~/.kimi-code-work kimi login
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.kimi-code-work"
$env:KIMI_CODE_HOME = "$env:USERPROFILE\.kimi-code-work"
kimi login
```

Then add or edit a Kimi provider instance:

```text
Display name: Kimi Work
Binary path: kimi
KIMI_CODE_HOME path: ~/.kimi-code-work
```

Use the corresponding absolute Windows path in the Windows server environment. The home setting
isolates Kimi configuration, membership credentials, and native sessions; it is not a process
sandbox.

## Binary path and shell troubleshooting

Desktop and GUI-launched servers do not always inherit the same `PATH` as an interactive terminal.
If T3 Code reports that Kimi is missing even though `kimi --version` succeeds in your terminal, set
the provider's Binary path to the absolute executable reported by:

```bash
command -v kimi
```

On Windows, use:

```powershell
where.exe kimi
```

Windows CLI startup can also depend on Git for Windows or an explicitly configured
`KIMI_SHELL_PATH`. Follow the provider card's shell-specific guidance if launch diagnostics identify
that dependency.

## Updates

For an npm installation, update with:

```bash
npm install -g @moonshot-ai/kimi-code@latest
```

Native installations may support `kimi upgrade`. T3 Code only offers an in-app update action when
it can safely supervise the detected installation; otherwise, use the provider card's manual update
instructions and refresh status afterward. T3-managed Kimi sessions disable background CLI updates
so the executable cannot change during an active session.

## Authentication and security boundaries

- Kimi Code CLI owns the OAuth login and refresh state for your membership. T3 Code neither reads,
  copies, displays, nor manages those tokens.
- This provider does not accept Moonshot or Kimi Platform API keys. Platform API access is a
  separate product and is not a substitute for `kimi login`.
- The retired Python `kimi-cli` protocol and data layout are not supported.
- Kimi ACP does not delegate terminal execution back to T3 Code. When you approve a Kimi shell
  action, the Kimi subprocess runs it locally with the provider instance's working directory and
  environment. Review permission prompts with the same care as commands run in your own terminal.
- Auxiliary title, branch, commit, and pull-request generation uses isolated Kimi ACP sessions.
  Current Kimi Code releases do not expose a native session-delete operation, so those session
  records can remain in the selected `KIMI_CODE_HOME` after T3 releases the subprocess.

## Subagents

Kimi can use its built-in `Agent` subagents in T3 Code. For work needed to answer the current
request, T3 asks Kimi to run those agents in foreground mode. Independent agents can still run in
parallel, but their results return through the active ACP prompt so Kimi can synthesize them before
the turn ends.

Detached Kimi background agents are different: current Kimi ACP releases return the launch receipt
but do not publish the later autonomous completion turn to the ACP client. T3 therefore does not
claim to supervise those detached tasks. If a native session already contains an unsurfaced
background result, the next user prompt asks Kimi to report it before starting unrelated work.

See the upstream [`kimi acp` reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
for the CLI integration surface.
