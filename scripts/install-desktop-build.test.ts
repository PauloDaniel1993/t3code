// @effect-diagnostics nodeBuiltinImport:off - Tests use temporary filesystem fixtures for the standalone installer CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { createPackageWithOptions } from "@electron/asar";

import {
  assertSafeInstallDir,
  assertSafeStateDir,
  assertLocalInstallDirectory,
  assertLocalDesktopArtifact,
  assertCanonicalInstallPaths,
  assertSeparateFromKnownInstalls,
  assertInstallDesktopBuildPaths,
  resolveInstallerHomeDirectory,
  resolveWindowsStartMenuShortcut,
  replaceInstallDir,
  writePosixLocalLauncher,
  buildArtifactArgs,
  InstallDesktopBuildError,
  parseInstallDesktopBuildArgs,
  renderInstallMetadata,
  renderWindowsShortcutScript,
  renderWindowsLocalLauncher,
  resolveUnpackedAppRoot,
} from "./install-desktop-build.ts";
import { LOCAL_DESKTOP_BOOTSTRAP_VERSION } from "./lib/local-desktop-identity.ts";
import { getWindowsUserDirectories } from "./lib/windows-user-directories.ts";

it("gets non-Windows installer defaults from the OS account instead of an inherited HOME", () => {
  try {
    vi.stubEnv("HOME", NodePath.resolve("fixture-alpha-home"));
    assert.equal(resolveInstallerHomeDirectory("linux"), NodeOS.userInfo().homedir);
    assert.equal(resolveInstallerHomeDirectory("darwin"), NodeOS.userInfo().homedir);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("creates a Linux launcher without overwriting the packaged executable", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-posix-launcher-"));
  try {
    const executable = NodePath.join(root, "t3code-v2-local");
    await NodeFSP.writeFile(executable, "packaged executable fixture");
    const launcher = await writePosixLocalLauncher(
      root,
      NodePath.join(root, "state"),
      executable,
      "linux",
    );
    assert.notEqual(launcher, executable);
    assert.equal(await NodeFSP.readFile(executable, "utf8"), "packaged executable fixture");
    assert.isNotEmpty(await NodeFSP.readFile(launcher, "utf8"));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.effect("resolves the Start Menu and default state outside an inherited alpha.local home", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") return;
    const folders = getWindowsUserDirectories();
    const alphaHome = NodePath.join(folders.home, ".t3.local");
    try {
      for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"]) {
        vi.stubEnv(name, NodePath.join(alphaHome, name.toLowerCase()));
      }
      vi.stubEnv("T3CODE_HOME", alphaHome);
      const shortcut = yield* Effect.promise(() => resolveWindowsStartMenuShortcut());
      assert.equal(shortcut, NodePath.join(folders.programs, "T3 v2.local.lnk"));
      const options = parseInstallDesktopBuildArgs([
        "--install-dir",
        NodePath.join(NodeOS.tmpdir(), "fixture-install"),
      ]);
      assert.equal(options.stateDir, NodePath.join(folders.home, ".t3.v2"));
      assert.notInclude(shortcut, alphaHome);
    } finally {
      vi.unstubAllEnvs();
    }
  }),
);

it("refuses install/state/output nesting in both directions, naming the conflicting install or home", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-nesting-guard-"));
  try {
    const otherInstall = NodePath.join(root, "other", "app");
    const otherHome = NodePath.join(root, "other-state", "home");
    await NodeFSP.mkdir(otherInstall, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(otherInstall, ".t3code-install.json"),
      JSON.stringify({
        displayName: "T3 alpha.local",
        t3Home: otherHome,
      }),
    );
    const safe = parseInstallDesktopBuildArgs(
      [
        "--install-dir",
        NodePath.join(root, "safe-install"),
        "--state-dir",
        NodePath.join(root, "safe-state"),
        "--output-dir",
        NodePath.join(root, "safe-output"),
      ],
      {},
      root,
      "win32",
      NodePath.join(root, "user"),
    );
    await assertSeparateFromKnownInstalls(safe, [otherInstall]);
    for (const key of ["installDir", "stateDir", "outputDir"] as const) {
      for (const protectedDir of [otherInstall, otherHome]) {
        for (const candidate of [
          NodePath.join(protectedDir, "v2"),
          NodePath.dirname(protectedDir),
        ]) {
          await expect(
            assertSeparateFromKnownInstalls({ ...safe, [key]: candidate }, [otherInstall]),
          ).rejects.toThrow(protectedDir);
        }
      }
    }
    assert.equal(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(otherInstall, ".t3code-install.json"), "utf8"),
      ).displayName,
      "T3 alpha.local",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("finds custom installs above and below the selected directories without a known-path hint", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-markers-"));
  try {
    const safe = parseInstallDesktopBuildArgs(
      [
        "--install-dir",
        NodePath.join(root, "safe-install"),
        "--state-dir",
        NodePath.join(root, "safe-state"),
        "--output-dir",
        NodePath.join(root, "safe-output"),
      ],
      {},
      root,
      "win32",
      NodePath.join(root, "user"),
    );
    for (const marker of [".t3code-install.json", "resources/app.asar", "Uninstall T3 Code.exe"]) {
      const other = NodePath.join(root, marker.replaceAll(/[/. ]/g, "_"), "app");
      const markerPath = NodePath.join(other, marker);
      await NodeFSP.mkdir(NodePath.dirname(markerPath), { recursive: true });
      await NodeFSP.writeFile(markerPath, marker.endsWith("json") ? "{}" : "fixture");
      for (const key of ["installDir", "stateDir"] as const) {
        for (const candidate of [
          NodePath.join(other, "nested"),
          ...(key === "installDir" ? [NodePath.dirname(other)] : []),
        ]) {
          await expect(
            assertInstallDesktopBuildPaths(
              { ...safe, [key]: candidate },
              NodePath.join(root, "user"),
              [],
            ),
          ).rejects.toThrow(other);
        }
      }
      await expect(
        assertSeparateFromKnownInstalls(
          { ...safe, outputDir: NodePath.join(other, "artifacts") },
          [],
        ),
      ).rejects.toThrow(other);
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("allows updates when state worktrees contain desktop artifacts, without inspecting their subtrees", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-state-worktrees-"));
  try {
    const safe = parseInstallDesktopBuildArgs(
      [
        "--install-dir",
        NodePath.join(root, "install"),
        "--state-dir",
        NodePath.join(root, "state"),
        "--output-dir",
        NodePath.join(root, "output"),
      ],
      {},
      root,
      "win32",
      NodePath.join(root, "user"),
    );
    const worktree = NodePath.join(safe.stateDir, "worktrees", "repo");
    for (const marker of [
      "win-unpacked/resources/app.asar",
      ".t3code-install.json",
      "node_modules/.pnpm/fixture/resources/app.asar",
    ]) {
      const file = NodePath.join(worktree, marker);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, "not install metadata");
    }
    await NodeFSP.mkdir(safe.installDir);
    await NodeFSP.writeFile(
      NodePath.join(safe.installDir, ".t3code-install.json"),
      renderInstallMetadata({
        installedAt: "fixture",
        branch: "fixture",
        commit: "fixture",
        sourceAppRoot: "fixture",
        stateDir: safe.stateDir,
      }),
    );
    await assertInstallDesktopBuildPaths(safe, NodePath.join(root, "user"), []);
    assert.equal(
      await NodeFSP.readFile(NodePath.join(worktree, ".t3code-install.json"), "utf8"),
      "not install metadata",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses UNC and junction aliases of another install or its home before replacement", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone filesystem test requiring Windows SMB shares.
  if (NodeOS.platform() !== "win32") return;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-unc-guard-"));
  try {
    const home = NodePath.join(root, "user");
    const otherInstall = NodePath.join(root, "other-install");
    const otherHome = NodePath.join(root, "other-home");
    const liveHome = NodePath.join(home, ".t3.local");
    for (const directory of [otherInstall, otherHome, liveHome])
      await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(otherInstall, ".t3code-install.json"),
      JSON.stringify({ t3Home: otherHome, displayName: "T3 alpha.local" }),
    );
    const safe = parseInstallDesktopBuildArgs(
      [
        "--install-dir",
        NodePath.join(root, "install"),
        "--state-dir",
        NodePath.join(root, "state"),
        "--output-dir",
        NodePath.join(root, "output"),
      ],
      {},
      root,
      "win32",
      home,
    );
    const drive = NodePath.parse(root).root;
    const unc = (directory: string) =>
      `\\\\localhost\\${drive[0]}$\\${directory.slice(drive.length)}`;
    const alias = NodePath.join(root, "junction");
    await NodeFSP.symlink(liveHome, alias, "junction");
    for (const key of ["installDir", "stateDir", "outputDir"] as const) {
      for (const protectedDir of [otherInstall, otherHome, liveHome]) {
        for (const candidate of [
          unc(protectedDir),
          `${unc(protectedDir)}\\missing`,
          unc(NodePath.dirname(protectedDir)),
          `${protectedDir}.`,
          `${protectedDir} `,
          `${protectedDir}.\\userdata`,
          NodePath.join(root, "T3LOCA~1"),
          `\\\\?\\${protectedDir}`,
          `\\\\.\\${protectedDir}`,
          `${protectedDir}:stream`,
          `${protectedDir}::$DATA`,
          protectedDir.replaceAll("\\", "/"),
        ]) {
          await expect(
            assertInstallDesktopBuildPaths({ ...safe, [key]: candidate }, home, [otherInstall]),
          ).rejects.toThrow(/overlap|home directory|not a T3 v2.local install|Refusing|trailing/);
        }
      }
      await expect(
        assertInstallDesktopBuildPaths({ ...safe, [key]: NodePath.join(alias, "missing") }, home, [
          otherInstall,
        ]),
      ).rejects.toThrow(/live home/);
    }
    assert.equal(
      await NodeFSP.readFile(NodePath.join(otherInstall, ".t3code-install.json"), "utf8"),
      JSON.stringify({ t3Home: otherHome, displayName: "T3 alpha.local" }),
    );
  } finally {
    await NodeFSP.rmdir(NodePath.join(root, "junction"));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses folded Windows CLI and environment spellings before normalization", () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Windows installer argument fixture.
  if (NodeOS.platform() !== "win32") return;
  const root = NodeOS.tmpdir();
  const live = NodePath.join(root, "fixture-user", ".t3.local");
  for (const candidate of [
    `${live}.`,
    `${live} `,
    `${live}.\\userdata`,
    NodePath.join(root, "fixture-user", ".t3."),
    NodePath.join(root, "T3LOCA~1"),
    `\\\\?\\${live}`,
    `\\\\.\\${live}`,
    `${live}:stream`,
    live.replaceAll("\\", "/"),
  ]) {
    for (const flag of ["--install-dir", "--state-dir", "--output-dir"]) {
      assert.throws(
        () =>
          parseInstallDesktopBuildArgs(
            ["--install-dir", NodePath.join(root, "install"), flag, candidate],
            {},
            root,
            "win32",
            NodePath.join(root, "fixture-user"),
          ),
        /Refusing|trailing/,
      );
    }
    assert.throws(
      () =>
        parseInstallDesktopBuildArgs(
          ["--install-dir", NodePath.join(root, "install")],
          { T3CODE_DESKTOP_LOCAL_STATE_DIR: candidate },
          root,
          "win32",
          NodePath.join(root, "fixture-user"),
        ),
      /Refusing|trailing/,
    );
  }
});

it("swaps fixture updates, rolls back a failed rename, and leaves refused targets untouched", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-swap-"));
  try {
    const install = NodePath.join(root, "install");
    const staged = NodePath.join(root, "stage");
    const metadata = renderInstallMetadata({
      installedAt: "fixture",
      branch: "fixture",
      commit: "fixture",
      sourceAppRoot: "fixture",
      stateDir: NodePath.join(root, "state"),
    });
    for (const [directory, version] of [
      [install, "old"],
      [staged, "new"],
    ] as const) {
      await NodeFSP.mkdir(directory);
      await NodeFSP.writeFile(NodePath.join(directory, ".t3code-install.json"), metadata);
      await NodeFSP.writeFile(NodePath.join(directory, "version.txt"), version);
    }
    await replaceInstallDir(staged, install);
    assert.equal(await NodeFSP.readFile(NodePath.join(install, "version.txt"), "utf8"), "new");
    await expect(NodeFSP.stat(`${install}.previous`)).rejects.toThrow();
    await expect(replaceInstallDir(NodePath.join(root, "missing-stage"), install)).rejects.toThrow(
      /Failed to replace/,
    );
    assert.equal(await NodeFSP.readFile(NodePath.join(install, "version.txt"), "utf8"), "new");
    await NodeFSP.rm(NodePath.join(install, ".t3code-install.json"));
    await expect(replaceInstallDir(staged, install)).rejects.toThrow(/not a T3 v2.local install/);
    assert.equal(await NodeFSP.readFile(NodePath.join(install, "version.txt"), "utf8"), "new");
    await NodeFSP.writeFile(NodePath.join(install, ".t3code-install.json"), metadata);
    const backup = `${install}.previous`;
    await NodeFSP.mkdir(backup);
    await NodeFSP.writeFile(NodePath.join(backup, "leftover.txt"), "partial backup");
    await expect(replaceInstallDir(staged, install)).rejects.toThrow(`Refusing backup ${backup}`);
    await expect(replaceInstallDir(staged, install)).rejects.toThrow(
      /remove that backup directory manually/,
    );
    assert.equal(
      await NodeFSP.readFile(NodePath.join(backup, "leftover.txt"), "utf8"),
      "partial backup",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("requests an unpacked artifact with the V2 local identity", () => {
  const options = parseInstallDesktopBuildArgs(
    ["--install-dir", NodePath.join(NodePath.resolve("fixtures"), "installed")],
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
      [
        "--install-dir",
        NodePath.join(root, "installed"),
        "--output-dir",
        NodePath.join(root, "artifacts"),
        "--state-dir",
        alias,
      ],
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

it("protects a live-home fixture that is itself a junction to an external directory", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-protected-junction-"));
  try {
    const homeDir = NodePath.join(root, "user");
    const protectedTarget = NodePath.join(root, "external", "alpha-state");
    await NodeFSP.mkdir(homeDir);
    await NodeFSP.mkdir(protectedTarget, { recursive: true });
    await NodeFSP.symlink(protectedTarget, NodePath.join(homeDir, ".t3.local"), "junction");
    const options = parseInstallDesktopBuildArgs(
      [
        "--install-dir",
        NodePath.join(root, "install"),
        "--output-dir",
        NodePath.join(root, "output"),
        "--state-dir",
        protectedTarget,
      ],
      {},
      root,
      "win32",
      homeDir,
    );
    await expect(assertInstallDesktopBuildPaths(options, homeDir, [])).rejects.toThrow(
      /live home.*\.t3.local/,
    );
    assert.deepEqual(await NodeFSP.readdir(protectedTarget), []);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("parses the install directory and host platform defaults", () => {
  const cwd = NodePath.resolve("fixtures");
  const options = parseInstallDesktopBuildArgs(
    ["--install-dir", NodePath.join(cwd, "installed"), "--arch=x64", "--launch"],
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
    ["--install-dir", NodePath.join(cwd, "installed"), "--reuse-artifact"],
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
      T3CODE_DESKTOP_INSTALL_DIR: NodePath.join(cwd, "env-install"),
      T3CODE_DESKTOP_PLATFORM: "linux",
      T3CODE_DESKTOP_ARCH: "arm64",
      T3CODE_DESKTOP_LOCAL_STATE_DIR: NodePath.join(cwd, "env-state"),
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
