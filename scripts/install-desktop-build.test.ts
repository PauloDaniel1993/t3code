// @effect-diagnostics nodeBuiltinImport:off - Tests use temporary filesystem fixtures for the standalone installer CLI.
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  assertSafeInstallDir,
  assertSafeStateDir,
  InstallDesktopBuildError,
  parseInstallDesktopBuildArgs,
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

it("resolves Windows unpacked desktop artifacts", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3code-install-test-"));
  try {
    const unpacked = NodePath.join(root, "win-unpacked");
    await NodeFs.mkdir(unpacked);

    assert.equal(await resolveUnpackedAppRoot(root, "win"), unpacked);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("resolves nested macOS app bundles", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3code-install-test-"));
  try {
    const appBundle = NodePath.join(root, "mac", "T3 Code.app");
    await NodeFs.mkdir(appBundle, { recursive: true });

    assert.equal(await resolveUnpackedAppRoot(root, "mac"), appBundle);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});
