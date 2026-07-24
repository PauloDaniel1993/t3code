/**
 * Opt-in compatibility probe for the current Node-based Kimi Code CLI.
 *
 * Enable the subscription-safe core probe with:
 *   T3_KIMI_ACP_PROBE=1 vp test run src/provider/acp/KimiAcpCliProbe.test.ts
 *
 * Set T3_KIMI_CODE_HOME to an authenticated test home when isolation is
 * required. Set T3_KIMI_ACP_INTERACTION_PROBE=1 to additionally request a
 * question/permission exchange; every observed request is cancelled and only
 * redacted shape metadata is retained in memory.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import { makeKimiAcpRuntime, probeKimiAcpAuthentication } from "./KimiAcpSupport.ts";

interface RedactedObservation {
  readonly method: string;
  readonly status: string;
  readonly shape?: ReadonlyArray<string>;
}

function describeRawInputShape(rawInput: unknown): ReadonlyArray<string> {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return [`raw:${typeof rawInput}`];
  }
  const record = rawInput as Record<string, unknown>;
  const shape = [`raw-keys:${Object.keys(record).sort().join(",")}`];
  if (Array.isArray(record.questions) && record.questions.length > 0) {
    const first = record.questions[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      const question = first as Record<string, unknown>;
      shape.push(`question-keys:${Object.keys(question).sort().join(",")}`);
      if (Array.isArray(question.options) && question.options.length > 0) {
        const option = question.options[0];
        if (typeof option === "object" && option !== null && !Array.isArray(option)) {
          shape.push(
            `option-keys:${Object.keys(option as Record<string, unknown>)
              .sort()
              .join(",")}`,
          );
        }
      }
    }
  }
  return shape;
}

const binaryPath = process.env.T3_KIMI_BINARY?.trim() || "kimi";
const probeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  KIMI_CODE_NO_AUTO_UPDATE: "1",
  ...(process.env.T3_KIMI_CODE_HOME?.trim()
    ? { KIMI_CODE_HOME: process.env.T3_KIMI_CODE_HOME.trim() }
    : {}),
};

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI probe", () => {
  it.effect("authenticates, starts, settles a prompt, and resumes without exposing secrets", () =>
    Effect.gen(function* () {
      const authentication = yield* probeKimiAcpAuthentication(
        { binaryPath },
        probeEnvironment,
        process.cwd(),
      );
      expect(authentication.initializeResult.protocolVersion).toBeGreaterThan(0);

      const observations: Array<RedactedObservation> = [];
      const startNativeSession = (resumeSessionId?: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const scope = yield* Scope.Scope;
            const runtime = yield* makeKimiAcpRuntime({
              kimiSettings: { binaryPath },
              childProcessSpawner,
              environment: probeEnvironment,
              cwd: process.cwd(),
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientCapabilities: { elicitation: { form: {} } },
              clientInfo: { name: "t3-kimi-compatibility-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  observations.push({ method: event.method, status: event.status });
                }),
            }).pipe(Effect.provideService(Scope.Scope, scope));

            yield* runtime.handleRequestPermission((request) =>
              Effect.sync(() => {
                observations.push({
                  method: "session/request_permission",
                  status: "observed",
                  shape: [
                    request.toolCall.title === "AskUserQuestion" ? "question" : "tool",
                    `tool-kind:${request.toolCall.kind ?? "unknown"}`,
                    ...request.options.map((option) => option.kind),
                    ...describeRawInputShape(request.toolCall.rawInput),
                  ],
                });
                return { outcome: { outcome: "cancelled" as const } };
              }),
            );
            yield* runtime.handleElicitation((request) =>
              Effect.sync(() => {
                observations.push({
                  method: "session/elicitation",
                  status: "observed",
                  shape:
                    request.mode === "form"
                      ? Object.values(request.requestedSchema.properties ?? {}).map(
                          (property) => property.type,
                        )
                      : ["url"],
                });
                return { action: { action: "cancel" as const } };
              }),
            );

            const started = yield* runtime.start().pipe(Effect.timeout("60 seconds"));
            const capabilities = started.initializeResult.agentCapabilities;
            observations.push({
              method: "initialize/capabilities",
              status: "observed",
              shape: [
                capabilities?.promptCapabilities?.image === true ? "image" : "no-image",
                capabilities?.promptCapabilities?.embeddedContext === true
                  ? "embedded-context"
                  : "no-embedded-context",
                capabilities?.mcpCapabilities?.http === true ? "mcp-http" : "no-mcp-http",
                capabilities?.mcpCapabilities?.sse === true ? "mcp-sse" : "no-mcp-sse",
              ],
            });
            observations.push({
              method: resumeSessionId ? "session/resume/config" : "session/new/config",
              status: "observed",
              shape: (started.sessionSetupResult.configOptions ?? []).map(
                (option) => `${option.category ?? "uncategorized"}:${option.type}`,
              ),
            });

            if (!resumeSessionId) {
              const settled = yield* runtime
                .prompt({
                  prompt: [
                    {
                      type: "text",
                      text: "Reply with exactly T3_KIMI_PROBE_OK. Do not use tools.",
                    },
                  ],
                })
                .pipe(Effect.timeout("60 seconds"));
              expect(typeof settled.stopReason).toBe("string");

              if (process.env.T3_KIMI_ACP_INTERACTION_PROBE === "1") {
                yield* runtime
                  .prompt({
                    prompt: [
                      {
                        type: "text",
                        text: "Ask one short scope question, then request approval for a harmless read-only shell command. Do not run anything after a denial.",
                      },
                    ],
                  })
                  .pipe(Effect.timeout("90 seconds"));
              }
            }
            return started;
          }),
        );

      const created = yield* startNativeSession();
      const resumed = yield* startNativeSession(created.sessionId);
      expect(resumed.sessionId).toBe(created.sessionId);

      expect(
        observations.some(
          (observation) =>
            observation.method === "session/new" && observation.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        observations.some(
          (observation) =>
            observation.method === "session/resume" && observation.status === "succeeded",
        ),
      ).toBe(true);
      if (process.env.T3_KIMI_ACP_INTERACTION_PROBE === "1") {
        expect(
          observations.some(
            (observation) =>
              observation.method === "session/request_permission" ||
              observation.method === "session/elicitation",
          ),
        ).toBe(true);
      }
      const redactedText = observations.flatMap((observation) => [
        observation.method,
        observation.status,
        ...(observation.shape ?? []),
      ]);
      expect(redactedText.join("\n")).not.toMatch(/bearer|access[_-]?token|refresh[_-]?token/i);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
