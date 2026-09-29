// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

it.effect("keeps a healthy runtime alive with more than 512 unread text/lifecycle events", () =>
  Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime.make({
      spawn: {
        command: "node",
        args: [
          NodeURL.fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
        ],
      },
      cwd: process.cwd(),
      clientInfo: { name: "intake-regression", version: "0.0.0" },
      authMethodId: "test",
    });
    yield* runtime.start();
    // Deliberately leave the runtime stream unread. V2 projects notifications
    // directly and its catalog callback consumer may lag behind that projection.
    const exit = yield* Effect.gen(function* () {
      for (let turn = 0; turn < 200; turn++) {
        yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
      }
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isSuccess(exit));
    const events = yield* runtime.getEvents().pipe(Stream.take(800), Stream.runCollect);
    assert.lengthOf(events, 800);
    assert.equal(events.filter((event) => event._tag === "ContentDelta").length, 200);
    assert.isFalse(events.some((event) => event._tag === "ConnectionTerminated"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
