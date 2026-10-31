import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FlowId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FlowDefinitions from "./FlowDefinitions.ts";

const registry = Layer.effect(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    return {
      listInstances: Effect.succeed([]),
      getInstance: () => Effect.sync(() => undefined),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: PubSub.subscribe(changes),
    };
  }),
);
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  registry,
  WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
);
const testLayer = FlowDefinitions.layer.pipe(Layer.provideMerge(dependencies));

it.effect(
  "round trips stable files, lists invalid definitions, validates providers, renames and deletes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-files-" });
      const flows = yield* FlowDefinitions.FlowDefinitions;
      expect(yield* flows.list(root)).toEqual([]);
      const id = FlowId.make("test");
      const definition = {
        version: 1 as const,
        title: "Flow",
        steps: [{ id: "a", kind: "agent" as const, prompt: "Work" }],
        edges: [],
      };
      expect((yield* flows.write(root, id, definition)).definition).toEqual(definition);
      for (let i = 0; i < 300; i++) yield* flows.write(root, id, definition);
      expect(yield* fs.readDirectory(path.join(root, ".t3code/flow"))).toEqual(["test.json"]);
      const invalid = { ...definition, edges: [{ from: "a", to: "a" }] };
      expect((yield* flows.write(root, FlowId.make("invalid"), invalid)).validation.valid).toBe(
        false,
      );
      expect((yield* flows.read(root, FlowId.make("invalid"))).definition).toEqual(invalid);
      yield* flows.delete(root, FlowId.make("invalid"));
      const first = yield* fs.readFileString(path.join(root, ".t3code/flow/test.json"));
      yield* flows.write(root, id, {
        edges: [],
        steps: definition.steps,
        title: "Flow",
        version: 1,
      });
      expect(yield* fs.readFileString(path.join(root, ".t3code/flow/test.json"))).toBe(first);
      expect(
        (yield* flows.validate({
          ...definition,
          defaults: { model: { providerInstanceId: "missing", model: "x" } },
        })).valid,
      ).toBe(false);
      const unavailable = {
        ...definition,
        defaults: { model: { providerInstanceId: "missing", model: "x" } },
      };
      const savedUnavailable = yield* flows.write(root, FlowId.make("unavailable"), unavailable);
      expect(savedUnavailable.definition).toEqual(unavailable);
      expect(savedUnavailable.validation.valid).toBe(false);
      yield* flows.delete(root, FlowId.make("unavailable"));
      yield* fs.writeFileString(path.join(root, ".t3code/flow/broken.json"), "{broken");
      yield* fs.makeDirectory(path.join(root, ".t3code/flow/unreadable.json"));
      expect((yield* flows.list(root)).map((f) => [f.flowId, f.validation.valid])).toEqual([
        ["broken", false],
        ["test", true],
        ["unreadable", false],
      ]);
      expect((yield* flows.rename(root, id, FlowId.make("renamed"))).flowId).toBe("renamed");
      expect(yield* fs.exists(path.join(root, ".t3code/flow/test.json"))).toBe(false);
      yield* flows.write(root, id, definition);
      expect((yield* flows.rename(root, id, FlowId.make("renamed")).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      yield* flows.delete(root, id);
      expect(yield* fs.exists(path.join(root, ".t3code/flow/test.json"))).toBe(false);
      const firstSnapshot = yield* flows.stream(root).pipe(Stream.runHead);
      expect(firstSnapshot._tag).toBe("Some");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("cleans a sibling temp file if replacement fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-failed-save-" });
    const brokenFs = { ...fs, rename: () => Effect.die(new Error("replacement failed")) };
    yield* Effect.gen(function* () {
      const flows = yield* FlowDefinitions.FlowDefinitions;
      const result = yield* flows
        .write(root, FlowId.make("test"), { version: 1, title: "Test", steps: [], edges: [] })
        .pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readDirectory(path.join(root, ".t3code/flow"))).toEqual([]);
      yield* flows.delete(root, FlowId.make("missing")).pipe(Effect.exit);
    }).pipe(
      Effect.provide(
        FlowDefinitions.layer.pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, brokenFs)),
          Layer.provide(dependencies),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shares a project scan across subscribers and releases it when both leave", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-shared-watch-" });
    const current = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    let subscriptions = 0;
    yield* Effect.gen(function* () {
      const flows = yield* FlowDefinitions.FlowDefinitions;
      const firstReady = yield* Deferred.make<void>();
      const secondReady = yield* Deferred.make<void>();
      const first = yield* flows.stream(root).pipe(
        Stream.runForEach(() =>
          Deferred.succeed(firstReady, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(firstReady);
      const second = yield* flows.stream(root).pipe(
        Stream.runForEach(() =>
          Deferred.succeed(secondReady, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(secondReady);
      expect(subscriptions).toBe(1);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
      expect((yield* flows.stream(root).pipe(Stream.runHead))._tag).toBe("Some");
      expect(subscriptions).toBe(2);
    }).pipe(
      Effect.provide(
        FlowDefinitions.layer.pipe(
          Layer.provide(
            Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
              ...current,
              subscribeChanges: Effect.sync(() => {
                subscriptions++;
              }).pipe(Effect.andThen(current.subscribeChanges)),
            }),
          ),
          Layer.provide(dependencies),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.each([
  ["", "change", ".git", false],
  ["", "change", ".t3code", false],
  ["", "rename", ".t3code", true],
  [".t3code", "rename", "flow", true],
  [".t3code", "change", "other", false],
  [".t3code/flow", "rename", "test.json", true],
  [".t3code/flow", "change", ".flow-temp.tmp", false],
] as const)("filters watch events %s %s %s", (directory, event, name, expected) => {
  expect(FlowDefinitions.isFlowFileChange(directory, event, name)).toBe(expected);
});
