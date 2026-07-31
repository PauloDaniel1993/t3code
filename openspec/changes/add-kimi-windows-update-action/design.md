## Context

`resolvePackageManagedProviderMaintenance` classifies a provider by the path its command resolves
to, and `KIMI_MAINTENANCE_RESOLVER` narrows that further. After the Kimi ACP correctness work the
Kimi matrix is:

| Install                                   | Action                                                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| npm / pnpm / bun / vite-plus global       | that package manager                                                 |
| native macOS / Linux (`~/.kimi-code/bin`) | `kimi upgrade`                                                       |
| native Windows                            | none; shows `irm https://code.kimi.com/kimi-code/install.ps1 \| iex` |
| WinGet (`MoonshotAI.KimiCodeCLI`)         | `winget upgrade`                                                     |
| anything else                             | manual, no command                                                   |

`providerMaintenanceRunner` runs an update with piped stdio, no stdin, a kill finalizer, and a
five-minute timeout, then re-probes the version. Non-zero exit is `failed`; exit zero with the
version still behind is `unchanged`.

Two observations from investigating this on a real machine:

- WinGet does package `MoonshotAI.KimiCodeCLI`, and `winget upgrade --id ... --silent
--accept-package-agreements --accept-source-agreements --disable-interactivity` is fully
  non-interactive. It exits `43` when there is nothing to upgrade, which the runner would classify
  as `failed`. Since the action is only offered when T3 Code already sees a newer version, that
  should be rare, but it is a real edge.
- A machine can carry both a native and a WinGet install simultaneously, with PATH order deciding
  which one T3 Code actually uses. Any "update" that writes to the copy that is not on PATH is a
  no-op that looks like success.

## Goals / Non-Goals

**Goals:**

- Resolve the native-Windows gap deliberately rather than by default.
- Never present an action that cannot change the thing it claims to update.
- Make a completed-but-ineffective update explain itself.

**Non-Goals:**

- Changing the update path for any other provider or platform.
- Managing multiple competing installs on one machine. Detecting the ambiguity is in scope;
  resolving it for the user is not.

## Decisions

### The decision itself is deferred, and that is the point of this change

Three candidates, to be chosen before implementation:

**A — Run the vendor install script under supervision.** Offer
`powershell -NoProfile -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"` as the
update action, showing the command and requiring explicit confirmation.
_For:_ it is the vendor's documented path and updates the exact install in use.
_Against:_ T3 Code would execute remote code fetched at run time, with no pinning and no integrity
check. Nothing else in T3 Code does this. It sets a precedent that would be hard to argue against
for the next provider.

**B — Steer toward a WinGet-managed install.** When a native Windows install is detected and WinGet
packages the CLI, offer to install the WinGet package and then rely on the existing `winget upgrade`
path.
_For:_ no remote script execution; ends in a package manager T3 Code already supports.
_Against:_ it changes the user's install source rather than updating it, and can leave two copies
on disk with PATH order deciding the winner — exactly the failure this change is trying to avoid.
It is arguably not an "update" at all.

**C — Stay manual, and explain properly.** Keep the copyable install script, and invest instead in
the outcome surfacing below plus clearer card guidance.
_For:_ honest, zero new execution surface, smallest change.
_Against:_ leaves one platform permanently second-class.

### Outcome surfacing is not deferred

Regardless of which candidate wins, a completed update must report its outcome on the provider card.
Today only `ProviderUpdateLaunchNotification` reads `updateState`; `ProviderInstanceCard` does not.
That is why the original report was "it thinks a little bit and goes back to Update now" — the
runner had recorded a precise message that the card never showed. This part is provider-agnostic and
should proceed even if the answer to the Windows question is C.

### Competing installs are detected, not resolved

If both a native and a package-managed install are present, T3 Code should say which one it is using
and that another exists. It should not delete, reorder, or rewrite PATH.

## Risks / Trade-offs

- Candidate A's risk is precedent, not mechanics. The mechanics are easy; the policy is the hard
  part, and it should be decided by a human with an explicit rationale recorded here.
- Candidate B's risk is silently creating the dual-install situation this change wants to warn about.
- The `winget upgrade` exit code 43 means "nothing to upgrade". If WinGet's source lags the npm
  registry that drives the version advisory, a user could see an offered update fail with a
  confusing code. Mapping known no-op exit codes to `unchanged` rather than `failed` would be a
  small, contained improvement.

## Open Questions

- Which candidate? This needs a human decision with the rationale recorded before any code lands.
- Should `providerMaintenanceRunner` map a known "nothing to do" exit code to `unchanged` rather
  than `failed`, so an up-to-date WinGet package does not look like an error?
- Should the card show the raw captured update output, or a summarized form? The raw output was the
  clearest possible explanation in this case, but it is unbounded vendor text.
