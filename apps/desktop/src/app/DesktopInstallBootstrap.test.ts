import { assert, describe, it } from "@effect/vitest";

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
  it("isolates a taskbar launch even when it inherits the alpha.local environment", () => {
    const env: NodeJS.ProcessEnv = {
      T3CODE_HOME: "C:\\Users\\alice\\.t3.local",
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.t3tools.t3code.alpha.local",
      T3CODE_DISABLE_AUTO_UPDATE: "false",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    };
    assert.isTrue(applyInstalledDesktopBootstrap({ ...defaults, env, readFileString: read }));
    assert.equal(env.T3CODE_HOME, localMetadata.t3Home);
    assert.equal(env.APPDATA, `${localMetadata.t3Home}\\appdata`);
    assert.equal(env.T3CODE_DESKTOP_DISPLAY_NAME, "T3 v2.local");
    assert.equal(env.T3CODE_DESKTOP_APP_USER_MODEL_ID, localMetadata.windowsAppUserModelId);
    assert.equal(env.T3CODE_DESKTOP_LOCAL_IDENTITY, "true");
    assert.equal(env.T3CODE_LOCAL_BOOTSTRAP_VERSION, "t3code-v2-local-bootstrap-1");
    assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "true");
    assert.isUndefined(env.VITE_DEV_SERVER_URL);
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

  for (const t3Home of [
    "relative",
    "C:\\Users\\alice\\.t3",
    "C:\\Users\\alice\\.t3.local\\userdata",
    "C:\\Users\\alice",
  ]) {
    it(`rejects a home that cannot be isolated: ${t3Home}`, () => {
      const env: NodeJS.ProcessEnv = {};
      assert.throws(() =>
        applyInstalledDesktopBootstrap({
          ...defaults,
          env,
          readFileString: (path) =>
            path.endsWith("package.json")
              ? read(path)
              : JSON.stringify({ ...localMetadata, t3Home }),
        }),
      );
      assert.deepEqual(env, {});
    });
  }

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
        env,
        readFileString: () => JSON.stringify({ name: "t3code" }),
      }),
    );
    assert.isFalse(
      applyInstalledDesktopBootstrap({
        ...defaults,
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
        appPath: "/opt/t3/resources/app.asar",
        env,
        readFileString: read,
      });
      assert.equal(env.T3CODE_HOME, "/home/alice/.t3.v2");
    }
  });
});
