// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PROVIDER_INLINE_FILE_MAX_CHARS, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { attachmentRelativePath } from "../attachmentStore.ts";
import {
  decodeProviderText,
  ProviderInlineTextBudget,
  providerFileUri,
  resolveProviderAttachment,
} from "./attachmentDelivery.ts";

describe("attachmentDelivery", () => {
  it("builds exact encoded POSIX file URIs", () => {
    assert.equal(
      providerFileUri("/tmp/space # % café.txt", { windows: false }),
      "file:///tmp/space%20%23%20%25%20caf%C3%A9.txt",
    );
  });

  it("builds exact encoded Windows drive-letter file URIs", () => {
    assert.equal(
      providerFileUri(String.raw`C:\Users\Jane Doe\#100%\résumé.pdf`, { windows: true }),
      "file:///C:/Users/Jane%20Doe/%23100%25/r%C3%A9sum%C3%A9.pdf",
    );
  });

  it.effect("resolves and reads only attachments owned by the supplied thread", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-files-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        type: "file" as const,
        id: "thread-owned-12345678-1234-1234-1234-123456789abc",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      const absolutePath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
      NodeFS.writeFileSync(absolutePath, "hello");

      const resolved = yield* resolveProviderAttachment({
        attachmentsDir,
        threadId: ThreadId.make("thread-owned"),
        attachment,
        fileSystem,
      });
      assert.equal(resolved.absolutePath, absolutePath);
      assert.deepEqual(Array.from(resolved.bytes), Array.from(Buffer.from("hello")));

      const rejected = yield* resolveProviderAttachment({
        attachmentsDir,
        threadId: ThreadId.make("other-thread"),
        attachment,
        fileSystem,
      }).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") {
        assert.equal(rejected.failure.reason, "invalid-or-unowned");
        assert.match(rejected.failure.message, /notes\.txt/u);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a missing owned attachment as unreadable", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "provider-missing-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        type: "document" as const,
        id: "thread-missing-22345678-1234-1234-1234-123456789abc",
        name: "missing.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 1,
      };

      const rejected = yield* resolveProviderAttachment({
        attachmentsDir,
        threadId: ThreadId.make("thread-missing"),
        attachment,
        fileSystem,
      }).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") {
        assert.equal(rejected.failure.reason, "unreadable");
        assert.match(rejected.failure.message, /missing\.pdf/u);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("decodes UTF-8 and BOM-marked UTF-16 without retaining the BOM", () => {
    assert.equal(
      decodeProviderText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), "utf8.txt"),
      "hi",
    );
    assert.equal(
      decodeProviderText(Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), "le.txt"),
      "hi",
    );
    assert.equal(
      decodeProviderText(Uint8Array.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), "be.txt"),
      "hi",
    );
    assert.throws(
      () => decodeProviderText(Uint8Array.from([0xc3, 0x28]), "broken.txt"),
      /broken\.txt/u,
    );
  });

  it("counts UTF-16 code units and names the first file that overflows the cumulative budget", () => {
    const budget = new ProviderInlineTextBudget();
    budget.add("first.txt", "a".repeat(PROVIDER_INLINE_FILE_MAX_CHARS - 2));
    budget.add("emoji.txt", "😀");
    assert.equal(budget.used, PROVIDER_INLINE_FILE_MAX_CHARS);

    let overflow: unknown;
    try {
      budget.add("large.log", "x");
    } catch (error) {
      overflow = error;
    }
    assert.instanceOf(overflow, Error);
    assert.match(overflow.message, /large\.log/u);
    assert.match(overflow.message, /256 KiB/u);
    assert.match(overflow.message, /262144 UTF-16 code units/u);
    assert.equal(budget.used, PROVIDER_INLINE_FILE_MAX_CHARS);
  });
});
