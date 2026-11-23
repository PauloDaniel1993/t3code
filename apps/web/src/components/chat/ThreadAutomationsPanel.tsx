import { ScheduledFlowSummary } from "../flows/ScheduledFlowSummary";
import { flowEnvironment } from "../../state/flows";
import { useThreadShell } from "../../state/entities";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { T, useGT, useMessages, Var } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import { CalendarClockIcon, PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  ScheduledRelativeLabel,
  ScheduledTaskEditorDialog,
} from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { readEnvironmentScope } from "../../state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

function taskScheduleLine(
  task: ScheduledTask,
  timestampFormat: TimestampFormat,
  timeZone: string | undefined,
  resolve: MessageResolver,
) {
  return (
    <>
      {scheduleLabel(task.schedule, timestampFormat, timeZone, task.nextRunAt, resolve)}
      {task.blockedByPolicy !== undefined ? (
        ` · ${task.blockedByPolicy}`
      ) : task.enabled && task.nextRunAt !== null ? (
        <>
          {" · "}
          <T>
            next <ScheduledRelativeLabel value={task.nextRunAt} />
          </T>
        </>
      ) : task.enabled ? (
        ""
      ) : (
        <>
          {" · "}
          <T context="automation state">paused</T>
        </>
      )}
    </>
  );
}

export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [editor, setEditor] = useState<{ task: ScheduledTask | null } | null>(null);
  const thread = useThreadShell(props);
  const lookup = useEnvironmentQuery(
    flowEnvironment.runForThread({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const flowRun = useEnvironmentQuery(
    lookup.data
      ? flowEnvironment.run({
          environmentId: props.environmentId,
          input: { flowRunId: lookup.data.flowRunId },
        })
      : null,
  );
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
    useMessages(),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) =>
      task.threadId === props.threadId ||
      (task.flow &&
        task.projectId === thread?.projectId &&
        task.flow.flowId === flowRun.data?.summary.flowId),
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not update automation"), squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not run automation"), squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title={gt("Automations")}
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={gt("New scheduled task")}
                disabled={!canCreate}
                onClick={() => setEditor({ task: null })}
              >
                <PlusIcon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>
            <T>New scheduled task</T>
          </TooltipPopup>
        </Tooltip>
      }
    >
      {editor && (
        <SettingsScopeProvider search={{ machine: props.environmentId }} onChange={() => {}}>
          <ScheduledTaskEditorDialog
            initialEnvironmentId={props.environmentId}
            task={editor.task}
            initialProjectId={thread?.projectId}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      )}
      <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
        {boundTasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              "group flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span
                className={cn(
                  "absolute -right-1 -top-1 size-1.5 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
                aria-hidden
              />
            </span>
            <Tooltip>
              <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                <span className="block truncate text-sm font-medium text-foreground/80">
                  {task.title}
                </span>
                <p className="truncate text-2xs text-muted-foreground">
                  {taskScheduleLine(task, timestampFormat, tasksQuery.data?.timeZone, m)}
                </p>
                {task.flow && (
                  <ScheduledFlowSummary environmentId={props.environmentId} task={task} />
                )}
              </TooltipTrigger>
              <TooltipPopup side="left">
                <p className="font-medium">{task.title}</p>
                <p className="text-muted-foreground">
                  {taskScheduleLine(task, timestampFormat, tasksQuery.data?.timeZone, m)}
                </p>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={gt("Edit {title}", { title: task.title })}
                    onClick={() => setEditor({ task })}
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>
                <T>Edit automation</T>
              </TooltipPopup>
            </Tooltip>
            {/* Webhook tasks need a request from their URL. */}
            {task.schedule.type === "webhook" ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={gt("Run {title} now", { title: task.title })}
                      disabled={
                        !canOperate || busyTaskId !== null || task.lastRunStatus === "running"
                      }
                      onClick={() => void runNow(task)}
                    >
                      <PlayIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>
                  <T>Run now</T>
                </TooltipPopup>
              </Tooltip>
            )}
            <Switch
              checked={task.enabled}
              disabled={!canOperate || busyTaskId !== null}
              aria-label={
                task.enabled
                  ? gt("Pause {title}", { title: task.title })
                  : gt("Resume {title}", { title: task.title })
              }
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
      </ul>
      {boundTasks.length === 0 && tasksQuery.error === null && (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
          <T>No automations for this thread.</T>
        </p>
      )}
      {/* Kept last: the details card treats a section whose last child is empty as empty. */}
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          <T>
            Could not load automations: <Var>{tasksQuery.error}</Var>
          </T>
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
