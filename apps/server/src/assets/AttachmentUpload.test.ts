// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./AttachmentUpload.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-upload-" })),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 6,
} as const;

describe("AttachmentUpload", () => {
  it.effect("signs the attachment metadata and validates the upload token", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      expect(parseThreadSegmentFromAttachmentId(issued.attachmentId)).toBe("pending");

      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      expect(yield* validateAttachmentUploadToken(token)).toMatchObject({
        kind: "attachment-upload",
        attachmentId: issued.attachmentId,
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 6,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered and malformed upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateAttachmentUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateAttachmentUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateAttachmentUploadToken("garbage")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired upload tokens", () =>
    Effect.gen(function* () {
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);

      yield* TestClock.adjust("11 minutes");
      expect(yield* validateAttachmentUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes expired pending uploads while issuing a new upload URL", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const staleId = "pending-00000000-0000-4000-8000-0000000000cc";
      const stalePath = NodePath.join(config.attachmentsDir, `${staleId}.png`);
      NodeFS.writeFileSync(stalePath, Buffer.from("pixels"));
      NodeFS.utimesSync(stalePath, 0, 0);

      yield* TestClock.adjust("25 hours");
      yield* issueAttachmentUploadUrl(uploadInput);

      expect(NodeFS.existsSync(stalePath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores the expected bytes without leaving temporary files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }

      expect(yield* storeAttachmentUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeAttachmentUpload(claims, new Uint8Array(6))).toEqual({ ok: true });
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`)),
      ).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.endsWith(".part")),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims pending uploads through the transactional attachment stage", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const issued = yield* issueAttachmentUploadUrl(uploadInput);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      if (!claims) {
        throw new Error("Expected valid upload claims.");
      }
      yield* storeAttachmentUpload(claims, Buffer.from("pixels"));

      const normalized = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("command-pending-upload"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-pending-upload"),
          role: "user",
          text: "inspect this",
          attachments: [
            {
              type: "image",
              id: issued.attachmentId,
              name: uploadInput.name,
              mimeType: uploadInput.mimeType,
              sizeBytes: uploadInput.sizeBytes,
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      if (normalized.command.type !== "thread.turn.start" || !normalized.attachmentStage) {
        throw new Error("Expected a staged thread.turn.start command.");
      }

      const attachment = normalized.command.message.attachments[0]!;
      const pendingPath = NodePath.join(config.attachmentsDir, `${issued.attachmentId}.png`);
      const finalPath = NodePath.join(config.attachmentsDir, `${attachment.id}.png`);
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(NodeFS.existsSync(finalPath)).toBe(false);

      yield* normalized.attachmentStage.claim;
      yield* normalized.attachmentStage.commit;
      expect(NodeFS.readFileSync(finalPath)).toEqual(Buffer.from("pixels"));
      expect(NodeFS.existsSync(pendingPath)).toBe(true);

      yield* normalized.attachmentStage.complete;
      yield* deletePendingAttachment(issued.attachmentId);
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes pending uploads without deleting thread-owned copies", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const uuid = "00000000-0000-4000-8000-0000000000dd";
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${uuid}.png`);
      const claimedPath = NodePath.join(config.attachmentsDir, `thread-1-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));
      NodeFS.writeFileSync(claimedPath, Buffer.from("pixels"));

      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`pending-${uuid}`);
      yield* deletePendingAttachment(`thread-1-${uuid}`);

      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
