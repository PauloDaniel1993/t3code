// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type ChatAttachment,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  attachmentRelativePath,
  createAttachmentId,
  parseAttachmentIdFromRelativePath,
} from "./attachmentStore.ts";
import type { ValidatedAttachment } from "./attachmentValidation.ts";
import { ServerConfig } from "./config.ts";

export const ATTACHMENT_STAGING_DIRECTORY_NAME = ".staging";
const ATTACHMENT_STAGE_MANIFEST_FILE_NAME = "manifest.json";
const ATTACHMENT_STAGE_SWEEP_LIMIT = 100;
const ATTACHMENT_STAGE_MANIFEST_MAX_BYTES = 64 * 1024;
const ATTACHMENT_STAGE_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AttachmentStageManifest = Schema.Struct({
  version: Schema.Literal(1),
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  finalRelativePaths: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
});
type AttachmentStageManifest = typeof AttachmentStageManifest.Type;
const AttachmentStageManifestJson = Schema.fromJsonString(AttachmentStageManifest);
const encodeAttachmentStageManifest = Schema.encodeSync(AttachmentStageManifestJson);
const decodeAttachmentStageManifest = Schema.decodeUnknownOption(AttachmentStageManifestJson);

export interface AttachmentStage {
  readonly claim: Effect.Effect<void, OrchestrationDispatchCommandError>;
  readonly commit: Effect.Effect<void, OrchestrationDispatchCommandError>;
  readonly complete: Effect.Effect<void, never>;
  readonly abort: Effect.Effect<void, never>;
  readonly abortIfUnclaimed: Effect.Effect<void, never>;
}

export interface StagedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly stage: AttachmentStage;
}

type StageState = "unclaimed" | "claimed" | "committing" | "committed" | "completed" | "aborted";

interface StagedEntry {
  readonly name: string;
  readonly stagedPath: string;
  readonly finalPath: string;
  readonly finalRelativePath: string;
  readonly bytes: Uint8Array;
}

function stageError(message: string, cause?: unknown) {
  return new OrchestrationDispatchCommandError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toPersistedAttachment(attachment: ValidatedAttachment, id: string): ChatAttachment {
  switch (attachment.type) {
    case "image":
      return {
        type: "image",
        id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    case "document":
      return {
        type: "document",
        id,
        name: attachment.name,
        mimeType: "application/pdf",
        sizeBytes: attachment.sizeBytes,
      };
    case "file":
      return {
        type: "file",
        id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
  }
}

function validateStageManifest(candidate: AttachmentStageManifest): AttachmentStageManifest | null {
  for (const relativePath of candidate.finalRelativePaths) {
    if (
      relativePath.length === 0 ||
      relativePath.includes("/") ||
      relativePath.includes("\\") ||
      !parseAttachmentIdFromRelativePath(relativePath)
    ) {
      return null;
    }
  }
  return candidate;
}

export const stageValidatedAttachments = Effect.fn("stageValidatedAttachments")(function* (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ValidatedAttachment>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const persistedAttachments: ChatAttachment[] = [];
  for (const attachment of input.attachments) {
    const id = createAttachmentId(input.threadId);
    if (!id) {
      return yield* stageError(
        `Failed to create a safe attachment identifier for '${attachment.name}'.`,
      );
    }
    persistedAttachments.push(toPersistedAttachment(attachment, id));
  }

  const stagingRoot = resolveAttachmentRelativePath({
    attachmentsDir: serverConfig.attachmentsDir,
    relativePath: ATTACHMENT_STAGING_DIRECTORY_NAME,
  });
  if (!stagingRoot) {
    return yield* stageError("Failed to resolve the attachment staging directory.");
  }

  const stageDirectoryName = NodeCrypto.randomUUID();
  const stageDirectory = resolveAttachmentRelativePath({
    attachmentsDir: serverConfig.attachmentsDir,
    relativePath: `${ATTACHMENT_STAGING_DIRECTORY_NAME}/${stageDirectoryName}`,
  });
  if (!stageDirectory) {
    return yield* stageError("Failed to resolve a contained command attachment staging path.");
  }

  const entries: StagedEntry[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const persistedAttachment = persistedAttachments[index];
    if (!persistedAttachment) {
      return yield* stageError(`Failed to prepare attachment '${attachment.name}' for staging.`);
    }

    const finalRelativePath = yield* Effect.try({
      try: () => attachmentRelativePath(persistedAttachment),
      catch: (cause) =>
        stageError(
          `Failed to resolve a safe persisted path for attachment '${attachment.name}'.`,
          cause,
        ),
    });
    const finalPath = resolveAttachmentRelativePath({
      attachmentsDir: serverConfig.attachmentsDir,
      relativePath: finalRelativePath,
    });
    const stagedPath = resolveAttachmentRelativePath({
      attachmentsDir: serverConfig.attachmentsDir,
      relativePath: `${ATTACHMENT_STAGING_DIRECTORY_NAME}/${stageDirectoryName}/${finalRelativePath}`,
    });
    if (!finalPath || !stagedPath) {
      return yield* stageError(
        `Failed to resolve a contained persisted path for attachment '${attachment.name}'.`,
      );
    }
    entries.push({
      name: attachment.name,
      stagedPath,
      finalPath,
      finalRelativePath,
      bytes: attachment.bytes,
    });
  }

  const manifestPath = path.join(stageDirectory, ATTACHMENT_STAGE_MANIFEST_FILE_NAME);
  const manifest: AttachmentStageManifest = {
    version: 1,
    commandId: input.commandId,
    finalRelativePaths: entries.map((entry) => entry.finalRelativePath),
  };
  let state: StageState = "unclaimed";
  const finalizedPaths = new Set<string>();

  const removeStageRootIfEmpty = Effect.fn("removeAttachmentStageRootIfEmpty")(function* () {
    const remaining = yield* fileSystem
      .readDirectory(stagingRoot, { recursive: false })
      .pipe(Effect.orElseSucceed(() => ["unknown"]));
    if (remaining.length === 0) {
      yield* fileSystem.remove(stagingRoot, { force: true }).pipe(Effect.catch(() => Effect.void));
    }
  });

  const removeStageDirectory = Effect.fn("removeAttachmentStageDirectory")(function* () {
    const removed = yield* fileSystem.remove(stageDirectory, { recursive: true, force: true }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("failed to remove command attachment staging directory", {
          commandId: input.commandId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (removed) {
      yield* removeStageRootIfEmpty();
    }
    return removed;
  });

  const cleanupFinalizedPaths = Effect.fn("cleanupFinalizedAttachmentPaths")(function* () {
    let allRemoved = true;
    for (const finalPath of finalizedPaths) {
      const removed = yield* fileSystem.remove(finalPath, { force: true }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("failed to remove finalized attachment during command rollback", {
            commandId: input.commandId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      allRemoved = allRemoved && removed;
    }
    return allRemoved;
  });

  const abort = Effect.gen(function* () {
    const shouldAbort = yield* Effect.sync(() => {
      if (state === "completed") return false;
      state = "aborted";
      return true;
    });
    if (!shouldAbort) return;

    const finalsRemoved = yield* cleanupFinalizedPaths();
    if (finalsRemoved) {
      yield* removeStageDirectory();
    } else {
      yield* Effect.logWarning("retaining attachment stage manifest for startup cleanup retry", {
        commandId: input.commandId,
      });
    }
  }).pipe(Effect.withSpan("AttachmentStage.abort"));

  const abortIfUnclaimed = Effect.gen(function* () {
    const shouldAbort = yield* Effect.sync(() => {
      if (state !== "unclaimed") return false;
      state = "aborted";
      return true;
    });
    if (shouldAbort) {
      yield* removeStageDirectory();
    }
  }).pipe(Effect.withSpan("AttachmentStage.abortIfUnclaimed"));

  const claim = Effect.sync(() => {
    if (state !== "unclaimed") return false;
    state = "claimed";
    return true;
  }).pipe(
    Effect.flatMap((claimed) =>
      claimed
        ? Effect.void
        : Effect.fail(
            stageError(`Attachment stage for command '${input.commandId}' is no longer claimable.`),
          ),
    ),
  );

  const commit = Effect.gen(function* () {
    const canCommit = yield* Effect.sync(() => {
      if (state !== "claimed") return false;
      state = "committing";
      return true;
    });
    if (!canCommit) {
      return yield* stageError(
        `Attachment stage for command '${input.commandId}' is not ready to commit.`,
      );
    }

    for (const entry of entries) {
      const exists = yield* fileSystem
        .exists(entry.finalPath)
        .pipe(
          Effect.mapError((cause) =>
            stageError(`Failed to inspect final attachment path for '${entry.name}'.`, cause),
          ),
        );
      if (exists) {
        return yield* stageError(
          `Refusing to overwrite an existing persisted attachment for '${entry.name}'.`,
        );
      }
    }

    for (const entry of entries) {
      // Register the candidate before the interruptible rename so rollback also
      // covers interruption immediately after the filesystem operation succeeds.
      finalizedPaths.add(entry.finalPath);
      yield* fileSystem
        .rename(entry.stagedPath, entry.finalPath)
        .pipe(
          Effect.mapError((cause) =>
            stageError(`Failed to commit attachment '${entry.name}' to durable storage.`, cause),
          ),
        );
    }
    yield* Effect.sync(() => {
      state = "committed";
    });
  }).pipe(Effect.withSpan("AttachmentStage.commit"));

  const complete = Effect.gen(function* () {
    const isCommitted = yield* Effect.sync(() => state === "committed");
    if (!isCommitted) return;
    const removed = yield* removeStageDirectory();
    if (removed) {
      yield* Effect.sync(() => {
        state = "completed";
      });
    }
  }).pipe(Effect.withSpan("AttachmentStage.complete"));

  const writeStage = Effect.gen(function* () {
    yield* fileSystem
      .makeDirectory(stageDirectory, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          stageError("Failed to create the command attachment staging directory.", cause),
        ),
      );
    for (const entry of entries) {
      yield* fileSystem
        .writeFile(entry.stagedPath, entry.bytes, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.mapError((cause) =>
            stageError(`Failed to stage attachment '${entry.name}'.`, cause),
          ),
        );
    }
    yield* fileSystem
      .writeFileString(manifestPath, encodeAttachmentStageManifest(manifest), {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError((cause) =>
          stageError("Failed to persist command attachment staging metadata.", cause),
        ),
      );
  }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? abort : Effect.void)));

  yield* writeStage;

  return {
    attachments: persistedAttachments,
    stage: {
      claim,
      commit,
      complete,
      abort,
      abortIfUnclaimed,
    },
  } satisfies StagedAttachments;
});

export const sweepAttachmentStaging = Effect.fn("sweepAttachmentStaging")(function* (input: {
  readonly attachmentsDir: string;
  readonly getReceiptStatus: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<"accepted" | "rejected">, OrchestrationDispatchCommandError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stagingRoot = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: ATTACHMENT_STAGING_DIRECTORY_NAME,
  });
  if (!stagingRoot) {
    yield* Effect.logWarning("attachment staging startup sweep skipped an unsafe staging root");
    return;
  }

  const rootExists = yield* fileSystem.exists(stagingRoot).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("attachment staging startup sweep could not inspect the staging root", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  if (!rootExists) return;

  const allEntries = yield* fileSystem.readDirectory(stagingRoot, { recursive: false }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("attachment staging startup sweep could not read the staging root", {
        cause,
      }).pipe(Effect.as([] as string[])),
    ),
  );
  const entries = allEntries.toSorted().slice(0, ATTACHMENT_STAGE_SWEEP_LIMIT);
  let removedStages = 0;
  let preservedAcceptedStages = 0;
  let deferredStages = 0;

  for (const entry of entries) {
    const stageDirectory = path.join(stagingRoot, entry);
    const removeStageDirectory = fileSystem
      .remove(stageDirectory, { recursive: true, force: true })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("attachment staging startup sweep failed to remove a stage", {
            stage: entry,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    if (!ATTACHMENT_STAGE_DIRECTORY_PATTERN.test(entry)) {
      if (yield* removeStageDirectory) removedStages += 1;
      else deferredStages += 1;
      continue;
    }

    const manifestPath = path.join(stageDirectory, ATTACHMENT_STAGE_MANIFEST_FILE_NAME);
    const manifestInfo = yield* fileSystem
      .stat(manifestPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      !manifestInfo ||
      manifestInfo.type !== "File" ||
      manifestInfo.size > ATTACHMENT_STAGE_MANIFEST_MAX_BYTES
    ) {
      yield* Effect.logWarning(
        "attachment staging startup sweep removed a stage without a valid manifest",
        {
          stage: entry,
        },
      );
      if (yield* removeStageDirectory) removedStages += 1;
      else deferredStages += 1;
      continue;
    }

    const manifestText = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const decodedManifest = decodeAttachmentStageManifest(manifestText);
    const manifest = Option.isSome(decodedManifest)
      ? validateStageManifest(decodedManifest.value)
      : null;
    if (!manifest) {
      yield* Effect.logWarning("attachment staging startup sweep removed a malformed manifest", {
        stage: entry,
      });
      if (yield* removeStageDirectory) removedStages += 1;
      else deferredStages += 1;
      continue;
    }

    const receiptExit = yield* Effect.exit(
      input.getReceiptStatus(CommandId.make(manifest.commandId)),
    );
    if (Exit.isFailure(receiptExit)) {
      deferredStages += 1;
      yield* Effect.logWarning(
        "attachment staging startup sweep deferred a stage after receipt lookup failed",
        {
          commandId: manifest.commandId,
          cause: receiptExit.cause,
        },
      );
      continue;
    }

    if (Option.isSome(receiptExit.value) && receiptExit.value.value === "accepted") {
      if (yield* removeStageDirectory) {
        removedStages += 1;
        preservedAcceptedStages += 1;
      } else {
        deferredStages += 1;
      }
      continue;
    }

    let finalsRemoved = true;
    for (const finalRelativePath of manifest.finalRelativePaths) {
      const finalPath = resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: finalRelativePath,
      });
      if (!finalPath) {
        finalsRemoved = false;
        continue;
      }
      const removed = yield* fileSystem.remove(finalPath, { force: true }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning(
            "attachment staging startup sweep failed to remove an orphan final file",
            {
              commandId: manifest.commandId,
              cause,
            },
          ).pipe(Effect.as(false)),
        ),
      );
      finalsRemoved = finalsRemoved && removed;
    }

    if (finalsRemoved && (yield* removeStageDirectory)) {
      removedStages += 1;
    } else {
      deferredStages += 1;
    }
  }

  yield* Effect.logInfo("attachment staging startup sweep complete", {
    examinedStages: entries.length,
    removedStages,
    preservedAcceptedStages,
    deferredStages,
    remainingUnexaminedStages: Math.max(0, allEntries.length - entries.length),
  });
  if (allEntries.length > entries.length) {
    yield* Effect.logWarning("attachment staging startup sweep reached its bounded stage limit", {
      limit: ATTACHMENT_STAGE_SWEEP_LIMIT,
      remainingStages: allEntries.length - entries.length,
    });
  }
});
