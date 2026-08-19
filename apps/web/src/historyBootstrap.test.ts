import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBootstrapInput } from "./historyBootstrap";

const messageId = (value: string) => MessageId.make(value);

describe("buildBootstrapInput", () => {
  it("summarizes documents and generic files in transcript order", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-files"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "document",
              id: "pdf-1",
              name: "manual.pdf",
              mimeType: "application/pdf",
              sizeBytes: 100,
            },
            {
              type: "file",
              id: "file-1",
              name: "Program.cs",
              mimeType: "text/plain",
              sizeBytes: 50,
            },
          ],
          createdAt: "2026-02-09T00:00:00.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      "Continue",
      1_500,
    );
    expect(result.text).toContain("[Attached PDF manual.pdf]");
    expect(result.text).toContain("[Attached file Program.cs]");
    expect(result.text.indexOf("manual.pdf")).toBeLessThan(result.text.indexOf("Program.cs"));
  });
});
