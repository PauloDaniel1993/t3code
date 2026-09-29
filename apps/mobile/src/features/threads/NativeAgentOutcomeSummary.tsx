import { nativeAgentOutcomeSummary } from "@t3tools/client-runtime/state/native-agent-rollup";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export function NativeAgentOutcomeSummary(props: {
  readonly agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}) {
  const summary = nativeAgentOutcomeSummary(props.agents);
  return (
    <View
      accessible
      accessibilityLabel={summary.label}
      className="flex-row flex-wrap items-center gap-2"
    >
      {summary.runningCount > 0 ? (
        <Text className="text-2xs text-adaptive-sky-600-400">{summary.runningCount} running</Text>
      ) : null}
      {summary.finishedCount > 0 ? (
        <Text className="text-2xs text-adaptive-emerald-600-400">
          ✓ {summary.finishedCount} finished
        </Text>
      ) : null}
      {summary.failedCount > 0 ? (
        <Text className="text-2xs text-adaptive-rose-600-400">× {summary.failedCount} failed</Text>
      ) : null}
      {summary.stoppedCount > 0 ? (
        <Text className="text-2xs text-foreground-muted">{summary.stoppedCount} stopped</Text>
      ) : null}
      {summary.idleCount > 0 ? (
        <Text className="text-2xs text-foreground-muted">{summary.idleCount} idle · resumable</Text>
      ) : null}
    </View>
  );
}
