// oxlint-disable t3code/no-manual-effect-runtime-in-tests
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, DeepSeekSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, it } from "vite-plus/test";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { T3_MCP_USER_INPUT_DEEPSEEK_UNSUPPORTED_MESSAGE } from "../T3McpUserInputTool.ts";
import { makeDeepSeekAdapter } from "./DeepSeekAdapter.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const THREAD_ID = ThreadId.make("thread-deepseek-user-input");
const READY_ENV: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: "ds-test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.example/v1",
};

const adapterLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("", {
          status: 204,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

it("returns explicit T3 MCP guidance for unsupported DeepSeek user-input responses", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeDeepSeekAdapter(decodeDeepSeekSettings({ enabled: true }), {
          environment: READY_ENV,
        });

        const result = yield* adapter
          .respondToUserInput(THREAD_ID, ApprovalRequestId.make("deepseek-user-input"), {})
          .pipe(Effect.result);

        return result;
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(ProviderAdapterRequestError);
    expect(result.failure._tag).toBe("ProviderAdapterRequestError");
    if (result.failure._tag === "ProviderAdapterRequestError") {
      expect(result.failure.detail).toBe(T3_MCP_USER_INPUT_DEEPSEEK_UNSUPPORTED_MESSAGE);
    }
  }
});
