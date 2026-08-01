import { useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ScopedThreadRef,
  WayfinderLint,
  WayfinderNode,
} from "@t3tools/contracts";
import { ChevronLeft, Focus, Map as MapIcon, TriangleAlert, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { wayfinderEnvironment } from "~/state/wayfinder";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { StarMapTicketDetail } from "./StarMapTicketDetail";
import {
  boundsFromPoints,
  clampCamera,
  panCameraBy,
  zoomCameraAt,
  type StarMapCamera,
} from "./starMapCamera";
import { buildStarMapGraph, type StarMapGraph, type StarMapGraphNode } from "./starMapGraph";
import {
  STAR_MAP_CAMERA_EASE_MS,
  STAR_MAP_CLICK_DRAG_TOLERANCE_PX,
  STAR_MAP_HIT_TOLERANCE_SCREEN_PX,
  cameraEaseProgress,
  cameraForNodeFocus,
  defaultStarMapView,
  hitTestStarMap,
  interpolateCamera,
  zoomFactorFromWheelDelta,
  type StarMapView,
} from "./starMapInteraction";
import { layoutStarMap } from "./starMapLayout";
import { StarMapRenderer, detectPrefersReducedMotion } from "./starMapRenderer";
import { initialStarMapPanelState, starMapPanelReducer } from "./StarMapPanel.logic";

export interface StarMapPanelProps {
  readonly environmentId: EnvironmentId;
  /**
   * Root the server reads `.plan` from. Callers pass
   * `thread.worktreePath ?? project.workspaceRoot`, the same root ticket
   * relative paths resolve against.
   */
  readonly cwd: string;
}

function ticketStatusText(node: WayfinderNode): string {
  const status = (() => {
    switch (node.status) {
      case "open":
        return "open";
      case "claimed":
        return node.claimedBy !== null ? `claimed by ${node.claimedBy}` : "claimed";
      case "resolved":
        return "resolved";
      case "out_of_scope":
        return "out of scope";
    }
  })();
  return node.isFrontier ? `${status} · frontier` : status;
}

/** Blockers that still block: resolved or ruled-out blockers no longer hold a ticket back. */
function unresolvedBlockers(graph: StarMapGraph, nodeId: string): StarMapGraphNode[] {
  const incoming = graph.incoming.get(nodeId);
  if (!incoming) return [];
  return incoming.blocks.flatMap((edge) => {
    const blocker = graph.nodeById.get(edge.from);
    if (!blocker || blocker.status === "resolved" || blocker.status === "out_of_scope") return [];
    return [blocker];
  });
}

function ticketAriaLabel(graph: StarMapGraph, node: StarMapGraphNode): string {
  const blockers = unresolvedBlockers(graph, node.id);
  const blockedBy =
    blockers.length > 0
      ? `, blocked by ${blockers.map((blocker) => blocker.label).join(", ")}`
      : "";
  return `${node.label}, ${ticketStatusText(node)}${blockedBy}`;
}

function LintList(props: { lints: ReadonlyArray<WayfinderLint> }) {
  return (
    <ul className="space-y-1">
      {props.lints.map((lint) => (
        <li
          // Lints have no id, but code plus scope plus message is unique per
          // snapshot and stable across republishes, so a repeated parse failure
          // keeps its list item instead of remounting.
          key={`${lint.code}:${lint.mapId ?? ""}:${lint.ticketId ?? ""}:${lint.message}`}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {lint.message}
        </li>
      ))}
    </ul>
  );
}

function NoMapEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <MapIcon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">No wayfinder map in this project</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        Wayfinder maps live in the project&apos;s .plan directory. Once one exists, its tickets and
        blockers show up here.
      </p>
    </div>
  );
}

function UnparseableMapEmptyState(props: { lints: ReadonlyArray<WayfinderLint> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">
      <TriangleAlert className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">A map was found but could not be parsed</p>
      <div className="w-full max-w-md">
        <LintList lints={props.lints} />
      </div>
    </div>
  );
}

/**
 * The accessible parallel view of the constellation (design decision 14).
 * Focus is a transient highlight: focusing an item highlights its star and
 * eases the camera to it; activating an item selects the ticket. Selection
 * also flows the other way — a star clicked on the canvas highlights and
 * scrolls to its list item here.
 */
function TicketList(props: {
  graph: StarMapGraph;
  selectedTicketId: string | null;
  onSelectTicket: (ticketId: string) => void;
  onFocusTicket: (ticketId: string | null) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const ordered = [...props.graph.nodes].sort(
    (left, right) => left.rank - right.rank || left.ordinal - right.ordinal,
  );

  useEffect(() => {
    if (props.selectedTicketId === null) return;
    listRef.current
      ?.querySelector(`[data-ticket-id="${CSS.escape(props.selectedTicketId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedTicketId]);

  return (
    <ul aria-label="Tickets" className="space-y-0.5 p-2" ref={listRef}>
      {ordered.map((node) => {
        const selected = node.id === props.selectedTicketId;
        return (
          <li key={node.id}>
            <button
              type="button"
              data-ticket-id={node.id}
              aria-label={ticketAriaLabel(props.graph, node)}
              aria-current={selected ? "true" : undefined}
              onClick={() => props.onSelectTicket(node.id)}
              onFocus={() => props.onFocusTicket(node.id)}
              onBlur={() => props.onFocusTicket(null)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60",
                selected && "bg-accent/60 ring-1 ring-ring/40",
              )}
            >
              <span className="w-7 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {node.ordinal}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{node.label}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {ticketStatusText(node)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function StarMapPanel(props: StarMapPanelProps) {
  const mapsQuery = useEnvironmentQuery(
    wayfinderEnvironment.maps({ environmentId: props.environmentId, input: { cwd: props.cwd } }),
  );
  const snapshot = mapsQuery.data;
  const [state, dispatch] = useReducer(starMapPanelReducer, initialStarMapPanelState);

  // The panel needs its thread's right-panel scope for two things: the
  // surface-active gate below and the ticket detail's open-as-file action.
  // ChatView does not pass a ref down, so resolve it from the route params —
  // the same pattern CommandPalette uses — with draft sessions resolved to
  // their pre-allocated thread ref.
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const threadRef = useMemo<ScopedThreadRef | null>(() => {
    if (routeTarget?.kind === "server") return routeTarget.threadRef;
    if (routeTarget?.kind === "draft" && draftSession !== null) {
      return scopeThreadRef(draftSession.environmentId, draftSession.threadId);
    }
    return null;
  }, [routeTarget, draftSession]);

  // The surface-active hard stop. RightPanelSheet mounts its popup with
  // keepMounted, so "not visible" is not necessarily "unmounted" — tell the
  // engine whether this thread's map surface is the active one. With today's
  // ChatView wiring an inactive surface also unmounts (destroy() covers it),
  // but this gate is what keeps the loop stopped if the panel ever stays
  // mounted while hidden; fail open when the thread ref is unknown, because a
  // mounted panel is the active surface in every wiring that renders it.
  const mapSurfaceActive = useRightPanelStore((storeState) =>
    threadRef !== null ? selectActiveRightPanel(storeState.byThreadKey, threadRef) === "map" : true,
  );

  // View (map/list): the user's toggle wins; until they touch it the view
  // follows the panel width and the reduced-motion preference, so resizing
  // below the narrow threshold falls back to the list on its own.
  const panelRootRef = useRef<HTMLDivElement>(null);
  const [containerWidthPx, setContainerWidthPx] = useState(0);
  const [prefersReducedMotion] = useState(() => detectPrefersReducedMotion());
  const [viewOverride, setViewOverride] = useState<StarMapView | null>(null);
  const view = viewOverride ?? defaultStarMapView({ containerWidthPx, prefersReducedMotion });

  useLayoutEffect(() => {
    const root = panelRootRef.current;
    if (root === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setContainerWidthPx(entry.contentRect.width);
    });
    observer.observe(root);
    setContainerWidthPx(root.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (snapshot !== null) dispatch({ type: "syncSnapshot", snapshot });
  }, [snapshot]);

  const selectedMap = snapshot?.maps.find((map) => map.id === state.selectedMapId) ?? null;
  const graph = useMemo(
    () => (selectedMap !== null ? buildStarMapGraph(selectedMap) : null),
    [selectedMap],
  );
  const graphRevision = graph?.revision ?? null;
  const layout = useMemo(
    () => (graph !== null ? layoutStarMap(graph) : null),
    // 7.7: keyed on the graph's content revision string, NOT on graph identity.
    // A snapshot that changes only statuses or labels produces a new graph
    // object with the SAME revision, and the ~300-iteration solver must not
    // re-run; panel resize never reaches this memo at all — the camera adapts.
    [graphRevision],
  );
  const selectedNode =
    state.selectedTicket !== null && graph !== null
      ? (graph.nodeById.get(state.selectedTicket) ?? null)
      : null;

  // List focus is a transient canvas highlight; selection is the persistent
  // one. Focus wins while it lasts so keyboard traversal glides the camera.
  const [focusedTicketId, setFocusedTicketId] = useState<string | null>(null);
  useEffect(() => setFocusedTicketId(null), [state.selectedMapId]);
  const canvasSelection = focusedTicketId ?? state.selectedTicket;

  const canvasHostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<StarMapRenderer | null>(null);
  // Latest-layout ref so the native pointer handlers below always read the
  // current positions without re-registering on every snapshot.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Camera survives Map/List toggles, per map — the toggle must not teleport.
  const cameraStashRef = useRef<{ mapId: string; camera: StarMapCamera } | null>(null);
  const selectedMapId = state.selectedMapId;

  // 8.8: engine lifecycle plus pan/zoom input. The engine is created once per
  // (view, selected map) entry; graph, layout, selection, and the surface
  // gate flow through the sync effects that follow, so a status-only snapshot
  // never rebuilds the canvas or loses the camera.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (view !== "map" || selectedMapId === null || host === null) return;
    const stash = cameraStashRef.current;
    const stashedCamera =
      stash !== null && stash.mapId === selectedMapId ? stash.camera : undefined;
    const renderer = new StarMapRenderer({
      container: host,
      graph,
      layout,
      ...(stashedCamera !== undefined ? { camera: stashedCamera } : {}),
      selection: canvasSelection,
      surfaceActive: mapSurfaceActive,
    });
    renderer.start();
    rendererRef.current = renderer;

    const canvas = renderer.canvas;
    const contentBounds = () =>
      layoutRef.current !== null
        ? boundsFromPoints(layoutRef.current.positions)
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const clampToContent = (camera: StarMapCamera) =>
      clampCamera(camera, contentBounds(), renderer.getViewport());

    // NATIVE listener with { passive: false } — React's synthetic onWheel is
    // registered passively at the root, so preventDefault() there is a silent
    // no-op and the page would scroll under the zoom gesture. Attach directly
    // to renderer.canvas. Precedent: MessagesTimeline.tsx:606.
    const onWheel = (event: WheelEvent) => {
      const factor = zoomFactorFromWheelDelta(event);
      if (factor === 1) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const viewport = renderer.getViewport();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      renderer.setCamera(
        clampToContent(zoomCameraAt(renderer.getCamera(), viewport, anchor, factor)),
      );
      renderer.noteInteraction();
    };

    let drag: {
      pointerId: number;
      lastX: number;
      lastY: number;
      totalMove: number;
    } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || drag !== null) return;
      drag = {
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
        totalMove: 0,
      };
      canvas.setPointerCapture(event.pointerId);
      renderer.setGestureActive(true);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (drag === null) {
        // Nothing on a canvas says "this is clickable", so the cursor has to.
        // Hover hit-testing uses the same tolerance as the click, so what looks
        // hittable and what is hittable cannot drift apart.
        const hoverLayout = layoutRef.current;
        if (hoverLayout === null) return;
        const hoverRect = canvas.getBoundingClientRect();
        const hovered = hitTestStarMap(
          hoverLayout,
          renderer.toWorld({
            x: event.clientX - hoverRect.left,
            y: event.clientY - hoverRect.top,
          }),
          STAR_MAP_HIT_TOLERANCE_SCREEN_PX / renderer.getCamera().scale,
        );
        canvas.style.cursor = hovered === null ? "grab" : "pointer";
        return;
      }
      if (event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.totalMove += Math.hypot(dx, dy);
      // Below the click tolerance this might still be a selection, not a pan.
      if (drag.totalMove < STAR_MAP_CLICK_DRAG_TOLERANCE_PX) return;
      renderer.setCamera(clampToContent(panCameraBy(renderer.getCamera(), dx, dy)));
      renderer.noteInteraction();
    };
    const finishDrag = (event: PointerEvent, cancelled: boolean) => {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      const wasClick = !cancelled && drag.totalMove < STAR_MAP_CLICK_DRAG_TOLERANCE_PX;
      drag = null;
      renderer.setGestureActive(false);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!wasClick) return;
      const currentLayout = layoutRef.current;
      if (currentLayout === null) return;
      const rect = canvas.getBoundingClientRect();
      const camera = renderer.getCamera();
      const world = renderer.toWorld({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      const hit = hitTestStarMap(
        currentLayout,
        world,
        STAR_MAP_HIT_TOLERANCE_SCREEN_PX / camera.scale,
      );
      if (hit !== null) dispatch({ type: "selectTicket", ticketId: hit });
    };
    const onPointerUp = (event: PointerEvent) => finishDrag(event, false);
    const onPointerCancel = (event: PointerEvent) => finishDrag(event, true);

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);

    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      cameraStashRef.current = { mapId: selectedMapId, camera: renderer.getCamera() };
      rendererRef.current = null;
      renderer.destroy();
    };
  }, [view, selectedMapId]);

  useEffect(() => {
    rendererRef.current?.setGraph(graph, layout);
  }, [graph, layout]);
  useEffect(() => {
    rendererRef.current?.setSelection(canvasSelection);
  }, [canvasSelection]);
  useEffect(() => {
    rendererRef.current?.setSurfaceActive(mapSurfaceActive);
  }, [mapSurfaceActive]);

  // 8.9: eased camera move to the selected/focused star. Reduced motion jumps
  // straight there — the engine renders a single static frame either way.
  const easeRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (easeRafRef.current !== null) {
      cancelAnimationFrame(easeRafRef.current);
      easeRafRef.current = null;
    }
    const renderer = rendererRef.current;
    const currentLayout = layoutRef.current;
    if (renderer === null || currentLayout === null || canvasSelection === null) return;
    const target = cameraForNodeFocus(currentLayout, canvasSelection, renderer.getCamera());
    if (target === null) return;
    if (renderer.reducedMotion) {
      renderer.setCamera(target);
      return;
    }
    const from = renderer.getCamera();
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = cameraEaseProgress(now - startedAt, STAR_MAP_CAMERA_EASE_MS);
      renderer.setCamera(interpolateCamera(from, target, progress));
      renderer.noteInteraction();
      easeRafRef.current = progress < 1 ? requestAnimationFrame(step) : null;
    };
    easeRafRef.current = requestAnimationFrame(step);
    return () => {
      if (easeRafRef.current !== null) {
        cancelAnimationFrame(easeRafRef.current);
        easeRafRef.current = null;
      }
    };
  }, [canvasSelection]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || state.level === "maps") return;
    // Escape pops one navigation level instead of closing the panel.
    event.stopPropagation();
    dispatch({ type: "escape" });
  };

  let headerTitle = "Maps";
  let headerMeta: string | null =
    snapshot !== null
      ? `${snapshot.maps.length} ${snapshot.maps.length === 1 ? "map" : "maps"}`
      : null;
  if (state.level !== "maps" && selectedMap !== null) {
    headerTitle = selectedMap.title;
    headerMeta = `${selectedMap.counts.frontier} frontier · ${selectedMap.counts.open} open · ${selectedMap.counts.resolved} resolved`;
  }
  if (state.level === "ticket" && selectedNode !== null) {
    headerTitle = selectedNode.label;
    headerMeta = ticketStatusText(selectedNode);
  }

  const hasUsableNodes = snapshot?.maps.some((map) => map.nodes.length > 0) ?? false;
  const lints = snapshot?.lints ?? [];
  // Scoped to the open map, because "found a map but could not parse it" is a
  // per-map answer. A snapshot-wide check hides the broken map behind any
  // sibling that parsed, which is exactly when the user most needs to see it.
  const selectedMapLints =
    selectedMap !== null ? lints.filter((lint) => lint.mapId === selectedMap.id) : [];
  // Warnings belong where they are actionable: every map's warnings on the map
  // list, and only its own once a map is open. Carrying a sibling map's parse
  // failure into an unrelated map reads as "this map is broken" and is the
  // fastest way to make the whole panel look untrustworthy.
  const visibleLints = state.level === "maps" ? lints : selectedMapLints;

  let body: React.ReactNode;
  if (snapshot === null) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {mapsQuery.error !== null ? (
          <p className="text-xs leading-relaxed text-destructive">{mapsQuery.error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading maps…</p>
        )}
      </div>
    );
  } else if (snapshot.maps.length === 0 && lints.length === 0) {
    body = <NoMapEmptyState />;
  } else if (!hasUsableNodes && lints.length > 0) {
    body = <UnparseableMapEmptyState lints={lints} />;
  } else if (
    state.level !== "maps" &&
    selectedMap !== null &&
    selectedMap.nodes.length === 0 &&
    selectedMapLints.length > 0
  ) {
    body = <UnparseableMapEmptyState lints={selectedMapLints} />;
  } else if (state.level !== "maps" && selectedMap !== null && graph !== null) {
    // The ticket level renders the detail INSTEAD of the map below the split
    // breakpoint and NEXT to it above — decided by the @container rules keyed
    // on data-level (8.11), so PreviewPanelShell's explicit pixel width is
    // what matters, never the viewport.
    const detailNode = state.level === "ticket" ? selectedNode : null;
    const ticketList = (
      <TicketList
        graph={graph}
        selectedTicketId={state.selectedTicket}
        onSelectTicket={(ticketId) => dispatch({ type: "selectTicket", ticketId })}
        onFocusTicket={setFocusedTicketId}
      />
    );
    body = (
      <div data-star-map-container="" className="flex min-h-0 flex-1 flex-col">
        <div
          data-star-map-split=""
          data-level={detailNode !== null ? "ticket" : "map"}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div data-star-map-mapside="" className="flex min-h-0 flex-1 flex-col">
            {view === "map" ? (
              <>
                {/* Collapsed and above the map: the constellation is the point of
                    this view, so the list sits out of the way until asked for.
                    It stays in the DOM either way — it is the keyboard and
                    screen-reader path to the same tickets, not a fallback. */}
                <details className="shrink-0 border-b border-border/60">
                  <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                    {graph.nodes.length} {graph.nodes.length === 1 ? "ticket" : "tickets"}
                  </summary>
                  <div className="max-h-64 overflow-y-auto">{ticketList}</div>
                </details>
                <div className="relative min-h-0 flex-1">
                  <div
                    aria-hidden="true"
                    data-star-map-canvas=""
                    ref={canvasHostRef}
                    className="absolute inset-0"
                  />
                  <button
                    type="button"
                    aria-label="Reset map view"
                    title="Reset map view"
                    onClick={() => rendererRef.current?.fitToContent()}
                    className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground backdrop-blur-xs hover:text-foreground"
                  >
                    <Focus className="size-4" aria-hidden />
                  </button>
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">{ticketList}</div>
            )}
          </div>
          {detailNode !== null ? (
            <div data-star-map-detail="" className="flex min-h-0 flex-1 flex-col">
              <StarMapTicketDetail
                environmentId={props.environmentId}
                cwd={props.cwd}
                graph={graph}
                node={detailNode}
                threadRef={threadRef}
                onSelectTicket={(ticketId) => dispatch({ type: "selectTicket", ticketId })}
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  } else {
    body = (
      <ul aria-label="Maps" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {snapshot.maps.map((map) => (
          <li key={map.id}>
            <button
              type="button"
              aria-label={`${map.title}, ${map.counts.total} tickets, ${map.counts.frontier} frontier`}
              onClick={() => dispatch({ type: "selectMap", mapId: map.id })}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent/60"
            >
              <span className="text-sm font-medium text-foreground">{map.title}</span>
              <span className="text-xs text-muted-foreground">
                {map.counts.total} tickets · {map.counts.frontier} frontier · {map.counts.resolved}{" "}
                resolved
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-star-map-panel=""
      ref={panelRootRef}
      onKeyDown={handleKeyDown}
    >
      <div className="surface-subheader gap-2 px-2" data-surface-subheader>
        {state.level !== "maps" ? (
          <button
            type="button"
            aria-label={state.level === "ticket" ? "Back to map" : "Back to maps"}
            onClick={() => dispatch({ type: "back" })}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded-md pl-0.5 pr-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            Back
          </button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {headerTitle}
        </h2>
        {headerMeta !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground">{headerMeta}</span>
        ) : null}
        {state.level === "map" && selectedMap !== null ? (
          <div
            role="group"
            aria-label="Star map view"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 p-0.5"
          >
            {(["map", "list"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setViewOverride(option)}
                className={cn(
                  "h-5 rounded-sm px-2 text-xs capitalize",
                  view === option
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {state.notice === "map-removed" ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            The selected map was removed from disk.
          </p>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dispatch({ type: "dismissNotice" })}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {visibleLints.length > 0 && hasUsableNodes ? (
        <details className="shrink-0 border-b border-border/60 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            <TriangleAlert className="mr-1 inline size-3.5" aria-hidden />
            {visibleLints.length} map {visibleLints.length === 1 ? "warning" : "warnings"}
          </summary>
          <div className="mt-1">
            <LintList lints={visibleLints} />
          </div>
        </details>
      ) : null}
      {body}
    </div>
  );
}
