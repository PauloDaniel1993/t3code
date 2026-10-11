import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { buildWorkspaceFolderInventory } from "../../provider/WorkspaceFolderInventory.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  makeClaudeWorkspaceFolderHarness,
  workspaceFolderModelSelection,
} from "./ClaudeWorkspaceFolders.testkit.ts";

const scope = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  cwd: "C:\\sessions\\primary worktree",
  additionalDirectories: ["D:\\sessions\\secondary worktree", "C:\\shared\\notes"],
});

function systemAppend(options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions): string {
  const prompt = options.systemPrompt;
  return typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset"
    ? (prompt.append ?? "")
    : "";
}

const resultFrame = (ordinal: number): SDKMessage => ({
  type: "result",
  subtype: "success",
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: "Done.",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [],
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  },
  modelUsage: {},
  permission_denials: [],
  uuid: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
  session_id: "00000000-0000-4000-8000-000000000100",
  terminal_reason: "completed",
});

const makeHarness = Effect.fnUntraced(function* () {
  const queries: Array<{
    input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput;
    messages: Queue.Queue<SDKMessage>;
    closed: boolean;
  }> = [];
  const harness = yield* makeClaudeWorkspaceFolderHarness({
    runtimePolicy: scope,
    queryRunner: {
      allocateSessionId: Effect.succeed("00000000-0000-4000-8000-000000000100"),
      open: Effect.fnUntraced(function* (input) {
        const messages = yield* Queue.unbounded<SDKMessage>();
        const process = { input, messages, closed: false };
        queries.push(process);
        return {
          messages: Stream.fromQueue(messages),
          offer: () => Effect.void,
          setModel: () => Effect.void,
          interrupt: Effect.void,
          close: Effect.sync(() => {
            process.closed = true;
          }).pipe(Effect.andThen(Queue.shutdown(messages))),
        };
      }),
      forkSession: () => Effect.succeed({ sessionId: "00000000-0000-4000-8000-000000000200" }),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const finish = Effect.fnUntraced(function* (ordinal: number) {
    yield* Queue.offer(queries.at(-1)!.messages, resultFrame(ordinal));
    const terminal = yield* Queue.take(harness.terminals);
    assert.equal(terminal.status, "completed");
    return terminal;
  });
  return { ...harness, queries, finish };
});

const testLayer = Layer.merge(NodeServices.layer, IdAllocator.layer);

describe("Claude workspace folders", () => {
  it.each([false, true])("keeps cwd, folders and attachments with resume=%s", (resume) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: workspaceFolderModelSelection,
      nativeThreadId: "native-folders",
      resume,
      cwd: scope.cwd,
      additionalDirectories: [...scope.additionalDirectories, scope.cwd!],
      attachmentsDir: "C:\\attachments",
      permissionMode: "acceptEdits",
    });
    assert.deepEqual(options.additionalDirectories, [
      scope.cwd,
      ...scope.additionalDirectories,
      "C:\\attachments",
    ]);
    assert.equal(options.permissionMode, "acceptEdits");
    assert.include(systemAppend(options), "<workspace_folders>");
  });

  it.each([
    ProviderAdapterV2RuntimePolicy.make({ ...scope, sandboxPolicy: { type: "readOnly" } }),
    ProviderAdapterV2RuntimePolicy.make({ ...scope, interactionMode: "plan" }),
  ])("preserves restricted query policy with folders (%j)", (runtimePolicy) => {
    const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy);
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: workspaceFolderModelSelection,
      nativeThreadId: "native-restricted-folders",
      resume: false,
      cwd: scope.cwd,
      additionalDirectories: scope.additionalDirectories,
      ...policy,
    });
    const singleFolder = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({ ...runtimePolicy, additionalDirectories: [] }),
    );
    assert.deepEqual(policy, singleFolder);
    assert.notEqual(options.permissionMode, "bypassPermissions");
    assert.notInclude(options.allowedTools ?? [], "Edit");
  });

  it.effect(
    "reuses the same scope, replaces changed cwd/folders, and clears installed folders",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          assert.deepEqual(harness.runtime.providerSession.additionalDirectories, []);
          yield* harness.startTurn({ ordinal: 1, runtimePolicy: scope });
          const installed = yield* Queue.take(harness.sessions);
          assert.deepEqual(
            installed.providerSession.additionalDirectories,
            scope.additionalDirectories,
          );
          const options = harness.queries[0]!.input.options;
          assert.deepEqual(options.additionalDirectories, [
            scope.cwd,
            ...scope.additionalDirectories,
            harness.attachmentsDir,
          ]);
          assert.include(systemAppend(options), buildWorkspaceFolderInventory(scope)!);
          yield* harness.finish(1);
          yield* harness.startTurn({ ordinal: 2, runtimePolicy: scope });
          assert.lengthOf(harness.queries, 1);
          yield* harness.finish(2);
          const replacement = ProviderAdapterV2RuntimePolicy.make({
            ...scope,
            additionalDirectories: scope.additionalDirectories.toReversed(),
          });
          yield* harness.startTurn({ ordinal: 3, runtimePolicy: replacement });
          assert.isTrue(harness.queries[0]!.closed);
          assert.isDefined(harness.queries[1]!.input.options.resume);
          assert.deepEqual(
            (yield* Queue.take(harness.sessions)).providerSession.additionalDirectories,
            replacement.additionalDirectories,
          );
          yield* harness.finish(3);
          const moved = ProviderAdapterV2RuntimePolicy.make({
            ...replacement,
            cwd: "C:\\sessions\\new primary",
          });
          yield* harness.startTurn({ ordinal: 4, runtimePolicy: moved });
          assert.lengthOf(harness.queries, 3);
          assert.equal(harness.queries[2]!.input.options.cwd, moved.cwd);
          assert.deepEqual(
            (yield* Queue.take(harness.sessions)).providerSession.additionalDirectories,
            replacement.additionalDirectories,
          );
          yield* harness.finish(4);
          const cleared = ProviderAdapterV2RuntimePolicy.make({
            ...moved,
            additionalDirectories: [],
          });
          yield* harness.startTurn({ ordinal: 5, runtimePolicy: cleared });
          assert.lengthOf(harness.queries, 4);
          assert.deepEqual(harness.queries[3]!.input.options.additionalDirectories, [
            cleared.cwd,
            harness.attachmentsDir,
          ]);
          assert.notInclude(systemAppend(harness.queries[3]!.input.options), "<workspace_folders>");
          assert.deepEqual(
            (yield* Queue.take(harness.sessions)).providerSession.additionalDirectories,
            [],
          );
          assert.deepEqual(harness.runtime.providerSession.additionalDirectories, []);
          assert.deepEqual(
            installed.providerSession.additionalDirectories,
            scope.additionalDirectories,
          );
          yield* harness.finish(5);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("delivers the target folder scope on the first query after native fork", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn({ ordinal: 1, runtimePolicy: scope });
        yield* harness.finish(1);
        const targetThreadId = ThreadId.make("claude-folder-fork");
        const targetScope = ProviderAdapterV2RuntimePolicy.make({
          ...scope,
          additionalDirectories: ["D:\\sessions\\fork worktree"],
        });
        const fork = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          targetThreadId,
          runtimePolicy: targetScope,
        });
        yield* harness.startTurn({
          ordinal: 2,
          threadId: targetThreadId,
          providerThread: fork,
          runtimePolicy: targetScope,
        });
        assert.equal(harness.queries[1]!.input.options.resume, fork.nativeThreadRef?.nativeId);
        assert.deepEqual(harness.queries[1]!.input.options.additionalDirectories, [
          targetScope.cwd,
          ...targetScope.additionalDirectories,
          harness.attachmentsDir,
        ]);
        yield* Queue.take(harness.sessions);
        assert.deepEqual(
          (yield* Queue.take(harness.sessions)).providerSession.additionalDirectories,
          targetScope.additionalDirectories,
        );
        yield* harness.finish(2);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses scope replacement while background work is running without closing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startTurn({ ordinal: 1, runtimePolicy: scope });
        yield* Queue.offer(harness.queries[0]!.messages, {
          type: "system",
          subtype: "task_started",
          task_id: "folder-background-task",
          tool_use_id: "folder-background-agent",
          description: "Work in the extra folder",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Read the folder",
          uuid: "00000000-0000-4000-8000-000000000300",
          session_id: "00000000-0000-4000-8000-000000000100",
        });
        yield* harness.finish(1);
        assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
        const refused = yield* harness
          .startTurn({
            ordinal: 2,
            runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
              ...scope,
              additionalDirectories: [],
            }),
          })
          .pipe(Effect.flip);
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError().message,
        );
        assert.lengthOf(harness.queries, 1);
        assert.isFalse(harness.queries[0]!.closed);
        assert.deepEqual(
          harness.runtime.providerSession.additionalDirectories,
          scope.additionalDirectories,
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
