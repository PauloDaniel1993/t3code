# Local Desktop Handoff

Generated on 2026-06-20 for continuing this workspace in another thread.

## Current State

- Repository: `I:\projects\Personal\t3code`
- Branch: `feature/opsx-openspec-workflows-rebased`
- HEAD: `67238808289d`
- Local app install: `%LOCALAPPDATA%\T3 Code Local`
- Local app executable: `%LOCALAPPDATA%\T3 Code Local\T3 Code (alpha.local).exe`
- Local state/context: `%USERPROFILE%\.t3.local`
- Local app data: `%USERPROFILE%\.t3.local\appdata`
- Local Windows AppUserModelID: `com.t3tools.t3code.alpha.local`
- Official install found at: `%LOCALAPPDATA%\Programs\t3code`

## What Was Done

1. Rebased work onto `main` and continued on `feature/opsx-openspec-workflows-rebased`.
2. Built local desktop install/update support:
   - `pnpm update:desktop` now installs an unpacked desktop build into a chosen directory.
   - Local install metadata is written beside the executable as `.t3code-install.json`.
   - The local install preserves context across app runs through `%USERPROFILE%\.t3.local`.
   - The local install creates launchers/shortcuts for `T3 Code (alpha.local)`.
3. Separated local and official desktop identities:
   - Product/display name: `T3 Code (alpha.local)`.
   - Package/app id: `com.t3tools.t3code.alpha.local`.
   - Windows taskbar grouping is separate from official `T3 Code (Alpha)`.
   - Local state directory does not reuse the official `T3CODE_HOME` variable.
4. Fixed local launch/install issues:
   - The installed app now launches from the built packaged entry instead of the repo `dist-electron` path.
   - Server/client static responses include no-cache headers to avoid stale local renderer assets.
   - The app was rebuilt and installed after closing locked local app processes.
5. Added platform-aware reveal-in-file-manager behavior:
   - Project context menu now shows platform-specific labels:
     - Windows: `Show in Explorer`
     - macOS: `Reveal in Finder`
     - Linux: `Show in Files`
   - Desktop IPC bridge exposes `shell.revealPath`.
6. Added category context menus:
   - Categories now have the same management menu behavior as projects, excluding copy path and open/reveal actions.
   - Includes rename, create/new category, hide, and remove behavior using existing sidebar organization logic.
7. Added category activity/status dots:
   - Category rows aggregate visible project/thread status.
   - If anything inside a category is working, the category shows the same small blue working dot behavior.
8. Restored T3 Connect support for local builds:
   - The missing T3 Connect UI was caused by absent Vite-time cloud public config.
   - The official installed app bundle was inspected for public frontend values.
   - The values were written to ignored `.env.local`, not committed.
   - `scripts/build-desktop-artifact.ts` now loads `.env` / `.env.local` for packaged desktop builds, matching dev behavior.
   - The build script warns when T3 Connect public config is missing and the packaged app would hide T3 Connect UI.

## Important Local Files

- `.env.local`
  - Ignored by git.
  - Contains public T3 Connect frontend values extracted from the official installed app:
    - `T3CODE_CLERK_PUBLISHABLE_KEY`
    - `T3CODE_CLERK_JWT_TEMPLATE`
    - `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`
    - `T3CODE_RELAY_URL`
  - Do not add server-side secrets here.
- `%LOCALAPPDATA%\T3 Code Local\.t3code-install.json`
  - Confirms branch, source artifact, local state directory, display name, and AppUserModelID.

## How To Rebuild And Launch

Run this after future rebases or code changes:

```powershell
pnpm update:desktop -- --install-dir "$env:LOCALAPPDATA\T3 Code Local" --launch
```

If the install fails with `EBUSY`, the current local app is still running. Close `T3 Code (alpha.local)` or stop only processes whose path starts with:

```text
%LOCALAPPDATA%\T3 Code Local
```

Then reuse the already-built artifact:

```powershell
pnpm update:desktop -- --install-dir "$env:LOCALAPPDATA\T3 Code Local" --reuse-artifact --launch
```

## Verification Already Run

- `pnpm --filter @t3tools/scripts test -- build-desktop-artifact.test.ts lib/public-config.test.ts`
  - Passed: 2 files, 26 tests.
- `vp check`
  - Passed with existing unrelated lint warnings.
- `vp run typecheck`
  - Passed.
- Installed local bundle check:
  - `VITE_CLERK_PUBLISHABLE_KEY`: present
  - `VITE_CLERK_JWT_TEMPLATE`: present
  - `VITE_T3CODE_RELAY_URL`: present

## Current Dirty Files

The worktree has intentional modifications across desktop, server, web, contracts, and scripts. Do not blindly revert these files.

Main areas:

- Desktop identity, state, launch, Clerk, window, and IPC:
  - `apps/desktop/src/app/*`
  - `apps/desktop/src/electron/*`
  - `apps/desktop/src/ipc/*`
  - `apps/desktop/src/window/*`
  - `apps/desktop/src/main.ts`
  - `apps/desktop/src/preload.ts`
- Server cache/static response behavior:
  - `apps/server/src/http.ts`
  - `apps/server/src/server.test.ts`
- Web sidebar menus/status:
  - `apps/web/src/components/Sidebar.tsx`
  - `apps/web/src/localApi.ts`
  - `apps/web/src/sidebarOrganization/projectWorkflow.ts`
- IPC contract:
  - `packages/contracts/src/ipc.ts`
- Build/install scripts:
  - `scripts/build-desktop-artifact.ts`
  - `scripts/install-desktop-build.ts`

## Known Notes

- `vp check` reports existing warnings in unrelated mobile/web files, but exits successfully.
- T3 Connect config is public frontend config, not a server secret. It is still kept in ignored `.env.local` to avoid baking official service configuration into tracked source.
- T3 Connect may still depend on official service-side origin/protocol allowlists. The local renderer now has the same public config as the official build, but service-side restrictions can still reject a local fork.
- The local app is currently installed and launched as `T3 Code (alpha.local)`.
