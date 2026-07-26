import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand", () => {
  const run = (command: ClientOrchestrationCommand) =>
    Effect.runPromise(
      normalizeDispatchCommand(command).pipe(
        Effect.provide(WorkspacePaths.layer),
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" })),
        Effect.provide(NodeServices.layer),
      ),
    );

  // A client cannot claim a task was the agent's idea, and the client command
  // carries no `createdBy` at all — so it must be stamped here or the projector
  // rejects the event it produces.
  it("stamps user authorship on a client task creation", async () => {
    const { command } = await run({
      type: "thread.task.create",
      commandId: CommandId.make("command-task"),
      parentThreadId: ThreadId.make("thread-1"),
      taskThreadId: ThreadId.make("thread-2"),
      title: "Inventory handlers",
      prompt: "List every handler.",
      context: { kind: "full-thread" },
      createdAt: clientCreatedAt,
    });

    expect(command.type).toBe("thread.task.create");
    if (command.type !== "thread.task.create") throw new Error("Expected a task create command");
    expect(command.createdBy).toBe("user");
    expect(command.createdAt).not.toBe(clientCreatedAt);
  });
});
