import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export type JsonTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface JsonTextGenerationRunOptions {
  readonly operation: JsonTextGenerationOperation;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly timeoutMs: number;
}

export interface JsonTextGenerationConfig {
  readonly providerLabel: string;
  readonly defaultTimeoutMs: number;
  readonly runRaw: (
    prompt: string,
    options: JsonTextGenerationRunOptions,
  ) => Effect.Effect<string, TextGenerationError>;
  readonly isTransientError?: (error: TextGenerationError) => boolean;
}

function defaultIsTransientError(error: TextGenerationError): boolean {
  const detail = error.detail.toLowerCase();
  return (
    detail.includes("timed out") ||
    detail.includes("timeout") ||
    detail.includes("network") ||
    detail.includes("temporar") ||
    detail.includes("invalid structured output") ||
    detail.includes("malformed")
  );
}

export function makeJsonTextGeneration(
  config: JsonTextGenerationConfig,
): TextGeneration.TextGeneration["Service"] {
  const runJson = <S extends Schema.Top>(input: {
    readonly operation: JsonTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> => {
    const attempt = config
      .runRaw(input.prompt, {
        operation: input.operation,
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        timeoutMs: config.defaultTimeoutMs,
      })
      .pipe(
        Effect.timeoutOption(config.defaultTimeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${config.providerLabel} request timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.flatMap((raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: `${config.providerLabel} returned empty output.`,
              }),
            );
          }
          // oxlint-disable-next-line t3code/no-inline-schema-compile -- The caller supplies a different output schema per operation.
          return Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
            extractJsonObject(trimmed),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${config.providerLabel} returned invalid structured output.`,
                  cause,
                }),
            ),
          );
        }),
      );

    return attempt.pipe(
      Effect.retry({
        times: 1,
        while: config.isTransientError ?? defaultIsTransientError,
      }),
    );
  };

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("JsonTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
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
    Effect.fn("JsonTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("JsonTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("JsonTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
}
