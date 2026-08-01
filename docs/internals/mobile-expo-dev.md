# Running the mobile app against Metro

How to get `apps/mobile` running on a real device or emulator, and the traps that
waste a session. Most of these fail in a way that **looks like success**, which is
why they are worth reading before you start rather than after.

## The short version

From `apps/mobile`, with a device attached over USB:

```bash
adb reverse tcp:8082 tcp:8082
APP_VARIANT=development REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 \
  ./node_modules/.bin/expo start --dev-client --scheme t3code-dev --port 8082
```

Then press `a`, or connect explicitly:

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "t3code-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8082"
```

Every part of that command is load-bearing. The rest of this file explains why.

## There is no web target

`react-native-web` is not installed, the Expo config declares only `ios` and
`android` (`apps/mobile/app.config.ts`), and metro is configured for native
resolution only. **Expo web will not render this app.** Adding a web target is not
a config flag — it needs the dependency, a web entry, and every native-only import
made web-safe.

Practical consequence: there is no browser shortcut for verifying mobile UI. It is
a device or an emulator, or it is not verified. Rendering the HTML mockups in
`experiments/` is **not** evidence about the React Native implementation.

Expo Go does not work either — the app uses native modules
(`apps/mobile/README.md`). You need a dev client build or a standalone APK.

## Use the worktree-local binaries

`which vp` may resolve to a **different worktree's** `node_modules/.bin/vp`. When it
does, every test fails with a misleading error:

```
TypeError: Cannot read properties of undefined (reading 'config')
```

That is not your code. Always run the local binary:

```bash
cd apps/mobile
../../node_modules/.bin/vp test run <path>   # tests
./node_modules/.bin/tsc --noEmit             # typecheck (the script is literally tsc --noEmit)
```

The same applies to `expo` — use `./node_modules/.bin/expo`, not a global one.

## Port 8081 may not be free, and Metro will not tell you

Check before you start:

```powershell
Get-NetTCPConnection -LocalPort 8081 -State Listen |
  ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }
```

On a machine running WSL2, port 8081 is frequently held by `wslrelay` forwarding a
service inside the Linux VM. The failure mode is nasty:

- Metro fails to bind with `EADDRINUSE`, but
- a naive readiness probe (`curl http://127.0.0.1:8081/status`) **succeeds**, because
  something else is answering.

If you then point a device at 8081 it loads _that_ service, or an unrelated bundle,
and you can spend a long time "verifying" code that was never loaded. Pick a free
port and pass `--port`.

**Probe the manifest, not the port.** A liveness check that only proves "something
is listening" is worthless here:

```bash
curl -s -o /dev/null -w '%{http_code}' -H "expo-platform: android" http://127.0.0.1:8082/
```

## Do not pass `--localhost` when driving a device over `adb reverse`

`--localhost` makes Expo bind `localhost`, which on many Windows machines resolves
to IPv6 `::1`. `adb reverse` tunnels over IPv4 `127.0.0.1`. The result is a Metro
that is genuinely running, prints `Waiting on http://localhost:8082`, and is
unreachable from the phone.

Check the bind address if connections fail:

```powershell
Get-NetTCPConnection -LocalPort 8082 -State Listen | Select LocalAddress
# ::1  -> IPv6 only, adb reverse cannot reach it
# ::   -> dual stack, fine
```

Set `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1` and omit `--localhost`.

## Metro dies when backgrounded without a TTY

Expo's CLI writes to an interactive terminal UI. Started as a background process
whose stdout pipe closes, it throws:

```
Error [ERR_STREAM_UNABLE_TO_PIPE]: Cannot pipe to a closed or destroyed stream
```

and eventually the server dies — **while the port stays held by the hung process**,
so it still looks alive. `CI=1` alone does not reliably prevent this.

Either run it in a real foreground terminal, or launch it fully detached with file
redirection so there is no pipe to break:

```powershell
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c",".\node_modules\.bin\expo.CMD start --dev-client --port 8082 > metro.log 2>&1" `
  -WorkingDirectory "<repo>\apps\mobile" -WindowStyle Hidden
```

If the app stops picking up your edits, suspect this before suspecting fast refresh.

## USB beats LAN

`adb reverse` maps a host port onto the device's loopback, so the phone reaches
Metro over the cable regardless of Wi-Fi, VPNs, or firewalls:

```bash
adb reverse tcp:8082 tcp:8082    # Metro
adb reverse tcp:3773 tcp:3773    # backend, if the app talks to a local server
```

This matters because the app may be paired to a backend by **LAN address**. A phone
on mobile data or a VPN can ping the host yet fail to reach a port, and the app
surfaces that as a 6-second `RemoteEnvironmentAuthTimeoutError` on
`/api/orchestration/shell`, falling back to a socket snapshot.

## Device authorization

`adb devices` showing `unauthorized` means the phone has not accepted this
computer's key. If no dialog appears:

- the screen must be **unlocked** — the prompt does not queue;
- Samsung suppresses it when USB mode is **Charging only** — switch to File
  Transfer / MTP;
- a previously denied key is remembered — Developer options → **Revoke USB
  debugging authorizations**;
- as a last resort, regenerate the host key (rename `~/.android/adbkey{,.pub}` and
  restart the daemon). This de-authorizes every other device you have paired.

## Driving the UI from a shell

Screenshots and the accessibility tree are the two reliable instruments:

```bash
adb exec-out screencap -p > shot.png
MSYS_NO_PATHCONV=1 adb shell uiautomator dump /sdcard/ui.xml
MSYS_NO_PATHCONV=1 adb pull /sdcard/ui.xml ui.xml
```

`MSYS_NO_PATHCONV=1` is required in Git Bash, or `/sdcard/ui.xml` is rewritten to
`C:/Program Files/Git/sdcard/ui.xml` and the pull fails with a confusing error.

The hierarchy dump gives exact `bounds` and `content-desc`, so you can tap by
inspected coordinates rather than guessing:

```bash
adb shell input tap <cx> <cy>
```

**The list is live.** Threads reorder while you work, so a tap based on a screenshot
taken seconds earlier can land on a different row — and look exactly like a routing
bug. Dump and tap in the same step when identity matters.

Note `curl` under MSYS can report failures for services that are actually up. When a
result is surprising, cross-check with PowerShell `Invoke-WebRequest` before
concluding anything.

## Feature flags hide things

Some surfaces are behind device-local beta preferences in Settings → Beta (for
example **Thread List v2** and **Thread Tasks**), and they default to **off**. An
invisible feature is far more often a flag than a bug. Check the toggles before
debugging the code.

Web-side flags are not shared: `threadTasksEnabled` on web lives in browser
`localStorage` under `t3code:client-settings:v1`, which does not exist in React
Native. Mobile has its own preference store.

## Related

- `docs/internals/mobile-android-build.md` — building a standalone APK
- `apps/mobile/README.md` — why Expo Go is unsupported
