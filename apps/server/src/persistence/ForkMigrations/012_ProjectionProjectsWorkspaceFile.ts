import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A project linked to a VS Code workspace file stores the file's path and its
 * folders as last read. NULL in both means a plain project, so existing rows
 * need no backfill. Linked projects are unique by file among active rows; the
 * index serves that lookup, and the project's commands guard uniqueness.
 *
 * Additive and idempotent per the fork migration rules in `ForkMigrations.ts`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "workspace_file")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_file TEXT
    `;
  }
  if (!columns.some((column) => column.name === "workspace_folders_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_folders_json TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_active_workspace_file
    ON projection_projects(workspace_file)
    WHERE deleted_at IS NULL AND workspace_file IS NOT NULL
  `;
});
