import { assert, describe, it } from "@effect/vitest";

import { applyWindowsInstalledDesktopBootstrap } from "./DesktopInstallBootstrap.ts";

describe("DesktopInstallBootstrap", () => {
  it("applies local identity before a direct Windows executable launch", () => {
    const env: NodeJS.ProcessEnv = {};
    let metadataPath = "";

    const applied = applyWindowsInstalledDesktopBootstrap({
      platform: "win32",
      executablePath: "C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 alpha.local.exe",
      env,
      readFileString: (path) => {
        metadataPath = path;
        return JSON.stringify({
          t3Home: "C:\\Users\\alice\\.t3.local",
          appDataDirectory: "C:\\Users\\alice\\.t3.local\\appdata",
          displayName: "T3 alpha.local",
          windowsAppUserModelId: "com.t3tools.t3code.alpha.local",
        });
      },
    });

    assert.equal(applied, true);
    assert.equal(
      metadataPath,
      "C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\.t3code-install.json",
    );
    assert.equal(env.T3CODE_HOME, "C:\\Users\\alice\\.t3.local");
    assert.equal(env.APPDATA, "C:\\Users\\alice\\.t3.local\\appdata");
    assert.equal(env.T3CODE_DESKTOP_DISPLAY_NAME, "T3 alpha.local");
    assert.equal(env.T3CODE_DESKTOP_APP_USER_MODEL_ID, "com.t3tools.t3code.alpha.local");
    assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "true");
  });

  it("forces the isolated APPDATA over the inherited Windows default", () => {
    const env: NodeJS.ProcessEnv = {
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
    };

    const applied = applyWindowsInstalledDesktopBootstrap({
      platform: "win32",
      executablePath: "C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 alpha.local.exe",
      env,
      readFileString: () =>
        JSON.stringify({
          t3Home: "C:\\Users\\alice\\.t3.local",
          appDataDirectory: "C:\\Users\\alice\\.t3.local\\appdata",
          displayName: "T3 alpha.local",
          windowsAppUserModelId: "com.t3tools.t3code.alpha.local",
        }),
    });

    assert.equal(applied, true);
    assert.equal(env.T3CODE_HOME, "C:\\Users\\alice\\.t3.local");
    assert.equal(env.APPDATA, "C:\\Users\\alice\\.t3.local\\appdata");
  });

  it("preserves explicit environment overrides", () => {
    const env: NodeJS.ProcessEnv = {
      T3CODE_HOME: "D:\\custom-state",
      APPDATA: "D:\\custom-appdata",
      T3CODE_DESKTOP_DISPLAY_NAME: "Custom local",
      T3CODE_DESKTOP_APP_USER_MODEL_ID: "example.custom.local",
      T3CODE_DISABLE_AUTO_UPDATE: "false",
    };

    const applied = applyWindowsInstalledDesktopBootstrap({
      platform: "win32",
      executablePath: "C:\\T3 Local\\T3 alpha.local.exe",
      env,
      readFileString: () =>
        JSON.stringify({
          t3Home: "C:\\Users\\alice\\.t3.local",
          appDataDirectory: "C:\\Users\\alice\\.t3.local\\appdata",
          displayName: "T3 alpha.local",
          windowsAppUserModelId: "com.t3tools.t3code.alpha.local",
        }),
    });

    assert.equal(applied, true);
    assert.equal(env.T3CODE_HOME, "D:\\custom-state");
    assert.equal(env.APPDATA, "D:\\custom-appdata");
    assert.equal(env.T3CODE_DESKTOP_DISPLAY_NAME, "Custom local");
    assert.equal(env.T3CODE_DESKTOP_APP_USER_MODEL_ID, "example.custom.local");
    assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "false");
  });

  it("ignores missing, malformed, and non-Windows install metadata", () => {
    const missingEnv: NodeJS.ProcessEnv = {};
    assert.equal(
      applyWindowsInstalledDesktopBootstrap({
        platform: "win32",
        executablePath: "C:\\T3 Local\\T3 alpha.local.exe",
        env: missingEnv,
        readFileString: () => {
          throw new Error("missing");
        },
      }),
      false,
    );
    assert.deepEqual(missingEnv, {});

    const malformedEnv: NodeJS.ProcessEnv = {};
    assert.equal(
      applyWindowsInstalledDesktopBootstrap({
        platform: "win32",
        executablePath: "C:\\T3 Local\\T3 alpha.local.exe",
        env: malformedEnv,
        readFileString: () => JSON.stringify({ t3Home: "relative" }),
      }),
      false,
    );
    assert.deepEqual(malformedEnv, {});

    assert.equal(
      applyWindowsInstalledDesktopBootstrap({
        platform: "linux",
        executablePath: "/opt/t3code-local/t3code",
        env: {},
        readFileString: () => {
          throw new Error("should not read");
        },
      }),
      false,
    );
  });
});
