import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const stamp = "2026-01-01T00:00:00.000Z";
const message = {
  id: "message",
  threadId: "thread",
  runId: null,
  nodeId: null,
  createdBy: "system",
  creationSource: "server",
  role: "user",
  text: "Task finished",
  attachments: [],
  streaming: false,
  createdAt: stamp,
  updatedAt: stamp,
};
const item = {
  id: "item",
  threadId: "thread",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: stamp,
  completedAt: stamp,
  updatedAt: stamp,
};

describe("legacy message provenance", () => {
  it("round-trips exact source tags without changing old messages", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
    const encode = Schema.encodeSync(OrchestrationV2ConversationMessageJson);
    for (const source of ["user", "provider", "system", "task-result"]) {
      expect(encode(decode({ ...message, source }))).toEqual({ ...message, source });
    }
    expect(encode(decode(message))).toEqual(message);
  });

  it("round-trips reasoning identity and provenance in the existing timeline variant", () => {
    const legacy = {
      ...item,
      type: "reasoning",
      messageId: "reasoning-message",
      legacyMessageSource: "provider",
      text: "Thinking",
      streaming: false,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
    const encode = Schema.encodeSync(OrchestrationV2TurnItemJson);
    expect(encode(decode(legacy))).toEqual(legacy);
    const native = { ...item, type: "reasoning", text: "Native thinking", streaming: false };
    expect(encode(decode(native))).toEqual(native);
  });
});
