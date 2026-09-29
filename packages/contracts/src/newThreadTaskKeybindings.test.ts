import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { KeybindingRule } from "./keybindings.ts";

const decodeRule = Schema.decodeSync(KeybindingRule);

it("accepts the delegated task shortcut command", () => {
  const rule = decodeRule({
    key: "mod+alt+n",
    command: "thread.newTask",
    when: "!terminalFocus",
  });
  expect(rule.command).toBe("thread.newTask");
});
