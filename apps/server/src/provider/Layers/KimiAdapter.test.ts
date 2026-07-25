// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ChatAttachment,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { providerFileUri } from "../attachmentDelivery.ts";
import { makeKimiModelState } from "../KimiModelState.ts";
import type { KimiAdapterShape } from "../Services/KimiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  isKimiStructuredUserInputPermission,
  kimiElicitationQuestions,
  makeKimiAdapter,
  prepareKimiAcpPromptParts,
} from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.UnknownFromJsonString);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKimiWrapper(
  hostPlatform: NodeJS.Platform,
  executablePath: string,
  extraEnv: Record<string, string> = {},
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  if (hostPlatform === "win32") {
    const wrapperPath = NodePath.join(dir, "fake-kimi.cmd");
    const envLines = Object.entries(extraEnv)
      .map(([key, value]) => `set "${key}=${value}"`)
      .join("\r\n");
    await NodeFSP.writeFile(
      wrapperPath,
      `@echo off\r\n${envLines}\r\n"${executablePath}" "${mockAgentPath}" %*\r\n`,
      "utf8",
    );
    return { dir, wrapperPath };
  }

  const wrapperPath = NodePath.join(dir, "fake-kimi.sh");
  const envLines = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envLines}\nexec ${JSON.stringify(executablePath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return { dir, wrapperPath };
}

function withMockKimi<A, E, R>(
  extraEnv: Record<string, string>,
  use: (wrapperPath: string) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    const executablePath = yield* HostProcessExecutablePath;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() =>
        makeMockKimiWrapper(hostPlatform, executablePath, {
          T3_ACP_KIMI_FIXTURE: "1",
          ...extraEnv,
        }),
      ),
      ({ wrapperPath }) => use(wrapperPath),
      ({ dir }) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
  });
}

function withKimiAdapter<A, E, R>(
  wrapperPath: string,
  use: (adapter: KimiAdapterShape) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
  nativeEventLogger?: EventNdjsonLogger,
) {
  return Effect.gen(function* () {
    const modelState = yield* makeKimiModelState([]);
    const adapter = yield* makeKimiAdapter(
      decodeKimiSettings({ enabled: true, binaryPath: wrapperPath }),
      {
        modelState,
        ...(environment ? { environment } : {}),
        ...(nativeEventLogger ? { nativeEventLogger } : {}),
      },
    );
    return yield* use(adapter);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kimi-adapter-test-" }).pipe(
        // ServerConfig's test layer consumes filesystem/path services; merge
        // those into its output so the adapter and config share one lifecycle.
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function writeStoredAttachment(
  attachmentsDir: string,
  attachment: ChatAttachment,
  bytes: Uint8Array,
) {
  const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
  await NodeFSP.mkdir(NodePath.dirname(attachmentPath), { recursive: true });
  await NodeFSP.writeFile(attachmentPath, bytes);
  return attachmentPath;
}

it.effect("maps supported Kimi attachments and rejects unadvertised images before dispatch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kimi-parts-" });
    const threadId = ThreadId.make("kimi-attachment-thread");
    const file = {
      type: "file" as const,
      id: "kimi-attachment-thread-12345678-1234-1234-1234-123456789abc",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    const image = {
      type: "image" as const,
      id: "kimi-attachment-thread-22345678-1234-1234-1234-123456789abc",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 2,
    };
    const filePath = yield* Effect.promise(() =>
      writeStoredAttachment(attachmentsDir, file, Uint8Array.from([1, 2, 3])),
    );
    yield* Effect.promise(() =>
      writeStoredAttachment(attachmentsDir, image, Uint8Array.from([4, 5])),
    );

    const parts = yield* prepareKimiAcpPromptParts({
      text: "Inspect",
      attachmentsDir,
      threadId,
      attachments: [file, image],
      fileSystem,
      imageSupported: true,
    });
    assert.equal(parts[0]?.type, "text");
    if (parts[0]?.type === "text") {
      assert.include(parts[0].text, "You may use Agent or AgentSwarm subagents.");
      assert.include(parts[0].text, "omit run_in_background");
      assert.include(parts[0].text, "User request:\nInspect");
    }
    assert.deepStrictEqual(parts.slice(1), [
      {
        type: "resource_link",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 3,
        uri: providerFileUri(filePath),
      },
      { type: "image", data: "BAU=", mimeType: "image/png" },
    ]);

    const error = yield* prepareKimiAcpPromptParts({
      text: "Do not dispatch",
      attachmentsDir,
      threadId,
      attachments: [image],
      fileSystem,
      imageSupported: false,
    }).pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.match(error.message, /did not advertise image prompt support/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("normalizes ACP form elicitation into provider-generic user questions", () => {
  assert.deepStrictEqual(
    kimiElicitationQuestions({
      mode: "form",
      sessionId: "kimi-session",
      message: "Choose a scope",
      requestedSchema: {
        type: "object",
        title: "Kimi question",
        properties: {
          scope: {
            type: "string",
            title: "Scope",
            description: "Where should Kimi work?",
            oneOf: [
              { const: "workspace", title: "Workspace" },
              { const: "session", title: "Session" },
            ],
          },
        },
      },
    }),
    [
      {
        id: "scope",
        header: "Scope",
        question: "Where should Kimi work?",
        options: [
          { label: "Workspace", description: "Workspace" },
          { label: "Session", description: "Session" },
        ],
        multiSelect: false,
      },
    ],
  );
});

it("does not mistake a multi-choice tool approval for structured user input", () => {
  const request = {
    sessionId: "kimi-session",
    toolCall: {
      toolCallId: "tool-call",
      title: "Bash",
      status: "pending",
    },
    options: [
      { optionId: "allow-workspace", name: "Allow workspace", kind: "allow_once" },
      { optionId: "allow-file", name: "Allow file", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  } as Parameters<typeof isKimiStructuredUserInputPermission>[0];

  assert.isFalse(isKimiStructuredUserInputPermission(request));
});

it.effect("maps Kimi session lifecycle without stderr backpressure and supports resume", () =>
  withMockKimi(
    {
      T3_ACP_PROMPT_STDERR_BYTES: String(1024 * 1024),
      T3_ACP_OMIT_KIMI_RESUME_CONFIG_OPTIONS: "1",
    },
    (wrapperPath) =>
      withKimiAdapter(wrapperPath, (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("kimi-lifecycle-thread");
          const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("kimi"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("kimi"),
              model: "composer-2",
            },
          });
          assert.deepStrictEqual(session.resumeCursor, {
            schemaVersion: 1,
            instanceId: ProviderInstanceId.make("kimi"),
            sessionId: "mock-session-1",
          });

          yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
          const types = Array.from(yield* Fiber.join(eventsFiber), (event) => event.type);
          for (const expected of [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "turn.plan.updated",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ] as const) {
            assert.include(types, expected);
          }

          yield* adapter.stopSession(threadId);
          const crossInstanceError = yield* adapter
            .startSession({
              threadId,
              provider: ProviderDriverKind.make("kimi"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: {
                schemaVersion: 1,
                instanceId: ProviderInstanceId.make("kimi-work"),
                sessionId: "mock-session-1",
              },
            })
            .pipe(Effect.flip);
          assert.equal(crossInstanceError._tag, "ProviderAdapterValidationError");
          assert.match(crossInstanceError.message, /belongs to instance/);

          const resumed = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("kimi"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: session.resumeCursor,
            modelSelection: {
              instanceId: ProviderInstanceId.make("kimi"),
              model: "composer-2",
            },
          });
          assert.deepStrictEqual(resumed.resumeCursor, session.resumeCursor);
          yield* adapter.stopSession(threadId);
        }),
      ),
  ),
);

it.effect("surfaces Kimi provider failures that ACP reports as successful turns", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const kimiHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-home-"));
      const sessionDir = NodePath.join(kimiHome, "sessions", "mock-workdir", "mock-session-1");
      const logPath = NodePath.join(sessionDir, "logs", "kimi-code.log");
      await NodeFSP.mkdir(NodePath.dirname(logPath), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(kimiHome, "session_index.jsonl"),
        `${encodeUnknownJsonString({ sessionId: "mock-session-1", sessionDir })}\n`,
        "utf8",
      );
      await NodeFSP.writeFile(logPath, "Kimi session started\n", "utf8");
      return { kimiHome, logPath };
    }),
    ({ kimiHome, logPath }) =>
      withMockKimi(
        {
          T3_ACP_KIMI_FAILURE_LOG_PATH: logPath,
          T3_ACP_KIMI_FAILURE_MESSAGE:
            "403 You've reached your usage limit for this billing cycle.",
        },
        (wrapperPath) =>
          withKimiAdapter(
            wrapperPath,
            (adapter) =>
              Effect.gen(function* () {
                const threadId = ThreadId.make("kimi-provider-failure-thread");
                const completedEventFiber = yield* adapter.streamEvents.pipe(
                  Stream.filter(
                    (event) => event.threadId === threadId && event.type === "turn.completed",
                  ),
                  Stream.runHead,
                  Effect.forkChild,
                );

                yield* adapter.startSession({
                  threadId,
                  provider: ProviderDriverKind.make("kimi"),
                  cwd: process.cwd(),
                  runtimeMode: "full-access",
                });
                const turn = yield* adapter.sendTurn({
                  threadId,
                  input: "hello",
                  attachments: [],
                });
                const completedEvent = yield* Fiber.join(completedEventFiber);
                const session = (yield* adapter.listSessions()).find(
                  (candidate) => candidate.threadId === threadId,
                );
                const snapshot = yield* adapter.readThread(threadId);

                assert.isTrue(Option.isSome(completedEvent));
                if (
                  Option.isSome(completedEvent) &&
                  completedEvent.value.type === "turn.completed"
                ) {
                  assert.equal(completedEvent.value.turnId, turn.turnId);
                  assert.equal(completedEvent.value.payload.state, "failed");
                  assert.equal(
                    completedEvent.value.payload.errorMessage,
                    "403 You've reached your usage limit for this billing cycle.",
                  );
                }
                assert.equal(session?.status, "error");
                assert.equal(
                  session?.lastError,
                  "403 You've reached your usage limit for this billing cycle.",
                );
                assert.isUndefined(session?.activeTurnId);
                assert.deepStrictEqual(snapshot.turns, []);
                yield* adapter.stopSession(threadId);
              }),
            { ...process.env, KIMI_CODE_HOME: kimiHome },
          ),
      ),
    ({ kimiHome }) => Effect.promise(() => NodeFSP.rm(kimiHome, { recursive: true, force: true })),
  ),
);

it.effect("steers a running Kimi turn by cancelling it before the follow-up prompt", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-steer-"))),
    (tempDir) => {
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      return withMockKimi(
        {
          T3_ACP_HANG_FIRST_PROMPT_UNTIL_CANCEL: "1",
          T3_ACP_CANCEL_SETTLE_DELAY_MS: "100",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
        (wrapperPath) =>
          withKimiAdapter(wrapperPath, (adapter) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make("kimi-steer-thread");
              const runtimeEvents: ProviderRuntimeEvent[] = [];
              const firstTurnStarted = yield* Deferred.make<TurnId>();
              const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
                Effect.sync(() => {
                  runtimeEvents.push(event);
                }).pipe(
                  Effect.andThen(
                    event.type === "turn.started" && event.turnId !== undefined
                      ? Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ).pipe(Effect.forkChild);

              yield* adapter.startSession({
                threadId,
                provider: ProviderDriverKind.make("kimi"),
                cwd: process.cwd(),
                runtimeMode: "full-access",
              });
              const firstFiber = yield* adapter
                .sendTurn({ threadId, input: "first", attachments: [] })
                .pipe(Effect.forkChild);
              const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(
                Effect.timeout("2 seconds"),
              );
              yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
              const second = yield* adapter
                .sendTurn({ threadId, input: "second", attachments: [] })
                .pipe(Effect.timeout("2 seconds"));
              const first = yield* Fiber.join(firstFiber).pipe(Effect.timeout("2 seconds"));

              assert.equal(first.turnId, firstTurnId);
              assert.notEqual(second.turnId, firstTurnId);
              const firstCompletedIndex = runtimeEvents.findIndex(
                (event) =>
                  event.type === "turn.completed" &&
                  event.turnId === firstTurnId &&
                  event.payload.state === "cancelled",
              );
              const secondStartedIndex = runtimeEvents.findIndex(
                (event) => event.type === "turn.started" && event.turnId === second.turnId,
              );
              assert.isAtLeast(firstCompletedIndex, 0);
              assert.isAbove(secondStartedIndex, firstCompletedIndex);

              const snapshot = yield* adapter.readThread(threadId);
              assert.deepStrictEqual(
                snapshot.turns.map((turn) => turn.id),
                [first.turnId, second.turnId],
              );
              yield* Fiber.interrupt(eventsFiber);
              yield* adapter.stopSession(threadId);
            }),
          ),
      );
    },
    (tempDir) => Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true })),
  ).pipe(TestClock.withLive),
);

it.effect("rejects an empty Kimi turn before mutating session lifecycle", () =>
  withMockKimi({}, (wrapperPath) =>
    withKimiAdapter(wrapperPath, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-empty-turn-thread");
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const error = yield* adapter
          .sendTurn({ threadId, input: "   ", attachments: [] })
          .pipe(Effect.flip);
        const session = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );
        const snapshot = yield* adapter.readThread(threadId);

        assert.equal(error._tag, "ProviderAdapterValidationError");
        assert.isUndefined(session?.activeTurnId);
        assert.deepStrictEqual(snapshot.turns, []);
        yield* adapter.stopSession(threadId);
      }),
    ),
  ),
);

it.effect("interrupts a hanging Kimi turn and drops late notifications", () =>
  withMockKimi(
    {
      T3_ACP_HANG_PROMPT_FOREVER: "1",
      T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
    },
    (wrapperPath) =>
      withKimiAdapter(wrapperPath, (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("kimi-interrupt-thread");
          const runtimeEvents: ProviderRuntimeEvent[] = [];
          const turnStarted = yield* Deferred.make<TurnId>();
          const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "turn.started" && event.turnId !== undefined
                  ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("kimi"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const sendFiber = yield* adapter
            .sendTurn({ threadId, input: "wait forever", attachments: [] })
            .pipe(Effect.forkChild);
          const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
          yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
          yield* Fiber.join(sendFiber).pipe(Effect.timeout("2 seconds"));
          yield* Effect.sleep("100 millis");

          const cancelledIndex = runtimeEvents.findIndex(
            (event) => event.type === "turn.completed" && event.turnId === turnId,
          );
          assert.isAtLeast(cancelledIndex, 0);
          assert.isFalse(
            runtimeEvents.slice(cancelledIndex + 1).some((event) => event.type === "content.delta"),
          );

          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }),
      ),
  ).pipe(TestClock.withLive),
);

it.effect("ignores a malformed Kimi session update without losing the turn", () =>
  withMockKimi({ T3_ACP_EMIT_MALFORMED_SESSION_UPDATE: "1" }, (wrapperPath) =>
    withKimiAdapter(wrapperPath, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-malformed-update-thread");
        const completedEventFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const error = yield* adapter
          .sendTurn({ threadId, input: "continue after malformed update", attachments: [] })
          .pipe(Effect.flip, Effect.timeout("2 seconds"));
        const completedEvent = yield* Fiber.join(completedEventFiber).pipe(
          Effect.timeout("2 seconds"),
        );
        const session = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );

        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.isTrue(Option.isSome(completedEvent));
        if (Option.isSome(completedEvent) && completedEvent.value.type === "turn.completed") {
          assert.equal(completedEvent.value.payload.state, "failed");
        }
        assert.equal(session?.status, "error");
        assert.isUndefined(session?.activeTurnId);
        yield* adapter.stopSession(threadId);
      }),
    ),
  ),
);

it.effect("routes Kimi permissions and structured questions through canonical responses", () =>
  withMockKimi(
    {
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "kimi-allow-once",
      T3_ACP_ALLOW_ALWAYS_OPTION_ID: "kimi-allow-session",
      T3_ACP_REJECT_ONCE_OPTION_ID: "kimi-reject",
    },
    (permissionWrapperPath) =>
      withKimiAdapter(permissionWrapperPath, (permissionAdapter) =>
        Effect.gen(function* () {
          const permissionThread = ThreadId.make("kimi-permission-thread");
          yield* permissionAdapter.startSession({
            threadId: permissionThread,
            provider: ProviderDriverKind.make("kimi"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          const permissionEventFiber = yield* permissionAdapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.threadId === permissionThread && event.type === "request.opened",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          const permissionTurnFiber = yield* permissionAdapter
            .sendTurn({ threadId: permissionThread, input: "use a tool", attachments: [] })
            .pipe(Effect.forkChild);
          const permissionEvent = yield* Fiber.join(permissionEventFiber);
          assert.isTrue(Option.isSome(permissionEvent));
          if (Option.isSome(permissionEvent) && permissionEvent.value.type === "request.opened") {
            assert.isDefined(permissionEvent.value.requestId);
            assert.equal(permissionEvent.value.payload.requestType, "exec_command_approval");
            assert.include(permissionEvent.value.payload.detail, "cat server/package.json");
            yield* permissionAdapter.respondToRequest(
              permissionThread,
              ApprovalRequestId.make(permissionEvent.value.requestId!),
              "accept",
            );
          }
          yield* Fiber.join(permissionTurnFiber);
          yield* permissionAdapter.stopSession(permissionThread);
        }),
      ),
  ).pipe(
    Effect.andThen(
      withMockKimi({ T3_ACP_EMIT_KIMI_PERMISSION_QUESTION: "1" }, (questionWrapperPath) =>
        withKimiAdapter(questionWrapperPath, (questionAdapter) =>
          Effect.gen(function* () {
            const questionThread = ThreadId.make("kimi-question-thread");
            yield* questionAdapter.startSession({
              threadId: questionThread,
              provider: ProviderDriverKind.make("kimi"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            const questionEventFiber = yield* questionAdapter.streamEvents.pipe(
              Stream.filter(
                (event) =>
                  event.threadId === questionThread && event.type === "user-input.requested",
              ),
              Stream.runHead,
              Effect.forkChild,
            );
            const questionTurnFiber = yield* questionAdapter
              .sendTurn({ threadId: questionThread, input: "ask me", attachments: [] })
              .pipe(Effect.forkChild);
            const questionEvent = yield* Fiber.join(questionEventFiber);
            assert.isTrue(Option.isSome(questionEvent));
            if (
              Option.isSome(questionEvent) &&
              questionEvent.value.type === "user-input.requested"
            ) {
              assert.isDefined(questionEvent.value.requestId);
              yield* questionAdapter.respondToUserInput(
                questionThread,
                ApprovalRequestId.make(questionEvent.value.requestId!),
                { "kimi-question-1": "Workspace" },
              );
            }
            yield* Fiber.join(questionTurnFiber);
            yield* questionAdapter.stopSession(questionThread);
          }),
        ),
      ),
    ),
  ),
);

it.effect("records correlated Kimi permission and session lifecycle diagnostics", () => {
  const records: unknown[] = [];
  const nativeEventLogger: EventNdjsonLogger = {
    filePath: "memory://kimi-native-events",
    write: (event) =>
      Effect.sync(() => {
        records.push(event);
      }),
    close: () => Effect.void,
  };

  return withMockKimi(
    {
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "kimi-allow-once",
      T3_ACP_ALLOW_ALWAYS_OPTION_ID: "kimi-allow-session",
      T3_ACP_REJECT_ONCE_OPTION_ID: "kimi-reject",
    },
    (wrapperPath) =>
      withKimiAdapter(
        wrapperPath,
        (adapter) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("kimi-observability-thread");
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("kimi"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            const turn = yield* adapter.sendTurn({
              threadId,
              input: "use a tool",
              attachments: [],
            });
            yield* adapter.stopSession(threadId);

            const nativeRecords = records.filter(
              (
                record,
              ): record is {
                readonly event: {
                  readonly method: string;
                  readonly providerSessionId: string | null;
                  readonly turnId: TurnId | null;
                  readonly payload: unknown;
                };
                readonly sessionContext: {
                  readonly activeTurnId: TurnId | null;
                  readonly sendInFlight: boolean;
                  readonly stopped: boolean | null;
                };
              } =>
                typeof record === "object" &&
                record !== null &&
                "event" in record &&
                typeof record.event === "object" &&
                record.event !== null &&
                "method" in record.event &&
                typeof record.event.method === "string" &&
                "sessionContext" in record &&
                typeof record.sessionContext === "object" &&
                record.sessionContext !== null,
            );

            const permissionRequest = nativeRecords.find(
              (record) => record.event.method === "session/request_permission",
            );
            assert.equal(permissionRequest?.event.providerSessionId, "mock-session-1");
            assert.equal(permissionRequest?.event.turnId, turn.turnId);
            assert.equal(permissionRequest?.sessionContext.activeTurnId, turn.turnId);
            assert.isTrue(permissionRequest?.sessionContext.sendInFlight);

            const autoApproval = nativeRecords.find(
              (record) => record.event.method === "t3/session_permission_auto_approved",
            );
            assert.deepStrictEqual(autoApproval?.event.payload, {
              requestMethod: "session/request_permission",
              sessionId: "mock-session-1",
              toolCallId: "tool-call-1",
              toolTitle: "Bash",
              optionId: "kimi-allow-session",
              optionKind: "allow_always",
              optionCount: 3,
            });
            assert.notInclude(
              encodeUnknownJsonString(autoApproval?.event.payload),
              "cat server/package.json",
            );

            const stopRequested = nativeRecords.find(
              (record) => record.event.method === "t3/session_stop_requested",
            );
            assert.isNull(stopRequested?.sessionContext.activeTurnId);
            assert.isFalse(stopRequested?.sessionContext.sendInFlight);
            assert.isFalse(stopRequested?.sessionContext.stopped);

            const stopped = nativeRecords.find(
              (record) => record.event.method === "t3/session_stopped",
            );
            assert.isTrue(stopped?.sessionContext.stopped);
          }),
        undefined,
        nativeEventLogger,
      ),
  );
});
