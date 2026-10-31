import { create } from "zustand";
import type { FlowId, FlowRunId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "../../rightPanelStore";
import type { createFlowDraft } from "@t3tools/client-runtime/flows";

type Request = { flowId?: FlowId; flowRunId?: FlowRunId; start?: boolean };
export const flowDrafts = new Map<string, ReturnType<typeof createFlowDraft>>();
export const useFlowPanelRequest = create<{
  requests: Record<string, Request>;
  consume: (key: string, request: Request) => void;
  open: (thread: ScopedThreadRef, request: Request) => void;
}>((set) => ({
  requests: {},
  consume: (key, request) =>
    set((state) => {
      if (state.requests[key] !== request) return state;
      const requests = { ...state.requests };
      delete requests[key];
      return { requests };
    }),
  open: (thread, request) => {
    set((state) => ({ requests: { ...state.requests, [scopedThreadKey(thread)]: request } }));
    useRightPanelStore.getState().open(thread, "flow");
  },
}));
