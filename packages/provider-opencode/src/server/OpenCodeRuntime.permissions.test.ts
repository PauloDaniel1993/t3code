import * as NodeAssert from "node:assert/strict";

import * as RegExpUtils from "effect/RegExp";
import { describe, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { openCode2SessionRules } from "./v2/adapter.ts";

function actionFor(
  runtimeMode: Parameters<typeof OpenCodeRuntime.buildOpenCodePermissionRules>[0],
  permission: string,
  target = "*",
) {
  // OpenCode uses the last matching rule. Its wildcards match directory separators.
  return OpenCodeRuntime.buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.permission === "*" || rule.permission === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.pattern).replaceAll("\\*", ".*")}$`, "s").test(target),
  )?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("preserves OpenCode's environment-file approval rules", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const target of [
        ".env",
        ".env.local",
        "config/service.env",
        "config/service.env.local",
      ]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "ask");
      }
      for (const target of [".env.example", "config/service.env.example"]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "allow");
      }
    }
  });

  it("still asks before commands, network access, external directories and unknown tools", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "bash"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "websearch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "custom_tool"), "ask");
    }
  });
});

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["decline", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(OpenCodeRuntime.toOpenCodePermissionReply(decision), reply);
  });
});

describe("OpenCode 2 workspace permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
    "keeps the %s edit policy while granting extra folders",
    (runtimeMode) => {
      const policy = {
        runtimeMode,
        interactionMode: "default" as const,
        additionalDirectories: [],
      };
      const primary = openCode2SessionRules(policy, [], [], null);
      const expanded = openCode2SessionRules(
        {
          ...policy,
          additionalDirectories: [
            "/sibling folder/",
            "D:\\Other Projects\\api\\",
            "//server/share/",
          ],
        },
        [],
        [],
        null,
      );
      const edit = (rules: typeof primary) => rules.findLast((entry) => entry.action === "edit");
      NodeAssert.deepEqual(edit(expanded), edit(primary));
      for (const resource of ["/sibling folder/*", "D:/Other Projects/api/*", "//server/share/*"]) {
        NodeAssert.ok(
          expanded.some(
            (entry) =>
              entry.action === "external_directory" &&
              entry.resource === resource &&
              entry.effect === "allow",
          ),
        );
      }
    },
  );

  it("clears workspace grants while retaining plan paths, session grants and MCP isolation", () => {
    const policy = {
      runtimeMode: "auto-accept-edits" as const,
      interactionMode: "plan" as const,
      additionalDirectories: ["/old"],
    };
    const paths = [{ action: "edit", resource: "/plans/*", effect: "allow" as const }];
    const grants = [
      { action: "external_directory", resource: "/attachments/*", effect: "allow" as const },
    ];
    const expanded = openCode2SessionRules(policy, paths, grants, "t3-code-child");
    const cleared = openCode2SessionRules(
      { ...policy, additionalDirectories: [] },
      paths,
      grants,
      "t3-code-child",
    );
    NodeAssert.ok(expanded.some((entry) => entry.resource === "/old/*"));
    NodeAssert.ok(!cleared.some((entry) => entry.resource === "/old/*"));
    NodeAssert.ok(
      cleared.some(
        (entry) => entry.action === "edit" && entry.resource === "*" && entry.effect === "deny",
      ),
    );
    NodeAssert.deepEqual(cleared.slice(-4), [
      { action: "edit", resource: "*", effect: "deny" },
      ...paths,
      { action: "t3-code-*", resource: "*", effect: "deny" },
      { action: "t3-code-child_*", resource: "*", effect: "allow" },
    ]);
    NodeAssert.ok(cleared.some((entry) => entry.resource === "/attachments/*"));
  });
});
