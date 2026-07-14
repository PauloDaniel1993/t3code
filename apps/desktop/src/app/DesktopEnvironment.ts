import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export const LOCAL_INSTALL_METADATA_FILE_NAME = ".t3code-install.json";

export interface DesktopLocalInstallMetadata {
  readonly t3Home: Option.Option<string>;
  readonly appDataDirectory: Option.Option<string>;
  readonly displayName: Option.Option<string>;
  readonly windowsAppUserModelId: Option.Option<string>;
}

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly executablePath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
  readonly localInstallMetadata: Option.Option<DesktopLocalInstallMetadata>;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly desktopSettingsPath: string;
    readonly clientSettingsPath: string;
    readonly savedEnvironmentRegistryPath: string;
    readonly serverSettingsPath: string;
    readonly logDir: string;
    readonly browserArtifactsDir: string;
    readonly rootDir: string;
    readonly appRoot: string;
    readonly backendEntryPath: string;
    readonly backendCwd: string;
    readonly preloadPath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly devRemoteT3ServerEntryPath: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly commitHashOverride: Option.Option<string>;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly linuxDesktopEntryName: string;
    readonly linuxWmClass: string;
    readonly userDataDirName: string;
    readonly legacyUserDataDirName: string;
    readonly defaultDesktopSettings: DesktopAppSettings.DesktopSettings;
    readonly runtimeInfo: DesktopRuntimeInfo;
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
    readonly developmentDockIconPath: string;
  }
>()("@t3tools/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "T3 Code";

const LocalInstallMetadataDocument = Schema.Struct({
  t3Home: Schema.optionalKey(Schema.String),
  stateDir: Schema.optionalKey(Schema.String),
  appDataDirectory: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  windowsAppUserModelId: Schema.optionalKey(Schema.String),
});

type LocalInstallMetadataDocument = typeof LocalInstallMetadataDocument.Type;

const LocalInstallMetadataJson = Schema.fromJsonString(LocalInstallMetadataDocument);
const decodeLocalInstallMetadataJson = Schema.decodeEffect(LocalInstallMetadataJson);

const trimNonEmptyOption = (value: string | undefined): Option.Option<string> => {
  if (value === undefined) {
    return Option.none();
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

function normalizeLocalInstallMetadata(
  metadata: LocalInstallMetadataDocument,
): DesktopLocalInstallMetadata {
  return {
    t3Home: Option.orElse(trimNonEmptyOption(metadata.t3Home), () =>
      trimNonEmptyOption(metadata.stateDir),
    ),
    appDataDirectory: trimNonEmptyOption(metadata.appDataDirectory),
    displayName: trimNonEmptyOption(metadata.displayName),
    windowsAppUserModelId: trimNonEmptyOption(metadata.windowsAppUserModelId),
  };
}

export const readLocalInstallMetadata = (
  executablePath: string,
): Effect.Effect<
  Option.Option<DesktopLocalInstallMetadata>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const metadataPath = path.join(path.dirname(executablePath), LOCAL_INSTALL_METADATA_FILE_NAME);
    const raw = yield* fileSystem.readFileString(metadataPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<DesktopLocalInstallMetadata>()),
      onSome: (value) =>
        decodeLocalInstallMetadataJson(value).pipe(
          Effect.map((metadata) => Option.some(normalizeLocalInstallMetadata(metadata))),
          Effect.orElseSucceed(() => Option.none<DesktopLocalInstallMetadata>()),
        ),
    });
  });

function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<DesktopEnvironment["Service"], Config.ConfigError, Path.Path> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const localInstallMetadata = input.localInstallMetadata;
  const localT3Home = Option.flatMap(localInstallMetadata, (metadata) => metadata.t3Home);
  const localAppDataDirectory = Option.flatMap(localInstallMetadata, (metadata) =>
    Option.orElse(metadata.appDataDirectory, () =>
      Option.map(metadata.t3Home, (t3Home) => path.join(t3Home, "appdata")),
    ),
  );
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(localAppDataDirectory, () =>
          Option.getOrElse(config.appDataDirectory, () =>
            path.join(homeDirectory, "AppData", "Roaming"),
          ),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const baseDir = Option.getOrElse(config.t3Home, () =>
    Option.getOrElse(localT3Home, () => path.join(homeDirectory, ".t3")),
  );
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const defaultBranding = resolveDesktopAppBranding({
    isDevelopment,
    appVersion: input.appVersion,
  });
  const localDisplayName = Option.flatMap(localInstallMetadata, (metadata) => metadata.displayName);
  const displayName = Option.getOrElse(config.displayNameOverride, () =>
    Option.getOrElse(localDisplayName, () => defaultBranding.displayName),
  );
  const branding: DesktopAppBranding = {
    ...defaultBranding,
    displayName,
  };
  const stateDir = path.join(baseDir, isDevelopment ? "dev" : "userdata");
  const userDataDirName = isDevelopment ? "t3code-dev" : "t3code";
  const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
  const resourcesPath = input.resourcesPath;

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath,
    homeDirectory,
    appDataDirectory,
    baseDir,
    stateDir,
    desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
    clientSettingsPath: path.join(stateDir, "client-settings.json"),
    savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
    serverSettingsPath: path.join(stateDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
    rootDir,
    appRoot,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    backendCwd: input.isPackaged ? homeDirectory : appRoot,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    branding,
    displayName,
    appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
      Option.getOrElse(
        Option.flatMap(localInstallMetadata, (metadata) => metadata.windowsAppUserModelId),
        () => (isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code"),
      ),
    ),
    linuxDesktopEntryName: isDevelopment ? "t3code-dev.desktop" : "t3code.desktop",
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    userDataDirName,
    legacyUserDataDirName,
    defaultDesktopSettings: DesktopAppSettings.resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
    developmentDockIconPath: path.join(rootDir, "assets", "dev", "blueprint-macos-1024.png"),
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
