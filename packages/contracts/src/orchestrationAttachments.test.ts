import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ChatDocumentAttachment,
  ChatFileAttachment,
  ClientOrchestrationCommand,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
  ThreadTurnStartCommand,
  UploadChatAttachment,
} from "./orchestration.ts";
import { ProviderSendTurnInput } from "./provider.ts";

const decodeChatDocumentAttachment = Schema.decodeUnknownSync(ChatDocumentAttachment);
const decodeChatFileAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const decodeUploadChatAttachment = Schema.decodeUnknownSync(UploadChatAttachment);
const decodeClientOrchestrationCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeThreadTurnStartCommand = Schema.decodeUnknownSync(ThreadTurnStartCommand);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

const persistedImage = (index: number) => ({
  type: "image",
  id: `image-${index}`,
  name: `image-${index}.png`,
  mimeType: "image/png",
  sizeBytes: 128,
});

const persistedDocument = (index: number) => ({
  type: "document",
  id: `document-${index}`,
  name: `document-${index}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 256,
});

const uploadImage = (index: number) => ({
  type: "image",
  name: `image-${index}.png`,
  mimeType: "image/png",
  sizeBytes: 128,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
});

const uploadDocument = (index: number) => ({
  type: "document",
  name: `document-${index}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 256,
  dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
});

const persistedFile = (index: number) => ({
  type: "file",
  id: `file-${index}`,
  name: `data-${index}.json`,
  mimeType: "application/json",
  sizeBytes: 64,
});

const uploadFile = (index: number) => ({
  type: "file",
  name: `data-${index}.json`,
  mimeType: "application/json",
  sizeBytes: 64,
  dataUrl: "data:application/json;base64,eyJhIjoxfQ==",
});

const clientTurnStart = (attachments: ReadonlyArray<Record<string, unknown>>) => ({
  type: "thread.turn.start",
  commandId: "command-1",
  threadId: "thread-1",
  message: {
    messageId: "message-1",
    role: "user",
    text: "",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const persistedTurnStart = (attachments: ReadonlyArray<Record<string, unknown>>) => ({
  type: "thread.turn.start",
  commandId: "command-1",
  threadId: "thread-1",
  message: {
    messageId: "message-1",
    role: "user",
    text: "",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("PDF attachment schemas", () => {
  it("accepts persisted PDF metadata and PDF upload envelopes", () => {
    const persisted = decodeChatDocumentAttachment({
      ...persistedDocument(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES,
    });
    const upload = decodeUploadChatAttachment({
      ...uploadDocument(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES,
    });

    expect(persisted).toEqual({
      ...persistedDocument(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES,
    });
    expect(upload).toEqual({
      ...uploadDocument(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES,
    });
  });

  it.each([
    ["missing", undefined],
    ["an image MIME", "image/png"],
    ["a differently cased PDF MIME", "application/PDF"],
  ])("rejects persisted PDFs with %s MIME metadata", (_label, mimeType) => {
    expect(() =>
      decodeChatDocumentAttachment({
        ...persistedDocument(1),
        mimeType,
      }),
    ).toThrow();
  });

  it.each([
    ["missing", undefined],
    ["an image MIME", "image/png"],
    ["a differently cased PDF MIME", "application/PDF"],
  ])("rejects PDF uploads with %s MIME metadata", (_label, mimeType) => {
    expect(() =>
      decodeUploadChatAttachment({
        ...uploadDocument(1),
        mimeType,
      }),
    ).toThrow();
  });

  it("accepts the PDF size boundary and rejects values outside it", () => {
    expect(() =>
      decodeChatDocumentAttachment({
        ...persistedDocument(1),
        sizeBytes: 0,
      }),
    ).not.toThrow();
    expect(() =>
      decodeUploadChatAttachment({
        ...uploadDocument(1),
        sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES,
      }),
    ).not.toThrow();
    expect(() =>
      decodeChatDocumentAttachment({
        ...persistedDocument(1),
        sizeBytes: -1,
      }),
    ).toThrow();
    expect(() =>
      decodeUploadChatAttachment({
        ...uploadDocument(1),
        sizeBytes: PROVIDER_SEND_TURN_MAX_PDF_BYTES + 1,
      }),
    ).toThrow();
  });
});

describe("generic file attachment schemas", () => {
  it("accepts persisted file metadata and file upload envelopes", () => {
    const persisted = decodeChatFileAttachment({
      ...persistedFile(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    });
    const upload = decodeUploadChatAttachment({
      ...uploadFile(1),
      sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    });

    expect(persisted.type).toBe("file");
    expect(upload.type).toBe("file");
  });

  it.each([
    ["missing", undefined],
    ["a non-registry MIME", "application/x-msdownload"],
    ["a browser-guessed MIME for .ts", "video/mp2t"],
  ])("rejects file attachments with %s MIME metadata", (_label, mimeType) => {
    expect(() =>
      decodeChatFileAttachment({
        ...persistedFile(1),
        mimeType,
      }),
    ).toThrow();
    expect(() =>
      decodeUploadChatAttachment({
        ...uploadFile(1),
        mimeType,
      }),
    ).toThrow();
  });

  it("accepts the file size boundary and rejects values outside it", () => {
    expect(() =>
      decodeChatFileAttachment({
        ...persistedFile(1),
        sizeBytes: 0,
      }),
    ).not.toThrow();
    expect(() =>
      decodeChatFileAttachment({
        ...persistedFile(1),
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeUploadChatAttachment({
        ...uploadFile(1),
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toThrow();
  });
});

describe("mixed attachment arrays", () => {
  it("preserves image and document variants in persisted and upload turns", () => {
    const persisted = decodeThreadTurnStartCommand(
      persistedTurnStart([persistedImage(1), persistedDocument(1), persistedImage(2)]),
    );
    const upload = decodeClientOrchestrationCommand(
      clientTurnStart([uploadDocument(1), uploadImage(1), uploadDocument(2)]),
    );

    expect(persisted.message.attachments.map((attachment) => attachment.type)).toEqual([
      "image",
      "document",
      "image",
    ]);
    if (upload.type !== "thread.turn.start") {
      throw new Error("expected thread.turn.start command");
    }
    expect(upload.message.attachments.map((attachment) => attachment.type)).toEqual([
      "document",
      "image",
      "document",
    ]);
  });

  it("shares the eight-attachment limit across persisted images, PDFs, and files", () => {
    const eightAttachments = [
      ...Array.from({ length: 3 }, (_, index) => persistedImage(index)),
      ...Array.from({ length: 3 }, (_, index) => persistedDocument(index)),
      ...Array.from({ length: 2 }, (_, index) => persistedFile(index)),
    ];
    const nineAttachments = [...eightAttachments, persistedFile(5)];

    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        attachments: eightAttachments,
      }),
    ).not.toThrow();
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        attachments: nineAttachments,
      }),
    ).toThrow();
    expect(eightAttachments).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  });

  it("shares the eight-attachment limit across image, PDF, and file uploads", () => {
    const eightAttachments = [
      ...Array.from({ length: 3 }, (_, index) => uploadImage(index)),
      ...Array.from({ length: 3 }, (_, index) => uploadDocument(index)),
      ...Array.from({ length: 2 }, (_, index) => uploadFile(index)),
    ];
    const nineAttachments = [...eightAttachments, uploadFile(5)];

    expect(() => decodeClientOrchestrationCommand(clientTurnStart(eightAttachments))).not.toThrow();
    expect(() => decodeClientOrchestrationCommand(clientTurnStart(nineAttachments))).toThrow();
    expect(() => decodeThreadTurnStartCommand(persistedTurnStart([]))).not.toThrow();
  });
});
