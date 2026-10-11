import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAppActivationRequest } from "./desktopAppActivation.ts";

describe("desktop activation requests", () => {
  it("keeps folder requests compatible and decodes the file variant without a folder fallback", () => {
    const decode = Schema.decodeUnknownSync(DesktopAppActivationRequest);
    const common = { version: 1, requestId: "request", platform: "win32" };
    expect(decode({ ...common, type: "open-workspace", workspaceRoot: "C:/repo" })).toMatchObject({
      type: "open-workspace",
      workspaceRoot: "C:/repo",
    });
    expect(
      decode({
        ...common,
        type: "open-workspace-file",
        workspaceFilePath: "C:/Team Space/team.code-workspace",
      }),
    ).toMatchObject({
      type: "open-workspace-file",
      workspaceFilePath: "C:/Team Space/team.code-workspace",
    });
    expect(() =>
      decode({ ...common, type: "open-workspace-file", workspaceRoot: "C:/repo" }),
    ).toThrow();
  });
});
