// Register as [10, "AttachmentReferenceIndex", migration] when joining ticket 28's ledger.
// Startup also calls this preparation on its own branch and verifies schema every time.
import { initializeAttachmentReferenceIndex } from "../../orchestration-v2/AttachmentReferenceIndex.ts";

export default initializeAttachmentReferenceIndex();
