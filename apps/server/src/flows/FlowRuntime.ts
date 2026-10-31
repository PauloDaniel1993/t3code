// @effect-diagnostics redundantMapError:off -- Each adapter operation normalizes failures at its I/O boundary.
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  type FlowModel,
  type FlowRunSummary,
  type ProjectId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import { FlowError } from "@t3tools/contracts";

export interface FlowThreadInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly title: string;
  readonly workspace: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  readonly parentThreadId?: ThreadId;
  readonly messageId?: string;
  readonly prompt?: string;
  readonly model?: FlowModel | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}
export class FlowRuntime extends Context.Service<
  FlowRuntime,
  {
    readonly root: (projectId: ProjectId) => Effect.Effect<string, FlowError>;
    readonly launch: (input: FlowThreadInput) => Effect.Effect<string, FlowError>;
    readonly send: (
      input: FlowThreadInput & { readonly prompt: string; readonly messageId: string },
    ) => Effect.Effect<void, FlowError>;
    readonly interrupt: (
      projectId: ProjectId,
      threadId: ThreadId,
      key: string,
    ) => Effect.Effect<void, FlowError>;
    readonly attention: (run: FlowRunSummary) => Effect.Effect<void, FlowError>;
    readonly settled: (
      threadId: ThreadId,
      messageId: string,
    ) => Effect.Effect<
      {
        readonly messageId: string;
        readonly turnId: string;
        readonly text: string;
        readonly failed: boolean;
      } | null,
      FlowError
    >;
    readonly continuing: (
      threadId: ThreadId,
      messageId: string,
    ) => Effect.Effect<string | null, FlowError>;
    readonly events: Stream.Stream<ThreadId, FlowError>;
  }
>()("t3/flows/FlowRuntime") {}
const decodeContinuation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ sourceRunId: Schema.String })),
);
const failure = () => new FlowError({ message: "Flow thread operation failed." });
const make = Effect.gen(function* () {
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const sequence = yield* sink.latestSequence().pipe(Effect.mapError(failure));
  const commit = Effect.fn("FlowRuntime.link")(function* (childId: ThreadId, parentId: ThreadId) {
    const child = (yield* threads.getThreadRecords(childId, [])).thread;
    const parent = (yield* threads.getThreadRecords(parentId, [])).thread;
    const now = yield* DateTime.now;
    yield* sink.commitCommand({
      commandId: CommandId.make(`flow-link:${childId}`),
      threadId: childId,
      commandType: "flow.link",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make(`flow-link:${childId}`),
          type: "thread.metadata-updated",
          threadId: childId,
          providerInstanceId: child.providerInstanceId,
          occurredAt: now,
          payload: {
            ...child,
            lineage: {
              parentThreadId: parentId,
              relationshipToParent: "subagent",
              rootThreadId: parent.lineage.rootThreadId,
            },
          },
        },
      ],
    });
  });
  return FlowRuntime.of({
    root: Effect.fn("FlowRuntime.root")(function* (projectId) {
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(failure));
      if (Option.isNone(project)) return yield* new FlowError({ message: "Project not found." });
      return project.value.workspaceRoot;
    }),
    launch: Effect.fn("FlowRuntime.launch")(function* (input) {
      const instances = yield* registry.listInstances;
      const instance =
        input.model?.providerInstanceId ?? instances.find((item) => item.enabled)?.instanceId;
      const selected = instances.find((item) => item.instanceId === instance && item.enabled);
      if (!selected) return yield* new FlowError({ message: "No enabled provider instance." });
      const snapshot = yield* selected.snapshot.getSnapshot;
      const model =
        input.model?.model ??
        snapshot.models.find((model) => model.isDefault)?.slug ??
        snapshot.models[0]?.slug;
      if (!model) return yield* new FlowError({ message: "No model available for the flow." });
      const result = yield* launch
        .launch({
          commandId: CommandId.make(input.commandId),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          awaitPreparation: true,
          skipSetupScript: input.parentThreadId !== undefined,
          workspaceStrategy: input.workspace,
          modelSelection: {
            instanceId: selected.instanceId,
            model: model,
            ...(input.model?.options
              ? {
                  options: Object.entries(input.model.options).map(([id, value]) => ({
                    id,
                    value,
                  })),
                }
              : {}),
          },
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          createdBy: "user",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
      if (input.parentThreadId)
        yield* commit(input.threadId, input.parentThreadId).pipe(Effect.mapError(failure));
      if (input.prompt !== undefined && input.messageId !== undefined) {
        yield* threads
          .sendToThread({
            projectId: input.projectId,
            threadId: input.threadId,
            commandId: CommandId.make(`${input.commandId}:message`),
            messageId: MessageId.make(input.messageId),
            text: input.prompt,
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(failure));
      }
      return (
        result.projection.thread.worktreePath ??
        result.projection.thread.workspaceFolders?.[0]?.path ??
        (yield* projects.getById(input.projectId).pipe(
          Effect.mapError(failure),
          Effect.flatMap((p) =>
            Option.isSome(p) ? Effect.succeed(p.value.workspaceRoot) : Effect.fail(failure()),
          ),
        ))
      );
    }),
    send: Effect.fn("FlowRuntime.send")(function* (input) {
      if (input.runtimeMode)
        yield* threads.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${input.commandId}:runtime-mode`),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
        });
      if (input.interactionMode)
        yield* threads.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`${input.commandId}:interaction-mode`),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
        });
      yield* threads
        .sendToThread({
          projectId: input.projectId,
          threadId: input.threadId,
          commandId: CommandId.make(input.commandId),
          messageId: MessageId.make(input.messageId),
          text: input.prompt,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "mcp",
          ...(input.model
            ? {
                modelSelection: {
                  instanceId: ProviderInstanceId.make(input.model.providerInstanceId),
                  model: input.model.model,
                  ...(input.model.options
                    ? {
                        options: Object.entries(input.model.options).map(([id, value]) => ({
                          id,
                          value,
                        })),
                      }
                    : {}),
                },
              }
            : {}),
        })
        .pipe(Effect.asVoid);
    }, Effect.mapError(failure)),
    interrupt: Effect.fn("FlowRuntime.interrupt")((projectId, threadId, key) =>
      threads
        .interruptThread({
          projectId,
          threadId,
          commandId: CommandId.make(key),
          reason: "Flow stopped.",
        })
        .pipe(Effect.asVoid, Effect.mapError(failure)),
    ),
    attention: Effect.fn("FlowRuntime.attention")(function* (run) {
      const thread = (yield* threads.getThreadRecords(run.flowRunThreadId, [])).thread;
      const at = yield* DateTime.now;
      yield* sink.commitCommand({
        commandId: CommandId.make(
          `flow-attention:${run.id}:${run.status}:${run.activeStepRunIds.join(":")}`,
        ),
        threadId: thread.id,
        commandType: "flow.attention",
        acceptedAt: at,
        effects: [],
        events: [
          {
            id: EventId.make(
              `flow-attention:${run.id}:${run.status}:${DateTime.toEpochMillis(at)}`,
            ),
            type: "thread.metadata-updated",
            threadId: thread.id,
            occurredAt: at,
            providerInstanceId: thread.providerInstanceId,
            payload: {
              ...thread,
              flowNeedsInput: run.status === "waiting_approval",
              updatedAt: at,
            },
          },
        ],
      });
      if (["succeeded", "failed", "cancelled"].includes(run.status))
        yield* threads.dispatch({
          type: "thread.mark-unread",
          threadId: thread.id,
          commandId: CommandId.make(`flow-unread:${run.id}:${run.status}:${run.finishedAt}`),
        });
    }, Effect.mapError(failure)),
    settled: Effect.fn("FlowRuntime.settled")(function* (threadId, messageId) {
      if (!(yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure)))) return null;
      const projection = yield* threads
        .getThreadRecords(threadId, ["runs", "messages", "turnItems"])
        .pipe(Effect.mapError(failure));
      const run = projection.runs.find((run) => run.userMessageId === messageId);
      if (
        !run ||
        !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)
      )
        return null;
      const continuation = projection.runs.find(
        (candidate) => candidate.restartContinuationOfRunId === run.id,
      );
      if (continuation) return null;
      const pending =
        yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} AND effect_type = 'provider-runtime.continue' AND status IN ('pending', 'running')`.pipe(
          Effect.mapError(failure),
        );
      if (pending.length) return null;
      return {
        messageId,
        turnId: run.id,
        text: subagentResultForRun(projection, run).text,
        failed: run.status !== "completed",
      };
    }),
    continuing: Effect.fn("FlowRuntime.continuing")(function* (threadId, messageId) {
      if (!(yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure)))) return null;
      const projection = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError(failure));
      const source = projection.runs.find((run) => run.userMessageId === messageId);
      if (!source) return null;
      let latest = source;
      for (let remaining = projection.runs.length; remaining > 0; remaining--) {
        const continuation = projection.runs.find(
          (run) => run.restartContinuationOfRunId === latest.id,
        );
        if (!continuation) break;
        latest = continuation;
      }
      if (latest !== source) return latest.userMessageId;
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} AND effect_type = 'provider-runtime.continue' AND status IN ('pending', 'running') ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.mapError(failure),
      );
      if (!rows[0]) return null;
      const request = yield* decodeContinuation(rows[0].payload_json).pipe(
        Effect.mapError(failure),
      );
      return request.sourceRunId === source.id
        ? `message:restart-continuation:${request.sourceRunId}`
        : null;
    }),
    events: sink.stream({ afterSequence: sequence }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" || stored.event.type === "run.created",
      ),
      Stream.map((stored) => stored.event.threadId),
      Stream.mapError(failure),
    ),
  });
});
export const layer = Layer.effect(FlowRuntime, make);
