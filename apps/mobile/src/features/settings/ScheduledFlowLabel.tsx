import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { flowEnvironment } from "../../state/flows";
import { useEnvironmentQuery } from "../../state/query";

export function ScheduledFlowLabel({
  environmentId,
  task,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
}) {
  const definitions = useEnvironmentQuery(
    task.flow
      ? flowEnvironment.list({ environmentId, input: { projectId: task.projectId } })
      : null,
  );
  const flow = definitions.data?.flows.find((entry) => entry.flowId === task.flow?.flowId);
  return (
    <Text className="text-sm text-foreground-muted">
      Runs flow: {flow?.definition?.title ?? task.prompt.replace(/^Run flow: /, "")}
    </Text>
  );
}
