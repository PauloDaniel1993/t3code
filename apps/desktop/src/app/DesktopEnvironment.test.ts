import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
  localInstallMetadata: Option.none(),
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: " /tmp/t3 ",
          T3CODE_COMMIT_HASH: " 0123456789abcdef ",
          T3CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          T3CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );
      const path = environment.path;
      const stateDir = path.join("/tmp/t3", "dev");
      const rootDir = path.resolve(defaultInput.dirname, "../../..");

      assert.equal(environment.isDevelopment, true);
      assert.equal(
        environment.appDataDirectory,
        path.join(defaultInput.homeDirectory, "Library", "Application Support"),
      );
      assert.equal(environment.baseDir, "/tmp/t3");
      assert.equal(environment.stateDir, stateDir);
      assert.equal(environment.desktopSettingsPath, path.join(stateDir, "desktop-settings.json"));
      assert.equal(environment.clientSettingsPath, path.join(stateDir, "client-settings.json"));
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        path.join(stateDir, "saved-environments.json"),
      );
      assert.equal(environment.serverSettingsPath, path.join(stateDir, "settings.json"));
      assert.equal(environment.logDir, path.join(stateDir, "logs"));
      assert.equal(environment.browserArtifactsDir, path.join(stateDir, "browser-artifacts"));
      assert.equal(environment.rootDir, rootDir);
      assert.equal(environment.appRoot, rootDir);
      assert.equal(environment.backendEntryPath, path.join(rootDir, "apps/server/dist/bin.mjs"));
      assert.equal(environment.backendCwd, rootDir);
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
      assert.equal(environment.linuxWmClass, "t3code-dev");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteT3ServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("derives production state paths under userdata", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
        },
      );
      const path = environment.path;
      const stateDir = path.join("/tmp/t3", "userdata");

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, stateDir);
      assert.equal(environment.logDir, path.join(stateDir, "logs"));
      assert.equal(environment.browserArtifactsDir, path.join(stateDir, "browser-artifacts"));
      assert.equal(environment.serverSettingsPath, path.join(stateDir, "settings.json"));
    }),
  );

  it.effect("uses configured app identity overrides", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: " com.t3tools.t3code.alpha.local ",
          T3CODE_DESKTOP_DISPLAY_NAME: " T3 Code (alpha.local) ",
        },
      );

      assert.equal(environment.appUserModelId, "com.t3tools.t3code.alpha.local");
      assert.equal(environment.displayName, "T3 Code (alpha.local)");
      assert.equal(environment.branding.displayName, "T3 Code (alpha.local)");
      assert.equal(environment.branding.stageLabel, "Alpha");
    }),
  );

  it.effect("uses local install metadata when launched without launcher environment", () =>
    Effect.gen(function* () {
      const localT3Home = "C:\\Users\\alice\\.t3.local";
      const environment = yield* makeEnvironment({
        platform: "win32",
        homeDirectory: "C:\\Users\\alice",
        localInstallMetadata: Option.some({
          t3Home: Option.some(localT3Home),
          appDataDirectory: Option.none(),
          displayName: Option.some("T3 Code (alpha.local)"),
          windowsAppUserModelId: Option.some("com.t3tools.t3code.alpha.local"),
        }),
      });

      assert.equal(environment.baseDir, localT3Home);
      assert.equal(environment.stateDir, environment.path.join(localT3Home, "userdata"));
      assert.equal(environment.appDataDirectory, environment.path.join(localT3Home, "appdata"));
      assert.equal(environment.displayName, "T3 Code (alpha.local)");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.alpha.local");
    }),
  );

  it.effect("reads local install metadata next to the executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const installDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-local-install-metadata-test-",
      });
      yield* fileSystem.writeFileString(
        path.join(installDir, DesktopEnvironment.LOCAL_INSTALL_METADATA_FILE_NAME),
        `{
          "stateDir": " C:\\\\Users\\\\alice\\\\.t3.local ",
          "displayName": " T3 Code (alpha.local) ",
          "windowsAppUserModelId": " com.t3tools.t3code.alpha.local "
        }\n`,
      );
      const metadata = yield* DesktopEnvironment.readLocalInstallMetadata(
        path.join(installDir, "T3 Code.exe"),
      );

      assert.deepEqual(
        Option.map(metadata, (value) => ({
          t3Home: value.t3Home,
          displayName: value.displayName,
          windowsAppUserModelId: value.windowsAppUserModelId,
        })),
        Option.some({
          t3Home: Option.some("C:\\Users\\alice\\.t3.local"),
          displayName: Option.some("T3 Code (alpha.local)"),
          windowsAppUserModelId: Option.some("com.t3tools.t3code.alpha.local"),
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some(environment.path.join(defaultInput.homeDirectory, "project")),
      );
    }),
  );
});
