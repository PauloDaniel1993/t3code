import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export interface DeepSeekChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class DeepSeekApiError extends Schema.TaggedErrorClass<DeepSeekApiError>()(
  "DeepSeekApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `DeepSeek API ${this.operation} failed: ${this.detail}`;
  }
}

const DeepSeekChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.NullOr(Schema.String),
      }),
    }),
  ),
  usage: Schema.optional(Schema.Unknown),
});

const decodeChatCompletionResponse = Schema.decodeUnknownEffect(DeepSeekChatCompletionResponse);
const isDeepSeekApiError = Schema.is(DeepSeekApiError);

export function normalizeDeepSeekChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export interface DeepSeekSseParseState {
  readonly buffer: string;
  readonly done: boolean;
}

export function parseDeepSeekSseChunk(input: {
  readonly state: DeepSeekSseParseState;
  readonly chunk: string;
}): {
  readonly state: DeepSeekSseParseState;
  readonly deltas: ReadonlyArray<string>;
} {
  if (input.state.done) {
    return { state: input.state, deltas: [] };
  }

  const normalized = `${input.state.buffer}${input.chunk}`.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const completeBlocks = parts.slice(0, -1);
  const remaining = parts.at(-1) ?? "";
  const deltas: string[] = [];
  let done = false;

  for (const block of completeBlocks) {
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) {
        continue;
      }
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") {
        done = true;
        break;
      }
      try {
        const parsed = JSON.parse(data) as unknown;
        const choices = Array.isArray((parsed as { choices?: unknown }).choices)
          ? (parsed as { choices: ReadonlyArray<unknown> }).choices
          : [];
        for (const choice of choices) {
          const delta = (choice as { delta?: { content?: unknown } }).delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            deltas.push(delta);
          }
        }
      } catch {
        continue;
      }
    }
    if (done) break;
  }

  return {
    state: {
      buffer: done ? "" : remaining,
      done,
    },
    deltas,
  };
}

const makeRequest = (input: {
  readonly operation: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly messages: ReadonlyArray<DeepSeekChatMessage>;
  readonly stream: boolean;
}) =>
  HttpClientRequest.post(normalizeDeepSeekChatCompletionsUrl(input.baseUrl)).pipe(
    HttpClientRequest.bearerToken(input.apiKey),
    HttpClientRequest.accept(input.stream ? "text/event-stream" : "application/json"),
    HttpClientRequest.bodyJson({
      model: input.model,
      messages: input.messages,
      stream: input.stream,
    }),
    Effect.mapError(
      (cause) =>
        new DeepSeekApiError({
          operation: input.operation,
          detail: "Failed to encode request body.",
          cause,
        }),
    ),
  );

export const streamDeepSeekChatCompletion = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly messages: ReadonlyArray<DeepSeekChatMessage>;
  readonly timeoutMs: number;
  readonly onDelta: (delta: string) => Effect.Effect<void>;
}): Effect.Effect<{ readonly text: string }, DeepSeekApiError> =>
  Effect.gen(function* () {
    let text = "";
    let state: DeepSeekSseParseState = { buffer: "", done: false };
    const request = yield* makeRequest({
      operation: "streamChatCompletion",
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      stream: true,
    });
    const response = yield* input.httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new DeepSeekApiError({
            operation: "streamChatCompletion",
            detail: "Streaming request failed.",
            cause,
          }),
      ),
    );

    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => {
        const parsed = parseDeepSeekSseChunk({ state, chunk });
        state = parsed.state;
        return Effect.forEach(
          parsed.deltas,
          (delta) => {
            text += delta;
            return input.onDelta(delta);
          },
          { discard: true },
        );
      }),
      Effect.timeoutOption(input.timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DeepSeekApiError({
                operation: "streamChatCompletion",
                detail: "Streaming request timed out.",
              }),
            ),
          onSome: () => Effect.void,
        }),
      ),
      Effect.mapError((cause) =>
        isDeepSeekApiError(cause)
          ? cause
          : new DeepSeekApiError({
              operation: "streamChatCompletion",
              detail: "Failed while reading streaming response.",
              cause,
            }),
      ),
    );

    const finalParsed = parseDeepSeekSseChunk({ state, chunk: "\n\n" });
    for (const delta of finalParsed.deltas) {
      text += delta;
      yield* input.onDelta(delta);
    }
    return { text };
  });

export const generateDeepSeekChatCompletion = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly messages: ReadonlyArray<DeepSeekChatMessage>;
  readonly timeoutMs: number;
}): Effect.Effect<{ readonly text: string; readonly usage?: unknown }, DeepSeekApiError> =>
  Effect.gen(function* () {
    const request = yield* makeRequest({
      operation: "generateChatCompletion",
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      stream: false,
    });
    const response = yield* input.httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeChatCompletionResponse),
      Effect.timeoutOption(input.timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DeepSeekApiError({
                operation: "generateChatCompletion",
                detail: "Request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isDeepSeekApiError(cause)
          ? cause
          : new DeepSeekApiError({
              operation: "generateChatCompletion",
              detail: "Request failed or returned an invalid response.",
              cause,
            }),
      ),
    );
    const text = response.choices
      .map((choice) => choice.message.content ?? "")
      .join("")
      .trim();
    if (text.length === 0) {
      return yield* new DeepSeekApiError({
        operation: "generateChatCompletion",
        detail: "Response did not contain assistant content.",
      });
    }
    return {
      text,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
    };
  });
