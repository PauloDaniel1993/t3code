import * as NodeCrypto from "node:crypto";

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatAttachment,
  type HandoffCompressionSummary,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThread,
  type TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  limitHeadTailSection,
  sanitizeHandoffSummary,
} from "../../textGeneration/TextGenerationUtils.ts";

export const HANDOFF_BOOTSTRAP_CONTEXT_BUDGET_CHARS = 80_000;
export const HANDOFF_MESSAGE_COMPRESSION_THRESHOLD_CHARS = 12_000;

export interface BuildHandoffBootstrapInput {
  readonly thread: OrchestrationThread;
  readonly latestUserMessage: OrchestrationMessage;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  readonly summarizeHandoffMessage: (input: {
    readonly cwd: string;
    readonly sourceThreadTitle: string;
    readonly role: "user" | "assistant" | "system";
    readonly messageText: string;
    readonly attachmentMetadata: ReadonlyArray<string>;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<{ readonly summary: string }, TextGenerationError>;
}

export interface HandoffBootstrapContextResult {
  readonly providerInput: string;
  readonly compressionSummaries: ReadonlyArray<HandoffCompressionSummary>;
  readonly wasTrimmed: boolean;
}

export function attachmentMetadataLines(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<string> {
  return (attachments ?? []).map(
    (attachment) =>
      `${attachment.type}:${attachment.id} ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
}

export function handoffSourceTextHash(input: {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachmentMetadata: ReadonlyArray<string>;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(input.role)
    .update("\n")
    .update(input.text)
    .update("\n")
    .update(input.attachmentMetadata.join("\n"))
    .digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function deterministicFallbackSummary(text: string): string {
  return sanitizeHandoffSummary(
    [
      "Summary generation failed. Deterministic head/tail excerpt follows.",
      "",
      limitHeadTailSection(text, 3_800),
    ].join("\n"),
  );
}

function sameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cachedSummaryForMessage(input: {
  readonly thread: OrchestrationThread;
  readonly message: OrchestrationMessage;
  readonly modelSelection: ModelSelection;
  readonly sourceTextHash: string;
}): HandoffCompressionSummary | undefined {
  const summaries = input.thread.handoff?.compression?.summaries ?? [];
  return summaries.find(
    (summary) =>
      summary.sourceMessageId === input.message.id &&
      summary.sourceTextHash === input.sourceTextHash &&
      sameModelSelection(summary.modelSelection, input.modelSelection),
  );
}

const roleForSummary = (role: OrchestrationMessage["role"]): "user" | "assistant" | "system" =>
  role === "assistant" ? "assistant" : role;

function messageTextBlock(input: {
  readonly message: OrchestrationMessage;
  readonly text: string;
  readonly attachmentMetadata: ReadonlyArray<string>;
}): string {
  const attachmentBlock =
    input.attachmentMetadata.length > 0
      ? [
          "  <attachments>",
          ...input.attachmentMetadata.map(
            (line) => `    <attachment>${escapeXml(line)}</attachment>`,
          ),
          "  </attachments>",
        ].join("\n")
      : "  <attachments />";
  return [
    `<message role="${input.message.role}" source_message_id="${escapeXml(input.message.sourceMessageId ?? input.message.id)}" created_at="${escapeXml(input.message.createdAt)}">`,
    attachmentBlock,
    "  <text>",
    escapeXml(input.text),
    "  </text>",
    "</message>",
  ].join("\n");
}

function latestUserBlock(message: OrchestrationMessage, maxChars: number): string {
  const text =
    message.text.length <= maxChars ? message.text : limitHeadTailSection(message.text, maxChars);
  const attachmentMetadata = attachmentMetadataLines(message.attachments);
  return [
    "<latest_user_message>",
    messageTextBlock({
      message,
      text,
      attachmentMetadata,
    }),
    "</latest_user_message>",
  ].join("\n");
}

function buildContextFromBlocks(input: {
  readonly thread: OrchestrationThread;
  readonly blocks: ReadonlyArray<string>;
  readonly budgetChars: number;
}): { readonly context: string; readonly wasTrimmed: boolean } {
  const handoff = input.thread.handoff;
  const header = [
    "<handoff_context>",
    handoff ? `Source title: ${escapeXml(handoff.sourceTitle)}` : "Source title: unknown",
    handoff
      ? `Source provider instance: ${escapeXml(handoff.sourceProviderInstanceId)}`
      : "Source provider instance: unknown",
    handoff
      ? `Target provider instance: ${escapeXml(handoff.targetProviderInstanceId)}`
      : "Target provider instance: unknown",
    `Branch: ${escapeXml(input.thread.branch ?? "(none)")}`,
    `Worktree: ${escapeXml(input.thread.worktreePath ?? "(none)")}`,
    handoff ? `Imported messages: ${handoff.importedMessageCount}` : "Imported messages: unknown",
    "<imported_messages>",
  ].join("\n");
  const footer = ["</imported_messages>", "</handoff_context>"].join("\n");
  const baseOverhead = header.length + footer.length + 4;
  const selectedBlocks: string[] = [];
  let blockChars = 0;
  for (let index = input.blocks.length - 1; index >= 0; index -= 1) {
    const block = input.blocks[index];
    if (!block) {
      continue;
    }
    const nextChars = blockChars + block.length + 2;
    if (baseOverhead + nextChars > input.budgetChars) {
      break;
    }
    selectedBlocks.unshift(block);
    blockChars = nextChars;
  }

  const wasTrimmed = selectedBlocks.length < input.blocks.length;
  const trimmingNotice = wasTrimmed
    ? "<trimming_notice>Older imported messages were omitted to keep the handoff context bounded.</trimming_notice>\n"
    : "";
  return {
    context: [header, trimmingNotice + selectedBlocks.join("\n\n"), footer].join("\n"),
    wasTrimmed,
  };
}

export function buildHandoffBootstrapContext(
  input: BuildHandoffBootstrapInput,
): Effect.Effect<HandoffBootstrapContextResult, never> {
  return Effect.gen(function* () {
    const handoff = input.thread.handoff;
    const importedMessages = input.thread.messages.filter(
      (message) => message.source === "handoff-import",
    );
    const compressionSummaries: HandoffCompressionSummary[] = [];
    const blocks: string[] = [];

    for (const message of importedMessages) {
      const attachmentMetadata = attachmentMetadataLines(message.attachments);
      let text = message.text;
      if (message.text.length > HANDOFF_MESSAGE_COMPRESSION_THRESHOLD_CHARS) {
        const role = roleForSummary(message.role);
        const sourceTextHash = handoffSourceTextHash({
          role,
          text: message.text,
          attachmentMetadata,
        });
        const cached = cachedSummaryForMessage({
          thread: input.thread,
          message,
          modelSelection: input.modelSelection,
          sourceTextHash,
        });
        let summary = cached;
        if (!summary) {
          summary = yield* input
            .summarizeHandoffMessage({
              cwd: input.cwd,
              sourceThreadTitle: handoff?.sourceTitle ?? input.thread.title,
              role,
              messageText: message.text,
              attachmentMetadata,
              modelSelection: input.modelSelection,
            })
            .pipe(
              Effect.catch(() =>
                input.summarizeHandoffMessage({
                  cwd: input.cwd,
                  sourceThreadTitle: handoff?.sourceTitle ?? input.thread.title,
                  role,
                  messageText: message.text,
                  attachmentMetadata,
                  modelSelection: input.modelSelection,
                }),
              ),
              Effect.map(
                (result): HandoffCompressionSummary => ({
                  sourceMessageId: message.id,
                  modelSelection: input.modelSelection,
                  sourceTextHash,
                  summary: sanitizeHandoffSummary(result.summary),
                  createdAt: input.createdAt,
                }),
              ),
              Effect.orElseSucceed(
                () =>
                  ({
                    sourceMessageId: message.id,
                    modelSelection: input.modelSelection,
                    sourceTextHash,
                    summary: deterministicFallbackSummary(message.text),
                    createdAt: input.createdAt,
                  }) satisfies HandoffCompressionSummary,
              ),
            );
        }
        compressionSummaries.push(summary);
        text = `[compressed imported message]\n\n${summary.summary}`;
      }
      blocks.push(messageTextBlock({ message, text, attachmentMetadata }));
    }

    let latestBlock = latestUserBlock(input.latestUserMessage, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const contextBudget = Math.max(
      0,
      Math.min(
        HANDOFF_BOOTSTRAP_CONTEXT_BUDGET_CHARS,
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS - latestBlock.length - 2,
      ),
    );
    let { context, wasTrimmed } = buildContextFromBlocks({
      thread: input.thread,
      blocks,
      budgetChars: contextBudget,
    });
    let providerInput = `${context}\n\n${latestBlock}`;
    if (providerInput.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      context = "";
      providerInput = latestBlock;
      wasTrimmed = true;
    }
    if (providerInput.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      latestBlock = latestUserBlock(
        input.latestUserMessage,
        Math.max(1_000, PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 2_000),
      );
      providerInput = latestBlock;
      wasTrimmed = true;
    }

    return {
      providerInput,
      compressionSummaries,
      wasTrimmed,
    };
  });
}
