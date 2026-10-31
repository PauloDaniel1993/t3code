import { FlowKindIcon } from "./FlowStepStatus";
import { Plus, MoreHorizontal, TriangleAlert, X, Trash2 } from "lucide-react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectGroup,
  SelectItem,
} from "../ui/select";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  FlowId,
  type EnvironmentId,
  type FlowDefinition,
  type ProjectId,
  type ScopedThreadRef,
  type FlowRunId,
  type FlowEdge,
  type FlowRunsPage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  createFlowDraft,
  latestStepRunById,
  applyFlowRunsEvent,
} from "@t3tools/client-runtime/flows";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Checkbox } from "../ui/checkbox";
import { reportFlowFailure } from "./flowErrors";
import { coerceFlowInputs, validateFlowDefinition } from "@t3tools/shared/flow";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { serverEnvironment } from "../../state/server";
import { flowEnvironment } from "../../state/flows";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Choice,
  TextField,
  InputFieldsForm,
  ModelFields,
  AgentModes,
  StepForm,
  ConditionForm,
} from "./FlowFields";
import { FlowModelContext } from "./FlowModelPicker";
import { FlowCanvas } from "./FlowCanvas";
import { editLevel, findStep, removeStep, renameStep, updateStep, stepIdAtPath } from "./flowGraph";
import { FlowRunActions, FlowRunTimeline, StepRunInspector } from "./FlowRunView";
import { flowDrafts, useFlowPanelRequest } from "./flowPanelState";
const isFlowId = Schema.is(FlowId);
export default function FlowPanel(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef: ScopedThreadRef;
}) {
  return (
    <FlowModelContext value={{ environmentId: props.environmentId, projectId: props.projectId }}>
      <ProjectFlows key={`${props.environmentId}:${props.projectId}`} {...props} />
    </FlowModelContext>
  );
}
function ProjectFlows({ environmentId, projectId, threadRef }: Parameters<typeof FlowPanel>[0]) {
  const list = useEnvironmentQuery(flowEnvironment.list({ environmentId, input: { projectId } }));
  const request = useFlowPanelRequest((state) => state.requests[scopedThreadKey(threadRef)]);
  const [selected, setSelected] = useState<FlowId | null>(request?.flowId ?? null);
  const [newId, setNewId] = useState<string | null>(null);
  const save = useAtomCommand(flowEnvironment.save);
  const canSave = useAtomValue(flowEnvironment.save.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [requestedRunId, setRequestedRunId] = useState<FlowRunId | null>(
    request?.flowRunId ?? null,
  );
  const [previousRequest, setPreviousRequest] = useState<typeof request>(undefined);
  if (request !== previousRequest) {
    setPreviousRequest(request);
    if (request?.flowId) setSelected(request.flowId);
    if (request) setRequestedRunId(request.flowRunId ?? null);
  }
  const requestedRun = useEnvironmentQuery(
    requestedRunId
      ? flowEnvironment.run({ environmentId, input: { flowRunId: requestedRunId } })
      : null,
  );
  const currentEntry = list.data?.flows.find((entry) => entry.flowId === selected);
  const entry =
    requestedRunId &&
    requestedRun.data &&
    selected === requestedRun.data.summary.flowId &&
    !currentEntry?.definition
      ? {
          flowId: requestedRun.data.summary.flowId,
          definition: requestedRun.data.definition,
          revision: "",
          validation: { valid: true, errors: [] },
        }
      : (currentEntry ?? (request?.flowId ? undefined : list.data?.flows[0]));
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="flex h-10 min-h-10 items-center gap-2 border-b border-border/60 px-2">
        {entry && (
          <div className="min-w-0 flex-1">
            <Select
              value={entry.flowId}
              onValueChange={(id) => {
                if (!id) return;
                setRequestedRunId(null);
                setSelected(FlowId.make(id));
              }}
            >
              <SelectTrigger variant="ghost" size="xs" aria-label="Flow" className="max-w-full">
                <SelectValue>{entry.definition?.title ?? entry.flowId}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectGroup>
                  {(list.data?.flows ?? []).map((flow) => (
                    <SelectItem key={flow.flowId} value={flow.flowId}>
                      {flow.definition?.title ?? flow.flowId}
                      {!flow.validation.valid && (
                        <Badge variant="error" size="sm">
                          Invalid
                        </Badge>
                      )}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </div>
        )}
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="New flow"
                  disabled={!canSave}
                  onClick={() => setNewId("")}
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipPopup>New flow</TooltipPopup>
          </Tooltip>
        </div>
      </header>
      {list.error && (
        <p role="alert" className="p-2">
          {list.error}
        </p>
      )}
      {newId !== null && (
        <div className="flex flex-col gap-2 p-3">
          <TextField label="New flow id" value={newId} onChange={setNewId} />
          <Button
            size="xs"
            disabled={
              !canSave ||
              busy ||
              !isFlowId(newId) ||
              !!list.data?.flows.some((flow) => flow.flowId === newId)
            }
            onClick={async () => {
              setBusy(true);
              const result = await save({
                environmentId,
                input: {
                  projectId,
                  baseRevision: null,
                  flowId: FlowId.make(newId),
                  definition: {
                    version: 1,
                    title: newId,
                    workspace: "worktree",
                    steps: [],
                    edges: [],
                  },
                },
              });
              if (result._tag === "Success") {
                setSelected(result.value.flowId);
                setNewId(null);
              }
              reportFlowFailure(result, "Could not create flow");
              setBusy(false);
            }}
          >
            Create flow
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setNewId(null)}>
            Cancel
          </Button>
        </div>
      )}
      {entry?.validation.valid === false && !entry.definition && (
        <div role="alert" className="p-2 text-destructive">
          Invalid flow
          {entry.validation.errors.map((error) => (
            <p key={`${error.path}:${error.message}`}>
              {error.path}: {error.message}
            </p>
          ))}
        </div>
      )}
      {entry?.definition ? (
        <FlowEditor
          key={entry.flowId}
          environmentId={environmentId}
          projectId={projectId}
          flowId={entry.flowId}
          initial={entry.definition}
          revision={entry.revision}
          flowIds={list.data?.flows.map((flow) => flow.flowId) ?? []}
          requestKey={scopedThreadKey(threadRef)}
          onRenamed={setSelected}
          request={request?.flowId && request.flowId !== entry.flowId ? undefined : request}
        />
      ) : (
        !list.isPending && (
          <p className="p-4 text-muted-foreground">
            {entry ? "Fix this flow file in the project to edit it." : "Create a flow to begin."}
          </p>
        )
      )}
    </div>
  );
}

function FlowEditor({
  environmentId,
  projectId,
  flowId,
  initial,
  revision,
  flowIds,
  requestKey,
  request,
  onRenamed,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  flowId: FlowId;
  initial: FlowDefinition;
  revision: string;
  flowIds: ReadonlyArray<string>;
  requestKey: string;
  onRenamed: (flowId: FlowId) => void;
  request: ReturnType<typeof useFlowPanelRequest.getState>["requests"][string] | undefined;
}) {
  const navigate = useNavigate();
  const canSchedule = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const draftKey = JSON.stringify([environmentId, projectId, flowId]);
  const [draftStore] = useState(
    () => flowDrafts.get(draftKey) ?? createFlowDraft({ definition: initial, revision }),
  );
  const draftState = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot);
  const { definition: draft, saved, saving, error: saveError, conflict } = draftState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads pristine drafts when the watched flow file changes
  useEffect(() => {
    const current = draftStore.getSnapshot();
    if (current.definition === current.saved && current.revision !== revision)
      draftStore.reload({ definition: initial, revision });
  }, [draftStore, initial, revision]);
  const [tab, setTab] = useState<"design" | "runs">("design");
  const [flowRunId, setFlowRunId] = useState<FlowRunId | null>(request?.flowRunId ?? null);
  const [showStart, setShowStart] = useState(request?.start ?? false);
  const [lastRequest, setLastRequest] = useState(request);
  if (request !== lastRequest) {
    setLastRequest(request);
    if (request?.flowRunId) {
      setFlowRunId(request.flowRunId);
      setTab("design");
    }
    if (request?.start) setShowStart(true);
  }
  const [selection, setSelection] = useState<{ kind: "step" | "edge" | "flow"; id: string } | null>(
    null,
  );
  const [stepRunId, setStepRunId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [disableSchedules, setDisableSchedules] = useState(true);
  const schedules = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const targetedSchedules = (schedules.data?.tasks ?? []).filter(
    (task) => task.projectId === projectId && task.flow?.flowId === flowId,
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const canDisableSchedules = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const save = useAtomCommand(flowEnvironment.save);
  const rename = useAtomCommand(flowEnvironment.rename);
  const remove = useAtomCommand(flowEnvironment.delete);
  const validate = useAtomCommand(flowEnvironment.validate);
  const canSave = useAtomValue(flowEnvironment.save.permissionAtom(environmentId));
  const canRename = useAtomValue(flowEnvironment.rename.permissionAtom(environmentId));
  const canDelete = useAtomValue(flowEnvironment.delete.permissionAtom(environmentId));
  const canValidate = useAtomValue(flowEnvironment.validate.permissionAtom(environmentId));
  const canStart = useAtomValue(flowEnvironment.start.permissionAtom(environmentId));
  const history = useEnvironmentQuery(
    flowEnvironment.runs({ environmentId, input: { projectId } }),
  );
  const detail = useEnvironmentQuery(
    flowRunId ? flowEnvironment.run({ environmentId, input: { flowRunId } }) : null,
  );
  const [serverErrors, setServerErrors] = useState<
    ReadonlyArray<{ path: string; message: string }>
  >([]);
  const validation = validateFlowDefinition(draft);
  const dirty = draft !== saved;
  const problems = [...validation.errors, ...serverErrors];
  const persist = useStableCallback(async (overwrite = false) => {
    if (!canSave) return;
    await draftStore.save(
      async (input) => {
        const result = await save({ environmentId, input: { projectId, flowId, ...input } });
        reportFlowFailure(result, "Could not save flow");
        return result;
      },
      overwrite
        ? revision !== draftState.revision
          ? revision
          : draftState.conflictRevision
        : undefined,
    );
    if (draftStore.getSnapshot().definition === draftStore.getSnapshot().saved)
      flowDrafts.delete(draftKey);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces writes to the environment's flow file
  useEffect(() => {
    if (!dirty || saving || saveError || conflict) return;
    const timer = setTimeout(() => {
      if (draftStore.getSnapshot().definition === draft) void persist();
    }, 650);
    return () => clearTimeout(timer);
  }, [draft, dirty, saving, saveError, conflict, persist, draftStore]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes the latest draft when this editor closes
  useEffect(
    () => () => {
      void persist();
    },
    [persist],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges an external panel request after applying it
  useEffect(() => {
    if (request) useFlowPanelRequest.getState().consume(requestKey, request);
  }, [request, requestKey]);
  const change = (definition: FlowDefinition) => {
    flowDrafts.set(draftKey, draftStore);
    draftStore.change(definition);
    setServerErrors([]);
  };
  const discard = () => {
    draftStore.reload({ definition: initial, revision });
    flowDrafts.delete(draftKey);
  };
  const [older, setOlder] = useState<FlowRunsPage>({ runs: [], nextCursor: null });
  const [loadedOlder, setLoadedOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pageError, setPageError] = useState(false);
  const loadOlder = useAtomCommand(flowEnvironment.runsPage);
  const cursor = loadedOlder ? older.nextCursor : history.data?.nextCursor;
  const snapshot = detail.data;
  const runs = applyFlowRunsEvent(older, { type: "upsert", runs: history.data?.runs ?? [] })
    .runs.filter((run) => run.flowId === flowId)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selectedRun =
    snapshot?.stepRuns.find((step) => step.id === stepRunId) ??
    (selection?.kind === "step"
      ? snapshot && latestStepRunById(snapshot).get(selection.id)
      : undefined);
  const displayed = snapshot?.definition ?? draft;
  const step = selection?.kind === "step" ? findStep(displayed.steps, selection.id) : undefined;
  const edgeParent =
    selection?.kind === "edge" ? selection.id.slice(0, selection.id.lastIndexOf(":")) : null;
  const edgeIndex =
    selection?.kind === "edge" ? Number(selection.id.slice(selection.id.lastIndexOf(":") + 1)) : -1;
  const level = edgeParent === "$" ? draft : edgeParent ? findStep(draft.steps, edgeParent) : null;
  const edge = level && "edges" in level ? level.edges[edgeIndex] : undefined;
  const editEdge = (next: FlowEdge | null) =>
    change(
      editLevel(draft, edgeParent === "$" ? null : edgeParent, (level) => ({
        ...level,
        edges: next
          ? level.edges.map((entry, index) => (index === edgeIndex ? next : entry))
          : level.edges.filter((_, index) => index !== edgeIndex),
      })),
    );
  const locked = flowRunId !== null || !canSave;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <ToggleGroup
          variant="segmented"
          size="segmented"
          value={[tab]}
          onValueChange={(value) => {
            if (value[0] === "design" || value[0] === "runs") setTab(value[0]);
          }}
        >
          <Toggle value="design">Design</Toggle>
          <Toggle value="runs">
            Runs <span className="text-muted-foreground">{runs.length}</span>
          </Toggle>
        </ToggleGroup>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {(saving || saveError || dirty) && (
            <span role="status" className="truncate text-2xs text-muted-foreground">
              {saving ? "Saving…" : saveError ? "Save failed" : "Unsaved"}
            </span>
          )}
          {dirty && (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canSave || saving}
              onClick={() => void persist()}
            >
              Save
            </Button>
          )}
          {problems.length > 0 && (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`${problems.length} problems`}
                    onClick={() => {
                      const id = stepIdAtPath(draft, problems[0]!.path);
                      setTab("design");
                      setSelection(id ? { kind: "step", id } : { kind: "flow", id: "" });
                    }}
                  />
                }
              >
                <Badge variant="error" size="sm">
                  <TriangleAlert />
                  {problems.length} problems
                </Badge>
              </PopoverTrigger>
              <PopoverPopup width="md">
                <div className="flex max-h-64 flex-col gap-1 overflow-auto">
                  {problems.map((problem) => (
                    <Button
                      key={`${problem.path}:${problem.message}`}
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        const id = stepIdAtPath(draft, problem.path);
                        setTab("design");
                        setSelection(id ? { kind: "step", id } : { kind: "flow", id: "" });
                      }}
                    >
                      {problem.path}: {problem.message}
                    </Button>
                  ))}
                </div>
              </PopoverPopup>
            </Popover>
          )}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Flow actions" />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setSelection({ kind: "flow", id: "" })}>
                Flow settings
              </MenuItem>
              <MenuItem
                disabled={!canSchedule || dirty || saving || !validation.valid}
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId, projectId, flowId },
                  })
                }
              >
                Schedule…
              </MenuItem>
              <MenuItem
                disabled={!canValidate}
                onClick={async () => {
                  const result = await validate({
                    environmentId,
                    input: { projectId, definition: draft },
                  });
                  if (result._tag === "Success") setServerErrors(result.value.errors);
                  reportFlowFailure(result, "Could not validate flow");
                }}
              >
                Validate with environment
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={!canRename || dirty} onClick={() => setRenameId(flowId)}>
                Rename flow file
              </MenuItem>
              <MenuItem disabled={!canDelete || dirty} onClick={() => setDeleteOpen(true)}>
                Delete flow
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button
            size="xs"
            disabled={!canStart || dirty || saving || !validation.valid}
            onClick={() => setShowStart(!showStart)}
          >
            Start
          </Button>
        </div>
      </div>
      {targetedSchedules.length > 0 && (
        <div className="p-2 text-xs">
          Schedules:{" "}
          {targetedSchedules.map((task) => (
            <Link
              key={task.id}
              className="mr-2 underline"
              to="/settings/scheduled-tasks"
              search={{ environmentId, taskId: task.id }}
            >
              {task.title}
              {task.enabled ? "" : " (disabled)"}
            </Link>
          ))}
        </div>
      )}
      {(conflict || (dirty && revision !== draftState.revision)) && (
        <div role="alert" className="p-2 text-xs">
          File changed on disk. Reload to discard this draft, or overwrite the current file.
          <Button size="xs" variant="outline" disabled={saving} onClick={discard}>
            Reload
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={saving || !canSave}
            onClick={() => {
              void persist(true);
            }}
          >
            Overwrite
          </Button>
        </div>
      )}
      {showStart && (dirty || !validation.valid) && (
        <p className="p-2 text-xs">Save a valid flow before starting it.</p>
      )}
      {showStart && !dirty && validation.valid && (
        <FlowStartForm
          environmentId={environmentId}
          projectId={projectId}
          flowId={flowId}
          definition={draft}
          onStarted={(id) => {
            setFlowRunId(id);
            setShowStart(false);
          }}
          onClose={() => setShowStart(false)}
        />
      )}
      {flowRunId && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-xs">
          <span>
            Viewing run{" "}
            {snapshot?.summary.runNumber ??
              runs.find((run) => run.id === flowRunId)?.runNumber ??
              "..."}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setFlowRunId(null);
              setStepRunId(null);
            }}
          >
            Back to editing
          </Button>
          {snapshot && <FlowRunActions environmentId={environmentId} summary={snapshot.summary} />}
        </div>
      )}
      {detail.error && <p role="alert">{detail.error}</p>}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === "runs" ? (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {history.error && <p role="alert">{history.error}</p>}
            {runs.map((run) => (
              <Button
                key={run.id}
                size="sm"
                variant={flowRunId === run.id ? "secondary" : "ghost"}
                aria-pressed={flowRunId === run.id}
                onClick={() => {
                  setFlowRunId(run.id);
                  setStepRunId(null);
                }}
              >
                {run.flowTitle} · Flow run {run.runNumber} · {run.status.replaceAll("_", " ")} ·{" "}
                {formatRelativeTimeLabel(run.createdAt)}
              </Button>
            ))}
            {cursor && (
              <Button
                size="xs"
                variant="outline"
                disabled={loadingOlder}
                onClick={async () => {
                  setLoadingOlder(true);
                  setPageError(false);
                  const result = await loadOlder({
                    environmentId,
                    input: { projectId, before: cursor },
                  });
                  if (result._tag === "Success") {
                    setOlder((previous) => ({
                      ...applyFlowRunsEvent(previous, { type: "upsert", runs: result.value.runs }),
                      nextCursor: result.value.nextCursor,
                    }));
                    setLoadedOlder(true);
                  } else setPageError(true);
                  setLoadingOlder(false);
                }}
              >
                Load older flow runs
              </Button>
            )}
            {pageError && <p role="alert">Could not load older flow runs.</p>}
            {snapshot && (
              <>
                <Button size="xs" variant="outline" onClick={() => setTab("design")}>
                  View on canvas
                </Button>
                <FlowRunTimeline
                  selectedId={selectedRun?.id ?? null}
                  snapshot={snapshot}
                  onSelect={(step) => setStepRunId(step.id)}
                />
              </>
            )}
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            {flowRunId && !snapshot ? (
              <p className="p-3 text-xs text-muted-foreground">Loading flow run…</p>
            ) : (
              <FlowCanvas
                definition={displayed}
                snapshot={snapshot}
                locked={locked}
                selectedId={
                  selection?.kind === "step" || selection?.kind === "edge" ? selection.id : null
                }
                errors={validation.errors}
                onDeselect={() => {
                  setSelection(null);
                  setStepRunId(null);
                }}
                onChange={change}
                onSelectStep={(id) => {
                  setSelection({ kind: "step", id });
                  setStepRunId(null);
                }}
                onSelectEdge={(id) => {
                  setSelection({ kind: "edge", id });
                  setStepRunId(null);
                }}
              />
            )}
          </div>
        )}
        {(selection || selectedRun) && (
          <section
            aria-label="Flow inspector"
            className="absolute inset-x-0 bottom-0 z-10 max-h-[55%] overflow-auto scrollbar-gutter-both rounded-t-2xl border-t border-border bg-popover p-3 text-xs shadow-xl"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSelection(null);
                setStepRunId(null);
              }
            }}
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border" />
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium">
                {step && <FlowKindIcon kind={step.kind} />}
                {flowRunId
                  ? (selectedRun?.stepPath.at(-1) ?? "Step run")
                  : selection?.kind === "flow"
                    ? "Flow settings"
                    : step
                      ? step.id
                      : "Edge"}
              </h3>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close inspector"
                onClick={() => {
                  setSelection(null);
                  setStepRunId(null);
                }}
              >
                <X />
              </Button>
            </div>
            {flowRunId ? (
              selectedRun && snapshot ? (
                <StepRunInspector
                  key={selectedRun.id}
                  environmentId={environmentId}
                  snapshot={snapshot}
                  stepRun={selectedRun}
                />
              ) : (
                <p>No step run recorded for this step.</p>
              )
            ) : (
              <fieldset disabled={locked} className="flex flex-col gap-3">
                {step && (
                  <>
                    <StepForm
                      key={step.id}
                      errors={[...validation.errors, ...serverErrors].filter(
                        (error) => stepIdAtPath(draft, error.path) === step.id,
                      )}
                      step={step}
                      onRename={(id) => {
                        change(renameStep(draft, step.id, id));
                        setSelection({ kind: "step", id });
                      }}
                      onChange={(next) => {
                        change({ ...draft, steps: updateStep(draft.steps, step.id, () => next) });
                        if (next.id !== step.id) setSelection({ kind: "step", id: next.id });
                      }}
                    />
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => {
                        change(removeStep(draft, step.id));
                        setSelection(null);
                      }}
                    >
                      <Trash2 /> Remove step
                    </Button>
                  </>
                )}
                {edge && (
                  <>
                    <TextField
                      label="From step"
                      value={edge.from}
                      onChange={(from) => editEdge({ ...edge, from })}
                    />
                    <TextField
                      label="To step"
                      value={edge.to}
                      onChange={(to) => editEdge({ ...edge, to })}
                    />
                    <Choice
                      label="When step"
                      value={edge.on ?? "success"}
                      values={["success", "failure"]}
                      onChange={(value) =>
                        editEdge({ ...edge, on: value === "failure" ? "failure" : undefined })
                      }
                    />
                    <Choice
                      label="Edge condition"
                      value={edge.when ? "conditional" : "always"}
                      values={["always", "conditional"]}
                      onChange={(value) =>
                        editEdge({
                          ...edge,
                          when:
                            value === "conditional" ? { ref: "", op: "eq", value: "" } : undefined,
                        })
                      }
                    />
                    {edge.when && (
                      <ConditionForm
                        value={edge.when}
                        onChange={(when) => editEdge({ ...edge, when })}
                      />
                    )}
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => {
                        editEdge(null);
                        setSelection(null);
                      }}
                    >
                      <Trash2 /> Remove edge
                    </Button>
                  </>
                )}
                {selection?.kind === "flow" && (
                  <>
                    <TextField
                      label="Title"
                      value={draft.title}
                      onChange={(title) => change({ ...draft, title })}
                    />
                    <TextField
                      label="Description"
                      value={draft.description ?? ""}
                      multiline
                      onChange={(description) =>
                        change({ ...draft, description: description || undefined })
                      }
                    />
                    <Choice
                      label="Workspace"
                      value={draft.workspace ?? "worktree"}
                      values={["worktree", "root"]}
                      onChange={(workspace) =>
                        change({ ...draft, workspace: workspace === "root" ? "root" : "worktree" })
                      }
                    />
                    {draft.workspace === "root" && (
                      <p>
                        Flow runs share the project folder. Concurrent flow runs can change the same
                        files.
                      </p>
                    )}
                    <InputFieldsForm
                      fields={draft.inputs ?? []}
                      onChange={(inputs) => change({ ...draft, inputs })}
                    />
                    <ModelFields
                      value={draft.defaults?.model}
                      onChange={(model) =>
                        change({ ...draft, defaults: { ...draft.defaults, model } })
                      }
                    />
                    <AgentModes
                      value={draft.defaults ?? {}}
                      onChange={(modes) =>
                        change({ ...draft, defaults: { ...draft.defaults, ...modes } })
                      }
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canRename || dirty}
                      onClick={() => setRenameId(flowId)}
                    >
                      Rename flow file
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canDelete || dirty}
                      onClick={() => setDeleteOpen(true)}
                    >
                      Delete flow
                    </Button>
                  </>
                )}
              </fieldset>
            )}
          </section>
        )}
      </div>
      {renameId !== null && (
        <div className="flex flex-col gap-2 p-3">
          <TextField label="New flow id" value={renameId} onChange={setRenameId} />
          <Button
            size="xs"
            disabled={
              !canRename ||
              !isFlowId(renameId) ||
              (renameId !== flowId && flowIds.includes(renameId))
            }
            onClick={async () => {
              const result = await rename({
                environmentId,
                input: { projectId, flowId, newFlowId: FlowId.make(renameId) },
              });
              if (result._tag === "Success") {
                setRenameId(null);
                onRenamed(result.value.flowId);
              }
              reportFlowFailure(result, "Could not rename flow");
            }}
          >
            Rename
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setRenameId(null)}>
            Cancel
          </Button>
        </div>
      )}
      {deleteOpen && (
        <div className="flex flex-col gap-2 p-3">
          <p>Delete {flowId}? Existing flow runs remain available in their threads.</p>
          {targetedSchedules.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={disableSchedules}
                onCheckedChange={(checked) => setDisableSchedules(checked === true)}
              />
              Disable schedules targeting this flow
            </label>
          )}
          <Button
            size="xs"
            disabled={
              !canDelete ||
              (disableSchedules && targetedSchedules.length > 0 && !canDisableSchedules)
            }
            onClick={async () => {
              if (disableSchedules) {
                for (const task of targetedSchedules) {
                  const result = await setEnabled({
                    environmentId,
                    input: { id: task.id, enabled: false },
                  });
                  if (
                    reportFlowFailure(result, "Could not disable schedule") ||
                    result._tag !== "Success"
                  )
                    return;
                }
              }
              const result = await remove({ environmentId, input: { projectId, flowId } });
              if (result._tag === "Success") setDeleteOpen(false);
              reportFlowFailure(result, "Could not delete flow");
            }}
          >
            Confirm delete
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function FlowStartForm({
  environmentId,
  projectId,
  flowId,
  definition,
  onStarted,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  flowId: FlowId;
  definition: FlowDefinition;
  onStarted: (id: FlowRunId) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (definition.inputs ?? [])
        .filter((field) => field.default !== undefined)
        .map((field) => [
          field.name,
          Array.isArray(field.default) ? field.default.join("\n") : String(field.default),
        ]),
    ),
  );
  const [baseRef, setBaseRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useAtomCommand(flowEnvironment.start);
  const allowed = useAtomValue(flowEnvironment.start.permissionAtom(environmentId));
  return (
    <form
      className="flex max-h-80 flex-col gap-2 overflow-auto border-b border-border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        let inputs;
        try {
          inputs = coerceFlowInputs(definition.inputs ?? [], values);
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          return;
        }
        setBusy(true);
        const result = await start({
          environmentId,
          input: { projectId, flowId, inputs, ...(baseRef ? { baseRef } : {}) },
        });
        if (result._tag === "Success") onStarted(result.value.id);
        else setError(reportFlowFailure(result, "Could not start flow"));
        setBusy(false);
      }}
    >
      <h3>Start flow</h3>
      {(definition.inputs ?? []).map((field) => (
        <div key={field.name}>
          {field.type === "boolean" ? (
            <Choice
              label={`${field.name}${field.required ? " (required)" : ""}`}
              value={values[field.name] ?? ""}
              values={["", "true", "false"]}
              labels={{ "": "Not set", true: "True", false: "False" }}
              onChange={(value) => setValues({ ...values, [field.name]: value })}
            />
          ) : (
            <TextField
              label={`${field.name}${field.required ? " (required)" : ""} · ${field.type}`}
              value={values[field.name] ?? ""}
              multiline={field.type === "string[]"}
              onChange={(value) => setValues({ ...values, [field.name]: value })}
            />
          )}
          <p className="text-xs text-muted-foreground">{field.description}</p>
        </div>
      ))}
      <TextField label="Base branch (optional)" value={baseRef} onChange={setBaseRef} />
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button size="xs" type="submit" disabled={!allowed || busy}>
          Start flow
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
