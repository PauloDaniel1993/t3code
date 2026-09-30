import type { PersistedUiState, UiState } from "./uiStateStore";

type Records = Pick<
  UiState,
  | "threadLastVisitedAtById"
  | "threadVisitEditsAtById"
  | "threadVisitIsUnreadById"
  | "sidebarTaskGroupsExpandedById"
  | "sidebarTaskGroupsExpandedAtById"
>;
const recordFields = [
  "threadLastVisitedAtById",
  "threadVisitEditsAtById",
  "threadVisitIsUnreadById",
  "sidebarTaskGroupsExpandedById",
  "sidebarTaskGroupsExpandedAtById",
] as const;

export function nextLocalEditTime(previous?: string) {
  return new Date(Math.max(Date.now(), Date.parse(previous ?? "") + 1 || 0)).toISOString();
}

/** Ordinary visits need no conflict metadata; explicit Mark unread does. */
export function visitConflictEdits(state: UiState, key: string, unread: boolean) {
  return unread || state.threadVisitEditsAtById?.[key] !== undefined
    ? {
        threadVisitEditsAtById: {
          ...state.threadVisitEditsAtById,
          [key]: nextLocalEditTime(state.threadVisitEditsAtById?.[key]),
        },
        threadVisitIsUnreadById: { ...state.threadVisitIsUnreadById, [key]: unread },
      }
    : {};
}

function sameRecord(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => b[key] === value)
  );
}

/** Merge only this feature's records. Each window keeps its own other preferences. */
export function mergeUiStateRecords(previous: UiState, incoming: UiState): UiState {
  const visits = { ...previous.threadLastVisitedAtById };
  const edits = { ...previous.threadVisitEditsAtById };
  const unread = { ...previous.threadVisitIsUnreadById };
  for (const [key, time] of Object.entries(incoming.threadLastVisitedAtById)) {
    const oldEdit = previous.threadVisitEditsAtById?.[key];
    const newEdit = incoming.threadVisitEditsAtById?.[key];
    if (
      newEdit !== undefined &&
      (oldEdit === undefined || Date.parse(newEdit) > Date.parse(oldEdit))
    ) {
      visits[key] = time;
      edits[key] = newEdit;
      unread[key] = incoming.threadVisitIsUnreadById?.[key] === true;
    } else if (
      newEdit === undefined &&
      (visits[key] === undefined || Date.parse(time) > Date.parse(visits[key]!)) &&
      (oldEdit === undefined || Date.parse(time) > Date.parse(oldEdit))
    ) {
      visits[key] = time;
      if (oldEdit !== undefined) {
        edits[key] = time;
        unread[key] = false;
      }
    }
  }
  const expanded = { ...previous.sidebarTaskGroupsExpandedById };
  const expandedAt = { ...previous.sidebarTaskGroupsExpandedAtById };
  for (const [key, value] of Object.entries(incoming.sidebarTaskGroupsExpandedById)) {
    const oldTime = expandedAt[key];
    const newTime = incoming.sidebarTaskGroupsExpandedAtById?.[key];
    if (
      oldTime === undefined ||
      (newTime !== undefined && Date.parse(newTime) >= Date.parse(oldTime))
    ) {
      expanded[key] = value;
      if (newTime !== undefined) expandedAt[key] = newTime;
    }
  }
  const records: Records = {
    threadLastVisitedAtById: visits,
    threadVisitEditsAtById: edits,
    threadVisitIsUnreadById: unread,
    sidebarTaskGroupsExpandedById: expanded,
    sidebarTaskGroupsExpandedAtById: expandedAt,
  };
  const unchanged = Object.entries(records).every(([key, value]) =>
    sameRecord(previous[key as keyof Records], value),
  );
  return unchanged ? previous : { ...previous, ...records };
}

export function syncSidebarTaskUiState(input: {
  key: string;
  store: { getState: () => UiState; setState: (state: Partial<UiState>) => void };
  parse: (value: PersistedUiState) => UiState;
  repair: (state: UiState) => void;
}) {
  let applying = false;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function")
    window.addEventListener("storage", (event) => {
      if (event.key !== input.key || event.newValue === null) return;
      try {
        const incoming = input.parse(JSON.parse(event.newValue));
        const next = mergeUiStateRecords(input.store.getState(), incoming);
        applying = true;
        if (next !== input.store.getState()) {
          const records: Records = {
            threadLastVisitedAtById: next.threadLastVisitedAtById,
            threadVisitEditsAtById: next.threadVisitEditsAtById ?? {},
            threadVisitIsUnreadById: next.threadVisitIsUnreadById ?? {},
            sidebarTaskGroupsExpandedById: next.sidebarTaskGroupsExpandedById,
            sidebarTaskGroupsExpandedAtById: next.sidebarTaskGroupsExpandedAtById ?? {},
          };
          input.store.setState(records);
        }
        // A simultaneous stale write can omit our keys; repair only that conflict.
        if (recordFields.some((field) => !sameRecord(next[field], incoming[field])))
          input.repair(next);
      } catch {
        // Malformed external state cannot invalidate this window.
      } finally {
        applying = false;
      }
    });
  return { isApplying: () => applying };
}
