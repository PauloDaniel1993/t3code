import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { useTaskAgentReadState } from "../../state/use-task-agent-read-state";
import {
  TaskAgentPeekSheet,
  TaskAgentPeekUnavailableSheet,
} from "./task-agent-surface/TaskAgentPeekSheet";
import {
  buildTaskAgentPeek,
  resolveTaskAgentPeekRoute,
  resolveTaskPeekRoute,
  type TaskAgentPeekAction,
  type TaskAgentPeekResolution,
  type TaskPeekAgentRouteParams,
  type TaskPeekTaskRouteParams,
} from "./task-agent-surface/taskAgentPeek.logic";
import { buildTaskAgentModel } from "./task-agent-surface/taskAgentModel";
import {
  buildTaskAgentSurfaceRows,
  type TaskAgentSurfaceViewModel,
} from "./task-agent-surface/taskAgentSurface.logic";

type TaskPeekRouteScreenProps = StaticScreenProps<TaskPeekTaskRouteParams>;
type TaskAgentPeekRouteScreenProps = StaticScreenProps<TaskPeekAgentRouteParams>;

const STALE_PEEK_TARGET_REASON =
  "This exact task or agent is not available in the current mobile snapshot.";

type PeekResolver<TParams> = (input: {
  readonly surface: TaskAgentSurfaceViewModel;
  readonly params: TParams;
}) => TaskAgentPeekResolution | null;

/**
 * Shared form-sheet content. The route wrapper supplies a fully required,
 * route-specific identity; this component has no default target branch.
 */
function TaskAgentPeekRouteContent<TParams>(props: {
  readonly params: TParams;
  readonly resolve: PeekResolver<TParams>;
}) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const { readState, markThreadsVisited } = useTaskAgentReadState();
  const surface = useMemo(
    () =>
      buildTaskAgentSurfaceRows(
        buildTaskAgentModel({
          threads,
          readState,
          // This snapshot deliberately does not schedule a repainting clock.
          nowMs: Date.now(),
        }),
      ),
    [readState, threads],
  );
  const resolution = useMemo(
    () => props.resolve({ surface, params: props.params }),
    [props.params, props.resolve, surface],
  );
  const peek = useMemo(
    () => (resolution === null ? null : buildTaskAgentPeek(resolution)),
    [resolution],
  );
  const visitedTaskThreadId = resolution?.kind === "task" ? resolution.route.threadId : null;
  const visitedParentThreadId = resolution?.kind === "task" ? resolution.parentThreadId : null;

  useFocusEffect(
    useCallback(() => {
      if (visitedParentThreadId === null || visitedTaskThreadId === null) return;
      markThreadsVisited({
        parentThreadId: visitedParentThreadId,
        taskThreadId: visitedTaskThreadId,
        visitedAt: new Date().toISOString(),
      });
    }, [markThreadsVisited, visitedParentThreadId, visitedTaskThreadId]),
  );

  const handleClose = useCallback(() => navigation.goBack(), [navigation]);
  const handleAction = useCallback(
    (action: TaskAgentPeekAction) => {
      // The sheet action uses the destination projected for this exact task;
      // no task id is reconstructed or defaulted at this forwarding boundary.
      navigation.navigate("Thread", action.destination.params);
    },
    [navigation],
  );

  if (peek === null) {
    return (
      <TaskAgentPeekUnavailableSheet onClose={handleClose} reason={STALE_PEEK_TARGET_REASON} />
    );
  }

  return <TaskAgentPeekSheet onAction={handleAction} onClose={handleClose} peek={peek} />;
}

/** A task route carries the task's exact required thread id. */
export function TaskPeekRouteScreen(props: TaskPeekRouteScreenProps) {
  return <TaskAgentPeekRouteContent params={props.route.params} resolve={resolveTaskPeekRoute} />;
}

/** A native-agent route carries both its owner and exact required agent id. */
export function TaskAgentPeekRouteScreen(props: TaskAgentPeekRouteScreenProps) {
  return (
    <TaskAgentPeekRouteContent params={props.route.params} resolve={resolveTaskAgentPeekRoute} />
  );
}
