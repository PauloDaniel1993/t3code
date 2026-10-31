// @effect-diagnostics preferSchemaOverJson:off -- Stable pretty-printing and snapshot comparison preserve file formatting.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  type FlowDefinition,
  type FlowValidationResult,
} from "@t3tools/contracts";
import { validateFlowDefinition } from "@t3tools/shared/flow";
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
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Flow file operation failed: ${this.operation}.`;
  }
}

export class FlowDefinitions extends Context.Service<
  FlowDefinitions,
  {
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
    ) => Stream.Stream<ReadonlyArray<typeof FlowDefinitionEntry.Type>, FlowDefinitionError>;
  }
>()("t3/flows/FlowDefinitions") {}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}

const decodeId = Schema.decodeSync(FlowId);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const gate = yield* Semaphore.make(2);
  let subscriptions = 0;
  const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new FlowDefinitionError({ operation, cause })));
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
        if (!file)
          return yield* new FlowDefinitionError({ operation: "missing file", cause: null });
        const parsed = yield* decodeJson(file.contents).pipe(Effect.option);
        if (parsed._tag === "None" || file.truncated)
          return {
            flowId: id,
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
          definition: validation.valid ? (value as FlowDefinition) : null,
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
          return yield* Effect.forEach(ids, (name) => read(root, FlowId.make(name.slice(0, -5))), {
            concurrency: 2,
          });
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
          operation: "directory outside project",
          cause: null,
        });
    }
    const target = path.join(real, filePath(id));
    if (yield* fs.exists(target)) {
      if (!(yield* files.isFile(filePath(id))))
        return yield* new FlowDefinitionError({ operation: "unsafe file", cause: null });
    }
    return target;
  });
  return FlowDefinitions.of({
    validate,
    read,
    list,
    write: Effect.fn("FlowDefinitions.write")(function* (root, id, definition) {
      const validation = yield* validate(definition);
      if (!validation.valid)
        return yield* new FlowDefinitionError({
          operation: "validation",
          cause: validation.errors,
        });
      return yield* wrap(
        "write",
        Effect.gen(function* () {
          const target = yield* writable(root, id);
          const text = `${JSON.stringify(stable(definition), null, 2)}\n`;
          if (new TextEncoder().encode(text).length > 256 * 1024)
            return yield* new FlowDefinitionError({ operation: "file size", cause: null });
          const temp = yield* fs.makeTempFile({
            directory: path.dirname(target),
            prefix: ".flow-",
          });
          yield* fs
            .writeFileString(temp, text)
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
          const source = yield* writable(root, id);
          const target = yield* writable(root, newId);
          if (source === target) return yield* read(root, id);
          if (yield* fs.exists(target))
            return yield* new FlowDefinitionError({ operation: "destination exists", cause: null });
          yield* fs.rename(source, target);
          return yield* read(root, newId);
        }),
      );
    }),
    delete: Effect.fn("FlowDefinitions.delete")(function* (root, id) {
      yield* wrap(
        "delete",
        Effect.flatMap(writable(root, id), (target) => fs.remove(target)),
      );
    }),
    stream: (root) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (subscriptions >= 16)
            return yield* new FlowDefinitionError({ operation: "subscription limit", cause: null });
          subscriptions++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subscriptions--;
            }),
          );
          const changed = yield* Queue.sliding<void>(1);
          const providerChanges = yield* registry.subscribeChanges;
          yield* Stream.fromSubscription(providerChanges).pipe(
            Stream.runForEach(() => Queue.offer(changed, undefined)),
            Effect.forkIn(yield* Scope.Scope),
          );
          let watcherScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
          const arm = Effect.fn("FlowDefinitions.armWatchers")(function* () {
            yield* Scope.close(watcherScope, Exit.void);
            watcherScope = yield* Scope.make();
            const { real, files } = yield* filesFor(root);
            for (const dir of ["", ".t3code", ".t3code/flow"]) {
              const resolved = dir === "" ? real : yield* files.resolveDirectory(dir);
              if (resolved)
                yield* watchDirectory(
                  resolved,
                  false,
                  () => Queue.offerUnsafe(changed, undefined),
                  () => Queue.offerUnsafe(changed, undefined),
                ).pipe(Effect.provideService(Scope.Scope, watcherScope), Effect.ignore);
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
      ),
  });
});

export const layer = Layer.effect(FlowDefinitions, make);
