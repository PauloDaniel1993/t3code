import { create } from "zustand";
import type { FlowId, FlowRunId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "../../rightPanelStore";
import type { FlowDefinition } from "@t3tools/contracts";

type Request = { flowId?: FlowId; flowRunId?: FlowRunId; start?: boolean };
export const flowDrafts = new Map<string, FlowDefinition>();
export const useFlowPanelRequest = create<{
  requests: Record<string, Request>;
  open: (thread: ScopedThreadRef, request: Request) => void;
}>((set) => ({
  requests: {},
  open: (thread, request) => {
    set((state) => ({ requests: { ...state.requests, [scopedThreadKey(thread)]: request } }));
    useRightPanelStore.getState().open(thread, "flow");
  },
}));
