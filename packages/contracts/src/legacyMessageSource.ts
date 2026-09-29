import * as Schema from "effect/Schema";

/** Exact V1 fork provenance; task-result messages were sent with the user role. */
export const LegacyMessageSource = Schema.Literals(["user", "provider", "system", "task-result"]);
