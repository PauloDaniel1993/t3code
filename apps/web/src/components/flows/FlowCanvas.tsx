import { createContext, useContext, useState } from "react";
import {
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
import { flowStepStatusById } from "@t3tools/client-runtime/flows";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { flowGraph, editLevel, findStep, newStep, type FlowNode } from "./flowGraph";
import { Choice } from "./FlowFields";
import { cn } from "../../lib/utils";

export const FlowRunContext = createContext<ReadonlyMap<string, FlowStepRunStatus>>(new Map());
export function FlowStepNode({ data, id }: NodeProps<FlowNode>) {
  const status = useContext(FlowRunContext).get(id);
  const container = data.step.kind === "loop" || data.step.kind === "map";
  return (
    <div
      data-step-status={status ?? "editing"}
      className={cn(
        "h-full rounded-lg border bg-card px-3 py-2 text-xs text-card-foreground",
        container ? "min-h-full border-dashed" : "min-w-40",
        status === "succeeded" && "border-success",
        (status === "failed" || status === "interrupted") && "border-destructive",
        (status === "running" || status === "waiting_report") && "border-primary",
        status === "waiting_approval" && "border-warning",
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="font-medium">{data.step.id}</div>
      <div className="text-muted-foreground">
        {data.step.kind} step{status ? ` · ${status.replaceAll("_", " ")}` : ""}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { step: FlowStepNode };
const kinds: ReadonlyArray<FlowStep["kind"]> = ["agent", "command", "approval", "loop", "map"];

export function FlowCanvas(props: {
  definition: FlowDefinition;
  snapshot: FlowRunSnapshot | null;
  locked: boolean;
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
  onChange,
  onSelectStep,
  onSelectEdge,
}: Parameters<typeof FlowCanvas>[0]) {
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition } = useReactFlow();
  const [parentId, setParentId] = useState<string | null>(null);
  const graph = flowGraph(definition);
  const containers = graph.nodes.filter(
    (node) => node.data.step.kind === "loop" || node.data.step.kind === "map",
  );
  const parent = parentId && findStep(definition.steps, parentId) ? parentId : null;
  const add = (kind: FlowStep["kind"], position?: { x: number; y: number }) => {
    if (locked) return;
    let index = 1;
    while (findStep(definition.steps, `${kind}-${index}`)) index++;
    const step = newStep(kind, `${kind}-${index}`);
    const next = editLevel(definition, parent, (level) => ({
      ...level,
      steps: [...level.steps, step],
    }));
    onChange(position ? { ...next, layout: { ...next.layout, [step.id]: position } } : next);
    onSelectStep(step.id);
  };
  return (
    <FlowRunContext value={snapshot ? flowStepStatusById(snapshot) : new Map()}>
      <div
        className="flow-canvas h-full min-h-72"
        onDragOver={(event) => {
          if (!locked) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const kind = kinds.find(
            (candidate) => candidate === event.dataTransfer.getData("application/t3-flow-step"),
          );
          if (kind) {
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            let ancestor = graph.nodes.find((node) => node.id === parent);
            const offset = { x: 0, y: 0 };
            while (ancestor) {
              offset.x += ancestor.position.x;
              offset.y += ancestor.position.y;
              const parentId = ancestor.parentId;
              ancestor = graph.nodes.find((node) => node.id === parentId);
            }
            add(kind, { x: position.x - offset.x, y: position.y - offset.y });
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
            if (locked) return;
            const layout = { ...definition.layout };
            let changed = false;
            for (const change of changes)
              if (change.type === "position" && change.position) {
                layout[change.id] = change.position;
                changed = true;
              }
            if (changed) onChange({ ...definition, layout });
          }}
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
          <Background />
          <Controls showInteractive={false} position="top-right" />
          {!locked && (
            <Panel position="top-left">
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-xs shadow">
                <Choice
                  label="Add steps to"
                  value={parent ?? "Flow"}
                  values={["Flow", ...containers.map((node) => node.id)]}
                  onChange={(value) => setParentId(value === "Flow" ? null : value)}
                />
                {kinds.map((kind) => (
                  <div
                    key={kind}
                    draggable
                    onDragStart={(event) =>
                      event.dataTransfer.setData("application/t3-flow-step", kind)
                    }
                  >
                    <Button variant="ghost" size="xs" onClick={() => add(kind)}>
                      + {kind} step
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </FlowRunContext>
  );
}
