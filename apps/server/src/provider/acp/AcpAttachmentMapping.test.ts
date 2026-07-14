// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ChatAttachment } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { mapAcpAttachments } from "./AcpAttachmentMapping.ts";

const makeTempAttachmentsDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-attachments-"));

const writeAttachment = (attachmentsDir: string, attachment: ChatAttachment, bytes: Uint8Array) => {
  const filePath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, bytes);
  return filePath;
};

for (const provider of ["cursor", "grok"] as const) {
  it.effect(`maps a PDF-only ${provider} turn to one ACP resource link`, () =>
    Effect.gen(function* () {
      const attachmentsDir = makeTempAttachmentsDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const pdf = {
        type: "document" as const,
        id: `${provider}-only-pdf-12345678-1234-1234-1234-123456789abc`,
        name: "only.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 8,
      };
      const pdfPath = writeAttachment(attachmentsDir, pdf, new TextEncoder().encode("%PDF-1.7"));

      const blocks = yield* mapAcpAttachments({
        provider,
        method: "session/prompt",
        attachmentsDir,
        attachments: [pdf],
        fileSystem,
      });

      NodeAssert.deepStrictEqual(blocks, [
        {
          type: "resource_link",
          name: "only.pdf",
          mimeType: "application/pdf",
          size: 8,
          uri: NodeURL.pathToFileURL(pdfPath).href,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`maps ordered image and PDF attachments for ${provider} ACP prompts`, () =>
    Effect.gen(function* () {
      const attachmentsDir = makeTempAttachmentsDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const image = {
        type: "image" as const,
        id: `${provider}-image-12345678-1234-1234-1234-123456789abc`,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const pdf = {
        type: "document" as const,
        id: `${provider}-pdf-12345678-1234-1234-1234-123456789abc`,
        name: "requirements.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 9,
      };
      writeAttachment(attachmentsDir, image, Uint8Array.from([1, 2, 3]));
      const pdfPath = writeAttachment(attachmentsDir, pdf, new TextEncoder().encode("%PDF-1.7"));

      const blocks = yield* mapAcpAttachments({
        provider,
        method: "session/prompt",
        attachmentsDir,
        attachments: [image, pdf],
        fileSystem,
      });

      NodeAssert.deepStrictEqual(blocks, [
        {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
        },
        {
          type: "resource_link",
          name: "requirements.pdf",
          mimeType: "application/pdf",
          size: 9,
          uri: NodeURL.pathToFileURL(pdfPath).href,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`rejects invalid ${provider} PDF attachment paths`, () =>
    Effect.gen(function* () {
      const attachmentsDir = makeTempAttachmentsDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const result = yield* mapAcpAttachments({
        provider,
        method: "session/prompt",
        attachmentsDir,
        attachments: [
          {
            type: "document",
            id: "../outside",
            name: "outside.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        ],
        fileSystem,
      }).pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(result.failure.provider, provider);
        NodeAssert.equal(result.failure.detail, "Invalid attachment id '../outside'.");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`rejects missing ${provider} PDF attachment files`, () =>
    Effect.gen(function* () {
      const attachmentsDir = makeTempAttachmentsDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const result = yield* mapAcpAttachments({
        provider,
        method: "session/prompt",
        attachmentsDir,
        attachments: [
          {
            type: "document",
            id: `${provider}-missing-12345678-1234-1234-1234-123456789abc`,
            name: "missing.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        ],
        fileSystem,
      }).pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(result.failure.provider, provider);
        NodeAssert.match(result.failure.detail, /Failed to read attachment 'missing\.pdf'/u);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`rejects ${provider} PDF paths that resolve to directories`, () =>
    Effect.gen(function* () {
      const attachmentsDir = makeTempAttachmentsDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        type: "document" as const,
        id: `${provider}-directory-12345678-1234-1234-1234-123456789abc`,
        name: "directory.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 1,
      };
      NodeFS.mkdirSync(NodePath.join(attachmentsDir, attachmentRelativePath(attachment)));

      const result = yield* mapAcpAttachments({
        provider,
        method: "session/prompt",
        attachmentsDir,
        attachments: [attachment],
        fileSystem,
      }).pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.match(result.failure.detail, /is not a file/u);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
