import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ClientSettingsDocumentSchema = Schema.Struct({
  settings: ClientSettingsSchema,
});

const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const LegacyClientSettingsDocumentJson = fromLenientJson(ClientSettingsDocumentSchema);
const UnknownJson = fromLenientJson(Schema.Unknown);
const decodeLegacyClientSettingsDocumentJson = Schema.decodeEffect(
  LegacyClientSettingsDocumentJson,
);
const decodeClientSettingsJsonValue = Schema.decodeEffect(ClientSettingsJson);
const decodeUnknownJson = Schema.decodeEffect(UnknownJson);
const decodeClientSettingsJson = (raw: string): Effect.Effect<ClientSettings, Schema.SchemaError> =>
  decodeLegacyClientSettingsDocumentJson(raw).pipe(
    Effect.map((document) => document.settings),
    Effect.catchTags({
      SchemaError: () => decodeClientSettingsJsonValue(raw),
    }),
  );
const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);

export interface DesktopClientSettingsSnapshot {
  readonly settings: ClientSettings;
  readonly appearanceWasPersisted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawAppearanceWasPersisted(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const settingsValue = isRecord(value.settings) ? value.settings : value;
  return Object.hasOwn(settingsValue, "appearance");
}

const decodeClientSettingsJsonWithMeta = (
  raw: string,
): Effect.Effect<DesktopClientSettingsSnapshot, Schema.SchemaError> =>
  decodeClientSettingsJson(raw).pipe(
    Effect.flatMap((settings) =>
      decodeUnknownJson(raw).pipe(
        Effect.map((rawValue) => ({
          settings,
          appearanceWasPersisted: rawAppearanceWasPersisted(rawValue),
        })),
      ),
    ),
  );

const DesktopClientSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);

export class DesktopClientSettingsWriteError extends Schema.TaggedErrorClass<DesktopClientSettingsWriteError>()(
  "DesktopClientSettingsWriteError",
  {
    operation: DesktopClientSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>>;
    readonly getWithMeta: Effect.Effect<Option.Option<DesktopClientSettingsSnapshot>>;
    readonly set: (
      settings: ClientSettings,
    ) => Effect.Effect<void, DesktopClientSettingsWriteError>;
  }
>()("@t3tools/desktop/settings/DesktopClientSettings") {}

const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<DesktopClientSettingsSnapshot>> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Could not read desktop client settings.", cause).pipe(
              Effect.annotateLogs({ settingsPath }),
              Effect.as(Option.none<string>()),
            ),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<DesktopClientSettingsSnapshot>()),
        onSome: (raw) =>
          decodeClientSettingsJsonWithMeta(raw).pipe(
            Effect.map((snapshot) => Option.some(snapshot)),
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.logWarning("Could not decode desktop client settings.", cause).pipe(
                  Effect.annotateLogs({ settingsPath }),
                  Effect.as(Option.none<DesktopClientSettingsSnapshot>()),
                ),
            }),
          ),
      }),
    ),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: ClientSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopClientSettingsWriteError> {
  const directory = input.path.dirname(input.settingsPath);
  const tempPath = `${input.settingsPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeClientSettingsJson(input.settings).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const getWithMeta = readClientSettings(fileSystem, environment.clientSettingsPath);

  return DesktopClientSettings.of({
    get: getWithMeta.pipe(
      Effect.map(Option.map((snapshot) => snapshot.settings)),
      Effect.withSpan("desktop.clientSettings.get"),
    ),
    getWithMeta: getWithMeta.pipe(Effect.withSpan("desktop.clientSettings.getWithMeta")),
    set: (settings) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => uuid.replace(/-/g, "")),
        Effect.mapError(
          (cause) =>
            new DesktopClientSettingsWriteError({
              operation: "create-temporary-file-name",
              path: environment.clientSettingsPath,
              cause,
            }),
        ),
        Effect.flatMap((suffix) =>
          writeClientSettings({
            fileSystem,
            path,
            settingsPath: environment.clientSettingsPath,
            settings,
            suffix,
          }),
        ),
        Effect.withSpan("desktop.clientSettings.set"),
      ),
  });
});

export const layer = Layer.effect(DesktopClientSettings, make);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        getWithMeta: Ref.get(settingsRef).pipe(
          Effect.map(Option.map((settings) => ({ settings, appearanceWasPersisted: true }))),
        ),
        set: (settings) => Ref.set(settingsRef, Option.some(settings)),
      });
    }),
  );
