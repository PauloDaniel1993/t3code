// @effect-diagnostics nodeBuiltinImport:off - This runs before the Effect runtime so pinned Windows launches can load their install identity.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const INSTALL_METADATA_FILE_NAME = ".t3code-install.json";

interface WindowsInstallMetadata {
  readonly t3Home: string;
  readonly appDataDirectory: string;
  readonly displayName: string;
  readonly windowsAppUserModelId: string;
}

export interface ApplyWindowsInstalledDesktopBootstrapInput {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFileString?: (path: string) => string;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function decodeWindowsInstallMetadata(raw: string): WindowsInstallMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const t3Home = readNonEmptyString(record.t3Home);
  const appDataDirectory = readNonEmptyString(record.appDataDirectory);
  const displayName = readNonEmptyString(record.displayName);
  const windowsAppUserModelId = readNonEmptyString(record.windowsAppUserModelId);
  if (
    !t3Home ||
    !NodePath.win32.isAbsolute(t3Home) ||
    !appDataDirectory ||
    !NodePath.win32.isAbsolute(appDataDirectory) ||
    !displayName ||
    !windowsAppUserModelId
  ) {
    return undefined;
  }

  return { t3Home, appDataDirectory, displayName, windowsAppUserModelId };
}

function setDefaultEnvironmentValue(env: NodeJS.ProcessEnv, name: string, value: string): void {
  if (readNonEmptyString(env[name]) === undefined) {
    env[name] = value;
  }
}

/**
 * Taskbar pins created from a running Electron window target the executable
 * directly, bypassing the generated launcher script. Apply the adjacent
 * installer metadata before desktop layers resolve APPDATA, userData, and the
 * single-instance identity so those direct launches remain isolated.
 */
export function applyWindowsInstalledDesktopBootstrap(
  input: ApplyWindowsInstalledDesktopBootstrapInput,
): boolean {
  if (input.platform !== "win32") return false;

  const metadataPath = NodePath.win32.join(
    NodePath.win32.dirname(input.executablePath),
    INSTALL_METADATA_FILE_NAME,
  );
  let raw: string;
  try {
    raw = (input.readFileString ?? ((path) => NodeFS.readFileSync(path, "utf8")))(metadataPath);
  } catch {
    return false;
  }

  const metadata = decodeWindowsInstallMetadata(raw);
  if (!metadata) return false;

  // APPDATA is always populated on Windows, so a default-only write would never
  // isolate a direct executable launch from the official build's profile. Treat a
  // pre-existing T3CODE_HOME as the explicit-override signal instead: without it,
  // force APPDATA to the install's isolated directory.
  const hasExplicitHome = readNonEmptyString(input.env.T3CODE_HOME) !== undefined;
  setDefaultEnvironmentValue(input.env, "T3CODE_HOME", metadata.t3Home);
  if (hasExplicitHome) {
    setDefaultEnvironmentValue(input.env, "APPDATA", metadata.appDataDirectory);
  } else {
    input.env.APPDATA = metadata.appDataDirectory;
  }
  setDefaultEnvironmentValue(input.env, "T3CODE_DESKTOP_DISPLAY_NAME", metadata.displayName);
  setDefaultEnvironmentValue(
    input.env,
    "T3CODE_DESKTOP_APP_USER_MODEL_ID",
    metadata.windowsAppUserModelId,
  );
  setDefaultEnvironmentValue(input.env, "T3CODE_DISABLE_AUTO_UPDATE", "true");
  return true;
}
