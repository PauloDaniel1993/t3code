import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
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
  type TaskAgentPeekAction,
  type TaskPeekRouteParams,
} from "./task-agent-surface/taskAgentPeek.logic";
import { buildTaskAgentModel } from "./task-agent-surface/taskAgentModel";
import { buildTaskAgentSurfaceRows } from "./task-agent-surface/taskAgentSurface.logic";

type TaskPeekRouteScreenProps = StaticScreenProps<TaskPeekRouteParams>;

const MISSING_PEEK_TARGET_REASON =
  "The task or agent target was not supplied, so no other item was opened.";
const STALE_PEEK_TARGET_REASON =
  "This exact task or agent is not available in the current mobile snapshot.";

/**
 * A form-sheet route over the list. It resolves only the required route
 * identity and intentionally never substitutes another task or agent.
 */
export function TaskPeekRouteScreen(props: TaskPeekRouteScreenProps) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const { readState } = useTaskAgentReadState();
  const routeParams = props.route.params as TaskPeekRouteParams | undefined;
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
    () =>
      routeParams === undefined
        ? null
        : resolveTaskAgentPeekRoute({ surface, params: routeParams }),
    [routeParams, surface],
  );
  const peek = useMemo(
    () => (resolution === null ? null : buildTaskAgentPeek(resolution)),
    [resolution],
  );
  const handleClose = useCallback(() => navigation.goBack(), [navigation]);
  const handleAction = useCallback(
    (action: TaskAgentPeekAction) => {
      // Both sheet actions use the destination projected for this exact task;
      // no task id is reconstructed or defaulted at this forwarding boundary.
      navigation.navigate("Thread", action.destination.params);
    },
    [navigation],
  );

  if (peek === null) {
    return (
      <TaskAgentPeekUnavailableSheet
        onClose={handleClose}
        reason={routeParams === undefined ? MISSING_PEEK_TARGET_REASON : STALE_PEEK_TARGET_REASON}
      />
    );
  }

  return <TaskAgentPeekSheet onAction={handleAction} onClose={handleClose} peek={peek} />;
}
