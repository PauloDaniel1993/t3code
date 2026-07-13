# Set Up the T3 Code Development Environment

This guide prepares a clean Windows or Linux machine for T3 Code development, checks out the repository's `dev` branch, and optionally installs a local desktop build. The local build uses a separate application identity and state directory, so it can coexist with the official release.

## Tooling Overview

| Tool                                   | Requirement                                  | Purpose                                                                       |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Git                                    | Required                                     | Clones and updates the repository                                             |
| Vite+ (`vp`)                           | Required                                     | Manages Node.js, pnpm, dependencies, tasks, builds, checks, and tests         |
| Codex, Claude, Cursor, or OpenCode CLI | Required                                     | Provides at least one coding-agent backend                                    |
| GitHub CLI (`gh`)                      | Optional                                     | Creates and manages pull requests from the machine                            |
| C++ build tools and Python             | Conditional on Windows, recommended on Linux | Compiles native Node modules when a compatible prebuilt binary is unavailable |

Do not install Node.js, pnpm, or Bun separately unless you have a specific reason to bypass Vite+'s managed environment. Vite+ reads the required runtime and package-manager versions from `package.json`.

## 1. Install the Machine Tools

### Windows

Open PowerShell and run:

```powershell
winget install --id Git.Git -e --source winget
irm https://vite.plus/ps1 | iex
```

Optionally install GitHub CLI:

```powershell
winget install --id GitHub.cli -e --source winget
```

Close every PowerShell window and open a new one. Then initialize and verify Vite+:

```powershell
vp env setup
vp env on
vp --version
git --version
```

If `vp` is not recognized, load its PowerShell environment explicitly:

```powershell
. "$env:USERPROFILE\.vite-plus\env.ps1"
vp --version
```

#### Conditional Windows Native Build Tools

Only install these heavyweight tools if `vp install` reports an error involving `node-gyp`, `node-pty`, MSVC, Python, or missing C++ build tools:

1. Install [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/downloads/).
2. Select **Desktop development with C++** and a current Windows SDK.
3. Install a current Python 3 release and ensure `python` is available in PowerShell.

### Linux

Install Git, `curl`, certificates, a C++ toolchain, and Python using the commands for your distribution.

#### Ubuntu or Debian

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3
```

Optionally install GitHub CLI:

```bash
sudo apt install -y gh
```

#### Fedora

```bash
sudo dnf install -y git curl ca-certificates gcc-c++ make python3
```

Optionally install GitHub CLI:

```bash
sudo dnf install -y gh
```

#### Arch Linux

```bash
sudo pacman -Syu
sudo pacman -S --needed git curl ca-certificates base-devel python
```

Optionally install GitHub CLI:

```bash
sudo pacman -S --needed github-cli
```

Install Vite+ on any supported Linux distribution:

```bash
curl -fsSL https://vite.plus | bash
```

Close and reopen the terminal, then run:

```bash
vp env setup
vp env on
vp --version
git --version
python3 --version
```

Official setup references:

- [Git for Windows](https://git-scm.com/install/windows)
- [Vite+ installation](https://viteplus.dev/guide/)
- [Vite+ environment management](https://viteplus.dev/guide/env)

## 2. Clone and Bootstrap the Repository

The following commands work in PowerShell, Bash, and Zsh:

```bash
cd ~
git clone --branch dev https://github.com/PauloDaniel1993/t3code.git
cd t3code
vp install --frozen-lockfile
```

Vite+ resolves the repository's Node.js `^24.13.1` requirement and its pinned `pnpm@11.10.0` package manager during installation.

Verify the checkout and managed environment:

```bash
git branch --show-current
vp env current
node --version
pnpm --version
vp env doctor
```

Expected results:

- Current Git branch: `dev`
- Node.js: version `24.13.1` or newer within major version 24
- pnpm: version `11.10.0`
- `vp env doctor`: no blocking environment errors

## 3. Install and Authenticate a Provider

T3 Code needs at least one supported coding-agent CLI.

### Codex on Windows

Install Codex through the Node.js environment managed by Vite+:

```powershell
npm install --global @openai/codex
codex --version
codex
```

### Codex on Linux

Use the official standalone installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
codex
```

On the first `codex` run, select **Sign in with ChatGPT** or another available authentication method. See the [official Codex CLI guide](https://developers.openai.com/codex/cli/).

Alternatively, install and authenticate another supported provider:

- Claude: run `claude auth login` after installing Claude Code.
- Cursor: run `cursor-agent login` after installing Cursor CLI.
- OpenCode: run `opencode auth login` after installing OpenCode.

If GitHub CLI was installed, authenticate it separately:

```bash
gh auth login
gh auth status
```

## 4. Run From Source

Run the desktop application in development mode:

```bash
vp run dev:desktop
```

On a Linux server without a graphical desktop, run the browser version instead:

```bash
vp run dev
```

The browser UI normally opens automatically. If it does not, visit `http://localhost:5733`.

## 5. Install a Persistent Local Desktop Build

### Windows

```powershell
vp run install:desktop --install-dir "$env:LOCALAPPDATA\Programs\T3CodeDev" --launch
```

This creates a **T3 Code (alpha.local)** Start Menu shortcut.

### Linux

```bash
vp run install:desktop --install-dir "$HOME/.local/opt/t3code-dev" --launch
```

The local Linux launcher is installed at:

```text
~/.local/opt/t3code-dev/t3code-local
```

Launch it later with:

```bash
"$HOME/.local/opt/t3code-dev/t3code-local"
```

## 6. Verify the Complete Machine Setup

Run this checklist from the repository directory:

```bash
git status --short --branch
git --version
vp --version
vp env current
node --version
pnpm --version
codex --version
vp check
vp run typecheck
```

Replace `codex --version` with the selected provider's version command if Codex is not installed.

## Updating the Local Installation

Close the local desktop application first.

Update the source on Windows or Linux:

```bash
cd ~/t3code
git switch dev
git pull --ff-only origin dev
vp install --frozen-lockfile
```

Finish the update on Windows:

```powershell
vp run update:desktop --install-dir "$env:LOCALAPPDATA\Programs\T3CodeDev" --launch
```

Finish the update on Linux:

```bash
vp run update:desktop --install-dir "$HOME/.local/opt/t3code-dev" --launch
```

## Testing an Unmerged Feature Branch

Clone the feature branch directly. For example:

```bash
cd ~
git clone --branch feature/pdf-attachment-support https://github.com/PauloDaniel1993/t3code.git t3code-pdf
cd t3code-pdf
vp install --frozen-lockfile
vp run dev:desktop
```

Use a different installation destination so the feature build does not replace the `dev` build.

Windows:

```powershell
vp run install:desktop --install-dir "$env:LOCALAPPDATA\Programs\T3CodePdf" --launch
```

Linux:

```bash
vp run install:desktop --install-dir "$HOME/.local/opt/t3code-pdf" --launch
```

## Troubleshooting

### `vp` Is Not Recognized

Open a new terminal first.

On Windows PowerShell:

```powershell
vp env setup
. "$env:USERPROFILE\.vite-plus\env.ps1"
vp env doctor
```

On Linux, rerun the installer if the shell configuration was not updated:

```bash
curl -fsSL https://vite.plus | bash
exec "$SHELL" -l
vp env doctor
```

### Dependency Installation Fails

```bash
git status --short --branch
vp env doctor
vp install --frozen-lockfile
```

On Windows, install Visual Studio C++ Build Tools and Python as described above if the failure involves native compilation.

On Linux, confirm the compiler and Python are available:

```bash
python3 --version
c++ --version
make --version
```

### Development Ports Are Already in Use

PowerShell:

```powershell
$env:T3CODE_DEV_INSTANCE = "local-dev"
vp run dev:desktop
```

Bash or Zsh:

```bash
T3CODE_DEV_INSTANCE=local-dev vp run dev:desktop
```
