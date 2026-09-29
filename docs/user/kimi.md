# Kimi

Kimi uses your local Kimi Code CLI and membership through ACP. Install `@moonshot-ai/kimi-code`, run `kimi login`, then enable Kimi in Settings and refresh its status. The older Python `kimi-cli` package and the ACP Registry's legacy Kimi distribution are not supported.

If the server cannot find `kimi`, set **Binary path** to its absolute executable path. On Windows, `where.exe kimi` lists the installed commands. If the CLI needs a different shell, configure `KIMI_SHELL_PATH` in the provider instance's environment.

To use another membership, set **KIMI_CODE_HOME path** to a separate home directory. Authenticate that same home first:

```powershell
$env:KIMI_CODE_HOME = "$env:USERPROFILE\.kimi-code-work"
kimi login
```

The Kimi default model follows the CLI's current selection. Opening a conversation discovers available models and thinking options. T3's plan toggle selects Kimi's read-only mode. T3 retains permission handling even under full access, so autonomous CLI modes cannot override saved approval policy.

Kimi can generate titles, branch names, commit messages, and change request descriptions when selected as the system model. These helpers use fresh read-only sessions. Kimi may retain their native session records in its home directory.

T3 disables Kimi's automatic updates while managing its processes. npm and WinGet installations use their owning package manager. A native Windows installation requires a manual update using the vendor's installer:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```
