// Ticket 36: registered as fork migration 10 in ForkMigrations.ts.
// Startup also calls this preparation on its own branch and verifies schema every time.
import { initializeAttachmentReferenceIndex } from "../../orchestration-v2/AttachmentReferenceIndex.ts";

export default initializeAttachmentReferenceIndex();
