// oxlint-disable t3code/no-manual-effect-runtime-in-tests
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type ModelSelection,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_MESSAGE_COMPRESSION_THRESHOLD_CHARS,
  buildHandoffBootstrapContext,
} from "./bootstrapContext.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("deepseek"),
  model: "deepseek-v4-flash",
};

function makeThread(messageText: string): OrchestrationThread {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: ThreadId.make("target-thread"),
    projectId: ProjectId.make("project-1"),
    title: "Handoff: Source thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-v4-pro",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    handoff: {
      schemaVersion: 1,
      sourceThreadId: ThreadId.make("source-thread"),
      sourceTitle: "Source thread",
      sourceProviderInstanceId: ProviderInstanceId.make("codex"),
      targetProviderInstanceId: ProviderInstanceId.make("deepseek"),
      importedMessageCount: 1,
      bootstrapStatus: "pending",
      bootstrapMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("source-message-1"),
        role: "assistant",
        text: messageText,
        turnId: null,
        streaming: false,
        source: "handoff-import",
        sourceThreadId: ThreadId.make("source-thread"),
        sourceMessageId: MessageId.make("source-message-1"),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MessageId.make("native-user-1"),
        role: "user",
        text: "Continue from the unresolved migration note.",
        turnId: null,
        streaming: false,
        source: "user",
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

describe("buildHandoffBootstrapContext", () => {
  const effectIt = {
    effect: (name: string, body: () => Effect.Effect<unknown, object, never>): void => {
      it(name, () => Effect.runPromise(body()));
    },
  };

  effectIt.effect(
    "compresses oversized imported messages and preserves the latest user message",
    () =>
      Effect.gen(function* () {
        const oversizedText = `Keep file apps/server/src/foo.ts. ${"x".repeat(
          HANDOFF_MESSAGE_COMPRESSION_THRESHOLD_CHARS + 1,
        )}`;
        const thread = makeThread(oversizedText);

        const result = yield* buildHandoffBootstrapContext({
          thread,
          latestUserMessage: thread.messages[1]!,
          cwd: process.cwd(),
          modelSelection,
          createdAt: "2026-01-01T00:00:00.000Z",
          summarizeHandoffMessage: () =>
            Effect.succeed({
              summary: "Preserve apps/server/src/foo.ts and finish the migration note.",
            }),
        });

        expect(result.providerInput).toContain("<handoff_context>");
        expect(result.providerInput).toContain("<latest_user_message>");
        expect(result.providerInput).toContain("Continue from the unresolved migration note.");
        expect(result.providerInput).toContain("Preserve apps/server/src/foo.ts");
        expect(result.providerInput).not.toContain("x".repeat(2_000));
        expect(result.compressionSummaries).toHaveLength(1);
        expect(result.compressionSummaries[0]?.sourceMessageId).toBe("source-message-1");
      }),
  );

  effectIt.effect("uses deterministic fallback text when summary generation fails twice", () =>
    Effect.gen(function* () {
      const oversizedText = `Important command: vp run typecheck\n${"y".repeat(
        HANDOFF_MESSAGE_COMPRESSION_THRESHOLD_CHARS + 1,
      )}`;
      const thread = makeThread(oversizedText);

      const result = yield* buildHandoffBootstrapContext({
        thread,
        latestUserMessage: thread.messages[1]!,
        cwd: process.cwd(),
        modelSelection,
        createdAt: "2026-01-01T00:00:00.000Z",
        summarizeHandoffMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateHandoffSummary",
              detail: "test failure",
            }),
          ),
      });

      expect(result.providerInput).toContain("Summary generation failed");
      expect(result.providerInput).toContain("Important command: vp run typecheck");
      expect(result.compressionSummaries).toHaveLength(1);
    }),
  );
});
