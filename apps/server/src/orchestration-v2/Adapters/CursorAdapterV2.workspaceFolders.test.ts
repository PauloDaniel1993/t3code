import type { AgentOptions, RunResult } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { CursorProviderCapabilitiesV2, makeCursorAgentOptions } from "./CursorAdapterV2.ts";
import type * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  cursorWorkspaceTurnEvents,
  cursorWorkspaceTurnInput,
  makeCursorWorkspaceFixture,
} from "./CursorWorkspaceFolders.testkit.ts";

const testLayer = Layer.merge(NodeServices.layer, IdAllocator.layer);
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const modelSelection = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };

describe("Cursor workspace folders", () => {
  it("maps directories without loosening sandbox, approval or plan controls", () => {
    for (const runtimeMode of ["full-access", "auto-accept-edits", "approval-required"] as const) {
      for (const interactionMode of ["default", "plan"] as const) {
        for (const sandboxPolicy of [undefined, { type: "readOnly" }] as const) {
          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            cwd: "/workspace/primary",
            runtimeMode,
            interactionMode,
            ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
          });
          const options = (additionalDirectories: string[]) =>
            makeCursorAgentOptions({
              threadId: ThreadId.make("cursor-workspace-policy"),
              modelSelection,
              runtimePolicy: { ...runtimePolicy, additionalDirectories },
            });
          const single = options([]);
          const multi = options(["/workspace/second", "/workspace/third"]);
          assert.deepEqual(multi.local?.dirs, ["/workspace/second", "/workspace/third"]);
          assert.deepEqual({ ...multi.local, dirs: [] }, single.local);
          assert.equal(multi.mode, single.mode);
        }
      }
    }
    assert.equal(CursorProviderCapabilitiesV2.runtimePolicy.workspaceFolderAccess, "unverified");
  });

  it.effect("reuses equal scopes, replaces and clears changed scopes after the turn settles", () =>
    Effect.gen(function* () {
      const opens: Array<CursorAgentSdk.CursorAgentSdkOpenInput> = [];
      const messages: string[] = [];
      let closes = 0;
      const firstRun = yield* Deferred.make<RunResult>();
      const runner: CursorAgentSdk.CursorAgentSdkRunnerShape = {
        assertComplete: Effect.void,
        open: (input) =>
          Effect.sync(() => {
            opens.push(input);
            return {
              agentId: input.agentId ?? "cursor-workspace-native",
              listMessages: Effect.succeed([]),
              close: Effect.sync(() => {
                closes += 1;
              }),
              send: (sendInput) =>
                Effect.sync(() => {
                  messages.push(
                    typeof sendInput.message === "string"
                      ? sendInput.message
                      : sendInput.message.text,
                  );
                  const runId = `cursor-workspace-run-${messages.length}`;
                  return {
                    agentId: "cursor-workspace-native",
                    runId,
                    wait:
                      messages.length === 1
                        ? Deferred.await(firstRun)
                        : Effect.succeed({
                            id: runId,
                            requestId: runId,
                            status: "finished" as const,
                            model: { id: "composer-2.5" },
                            durationMs: 1,
                          }),
                    cancel: Effect.die("A folder change must not cancel work."),
                  };
                }),
            };
          }),
      };
      const fixture = yield* makeCursorWorkspaceFixture(runner);
      const { adapter, runtimePolicy, modelSelection } = fixture;
      const threadId = ThreadId.make("cursor-workspace-reuse");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-workspace-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turn = (ordinal: number, policy = runtimePolicy) =>
        cursorWorkspaceTurnInput({
          providerThread,
          modelSelection,
          runtimePolicy: policy,
          ordinal,
        });
      yield* runtime.startTurn(yield* turn(1));
      const cleared = { ...runtimePolicy, additionalDirectories: [] };
      const activeChange = yield* runtime
        .ensureThread({ threadId, modelSelection, runtimePolicy: cleared })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(activeChange));
      assert.equal(opens.length, 1);
      assert.equal(closes, 0);
      yield* Deferred.succeed(firstRun, {
        id: "cursor-workspace-run-1",
        requestId: "first",
        status: "finished",
        model: { id: "composer-2.5" },
        durationMs: 1,
      });
      const firstEvents = yield* cursorWorkspaceTurnEvents(runtime);
      assert.deepEqual(
        firstEvents.find((event) => event.type === "provider_session.updated")?.providerSession
          .additionalDirectories,
        fixture.additionalDirectories,
      );
      yield* runtime.startTurn(
        yield* turn(2, {
          ...runtimePolicy,
          additionalDirectories: [...fixture.additionalDirectories],
        }),
      );
      yield* cursorWorkspaceTurnEvents(runtime);
      assert.equal(opens.length, 1);

      const reduced = {
        ...runtimePolicy,
        additionalDirectories: fixture.additionalDirectories.slice(1),
      };
      yield* runtime.startTurn(yield* turn(3, reduced));
      yield* cursorWorkspaceTurnEvents(runtime);
      yield* runtime.compactThread!(yield* turn(4, reduced));
      yield* cursorWorkspaceTurnEvents(runtime);
      assert.equal(messages[3], "/compress");
      yield* runtime.startTurn(yield* turn(5, cleared));
      const clearedEvents = yield* cursorWorkspaceTurnEvents(runtime);
      assert.deepEqual(
        clearedEvents.find((event) => event.type === "provider_session.updated")?.providerSession
          .additionalDirectories,
        [],
      );

      const moved = { ...cleared, cwd: fixture.additionalDirectories[0]! };
      yield* runtime.startTurn(yield* turn(6, moved));
      yield* cursorWorkspaceTurnEvents(runtime);
      yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(opens.length, 4);
      assert.equal(closes, 3);
      assert.deepEqual(
        opens.map((open) => [open.operation, open.agentId, open.options.local?.dirs]),
        [
          ["create", undefined, [...fixture.additionalDirectories]],
          ["resume", "cursor-workspace-native", reduced.additionalDirectories],
          ["resume", "cursor-workspace-native", []],
          ["resume", "cursor-workspace-native", []],
        ],
      );
      assert.equal(opens.at(-1)?.options.local?.cwd, moved.cwd);
      assert.deepEqual(runtime.providerSession.additionalDirectories, []);
      assert.equal(runtime.providerSession.cwd, moved.cwd);
      for (const message of messages.slice(0, 3)) {
        assert.include(message, "<workspace_folders>");
        assert.include(message, quote(fixture.cwd));
        assert.include(message, quote(fixture.additionalDirectories[1]));
      }
      assert.isBelow(
        messages[0]!.indexOf(quote(fixture.additionalDirectories[0])),
        messages[0]!.indexOf(quote(fixture.additionalDirectories[1])),
      );
      assert.notInclude(messages[2]!, quote(fixture.additionalDirectories[0]));
      assert.notInclude(messages[4]!, "<workspace_folders>");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("installs the full list on resume and a portable fork's new agent", () =>
    Effect.gen(function* () {
      const options: Array<readonly [string, string | undefined, AgentOptions]> = [];
      const fixture = yield* makeCursorWorkspaceFixture({
        assertComplete: Effect.void,
        open: (input) =>
          Effect.sync(() => {
            options.push([input.operation, input.agentId, input.options]);
            return {
              agentId: input.agentId ?? `cursor-native-${options.length}`,
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: () => Effect.die("unused turn"),
            };
          }),
      });
      const { adapter, modelSelection, runtimePolicy } = fixture;
      const threadId = ThreadId.make("cursor-workspace-resume");
      const providerThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* adapter.openSession({
            threadId,
            modelSelection,
            runtimePolicy,
            providerSessionId: ProviderSessionId.make("cursor-workspace-initial"),
          });
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const resumed = yield* adapter.openSession({
        threadId,
        modelSelection,
        runtimePolicy,
        providerSessionId: ProviderSessionId.make("cursor-workspace-resumed"),
      });
      yield* resumed.resumeThread({ providerThread });
      assert.deepEqual(
        resumed.providerSession.additionalDirectories,
        fixture.additionalDirectories,
      );
      const forkId = ThreadId.make("cursor-workspace-portable-fork");
      const fork = yield* adapter.openSession({
        threadId: forkId,
        modelSelection,
        runtimePolicy,
        providerSessionId: ProviderSessionId.make("cursor-workspace-fork"),
      });
      yield* fork.ensureThread({ threadId: forkId, modelSelection, runtimePolicy });
      assert.deepEqual(
        options.map(([operation, agentId, option]) => [operation, agentId, option.local?.dirs]),
        [
          ["create", undefined, [...fixture.additionalDirectories]],
          ["resume", "cursor-native-1", [...fixture.additionalDirectories]],
          ["create", undefined, [...fixture.additionalDirectories]],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
