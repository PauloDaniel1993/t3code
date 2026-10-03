import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - Local-home alias fixtures do not access installed homes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  applyInstalledDesktopBootstrap,
  type ApplyInstalledDesktopBootstrapInput,
} from "./DesktopInstallBootstrap.ts";

const localMetadata = {
  t3Home: "C:\\Users\\alice\\.t3.v2",
  displayName: "T3 v2.local",
  windowsAppUserModelId: "com.t3tools.t3code.v2.local",
};
const defaults = {
  platform: "win32",
  isPackaged: true,
  appPath: "C:\\Apps\\T3 v2.local\\resources\\app.asar",
  executablePath: "C:\\Apps\\T3 v2.local\\T3 v2.local.exe",
  homeDirectory: "C:\\Users\\alice",
} satisfies Omit<ApplyInstalledDesktopBootstrapInput, "env">;

const read = (path: string) =>
  path.endsWith("package.json")
    ? JSON.stringify({ name: "t3code-v2-local" })
    : JSON.stringify(localMetadata);

describe("installed local identity", () => {
  it("refuses metadata homes reached through UNC shares or junctions into a live-home fixture", async () => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous bootstrap fixture requiring Windows SMB shares.
    if (NodeOS.platform() !== "win32") return;
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bootstrap-alias-"));
    try {
      const homeDirectory = NodePath.join(root, "user");
      const liveHome = NodePath.join(homeDirectory, ".t3.local");
      await NodeFSP.mkdir(liveHome, { recursive: true });
      const drive = NodePath.parse(root).root;
      const unc = `\\\\localhost\\${drive[0]}$\\${liveHome.slice(drive.length)}`;
      const junction = NodePath.join(root, "junction");
      await NodeFSP.symlink(liveHome, junction, "junction");
      for (const t3Home of [
        unc,
        `${unc}\\userdata`,
        NodePath.join(junction, "missing"),
        `${liveHome}.`,
        `${liveHome} `,
        `${liveHome}.\\userdata`,
        NodePath.join(homeDirectory, ".t3."),
        NodePath.join(homeDirectory, "T3LOCA~1"),
        `\\\\?\\${liveHome}`,
        `\\\\.\\${liveHome}`,
        `${liveHome}:stream`,
        `${liveHome}::$DATA`,
        liveHome.replaceAll("\\", "/"),
      ]) {
        const env: NodeJS.ProcessEnv = {};
        assert.throws(
          () =>
            applyInstalledDesktopBootstrap({
              ...defaults,
              homeDirectory,
              env,
              readFileString: (path) =>
                path.endsWith("package.json")
                  ? read(path)
                  : JSON.stringify({ ...localMetadata, t3Home }),
            }),
          /overlaps|Refusing|trailing/,
        );
        assert.deepEqual(env, {});
      }
    } finally {
      await NodeFSP.rmdir(NodePath.join(root, "junction"));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("isolates a taskbar launch even when it inherits the alpha.local environment", () => {
    const env: NodeJS.ProcessEnv = {
      T3CODE_HOME: "C:\\Users\\alice\\.t3.local",
      APPDATA: "C:\\Users\\alice\\.t3.local\\appdata",
      T3CODE_DESKTOP_LOCAL_IDENTITY: "true",
      T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.t3tools.t3code.alpha.local",
      T3CODE_DISABLE_AUTO_UPDATE: "false",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    };
    assert.isTrue(applyInstalledDesktopBootstrap({ ...defaults, env, readFileString: read }));
    assert.equal(env.T3CODE_HOME, localMetadata.t3Home);
    assert.equal(env.APPDATA, `${localMetadata.t3Home}\\appdata`);
    assert.equal(env.T3CODE_DESKTOP_DISPLAY_NAME, "T3 v2.local");
    assert.equal(env.T3CODE_DESKTOP_APP_USER_MODEL_ID, localMetadata.windowsAppUserModelId);
    assert.isUndefined(env.T3CODE_DESKTOP_LOCAL_IDENTITY);
    assert.isUndefined(env.T3CODE_LOCAL_BOOTSTRAP_VERSION);
    assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "true");
    assert.isUndefined(env.VITE_DEV_SERVER_URL);
  });

  it("keeps its custom metadata home ahead of an explicit home from another install", () => {
    const env: NodeJS.ProcessEnv = {
      T3CODE_HOME: "C:\\Users\\alice\\.t3.local",
      APPDATA: "C:\\Users\\alice\\.t3.local\\appdata",
    };
    applyInstalledDesktopBootstrap({
      ...defaults,
      env,
      readFileString: (path) =>
        path.endsWith("package.json")
          ? read(path)
          : JSON.stringify({ ...localMetadata, t3Home: "D:\\V2 state" }),
    });
    assert.equal(env.T3CODE_HOME, "D:\\V2 state");
    assert.equal(env.APPDATA, "D:\\V2 state\\appdata");
  });

  it("uses the isolated default for an unpacked local artifact without installer metadata", () => {
    const env: NodeJS.ProcessEnv = {};
    applyInstalledDesktopBootstrap({
      ...defaults,
      env,
      readFileString: (path) => {
        if (path.endsWith("package.json")) return read(path);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    assert.equal(env.T3CODE_HOME, localMetadata.t3Home);
  });

  it.each([
    "relative",
    "C:\\Users\\alice\\.t3",
    "C:\\Users\\alice\\.t3.local\\userdata",
    "C:\\Users\\alice",
  ])("rejects a home that cannot be isolated: %s", (t3Home) => {
    const env: NodeJS.ProcessEnv = {};
    assert.throws(() =>
      applyInstalledDesktopBootstrap({
        ...defaults,
        env,
        readFileString: (path) =>
          path.endsWith("package.json") ? read(path) : JSON.stringify({ ...localMetadata, t3Home }),
      }),
    );
    assert.deepEqual(env, {});
  });

  it("rejects malformed or alpha.local metadata without falling back to an official profile", () => {
    for (const raw of [
      "broken json",
      JSON.stringify({ ...localMetadata, displayName: "T3 alpha.local" }),
    ]) {
      const env: NodeJS.ProcessEnv = {};
      assert.throws(() =>
        applyInstalledDesktopBootstrap({
          ...defaults,
          env,
          readFileString: (path) => (path.endsWith("package.json") ? read(path) : raw),
        }),
      );
      assert.deepEqual(env, {});
    }
  });

  it("leaves official packaged apps and development runs alone", () => {
    const env: NodeJS.ProcessEnv = { T3CODE_HOME: "C:\\Users\\alice\\.t3" };
    assert.isFalse(
      applyInstalledDesktopBootstrap({
        ...defaults,
        get homeDirectory(): string {
          throw new Error("Ordinary builds must not query the OS account home");
        },
        env,
        readFileString: () => JSON.stringify({ name: "t3code" }),
      }),
    );
    assert.isFalse(
      applyInstalledDesktopBootstrap({
        ...defaults,
        get homeDirectory(): string {
          throw new Error("Dev runs must not query the OS account home");
        },
        isPackaged: false,
        env,
        readFileString: () => {
          throw new Error("must not read");
        },
      }),
    );
    assert.deepEqual(env, { T3CODE_HOME: "C:\\Users\\alice\\.t3" });
  });

  it("also isolates local packaged apps on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/home/alice/.t3" };
      applyInstalledDesktopBootstrap({
        ...defaults,
        platform,
        homeDirectory: "/home/alice",
        appPath:
          platform === "darwin"
            ? "/opt/t3.app/Contents/Resources/app.asar"
            : "/opt/t3/resources/app.asar",
        executablePath:
          platform === "darwin"
            ? "/opt/t3.app/Contents/MacOS/T3 v2.local"
            : "/opt/t3/t3code-v2-local",
        env,
        readFileString: (path) => {
          if (path.endsWith("package.json")) return read(path);
          assert.equal(
            path,
            platform === "darwin"
              ? "/opt/t3.app/.t3code-install.json"
              : "/opt/t3/.t3code-install.json",
          );
          return JSON.stringify({ ...localMetadata, t3Home: "/custom/v2-state" });
        },
      });
      assert.equal(env.T3CODE_HOME, "/custom/v2-state");
      if (platform === "linux") assert.equal(env.XDG_CONFIG_HOME, "/custom/v2-state/appdata");
    }
  });
});
