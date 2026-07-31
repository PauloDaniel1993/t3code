## Why

Native Windows installs of Kimi Code CLI are the only Kimi install source without a one-click
update in T3 Code. `kimi upgrade` refuses to self-update there and reports success anyway:

```
$ kimi upgrade
exit=0
A newer version of @moonshot-ai/kimi-code is available (0.29.0 -> 0.29.1).
Detected install source: native (windows). Auto-update is not supported on this platform.
To update manually, run: irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

Exit 0 with an unchanged version is indistinguishable from a genuine no-op, so the update action
ran, verified, recorded `unchanged`, and returned the user to "Update now" with no visible
explanation. The Kimi ACP correctness work stopped offering the dead action and now shows the
vendor's install script as a copyable command instead. That is honest but incomplete: Windows users
still update by hand.

Wiring the vendor script would mean piping a remote script into PowerShell as a supervised action.
T3 Code does not do that for any provider, and the decision was deliberately left open rather than
made silently.

A second, provider-agnostic gap contributed to the original confusion. The `unchanged` update
outcome is only rendered by `ProviderUpdateLaunchNotification`; nothing on the provider card
consumes `updateState`. An update that completes without changing anything therefore looks, from
Settings, like a button that did nothing.

## What Changes

- Decide, explicitly, how a native Windows Kimi install updates from T3 Code. The candidates are
  running the vendor install script under supervision, steering the user to a WinGet-managed
  install, or keeping it manual and improving the explanation. The decision belongs in `design.md`
  before any implementation.
- Implement the chosen path, or record the decision to stay manual and close out the remaining
  work below.
- Independently of that choice, surface a completed update's outcome on the provider card, so an
  update that ran but changed nothing explains itself instead of silently reverting to "Update now".
- Surface the update command's captured output where the outcome was `unchanged` or `failed`, since
  in this case the agent's own output stated exactly what happened.

## Capabilities

### New Capabilities

- `provider-update-outcomes`: How a completed provider update reports its outcome to the user.

### Modified Capabilities

- `kimi-subscription-provider`: Extends provider maintenance with a resolved update path for native
  Windows installs.

## Impact

- `apps/server/src/provider/Drivers/KimiDriver.ts`: whichever update path is chosen, replacing the
  current manual-only result for native Windows.
- `apps/server/src/provider/providerMaintenance.ts`: only if the chosen path needs a new capability
  shape beyond the existing `update` and `manualCommand`.
- `apps/web/src/components/settings/ProviderInstanceCard.tsx`: render the completed outcome and its
  output; this part applies to every provider, not only Kimi.
- `docs/providers/kimi.md`: document the resolved Windows update path.
- If the chosen path executes a remote script, it establishes a precedent for T3 Code running
  vendor-hosted code, which is the reason this needs an explicit decision rather than an
  implementation detail.
