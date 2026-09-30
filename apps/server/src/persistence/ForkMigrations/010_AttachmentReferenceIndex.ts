// Ticket 36: registered as fork migration 10 in ForkMigrations.ts.
// Startup re-verifies this preparation after the fork migration ledger on every start.
import { initializeAttachmentReferenceIndex } from "../../orchestration-v2/AttachmentReferenceIndex.ts";

export default initializeAttachmentReferenceIndex();
