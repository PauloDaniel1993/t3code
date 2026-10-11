import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createWayfinderEnvironmentAtoms } from "./wayfinder.ts";

describe("Wayfinder subscription lifecycle", () => {
  it.effect("releases each folder subscription on unmount before opening the next", () =>
    Effect.gen(function* () {
      const opened = yield* Queue.unbounded<number>();
      const closed = yield* Queue.unbounded<void>();
      let active = 0;
      const stream = Stream.fromEffect(Effect.sync(() => ++active)).pipe(
        Stream.tap((count) => Queue.offer(opened, count)),
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.gen(function* () {
            active--;
            yield* Queue.offer(closed, undefined);
          }),
        ),
      );
      const environment = EnvironmentRegistry.of({
        followStream: () => stream,
      } as unknown as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environment));
      const maps = createWayfinderEnvironmentAtoms(runtime).maps;
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

      // More roots than the server's 16-map limit, without retaining any previous root.
      for (let index = 0; index < 17; index++) {
        const unmount = registry.mount(
          maps({ environmentId: EnvironmentId.make("remote"), input: { cwd: `/folder-${index}` } }),
        );
        expect(yield* Queue.take(opened)).toBe(1);
        unmount();
        yield* Queue.take(closed);
        expect(active).toBe(0);
      }
    }),
  );
});
