import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./CodexDeveloperInstructions.ts";

describe("Codex developer instructions", () => {
  it("advertises the ten-question request_user_input limit in plan mode", () => {
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("at most ten questions");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "The provider-native question tool is disabled",
    );
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
