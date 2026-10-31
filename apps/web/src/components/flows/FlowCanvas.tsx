import { createContext, memo, useContext, useState, useEffect, useRef } from "react";
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
  stepIdAtPath,
  flowGraph,
  dropTarget,
  editLevel,
  findStep,
  newStep,
  type FlowNode,
} from "./flowGraph";
import { FlowKindIcon, FlowStepStatus } from "./FlowStepStatus";
import { Plus, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { cn } from "../../lib/utils";
const FlowRunContext = createContext<ReadonlyMap<string, FlowStepRunStatus>>(new Map());
const FlowCountsContext = createContext<
  ReadonlyMap<string, { total: number; succeeded: number; failed: number }>
>(new Map());
const FlowStepNode = memo(function FlowStepNode({ data, id, selected }: NodeProps<FlowNode>) {
  const status = useContext(FlowRunContext).get(id);
  const count = useContext(FlowCountsContext).get(id);
  const container = data.step.kind === "loop" || data.step.kind === "map";
  return (
    <div
      data-step-status={status ?? "editing"}
      data-drop-target={data.dropTarget || undefined}
      className={cn(
        "h-full rounded-xl border px-3 py-2 text-xs text-card-foreground shadow-xs",
        container ? "min-h-full border-dashed border-border bg-muted/40" : "h-20 w-56 bg-card",
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
              <span id={`${id}-errors`}>{data.errors.join("; ")}</span>
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="ml-auto text-3xs text-muted-foreground">{data.step.kind}</span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-3xs text-muted-foreground",
          data.step.kind === "command" && "font-mono",
        )}
      >
        {data.step.kind === "agent"
          ? `${data.step.model?.model || "Inherits model"} · ${data.step.prompt.split("\n")[0]}`
          : data.step.kind === "command"
            ? data.step.command.split("\n")[0]
            : data.step.kind === "approval"
              ? data.step.prompt.split("\n")[0] || "Approve or reject + comment"
              : data.step.kind === "loop"
                ? `Up to ${data.step.maxIterations} iterations`
                : `Over ${data.step.over} · ×${data.step.concurrency ?? 1}`}
      </p>
      {status && (
        <div className="mt-1 flex items-center gap-2">
          <FlowStepStatus status={status} />
          {count && count.total > 1 && (
            <span className="text-3xs text-muted-foreground">
              {count.succeeded}/{count.total} succeeded
            </span>
          )}
        </div>
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the external canvas viewport above the overlay inspector
  useEffect(() => {
    if (selectedX === undefined || selectedY === undefined || !wrapper.current) return;
    const zoom = getViewport().zoom;
    void setCenter(selectedX + 112, selectedY + 40 + (wrapper.current.clientHeight * 0.22) / zoom, {
      zoom,
    });
  }, [selectedX, selectedY, setCenter, getViewport]);
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
  return (
    <FlowRunContext value={currentRun.statuses}>
      <FlowCountsContext value={currentRun.counts}>
        <div
          ref={wrapper}
          className="flow-canvas @container h-full"
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropParent(null);
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
            minZoom={0.1}
            maxZoom={1.6}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            edgesReconnectable={false}
            deleteKeyCode={null}
            onNodeClick={(_, node) => onSelectStep(node.id)}
            onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
            onNodesChange={(changes) => {
              const selected = changes.find(
                (change) => change.type === "select" && change.selected,
              );
              if (selected?.type === "select") onSelectStep(selected.id);
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
            <Background gap={18} size={1} />
            <Controls showInteractive={false} position="top-right" />
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
