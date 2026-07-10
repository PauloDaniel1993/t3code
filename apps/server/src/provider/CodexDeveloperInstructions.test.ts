import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./CodexDeveloperInstructions.ts";

describe("Codex developer instructions", () => {
  it("forces the T3 MCP user-input tool in every collaboration mode", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      expect(instructions).toContain("always use that product-native structured user-input tool");
      expect(instructions).toContain(
        "Do not call a provider-native or host-injected question tool",
      );
      expect(instructions).toContain("Those tools are disabled in that state");
    }
  });

  it("advertises the ten-question request_user_input limit in plan mode", () => {
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("at most ten questions");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("up to ten questions in one call");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).not.toContain("three questions");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).not.toContain("do not exceed 3");
  });

  it("keeps request_user_input unavailable in default mode", () => {
    expect(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "request_user_input` tool is unavailable in Default mode",
    );
  });
});
