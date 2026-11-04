// @effect-diagnostics nodeBuiltinImport:off -- Content addressing uses Node SHA-256.
import * as NodeCrypto from "node:crypto";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { deletePendingAttachment } from "../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
// @effect-diagnostics preferSchemaOverJson:off -- Stable pretty-printing and snapshot comparison preserve file formatting.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  FlowId,
  type FlowDefinitionEntry,
  FlowDefinition,
  FlowValidationError,
  type FlowValidationResult,
} from "@t3tools/contracts";
import {
  validateFlowDefinition,
  serializeFlowDefinition,
  flowDefinitionRevision,
  flowImageMimeType,
} from "@t3tools/shared/flow";
import { imageMimeType } from "@t3tools/shared/image";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  makeWayfinderFiles,
  resolveRealRoot,
  watchDirectory,
} from "../wayfinder/WayfinderFiles.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export class FlowDefinitionError extends Schema.TaggedError<FlowDefinitionError>()(
  "FlowDefinitionError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "io",
      "missing",
      "unsafe_path",
      "too_large",
      "invalid_schema",
      "destination_exists",
      "subscription_limit",
      "invalid_image",
    ]),
    errors: Schema.optional(Schema.Array(FlowValidationError)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static readonly is = Schema.is(FlowDefinitionError);

  override get message() {
    return `Flow file ${this.operation}${this.path ? ` "${this.path}"` : ""}: ${this.reason}.`;
  }
}

export class FlowDefinitions extends Context.Service<
  FlowDefinitions,
  {
    readonly importImage: (
      root: string,
      attachmentId: string,
    ) => Effect.Effect<string, FlowDefinitionError>;
    readonly readImage: (
      root: string,
      relativePath: string,
    ) => Effect.Effect<{ bytes: Uint8Array; mimeType: string }, FlowDefinitionError>;
    readonly list: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<typeof FlowDefinitionEntry.Type>, FlowDefinitionError>;
    readonly read: (
      root: string,
      id: FlowId,
    ) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowDefinitionError>;
    readonly validate: (definition: unknown) => Effect.Effect<FlowValidationResult>;
    readonly write: (
      root: string,
      id: FlowId,
      definition: FlowDefinition,
    ) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowDefinitionError>;
    readonly rename: (
      root: string,
      id: FlowId,
      newId: FlowId,
    ) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowDefinitionError>;
    readonly delete: (root: string, id: FlowId) => Effect.Effect<void, FlowDefinitionError>;
    readonly stream: (
      root: string,
      connection?: object,
    ) => Stream.Stream<ReadonlyArray<typeof FlowDefinitionEntry.Type>, FlowDefinitionError>;
  }
>()("t3/flows/FlowDefinitions") {}

export function isFlowFileChange(directory: string, event: "rename" | "change", name: string) {
  const normalized = name.toLowerCase();
  if (directory === "") return event === "rename" && normalized === ".t3code";
  if (directory === ".t3code") return event === "rename" && normalized === "flow";
  return (
    (event === "rename" && normalized === "flow") ||
    /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(normalized)
  );
}

const isDefinition = Schema.is(FlowDefinition);
const decodeId = Schema.decodeSync(FlowId);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const gate = yield* Semaphore.make(2);
  const connections = new WeakMap<object, number>();
  const watchGate = yield* Semaphore.make(1);
  const watched = new Map<
    string,
    {
      scope: Scope.Closeable;
      stream: Stream.Stream<ReadonlyArray<typeof FlowDefinitionEntry.Type>, FlowDefinitionError>;
      users: number;
    }
  >();
  const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        FlowDefinitionError.is(cause)
          ? cause
          : new FlowDefinitionError({ operation, reason: "io", cause }),
      ),
    );
  const validate = Effect.fn("FlowDefinitions.validate")(function* (definition: unknown) {
    const instances = yield* registry.listInstances;
    return validateFlowDefinition(definition, {
      knownProviderInstanceIds: new Set(instances.map((i) => i.instanceId)),
    });
  });
  const filesFor = Effect.fn("FlowDefinitions.files")(function* (root: string) {
    const real = yield* resolveRealRoot(root);
    return {
      real,
      files: yield* makeWayfinderFiles(real).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(WorkspacePaths.WorkspacePaths, paths),
      ),
    };
  });
  const filePath = (id: FlowId) => `.t3code/flow/${decodeId(id)}.json`;
  const read = Effect.fn("FlowDefinitions.read")(function* (root: string, id: FlowId) {
    return yield* wrap(
      "read",
      Effect.gen(function* () {
        const { files } = yield* filesFor(root);
        const file = yield* files.readBounded(filePath(id), 256 * 1024);
        if (!file) {
          const { real } = yield* filesFor(root);
          return yield* new FlowDefinitionError({
            operation: "read",
            reason: (yield* fs.exists(path.join(real, filePath(id)))) ? "unsafe_path" : "missing",
          });
        }
        const parsed = yield* decodeJson(file.contents).pipe(Effect.option);
        if (parsed._tag === "None" || file.truncated)
          return {
            flowId: id,
            revision: flowDefinitionRevision(file.contents),
            definition: null,
            validation: {
              valid: false,
              errors: [{ path: "$", message: "Invalid JSON or file exceeds 256 KiB" }],
            },
          };
        const value = parsed.value;
        const validation = yield* validate(value);
        return {
          flowId: id,
          revision: flowDefinitionRevision(value),
          definition: isDefinition(value) ? value : null,
          validation,
        };
      }),
    );
  });
  const list = Effect.fn("FlowDefinitions.list")(function* (root: string) {
    return yield* wrap(
      "list",
      gate.withPermits(1)(
        Effect.gen(function* () {
          const { files } = yield* filesFor(root);
          const listing = yield* files.listDirectory(".t3code/flow", 256);
          const ids = listing.entries
            .filter((name) => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name))
            .sort()
            .slice(0, 64);
          const entries = yield* Effect.forEach(
            ids,
            (name) =>
              read(root, FlowId.make(name.slice(0, -5))).pipe(
                Effect.catch((error) =>
                  Effect.succeed(
                    error.reason === "missing"
                      ? null
                      : {
                          flowId: FlowId.make(name.slice(0, -5)),
                          revision: flowDefinitionRevision(null),
                          definition: null,
                          validation: {
                            valid: false,
                            errors: [{ path: "$", message: error.message }],
                          },
                        },
                  ),
                ),
              ),
            {
              concurrency: 2,
            },
          );
          return entries.filter((entry) => entry !== null);
        }),
      ),
    );
  });
  const writable = Effect.fn("FlowDefinitions.writable")(function* (root: string, id: FlowId) {
    const { real, files } = yield* filesFor(root);
    for (const dir of [".t3code", ".t3code/flow"]) {
      if (!(yield* fs.exists(path.join(real, dir)))) yield* fs.makeDirectory(path.join(real, dir));
      if (!(yield* files.resolveDirectory(dir)))
        return yield* new FlowDefinitionError({
          operation: "write",
          reason: "unsafe_path",
        });
    }
    const target = path.join(real, filePath(id));
    if (yield* fs.exists(target)) {
      if (!(yield* files.isFile(filePath(id))))
        return yield* new FlowDefinitionError({ operation: "write", reason: "unsafe_path" });
    }
    return target;
  });
  const sourceStream = (root: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changed = yield* Queue.sliding<void>(1);
        const providerChanges = yield* registry.subscribeChanges;
        yield* Stream.fromSubscription(providerChanges).pipe(
          Stream.runForEach(() => Queue.offer(changed, undefined)),
          Effect.forkIn(yield* Scope.Scope),
        );
        let watcherScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
        const resolvedWatches = new Map<string, string>();
        const arm = Effect.fn("FlowDefinitions.armWatchers")(function* () {
          const { real, files } = yield* filesFor(root);
          const desired = new Map<string, string>();
          for (const dir of [".t3code/flow", ".t3code", ""]) {
            const resolved = dir === "" ? real : yield* files.resolveDirectory(dir);
            if (resolved) {
              desired.set(dir, resolved);
              if (dir === ".t3code/flow") {
                // Windows does not notify a directory watcher when that directory itself is renamed.
                const parent = yield* files.resolveDirectory(".t3code");
                if (parent) desired.set(".t3code", parent);
              }
              break;
            }
          }
          if (JSON.stringify([...desired]) === JSON.stringify([...resolvedWatches])) return;
          yield* Scope.close(watcherScope, Exit.void);
          watcherScope = yield* Scope.make();
          resolvedWatches.clear();
          for (const [dir, resolved] of desired) {
            resolvedWatches.set(dir, resolved);
            const closed = yield* watchDirectory(
              resolved,
              false,
              (event, name) => {
                if (isFlowFileChange(dir, event, name)) {
                  if (event === "rename" && name.toLowerCase() === "flow") resolvedWatches.clear();
                  Queue.offerUnsafe(changed, undefined);
                }
              },
              () => Queue.offerUnsafe(changed, undefined),
            ).pipe(Effect.provideService(Scope.Scope, watcherScope), Effect.option);
            if (closed._tag === "Some")
              yield* Deferred.await(closed.value).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    resolvedWatches.clear();
                    Queue.offerUnsafe(changed, undefined);
                  }),
                ),
                Effect.forkIn(watcherScope),
              );
          }
        });
        yield* wrap("watch", arm());
        const initial = yield* list(root);
        const updates = Stream.fromQueue(changed).pipe(
          Stream.debounce("100 millis"),
          Stream.mapEffect(() => wrap("watch", arm()).pipe(Effect.andThen(list(root)))),
        );
        return Stream.concat(Stream.make(initial), updates).pipe(
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        );
      }),
    );
  const readImage = Effect.fn("FlowDefinitions.readImage")(
    function* (root: string, relativePath: string) {
      const mimeType = flowImageMimeType(relativePath);
      if (!mimeType)
        return yield* new FlowDefinitionError({
          operation: "read image",
          path: relativePath,
          reason: "invalid_image",
        });
      const { real, files } = yield* filesFor(root);
      const file = yield* files.readBinaryBounded(relativePath, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
      if (!file)
        return yield* new FlowDefinitionError({
          operation: "read image",
          path: relativePath,
          reason: (yield* fs.exists(path.join(real, relativePath))) ? "unsafe_path" : "missing",
        });
      if (file.truncated)
        return yield* new FlowDefinitionError({
          operation: "read image",
          path: relativePath,
          reason: "too_large",
        });
      return { bytes: file.bytes, mimeType };
    },
    (effect, _root, relativePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          FlowDefinitionError.is(cause)
            ? cause
            : new FlowDefinitionError({
                operation: "read image",
                path: relativePath,
                reason: "io",
                cause,
              }),
        ),
      ),
  );
  return FlowDefinitions.of({
    readImage,
    importImage: Effect.fn("FlowDefinitions.importImage")(function* (root, attachmentId) {
      return yield* wrap(
        "import image",
        Effect.gen(function* () {
          const source =
            parseThreadSegmentFromAttachmentId(attachmentId) === "pending" &&
            !parseAttachmentFileExtension(attachmentId)
              ? resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId })
              : null;
          const mimeType = source ? imageMimeType({ name: source, mimeType: "" }) : null;
          if (!source || !mimeType)
            return yield* new FlowDefinitionError({
              operation: "import image",
              reason: "invalid_image",
            });
          if (Number((yield* fs.stat(source)).size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
            return yield* new FlowDefinitionError({
              operation: "import image",
              reason: "too_large",
            });
          const bytes = yield* fs.readFile(source);
          const extension = mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.slice(6)}`;
          const relativePath = `.t3code/flow/images/${NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}${extension}`;
          const { real, files } = yield* filesFor(root);
          for (const directory of [".t3code", ".t3code/flow", ".t3code/flow/images"]) {
            const destination = path.join(real, directory);
            if (!(yield* fs.exists(destination)))
              yield* fs.makeDirectory(destination).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.void,
                ),
              );
            if (!(yield* files.resolveDirectory(directory)))
              return yield* new FlowDefinitionError({
                operation: "import image",
                reason: "unsafe_path",
              });
          }
          const target = path.join(real, relativePath);
          const exists = yield* fs.exists(target);
          if (exists && !(yield* files.isFile(relativePath)))
            return yield* new FlowDefinitionError({
              operation: "import image",
              reason: "unsafe_path",
            });
          // Names are content hashes, so an existing file, or one a concurrent import just
          // renamed into place (Windows then refuses our rename), already holds these bytes.
          if (!exists) {
            const temp = path.join(path.dirname(target), `.image-${yield* random.uuidV4()}.tmp`);
            yield* fs
              .writeFile(temp, bytes, { flag: "wx" })
              .pipe(
                Effect.andThen(
                  fs
                    .rename(temp, target)
                    .pipe(
                      Effect.catch((error) =>
                        fs
                          .exists(target)
                          .pipe(
                            Effect.flatMap((published) =>
                              published ? Effect.void : Effect.fail(error),
                            ),
                          ),
                      ),
                    ),
                ),
                Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
              );
          }
          yield* deletePendingAttachment(attachmentId).pipe(
            Effect.provideService(ServerConfig.ServerConfig, config),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          return relativePath;
        }),
      );
    }),
    validate,
    read,
    list,
    write: Effect.fn("FlowDefinitions.write")(function* (root, id, definition) {
      const validation = yield* validate(definition);
      if (!isDefinition(definition))
        return yield* new FlowDefinitionError({
          operation: "write",
          reason: "invalid_schema",
          errors: validation.errors,
        });
      return yield* wrap(
        "write",
        Effect.gen(function* () {
          const target = yield* writable(root, id);
          const text = serializeFlowDefinition(definition);
          if (new TextEncoder().encode(text).length > 256 * 1024)
            return yield* new FlowDefinitionError({ operation: "write", reason: "too_large" });
          const temp = path.join(path.dirname(target), `.flow-${yield* random.uuidV4()}.tmp`);
          yield* fs
            .writeFileString(temp, text, { flag: "wx" })
            .pipe(
              Effect.andThen(fs.rename(temp, target)),
              Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
            );
          return yield* read(root, id);
        }),
      );
    }),
    rename: Effect.fn("FlowDefinitions.rename")(function* (root, id, newId) {
      return yield* wrap(
        "rename",
        Effect.gen(function* () {
          const { real, files } = yield* filesFor(root);
          if (!(yield* files.isFile(filePath(id))))
            return yield* new FlowDefinitionError({ operation: "rename", reason: "missing" });
          const source = path.join(real, filePath(id));
          const target = yield* writable(root, newId);
          if (source === target) return yield* read(root, id);
          yield* fs.link(source, target).pipe(
            Effect.mapError(
              (cause) =>
                new FlowDefinitionError({
                  operation: "rename",
                  reason: "destination_exists",
                  cause,
                }),
            ),
          );
          yield* fs
            .remove(source)
            .pipe(Effect.onError(() => fs.remove(target).pipe(Effect.ignore)));
          return yield* read(root, newId);
        }),
      );
    }),
    delete: Effect.fn("FlowDefinitions.delete")(function* (root, id) {
      yield* wrap(
        "delete",
        Effect.gen(function* () {
          const { real, files } = yield* filesFor(root);
          if (!(yield* files.isFile(filePath(id))))
            return yield* new FlowDefinitionError({ operation: "delete", reason: "missing" });
          yield* fs.remove(path.join(real, filePath(id)));
        }),
      );
    }),
    stream: (root, connection = {}) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscriptions = connections.get(connection) ?? 0;
          if (subscriptions >= 16)
            return yield* new FlowDefinitionError({
              operation: "watch",
              reason: "subscription_limit",
            });
          connections.set(connection, subscriptions + 1);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const count = (connections.get(connection) ?? 1) - 1;
              if (count === 0) connections.delete(connection);
              else connections.set(connection, count);
            }),
          );
          const real = yield* wrap("watch", resolveRealRoot(root));
          const entry = yield* watchGate.withPermits(1)(
            Effect.gen(function* () {
              let entry = watched.get(real);
              if (!entry) {
                const scope = yield* Scope.make();
                const stream = yield* Stream.share(sourceStream(real), {
                  capacity: 1,
                  strategy: "sliding",
                  replay: 1,
                }).pipe(Effect.provideService(Scope.Scope, scope));
                entry = { scope, stream, users: 0 };
                watched.set(real, entry);
              }
              entry.users++;
              return entry;
            }),
          );
          yield* Effect.addFinalizer(() =>
            watchGate.withPermits(1)(
              Effect.gen(function* () {
                entry.users--;
                if (entry.users === 0) {
                  watched.delete(real);
                  yield* Scope.close(entry.scope, Exit.void);
                }
              }),
            ),
          );
          return entry.stream;
        }),
      ),
  });
});

export const layer = Layer.effect(FlowDefinitions, make);
