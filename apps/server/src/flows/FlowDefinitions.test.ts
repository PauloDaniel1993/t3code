import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FlowId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
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
      yield* fs.writeFileString(path.join(root, ".t3code/flow/broken.json"), "{broken");
      expect((yield* flows.list(root)).map((f) => [f.flowId, f.validation.valid])).toEqual([
        ["broken", false],
        ["test", true],
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
