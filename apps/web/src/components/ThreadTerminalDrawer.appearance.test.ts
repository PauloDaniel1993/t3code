import {
  DEFAULT_TERMINAL_FONT_SIZE,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type TerminalFont = { family?: string; size?: number };

const testState = vi.hoisted(() => ({
  frames: new Map<number, (timestamp: number) => void>(),
  instances: [] as Array<{
    cols: number;
    createdFont: { family?: string; size?: number } | undefined;
    rows: number;
    setFontCalls: Array<{ family?: string; size?: number }>;
  }>,
  mount: null as unknown,
  nextFrameId: 0,
  resize: vi.fn(),
  settings: {
    fontFamilyCode: "",
    fontFamilyTerminal: "",
    fontSizeTerminal: 12,
  },
}));

const hooks = vi.hoisted(() => {
  type Cleanup = (() => void) | undefined;
  type EffectSlot = { cleanup: Cleanup; dependencies: readonly unknown[] | undefined };
  type EventSlot = { current: (...args: never[]) => unknown; fn: (...args: never[]) => unknown };
  type MemoSlot = { dependencies: readonly unknown[] | undefined; value: unknown };

  let callbackCursor = 0;
  let effectCursor = 0;
  let eventCursor = 0;
  let memoCursor = 0;
  let refCursor = 0;
  let stateCursor = 0;
  let compilerCacheCursor = 0;
  let effectSlots: EffectSlot[] = [];
  let eventSlots: EventSlot[] = [];
  let memoSlots: MemoSlot[] = [];
  let refSlots: Array<{ current: unknown }> = [];
  let stateSlots: unknown[] = [];
  let callbackSlots: MemoSlot[] = [];
  let compilerCacheSlots: unknown[][] = [];
  let pendingEffects: Array<{ callback: () => void | (() => void); index: number }> = [];

  const dependenciesChanged = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ): boolean =>
    previous === undefined ||
    next === undefined ||
    previous.length !== next.length ||
    previous.some((dependency, index) => dependency !== next[index]);

  return {
    beginRender() {
      callbackCursor = 0;
      effectCursor = 0;
      eventCursor = 0;
      memoCursor = 0;
      refCursor = 0;
      stateCursor = 0;
      compilerCacheCursor = 0;
    },
    flushEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) {
        const slot = effectSlots[effect.index]!;
        slot.cleanup?.();
        slot.cleanup = effect.callback() ?? undefined;
      }
    },
    reset(firstRefValue: unknown) {
      callbackCursor = 0;
      effectCursor = 0;
      eventCursor = 0;
      memoCursor = 0;
      refCursor = 0;
      stateCursor = 0;
      compilerCacheCursor = 0;
      effectSlots = [];
      eventSlots = [];
      memoSlots = [];
      refSlots = [{ current: firstRefValue }];
      stateSlots = [];
      callbackSlots = [];
      compilerCacheSlots = [];
      pendingEffects = [];
    },
    unmount() {
      for (const slot of effectSlots) {
        slot.cleanup?.();
        slot.cleanup = undefined;
      }
      pendingEffects = [];
    },
    useCallback<T>(callback: T, dependencies: readonly unknown[]): T {
      const index = callbackCursor++;
      const slot = callbackSlots[index];
      if (!slot || dependenciesChanged(slot.dependencies, dependencies)) {
        callbackSlots[index] = { dependencies, value: callback };
        return callback;
      }
      return slot.value as T;
    },
    useEffect(callback: () => void | (() => void), dependencies: readonly unknown[]) {
      const index = effectCursor++;
      const slot = effectSlots[index];
      if (!slot) {
        effectSlots[index] = { cleanup: undefined, dependencies };
        pendingEffects.push({ callback, index });
        return;
      }
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        pendingEffects.push({ callback, index });
      }
    },
    useEffectEvent<T extends (...args: never[]) => unknown>(callback: T): T {
      const index = eventCursor++;
      const slot = eventSlots[index];
      if (slot) {
        slot.current = callback;
        return slot.fn as T;
      }
      const nextSlot: EventSlot = {
        current: callback,
        fn(...args) {
          return nextSlot.current(...args);
        },
      };
      eventSlots[index] = nextSlot;
      return nextSlot.fn as T;
    },
    useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T {
      const index = memoCursor++;
      const slot = memoSlots[index];
      if (!slot || dependenciesChanged(slot.dependencies, dependencies)) {
        const value = factory();
        memoSlots[index] = { dependencies, value };
        return value;
      }
      return slot.value as T;
    },
    useMemoCache(size: number): unknown[] {
      const index = compilerCacheCursor++;
      const slot = compilerCacheSlots[index];
      if (slot) return slot;
      const nextSlot = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      compilerCacheSlots[index] = nextSlot;
      return nextSlot;
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = refCursor++;
      const slot = refSlots[index];
      if (slot) return slot as { current: T };
      const nextSlot = { current: initialValue };
      refSlots[index] = nextSlot;
      return nextSlot;
    },
    useState<T>(initialValue: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
      const index = stateCursor++;
      if (index >= stateSlots.length) {
        stateSlots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      return [
        stateSlots[index] as T,
        (value) => {
          const previous = stateSlots[index] as T;
          stateSlots[index] =
            typeof value === "function" ? (value as (current: T) => T)(previous) : value;
        },
      ];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useEffectEvent: hooks.useEffectEvent,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => undefined,
}));

vi.mock("~/terminal/ghostty/surface", () => {
  class GhosttyTerminalSurface {
    cols = 80;
    rows = 24;
    readonly createdFont: TerminalFont | undefined;
    readonly setFontCalls: TerminalFont[] = [];

    constructor(options: { font?: TerminalFont }) {
      this.createdFont = options.font;
      testState.instances.push(this);
    }

    static create(_mount: unknown, options: { font?: TerminalFont }) {
      return Promise.resolve(new GhosttyTerminalSurface(options));
    }

    clearSelection(): void {}
    dispose(): void {}
    fit(): void {}
    focus(): void {}
    getSelection(): string {
      return "";
    }
    getSelectionEndClientRect() {
      return null;
    }
    getSelectionPosition() {
      return null;
    }
    hasSelection(): boolean {
      return false;
    }
    isAtBottom(): boolean {
      return true;
    }
    resetAndWrite(): void {}
    scrollToBottom(): void {}
    setFont(font: TerminalFont): Promise<void> {
      this.setFontCalls.push(font);
      return Promise.resolve();
    }
    setTheme(): void {}
    write(): void {}
  }
  return { GhosttyTerminalSurface };
});

vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => children,
  PopoverPopup: ({ children }: { children: unknown }) => children,
  PopoverTrigger: ({ children }: { children: unknown }) => children,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => undefined,
}));

vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => () => undefined,
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector?: (settings: typeof testState.settings) => unknown) =>
    selector ? selector(testState.settings) : testState.settings,
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: Symbol("open") },
}));

vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => Symbol("config") },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: { resize: Symbol("resize"), write: Symbol("write") },
}));

vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => ({
    buffer: "",
    error: null,
    status: "closed",
    version: 0,
  }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => testState.resize,
}));

vi.mock("./preview/openTerminalLinkInPreview", () => ({
  openTerminalLinkInPreview: () => undefined,
}));

import { TerminalViewport } from "./ThreadTerminalDrawer";

const viewportProps = {
  advancedTypography: false,
  autoFocus: false,
  cwd: "/workspace",
  drawerHeight: 300,
  focusRequestId: 0,
  keybindings: {} as ResolvedKeybindingsConfig,
  onAddTerminalContext: () => {},
  onSessionExited: () => {},
  resizeEpoch: 0,
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  threadId: "thread-1" as ThreadId,
  threadRef: { environmentId: "environment-local" } as ScopedThreadRef,
};

function flushAnimationFrames(): void {
  const frames = [...testState.frames.values()];
  testState.frames.clear();
  for (const frame of frames) {
    frame(0);
  }
}

function renderViewport(): void {
  hooks.beginRender();
  TerminalViewport(viewportProps);
  hooks.flushEffects();
}

/** The surface is created asynchronously, so settle the create promise chain. */
async function settleSetup(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function mountViewport(): Promise<(typeof testState.instances)[number]> {
  renderViewport();
  await settleSetup();
  flushAnimationFrames();
  const terminal = testState.instances[0];
  if (!terminal) {
    throw new Error("Expected terminal to be created");
  }
  testState.resize.mockClear();
  return terminal;
}

beforeEach(() => {
  testState.frames.clear();
  testState.instances.length = 0;
  testState.nextFrameId = 0;
  testState.resize.mockReset();
  testState.settings = {
    fontFamilyCode: '"Iosevka", monospace',
    fontFamilyTerminal: '"Berkeley Mono", monospace',
    fontSizeTerminal: 15,
  };

  const drawerSurface = {};
  testState.mount = {
    addEventListener: () => {},
    closest: () => drawerSurface,
    removeEventListener: () => {},
  };
  hooks.reset(testState.mount);

  vi.stubGlobal("document", {
    body: {},
    // The theme reader probes colors through a canvas; without a 2d context it
    // falls back to the literal values, which is all these typography tests need.
    createElement: () => ({ getContext: () => null }),
    documentElement: {
      classList: { contains: () => false },
    },
    querySelector: () => null,
  });
  vi.stubGlobal("getComputedStyle", () => ({
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(28, 33, 41)",
    getPropertyValue: () => "",
  }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      disconnect(): void {}
      observe(): void {}
    },
  );
  vi.stubGlobal("window", {
    addEventListener: () => {},
    cancelAnimationFrame: (frame: number) => testState.frames.delete(frame),
    clearTimeout: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      const frame = ++testState.nextFrameId;
      testState.frames.set(frame, callback);
      return frame;
    },
    setTimeout: () => 0,
  });
});

afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
});

describe("TerminalViewport appearance typography", () => {
  it("uses the code font while advanced typography is guarded off", async () => {
    const terminal = await mountViewport();

    expect(terminal.createdFont).toEqual({ family: '"Iosevka", monospace', size: 15 });
  });

  it("uses the dedicated terminal font when advanced typography is enabled", async () => {
    hooks.beginRender();
    TerminalViewport({ ...viewportProps, advancedTypography: true });
    hooks.flushEffects();
    await settleSetup();
    flushAnimationFrames();

    expect(testState.instances[0]?.createdFont).toEqual({
      family: '"Berkeley Mono", monospace',
      size: 15,
    });
  });

  it("re-fonts the existing terminal after preferences hydrate without recreating it", async () => {
    testState.settings = {
      fontFamilyCode: "",
      fontFamilyTerminal: "",
      fontSizeTerminal: DEFAULT_TERMINAL_FONT_SIZE,
    };
    const terminal = await mountViewport();
    expect(terminal.createdFont).toEqual({ size: DEFAULT_TERMINAL_FONT_SIZE });

    testState.settings = {
      fontFamilyCode: '"Fira Code", monospace',
      fontFamilyTerminal: '"Berkeley Mono", monospace',
      fontSizeTerminal: 17,
    };

    renderViewport();

    expect(testState.instances).toHaveLength(1);
    expect(testState.instances[0]).toBe(terminal);
    expect(terminal.setFontCalls).toEqual([{ family: '"Fira Code", monospace', size: 17 }]);
  });

  it("does not re-font unchanged typography", async () => {
    const terminal = await mountViewport();

    renderViewport();

    expect(terminal.setFontCalls).toEqual([]);
  });

  // Empty preferences leave the family unset so the renderer's own stack,
  // including its Nerd Font glyph fallbacks, remains in control.
  it("omits the current empty-family default so the renderer's own stack applies", async () => {
    testState.settings = {
      fontFamilyCode: "",
      fontFamilyTerminal: "",
      fontSizeTerminal: DEFAULT_TERMINAL_FONT_SIZE,
    };

    const terminal = await mountViewport();

    expect(terminal.createdFont).toEqual({ size: DEFAULT_TERMINAL_FONT_SIZE });
  });
});
