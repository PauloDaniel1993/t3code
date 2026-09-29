# First Windows install of T3 v2.local

These are manual steps. Keep stable and alpha.local running; close only an existing
T3 v2.local before replacing it. The installer does not migrate data or stop apps.

1. Open a plain PowerShell window outside T3 Code. Check `$env:APPDATA`,
   `$env:T3CODE_HOME` and `$env:ELECTRON_RUN_AS_NODE`. APPDATA must be the account's
   roaming folder, not either T3 home's `appdata`; the other two variables should
   be empty. If they are inherited from another install, open a fresh external
   window before continuing.

2. Select the **integrate/v2 worktree**, outside the new V2 home, and install its
   dependencies with `vp i`. Before building, explicitly verify that it contains
   **v2/carry-fork-data-into-v2** and **v2/attachment-protections-on-v2**:

   ```powershell
   $integrationCheckout = 'I:\tmp\v2wt\<your-integrate-v2-worktree>'
   git -C $integrationCheckout branch --show-current
   git -C $integrationCheckout merge-base --is-ancestor v2/carry-fork-data-into-v2 HEAD
   if ($LASTEXITCODE -ne 0) { throw 'The build is missing the current data carry-over branch.' }
   git -C $integrationCheckout merge-base --is-ancestor v2/attachment-protections-on-v2 HEAD
   if ($LASTEXITCODE -ne 0) { throw 'The build is missing the current attachment branch.' }
   ```

   Look for `integrate/v2` and two successful ancestry checks. Also require ticket
   28's reviewed proof on VACUUM INTO copies of both databases: on alpha.local's
   copy, all 657 task links, 501 source tags and 442 reasoning messages survive.
   **The installed build must contain the data carry-over before it is ever
   started on copied real data: the first start/import is the only import that
   destination directory gets.** If a branch, review or proof is missing, wait
   for its integration and repeat these checks; do not start an unpatched build
   on the seed. This branding branch alone is insufficient.

3. Verify Windows build prerequisites, including the ported Spectre selector.
   For x64, run this read-only query:

   ```powershell
   $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
   $visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath
   $toolset = Get-ChildItem (Join-Path $visualStudio 'VC\Tools\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
   Test-Path (Join-Path $toolset.FullName 'lib\spectre\x64')
   ```

   Look for a selected instance and `True` (on the verified machine, Community
   qualifies and Enterprise lacks x64 Spectre). If none qualifies, add the C++
   tools and `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre` through
   Visual Studio Installer and repeat. If a later native compile independently
   selects Enterprise, add that Spectre component to Enterprise too; this
   preflight does not control node-gyp's or Rust's instance selection. ARM64 needs
   the ARM64 tools, ARM64 Spectre runtime component and `lib\spectre\arm64`;
   neither inspected instance currently has them.

4. Build and install fresh with **no launch**, using separate install, state and
   artifact directories:

   ```powershell
   $localInstall = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'T3 v2.local'
   $v2Home = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.t3.v2'
   $artifactOutput = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.t3-v2-desktop-artifacts'
   Set-Location -LiteralPath $integrationCheckout
   node scripts/install-desktop-build.ts --install-dir $localInstall --platform win --arch x64 --state-dir $v2Home --output-dir $artifactOutput --no-launch
   if ($LASTEXITCODE -ne 0) { throw 'Installation failed; do not seed or launch.' }
   $metadata = Get-Content -LiteralPath (Join-Path $localInstall '.t3code-install.json') -Raw | ConvertFrom-Json
   $buildCommit = git -C $integrationCheckout rev-parse HEAD
   if ($metadata.commit -ne $buildCommit -or $metadata.t3Home -ne $v2Home -or $metadata.displayName -ne 'T3 v2.local') { throw 'Wrong build or home; rebuild before seeding.' }
   ```

   Look for the expected commit, V2 home and `T3 v2.local` identity in the metadata.
   The installer also validates the packaged local bootstrap. Do not reuse an old
   bundle on the first install. If anything disagrees, rebuild from the verified
   integration checkout with `--no-launch`. Leave other installs and pins alone.

5. **Before the first V2 launch**, seed only a fresh destination from alpha.local's
   live `state.sqlite`, opened read-only, using a consistent VACUUM INTO snapshot:

   ```powershell
   $sourceHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.t3.local'
   $sourceDatabase = Join-Path $sourceHome 'userdata\state.sqlite'
   $v2Userdata = Join-Path $v2Home 'userdata'
   if (Test-Path (Join-Path $v2Userdata 'state*.sqlite*')) { throw 'Preserve this destination and choose a fresh V2 home; do not overwrite it.' }
   New-Item -ItemType Directory -Path $v2Userdata -Force | Out-Null
   $env:T3_V2_COPY_SOURCE = $sourceDatabase
   $env:T3_V2_COPY_DEST = Join-Path $v2Userdata 'state.sqlite'
   node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.T3_V2_COPY_SOURCE, { readOnly: true }); db.prepare("VACUUM INTO ?").run(process.env.T3_V2_COPY_DEST); db.close();'
   if ($LASTEXITCODE -ne 0) { throw 'Snapshot failed; do not launch.' }
   node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.T3_V2_COPY_DEST, { readOnly: true }); console.log(db.prepare("PRAGMA quick_check").get()); db.close();'
   if ($LASTEXITCODE -ne 0) { throw 'Snapshot check failed; do not launch.' }
   Remove-Item Env:T3_V2_COPY_SOURCE, Env:T3_V2_COPY_DEST
   ```

   Look for the new `userdata\state.sqlite`, a quick check of `ok`, and **no
   statev2.sqlite yet**. Never open the source read-write or copy a live database
   with ordinary file-copy commands. If the destination was already started or a
   check fails, preserve it, choose a new unused home with `--state-dir`, repeat
   the no-launch installation, and re-seed there. Never delete an already-used
   V2 database to force an import. Stable's database is for the prerequisite
   proof, not this daily-driver seed.

6. **Copy the attachment files as well, directly into attachments-v2, before
   first launch.** Ticket 36's branch creates and reads this private directory:

   ```powershell
   $attachmentSource = Join-Path $sourceHome 'userdata\attachments'
   $attachmentDestination = Join-Path $v2Home 'userdata\attachments-v2'
   if (!(Test-Path -LiteralPath $attachmentSource -PathType Container)) { throw 'Attachment source missing; do not launch.' }
   New-Item -ItemType Directory -Path $attachmentDestination -Force | Out-Null
   Get-ChildItem -LiteralPath $attachmentSource -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $attachmentDestination -Recurse -Force -ErrorAction Stop }
   Get-ChildItem -LiteralPath $attachmentSource -File -Recurse -Force | ForEach-Object {
     $relative = $_.FullName.Substring($attachmentSource.Length).TrimStart('\')
     $copy = Join-Path $attachmentDestination $relative
     if (!(Test-Path -LiteralPath $copy -PathType Leaf) -or (Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) { throw "Missing or different attachment: $relative; do not launch." }
   }
   ```

   For this account the paths are
   `C:\Users\pdc18\.t3.local\userdata\attachments\*` →
   `C:\Users\pdc18\.t3.v2\userdata\attachments-v2\`.
   Look for matching files/hashes, with `<attachment-id>.<extension>` directly in
   `attachments-v2`, **not** in `attachments-v2\attachments`. If files are missing,
   hashes differ or copying fails, correct the source/destination, repeat the
   copy and verification, and keep V2 unstarted. Copy bytes; never move them or
   link the destination back to the live source. A database-only seed is incomplete.

7. Leave Chromium profiles, safeStorage keys, `secrets`, and `settings.json` out of
   the seed. In particular, do not copy an enabled Tailscale/network-exposure
   `userdata\desktop-settings.json`: V2 must use fresh, local-only desktop settings
   and cannot take over another install's machine-wide route. Look for absent or
   explicitly local-only settings and a fresh V2 profile. If another install's
   credentials/profile/exposure settings were copied, preserve the mistaken seed
   and repeat with a fresh home before launch.

8. Launch only `T3 v2.local.cmd` or its new shortcut. Check About/display name,
   `~/.t3.v2\userdata\statev2.sqlite`, the private profile
   `~/.t3.v2\appdata\t3code-v2-local`, distinct taskbar grouping, imported task
   links/reasoning/source tags, and an imported image/PDF opening from
   `attachments-v2`. Stable and alpha.local must keep their existing homes and
   keep working. If a path, import or attachment is wrong, close only V2, preserve
   its home and logs, and investigate before another seed/start. Test a taskbar
   pin made from the V2 window too. Reauthenticate in its fresh profile.
   `t3code://` remains shared: start the install being signed into last and do not
   start another install until the callback completes. If a callback is stolen,
   restart sign-in in the intended install.

9. For updates, close only V2 manually and repeat step 4 from a verified checkout,
   preserving its existing home; **do not repeat the first-install seed**. Keep
   artifact output outside that home even when using a V2-managed worktree.
   Own metadata takes precedence over inherited `T3CODE_HOME`; move the home by
   reinstalling with an explicit `--state-dir`. If an update names a partial
   `.previous` backup, inspect that exact backup and remove it manually only when
   safe, then retry. A V2 agent shell deliberately has no `T3CODE_HOME`: use
   `t3 pair --base-dir "$v2Home"` (likewise trace/triage) and check the printed home
   before proceeding. If it names `~/.t3` or another install, stop and supply the
   V2 base directory explicitly.
