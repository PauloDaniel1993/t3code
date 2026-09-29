import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("new delegated task shortcut", () => {
  it("uses Ctrl+Alt+N on Windows and Command+Option+N on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "n", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Windows" },
      ),
      "thread.newTask",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "n", metaKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "MacIntel" },
      ),
      "thread.newTask",
    );
  });

  it("leaves terminal input alone and honors a custom task shortcut", () => {
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "n", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Windows", context: { terminalFocus: true } },
      ),
    );
    const custom = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key: "ctrl+alt+t", command: "thread.newTask", when: "!terminalFocus" },
      ]),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "t", ctrlKey: true, altKey: true }), custom, {
        platform: "Windows",
      }),
      "thread.newTask",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true, altKey: true }), custom, {
        platform: "Windows",
      }),
    );
  });
});
