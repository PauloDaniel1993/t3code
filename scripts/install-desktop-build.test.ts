// @effect-diagnostics nodeBuiltinImport:off - Tests use temporary filesystem fixtures for the standalone installer CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  assertSafeInstallDir,
  assertSafeStateDir,
  InstallDesktopBuildError,
  parseInstallDesktopBuildArgs,
  renderInstallMetadata,
  renderWindowsShortcutScript,
  renderWindowsLocalLauncher,
  resolveUnpackedAppRoot,
} from "./install-desktop-build.ts";

it("parses the install directory and host platform defaults", () => {
  const cwd = NodePath.resolve("fixtures");
  const options = parseInstallDesktopBuildArgs(
    ["--install-dir", "installed", "--arch=x64", "--launch"],
    {},
    cwd,
    "win32",
    NodePath.join(cwd, "home"),
  );

  assert.equal(options.installDir, NodePath.join(cwd, "installed"));
  assert.equal(options.stateDir, NodePath.join(cwd, "home", ".t3.local"));
  assert.equal(options.platform, "win");
  assert.equal(options.arch, "x64");
  assert.equal(options.launch, true);
  assert.equal(options.skipBuild, false);
  assert.equal(options.reuseArtifact, false);
});

it("parses the reuse-artifact installer shortcut", () => {
  const cwd = NodePath.resolve("fixtures");
  const options = parseInstallDesktopBuildArgs(
    ["--install-dir", "installed", "--reuse-artifact"],
    {},
    cwd,
    "win32",
    NodePath.join(cwd, "home"),
  );

  assert.equal(options.installDir, NodePath.join(cwd, "installed"));
  assert.equal(options.reuseArtifact, true);
});

it("reads install defaults from the environment", () => {
  const cwd = NodePath.resolve("fixtures");
  const options = parseInstallDesktopBuildArgs(
    [],
    {
      T3CODE_DESKTOP_INSTALL_DIR: "env-install",
      T3CODE_DESKTOP_PLATFORM: "linux",
      T3CODE_DESKTOP_ARCH: "arm64",
      T3CODE_DESKTOP_LOCAL_STATE_DIR: "env-state",
      T3CODE_DESKTOP_VERSION: "0.0.0-local",
    },
    cwd,
    "win32",
    NodePath.join(cwd, "home"),
  );

  assert.equal(options.installDir, NodePath.join(cwd, "env-install"));
  assert.equal(options.stateDir, NodePath.join(cwd, "env-state"));
  assert.equal(options.platform, "linux");
  assert.equal(options.arch, "arm64");
  assert.equal(options.buildVersion, "0.0.0-local");
});

it("rejects state directories that would be replaced or cleaned", () => {
  const installDir = NodePath.resolve("install");
  const outputDir = NodePath.resolve("artifacts");

  assert.throws(
    () =>
      assertSafeStateDir(NodePath.join(installDir, "state"), {
        installDir,
        outputDir,
      }),
    InstallDesktopBuildError,
  );

  assert.throws(
    () =>
      assertSafeStateDir(NodePath.join(outputDir, "state"), {
        installDir,
        outputDir,
      }),
    InstallDesktopBuildError,
  );
});

it("rejects unsafe install directories", () => {
  const repoRoot = NodePath.resolve("repo");
  const outputDir = NodePath.join(repoRoot, ".t3-dev", "desktop-install-artifacts");

  assert.throws(
    () =>
      assertSafeInstallDir(repoRoot, {
        repoRoot,
        outputDir,
        homeDir: NodePath.resolve("home"),
      }),
    InstallDesktopBuildError,
  );

  assert.throws(
    () =>
      assertSafeInstallDir(outputDir, {
        repoRoot,
        outputDir,
        homeDir: NodePath.resolve("home"),
      }),
    InstallDesktopBuildError,
  );
});

it("renders a Windows launcher with local state and taskbar identity", () => {
  const launcher = renderWindowsLocalLauncher("C:\\Users\\alice\\.t3.local", "T3 Code.exe");

  assert.include(launcher, 'set "T3CODE_HOME=C:\\Users\\alice\\.t3.local"');
  assert.include(launcher, 'set "APPDATA=%T3CODE_HOME%\\appdata"');
  assert.include(launcher, 'set "T3CODE_DESKTOP_DISPLAY_NAME=T3 Code (alpha.local)"');
  assert.include(launcher, 'set "T3CODE_DESKTOP_APP_USER_MODEL_ID=com.t3tools.t3code.alpha.local"');
  assert.include(launcher, 'set "T3CODE_DISABLE_AUTO_UPDATE=true"');
  assert.include(launcher, 'start "" "%~dp0T3 Code.exe" %*');
});

it("renders a Windows shortcut script targeting the local launcher with the installed exe icon", () => {
  const script = renderWindowsShortcutScript({
    shortcutPath:
      "C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\T3 Code (alpha.local).lnk",
    targetPath: "C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 Code Local.cmd",
    iconPath: "C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 Code.exe",
    workingDirectory: "C:\\Users\\alice\\AppData\\Local\\T3 Code Local",
  });

  assert.include(
    script,
    "$shortcut.TargetPath = 'C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 Code Local.cmd'",
  );
  assert.include(script, "$shortcut.Arguments = ''");
  assert.include(
    script,
    "$shortcut.WorkingDirectory = 'C:\\Users\\alice\\AppData\\Local\\T3 Code Local'",
  );
  assert.include(
    script,
    "$shortcut.IconLocation = 'C:\\Users\\alice\\AppData\\Local\\T3 Code Local\\T3 Code.exe,0'",
  );
  assert.include(script, "$shortcut.Description = 'T3 Code (alpha.local) local build'");
  assert.notInclude(script, "dist-electron");
  assert.notInclude(script, "main.cjs");
});

it("renders install metadata for direct taskbar launches", () => {
  const metadata = JSON.parse(
    renderInstallMetadata({
      installedAt: "2026-06-20T00:00:00.000Z",
      branch: "feature/local",
      commit: "abc123",
      sourceAppRoot: "C:\\build\\win-unpacked",
      stateDir: "C:\\Users\\alice\\.t3.local",
    }),
  );

  assert.equal(metadata.t3Home, "C:\\Users\\alice\\.t3.local");
  assert.equal(metadata.stateDir, "C:\\Users\\alice\\.t3.local");
  assert.equal(metadata.appDataDirectory, "C:\\Users\\alice\\.t3.local\\appdata");
  assert.equal(metadata.displayName, "T3 Code (alpha.local)");
  assert.equal(metadata.windowsAppUserModelId, "com.t3tools.t3code.alpha.local");
});

it("resolves Windows unpacked desktop artifacts", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-install-test-"));
  try {
    const unpacked = NodePath.join(root, "win-unpacked");
    await NodeFSP.mkdir(unpacked);

    assert.equal(await resolveUnpackedAppRoot(root, "win"), unpacked);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("resolves nested macOS app bundles", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-install-test-"));
  try {
    const appBundle = NodePath.join(root, "mac", "T3 Code.app");
    await NodeFSP.mkdir(appBundle, { recursive: true });

    assert.equal(await resolveUnpackedAppRoot(root, "mac"), appBundle);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
