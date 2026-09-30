# Kimi

Choose **Kimi** in Settings to use your local Kimi Code CLI and membership. Install `@moonshot-ai/kimi-code`, run `kimi login`, then enable the provider and refresh its status. The ACP Registry's **Kimi CLI** entry is a separate legacy integration; the built-in driver supports Kimi Code, rather than the older Python `kimi-cli` package.

If the server cannot find `kimi`, set **Binary path** to its absolute executable path. On Windows, `where.exe kimi` lists the installed commands. If the CLI needs a different shell, configure `KIMI_SHELL_PATH` in the provider instance's environment.

To use another membership, set **KIMI_CODE_HOME path** to a separate home directory. Authenticate that same home first:

```powershell
$env:KIMI_CODE_HOME = "$env:USERPROFILE\.kimi-code-work"
kimi login
```

The Kimi default model follows the CLI's current selection. Opening a conversation discovers available models and thinking options. T3 remembers the available models across server restarts, so tasks can use a named model before another Kimi conversation runs. A new account or a newly added model needs a conversation to refresh the available models before tasks can use it. Model switching may be unavailable on some resumed threads. T3's plan toggle uses Kimi's read-only mode; if that mode is unavailable, the turn fails and you can start a new thread to try again. T3 retains permission handling even under full access.

Kimi can generate titles, branch names, commit messages, and change request descriptions when selected as the system model. These helpers use fresh read-only sessions. Kimi may retain their native session records in its home directory.

T3 disables Kimi's automatic updates while managing its processes. npm and WinGet installations use their owning package manager. A native Windows installation requires a manual update using the vendor's installer:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```
