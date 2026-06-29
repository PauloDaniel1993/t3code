import {
  DEFAULT_DEEPSEEK_MODEL,
  TextGenerationError,
  type DeepSeekSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import {
  type DeepSeekChatMessage,
  generateDeepSeekChatCompletion,
} from "../provider/deepseek/DeepSeekApi.ts";
import { readDeepSeekApiKey, readDeepSeekBaseUrl } from "../provider/Layers/DeepSeekProvider.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildHandoffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeHandoffSummary,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as TextGeneration from "./TextGeneration.ts";

const DEEPSEEK_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeDeepSeekTextGeneration = Effect.fn("makeDeepSeekTextGeneration")(function* (
  deepSeekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const httpClient = yield* HttpClient.HttpClient;

  const resolveReadyConfig = (operation: string) =>
    Effect.gen(function* () {
      if (!deepSeekSettings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "DeepSeek is disabled in T3 Code settings.",
        });
      }
      const apiKey = readDeepSeekApiKey(environment);
      const baseUrl = readDeepSeekBaseUrl(deepSeekSettings, environment);
      if (!apiKey) {
        return yield* new TextGenerationError({
          operation,
          detail: "DeepSeek API key is missing. Set DEEPSEEK_API_KEY in the provider environment.",
        });
      }
      if (!baseUrl) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "DeepSeek base URL is missing. Configure providers.deepseek.baseUrl or DEEPSEEK_BASE_URL.",
        });
      }
      return { apiKey, baseUrl };
    });

  const runDeepSeekJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateHandoffSummary";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const { apiKey, baseUrl } = yield* resolveReadyConfig(operation);
      const model = modelSelection.model?.trim() || DEFAULT_DEEPSEEK_MODEL;
      const messages: ReadonlyArray<DeepSeekChatMessage> = [
        {
          role: "system",
          content:
            "Return only a single JSON object matching the requested schema. Do not wrap it in Markdown.",
        },
        { role: "user", content: prompt },
      ];
      const response = yield* generateDeepSeekChatCompletion({
        httpClient,
        apiKey,
        baseUrl,
        model,
        messages,
        timeoutMs: DEEPSEEK_TEXT_GENERATION_TIMEOUT_MS,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "DeepSeek text generation request failed.",
              cause,
            }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(response.text)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "DeepSeek returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "DeepSeek text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("DeepSeekTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("DeepSeekTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("DeepSeekTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("DeepSeekTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateHandoffSummary: TextGeneration.TextGeneration["Service"]["generateHandoffSummary"] =
    Effect.fn("DeepSeekTextGeneration.generateHandoffSummary")(function* (input) {
      const { prompt, outputSchema } = buildHandoffSummaryPrompt({
        sourceThreadTitle: input.sourceThreadTitle,
        role: input.role,
        messageText: input.messageText,
        attachmentMetadata: input.attachmentMetadata,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateHandoffSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        summary: sanitizeHandoffSummary(generated.summary),
      } satisfies TextGeneration.HandoffSummaryGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateHandoffSummary,
  } satisfies TextGeneration.TextGeneration["Service"];
});
