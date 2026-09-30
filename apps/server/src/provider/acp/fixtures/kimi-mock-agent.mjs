import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("Kimi Code CLI 0.29.0\n");
  process.exit(0);
}

const write = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const log = (method, params) =>
  NodeFS.appendFileSync(process.env.T3_KIMI_REQUEST_LOG, `${JSON.stringify({ method, params })}\n`);
const pending = new Map();
let nextId = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `kimi-client-${nextId++}`;
    pending.set(id, resolve);
    write({ id, method, params });
  });
let model = "kimi-live";
let mode = "yolo";
let activeSessionId;
const statePath = (sessionId) =>
  NodePath.join(process.env.KIMI_CODE_HOME, "sessions", sessionId, "model.json");
const saveSelection = () =>
  NodeFS.writeFileSync(statePath(activeSessionId), JSON.stringify({ model, mode }));
const modelChoices = () => {
  const catalogPath = NodePath.join(process.env.KIMI_CODE_HOME, "models.json");
  return NodeFS.existsSync(catalogPath)
    ? JSON.parse(NodeFS.readFileSync(catalogPath, "utf8"))
    : [
        { value: "kimi-live", name: "Live model" },
        { value: "kimi-saved", name: "Saved model" },
      ];
};
const configOptions = () => [
  {
    id: "llm",
    name: "Models",
    type: "select",
    currentValue: model,
    options: modelChoices(),
  },
  ...(process.env.T3_KIMI_NO_MODE
    ? []
    : [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: mode,
          options: [
            { value: "auto", name: "Auto", description: "Fully autonomous agent" },
            { value: "yolo", name: "Yolo" },
            { value: "default", name: "Default" },
            ...(process.env.T3_KIMI_NO_PLAN ? [] : [{ value: "plan", name: "Plan" }]),
          ],
        },
      ]),
  { id: "thinking", name: "Thinking", type: "boolean", currentValue: true },
];
const setup = (sessionId, resumed = false) => {
  const home = process.env.KIMI_CODE_HOME;
  const sessionDir = NodePath.join(home, "sessions", sessionId);
  NodeFS.mkdirSync(NodePath.join(sessionDir, "logs"), { recursive: true });
  activeSessionId = sessionId;
  if (resumed && NodeFS.existsSync(statePath(sessionId))) {
    ({ model, mode } = JSON.parse(NodeFS.readFileSync(statePath(sessionId), "utf8")));
  }
  saveSelection();
  NodeFS.appendFileSync(
    NodePath.join(home, "session_index.jsonl"),
    `${JSON.stringify({ sessionId, sessionDir })}\n`,
  );
  return {
    sessionId,
    ...(resumed && process.env.T3_KIMI_RESUME_NO_CONFIG === "1"
      ? {}
      : { configOptions: configOptions() }),
  };
};
let waitingPrompt;
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    log("client-response", message);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  log(method, {
    ...params,
    ...(method === "session/prompt" ? { modeAtPrompt: mode, modelAtPrompt: model } : {}),
    ...(method === "initialize"
      ? {
          environment: {
            KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
            KIMI_CODE_NO_AUTO_UPDATE: process.env.KIMI_CODE_NO_AUTO_UPDATE,
          },
        }
      : {}),
  });
  const reply = (result) => write({ id, result });
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: Number(process.env.T3_KIMI_PROTOCOL_VERSION ?? "1"),
        agentInfo: { name: "kimi-code-mock", version: "0.29.0" },
        authMethods: [{ id: "login", name: "Kimi login" }],
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: process.env.T3_KIMI_LOAD_ONLY ? {} : { resume: {} },
          promptCapabilities: { image: process.env.T3_KIMI_IMAGE === "1" },
        },
      });
      break;
    case "authenticate":
      if (process.env.T3_KIMI_AUTH_FAIL)
        write({ id, error: { code: -32000, message: "Login required" } });
      else reply({});
      break;
    case "session/new":
      reply(setup("mock-kimi-session"));
      break;
    case "session/resume":
    case "session/load":
      reply(setup(params.sessionId, true));
      break;
    case "session/set_config_option":
      if (params.configId === "llm") {
        model = params.value;
        mode = "yolo";
      }
      if (params.configId === "mode") mode = params.value;
      saveSelection();
      reply({ configOptions: configOptions() });
      break;
    case "session/cancel":
      waitingPrompt?.();
      waitingPrompt = undefined;
      break;
    case "session/prompt": {
      const { sessionId } = params;
      const update = (content) =>
        write({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: content },
            },
          },
        });
      if (process.env.T3_KIMI_HOLD) {
        update("Started");
        await new Promise((resolve) => {
          waitingPrompt = resolve;
        });
        reply({ stopReason: "cancelled" });
        break;
      }
      if (process.env.T3_KIMI_PERMISSION || process.env.T3_KIMI_QUESTION) {
        const question = process.env.T3_KIMI_QUESTION;
        await request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "kimi-tool",
            title: question ? "AskUserQuestion" : "Bash",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: question ? "Choose a route" : "Requesting approval to Running: git status",
                },
              },
            ],
          },
          options: question
            ? [
                { optionId: "fast", kind: "allow_once", name: "Fast" },
                { optionId: "safe", kind: "allow_once", name: "Safe" },
              ]
            : [
                { optionId: "once", name: "Allow", kind: "allow_once" },
                { optionId: "always", name: "Allow for session", kind: "allow_always" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
        });
      }
      if (process.env.T3_KIMI_FAIL_LOG) {
        NodeFS.appendFileSync(
          NodePath.join(process.env.KIMI_CODE_HOME, "sessions", sessionId, "logs", "kimi-code.log"),
          'acp: turn ended with failed reason error={"message":"Quota reached token=secret","code":"quota","retryable":true}\n',
        );
      }
      if (process.env.T3_KIMI_WRITE_FILE) {
        NodeFS.writeFileSync(
          NodePath.join(process.cwd(), "unexpected.txt"),
          "Unexpected tool work",
        );
      }
      if (process.env.T3_KIMI_TOOL_UPDATE) {
        write({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "unexpected-tool",
              title: "Bash",
              status: "in_progress",
            },
          },
        });
      }
      update(
        process.env.T3_KIMI_OUTPUT_SIZE
          ? "x".repeat(Number(process.env.T3_KIMI_OUTPUT_SIZE))
          : (process.env.T3_KIMI_OUTPUT ?? "Kimi reply"),
      );
      reply({ stopReason: "end_turn" });
      break;
    }
    default:
      write({ id, error: { code: -32601, message: `Unsupported: ${method}` } });
  }
});
