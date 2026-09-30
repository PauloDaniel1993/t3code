/**
 * Opt-in compatibility probe for the current Node-based Kimi Code CLI.
 *
 * Enable the subscription-safe core probe with:
 *   T3_KIMI_ACP_PROBE=1 ./node_modules/.bin/vp test run src/provider/acp/KimiAcpCliProbe.test.ts
 *
 * Set T3_KIMI_CODE_HOME to an authenticated test home when isolation is
 * required. Set T3_KIMI_ACP_INTERACTION_PROBE=1 to additionally request a
 * question/permission exchange; every observed request is cancelled and only
 * redacted shape metadata is retained in memory.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import { makeKimiAcpRuntime, probeKimiAcpAuthentication } from "./KimiAcpSupport.ts";

interface RedactedObservation {
  readonly method: string;
  readonly status: string;
  readonly shape?: ReadonlyArray<string>;
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

function describeRawInputShape(rawInput: unknown): ReadonlyArray<string> {
  if (!isRecord(rawInput)) {
    return [`raw:${typeof rawInput}`];
  }
  const record = rawInput;
  const shape = [`raw-keys:${Object.keys(record).sort().join(",")}`];
  if (Array.isArray(record.questions) && record.questions.length > 0) {
    const first = record.questions[0];
    if (isRecord(first)) {
      const question = first;
      shape.push(`question-keys:${Object.keys(question).sort().join(",")}`);
      if (Array.isArray(question.options) && question.options.length > 0) {
        const option = question.options[0];
        if (isRecord(option)) {
          shape.push(`option-keys:${Object.keys(option).sort().join(",")}`);
        }
      }
    }
  }
  return shape;
}

const binaryPath = process.env.T3_KIMI_BINARY?.trim() || "kimi";
const decodeSetupShape = Schema.decodeUnknownOption(
  Schema.Struct({
    configOptions: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            category: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
);
const probeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  KIMI_CODE_NO_AUTO_UPDATE: "1",
  ...(process.env.T3_KIMI_CODE_HOME?.trim()
    ? { KIMI_CODE_HOME: process.env.T3_KIMI_CODE_HOME.trim() }
    : {}),
};

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI probe", () => {
  it.live(
    "authenticates, starts, settles a prompt, and resumes without exposing secrets",
    () =>
      Effect.gen(function* () {
        const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-kimi-probe-",
        });
        const authentication = yield* probeKimiAcpAuthentication(
          { binaryPath },
          probeEnvironment,
          cwd,
        );
        expect([1, 2]).toContain(authentication.protocolVersion);

        const observations: Array<RedactedObservation> = [];
        const startNativeSession = (resumeSessionId?: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const runtime = yield* makeKimiAcpRuntime({
                kimiSettings: { binaryPath },
                childProcessSpawner,
                environment: probeEnvironment,
                cwd,
                ...(resumeSessionId ? { resumeSessionId } : {}),
                supervisionGuidance: false,
                mcpServers: [],
                acpMcpServers: [],
                clientCapabilities: {
                  elicitation: { form: {} },
                  fs: { readTextFile: false, writeTextFile: false },
                  terminal: false,
                },
                clientInfo: { name: "t3-kimi-compatibility-probe", version: "0.0.0" },
                requestLogger: (event) =>
                  Effect.sync(() => {
                    observations.push({ method: event.method, status: event.status });
                    if (
                      ["session/new", "session/resume", "session/load"].includes(event.method) &&
                      event.status === "succeeded"
                    ) {
                      const setup = Option.getOrUndefined(decodeSetupShape(event.result));
                      observations.push({
                        method: `${event.method}/raw-config`,
                        status: "observed",
                        shape: [
                          `configOptions:${setup?.configOptions == null ? "absent" : "present"}`,
                          ...(setup?.configOptions ?? []).map(
                            (option) =>
                              `id:${option.id};name:${option.name};category:${option.category ?? "absent"}`,
                          ),
                        ],
                      });
                    }
                  }),
              });
              yield* runtime.getEvents().pipe(
                Stream.runForEach((event) =>
                  event._tag === "EventStreamBarrier"
                    ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkScoped,
              );

              yield* runtime.handleRequestPermission((request) =>
                Effect.sync(() => {
                  observations.push({
                    method: "session/request_permission",
                    status: "observed",
                    shape: [
                      request.toolCall.title === "AskUserQuestion" ? "question" : "tool",
                      `tool-kind:${request.toolCall.kind ?? "unknown"}`,
                      `approval-prefix:${
                        request.toolCall.content?.some(
                          (entry) =>
                            entry.type === "content" &&
                            entry.content.type === "text" &&
                            /^Requesting approval to Running:/i.test(
                              entry.content.text.trimStart(),
                            ),
                        ) === true
                      }`,
                      ...request.options.map((option) => option.kind),
                      ...describeRawInputShape(request.toolCall.rawInput),
                    ],
                  });
                  return { outcome: { outcome: "cancelled" as const } };
                }),
              );
              yield* runtime.handleElicitation((request) =>
                Effect.sync(() => {
                  const schema = request.mode === "form" ? request.requestedSchema : undefined;
                  const properties =
                    isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
                  observations.push({
                    method: "session/elicitation",
                    status: "observed",
                    shape:
                      request.mode === "form"
                        ? Object.values(properties).map((property) =>
                            isRecord(property) && typeof property.type === "string"
                              ? property.type
                              : "unknown",
                          )
                        : ["url"],
                  });
                  return { action: "cancel" as const };
                }),
              );

              const started = yield* runtime.start().pipe(Effect.timeout("60 seconds"));
              const capabilities = started.initializeResult.agentCapabilities;
              observations.push({
                method: "initialize/capabilities",
                status: "observed",
                shape: [
                  `protocolVersion:${started.initializeResult.protocolVersion}`,
                  ...(started.initializeResult.authMethods?.map(
                    (method) => `auth-type:${method.type ?? "absent"}`,
                  ) ?? []),
                  capabilities?.sessionCapabilities?.resume != null ? "resume" : "no-resume",
                  capabilities?.loadSession === true ? "load" : "no-load",
                  capabilities?.promptCapabilities?.image === true ? "image" : "no-image",
                  capabilities?.promptCapabilities?.embeddedContext === true
                    ? "embedded-context"
                    : "no-embedded-context",
                  capabilities?.mcpCapabilities?.http === true ? "mcp-http" : "no-mcp-http",
                  capabilities?.mcpCapabilities?.sse === true ? "mcp-sse" : "no-mcp-sse",
                  capabilities?.mcpCapabilities?.acp === true ? "mcp-acp" : "no-mcp-acp",
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
              ["session/resume", "session/load"].includes(observation.method) &&
              observation.status === "succeeded",
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
        yield* Effect.logInfo("Kimi ACP compatibility observations", { observations });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 240_000 },
  );
});
