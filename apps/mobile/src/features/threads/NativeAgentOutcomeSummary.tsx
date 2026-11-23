import { nativeAgentOutcomeSummary } from "@t3tools/client-runtime/state/native-agent-rollup";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { T, Var } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function NativeAgentOutcomeSummary(props: {
  readonly agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}) {
  const summary = nativeAgentOutcomeSummary(props.agents);
  return (
    <View
      accessible
      accessibilityLabel={summary.label}
      className="flex-row flex-wrap items-center gap-x-2 gap-y-1"
    >
      {summary.runningCount > 0 ? (
        <Text numberOfLines={1} className="shrink-0 text-2xs text-adaptive-sky-600-400">
          <T>
            <Var>{summary.runningCount}</Var> running
          </T>
        </Text>
      ) : null}
      {summary.finishedCount > 0 ? (
        <Text numberOfLines={1} className="shrink-0 text-2xs text-adaptive-emerald-600-400">
          <T>
            ✓ <Var>{summary.finishedCount}</Var> finished
          </T>
        </Text>
      ) : null}
      {summary.failedCount > 0 ? (
        <Text numberOfLines={1} className="shrink-0 text-2xs text-adaptive-rose-600-400">
          <T>
            × <Var>{summary.failedCount}</Var> failed
          </T>
        </Text>
      ) : null}
      {summary.stoppedCount > 0 ? (
        <Text numberOfLines={1} className="shrink-0 text-2xs text-foreground-muted">
          <T>
            <Var>{summary.stoppedCount}</Var> stopped
          </T>
        </Text>
      ) : null}
      {summary.idleCount > 0 ? (
        <Text numberOfLines={1} className="shrink-0 text-2xs text-foreground-muted">
          <T>
            <Var>{summary.idleCount}</Var> idle · resumable
          </T>
        </Text>
      ) : null}
    </View>
  );
}
