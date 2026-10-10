import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

import type * as Electron from "electron";

const { focusedWebContents, ownerWindow, showOpenDialog } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
  dialog: { showOpenDialog },
}));

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  pasteAsText,
  pickFolder,
  pickProjectFavicon,
  pickWorkspaceFile,
  probeRemoteEditors,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome(retryingConfig),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeedSome(window),
        }),
      ),
    );
  });
});

describe("pasteAsText", () => {
  it.effect(
    "pastes into the focused guest only after the main renderer acknowledges the menu action",
    () => {
      const paste = vi.fn();
      const mainPaste = vi.fn();
      const window = {
        webContents: { id: 42, paste: mainPaste },
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow;
      focusedWebContents.mockReturnValue({ paste, isDestroyed: () => false });
      ownerWindow.mockReturnValue(window);

      return Effect.gen(function* () {
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        assert.equal(mainPaste.mock.calls.length, 0);

        yield* pasteAsText.handler(undefined, { sender: { id: 99 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue({}); // A focused PiP/other BrowserWindow.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(null); // Detached contents.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(window);
        focusedWebContents.mockReturnValue({ paste, isDestroyed: () => true });
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        focusedWebContents.mockReturnValue(null);
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
      }).pipe(
        Effect.provide(
          Layer.mock(ElectronWindow.ElectronWindow)({
            main: Effect.succeedSome(window),
          }),
        ),
      );
    },
  );
});

describe("pickWorkspaceFile", () => {
  const owner = { id: 19 } as Electron.BrowserWindow;
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "C:\\repo\\apps\\desktop\\dist-electron",
    homeDirectory: "C:\\Users\\alice",
    platform: "win32",
    processArch: "x64",
    appVersion: "0.0.45",
    appPath: "C:\\repo",
    isPackaged: false,
    resourcesPath: "C:\\repo\\resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerWin32, DesktopConfig.layerTest({})),
    ),
  );
  const pickerLayer = (
    settings = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    wsl: DesktopWslEnvironment.DesktopWslEnvironmentTestStub = {},
  ) =>
    Layer.mergeAll(
      ElectronDialog.layer,
      Layer.mock(ElectronWindow.ElectronWindow)({ focusedMainOrFirst: Effect.succeedSome(owner) }),
      environmentLayer,
      DesktopAppSettings.layerTest(settings),
      DesktopWslEnvironment.layerTest(wsl),
    );

  beforeEach(() => {
    showOpenDialog.mockReset();
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["C:\\workspaces\\app.code-workspace"],
    });
  });

  it.effect("opens a single workspace-file dialog at the expanded host path", () =>
    Effect.gen(function* () {
      const result = yield* pickWorkspaceFile.handler({
        initialPath: " ~/workspaces ",
        targetEnvironmentId: PRIMARY_LOCAL_ENVIRONMENT_ID,
      });
      assert.strictEqual(result, "C:\\workspaces\\app.code-workspace");
      assert.deepEqual(showOpenDialog.mock.calls, [
        [
          owner,
          {
            defaultPath: "C:\\Users\\alice\\workspaces",
            properties: ["openFile"],
            filters: [{ name: "VS Code workspace files", extensions: ["code-workspace"] }],
          },
        ],
      ]);
    }).pipe(Effect.provide(pickerLayer())),
  );

  it.effect("defaults to the host filesystem with no picker options", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* pickWorkspaceFile.handler(undefined),
        "C:\\workspaces\\app.code-workspace",
      );
      assert.notProperty(showOpenDialog.mock.calls[0]![1], "defaultPath");
    }).pipe(
      Effect.provide(
        pickerLayer({ ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, wslDistro: "Ubuntu" }),
      ),
    ),
  );

  it.effect("returns null on cancellation even if the native result has a path", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({ canceled: true, filePaths: ["/ignored.code-workspace"] });
      assert.strictEqual(yield* pickWorkspaceFile.handler(undefined), null);
    }).pipe(Effect.provide(pickerLayer())),
  );

  it.effect("returns null when the native result has no selection", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      assert.strictEqual(yield* pickWorkspaceFile.handler(undefined), null);
    }).pipe(Effect.provide(pickerLayer())),
  );

  it.effect("does not open a dialog when local environments are disabled", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* pickWorkspaceFile.handler(undefined), null);
      assert.strictEqual(showOpenDialog.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        pickerLayer({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: false,
        }),
      ),
    ),
  );

  it.effect("does not offer a host file path to a remote environment", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* pickWorkspaceFile.handler({ targetEnvironmentId: "remote:server" }),
        null,
      );
      assert.strictEqual(showOpenDialog.mock.calls.length, 0);
    }).pipe(Effect.provide(pickerLayer())),
  );

  it.effect("uses the target WSL distro and returns its UNC selection as a Linux path", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ["\\\\wsl.localhost\\Debian\\home\\alice\\app.code-workspace"],
      });
      const result = yield* pickWorkspaceFile.handler({
        initialPath: "~/workspaces",
        targetEnvironmentId: "wsl:Debian",
      });
      assert.strictEqual(result, "/home/alice/app.code-workspace");
      assert.strictEqual(
        showOpenDialog.mock.calls[0]![1].defaultPath,
        "\\\\wsl.localhost\\Debian\\home\\alice\\workspaces",
      );
    }).pipe(
      Effect.provide(
        pickerLayer(
          { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, wslDistro: "Ubuntu" },
          { getUserHome: () => Option.some("/home/alice") },
        ),
      ),
    ),
  );

  it.effect("uses the persisted distro for wsl:default and accepts legacy UNC selections", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ["\\\\wsl$\\Debian\\workspaces\\app.code-workspace"],
      });
      assert.strictEqual(
        yield* pickWorkspaceFile.handler({
          initialPath: "/workspaces",
          targetEnvironmentId: "wsl:default",
        }),
        "/workspaces/app.code-workspace",
      );
      assert.strictEqual(
        showOpenDialog.mock.calls[0]![1].defaultPath,
        "\\\\wsl.localhost\\Debian\\workspaces",
      );
    }).pipe(
      Effect.provide(
        pickerLayer({ ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, wslDistro: "Debian" }),
      ),
    ),
  );

  it.effect("uses the default installed WSL distro when none is persisted", () =>
    Effect.gen(function* () {
      yield* pickWorkspaceFile.handler({ initialPath: "~", targetEnvironmentId: "wsl:default" });
      assert.strictEqual(
        showOpenDialog.mock.calls[0]![1].defaultPath,
        "\\\\wsl.localhost\\Ubuntu\\home\\alice",
      );
    }).pipe(
      Effect.provide(
        pickerLayer(
          { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, wslDistro: null },
          {
            distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
            getUserHome: () => Option.some("/home/alice"),
          },
        ),
      ),
    ),
  );

  it.effect("converts a Windows selection through the selected WSL distro", () =>
    Effect.gen(function* () {
      const windowsToWslPath = vi.fn(() => Option.some("/mnt/c/workspaces/app.code-workspace"));
      const result = yield* pickWorkspaceFile
        .handler({ targetEnvironmentId: "wsl:Debian" })
        .pipe(Effect.provide(pickerLayer(undefined, { windowsToWslPath })));
      assert.strictEqual(result, "/mnt/c/workspaces/app.code-workspace");
      assert.deepEqual(windowsToWslPath.mock.calls, [
        ["Debian", "C:\\workspaces\\app.code-workspace"],
      ]);
    }),
  );

  it.effect("keeps the folder picker's host fallback for non-local target ids", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\workspaces\\project"] });
      assert.strictEqual(
        yield* pickFolder.handler({ targetEnvironmentId: "remote:server" }),
        "C:\\workspaces\\project",
      );
      assert.deepEqual(showOpenDialog.mock.calls, [
        [owner, { properties: ["openDirectory", "createDirectory"] }],
      ]);
    }).pipe(Effect.provide(pickerLayer())),
  );

  it.effect("keeps folder selection and its WSL mapping unchanged", () =>
    Effect.gen(function* () {
      showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ["\\\\wsl.localhost\\Debian\\home\\alice\\project"],
      });
      assert.strictEqual(
        yield* pickFolder.handler({
          initialPath: "/home/alice",
          targetEnvironmentId: "wsl:Debian",
        }),
        "/home/alice/project",
      );
      assert.deepEqual(showOpenDialog.mock.calls[0]![1], {
        defaultPath: "\\\\wsl.localhost\\Debian\\home\\alice",
        properties: ["openDirectory", "createDirectory"],
      });
    }).pipe(Effect.provide(pickerLayer())),
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
    }),
  );

  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});

it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcessEnvironment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.notInclude(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
