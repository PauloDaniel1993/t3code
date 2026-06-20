#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone installer/update CLI that runs outside an Effect runtime.

import { spawn } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = NodePath.join(REPO_ROOT, ".t3-dev", "desktop-install-artifacts");
const METADATA_FILE_NAME = ".t3code-install.json";
const WINDOWS_LOCAL_LAUNCHER_NAME = "T3 Code Local.cmd";
const POSIX_LOCAL_LAUNCHER_NAME = "t3code-local";

const BUILD_PLATFORMS = ["mac", "linux", "win"] as const;
const BUILD_ARCHES = ["arm64", "x64", "universal"] as const;

type BuildPlatform = (typeof BUILD_PLATFORMS)[number];
type BuildArch = (typeof BUILD_ARCHES)[number];

export interface InstallDesktopBuildOptions {
  readonly installDir: string;
  readonly outputDir: string;
  readonly stateDir: string;
  readonly platform: BuildPlatform;
  readonly arch?: BuildArch;
  readonly buildVersion?: string;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
  readonly launch: boolean;
}

interface ParseState {
  installDir?: string;
  outputDir?: string;
  stateDir?: string;
  platform?: BuildPlatform;
  arch?: BuildArch;
  buildVersion?: string;
  skipBuild: boolean;
  verbose: boolean;
  launch: boolean;
}

export class InstallDesktopBuildError extends Error {
  override readonly name = "InstallDesktopBuildError";
}

function usage(): string {
  return [
    "Usage: node scripts/install-desktop-build.ts --install-dir <path> [options]",
    "",
    "Builds an unpacked desktop app and replaces the install directory with it.",
    "Rerun the same command after rebasing to update that install location.",
    "",
    "Options:",
    "  --install-dir <path>       Required install/update directory.",
    "  --output-dir <path>        Artifact staging directory. Defaults to .t3-dev/desktop-install-artifacts.",
    "  --state-dir <path>         Local app state directory. Defaults to the current user's .t3.local directory.",
    "  --platform <mac|linux|win> Build platform. Defaults to current host.",
    "  --arch <arm64|x64|universal>",
    "  --build-version <version>",
    "  --skip-build               Reuse existing build outputs while packaging.",
    "  --verbose                  Stream verbose artifact-builder output.",
    "  --launch                   Launch the installed app after updating.",
    "  --help",
  ].join("\n");
}

function isBuildPlatform(value: string): value is BuildPlatform {
  return BUILD_PLATFORMS.includes(value as BuildPlatform);
}

function isBuildArch(value: string): value is BuildArch {
  return BUILD_ARCHES.includes(value as BuildArch);
}

function detectHostBuildPlatform(platform: NodeJS.Platform): BuildPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "win";
  throw new InstallDesktopBuildError(`Unsupported host platform: ${platform}`);
}

function readCliHostPlatform(): NodeJS.Platform {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CLI boundary.
  return process.platform;
}

function readFlagValue(argv: ReadonlyArray<string>, index: number, flag: string): string {
  const current = argv[index];
  if (current === undefined) {
    throw new InstallDesktopBuildError(`Missing ${flag} value.`);
  }
  const assignmentPrefix = `${flag}=`;
  if (current.startsWith(assignmentPrefix)) {
    const assigned = current.slice(assignmentPrefix.length);
    if (assigned.length === 0) {
      throw new InstallDesktopBuildError(`Missing ${flag} value.`);
    }
    return assigned;
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InstallDesktopBuildError(`Missing ${flag} value.`);
  }
  return value;
}

function consumesNextValue(argv: ReadonlyArray<string>, index: number, flag: string): boolean {
  return argv[index] === flag;
}

function resolveInputPath(value: string, cwd: string): string {
  return NodePath.resolve(cwd, value);
}

function defaultStateDir(homeDir: string): string {
  return NodePath.join(homeDir, ".t3.local");
}

export function parseInstallDesktopBuildArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  hostPlatform: NodeJS.Platform = readCliHostPlatform(),
  homeDir = NodeOs.homedir(),
): InstallDesktopBuildOptions {
  const state: ParseState = {
    skipBuild: false,
    verbose: false,
    launch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      throw new InstallDesktopBuildError(usage());
    }
    if (arg === "--skip-build") {
      state.skipBuild = true;
      continue;
    }
    if (arg === "--verbose") {
      state.verbose = true;
      continue;
    }
    if (arg === "--launch") {
      state.launch = true;
      continue;
    }
    if (arg === "--no-launch") {
      state.launch = false;
      continue;
    }
    if (arg === "--install-dir" || arg.startsWith("--install-dir=")) {
      state.installDir = readFlagValue(argv, index, "--install-dir");
      if (consumesNextValue(argv, index, "--install-dir")) index += 1;
      continue;
    }
    if (arg === "--output-dir" || arg.startsWith("--output-dir=")) {
      state.outputDir = readFlagValue(argv, index, "--output-dir");
      if (consumesNextValue(argv, index, "--output-dir")) index += 1;
      continue;
    }
    if (arg === "--state-dir" || arg.startsWith("--state-dir=")) {
      state.stateDir = readFlagValue(argv, index, "--state-dir");
      if (consumesNextValue(argv, index, "--state-dir")) index += 1;
      continue;
    }
    if (arg === "--platform" || arg.startsWith("--platform=")) {
      const platform = readFlagValue(argv, index, "--platform");
      if (!isBuildPlatform(platform)) {
        throw new InstallDesktopBuildError(`Unsupported --platform value: ${platform}`);
      }
      state.platform = platform;
      if (consumesNextValue(argv, index, "--platform")) index += 1;
      continue;
    }
    if (arg === "--arch" || arg.startsWith("--arch=")) {
      const arch = readFlagValue(argv, index, "--arch");
      if (!isBuildArch(arch)) {
        throw new InstallDesktopBuildError(`Unsupported --arch value: ${arch}`);
      }
      state.arch = arch;
      if (consumesNextValue(argv, index, "--arch")) index += 1;
      continue;
    }
    if (arg === "--build-version" || arg.startsWith("--build-version=")) {
      state.buildVersion = readFlagValue(argv, index, "--build-version");
      if (consumesNextValue(argv, index, "--build-version")) index += 1;
      continue;
    }
    throw new InstallDesktopBuildError(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  const envInstallDir = env.T3CODE_DESKTOP_INSTALL_DIR?.trim();
  const installDir =
    state.installDir ?? (envInstallDir && envInstallDir.length > 0 ? envInstallDir : undefined);
  if (!installDir) {
    throw new InstallDesktopBuildError(`Missing required --install-dir.\n\n${usage()}`);
  }

  const envOutputDir = env.T3CODE_DESKTOP_INSTALL_OUTPUT_DIR?.trim();
  const outputDir =
    state.outputDir ??
    (envOutputDir && envOutputDir.length > 0 ? envOutputDir : DEFAULT_OUTPUT_DIR);
  const envStateDir = env.T3CODE_DESKTOP_LOCAL_STATE_DIR?.trim();
  const stateDir =
    state.stateDir ??
    (envStateDir && envStateDir.length > 0 ? envStateDir : defaultStateDir(homeDir));
  const envPlatform = env.T3CODE_DESKTOP_PLATFORM?.trim();
  const platform =
    state.platform ??
    (envPlatform && isBuildPlatform(envPlatform)
      ? envPlatform
      : detectHostBuildPlatform(hostPlatform));
  const envArch = env.T3CODE_DESKTOP_ARCH?.trim();
  const arch = state.arch ?? (envArch && isBuildArch(envArch) ? envArch : undefined);
  const envBuildVersion = env.T3CODE_DESKTOP_VERSION?.trim();
  const buildVersion =
    state.buildVersion ??
    (envBuildVersion && envBuildVersion.length > 0 ? envBuildVersion : undefined);

  return {
    installDir: resolveInputPath(installDir, cwd),
    outputDir: resolveInputPath(outputDir, cwd),
    stateDir: resolveInputPath(stateDir, cwd),
    platform,
    ...(arch ? { arch } : {}),
    ...(buildVersion ? { buildVersion } : {}),
    skipBuild: state.skipBuild,
    verbose: state.verbose,
    launch: state.launch,
  };
}

function pathEquals(a: string, b: string): boolean {
  return NodePath.resolve(a) === NodePath.resolve(b);
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(parent), NodePath.resolve(child));
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

function isSameOrInsidePath(child: string, parent: string): boolean {
  return pathEquals(child, parent) || isInsidePath(child, parent);
}

export function assertSafeInstallDir(
  installDir: string,
  options: {
    readonly repoRoot: string;
    readonly outputDir: string;
    readonly homeDir: string;
  },
): void {
  const resolvedInstallDir = NodePath.resolve(installDir);
  const root = NodePath.parse(resolvedInstallDir).root;
  if (pathEquals(resolvedInstallDir, root)) {
    throw new InstallDesktopBuildError(
      `Refusing to install into filesystem root: ${resolvedInstallDir}`,
    );
  }
  if (pathEquals(resolvedInstallDir, options.homeDir)) {
    throw new InstallDesktopBuildError(
      `Refusing to replace the home directory: ${resolvedInstallDir}`,
    );
  }
  if (isSameOrInsidePath(options.repoRoot, resolvedInstallDir)) {
    throw new InstallDesktopBuildError(
      `Refusing to use a directory that contains the repository as --install-dir: ${resolvedInstallDir}`,
    );
  }

  const gitDir = NodePath.join(options.repoRoot, ".git");
  if (isSameOrInsidePath(resolvedInstallDir, gitDir)) {
    throw new InstallDesktopBuildError(`Refusing to install inside .git: ${resolvedInstallDir}`);
  }

  if (
    isSameOrInsidePath(resolvedInstallDir, options.outputDir) ||
    isSameOrInsidePath(options.outputDir, resolvedInstallDir)
  ) {
    throw new InstallDesktopBuildError(
      `--install-dir and --output-dir must be separate directories.\ninstall: ${resolvedInstallDir}\noutput: ${options.outputDir}`,
    );
  }
}

export function assertSafeStateDir(
  stateDir: string,
  options: {
    readonly installDir: string;
    readonly outputDir: string;
  },
): void {
  const resolvedStateDir = NodePath.resolve(stateDir);
  if (isSameOrInsidePath(resolvedStateDir, options.installDir)) {
    throw new InstallDesktopBuildError(
      `Refusing to put persistent state inside --install-dir because updates replace that directory: ${resolvedStateDir}`,
    );
  }

  if (isSameOrInsidePath(resolvedStateDir, options.outputDir)) {
    throw new InstallDesktopBuildError(
      `Refusing to put persistent state inside --output-dir because build artifacts are disposable: ${resolvedStateDir}`,
    );
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await NodeFs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function firstExistingDirectory(
  candidates: ReadonlyArray<string>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function findFirstAppBundle(directory: string): Promise<string | undefined> {
  const entries = await NodeFs.readdir(directory, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  return appEntry ? NodePath.join(directory, appEntry.name) : undefined;
}

export async function resolveUnpackedAppRoot(
  outputDir: string,
  platform: BuildPlatform,
): Promise<string> {
  if (platform === "win") {
    const winRoot = await firstExistingDirectory([
      NodePath.join(outputDir, "win-unpacked"),
      NodePath.join(outputDir, "win-ia32-unpacked"),
    ]);
    if (winRoot) return winRoot;
  }

  if (platform === "linux") {
    const linuxRoot = await firstExistingDirectory([NodePath.join(outputDir, "linux-unpacked")]);
    if (linuxRoot) return linuxRoot;
  }

  if (platform === "mac") {
    const directApp = await findFirstAppBundle(outputDir);
    if (directApp) return directApp;
    const macDir = NodePath.join(outputDir, "mac");
    if (await isDirectory(macDir)) {
      const nestedApp = await findFirstAppBundle(macDir);
      if (nestedApp) return nestedApp;
    }
  }

  const entries = (await NodeFs.readdir(outputDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  const unpackedEntry = entries.find((entry) => entry.name.endsWith("-unpacked"));
  if (unpackedEntry) {
    return NodePath.join(outputDir, unpackedEntry.name);
  }

  throw new InstallDesktopBuildError(
    `No unpacked desktop app was found in ${outputDir}. Expected a 'dir' artifact such as win-unpacked or linux-unpacked.`,
  );
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new InstallDesktopBuildError(
          signal
            ? `Command was terminated by signal ${signal}: ${command}`
            : `Command failed with exit code ${code}: ${command}`,
        ),
      );
    });
  });
}

function buildArtifactArgs(options: InstallDesktopBuildOptions): string[] {
  const args = [
    "scripts/build-desktop-artifact.ts",
    "--target",
    "dir",
    "--output-dir",
    options.outputDir,
    "--platform",
    options.platform,
  ];
  if (options.arch) {
    args.push("--arch", options.arch);
  }
  if (options.buildVersion) {
    args.push("--build-version", options.buildVersion);
  }
  if (options.skipBuild) {
    args.push("--skip-build");
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  return args;
}

async function readGitValue(args: ReadonlyArray<string>): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve("unknown"));
    child.on("exit", (code) => {
      resolve(code === 0 ? output.trim() || "unknown" : "unknown");
    });
  });
}

async function writeInstallMetadata(
  installStageDir: string,
  sourceAppRoot: string,
  stateDir: string,
): Promise<void> {
  const [branch, commit] = await Promise.all([
    readGitValue(["branch", "--show-current"]),
    readGitValue(["rev-parse", "--short=12", "HEAD"]),
  ]);
  const metadata = {
    installedAt: new Date().toISOString(),
    branch,
    commit,
    sourceAppRoot,
    stateDir,
  };
  await NodeFs.writeFile(
    NodePath.join(installStageDir, METADATA_FILE_NAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function batchLiteral(value: string): string {
  return value.replaceAll("%", "%%");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeWindowsLocalLauncher(
  installStageDir: string,
  stateDir: string,
  executablePath: string,
): Promise<string> {
  const executableName = NodePath.basename(executablePath);
  const launcherPath = NodePath.join(installStageDir, WINDOWS_LOCAL_LAUNCHER_NAME);
  await NodeFs.writeFile(
    launcherPath,
    [
      "@echo off",
      "setlocal",
      `set "T3CODE_HOME=${batchLiteral(stateDir)}"`,
      'set "APPDATA=%T3CODE_HOME%\\appdata"',
      'if not exist "%APPDATA%" mkdir "%APPDATA%" >nul 2>nul',
      `start "" "%~dp0${batchLiteral(executableName)}" %*`,
      "",
    ].join("\r\n"),
  );
  return launcherPath;
}

async function writePosixLocalLauncher(
  installStageDir: string,
  stateDir: string,
  executablePath: string,
  platform: BuildPlatform,
): Promise<string> {
  const executableName = NodePath.basename(executablePath);
  const launcherPath = NodePath.join(installStageDir, POSIX_LOCAL_LAUNCHER_NAME);
  const envLines =
    platform === "linux"
      ? [
          `export T3CODE_HOME=${shellSingleQuote(stateDir)}`,
          `export XDG_CONFIG_HOME=${shellSingleQuote(NodePath.join(stateDir, "config"))}`,
          'mkdir -p "$XDG_CONFIG_HOME"',
        ]
      : [`export T3CODE_HOME=${shellSingleQuote(stateDir)}`];

  await NodeFs.writeFile(
    launcherPath,
    [
      "#!/bin/sh",
      "set -eu",
      ...envLines,
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$SCRIPT_DIR/${executableName}" "$@"`,
      "",
    ].join("\n"),
  );
  await NodeFs.chmod(launcherPath, 0o755);
  return launcherPath;
}

async function writeLocalLauncher(
  installStageDir: string,
  options: InstallDesktopBuildOptions,
): Promise<string | undefined> {
  const executablePath = await findLaunchTarget(installStageDir, options.platform);
  if (!executablePath || options.platform === "mac") {
    return undefined;
  }

  if (options.platform === "win") {
    return await writeWindowsLocalLauncher(installStageDir, options.stateDir, executablePath);
  }

  return await writePosixLocalLauncher(
    installStageDir,
    options.stateDir,
    executablePath,
    options.platform,
  );
}

async function replaceInstallDir(stagedDir: string, installDir: string): Promise<void> {
  const parentDir = NodePath.dirname(installDir);
  const backupDir = `${installDir}.previous`;
  await NodeFs.mkdir(parentDir, { recursive: true });
  await NodeFs.rm(backupDir, { recursive: true, force: true });

  let existingMoved = false;
  try {
    if (await pathExists(installDir)) {
      await NodeFs.rename(installDir, backupDir);
      existingMoved = true;
    }
    await NodeFs.rename(stagedDir, installDir);
    if (existingMoved) {
      await NodeFs.rm(backupDir, { recursive: true, force: true });
    }
  } catch (cause) {
    if (existingMoved && !(await pathExists(installDir)) && (await pathExists(backupDir))) {
      await NodeFs.rename(backupDir, installDir);
    }
    throw new InstallDesktopBuildError(
      `Failed to replace ${installDir}. Close any running T3 Code build from that directory and retry.`,
      { cause },
    );
  }
}

async function stageInstall(
  sourceAppRoot: string,
  options: InstallDesktopBuildOptions,
): Promise<string> {
  const installDir = options.installDir;
  const parentDir = NodePath.dirname(installDir);
  const stageDir = NodePath.join(
    parentDir,
    `.t3code-install-${NodePath.basename(installDir)}-${process.pid}-${Date.now()}`,
  );
  await NodeFs.rm(stageDir, { recursive: true, force: true });
  await NodeFs.cp(sourceAppRoot, stageDir, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  await writeLocalLauncher(stageDir, options);
  await writeInstallMetadata(stageDir, sourceAppRoot, options.stateDir);
  return stageDir;
}

async function findLaunchTarget(
  installDir: string,
  platform: BuildPlatform,
): Promise<string | undefined> {
  if (platform === "mac") {
    return installDir.endsWith(".app") ? installDir : undefined;
  }
  if (platform === "linux") {
    for (const candidate of ["t3code", "AppRun"]) {
      const candidatePath = NodePath.join(installDir, candidate);
      if (await pathExists(candidatePath)) return candidatePath;
    }
    return undefined;
  }

  const entries = await NodeFs.readdir(installDir, { withFileTypes: true });
  const executables = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => entry.name)
    .filter((name) => !name.toLowerCase().startsWith("uninstall"))
    .sort((a, b) => {
      const aPreferred = a.toLowerCase().includes("t3");
      const bPreferred = b.toLowerCase().includes("t3");
      if (aPreferred === bPreferred) return a.localeCompare(b);
      return aPreferred ? -1 : 1;
    });
  const executable = executables[0];
  return executable ? NodePath.join(installDir, executable) : undefined;
}

async function launchInstalledApp(installDir: string, platform: BuildPlatform): Promise<void> {
  const localLauncher =
    platform === "win"
      ? NodePath.join(installDir, WINDOWS_LOCAL_LAUNCHER_NAME)
      : NodePath.join(installDir, POSIX_LOCAL_LAUNCHER_NAME);
  const target = (await pathExists(localLauncher))
    ? localLauncher
    : await findLaunchTarget(installDir, platform);
  if (!target) {
    process.stderr.write(`[install-desktop] No launch target found in ${installDir}\n`);
    return;
  }

  const isWindowsLauncher = platform === "win" && target.endsWith(".cmd");
  const command = isWindowsLauncher ? "cmd.exe" : platform === "mac" ? "open" : target;
  const args = isWindowsLauncher
    ? ["/d", "/s", "/c", "start", "", target]
    : platform === "mac"
      ? [target]
      : [];
  const child = spawn(command, args, {
    cwd: installDir,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.unref();
}

export async function installDesktopBuild(options: InstallDesktopBuildOptions): Promise<void> {
  assertSafeInstallDir(options.installDir, {
    repoRoot: REPO_ROOT,
    outputDir: options.outputDir,
    homeDir: NodeOs.homedir(),
  });
  assertSafeStateDir(options.stateDir, {
    installDir: options.installDir,
    outputDir: options.outputDir,
  });

  process.stdout.write(
    `[install-desktop] Building unpacked desktop artifact into ${options.outputDir}\n`,
  );
  await runCommand(process.execPath, buildArtifactArgs(options), REPO_ROOT);

  const sourceAppRoot = await resolveUnpackedAppRoot(options.outputDir, options.platform);
  process.stdout.write(`[install-desktop] Installing ${sourceAppRoot} -> ${options.installDir}\n`);
  const stagedDir = await stageInstall(sourceAppRoot, options);
  await replaceInstallDir(stagedDir, options.installDir);

  process.stdout.write(`[install-desktop] Installed desktop build at ${options.installDir}\n`);
  process.stdout.write(`[install-desktop] Local state directory: ${options.stateDir}\n`);
  if (options.launch) {
    await launchInstalledApp(options.installDir, options.platform);
  }
}

if (import.meta.main) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
  } else {
    installDesktopBuild(parseInstallDesktopBuildArgs(cliArgs)).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
  }
}
