import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  FlowError,
  FlowId,
  FlowRunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Scheduled from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Managed from "../project/ManagedProjectFolders.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as FlowService from "./FlowService.ts";

it.effect(
  "persists a flow target and dispatches it instead of a bound thread; keeps overlap and input failures",
  () =>
    Effect.gen(function* () {
      const calls: FlowService.FlowStart[] = [];
      let missing = false;
      const layer = Scheduled.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FlowService.FlowService)({
              read: () =>
                missing
                  ? Effect.fail(new FlowError({ message: "Flow not found." }))
                  : Effect.succeed({
                      flowId: FlowId.make("example"),
                      definition: {
                        version: 1,
                        title: "Flow",
                        inputs: [{ name: "count", type: "number", required: true }],
                        steps: [],
                        edges: [],
                      },
                      revision: "test",
                      validation: { valid: true, errors: [] },
                    }),
              start: (input) => {
                calls.push(input);
                if (calls.length > 1)
                  return Effect.fail(
                    new FlowError({ message: "skipped: previous flow run still active" }),
                  );
                return Effect.succeed({
                  id: FlowRunId.make("flow-run"),
                  flowId: input.flowId,
                  flowTitle: "Flow",
                  projectId: input.projectId,
                  flowRunThreadId: ThreadId.make("flow-thread"),
                  runNumber: 1,
                  status: "running",
                  activeStepRunIds: [],
                  error: null,
                  createdAt: "2026-10-31T00:00:00.000Z",
                  startedAt: "2026-10-31T00:00:00.000Z",
                  finishedAt: null,
                });
              },
            }),
            Layer.mock(Launch.ThreadLaunchService)({}),
            Layer.mock(Threads.ThreadManagementService)({}),
            Layer.mock(Managed.ManagedProjectFolders)({
              isScratchProject: () => Effect.succeed(false),
              namedProjectsRoot: "/projects",
            }),
            Layer.mock(Secrets.SecretRequests)({}),
            NodeCrypto.layer,
            Scheduler.layer,
            ManagedPolicy.layerTest(),
          ),
        ),
      );
      const context = yield* Layer.build(layer);
      const tasks = Context.get(context, Scheduled.ScheduledTaskService);
      const target = { flowId: FlowId.make("example"), inputs: { count: "3" }, baseRef: "dev" };
      const { task } = yield* tasks.upsert({
        commandId: CommandId.make("schedule-flow"),
        title: "Flow",
        prompt: "ignored",
        enabled: true,
        projectId: ProjectId.make("p"),
        threadId: ThreadId.make("ignored-thread"),
        flow: target,
        schedule: { type: "interval", everyMs: 60000 },
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "ignored" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      expect(task.flow).toEqual(target);
      expect(task.prompt).toBe("Run flow: Flow");
      expect(task.threadId).toBeNull();
      expect(
        (yield* tasks
          .upsert({ ...task, flow: { ...target, inputs: { count: "not-a-number" } } })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      yield* tasks.runNow({ id: task.id });
      expect(calls[0]).toEqual({
        projectId: task.projectId,
        flowId: target.flowId,
        inputs: target.inputs,
        baseRef: "dev",
        scheduledTaskId: task.id,
        coerce: true,
        creationSource: "server",
      });
      yield* tasks.runNow({ id: task.id });
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        last_run_error: string;
        last_run_status: string;
      }>`SELECT last_run_error, last_run_status FROM scheduled_tasks WHERE task_id = ${task.id}`;
      expect(row?.last_run_status).toBe("failed");
      expect(row?.last_run_error).toContain("previous flow run still active");
      missing = true;
      expect((yield* tasks.upsert({ ...task, title: "Renamed" })).task.title).toBe("Renamed");
      expect((yield* tasks.upsert({ ...task, enabled: false })).task.enabled).toBe(false);
      expect((yield* tasks.upsert({ ...task, enabled: true }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
