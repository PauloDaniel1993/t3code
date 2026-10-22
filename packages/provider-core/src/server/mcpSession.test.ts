import { describe, expect, it } from "vite-plus/test";
import {
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";
import { withAgentDeviceEnvironment } from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("MCP-enabled provider instructions", () => {
  it("routes task requests through the aliases while preserving isolation and model choices", () => {
    const prompt = t3OrchestrationSystemPrompt(true)!;
    expect(prompt).toContain("prefer T3 tasks over native provider agents");
    expect(prompt).toContain("Use native agents when the user explicitly asks");
    expect(prompt).toContain("Call `task_models` before `task_create`");
    expect(prompt).toContain("Use `task_list` to recover task IDs and results after compaction");
    expect(prompt).toContain("pass `search` to find others");
    expect(prompt).toContain('`isolation:"worktree"`');
    expect(prompt).toContain("uncommitted edits are not copied");
    expect(prompt).toContain("`target.options`");
    expect(prompt).toContain("ordinary top-level T3 conversations");
    expect(prompt).toContain("call `delegate_task` again");
    expect(prompt).toContain("Async completion wakes the parent with task IDs, not results");
    expect(prompt).toContain("pending request tools answer questions only");
    expect(prompt).toContain("later completions from that turn no longer wake it");
    expect(t3OrchestrationSystemPrompt(false)).toBeUndefined();
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      expect(Buffer.byteLength(section, "utf8")).toBeLessThan(4_000);
    }
  });

  it("delivers task routing to ACP sessions without rewriting native slash commands", () => {
    const state = { interactionMode: "default", hasT3Mcp: true } as const;
    expect(t3AcpPromptWithInstructions({ prompt: "Delegate this task.", state })).toContain(
      "Call `task_models` before `task_create`",
    );
    expect(t3AcpPromptWithInstructions({ prompt: "/compact", state })).toBe("/compact");
    expect(t3AcpPromptWithInstructions({ prompt: "Continue.", state, previousState: state })).toBe(
      "Continue.",
    );
  });
});
