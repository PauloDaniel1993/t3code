import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Omit empty watermarks so ordinary shells pay no wire cost. */
export function taskDeliveryShellFields(fields: object) {
  const latestTaskDeliveredAt =
    "latestTaskDeliveredAt" in fields ? fields.latestTaskDeliveredAt : undefined;
  return typeof latestTaskDeliveredAt === "string" ? { latestTaskDeliveredAt } : {};
}

export function taskDeliveryFromSubagents(subagents: ReadonlyArray<OrchestrationV2Subagent>) {
  let latestTaskDeliveredAt: string | undefined;
  for (const task of subagents) {
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

/** One indexed batch per shell read, independent of thread count or detail/history windows. */
export const withTaskDeliveryWatermarks = (sql: SqlClient.SqlClient) =>
  Effect.fnUntraced(function* <Row extends { readonly thread_id: string }>(
    rows: ReadonlyArray<Row>,
  ) {
    if (rows.length === 0) return rows;
    const deliveries = yield* sql<{ thread_id: string; delivered_at: string | null }>`
      SELECT task.thread_id, MAX(json_extract(task.payload_json, '$.completionDelivery.deliveredAt')) AS delivered_at
      FROM json_each(${encodeThreadIds(rows.map((row) => row.thread_id))}) AS requested
      JOIN orchestration_v2_projection_subagents AS task ON task.thread_id = requested.value
      WHERE task.origin = 'app_owned'
      GROUP BY task.thread_id
    `;
    if (deliveries.length === 0) return rows;
    const byThread = new Map(deliveries.map((row) => [row.thread_id, row.delivered_at]));
    return rows.map((row) => {
      const latestTaskDeliveredAt = byThread.get(row.thread_id);
      return latestTaskDeliveredAt == null ? row : { ...row, latestTaskDeliveredAt };
    });
  });
