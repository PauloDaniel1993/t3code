import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { makeKimiTestHarness } from "./KimiTestHarness.ts";
import { applyKimiAcpModelSelection, isKimiAcpCompatible } from "./KimiAcpSupport.ts";
import { buildKimiModels } from "../KimiModels.ts";
import { extractKimiPermissionQuestion } from "./KimiProtocol.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })("Kimi ACP runtime", (it) => {
  for (const version of [1, 2, 3]) {
    it.effect(`negotiates ACP ${version} through the real transport`, () =>
      Effect.gen(function* () {
        const h = yield* makeKimiTestHarness({ T3_KIMI_PROTOCOL_VERSION: String(version) });
        const runtime = yield* h.makeRuntime({
          cwd: h.root,
          clientInfo: { name: "kimi-test", version: "0.0.0" },
        });
        if (version <= 2) {
          expect((yield* runtime.start()).initializeResult.protocolVersion).toBe(version);
        } else {
          expect((yield* runtime.start().pipe(Effect.flip)).message).toContain("protocol 1 or 2");
          expect((yield* h.requests).map((request) => request.method)).toEqual(["initialize"]);
        }
      }).pipe(Effect.scoped),
    );
  }
  for (const loadOnly of [false, true]) {
    it.effect(`restores a native session with ${loadOnly ? "load" : "resume"}`, () =>
      Effect.gen(function* () {
        const h = yield* makeKimiTestHarness(loadOnly ? { T3_KIMI_LOAD_ONLY: "1" } : {});
        const runtime = yield* h.makeRuntime({
          cwd: h.root,
          resumeSessionId: "saved-session",
          clientInfo: { name: "kimi-test", version: "0.0.0" },
        });
        const started = yield* runtime.start();
        expect(started.sessionId).toBe("saved-session");
        const requests = yield* h.requests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "authenticate",
          loadOnly ? "session/load" : "session/resume",
        ]);
        expect(requests[1]?.params).toEqual({ methodId: "login" });
        expect(requests[0]?.params.environment).toEqual({
          KIMI_CODE_HOME: h.home,
          KIMI_CODE_NO_AUTO_UPDATE: "1",
        });
        // The shared V2 adapter uses loadSession to activate an open thread.
        yield* runtime.loadSession("another-saved-session");
        expect((yield* h.requests).at(-1)).toMatchObject({
          method: loadOnly ? "session/load" : "session/resume",
          params: { sessionId: "another-saved-session" },
        });
      }).pipe(Effect.scoped),
    );
  }

  it.effect("keeps autonomous modes out of saved options and respects the default alias", () =>
    Effect.gen(function* () {
      const h = yield* makeKimiTestHarness();
      const runtime = yield* h.makeRuntime({
        cwd: h.root,
        clientInfo: { name: "kimi-test", version: "0.0.0" },
      });
      yield* runtime.start();
      yield* runtime.setMode("default");
      yield* runtime.setConfigOption("mode", "yolo");
      yield* runtime.setMode("auto");
      expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
      const original = yield* applyKimiAcpModelSelection({ runtime, model: "kimi-default" });
      expect(original).toBe("kimi-live");
      yield* applyKimiAcpModelSelection({ runtime, model: "kimi-saved" });
      yield* runtime.setMode("plan");
      expect((yield* runtime.getModeState)?.currentModeId).toBe("plan");
      const requests = yield* h.requests;
      expect(
        requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => request.params),
      ).toEqual([
        { sessionId: "mock-kimi-session", configId: "mode", value: "default" },
        { sessionId: "mock-kimi-session", configId: "llm", value: "kimi-saved" },
        { sessionId: "mock-kimi-session", configId: "mode", value: "plan" },
      ]);
      const models = buildKimiModels([], yield* runtime.getConfigOptions);
      expect(models.map((model) => model.slug)).toEqual([
        "kimi-default",
        "kimi-live",
        "kimi-saved",
      ]);
      expect(models[0]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
        "thinking",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("adds supervision guidance without rewriting the user's text", () =>
    Effect.gen(function* () {
      const h = yield* makeKimiTestHarness();
      const runtime = yield* h.makeRuntime({
        cwd: h.root,
        clientInfo: { name: "kimi-test", version: "0.0.0" },
      });
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.prompt({ prompt: [{ type: "text", text: "  original request  " }] });
      yield* runtime.drainEvents;
      const prompt = (yield* h.requests).find((request) => request.method === "session/prompt");
      expect(prompt?.params.prompt).toEqual([
        { type: "text", text: expect.stringContaining("<t3-subagent-supervision>") },
        { type: "text", text: "  original request  " },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("probes authentication without creating a session", () =>
    Effect.gen(function* () {
      const h = yield* makeKimiTestHarness();
      const runtime = yield* h.makeRuntime({
        cwd: h.root,
        clientInfo: { name: "kimi-test", version: "0.0.0" },
      });
      yield* runtime.initialize();
      yield* runtime.authenticate!("login");
      expect((yield* h.requests).map((request) => request.method)).toEqual([
        "initialize",
        "authenticate",
      ]);
      expect(yield* (yield* FileSystem.FileSystem).exists(h.home)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("Kimi questions", () => {
  it("rejects incompatible versions and agents without native resume support", () => {
    for (const protocolVersion of [0, 3])
      expect(
        isKimiAcpCompatible({ protocolVersion, agentCapabilities: { loadSession: true } }),
      ).toBe(false);
    expect(isKimiAcpCompatible({ protocolVersion: 2, agentCapabilities: {} })).toBe(false);
  });
  it("matches answer labels and option IDs and cancels invalid answers", () => {
    const request = {
      sessionId: "s",
      toolCall: {
        toolCallId: "q",
        title: "AskUserQuestion",
        content: [{ type: "content" as const, content: { type: "text" as const, text: "Choose" } }],
      },
      options: [
        { optionId: "first", name: "First", kind: "allow_once" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
      ],
    };
    const parsed = extractKimiPermissionQuestion(request);
    expect(parsed?.question.options).toEqual([{ label: "First", description: "First" }]);
    expect(parsed?.respond({ q: "FIRST" })).toEqual({
      outcome: { outcome: "selected", optionId: "first" },
    });
    expect(parsed?.respond({ q: "deny" })).toBeUndefined();
    expect(parsed?.respond({ q: "free text" })).toBeUndefined();
  });
});
