// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-attachments-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const attachmentUuid = "00000000-0000-4000-8000-0000000000aa";

function turnStartCommand(input: {
  readonly threadId?: string;
  readonly attachments: ReadonlyArray<
    | { readonly id: string; readonly sizeBytes: number; readonly mimeType?: string }
    | { readonly dataUrl: string; readonly sizeBytes: number; readonly mimeType?: string }
  >;
}): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("command-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "look at this",
      attachments: input.attachments.map((attachment) => ({
        type: "image" as const,
        name: "screenshot.png",
        ...attachment,
        mimeType: attachment.mimeType ?? "image/png",
      })),
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("normalizeDispatchCommand attachments", () => {
  it.effect("preserves inline image attachments from existing mobile clients", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ dataUrl: "data:image/png;base64,cGl4ZWxz", sizeBytes: 6 }],
        }),
      );
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const attachment = normalized.command.message.attachments[0]!;
      expect(attachment.id.startsWith("thread-1-")).toBe(true);
      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${attachment.id}.png`)),
      ).toEqual(Buffer.from("pixels"));
      yield* normalized.attachmentStage.complete;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims uploaded attachments while retaining a retryable pending copy", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`);
      NodeFS.writeFileSync(pendingPath, bytes);

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const attachmentId = normalized.command.message.attachments[0]!.id;
      expect(attachmentId.startsWith("thread-1-")).toBe(true);
      expect(attachmentId).not.toBe(`thread-1-${attachmentUuid}`);
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${attachmentId}.png`))).toBe(
        false,
      );

      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${attachmentId}.png`))).toBe(
        true,
      );
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      yield* normalized.attachmentStage.complete;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("normalizes inline and uploaded attachments in the same turn", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        Buffer.from("pixels"),
      );

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [
            { dataUrl: "data:image/png;base64,cGl4ZWxz", sizeBytes: 6 },
            { id: `pending-${attachmentUuid}`, sizeBytes: 6 },
          ],
        }),
      );
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      expect(normalized.command.message.attachments).toHaveLength(2);
      expect(normalized.command.message.attachments[1]?.id.startsWith("thread-1-")).toBe(true);
      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      yield* normalized.attachmentStage.complete;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims uploaded generic files without changing their original extension", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingId = `pending-${attachmentUuid}-pdf`;
      const pendingPath = NodePath.join(config.attachmentsDir, `${pendingId}.pdf`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("report"));

      const imageCommand = turnStartCommand({ attachments: [] });
      if (imageCommand.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }
      const normalized = yield* normalizeDispatchCommand({
        ...imageCommand,
        message: {
          ...imageCommand.message,
          attachments: [
            {
              type: "file",
              id: pendingId,
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
            },
          ],
        },
      });
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const attachment = normalized.command.message.attachments[0]!;
      expect(attachment.type).toBe("file");
      expect(attachment.id).toMatch(/^thread-1-.*-pdf$/);
      const claimedPath = NodePath.join(config.attachmentsDir, `${attachment.id}.pdf`);
      expect(NodeFS.existsSync(claimedPath)).toBe(false);
      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      expect(NodeFS.readFileSync(claimedPath)).toEqual(Buffer.from("report"));
      expect(NodeFS.statSync(claimedPath).ino).not.toBe(NodeFS.statSync(pendingPath).ino);
      yield* normalized.attachmentStage.complete;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retries a failed bootstrap with a fresh thread id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        bytes,
      );

      const first = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      if (first.command.type !== "thread.turn.start" || !first.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }
      yield* first.attachmentStage.claim;
      yield* first.attachmentStage.commit;
      yield* first.attachmentStage.abort;

      const retried = yield* normalizeDispatchCommand(
        turnStartCommand({
          threadId: "thread-retry",
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      if (retried.command.type !== "thread.turn.start" || !retried.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }
      const retriedAttachment = retried.command.message.attachments[0]!;
      expect(retriedAttachment.id.startsWith("thread-retry-")).toBe(true);
      yield* retried.attachmentStage.claim;
      yield* retried.attachmentStage.commit;
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${retriedAttachment.id}.png`)),
      ).toBe(true);
      yield* retried.attachmentStage.complete;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("aborts failed attachment stages without deleting pending uploads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [
            { dataUrl: "data:image/png;base64,cGl4ZWxz", sizeBytes: 6 },
            { id: `pending-${attachmentUuid}`, sizeBytes: 6 },
          ],
        }),
      );
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const inlinePath = NodePath.join(
        config.attachmentsDir,
        `${normalized.command.message.attachments[0]!.id}.png`,
      );
      const claimedPath = NodePath.join(
        config.attachmentsDir,
        `${normalized.command.message.attachments[1]!.id}.png`,
      );
      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      expect(NodeFS.existsSync(inlinePath)).toBe(true);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
      yield* normalized.attachmentStage.abort;

      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(NodeFS.existsSync(claimedPath)).toBe(false);
      expect(NodeFS.existsSync(inlinePath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes a failed claimed copy after its pending original was removed", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 6 }],
        }),
      );
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const claimedPath = NodePath.join(
        config.attachmentsDir,
        `${normalized.command.message.attachments[0]!.id}.png`,
      );
      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      NodeFS.rmSync(pendingPath);

      yield* normalized.attachmentStage.abort;

      expect(NodeFS.existsSync(claimedPath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps concurrent claims independent when one dispatch fails", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      const command = turnStartCommand({
        attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 6 }],
      });

      const [failed, succeeded] = yield* Effect.all(
        [normalizeDispatchCommand(command), normalizeDispatchCommand(command)],
        { concurrency: 2 },
      );
      if (
        failed.command.type !== "thread.turn.start" ||
        !failed.attachmentStage ||
        succeeded.command.type !== "thread.turn.start" ||
        !succeeded.attachmentStage
      ) {
        throw new Error("Expected staged thread.turn.start commands.");
      }

      const failedPath = NodePath.join(
        config.attachmentsDir,
        `${failed.command.message.attachments[0]!.id}.png`,
      );
      const succeededPath = NodePath.join(
        config.attachmentsDir,
        `${succeeded.command.message.attachments[0]!.id}.png`,
      );
      expect(failedPath).not.toBe(succeededPath);

      yield* failed.attachmentStage.claim;
      yield* failed.attachmentStage.commit;
      yield* succeeded.attachmentStage.claim;
      yield* succeeded.attachmentStage.commit;
      yield* failed.attachmentStage.abort;
      yield* succeeded.attachmentStage.complete;

      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(NodeFS.existsSync(failedPath)).toBe(false);
      expect(NodeFS.existsSync(succeededPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes earlier claimed copies when a later attachment cannot be normalized", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingId = `pending-${attachmentUuid}`;
      const pendingPath = NodePath.join(config.attachmentsDir, `${pendingId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const failure = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [
            { id: pendingId, sizeBytes: 6 },
            {
              id: "pending-00000000-0000-4000-8000-0000000000ff",
              sizeBytes: 6,
            },
          ],
        }),
      ).pipe(Effect.flip);

      expect(failure.message).toContain("not found");
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([`${pendingId}.png`]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects uploaded attachments with the wrong size or thread", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        Buffer.from("pixels"),
      );

      const wrongSize = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 999 }],
        }),
      ).pipe(Effect.flip);
      expect(wrongSize.message).toContain("size");

      const wrongThread = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `another-thread-${attachmentUuid}`, sizeBytes: 6 }],
        }),
      ).pipe(Effect.flip);
      expect(wrongThread.message).toContain("pending upload");

      const mismatchedType = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 6, mimeType: "image/jpeg" }],
        }),
      ).pipe(Effect.flip);
      expect(mismatchedType.message).toContain("attachment type");
    }).pipe(Effect.provide(testLayer)),
  );
});
