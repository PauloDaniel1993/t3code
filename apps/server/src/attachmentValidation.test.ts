import { it } from "@effect/vitest";
import type { UploadChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { validateUploadAttachments } from "./attachmentValidation.ts";

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function upload(
  attachment: Omit<UploadChatAttachment, "dataUrl" | "sizeBytes"> & {
    readonly bytes: Uint8Array;
    readonly dataUrl?: string;
    readonly sizeBytes?: number;
  },
): UploadChatAttachment {
  const { bytes, dataUrl: suppliedDataUrl, sizeBytes, ...metadata } = attachment;
  return {
    ...metadata,
    sizeBytes: sizeBytes ?? bytes.byteLength,
    dataUrl: suppliedDataUrl ?? dataUrl(metadata.mimeType, bytes),
  } as UploadChatAttachment;
}

const invalidBase64Cases = [
  {
    label: "malformed base64",
    attachment: upload({
      type: "file",
      name: "malformed.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello"),
      dataUrl: "data:text/plain;base64,SGVsbG8*",
    }),
  },
  {
    label: "non-canonical base64 padding bits",
    attachment: upload({
      type: "file",
      name: "noncanonical.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("M"),
      dataUrl: "data:text/plain;base64,TR==",
    }),
  },
  {
    label: "empty payload",
    attachment: upload({
      type: "file",
      name: "empty.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("x"),
      dataUrl: "data:text/plain;base64,",
    }),
  },
  {
    label: "mismatched declared size",
    attachment: upload({
      type: "file",
      name: "mismatch.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello"),
      sizeBytes: 4,
    }),
  },
] as const;

const utf16Cases = [
  {
    label: "UTF-16 LE",
    name: "little-endian.txt",
    bytes: Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]),
  },
  {
    label: "UTF-16 BE",
    name: "big-endian.txt",
    bytes: Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]),
  },
] as const;

const utf32Cases = [
  {
    label: "UTF-32 LE",
    bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]),
  },
  {
    label: "UTF-32 BE",
    bytes: Uint8Array.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]),
  },
] as const;

describe("attachmentValidation", () => {
  for (const { label, attachment } of invalidBase64Cases) {
    it.effect(`rejects ${label} with a filename-scoped error`, () =>
      Effect.gen(function* () {
        const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
        expect(error.message).toContain(attachment.name);
        expect(error.message).not.toContain("SGVsbG8");
      }),
    );
  }

  it.effect("rejects an encoded payload over the per-kind cap before decoding", () =>
    Effect.gen(function* () {
      const encoded = "A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3) + 4);
      const attachment = upload({
        type: "file",
        name: "oversized.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("x"),
        dataUrl: `data:text/plain;base64,${encoded}`,
        sizeBytes: 10 * 1024 * 1024,
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("oversized.txt");
      expect(error.message).toContain("encoded payload");
    }),
  );

  it.effect("enforces extension-authoritative attachment kinds before MIME metadata", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<UploadChatAttachment> = [
        upload({
          type: "image",
          name: "renamed.ts",
          mimeType: "image/png",
          bytes: Buffer.from("image"),
        }),
        upload({
          type: "image",
          name: "renamed.pdf",
          mimeType: "image/png",
          bytes: Buffer.from("image"),
        }),
        upload({
          type: "document",
          name: "renamed.txt",
          mimeType: "application/pdf",
          bytes: Buffer.from("%PDF-1.7", "ascii"),
        }),
      ];

      for (const attachment of cases) {
        const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
        expect(error.message).toContain(attachment.name);
        expect(error.message).toContain("extension");
      }
    }),
  );

  it.effect("accepts a PDF signature fully contained at offset 1019", () =>
    Effect.gen(function* () {
      const bytes = Buffer.alloc(1024, 0x20);
      bytes.set(Buffer.from("%PDF-", "ascii"), 1019);
      const [validated] = yield* validateUploadAttachments([
        upload({
          type: "document",
          name: "boundary.pdf",
          mimeType: "application/pdf",
          bytes,
        }),
      ]);

      expect(validated).toMatchObject({
        type: "document",
        name: "boundary.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      });
      expect(Buffer.from(validated?.bytes ?? [])).toEqual(bytes);
    }),
  );

  it.effect("rejects a PDF signature beginning at offset 1020", () =>
    Effect.gen(function* () {
      const bytes = Buffer.alloc(1025, 0x20);
      bytes.set(Buffer.from("%PDF-", "ascii"), 1020);
      const attachment = upload({
        type: "document",
        name: "spoofed.pdf",
        mimeType: "application/pdf",
        bytes,
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("spoofed.pdf");
      expect(error.message).toContain("first 1024 bytes");
    }),
  );

  it.effect("rejects NUL-bearing binary content renamed as text", () =>
    Effect.gen(function* () {
      const attachment = upload({
        type: "file",
        name: "binary.txt",
        mimeType: "application/octet-stream",
        bytes: Uint8Array.from([0x61, 0x00, 0x62]),
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("binary.txt");
      expect(error.message).toContain("NUL");
    }),
  );

  it.effect("accepts valid UTF-8 text and canonicalizes its MIME type", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("hello, λ\n", "utf8");
      const [validated] = yield* validateUploadAttachments([
        upload({
          type: "file",
          name: "notes.MD",
          mimeType: "application/octet-stream",
          bytes,
        }),
      ]);

      expect(validated).toMatchObject({
        type: "file",
        name: "notes.MD",
        mimeType: "text/markdown",
        sizeBytes: bytes.byteLength,
      });
      expect(Buffer.from(validated?.bytes ?? [])).toEqual(bytes);
    }),
  );

  it.effect("rejects invalid UTF-8 even when the text sniff contains no NUL bytes", () =>
    Effect.gen(function* () {
      const attachment = upload({
        type: "file",
        name: "broken.txt",
        mimeType: "text/plain",
        bytes: Uint8Array.from([0xc3, 0x28]),
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("broken.txt");
      expect(error.message).toContain("UTF-8");
    }),
  );

  for (const { label, name, bytes } of utf16Cases) {
    it.effect(`accepts ${label} with byte-identical storage data`, () =>
      Effect.gen(function* () {
        const [validated] = yield* validateUploadAttachments([
          upload({
            type: "file",
            name,
            mimeType: "text/plain",
            bytes,
          }),
        ]);

        expect(Buffer.from(validated?.bytes ?? [])).toEqual(Buffer.from(bytes));
      }),
    );
  }

  for (const { label, bytes } of utf32Cases) {
    it.effect(`rejects a ${label} BOM as unexplained NUL-bearing text`, () =>
      Effect.gen(function* () {
        const attachment = upload({
          type: "file",
          name: `${label}.txt`,
          mimeType: "text/plain",
          bytes,
        });

        const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
        expect(error.message).toContain(`${label}.txt`);
        expect(error.message).toContain("NUL");
      }),
    );
  }

  it.effect("rejects a fake .xlsx and accepts PK\\x03\\x04", () =>
    Effect.gen(function* () {
      const fake = upload({
        type: "file",
        name: "fake.xlsx",
        mimeType: "application/zip",
        bytes: Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
      });
      const fakeError = yield* validateUploadAttachments([fake]).pipe(Effect.flip);
      expect(fakeError.message).toContain("fake.xlsx");

      const validBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
      const [valid] = yield* validateUploadAttachments([
        upload({
          type: "file",
          name: "valid.XLSX",
          mimeType: "application/zip",
          bytes: validBytes,
        }),
      ]);
      expect(valid).toMatchObject({
        type: "file",
        name: "valid.XLSX",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      expect(Buffer.from(valid?.bytes ?? [])).toEqual(Buffer.from(validBytes));
    }),
  );

  it.effect("preserves mixed attachment order and every discriminated variant", () =>
    Effect.gen(function* () {
      const imageBytes = Buffer.from("image-bytes");
      const pdfBytes = Buffer.from("prefix %PDF-1.7\n", "ascii");
      const textBytes = Buffer.from("export const value = 1;\n", "utf8");
      const xlsxBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
      const imageBase64 = imageBytes.toString("base64");

      const validated = yield* validateUploadAttachments([
        upload({
          type: "image",
          name: "image.png",
          mimeType: "image/jpeg",
          bytes: imageBytes,
          dataUrl: `  data:image/png; charset=utf-8 ; base64,${imageBase64.slice(0, 4)} ${imageBase64.slice(4)}\n  `,
        }),
        upload({
          type: "document",
          name: "guide.pdf",
          mimeType: "application/pdf",
          bytes: pdfBytes,
        }),
        upload({
          type: "file",
          name: "source.ts",
          mimeType: "video/mp2t",
          bytes: textBytes,
        }),
        upload({
          type: "file",
          name: "sheet.xlsx",
          mimeType: "application/zip",
          bytes: xlsxBytes,
        }),
      ]);

      expect(validated.map((attachment) => attachment.type)).toEqual([
        "image",
        "document",
        "file",
        "file",
      ]);
      expect(validated.map((attachment) => attachment.name)).toEqual([
        "image.png",
        "guide.pdf",
        "source.ts",
        "sheet.xlsx",
      ]);
      expect(validated.map((attachment) => attachment.mimeType)).toEqual([
        "image/png",
        "application/pdf",
        "text/plain",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ]);
    }),
  );
});
