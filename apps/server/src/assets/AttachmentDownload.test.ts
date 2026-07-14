import { describe, expect, it } from "vite-plus/test";

import {
  attachmentContentDisposition,
  decodeAttachmentDownloadName,
} from "./AttachmentDownload.ts";

describe("attachment downloads", () => {
  it("preserves a UTF-8 PDF name with an ASCII fallback", () => {
    expect(attachmentContentDisposition("R\u00e9sum\u00e9 2026.pdf")).toBe(
      "attachment; filename=\"R_sum_ 2026.pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.pdf",
    );
  });

  it("removes path and header control characters", () => {
    const decoded = decodeAttachmentDownloadName(
      encodeURIComponent("../report\r\nInjected: yes.pdf"),
    );
    expect(decoded).toBe(".._report__Injected: yes.pdf");

    const value = attachmentContentDisposition(decoded ?? "");
    expect(value).not.toMatch(/[\r\n]/u);
    expect(value).not.toContain("../");
  });

  it("rejects malformed percent encoding", () => {
    expect(decodeAttachmentDownloadName("%not-hex")).toBeNull();
  });
});
