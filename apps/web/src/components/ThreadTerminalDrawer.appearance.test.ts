import {
  type AppearanceSettings,
  type AppearanceTheme,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  fitCalls: 0,
  fitShouldThrow: false,
  frames: new Map<number, (timestamp: number) => void>(),
  instances: [] as Array<{
    buffer: { active: { baseY: number; viewportY: number } };
    cols: number;
    options: Record<string, unknown>;
    rows: number;
  }>,
  mount: null as unknown,
  nextFrameId: 0,
  resize: vi.fn(),
  settings: { appearance: null as unknown },
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

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit(): void {
      testState.fitCalls += 1;
      if (testState.fitShouldThrow) {
        throw new Error("fit failed");
      }
    }
  }
  return { FitAddon };
});

vi.mock("@xterm/xterm", () => {
  class Terminal {
    readonly buffer = {
      active: {
        baseY: 0,
        getLine: () => undefined,
        viewportY: 0,
      },
    };
    cols = 80;
    options: Record<string, unknown>;
    rows = 24;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      testState.instances.push(this);
    }

    attachCustomKeyEventHandler(): void {}
    clearSelection(): void {}
    dispose(): void {}
    loadAddon(): void {}
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    open(): void {}
    refresh(): void {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    scrollToBottom(): void {}
  }
  return { Terminal };
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

function customAppearance(fontFamily: string, fontSize: number): AppearanceSettings {
  const baseTheme = {
    id: "custom-terminal-font",
    name: "Terminal Font",
    uiFontFamily: '"DM Sans Variable", sans-serif',
    monoFontFamily: "Consolas, monospace",
    terminalFontFamily: fontFamily,
    uiFontSizePx: 14,
    chatFontSizePx: 14,
    codeFontSizePx: 12,
    terminalFontSizePx: fontSize,
    density: "default",
    diffMarkerStyle: "color",
    variants: {
      light: {
        accent: "#1b4ed8",
        background: "#ffffff",
        foreground: "#262626",
        surface: "#ffffff",
        muted: "#f5f5f5",
        contrast: 1,
        translucentSidebar: false,
      },
      dark: {
        accent: "#366ffb",
        background: "#161616",
        foreground: "#f5f5f5",
        surface: "#1b1b1b",
        muted: "#1f1f1f",
        contrast: 1,
        translucentSidebar: false,
      },
    },
  } satisfies AppearanceTheme;

  return {
    colorScheme: "system",
    activeThemeId: baseTheme.id,
    customThemeOrder: [baseTheme.id],
    customThemes: { [baseTheme.id]: baseTheme },
  };
}

const viewportProps = {
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

function mountViewport(): { options: Record<string, unknown> } {
  renderViewport();
  flushAnimationFrames();
  const terminal = testState.instances[0];
  if (!terminal) {
    throw new Error("Expected terminal to be created");
  }
  testState.fitCalls = 0;
  testState.resize.mockClear();
  return terminal;
}

beforeEach(() => {
  testState.fitCalls = 0;
  testState.fitShouldThrow = false;
  testState.frames.clear();
  testState.instances.length = 0;
  testState.nextFrameId = 0;
  testState.resize.mockReset();
  testState.settings = { appearance: customAppearance('"Iosevka", monospace', 15) };

  const drawerSurface = {};
  testState.mount = {
    addEventListener: () => {},
    closest: () => drawerSurface,
    removeEventListener: () => {},
  };
  hooks.reset(testState.mount);

  vi.stubGlobal("document", {
    body: {},
    documentElement: {
      classList: { contains: () => false },
    },
    querySelector: () => null,
  });
  vi.stubGlobal("getComputedStyle", () => ({
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(28, 33, 41)",
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
  it("creates a terminal with typography from the active custom appearance theme", () => {
    const terminal = mountViewport();

    expect(terminal.options.fontFamily).toBe('"Iosevka", monospace');
    expect(terminal.options.fontSize).toBe(15);
  });

  it("updates the existing terminal options, refits, and resizes after typography changes", () => {
    const terminal = mountViewport();
    testState.settings = { appearance: customAppearance('"Fira Code", monospace', 17) };

    renderViewport();

    expect(testState.instances).toHaveLength(1);
    expect(testState.instances[0]).toBe(terminal);
    expect(terminal.options.fontFamily).toBe('"Fira Code", monospace');
    expect(terminal.options.fontSize).toBe(17);
    expect(testState.fitCalls).toBe(0);

    flushAnimationFrames();

    expect(testState.fitCalls).toBe(1);
    expect(testState.resize).toHaveBeenCalledWith({
      environmentId: "environment-local",
      input: { cols: 80, rows: 24, terminalId: "terminal-1", threadId: "thread-1" },
    });
  });

  it("does not refit unchanged typography and safely continues when fitting throws", () => {
    mountViewport();

    renderViewport();
    expect(testState.frames).toHaveLength(0);
    expect(testState.fitCalls).toBe(0);

    testState.fitShouldThrow = true;
    testState.settings = { appearance: customAppearance('"Fira Code", monospace', 17) };
    renderViewport();

    expect(() => flushAnimationFrames()).not.toThrow();
    expect(testState.fitCalls).toBe(1);
    expect(testState.resize).toHaveBeenCalledWith({
      environmentId: "environment-local",
      input: { cols: 80, rows: 24, terminalId: "terminal-1", threadId: "thread-1" },
    });
  });
});
