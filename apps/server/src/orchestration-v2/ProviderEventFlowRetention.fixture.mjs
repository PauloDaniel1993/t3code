import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { makeProviderEventFlowStage } from "./ProviderEventFlowStage.ts";
import { boundProviderToolResult } from "./ProviderEventPayload.ts";

const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
const stage = await Effect.runPromise(
  makeProviderEventFlowStage({ driver: "codex", providerSessionId: "retention" }),
);
function sample() {
  for (let i = 0; i < 8; i++) global.gc();
  return process.memoryUsage();
}
const before = sample();
let preview;
function makePreview() {
  const source = Buffer.alloc(64 * 1024 * 1024, 97).toString("utf8");
  return boundProviderToolResult(source);
}
if (process.argv[2] === "payload") {
  preview = makePreview();
} else {
  await Effect.runPromise(
    Effect.suspend(() =>
      stage.offer({
        type: "turn_item.updated",
        driver: "codex",
        turnItem: {
          id: "tool",
          type: "command_execution",
          threadId: "thread",
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Tool",
          input: "echo",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          output: Buffer.alloc(64 * 1024 * 1024, 97).toString("utf8"),
        },
      }),
    ),
  );
}
// Neither usage nor output encoding may flatten the string before this sample.
const held = sample();
if (preview === undefined) {
  const [event] = await Effect.runPromise(stage.events.pipe(Stream.take(1), Stream.runCollect));
  preview = event.turnItem.output;
}
process.stdout.write(
  JSON.stringify({
    externalBytes: held.external - before.external,
    heapBytes: held.heapUsed - before.heapUsed,
    output: preview,
  }),
);
