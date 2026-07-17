// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { attachmentRelativePath } from "../attachmentStore.ts";
import { mapAcpAttachments } from "./acpAttachments.ts";
import { providerFileUri } from "./attachmentDelivery.ts";

const THREAD_ID = ThreadId.make("thread-acp-mapper");

const image = {
  type: "image" as const,
  id: "thread-acp-mapper-12345678-1234-1234-1234-123456789abc",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 2,
};
const document = {
  type: "document" as const,
  id: "thread-acp-mapper-22345678-1234-1234-1234-123456789abc",
  name: "design.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: 3,
};
const file = {
  type: "file" as const,
  id: "thread-acp-mapper-32345678-1234-1234-1234-123456789abc",
  name: "report.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 4,
};

function writeAttachment(
  attachmentsDir: string,
  attachment: ChatAttachment,
  bytes: Uint8Array,
): string {
  const filePath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, bytes);
  return filePath;
}

it.effect("maps mixed ACP attachments in order with image and resource-link shapes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-mapper-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
    );
    writeAttachment(attachmentsDir, image, Uint8Array.from([1, 2]));
    const documentPath = writeAttachment(attachmentsDir, document, Uint8Array.from([3, 4, 5]));
    const filePath = writeAttachment(
      attachmentsDir,
      file,
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
    );

    const blocks = yield* mapAcpAttachments({
      attachmentsDir,
      threadId: THREAD_ID,
      attachments: [document, image, file],
      fileSystem,
    });

    NodeAssert.deepStrictEqual(blocks, [
      {
        type: "resource_link",
        name: "design.pdf",
        mimeType: "application/pdf",
        size: 3,
        uri: providerFileUri(documentPath),
      },
      {
        type: "image",
        data: "AQI=",
        mimeType: "image/png",
      },
      {
        type: "resource_link",
        name: "report.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 4,
        uri: providerFileUri(filePath),
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a missing ACP attachment instead of returning a partial mapping", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-missing-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
    );
    writeAttachment(attachmentsDir, image, Uint8Array.from([1, 2]));

    const error = yield* mapAcpAttachments({
      attachmentsDir,
      threadId: THREAD_ID,
      attachments: [image, document],
      fileSystem,
    }).pipe(Effect.flip);

    NodeAssert.equal(error._tag, "ProviderAttachmentAccessError");
    NodeAssert.match(error.message, /design\.pdf/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects an unknown ACP attachment kind exhaustively", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-unknown-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
    );
    const unknownAttachment = {
      type: "archive",
      id: "thread-acp-mapper-42345678-1234-1234-1234-123456789abc",
      name: "bundle.zip",
      mimeType: "application/zip",
      sizeBytes: 1,
    } as unknown as ChatAttachment;

    const error = yield* mapAcpAttachments({
      attachmentsDir,
      threadId: THREAD_ID,
      attachments: [unknownAttachment],
      fileSystem,
    }).pipe(Effect.flip);

    NodeAssert.equal(error._tag, "UnsupportedAcpAttachmentError");
    NodeAssert.match(error.message, /archive/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
