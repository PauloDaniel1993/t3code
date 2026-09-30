import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Omit empty watermarks so ordinary shells pay no wire cost. */
export function taskDeliveryShellFields(fields: object) {
  const latestTaskDeliveredAt =
    "latestTaskDeliveredAt" in fields ? fields.latestTaskDeliveredAt : undefined;
  const legacyImportedAt = "legacyImportedAt" in fields ? fields.legacyImportedAt : undefined;
  return {
    ...(typeof latestTaskDeliveredAt === "string" ? { latestTaskDeliveredAt } : {}),
    ...(typeof legacyImportedAt === "string" ? { legacyImportedAt } : {}),
  };
}

export function taskDeliveryFromSubagents(
  subagents: ReadonlyArray<OrchestrationV2Subagent> | null | undefined,
) {
  let latestTaskDeliveredAt: string | undefined;
  for (const task of subagents ?? []) {
    const delivered =
      task.origin === "app_owned" ? task.completionDelivery?.deliveredAt : undefined;
    if (
      delivered !== undefined &&
      (latestTaskDeliveredAt === undefined || delivered > latestTaskDeliveredAt)
    )
      latestTaskDeliveredAt = delivered;
  }
  return taskDeliveryShellFields({ latestTaskDeliveredAt });
}

/** Read delivery times from compact index keys, outside detail/history windows. */
export const withTaskDeliveryWatermarks = (sql: SqlClient.SqlClient) =>
  Effect.fnUntraced(function* <Row extends { readonly thread_id: string }>(
    rows: ReadonlyArray<Row>,
  ) {
    if (rows.length === 0) return rows;
    // Full lists scan only compact index keys, returning immediately for an
    // empty index. Single-thread live reads stay bounded to that parent's keys.
    // Join import markers after grouping, so each parent pays one primary-key
    // lookup and historical deliveries can be treated as seen by the display.
    const deliveries = yield* rows.length === 1
      ? sql<{ thread_id: string; delivered_at: string | null; shell_imported_at: string | null }>`
      SELECT delivery.*, imported.shell_imported_at
      FROM (
        SELECT task.thread_id, MAX(json_extract(task.payload_json, '$.completionDelivery.deliveredAt')) AS delivered_at
        FROM orchestration_v2_projection_subagents AS task
        WHERE task.origin = 'app_owned' AND task.thread_id = ${rows[0]!.thread_id}
        GROUP BY task.thread_id
      ) AS delivery
      LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = delivery.thread_id
    `
      : sql<{ thread_id: string; delivered_at: string | null; shell_imported_at: string | null }>`
      SELECT delivery.*, imported.shell_imported_at
      FROM (
        SELECT task.thread_id, MAX(json_extract(task.payload_json, '$.completionDelivery.deliveredAt')) AS delivered_at
        FROM orchestration_v2_projection_subagents AS task
        WHERE task.origin = 'app_owned'
        GROUP BY task.thread_id
      ) AS delivery
      LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = delivery.thread_id
    `;
    if (deliveries.length === 0) return rows;
    const byThread = new Map(deliveries.map((row) => [row.thread_id, row]));
    return rows.map((row) => {
      const delivery = byThread.get(row.thread_id);
      return delivery?.delivered_at == null
        ? row
        : {
            ...row,
            ...taskDeliveryShellFields({
              latestTaskDeliveredAt: delivery.delivered_at,
              legacyImportedAt: delivery.shell_imported_at,
            }),
          };
    });
  });
