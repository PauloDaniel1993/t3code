// @effect-diagnostics nodeBuiltinImport:off - Tests use temporary filesystem fixtures for the standalone installer CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { createPackageWithOptions } from "@electron/asar";

import {
  assertSafeInstallDir,
  assertSafeStateDir,
  assertLocalInstallDirectory,
  assertLocalDesktopArtifact,
  assertCanonicalInstallPaths,
  buildArtifactArgs,
  InstallDesktopBuildError,
  parseInstallDesktopBuildArgs,
  renderInstallMetadata,
  renderWindowsShortcutScript,
  renderWindowsLocalLauncher,
  resolveUnpackedAppRoot,
} from "./install-desktop-build.ts";
import { LOCAL_DESKTOP_BOOTSTRAP_VERSION } from "./lib/local-desktop-identity.ts";

it("requests an unpacked artifact with the V2 local identity", () => {
  const options = parseInstallDesktopBuildArgs(
    ["--install-dir", "installed"],
    {},
    NodePath.resolve("fixtures"),
    "win32",
    NodePath.resolve("fixtures/home"),
  );
  const args = buildArtifactArgs(options);
  assert.include(args, "--local-identity");
  assert.include(args, "dir");
  assert.isFalse(options.launch);
});

it("rejects both live homes and state that overlaps a disposable directory", () => {
  const homeDir = NodePath.resolve("fixtures/home");
  const installDir = NodePath.resolve("fixtures/install");
  const outputDir = NodePath.resolve("fixtures/artifacts");
  for (const stateDir of [
    NodePath.join(homeDir, ".t3"),
    NodePath.join(homeDir, ".t3.local", "userdata"),
    homeDir,
    NodePath.resolve("fixtures"),
    `${installDir}.previous`,
  ]) {
    assert.throws(
      () => assertSafeStateDir(stateDir, { installDir, outputDir, homeDir }),
      InstallDesktopBuildError,
    );
  }
  for (const liveDir of [NodePath.join(homeDir, ".t3"), NodePath.join(homeDir, ".t3.local")]) {
    assert.throws(
      () =>
        assertSafeInstallDir(liveDir, {
          repoRoot: NodePath.resolve("fixtures/repo"),
          outputDir,
          homeDir,
        }),
      InstallDesktopBuildError,
    );
  }
});

it("allows only V2 local installs to be updated and leaves other fixtures untouched", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-v2-install-guard-"));
  try {
    const metadataPath = NodePath.join(root, ".t3code-install.json");
    await NodeFSP.writeFile(NodePath.join(root, "keep.txt"), "existing app");
    for (const metadata of [
      undefined,
      { displayName: "T3 alpha.local", windowsAppUserModelId: "com.t3tools.t3code.alpha.local" },
    ]) {
      if (metadata) await NodeFSP.writeFile(metadataPath, JSON.stringify(metadata));
      await expect(assertLocalInstallDirectory(root)).rejects.toThrow(/not a T3 v2.local install/);
      assert.equal(await NodeFSP.readFile(NodePath.join(root, "keep.txt"), "utf8"), "existing app");
    }
    await NodeFSP.writeFile(
      metadataPath,
      renderInstallMetadata({
        installedAt: "fixture",
        branch: "fixture",
        commit: "fixture",
        sourceAppRoot: "fixture",
        stateDir: NodePath.join(root, "home"),
      }),
    );
    await assertLocalInstallDirectory(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses reused official artifacts and accepts a V2 local package", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-v2-artifact-guard-"));
  try {
    const appDir = NodePath.join(root, "resources", "app");
    await NodeFSP.mkdir(appDir, { recursive: true });
    for (const name of ["t3code", "t3code-alpha-local"]) {
      await NodeFSP.writeFile(NodePath.join(appDir, "package.json"), JSON.stringify({ name }));
      await expect(assertLocalDesktopArtifact(root, "win")).rejects.toThrow(
        /not a T3 v2.local build/,
      );
    }
    await NodeFSP.writeFile(
      NodePath.join(appDir, "package.json"),
      JSON.stringify({ name: "t3code-v2-local" }),
    );
    const bundlePath = NodePath.join(appDir, "apps", "desktop", "dist-electron", "main.cjs");
    await NodeFSP.mkdir(NodePath.dirname(bundlePath), { recursive: true });
    await NodeFSP.writeFile(bundlePath, "upstream bundle without isolation");
    await expect(assertLocalDesktopArtifact(root, "win")).rejects.toThrow(
      /not a T3 v2.local build/,
    );
    await NodeFSP.writeFile(
      bundlePath,
      `process.env.T3CODE_LOCAL_BOOTSTRAP_VERSION = "${LOCAL_DESKTOP_BOOTSTRAP_VERSION}";`,
    );
    await assertLocalDesktopArtifact(root, "win");
    await createPackageWithOptions(appDir, NodePath.join(root, "resources", "app.asar"), {});
    await NodeFSP.writeFile(
      NodePath.join(appDir, "package.json"),
      JSON.stringify({ name: "t3code" }),
    );
    await assertLocalDesktopArtifact(root, "win");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("resolves junctions before allowing state paths, using only fixture homes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-v2-path-guard-"));
  try {
    const homeDir = NodePath.join(root, "home");
    const protectedDir = NodePath.join(homeDir, ".t3.local");
    const alias = NodePath.join(root, "alias");
    await NodeFSP.mkdir(protectedDir, { recursive: true });
    await NodeFSP.symlink(protectedDir, alias, "junction");
    const options = parseInstallDesktopBuildArgs(
      ["--install-dir", "installed", "--output-dir", "artifacts", "--state-dir", alias],
      {},
      root,
      "win32",
      homeDir,
    );
    await expect(assertCanonicalInstallPaths(options, homeDir)).rejects.toThrow(/live home/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

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
  assert.equal(options.stateDir, NodePath.join(cwd, "home", ".t3.v2"));
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
  const launcher = renderWindowsLocalLauncher("C:\\Users\\alice\\.t3.v2", "T3 v2.local.exe");

  assert.include(launcher, 'set "T3CODE_HOME=C:\\Users\\alice\\.t3.v2"');
  assert.include(launcher, 'set "APPDATA=%T3CODE_HOME%\\appdata"');
  assert.include(launcher, 'set "T3CODE_DESKTOP_DISPLAY_NAME=T3 v2.local"');
  assert.include(launcher, 'set "T3CODE_DESKTOP_APP_USER_MODEL_ID=com.t3tools.t3code.v2.local"');
  assert.include(launcher, 'set "T3CODE_DISABLE_AUTO_UPDATE=true"');
  assert.include(launcher, 'start "" "%~dp0T3 v2.local.exe" %*');
});

it("renders a Windows shortcut script targeting the local launcher with the installed exe icon", () => {
  const script = renderWindowsShortcutScript({
    shortcutPath:
      "C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\T3 v2.local.lnk",
    targetPath: "C:\\Users\\alice\\AppData\\Local\\T3 v2.local\\T3 v2.local.cmd",
    iconPath: "C:\\Users\\alice\\AppData\\Local\\T3 v2.local\\T3 v2.local.exe",
    workingDirectory: "C:\\Users\\alice\\AppData\\Local\\T3 v2.local",
    appUserModelId: "com.t3tools.t3code.v2.local",
  });

  assert.include(
    script,
    "$shortcut.TargetPath = 'C:\\Users\\alice\\AppData\\Local\\T3 v2.local\\T3 v2.local.cmd'",
  );
  assert.include(script, "$shortcut.Arguments = ''");
  assert.include(
    script,
    "$shortcut.WorkingDirectory = 'C:\\Users\\alice\\AppData\\Local\\T3 v2.local'",
  );
  assert.include(
    script,
    "$shortcut.IconLocation = 'C:\\Users\\alice\\AppData\\Local\\T3 v2.local\\T3 v2.local.exe,0'",
  );
  assert.include(script, "$shortcut.Description = 'T3 v2.local local build'");
  assert.include(script, "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  assert.include(
    script,
    "[T3CodeShortcutInterop.ShortcutProperties]::SetAppUserModelId('C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\T3 v2.local.lnk', 'com.t3tools.t3code.v2.local')",
  );
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
      stateDir: "C:\\Users\\alice\\.t3.v2",
    }),
  );

  assert.equal(metadata.t3Home, "C:\\Users\\alice\\.t3.v2");
  assert.equal(metadata.stateDir, "C:\\Users\\alice\\.t3.v2");
  assert.equal(metadata.appDataDirectory, "C:\\Users\\alice\\.t3.v2\\appdata");
  assert.equal(metadata.displayName, "T3 v2.local");
  assert.equal(metadata.windowsAppUserModelId, "com.t3tools.t3code.v2.local");
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
