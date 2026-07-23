import type { AcpParsedSessionEvent, AcpToolCallState } from "./AcpRuntimeModel.ts";

type ToolCallUpdatedEvent = Extract<AcpParsedSessionEvent, { readonly _tag: "ToolCallUpdated" }>;

interface ToolProgressEntry {
  readonly lastEmittedAt: number;
  readonly lastSignature: string;
  readonly terminal?: boolean;
  readonly pending?: ToolCallUpdatedEvent;
}

export interface AcpToolProgressCoalescerState {
  readonly entries: ReadonlyMap<string, ToolProgressEntry>;
  readonly coalescedCount: number;
}

export interface AcpToolProgressTransition {
  readonly state: AcpToolProgressCoalescerState;
  readonly events: ReadonlyArray<ToolCallUpdatedEvent>;
}

export const emptyAcpToolProgressCoalescerState = (): AcpToolProgressCoalescerState => ({
  entries: new Map(),
  coalescedCount: 0,
});

const isTerminal = (toolCall: AcpToolCallState): boolean =>
  toolCall.status === "completed" || toolCall.status === "failed";

const hasMeaningfulPresentation = (toolCall: AcpToolCallState): boolean =>
  toolCall.detail !== undefined;

const presentationSignature = (toolCall: AcpToolCallState): string =>
  JSON.stringify([toolCall.title ?? null, toolCall.detail ?? null, toolCall.status ?? null]);

const withoutRawPayload = (event: ToolCallUpdatedEvent): ToolCallUpdatedEvent => ({
  ...event,
  rawPayload: undefined,
});

export function coalesceAcpToolProgress(
  state: AcpToolProgressCoalescerState,
  event: ToolCallUpdatedEvent,
  now: number,
  intervalMs: number,
): AcpToolProgressTransition {
  const normalizedEvent = withoutRawPayload(event);
  const toolCallId = event.toolCall.toolCallId;
  const signature = presentationSignature(event.toolCall);
  const current = state.entries.get(toolCallId);
  const entries = new Map(state.entries);

  if (current?.terminal === true) {
    return {
      state: {
        ...state,
        coalescedCount: state.coalescedCount + 1,
      },
      events: [],
    };
  }
  if (isTerminal(event.toolCall)) {
    entries.set(toolCallId, {
      lastEmittedAt: now,
      lastSignature: signature,
      terminal: true,
    });
    return {
      state: {
        entries,
        coalescedCount: state.coalescedCount + (current?.pending === undefined ? 0 : 1),
      },
      events: [normalizedEvent],
    };
  }
  if (!hasMeaningfulPresentation(event.toolCall)) {
    return { state, events: [] };
  }
  if (current === undefined) {
    entries.set(toolCallId, {
      lastEmittedAt: now,
      lastSignature: signature,
    });
    return {
      state: { ...state, entries },
      events: [normalizedEvent],
    };
  }
  if (current.lastSignature === signature && current.pending === undefined) {
    return {
      state: {
        ...state,
        coalescedCount: state.coalescedCount + 1,
      },
      events: [],
    };
  }
  if (now - current.lastEmittedAt >= intervalMs) {
    entries.set(toolCallId, {
      lastEmittedAt: now,
      lastSignature: signature,
    });
    return {
      state: { ...state, entries },
      events: [normalizedEvent],
    };
  }

  entries.set(toolCallId, {
    ...current,
    pending: normalizedEvent,
  });
  return {
    state: {
      entries,
      coalescedCount: state.coalescedCount + 1,
    },
    events: [],
  };
}

export function flushDueAcpToolProgress(
  state: AcpToolProgressCoalescerState,
  now: number,
  intervalMs: number,
): AcpToolProgressTransition {
  const entries = new Map(state.entries);
  const events: Array<ToolCallUpdatedEvent> = [];
  for (const [toolCallId, entry] of entries) {
    if (entry.pending === undefined || now - entry.lastEmittedAt < intervalMs) {
      continue;
    }
    events.push(entry.pending);
    entries.set(toolCallId, {
      lastEmittedAt: now,
      lastSignature: presentationSignature(entry.pending.toolCall),
    });
  }
  return {
    state: { ...state, entries },
    events,
  };
}

export function flushAllAcpToolProgress(
  state: AcpToolProgressCoalescerState,
): AcpToolProgressTransition {
  const events: Array<ToolCallUpdatedEvent> = [];
  const entries = new Map<string, ToolProgressEntry>();
  for (const [toolCallId, entry] of state.entries) {
    if (entry.pending !== undefined) {
      events.push(entry.pending);
    }
    entries.set(toolCallId, {
      lastEmittedAt: entry.lastEmittedAt,
      lastSignature:
        entry.pending === undefined
          ? entry.lastSignature
          : presentationSignature(entry.pending.toolCall),
    });
  }
  return {
    state: { ...state, entries },
    events,
  };
}

export function clearAcpToolProgress(
  state: AcpToolProgressCoalescerState,
): AcpToolProgressCoalescerState {
  return {
    entries: new Map(),
    coalescedCount: state.coalescedCount,
  };
}
