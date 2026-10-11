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
  initialNativeThreadId?: string,
  withWorkspaceFolders = false,
) {
  const h = yield* makeKimiTestHarness(environment);
  const additionalDirectories = withWorkspaceFolders
    ? [yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "t3-kimi-extra-" })]
    : [];
  if (initialNativeThreadId) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* h.makeRuntime({
          cwd: h.root,
          clientInfo: { name: "kimi-before-restart", version: "0.0.0" },
        });
        expect((yield* runtime.start()).sessionId).toBe(initialNativeThreadId);
        yield* runtime.setModel("kimi-saved");
      }),
    );
  }
  const instanceId = ProviderInstanceId.make("kimi-test");
  const threadId = ThreadId.make("kimi-thread");
  const modelSelection = {
    instanceId,
    model: "kimi-saved",
    options: [
      { id: "mode", value: "yolo" },
      { id: "llm", value: "kimi-live" },
      { id: "_t3/session-mode", value: "plan" },
    ],
  };
  const policy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: h.root,
    additionalDirectories,
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
    ...(initialNativeThreadId ? { initialNativeThreadId } : {}),
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
  return { ...h, adapter, session, providerThread, turn, policy, modelSelection, threadId };
});

it.layer(testLayer, { excludeTestServices: true })("Kimi V2 adapter", (it) => {
  it.effect("installs folders on new sessions and hands off when the scope is cleared", () =>
    Effect.gen(function* () {
      const h = yield* makeSession(
        { T3_KIMI_ADDITIONAL_DIRECTORIES: "1" },
        "full-access",
        undefined,
        true,
      );
      expect(h.session.providerSession.additionalDirectories).toEqual(
        h.policy.additionalDirectories,
      );
      expect(h.session.providerSession.capabilities.runtimePolicy.workspaceFolderAccess).toBe(
        "unverified",
      );
      expect(h.session.providerSession.capabilities.threads.canForkThread).toBe(false);
      yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now));
      yield* h.session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const cleared = ProviderAdapterV2RuntimePolicy.make({
        ...h.policy,
        additionalDirectories: [],
      });
      const error = yield* h.session
        .resumeThread({ providerThread: h.providerThread, runtimePolicy: cleared })
        .pipe(Effect.flip);
      expect(error.message).toContain("resume");
      const replacement = yield* h.session.ensureThread({
        threadId: h.threadId,
        modelSelection: h.modelSelection,
        runtimePolicy: cleared,
        existingProviderThread: { ...h.providerThread, nativeThreadRef: null },
      });
      expect(replacement.id).toBe(h.providerThread.id);
      expect(replacement.nativeThreadRef?.nativeId).not.toBe(
        h.providerThread.nativeThreadRef?.nativeId,
      );
      expect(h.session.providerSession.additionalDirectories).toEqual([]);
      yield* h.session.startTurn(h.turn(replacement, yield* DateTime.now, cleared, 2));
      yield* h.session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const requests = yield* h.requests;
      expect(
        requests
          .filter((request) => request.method === "session/new")
          .map((request) => request.params.additionalDirectories),
      ).toEqual([h.policy.additionalDirectories, []]);
      expect(
        requests.some((request) =>
          ["session/resume", "session/load", "session/fork"].includes(request.method),
        ),
      ).toBe(false);
      const prompts = requests.filter((request) => request.method === "session/prompt");
      expect(prompts.map((request) => request.params.additionalDirectoriesAtPrompt)).toEqual([
        h.policy.additionalDirectories,
        [],
      ]);
      expect(JSON.stringify(prompts[0]?.params.prompt)).toContain("<workspace_folders>");
      expect(JSON.stringify(prompts[1]?.params.prompt)).not.toContain("<workspace_folders>");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "opens a fresh Kimi session for a persisted scope change and refuses native resume",
    () =>
      Effect.gen(function* () {
        const h = yield* makeSession(
          { T3_KIMI_ADDITIONAL_DIRECTORIES: "1" },
          "full-access",
          undefined,
          true,
        );
        const cleared = ProviderAdapterV2RuntimePolicy.make({
          ...h.policy,
          additionalDirectories: [],
        });
        const reopened = yield* h.adapter.openSession({
          threadId: h.threadId,
          providerSessionId: h.session.providerSessionId,
          modelSelection: h.modelSelection,
          runtimePolicy: cleared,
          resumeFromSession: h.session.providerSession,
          initialNativeThreadId: h.providerThread.nativeThreadRef!.nativeId!,
        });
        yield* reopened
          .resumeThread({ providerThread: h.providerThread, runtimePolicy: cleared })
          .pipe(Effect.flip);
        const replacement = yield* reopened.ensureThread({
          threadId: h.threadId,
          modelSelection: h.modelSelection,
          runtimePolicy: cleared,
          existingProviderThread: { ...h.providerThread, nativeThreadRef: null },
        });
        expect(replacement.nativeThreadRef?.nativeId).not.toBe(
          h.providerThread.nativeThreadRef?.nativeId,
        );
        expect(
          (yield* h.requests)
            .filter((request) => request.method === "session/new")
            .map((request) => request.params.additionalDirectories),
        ).toEqual([h.policy.additionalDirectories, []]);
        expect((yield* h.requests).some((request) => request.method === "session/resume")).toBe(
          false,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("refuses extra folders when Kimi does not advertise access", () =>
    Effect.gen(function* () {
      const error = yield* makeSession({}, "full-access", undefined, true).pipe(Effect.flip);
      expect(error.message).toContain("open");
    }).pipe(Effect.scoped),
  );

  it.effect("retains the installed folders when resuming an unchanged Kimi scope", () =>
    Effect.gen(function* () {
      const h = yield* makeSession(
        { T3_KIMI_ADDITIONAL_DIRECTORIES: "1" },
        "full-access",
        undefined,
        true,
      );
      const reopened = yield* h.adapter.openSession({
        threadId: h.threadId,
        providerSessionId: h.session.providerSessionId,
        modelSelection: h.modelSelection,
        runtimePolicy: h.policy,
        resumeFromSession: h.session.providerSession,
        initialNativeThreadId: h.providerThread.nativeThreadRef!.nativeId!,
      });
      const resumed = yield* reopened.resumeThread({
        providerThread: h.providerThread,
        runtimePolicy: h.policy,
      });
      yield* reopened.startTurn(h.turn(resumed, yield* DateTime.now));
      yield* reopened.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const requests = yield* h.requests;
      expect(requests.filter((request) => request.method === "session/new")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "session/resume")).toHaveLength(1);
      expect(
        requests.find((request) => request.method === "session/prompt")?.params
          .additionalDirectoriesAtPrompt,
      ).toEqual(h.policy.additionalDirectories);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["full-access", "auto-accept-edits", "auto", "approval-required"] as const)(
    "keeps native approvals supervised under %s",
    (mode) =>
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

  it.effect.each([
    { resumed: false, label: "new" },
    { resumed: true, label: "resume" },
  ])(
    "fails a plan turn before prompting when native plan mode is unavailable ($label)",
    ({ resumed }) =>
      Effect.gen(function* () {
        const h = yield* makeSession(
          {
            ...(resumed ? { T3_KIMI_RESUME_NO_CONFIG: "1" } : { T3_KIMI_NO_PLAN: "1" }),
            T3_KIMI_WRITE_FILE: "1",
          },
          "full-access",
          resumed ? "mock-kimi-session" : undefined,
        );
        const policy = ProviderAdapterV2RuntimePolicy.make({
          ...h.policy,
          interactionMode: "plan",
        });
        yield* h.session.startTurn(h.turn(h.providerThread, yield* DateTime.now, policy));
        const events = yield* h.session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(events.at(-1)).toMatchObject({
          type: "turn.terminal",
          status: "failed",
          failure: {
            message: expect.stringContaining("cannot run a plan turn"),
            code: "plan_mode_unavailable",
          },
        });
        const requests = yield* h.requests;
        expect(requests.some((request) => request.method === "session/prompt")).toBe(false);
        expect(
          yield* (yield* FileSystem.FileSystem).exists(
            (yield* Path.Path).join(h.root, "unexpected.txt"),
          ),
        ).toBe(false);
        if (resumed)
          expect(requests.some((request) => request.method === "session/resume")).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["allows denying a Bash permission with a missing native kind", false],
    ["routes AskUserQuestion through user input under full access", true],
  ] as const)("%s", ([, question]) =>
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
      const response = (yield* h.requests).find((request) => request.method === "client-response");
      expect(response?.params.result).toEqual({
        outcome: { outcome: "selected", optionId: question ? "safe" : "deny" },
      });
      if (!question)
        expect(
          events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "approval_request" &&
              event.turnItem.requestKind === "command" &&
              event.turnItem.prompt === "git status",
          ),
        ).toBe(true);
    }).pipe(Effect.scoped),
  );

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

  it.effect.each([false, true])("respects negotiated image support (%s)", (negotiated) =>
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
});
