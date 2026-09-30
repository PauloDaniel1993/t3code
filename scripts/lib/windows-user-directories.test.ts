// @effect-diagnostics nodeBuiltinImport:off - Read-only Windows known-folder regression check.
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import {
  readWindowsUserDirectories,
  restoreWindowsUserDirectories,
} from "./windows-user-directories.ts";

it.effect("gets real Windows folders inside an alpha.local shell", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") return;
    const original = readWindowsUserDirectories();
    const alphaHome = NodePath.win32.join(original.home, ".t3.local");
    const inherited = {
      ...process.env,
      APPDATA: NodePath.win32.join(alphaHome, "appdata"),
      LOCALAPPDATA: NodePath.win32.join(alphaHome, "localappdata"),
      USERPROFILE: alphaHome,
      HOME: alphaHome,
      TEMP: NodePath.win32.join(alphaHome, "temp"),
      TMP: NodePath.win32.join(alphaHome, "temp"),
      T3CODE_HOME: alphaHome,
    };
    assert.deepEqual(readWindowsUserDirectories(inherited), original);
    const restored = restoreWindowsUserDirectories(inherited);
    assert.equal(restored.APPDATA, original.appData);
    assert.equal(restored.LOCALAPPDATA, original.localAppData);
    assert.equal(restored.USERPROFILE, original.home);
    assert.equal(restored.HOME, original.home);
    assert.equal(restored.TEMP, NodePath.win32.join(original.localAppData, "Temp"));
  }),
);
