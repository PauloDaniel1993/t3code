// @effect-diagnostics nodeBuiltinImport:off - Installed identity must resolve synchronously before Clerk acquires the profile lock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import {
  LOCAL_DESKTOP_IDENTITY,
  LOCAL_DESKTOP_BOOTSTRAP_VERSION,
} from "../../../../scripts/lib/local-desktop-identity.ts";

const PackageIdentity = Schema.Struct({ name: Schema.String });
const InstallMetadata = Schema.Struct({
  t3Home: Schema.String,
  displayName: Schema.Literal(LOCAL_DESKTOP_IDENTITY.productName),
  windowsAppUserModelId: Schema.Literal(LOCAL_DESKTOP_IDENTITY.appId),
});
const decodePackage = Schema.decodeUnknownSync(Schema.fromJsonString(PackageIdentity));
const decodeMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(InstallMetadata));

export interface ApplyInstalledDesktopBootstrapInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFileString?: (path: string) => string;
}

/** Direct executable and taskbar launches use the same identity as the launcher. */
export function applyInstalledDesktopBootstrap(
  input: ApplyInstalledDesktopBootstrapInput,
): boolean {
  if (!input.isPackaged) return false;
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const read = input.readFileString ?? ((filePath) => NodeFS.readFileSync(filePath, "utf8"));
  const appPackage = decodePackage(read(path.join(input.appPath, "package.json")));
  if (appPackage.name !== LOCAL_DESKTOP_IDENTITY.packageName) return false;

  let t3Home = path.join(input.homeDirectory, LOCAL_DESKTOP_IDENTITY.homeName);
  if (input.platform === "win32") {
    let raw: string | undefined;
    try {
      raw = read(
        path.join(path.dirname(input.executablePath), LOCAL_DESKTOP_IDENTITY.metadataFileName),
      );
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
    if (raw !== undefined) t3Home = decodeMetadata(raw).t3Home;
  }
  if (!path.isAbsolute(t3Home)) throw new Error("The local desktop home must be absolute.");
  t3Home = path.resolve(t3Home);
  for (const name of [".t3", ".t3.local"]) {
    const protectedHome = path.join(input.homeDirectory, name);
    const relative = path.relative(protectedHome, t3Home);
    const reverse = path.relative(t3Home, protectedHome);
    const within = (value: string) =>
      value === "" ||
      (value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
    if (within(relative) || within(reverse)) {
      throw new Error(`The local desktop home overlaps ${protectedHome}.`);
    }
  }

  // A desktop can inherit alpha.local's environment when launched from its terminal.
  // Install identity wins over ambient overrides so that cannot select a live home.
  input.env.T3CODE_HOME = t3Home;
  input.env.T3CODE_LOCAL_BOOTSTRAP_VERSION = LOCAL_DESKTOP_BOOTSTRAP_VERSION;
  input.env.T3CODE_DESKTOP_LOCAL_IDENTITY = "true";
  input.env.T3CODE_DESKTOP_DISPLAY_NAME = LOCAL_DESKTOP_IDENTITY.productName;
  input.env.T3CODE_DESKTOP_APP_USER_MODEL_ID = LOCAL_DESKTOP_IDENTITY.appId;
  input.env.T3CODE_DISABLE_AUTO_UPDATE = "true";
  delete input.env.VITE_DEV_SERVER_URL;
  if (input.platform === "win32") input.env.APPDATA = path.join(t3Home, "appdata");
  if (input.platform === "linux") input.env.XDG_CONFIG_HOME = path.join(t3Home, "appdata");
  return true;
}
