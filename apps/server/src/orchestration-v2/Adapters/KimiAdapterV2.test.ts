import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
  type ProviderTurnId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeKimiTestHarness } from "../../provider/acp/KimiTestHarness.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeKimiAdapterV2 } from "./KimiAdapterV2.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-kimi-v2-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const makeSession = Effect.fn("KimiAdapterTest.makeSession")(function* (
  environment: NodeJS.ProcessEnv = {},
  runtimeMode: RuntimeMode = "approval-required",
) {
  const h = yield* makeKimiTestHarness(environment);
  const instanceId = ProviderInstanceId.make("kimi-test");
  const threadId = ThreadId.make("kimi-thread");
  const modelSelection = {
    instanceId,
    model: "kimi-saved",
    options: [
      { id: "mode", value: "yolo" },
      { id: "llm", value: "kimi-live" },
      { id: "_t3/session-mode", value: "auto" },
    ],
  };
  const policy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: h.root,
  });
  const adapter = makeKimiAdapterV2({
    instanceId,
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocatorV2,
    serverConfig: yield* ServerConfig,
    selfInvocation: yield* resolveSelfInvocation(),
    makeRuntime: h.makeRuntime,
  });
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("kimi-session"),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const turn = (
    providerThread: OrchestrationV2ProviderThread,
    now: DateTime.Utc,
    runtimePolicy = policy,
    ordinal = 1,
  ): ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("kimi-project"),
      title: "Kimi test",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
      interactionMode: runtimePolicy.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`kimi-run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`kimi-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`kimi-node-${ordinal}`),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`kimi-message-${ordinal}`),
      text: "Do the requested work",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  return { ...h, adapter, session, providerThread, turn, policy, modelSelection };
});

it.layer(testLayer, { excludeTestServices: true })("Kimi V2 adapter", (it) => {
  for (const mode of ["full-access", "auto-accept-edits", "auto", "approval-required"] as const) {
    it.effect(`keeps native approvals supervised under ${mode}`, () =>
      Effect.gen(function* () {
        const h = yield* makeSession({}, mode);
        yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
        const events = yield* h.session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(
          events.some(
            (event) => event.type === "message.updated" && event.message.text === "Kimi reply",
          ),
        ).toBe(true);
        const prompt = (yield* h.requests).find((request) => request.method === "session/prompt");
        expect(prompt?.params.modeAtPrompt).toBe("default");
        expect(prompt?.params.modelAtPrompt).toBe("kimi-saved");
      }).pipe(Effect.scoped),
    );
  }

  it.effect("leaves plan mode on the next implement turn", () =>
    Effect.gen(function* () {
      const h = yield* makeSession();
      for (const [ordinal, interactionMode] of [
        [1, "plan"],
        [2, "default"],
      ] as const) {
        const policy = ProviderAdapterV2RuntimePolicy.make({ ...h.policy, interactionMode });
        yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now, policy, ordinal));
        yield* h.session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
      }
      expect(
        (yield* h.requests)
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params.modeAtPrompt),
      ).toEqual(["plan", "default"]);
    }).pipe(Effect.scoped),
  );

  for (const question of [false, true]) {
    it.effect(
      question
        ? "routes AskUserQuestion through user input under full access"
        : "allows denying a Bash permission with a missing native kind",
      () =>
        Effect.gen(function* () {
          const h = yield* makeSession(
            question ? { T3_KIMI_QUESTION: "1" } : { T3_KIMI_PERMISSION: "1" },
            question ? "full-access" : "approval-required",
          );
          yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
          let pending = 0;
          const events = yield* h.session.events.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                if (
                  event.type !== "runtime_request.updated" ||
                  event.runtimeRequest.status !== "pending"
                )
                  return;
                pending += 1;
                yield* h.session
                  .respondToRuntimeRequest(
                    question
                      ? { requestId: event.runtimeRequest.id, answers: { "kimi-tool": "Safe" } }
                      : { requestId: event.runtimeRequest.id, decision: "decline" },
                  )
                  .pipe(Effect.forkScoped);
              }),
            ),
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          expect(pending).toBe(1);
          expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
          const response = (yield* h.requests).find(
            (request) => request.method === "client-response",
          );
          expect(response?.params.result).toEqual({
            outcome: { outcome: "selected", optionId: question ? "safe" : "deny" },
          });
          if (!question)
            expect(
              events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "approval_request" &&
                  event.turnItem.requestKind === "command",
              ),
            ).toBe(true);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("uses T3's auto-approval while keeping native permission callbacks", () =>
    Effect.gen(function* () {
      const h = yield* makeSession({ T3_KIMI_PERMISSION: "1" }, "full-access");
      yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
      const events = yield* h.session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ status: "completed" });
      expect(
        events.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        ),
      ).toBe(false);
      expect(
        (yield* h.requests).find((request) => request.method === "client-response")?.params.result,
      ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    }).pipe(Effect.scoped),
  );

  it.effect("projects a redacted failure from a log even when ACP reports success", () =>
    Effect.gen(function* () {
      const h = yield* makeSession({ T3_KIMI_FAIL_LOG: "1" });
      yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
      const events = yield* h.session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({
        type: "turn.terminal",
        status: "failed",
        failure: { message: "Quota reached token=[REDACTED]", code: "quota", retryable: true },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an active native prompt", () =>
    Effect.gen(function* () {
      const h = yield* makeSession({ T3_KIMI_HOLD: "1" });
      yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
      let providerTurnId: ProviderTurnId | undefined;
      let interruptRequested = false;
      const events = yield* h.session.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
            if (
              interruptRequested ||
              event.type !== "message.updated" ||
              event.message.text !== "Started"
            )
              return;
            if (!providerTurnId) return yield* Effect.die("Expected a started Kimi provider turn.");
            interruptRequested = true;
            yield* h.session
              .interruptTurn({ providerThread: h.providerThread, providerTurnId })
              .pipe(Effect.forkScoped);
          }),
        ),
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
      expect((yield* h.requests).map((request) => request.method)).toContain("session/cancel");
    }).pipe(Effect.scoped),
  );

  for (const negotiated of [false, true]) {
    it.effect(`respects negotiated image support (${negotiated})`, () =>
      Effect.gen(function* () {
        const h = yield* makeSession({ T3_KIMI_IMAGE: negotiated ? "1" : "0" });
        const turn = h.turn(h.providerThread, yield* DateTime.now);
        const id = createAttachmentId(turn.threadId, ".png");
        if (id === null) return yield* Effect.die("Expected a valid attachment ID.");
        const attachment = {
          type: "image" as const,
          id,
          name: "pixel.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const imageTurn = { ...turn, message: { ...turn.message, attachments: [attachment] } };
        const filePath = resolveAttachmentPath({
          attachmentsDir: (yield* ServerConfig).attachmentsDir,
          attachment,
        });
        if (filePath === null) return yield* Effect.die("Expected a valid attachment path.");
        if (!negotiated) {
          const error = yield* h.session.startTurn(imageTurn).pipe(Effect.flip);
          expect(error).toMatchObject({
            cause: { detail: "ACP driver did not negotiate image prompt support" },
          });
          expect((yield* h.requests).some((request) => request.method === "session/prompt")).toBe(
            false,
          );
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory((yield* Path.Path).dirname(filePath), { recursive: true });
        yield* fs.writeFile(filePath, new Uint8Array([137, 80, 78, 71]));
        yield* Effect.addFinalizer(() => fs.remove(filePath).pipe(Effect.orDie));
        yield* h.session.startTurn(imageTurn);
        yield* h.session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        expect(
          (yield* h.requests).find((request) => request.method === "session/prompt")?.params.prompt,
        ).toEqual(
          expect.arrayContaining([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]),
        );
      }).pipe(Effect.scoped),
    );
  }
});
