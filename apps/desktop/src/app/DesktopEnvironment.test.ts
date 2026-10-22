import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("gives the local build its own home, profile parent and app identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { platform: "win32", isPackaged: true, isLocalIdentity: true },
        {
          APPDATA: "/official/profiles",
          T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.t3tools.t3code",
        },
      );
      assert.equal(environment.baseDir, "/Users/alice/.t3.v2");
      assert.equal(environment.stateDir, "/Users/alice/.t3.v2/userdata");
      assert.equal(environment.appDataDirectory, "/Users/alice/.t3.v2/appdata");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.v2.local");
      assert.equal(environment.branding.displayName, "T3 v2.local");
      assert.equal(environment.linuxWmClass, "t3code-v2-local");
    }),
  );
  it.effect("ignores an inherited local identity flag in an ordinary development run", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_LOCAL_IDENTITY: "true",
          T3CODE_DESKTOP_DISPLAY_NAME: "T3 alpha.local",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );
      assert.isFalse(environment.isLocalIdentity);
      assert.equal(environment.displayName, "T3 Code (Dev)");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
      assert.equal(environment.stateDir, "/Users/alice/.t3/dev");
    }),
  );
  it.effect(
    "keeps release branding despite an inherited display name, and reads the override only for local builds",
    () =>
      Effect.gen(function* () {
        const release = yield* makeEnvironment(
          { isPackaged: true },
          { T3CODE_DESKTOP_DISPLAY_NAME: "T3 alpha.local" },
        );
        assert.equal(release.displayName, "T3 Code (Beta)");
        const local = yield* makeEnvironment(
          { isPackaged: true, isLocalIdentity: true },
          { T3CODE_DESKTOP_DISPLAY_NAME: " T3 v2.local " },
        );
        assert.equal(local.displayName, "T3 v2.local");
      }),
  );
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});
