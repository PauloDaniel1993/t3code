import { it } from "@effect/vitest";
import type { UploadChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { validateUploadAttachments } from "./attachmentValidation.ts";

function uploadImage(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly dataUrl?: string;
  readonly sizeBytes?: number;
}): UploadChatAttachment {
  return {
    type: "image",
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes ?? input.bytes.byteLength,
    dataUrl:
      input.dataUrl ??
      `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
  };
}

describe("attachmentValidation", () => {
  for (const { label, dataUrl } of [
    { label: "malformed base64", dataUrl: "data:image/png;base64,SGVsbG8*" },
    { label: "non-canonical padding", dataUrl: "data:image/png;base64,TR==" },
    { label: "an empty payload", dataUrl: "data:image/png;base64," },
  ]) {
    it.effect(`rejects ${label} with a filename-scoped error`, () =>
      Effect.gen(function* () {
        const attachment = uploadImage({
          name: "broken.png",
          mimeType: "image/png",
          bytes: Buffer.from("image"),
          dataUrl,
        });

        const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
        expect(error.message).toContain("broken.png");
        expect(error.message).not.toContain(dataUrl);
      }),
    );
  }

  it.effect("rejects a mismatched declared size", () =>
    Effect.gen(function* () {
      const attachment = uploadImage({
        name: "mismatch.png",
        mimeType: "image/png",
        bytes: Buffer.from("image"),
        sizeBytes: 4,
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("mismatch.png");
      expect(error.message).toContain("declares 4 bytes");
    }),
  );

  it.effect("rejects non-image data URL MIME types", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("plain text");
      const attachment = uploadImage({
        name: "renamed.png",
        mimeType: "image/png",
        bytes,
        dataUrl: `data:text/plain;base64,${bytes.toString("base64")}`,
      });

      const error = yield* validateUploadAttachments([attachment]).pipe(Effect.flip);
      expect(error.message).toContain("renamed.png");
      expect(error.message).toContain("image MIME type");
    }),
  );

  it.effect("preserves attachment order and canonical data URL MIME types", () =>
    Effect.gen(function* () {
      const first = Buffer.from("first-image");
      const second = Buffer.from("second-image");
      const validated = yield* validateUploadAttachments([
        uploadImage({
          name: "first.png",
          mimeType: "image/jpeg",
          bytes: first,
          dataUrl: `data:image/png;base64,${first.toString("base64")}`,
        }),
        uploadImage({
          name: "second.webp",
          mimeType: "image/webp",
          bytes: second,
        }),
      ]);

      expect(validated.map(({ name, mimeType }) => ({ name, mimeType }))).toEqual([
        { name: "first.png", mimeType: "image/png" },
        { name: "second.webp", mimeType: "image/webp" },
      ]);
      expect(Buffer.from(validated[0]?.bytes ?? [])).toEqual(first);
      expect(Buffer.from(validated[1]?.bytes ?? [])).toEqual(second);
    }),
  );
});
