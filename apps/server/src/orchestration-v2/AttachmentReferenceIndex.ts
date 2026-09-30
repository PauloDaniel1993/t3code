// Ticket 36: legacy attachment reads stay at the import boundary until hydration completes.
export {
  ATTACHMENT_REFERENCE_TABLE,
  ATTACHMENT_REFERENCE_VERSION,
  ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE,
  ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS,
  readAttachmentReferenceIndexState,
  AttachmentReferenceIndexUnavailable,
  requireCompleteAttachmentReferenceIndex,
  isCompleteAttachmentReferenceIndex,
  attachmentSourceRows,
  initializeAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndexPass,
  rebuildAttachmentReferenceIndex,
  deferAttachmentCleanup,
  awaitAttachmentReferenceIndex,
  startAttachmentReferenceIndex,
} from "./legacy/ForkAttachmentReferenceIndex.ts";
