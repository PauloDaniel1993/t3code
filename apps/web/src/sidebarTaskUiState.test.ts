import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import {
  markThreadVisited,
  markThreadUnread,
  parsePersistedState,
  persistState,
  PERSISTED_STATE_KEY,
  type UiState,
} from "./uiStateStore";
import { mergeUiStateRecords } from "./sidebarTaskUiState";
const makeUiState = (overrides: Partial<UiState> = {}): UiState => ({
  ...parsePersistedState({}),
  ...overrides,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("browser window reconciliation", () => {
  it("persists ordinary state without reading storage or adding per-visit conflict records", () => {
    const getItem = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem, setItem }, addEventListener() {} });
    const state = markThreadVisited(makeUiState(), "local:parent", "2026-09-29T00:09:00Z");
    expect(state.threadVisitEditsAtById).toEqual({});
    expect(state.threadVisitIsUnreadById).toEqual({});
    persistState(state);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledOnce();
  });
  it("restores explicit expansion separately per environment", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem }, addEventListener() {} });
    persistState(
      makeUiState({
        sidebarTaskGroupsExpandedById: { "local:parent": false, "remote:parent": true },
      }),
    );
    const restored = parsePersistedState(JSON.parse(setItem.mock.calls[0]![1]));
    expect(restored.sidebarTaskGroupsExpandedById).toEqual({
      "local:parent": false,
      "remote:parent": true,
    });
  });
  it("compares visits by instant when old and new clients use different ISO precision", () => {
    const previous = makeUiState({
      threadLastVisitedAtById: { "local:parent": "2026-09-29T00:09:00Z" },
    });
    const incoming = makeUiState({
      threadLastVisitedAtById: { "local:parent": "2026-09-29T00:09:00.001Z" },
    });
    expect(mergeUiStateRecords(previous, incoming).threadLastVisitedAtById["local:parent"]).toBe(
      "2026-09-29T00:09:00.001Z",
    );
  });
  it("preserves interleaved visits and expansion choices in shared storage", () => {
    let saved = "";
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === PERSISTED_STATE_KEY ? saved || null : null),
        setItem: (_key: string, value: string) => {
          saved = value;
        },
        removeItem() {},
      },
    });
    const first = markThreadVisited(
      makeUiState({
        sidebarTaskGroupsExpandedById: { "local:parent": false },
        sidebarTaskGroupsExpandedAtById: { "local:parent": "2026-09-29T00:09:00Z" },
      }),
      "local:parent",
      "2026-09-29T00:09:00Z",
    );
    const second = markThreadVisited(
      makeUiState({
        sidebarTaskGroupsExpandedById: { "local:parent": true, "remote:parent": true },
        sidebarTaskGroupsExpandedAtById: {
          "local:parent": "2026-09-29T00:08:00Z",
          "remote:parent": "2026-09-29T00:09:00Z",
        },
      }),
      "local:child",
      "2026-09-29T00:08:00Z",
    );
    persistState(first);
    persistState(mergeUiStateRecords(first, second));
    const reloaded = parsePersistedState(JSON.parse(saved));
    expect(reloaded.threadLastVisitedAtById).toEqual({
      "local:parent": "2026-09-29T00:09:00Z",
      "local:child": "2026-09-29T00:08:00Z",
    });
    expect(reloaded.sidebarTaskGroupsExpandedById).toEqual({
      "local:parent": false,
      "remote:parent": true,
    });
    const later = {
      ...second,
      sidebarTaskGroupsExpandedAtById: { "local:parent": "2026-09-29T00:10:00Z" },
    };
    persistState(mergeUiStateRecords(reloaded, later));
    expect(
      parsePersistedState(JSON.parse(saved)).sidebarTaskGroupsExpandedById["local:parent"],
    ).toBe(true);
    vi.unstubAllGlobals();
  });
  it("never moves a visit backwards when the stale window writes later", () => {
    const first = markThreadVisited(makeUiState(), "local:parent", "2026-09-29T00:09:00Z");
    const stale = markThreadVisited(makeUiState(), "local:parent", "2026-09-29T00:08:00Z");
    expect(mergeUiStateRecords(first, stale).threadLastVisitedAtById["local:parent"]).toBe(
      "2026-09-29T00:09:00Z",
    );
  });
  it("keeps the explicit Mark unread action, and a later visit clears it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T01:00:00Z"));
    const read = markThreadVisited(makeUiState(), "local:parent", "2026-09-29T00:09:00Z");
    const unread = markThreadUnread(read, "local:parent", "2026-09-29T00:08:00Z");
    const reconciled = mergeUiStateRecords(read, unread);
    expect(reconciled.threadLastVisitedAtById["local:parent"]).toBe("2026-09-29T00:07:59.999Z");
    const visited = markThreadVisited(unread, "local:parent", "2026-09-29T00:10:00Z");
    expect(mergeUiStateRecords(reconciled, visited).threadLastVisitedAtById["local:parent"]).toBe(
      "2026-09-29T00:10:00Z",
    );
    vi.useRealTimers();
  });
  it("accepts a later visit from a window that has not seen Mark unread", () => {
    const unread = makeUiState({
      threadLastVisitedAtById: { "local:parent": "2026-09-29T00:00:00Z" },
      threadVisitEditsAtById: { "local:parent": "2026-09-29T01:00:00Z" },
      threadVisitIsUnreadById: { "local:parent": true },
    });
    const laterVisit = markThreadVisited(makeUiState(), "local:parent", "2026-09-29T01:01:00Z");
    const reconciled = mergeUiStateRecords(unread, laterVisit);
    expect(reconciled.threadLastVisitedAtById["local:parent"]).toBe("2026-09-29T01:01:00Z");
    expect(reconciled.threadVisitIsUnreadById?.["local:parent"]).toBe(false);
    expect(mergeUiStateRecords(reconciled, unread)).toBe(reconciled);
  });
});
