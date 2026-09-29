import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestratorMcpTaskListInput } from "./orchestratorTasks.ts";

const decode = Schema.decodeUnknownSync(OrchestratorMcpTaskListInput);

describe("delegated task list input", () => {
  it("accepts discovery without a remembered task ID and continuation pages", () => {
    expect(decode({})).toEqual({});
    expect(decode({ limit: 100, cursor: "task:previous-page" })).toEqual({
      limit: 100,
      cursor: "task:previous-page",
    });
  });

  it.each([0, -1, 1.5, 101, "50"])("rejects an invalid page size %s", (limit) => {
    expect(() => decode({ limit })).toThrow();
  });

  it("rejects an empty continuation cursor", () => {
    expect(() => decode({ cursor: "" })).toThrow();
  });
});
