import {
  createContext,
  memo,
  useContext,
  useState,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type FitViewOptions,
  type NodeProps,
} from "@xyflow/react";
import type {
  FlowDefinition,
  FlowRunSnapshot,
  FlowStep,
  FlowStepRunStatus,
} from "@t3tools/contracts";
import { flowStepStatusById, flowStepCountsById } from "@t3tools/client-runtime/flows";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import {
  CONTAINER_HEADER,
  conditionLabel,
  stepIdAtPath,
  flowGraph,
  dropTarget,
  editLevel,
  findStep,
  newStep,
  type FlowNode,
} from "./flowGraph";
import { FlowKindIcon, FlowStepStatus } from "./FlowStepStatus";
import { Image, Plus, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { cn } from "../../lib/utils";
const FlowRunContext = createContext<ReadonlyMap<string, FlowStepRunStatus>>(new Map());
const FlowCountsContext = createContext<
  ReadonlyMap<string, { total: number; succeeded: number; failed: number }>
>(new Map());
function stepSummary(step: FlowStep) {
  switch (step.kind) {
    case "agent":
      return `${step.model?.model || "Inherits model"} · ${step.prompt.split("\n")[0]}`;
    case "command":
      return step.command.split("\n")[0];
    case "approval":
      return step.prompt.split("\n")[0] || "Approve or reject + comment";
    case "loop":
      // A new loop starts with an empty condition; label it once it names a ref.
      return "ref" in step.until && !step.until.ref
        ? `Up to ${step.maxIterations} iterations`
        : `Up to ${step.maxIterations} iterations · until ${conditionLabel(step.until)}`;
    case "map":
      return `For each in ${step.over} · ${step.concurrency ?? 1} at a time`;
  }
}
const FlowStepNode = memo(function FlowStepNode({ data, id, selected }: NodeProps<FlowNode>) {
  const status = useContext(FlowRunContext).get(id);
  const count = useContext(FlowCountsContext).get(id);
  const container = data.step.kind === "loop" || data.step.kind === "map";
  const title = (
    <div className="flex items-center gap-2">
      <FlowKindIcon kind={data.step.kind} />
      <span className="truncate font-medium">{data.step.id}</span>
      {data.errors?.length ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span tabIndex={0} aria-label="Step problems" aria-describedby={`${id}-errors`} />
            }
          >
            <TriangleAlert className="size-3.5 text-destructive" />
          </TooltipTrigger>
          <TooltipPopup>
            <span>{data.errors.join("; ")}</span>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {data.step.kind === "agent" && !!data.step.images?.length && (
        <span
          className="flex items-center gap-1 text-3xs text-muted-foreground"
          aria-label={`${data.step.images.length} images`}
        >
          <Image className="size-3" />
          {data.step.images.length}
        </span>
      )}
      <span className="ml-auto text-3xs text-muted-foreground">{data.step.kind}</span>
    </div>
  );
  const summary = (
    <p
      className={cn(
        "mt-1 truncate text-3xs text-muted-foreground",
        data.step.kind === "command" && "font-mono",
      )}
    >
      {stepSummary(data.step)}
    </p>
  );
  const runStatus = status && (
    <div className="mt-1 flex items-center gap-2">
      <FlowStepStatus status={status} />
      {count && count.total > 1 && (
        <span className="text-3xs text-muted-foreground">
          {count.succeeded}/{count.total} succeeded
        </span>
      )}
    </div>
  );
  return (
    <div
      data-step-status={status ?? "editing"}
      data-drop-target={data.dropTarget || undefined}
      className={cn(
        "h-full rounded-xl border text-xs text-card-foreground shadow-xs",
        container
          ? "flex min-h-full flex-col border-foreground/15 bg-muted/30 dark:bg-muted/15"
          : "h-20 w-56 bg-card px-3 py-2",
        data.dropTarget && "ring-2 ring-primary/40",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        (status === "skipped" || status === "cancelled") && "opacity-60",
        data.errors?.length && "border-destructive",
        status === "succeeded" && "border-success",
        (status === "failed" || status === "interrupted") && "border-destructive",
        (status === "running" || status === "waiting_report") && "border-primary",
        status === "waiting_approval" && "border-warning",
      )}
    >
      <Handle type="target" position={Position.Top} />
      {container ? (
        <>
          <div
            className="flex shrink-0 flex-col justify-center rounded-t-xl border-b border-foreground/10 bg-card/60 px-3"
            style={{ height: CONTAINER_HEADER }}
          >
            {title}
            {status ? runStatus : summary}
          </div>
          {(data.step.kind === "loop" || data.step.kind === "map") &&
            data.step.steps.length === 0 && (
              <p className="m-auto text-3xs text-muted-foreground">Drag steps here</p>
            )}
        </>
      ) : (
        <>
          {title}
          {summary}
          {runStatus}
        </>
      )}
      {!!data.errors?.length && (
        <span id={`${id}-errors`} className="sr-only">
          {data.errors.join("; ")}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});
const nodeTypes = { step: FlowStepNode };
const paletteDescriptions = {
  agent: "Ask an agent to work on a prompt",
  command: "Run a shell command",
  approval: "Wait for a person to approve or reject",
  loop: "Repeat steps until a condition is met",
  map: "Run steps for each item in a list",
};
const kinds: ReadonlyArray<FlowStep["kind"]> = ["agent", "command", "approval", "loop", "map"];

export function FlowCanvas(props: {
  definition: FlowDefinition;
  snapshot: FlowRunSnapshot | null;
  locked: boolean;
  selectedId: string | null;
  errors: ReadonlyArray<{ path: string; message: string }>;
  onDeselect: () => void;
  onChange: (definition: FlowDefinition) => void;
  onSelectStep: (id: string) => void;
  onSelectEdge: (id: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
function Canvas({
  definition,
  snapshot,
  locked,
  selectedId,
  errors,
  onDeselect,
  onChange,
  onSelectStep,
  onSelectEdge,
}: Parameters<typeof FlowCanvas>[0]) {
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition, setCenter, getViewport } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [dropParent, setDropParent] = useState<string | null>(null);
  const [graphState, setGraphState] = useState(() => ({
    definition,
    graph: flowGraph(definition),
  }));
  let graph = graphState.graph;
  if (definition !== graphState.definition) {
    graph = flowGraph(definition, graph.nodes);
    setGraphState({ definition, graph });
  }
  const nodes = graph.nodes.map((node) => {
    const selected = selectedId === node.id;
    const messages = errors
      .filter((error) => stepIdAtPath(definition, error.path) === node.id)
      .map((error) => error.message);
    const unchanged =
      !!node.data.dropTarget === (dropParent === node.id) &&
      selected === !!node.selected &&
      messages.join("\n") === (node.data.errors ?? []).join("\n");
    return unchanged
      ? node
      : {
          ...node,
          selected,
          data: { ...node.data, errors: messages, dropTarget: dropParent === node.id },
        };
  });
  if (nodes.some((node, i) => node !== graph.nodes[i])) {
    graph = { ...graph, nodes };
    setGraphState({ definition, graph });
  }
  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  let selectedX = selectedNode?.position.x;
  let selectedY = selectedNode?.position.y;
  let ancestorId = selectedNode?.parentId;
  while (ancestorId && selectedX !== undefined && selectedY !== undefined) {
    const ancestor = graph.nodes.find((node) => node.id === ancestorId);
    if (!ancestor) break;
    selectedX += ancestor.position.x;
    selectedY += ancestor.position.y;
    ancestorId = ancestor.parentId;
  }
  const revealSelected = () => {
    if (selectedX === undefined || selectedY === undefined || !wrapper.current) return;
    const { x, y, zoom } = getViewport();
    const left = selectedX * zoom + x;
    const top = selectedY * zoom + y;
    const { clientWidth, clientHeight } = wrapper.current;
    if (
      left >= 0 &&
      top >= 0 &&
      left + 224 * zoom <= clientWidth &&
      top + 80 * zoom <= clientHeight * 0.55
    )
      return;
    void setCenter(selectedX + 112, selectedY + 40 + (clientHeight * 0.22) / zoom, { zoom });
  };
  // Grabbing a step selects it on pointer down; panning then would fling the dragged step away.
  const pointerSelection = useRef<string | null>(null);
  const onSelectionChange = useEffectEvent((id: string | null) => {
    const fromPointer = id !== null && id === pointerSelection.current;
    pointerSelection.current = null;
    if (id !== null && !fromPointer) revealSelected();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings a step selected elsewhere into view above the overlay inspector
  useEffect(() => onSelectionChange(selectedId), [selectedId]);
  const parent =
    selectedNode &&
    (selectedNode.data.step.kind === "loop" || selectedNode.data.step.kind === "map")
      ? selectedNode.id
      : (selectedNode?.parentId ?? null);
  const edges = graph.edges.map((edge) =>
    !!edge.selected === (selectedId === edge.id)
      ? edge
      : { ...edge, selected: selectedId === edge.id },
  );
  if (edges.some((edge, i) => edge !== graph.edges[i])) {
    graph = { ...graph, edges };
    setGraphState({ definition, graph });
  }
  const [runState, setRunState] = useState(() => ({
    snapshot,
    statuses: snapshot ? flowStepStatusById(snapshot) : new Map<string, FlowStepRunStatus>(),
    counts: snapshot
      ? flowStepCountsById(snapshot)
      : new Map<string, { total: number; succeeded: number; failed: number }>(),
  }));
  let currentRun = runState;
  if (snapshot !== runState.snapshot) {
    currentRun = {
      snapshot,
      statuses: snapshot ? flowStepStatusById(snapshot) : new Map<string, FlowStepRunStatus>(),
      counts: snapshot
        ? flowStepCountsById(snapshot)
        : new Map<string, { total: number; succeeded: number; failed: number }>(),
    };
    setRunState(currentRun);
  }
  const add = (
    kind: FlowStep["kind"],
    position?: { x: number; y: number },
    targetParent = parent,
  ) => {
    if (locked) return;
    let index = 1;
    while (findStep(definition.steps, `${kind}-${index}`)) index++;
    const step = newStep(kind, `${kind}-${index}`);
    const next = editLevel(definition, targetParent, (level) => ({
      ...level,
      steps: [...level.steps, step],
    }));
    onChange(position ? { ...next, layout: { ...next.layout, [step.id]: position } } : next);
    onSelectStep(step.id);
  };
  // Small flows otherwise zoom past 1:1; the left inset keeps the palette off the first step.
  const fitViewOptions: FitViewOptions = {
    maxZoom: 1,
    padding: locked ? "24px" : { top: "24px", right: "24px", bottom: "24px", left: "144px" },
  };
  return (
    <FlowRunContext value={currentRun.statuses}>
      <FlowCountsContext value={currentRun.counts}>
        <div
          ref={wrapper}
          className="flow-canvas @container h-full"
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof globalThis.Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              setDropParent(null);
          }}
          onDragOver={(event) => {
            if (!locked) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropParent(
                dropTarget(
                  graph.nodes,
                  screenToFlowPosition({ x: event.clientX, y: event.clientY }),
                ).parentId,
              );
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const kind = kinds.find(
              (candidate) => candidate === event.dataTransfer.getData("application/t3-flow-step"),
            );
            if (kind) {
              const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
              const target = dropTarget(graph.nodes, position);
              setDropParent(null);
              add(kind, target.position, target.parentId);
            }
          }}
        >
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            colorMode={resolvedTheme}
            fitView
            fitViewOptions={fitViewOptions}
            minZoom={0.1}
            maxZoom={1.6}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            edgesReconnectable={!locked}
            deleteKeyCode={null}
            onNodeClick={(_, node) => {
              onSelectStep(node.id);
              if (node.id === selectedId) revealSelected();
            }}
            onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
            onNodesChange={(changes) => {
              const selected = changes.find(
                (change) => change.type === "select" && change.selected,
              );
              if (selected?.type === "select") {
                pointerSelection.current = selected.id;
                onSelectStep(selected.id);
              }
              const nextNodes = applyNodeChanges(changes, graph.nodes);
              setGraphState({ definition, graph: { ...graph, nodes: nextNodes } });
              if (locked) return;
              const layout = { ...definition.layout };
              let changed = false;
              for (const change of changes)
                if (change.type === "position" && change.position && change.dragging !== true) {
                  layout[change.id] = change.position;
                  changed = true;
                }
              if (changed) onChange({ ...definition, layout });
            }}
            onReconnect={(edge, connection) => {
              if (locked) return;
              const parentId =
                graph.nodes.find((node) => node.id === connection.source)?.parentId ?? null;
              const targetParent =
                graph.nodes.find((node) => node.id === connection.target)?.parentId ?? null;
              const edgeParent = edge.id.slice(0, edge.id.lastIndexOf(":"));
              if (parentId !== targetParent || (parentId ?? "$") !== edgeParent) return;
              const index = Number(edge.id.slice(edge.id.lastIndexOf(":") + 1));
              onChange(
                editLevel(definition, parentId, (level) => ({
                  ...level,
                  edges: level.edges.map((entry, i) =>
                    i === index
                      ? { ...entry, from: connection.source, to: connection.target }
                      : entry,
                  ),
                })),
              );
            }}
            onEdgesChange={(changes) => {
              const selected = changes.find(
                (change) => change.type === "select" && change.selected,
              );
              if (selected?.type === "select") onSelectEdge(selected.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onDeselect();
            }}
            onPaneClick={onDeselect}
            onConnect={({ source, target }) => {
              if (locked) return;
              const sourceParent = graph.nodes.find((node) => node.id === source)?.parentId ?? null;
              const targetParent = graph.nodes.find((node) => node.id === target)?.parentId ?? null;
              if (sourceParent === targetParent)
                onChange(
                  editLevel(definition, sourceParent, (level) => ({
                    ...level,
                    edges: [...level.edges, { from: source, to: target }],
                  })),
                );
            }}
          >
            {definition.steps.length === 0 && (
              <Panel position="top-center">
                <div className="mt-24 max-w-48 text-center text-xs text-muted-foreground">
                  Drag a step from the palette to start building your flow.
                </div>
              </Panel>
            )}
            <Background gap={18} size={1} />
            <Controls
              showInteractive={false}
              position="top-right"
              fitViewOptions={fitViewOptions}
            />
            {!locked && (
              <Panel position="top-left">
                <div className="hidden min-w-32 flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg @min-[24rem]:flex">
                  <span className="px-2 py-1 text-3xs font-medium text-muted-foreground">
                    DRAG A STEP
                  </span>
                  {parent && (
                    <span className="max-w-40 truncate px-2 text-3xs text-muted-foreground">
                      Adding into {parent}
                    </span>
                  )}
                  {kinds.map((kind) => (
                    <Tooltip key={kind}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            draggable
                            className="flex cursor-grab items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                            onDragStart={(event) =>
                              event.dataTransfer.setData("application/t3-flow-step", kind)
                            }
                            onClick={() => add(kind)}
                          />
                        }
                      >
                        <FlowKindIcon kind={kind} />
                        {kind === "agent"
                          ? "Agent"
                          : kind === "command"
                            ? "Command"
                            : kind === "approval"
                              ? "Approval"
                              : kind === "loop"
                                ? "Loop"
                                : "Map"}
                      </TooltipTrigger>
                      <TooltipPopup>{paletteDescriptions[kind]}</TooltipPopup>
                    </Tooltip>
                  ))}
                </div>
                <div className="@min-[24rem]:hidden">
                  <Menu>
                    <MenuTrigger
                      render={<Button size="icon-sm" variant="outline" aria-label="Add step" />}
                    >
                      <Plus />
                    </MenuTrigger>
                    <MenuPopup align="start">
                      {kinds.map((kind) => (
                        <MenuItem key={kind} onClick={() => add(kind)}>
                          <FlowKindIcon kind={kind} />
                          {kind}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>
      </FlowCountsContext>
    </FlowRunContext>
  );
}
