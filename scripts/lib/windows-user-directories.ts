// @effect-diagnostics nodeBuiltinImport:off - Windows known folders must ignore an enclosing desktop's redirected environment.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

const WindowsUserDirectories = Schema.Struct({
  home: Schema.NonEmptyString,
  appData: Schema.NonEmptyString,
  localAppData: Schema.NonEmptyString,
  programs: Schema.NonEmptyString,
});
const decodeDirectories = Schema.decodeSync(Schema.fromJsonString(WindowsUserDirectories));

/** Read-only OS lookup; never infer user folders from inherited APPDATA or USERPROFILE. */
export function readWindowsUserDirectories(env: NodeJS.ProcessEnv = process.env) {
  // Unlike homedir(), userInfo().homedir comes from the OS profile API. Start
  // PowerShell with that profile: some known folders expand USERPROFILE before
  // the first script statement, so repairing it inside the script is too late.
  const osHome = NodeOS.userInfo().homedir;
  const lookupEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !["USERPROFILE", "HOME"].includes(name.toUpperCase())),
  );
  const raw = NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@{ home = [Environment]::GetFolderPath('UserProfile'); appData = [Environment]::GetFolderPath('ApplicationData'); localAppData = [Environment]::GetFolderPath('LocalApplicationData'); programs = [Environment]::GetFolderPath('Programs') } | ConvertTo-Json -Compress",
    ],
    {
      env: { ...lookupEnv, USERPROFILE: osHome, HOME: osHome },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return decodeDirectories(raw.trim());
}

let directories: ReturnType<typeof readWindowsUserDirectories> | undefined;

export const getWindowsUserDirectories = () => (directories ??= readWindowsUserDirectories());

/** A build or backend child gets Windows' user folders, even inside another install's shell. */
export function restoreWindowsUserDirectories(
  env: NodeJS.ProcessEnv,
  folders: Pick<
    ReturnType<typeof readWindowsUserDirectories>,
    "home" | "appData" | "localAppData"
  > = getWindowsUserDirectories(),
) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([name]) =>
          !["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"].includes(
            name.toUpperCase(),
          ),
      ),
    ),
    APPDATA: folders.appData,
    LOCALAPPDATA: folders.localAppData,
    USERPROFILE: folders.home,
    HOME: folders.home,
    TEMP: NodePath.win32.join(folders.localAppData, "Temp"),
    TMP: NodePath.win32.join(folders.localAppData, "Temp"),
  };
}
