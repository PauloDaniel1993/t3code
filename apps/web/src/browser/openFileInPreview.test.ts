import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { openFileOutsideT3 } from "./openFileInPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

describe("openFileOutsideT3", () => {
  it("opens a workspace-relative PDF asset in the system browser", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const openExternal = vi.fn(async () => undefined);

    const result = await openFileOutsideT3({
      threadRef,
      filePath: "output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
      httpBaseUrl: "http://localhost:13785",
      createAssetUrl,
      openExternal,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: "output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
        },
      },
    });
    expect(openExternal).toHaveBeenCalledWith(
      "http://localhost:13785/api/assets/signed/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
    );
  });
});
