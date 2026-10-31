// @effect-diagnostics redundantMapError:off -- Each adapter operation normalizes failures at its I/O boundary.
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type FlowModel,
  type OrchestrationV2CreationSource,
  type FlowRunId,
  type FlowRunSummary,
  type ProjectId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Settings from "../serverSettings.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import { restartContinuationMessageId } from "../orchestration-v2/RestartContinuation.ts";
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
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
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
    readonly belongsToRun: (
      threadId: ThreadId,
      runId: FlowRunId,
    ) => Effect.Effect<boolean, FlowError>;
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
      continuationAttempted?: boolean,
    ) => Effect.Effect<
      {
        readonly interrupted?: boolean;
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
const failure = (cause?: unknown) =>
  new FlowError({ message: "Flow thread operation failed.", cause });
const make = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2;
  const settings = yield* Settings.ServerSettingsService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const sequence = yield* sink.latestSequence().pipe(Effect.mapError(failure));
  const commit = Effect.fn("FlowRuntime.link")(function* (childId: ThreadId, parentId: ThreadId) {
    const parent = (yield* threads.getThreadRecords(parentId, [])).thread;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`flow-link:${childId}`),
      threadId: childId,
      lineage: {
        parentThreadId: parentId,
        relationshipToParent: "subagent",
        rootThreadId: parent.lineage.rootThreadId,
      },
    });
  });
  return FlowRuntime.of({
    belongsToRun: Effect.fn("FlowRuntime.belongsToRun")(function* (threadId, runId) {
      const seen = new Set<ThreadId>();
      let id: ThreadId | null = threadId;
      while (id && !seen.has(id)) {
        seen.add(id);
        const rows =
          yield* sql`SELECT 1 FROM flow_runs WHERE id = ${runId} AND flow_run_thread_id = ${id} UNION ALL SELECT 1 FROM flow_step_runs WHERE flow_run_id = ${runId} AND thread_id = ${id}`.pipe(
            Effect.mapError(failure),
          );
        if (rows.length) return true;
        id = yield* threads.getThreadShell(id).pipe(
          Effect.map((shell) => shell?.lineage.parentThreadId ?? null),
          Effect.mapError(failure),
        );
      }
      return false;
    }),
    root: Effect.fn("FlowRuntime.root")(function* (projectId) {
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(failure));
      if (Option.isNone(project)) return yield* new FlowError({ message: "Project not found." });
      return project.value.workspaceRoot;
    }),
    launch: Effect.fn("FlowRuntime.launch")(function* (input) {
      if (input.parentThreadId) {
        const parent = yield* threads
          .getThreadShell(input.parentThreadId)
          .pipe(Effect.mapError(failure));
        if (!parent || parent.archivedAt || parent.deletedAt)
          return yield* new FlowError({ message: "Flow run thread is archived or deleted." });
      }
      const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(failure));
      if (Option.isNone(project)) return yield* new FlowError({ message: "Project not found." });
      const defaults = resolveProjectSettings(
        yield* settings.getSettings.pipe(Effect.mapError(failure)),
        input.projectId,
      ).settings;
      const fallback = project.value.defaultModelSelection ?? defaults.defaultModelSelection;
      const instances = yield* registry.listInstances;
      const instance = input.model?.providerInstanceId ?? fallback?.instanceId;
      const selected = instances.find((item) => item.instanceId === instance && item.enabled);
      if (!selected) return yield* new FlowError({ message: "No enabled provider instance." });
      const snapshot = yield* selected.snapshot.getSnapshot;
      const model =
        input.model?.model ??
        fallback?.model ??
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
          runtimeMode: input.runtimeMode ?? defaults.defaultRuntimeMode,
          interactionMode: input.interactionMode ?? "default",
          createdBy:
            input.creationSource === "mcp"
              ? "agent"
              : input.creationSource === "server"
                ? "system"
                : "user",
          creationSource: input.creationSource ?? "web",
        })
        .pipe(Effect.mapError(failure));
      if (input.parentThreadId)
        yield* commit(input.threadId, input.parentThreadId).pipe(
          Effect.retry({ times: 2 }),
          Effect.mapError(failure),
        );
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
            createdBy:
              input.creationSource === "mcp"
                ? "agent"
                : input.creationSource === "server"
                  ? "system"
                  : "user",
            creationSource: input.creationSource ?? "web",
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
          createdBy:
            input.creationSource === "mcp"
              ? "agent"
              : input.creationSource === "server"
                ? "system"
                : "user",
          creationSource: input.creationSource ?? "web",
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
      const flowNeedsInput = run.status === "waiting_approval";
      if ((thread.flowNeedsInput ?? false) === flowNeedsInput) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        threadId: thread.id,
        commandId: CommandId.make(
          `flow-attention:${run.id}:${run.status}:${run.finishedAt}:${run.activeStepRunIds.join(":")}`,
        ),
        flowNeedsInput,
      });
    }, Effect.mapError(failure)),
    settled: Effect.fn("FlowRuntime.settled")(function* (
      threadId,
      messageId,
      continuationAttempted = false,
    ) {
      if (!(yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure)))) return null;
      const projection = yield* threads
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.mapError(failure));
      const run = projection.runs.find((run) => run.userMessageId === messageId);
      if (!run && continuationAttempted && messageId.startsWith("message:restart-continuation:"))
        return { messageId, turnId: messageId, text: "", failed: true, interrupted: true };
      if (
        !run ||
        !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)
      )
        return null;
      const continuation = projection.runs.find(
        (candidate) => candidate.restartContinuationOfRunId === run.id,
      );
      if (continuation) return null;
      const pending = yield* outbox.pendingForThread(threadId).pipe(Effect.mapError(failure));
      if (
        !continuationAttempted &&
        pending.some((effect) => effect.request.type === "provider-runtime.continue")
      )
        return null;
      return {
        messageId,
        turnId: run.id,
        text: subagentResultForRun(
          yield* threads
            .getThreadRecords(threadId, ["messages", "turnItems"], {
              messageRunIds: [run.id],
              turnItemRunIds: [run.id],
            })
            .pipe(Effect.mapError(failure)),
          run,
        ).text,
        failed: run.status !== "completed",
        interrupted: run.status === "cancelled" || run.status === "interrupted",
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
      const pending = yield* outbox.pendingForThread(threadId).pipe(Effect.mapError(failure));
      const continuation = pending.find(
        (effect) =>
          effect.request.type === "provider-runtime.continue" &&
          effect.request.sourceRunId === source.id,
      );
      return continuation ? restartContinuationMessageId(source.id) : null;
    }),
    events: sink.stream({ afterSequence: sequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
            stored.event.payload.status,
          ),
      ),
      Stream.map((stored) => stored.event.threadId),
      Stream.mapError(failure),
    ),
  });
});
export const layer = Layer.effect(FlowRuntime, make);
