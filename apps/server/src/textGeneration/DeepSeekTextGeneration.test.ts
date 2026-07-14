import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekSettings,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makeDeepSeekTextGeneration } from "./DeepSeekTextGeneration.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const READY_ENV: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: "ds-test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.example/v1",
};

const readySettings = () => decodeDeepSeekSettings({ enabled: true });

// The non-streaming text-generation path posts a Chat Completions request and
// reads `response.json`. We fake a Web Response containing the OpenAI-style
// completion envelope so the real decode + extractJsonObject pipeline runs.
function completionHttpClientLayer(assistantContent: string, status = 200) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              choices: [{ message: { content: assistantContent } }],
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

const modelSelection = createModelSelection(
  ProviderInstanceId.make("deepseek"),
  DEFAULT_DEEPSEEK_MODEL,
);

describe("makeDeepSeekTextGeneration", () => {
  it.effect("parses a valid structured thread-title response", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeDeepSeekTextGeneration(readySettings(), READY_ENV);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Refactor the routing layer to support nested params",
        modelSelection,
      });

      assert.equal(result.title, "Routing layer refactor");
    }).pipe(
      Effect.provide(
        completionHttpClientLayer(JSON.stringify({ title: "Routing layer refactor" })),
      ),
    ),
  );

  it.effect("extracts JSON even when the model wraps it in prose/markdown", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeDeepSeekTextGeneration(readySettings(), READY_ENV);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the flaky login test",
        modelSelection,
      });

      assert.equal(result.title, "Stabilize login test");
    }).pipe(
      Effect.provide(
        completionHttpClientLayer(
          'Here is your title:\n```json\n{"title":"Stabilize login test"}\n```',
        ),
      ),
    ),
  );

  it.effect("fails with TextGenerationError on structurally invalid output", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeDeepSeekTextGeneration(readySettings(), READY_ENV);

      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, TextGenerationError);
        assert.equal(result.failure.operation, "generateThreadTitle");
        assert.match(result.failure.detail, /invalid structured output/u);
      }
    }).pipe(
      // `title` is the wrong type, so schema decoding rejects it.
      Effect.provide(completionHttpClientLayer(JSON.stringify({ title: 123 }))),
    ),
  );

  it.effect("fails with TextGenerationError when DeepSeek is disabled", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeDeepSeekTextGeneration(
        decodeDeepSeekSettings({ enabled: false }),
        READY_ENV,
      );

      const result = yield* textGeneration
        .generateThreadTitle({ cwd: process.cwd(), message: "anything", modelSelection })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, TextGenerationError);
        assert.match(result.failure.detail, /disabled/u);
      }
    }).pipe(Effect.provide(completionHttpClientLayer("{}"))),
  );
});
