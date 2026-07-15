// oxlint-disable t3code/no-manual-effect-runtime-in-tests
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
  ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { assert, describe, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as ServerConfigModule from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { validateAttachmentPayload } from "./AttachmentPayload.ts";
import { dispatchNormalizedCommandWithCleanup, normalizeDispatchCommand } from "./Normalizer.ts";

type UploadDocumentAttachment = Extract<UploadChatAttachment, { readonly type: "document" }>;
type UploadFileAttachment = Extract<UploadChatAttachment, { readonly type: "file" }>;

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");
const JSON_BYTES = Buffer.from('{"hello":"world"}\n', "utf8");
const XLSX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("stub-xlsx-content", "utf8"),
]);

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function pdfUpload(overrides: Partial<UploadDocumentAttachment> = {}): UploadDocumentAttachment {
  return {
    type: "document",
    name: "specification.pdf",
    mimeType: "application/pdf",
    sizeBytes: PDF_BYTES.byteLength,
    dataUrl: dataUrl("application/pdf", PDF_BYTES),
    ...overrides,
  };
}

function fileUpload(overrides: Partial<UploadFileAttachment> = {}): UploadFileAttachment {
  return {
    type: "file",
    name: "data.json",
    mimeType: "application/json",
    sizeBytes: JSON_BYTES.byteLength,
    dataUrl: dataUrl("application/json", JSON_BYTES),
    ...overrides,
  };
}

function turnStartCommand(
  attachments: ReadonlyArray<UploadChatAttachment>,
): Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-pdf-normalizer"),
    threadId: ThreadId.make("thread-pdf-normalizer"),
    message: {
      messageId: MessageId.make("message-pdf-normalizer"),
      role: "user",
      text: "",
      attachments: [...attachments],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const configLayer = ServerConfigModule.layerTest(process.cwd(), {
  prefix: "t3-pdf-normalizer-test-",
});
const testLayer = Layer.mergeAll(configLayer, WorkspacePaths.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const effectIt = <A, E>(name: string, effect: () => Effect.Effect<A, E, Scope.Scope>): void => {
  it(name, () => Effect.runPromise(Effect.scoped(effect())));
};

describe("PDF attachment payload validation", () => {
  effectIt("accepts a valid PDF and canonicalizes its MIME type", () =>
    Effect.gen(function* () {
      const validated = yield* validateAttachmentPayload(pdfUpload());

      assert.deepEqual(validated.attachment, {
        type: "document",
        name: "specification.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
      });
      assert.deepEqual(validated.bytes, PDF_BYTES);
    }),
  );

  effectIt("accepts filename-based browser MIME fallback for PDFs", () =>
    Effect.gen(function* () {
      const validated = yield* validateAttachmentPayload(
        pdfUpload({
          name: "Browser Export.PDF",
          mimeType: "" as "application/pdf",
          dataUrl: dataUrl("application/octet-stream", PDF_BYTES),
        }),
      );

      assert.equal(validated.attachment.mimeType, "application/pdf");
      assert.equal(validated.attachment.name, "Browser Export.PDF");
    }),
  );

  effectIt("rejects spoofed PDF content without a signature in the first 1,024 bytes", () =>
    Effect.gen(function* () {
      const spoofed = Buffer.concat([Buffer.alloc(1_024, 0x20), PDF_BYTES]);
      const error = yield* validateAttachmentPayload(
        pdfUpload({ sizeBytes: spoofed.byteLength, dataUrl: dataUrl("application/pdf", spoofed) }),
      ).pipe(Effect.flip);

      assert.include(error.message, "valid PDF signature");
    }),
  );

  effectIt("rejects malformed base64", () =>
    Effect.gen(function* () {
      const error = yield* validateAttachmentPayload(
        pdfUpload({ sizeBytes: 5, dataUrl: "data:application/pdf;base64,AAAA=AAA" }),
      ).pipe(Effect.flip);

      assert.include(error.message, "Invalid base64 payload");
    }),
  );

  effectIt("rejects a declared PDF size that differs from decoded bytes", () =>
    Effect.gen(function* () {
      const error = yield* validateAttachmentPayload(
        pdfUpload({ sizeBytes: PDF_BYTES.byteLength + 1 }),
      ).pipe(Effect.flip);

      assert.include(error.message, "declared size does not match");
    }),
  );

  effectIt("rejects a PDF larger than 10 MiB", () =>
    Effect.gen(function* () {
      const oversized = Buffer.alloc(PROVIDER_SEND_TURN_MAX_PDF_BYTES + 1, 0x20);
      PDF_BYTES.copy(oversized, 0, 0, Math.min(PDF_BYTES.byteLength, oversized.byteLength));
      const error = yield* validateAttachmentPayload(
        pdfUpload({
          sizeBytes: oversized.byteLength,
          dataUrl: dataUrl("application/pdf", oversized),
        }),
      ).pipe(Effect.flip);

      assert.include(error.message, "10 MiB limit");
    }),
  );
});

describe("generic file attachment payload validation", () => {
  effectIt("accepts a text file and stamps the canonical registry MIME type", () =>
    Effect.gen(function* () {
      const validated = yield* validateAttachmentPayload(
        fileUpload({
          name: "video.ts",
          mimeType: "text/x-typescript",
          dataUrl: dataUrl("video/mp2t", JSON_BYTES),
        }),
      );

      assert.deepEqual(validated.attachment, {
        type: "file",
        name: "video.ts",
        mimeType: "text/x-typescript",
        sizeBytes: JSON_BYTES.byteLength,
      });
      assert.deepEqual(validated.bytes, JSON_BYTES);
    }),
  );

  effectIt("rejects a binary renamed to .txt", () =>
    Effect.gen(function* () {
      const binary = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]);
      const error = yield* validateAttachmentPayload(
        fileUpload({
          name: "data.txt",
          mimeType: "text/plain",
          sizeBytes: binary.byteLength,
          dataUrl: dataUrl("text/plain", binary),
        }),
      ).pipe(Effect.flip);

      assert.include(error.message, "not a readable text file");
      assert.include(error.message, "data.txt");
    }),
  );

  effectIt("transcodes BOM-prefixed UTF-16 text to UTF-8 instead of rejecting it", () =>
    Effect.gen(function* () {
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("name,total\nwidgets,42\n", "utf16le"),
      ]);
      const validated = yield* validateAttachmentPayload(
        fileUpload({
          name: "sales.csv",
          mimeType: "text/csv",
          sizeBytes: utf16.byteLength,
          dataUrl: dataUrl("text/csv", utf16),
        }),
      );

      assert.equal(
        validated.bytes.every((byte) => byte !== 0),
        true,
      );
      assert.equal(Buffer.from(validated.bytes).toString("utf8"), "name,total\nwidgets,42\n");
      assert.equal(validated.attachment.sizeBytes, validated.bytes.byteLength);
    }),
  );

  effectIt("accepts a valid xlsx by ZIP signature", () =>
    Effect.gen(function* () {
      const validated = yield* validateAttachmentPayload(
        fileUpload({
          name: "report.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: XLSX_BYTES.byteLength,
          dataUrl: dataUrl(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            XLSX_BYTES,
          ),
        }),
      );

      assert.equal(validated.attachment.type, "file");
      assert.equal(
        validated.attachment.mimeType,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    }),
  );

  effectIt("rejects an xlsx without the ZIP signature", () =>
    Effect.gen(function* () {
      const fake = Buffer.from("this is not a zip archive", "utf8");
      const error = yield* validateAttachmentPayload(
        fileUpload({
          name: "report.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: fake.byteLength,
          dataUrl: dataUrl(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            fake,
          ),
        }),
      ).pipe(Effect.flip);

      assert.include(error.message, "report.xlsx");
      assert.include(error.message, "not a valid spreadsheet");
    }),
  );

  effectIt("rejects file names without a registered extension", () =>
    Effect.gen(function* () {
      const error = yield* validateAttachmentPayload(
        fileUpload({ name: "installer.exe", mimeType: "application/json" }),
      ).pipe(Effect.flip);

      assert.include(error.message, "unsupported file extension");
    }),
  );

  effectIt("rejects a declared file size that differs from decoded bytes", () =>
    Effect.gen(function* () {
      const error = yield* validateAttachmentPayload(
        fileUpload({ sizeBytes: JSON_BYTES.byteLength + 1 }),
      ).pipe(Effect.flip);

      assert.include(error.message, "declared size does not match");
    }),
  );
});

describe("normalizeDispatchCommand attachments", () => {
  effectIt("persists mixed image and PDF attachments in their submitted order", () =>
    Effect.gen(function* () {
      const imageBytes = Buffer.from([1, 2, 3]);
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand([
          {
            type: "image",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 999,
            dataUrl: dataUrl("image/png", imageBytes),
          },
          pdfUpload(),
        ]),
      );
      if (normalized.command.type !== "thread.turn.start") {
        assert.fail("Expected a normalized thread.turn.start command");
      }

      assert.deepEqual(
        normalized.command.message.attachments.map((attachment) => attachment.type),
        ["image", "document"],
      );
      assert.equal(normalized.command.message.attachments[0]?.sizeBytes, imageBytes.byteLength);
      assert.equal(normalized.command.message.attachments[1]?.mimeType, "application/pdf");

      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const entries = (yield* fileSystem.readDirectory(attachmentsDir)).toSorted();
      assert.equal(entries.length, 2);
      assert.isTrue(entries.some((entry) => entry.endsWith(".png")));
      assert.isTrue(entries.some((entry) => entry.endsWith(".pdf")));
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt("does not persist earlier valid files when any attachment fails validation", () =>
    Effect.gen(function* () {
      const invalidPdf = Buffer.from("not a pdf", "utf8");
      const error = yield* normalizeDispatchCommand(
        turnStartCommand([
          pdfUpload(),
          pdfUpload({
            name: "spoofed.pdf",
            sizeBytes: invalidPdf.byteLength,
            dataUrl: dataUrl("application/pdf", invalidPdf),
          }),
        ]),
      ).pipe(Effect.flip);
      assert.include(error.message, "valid PDF signature");

      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepEqual(yield* fileSystem.readDirectory(attachmentsDir), []);
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt("removes only freshly-created attachments when downstream dispatch fails", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sentinelPath = path.join(attachmentsDir, "preexisting.pdf");
      yield* fileSystem.writeFileString(sentinelPath, "keep");

      const normalized = yield* normalizeDispatchCommand(turnStartCommand([pdfUpload()]));
      yield* Effect.exit(
        dispatchNormalizedCommandWithCleanup(normalized, () => Effect.fail("dispatch failed")),
      );

      assert.deepEqual(yield* fileSystem.readDirectory(attachmentsDir), ["preexisting.pdf"]);
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt("removes freshly-created attachments when downstream dispatch is interrupted", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStartCommand([pdfUpload()]));
      yield* Effect.exit(dispatchNormalizedCommandWithCleanup(normalized, () => Effect.interrupt));

      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepEqual(yield* fileSystem.readDirectory(attachmentsDir), []);
    }).pipe(Effect.provide(testLayer)),
  );

  effectIt("preserves freshly-created attachments after successful dispatch", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStartCommand([pdfUpload()]));
      yield* dispatchNormalizedCommandWithCleanup(normalized, () =>
        Effect.succeed({ sequence: 1 }),
      );

      const { attachmentsDir } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const entries = yield* fileSystem.readDirectory(attachmentsDir);
      assert.equal(entries.length, 1);
      assert.isTrue(entries[0]?.endsWith(".pdf") === true);
    }).pipe(Effect.provide(testLayer)),
  );
});
