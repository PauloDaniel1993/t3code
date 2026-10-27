import { useAtomValue } from "@effect/atom-react";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import type { NativeAgentRollupGroup } from "@t3tools/client-runtime/state/native-agent-rollup";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { SubagentRow } from "./SubagentRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeAgentOutcomeSummary } from "./NativeAgentOutcomeSummary";
import { useNativeAgentRollup } from "./use-native-agent-rollup";
import { deriveThreadAgentsSheetSections } from "./threadAgentsSheetSections";

import { useOpenThreadInspector } from "./thread-inspector-navigation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const openInspector = useOpenThreadInspector();
  const insets = useSafeAreaInsets();
  const turn = useThreadTurnSubagents(target);
  const turnRunStatus = useAtomValue(
    environmentThreadDetails.threadAtom(target),
    (thread) => thread?.projection.runs.find((run) => run.id === turn?.runId)?.status,
  );
  const rollup = useNativeAgentRollup(target);
  const { subagents, hasLiveAgent, nativeHistory, currentNativeAgents, hiddenHistoryCount } =
    deriveThreadAgentsSheetSections({ turn, turnRunStatus, rollup });

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    if (
      openInspector(target, {
        type: "thread",
        environmentId: target.environmentId,
        threadId: childThreadId,
      })
    )
      return;
    // Replace this leaf sheet so the child enters the workspace stack expected by Home's Back button.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {nativeHistory.length > 0 && subagents.length > 0 ? (
        <Text accessibilityRole="header" className="pt-4 font-t3-medium text-sm text-foreground">
          Current turn
        </Text>
      ) : null}
      {currentNativeAgents.length > 0 ? (
        <View className="gap-1 pt-4">
          <Text className="text-xs text-foreground-muted">Native agents</Text>
          <NativeAgentOutcomeSummary agents={currentNativeAgents} />
        </View>
      ) : null}
      {subagents.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No agents in this turn.
        </Text>
      ) : (
        subagents.map((subagent) => (
          <AgentRow
            key={subagent.id}
            subagent={subagent}
            environmentId={target.environmentId}
            tickSeconds={hasLiveAgent}
            onOpen={openChildThread}
          />
        ))
      )}
      {nativeHistory.length > 0 ? (
        <View className="gap-3 pt-5">
          <Text accessibilityRole="header" className="font-t3-medium text-sm text-foreground">
            Turn agents
          </Text>
          {nativeHistory.map((group) => (
            <NativeAgentTurn
              key={`${target.environmentId}:${target.threadId}:${group.key}`}
              group={group}
              environmentId={target.environmentId}
              onOpen={openChildThread}
            />
          ))}
        </View>
      ) : null}
      {hiddenHistoryCount > 0 ? (
        <Text className="pt-3 text-xs text-foreground-muted">
          {hiddenHistoryCount} older inactive agents remain in the transcript.
        </Text>
      ) : null}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // Plain formSheets lack stack headers; host one in a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function NativeAgentTurn(props: {
  readonly group: NativeAgentRollupGroup;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? props.group.expandedByDefault;
  return (
    <View className="rounded-xl border border-border bg-card px-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.group.label}, ${props.group.summary.label}`}
        accessibilityState={{ expanded }}
        onPress={() => setOverride(!expanded)}
        className="min-h-14 flex-row items-center gap-2 py-3"
      >
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">{props.group.label}</Text>
          <NativeAgentOutcomeSummary agents={props.group.agents} />
        </View>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-subtle"
        />
      </Pressable>
      {expanded
        ? props.group.agents.map((subagent) => (
            <AgentRow
              key={subagent.id}
              subagent={subagent}
              environmentId={props.environmentId}
              tickSeconds={props.group.summary.runningCount > 0}
              onOpen={props.onOpen}
            />
          ))
        : null}
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { subagent } = props;
  const childThreadId = subagent.childThreadId;

  const row = (
    <View className="border-b border-border py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        elapsed={<AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      />
    </View>
  );

  if (childThreadId === null) {
    return (
      <View
        accessible
        accessibilityHint="Provider-managed agent. Its work appears in the transcript."
      >
        {row}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isOrchestrationV2WorkActive(subagent.status);
  useEffect(() => {
    if (!tickSeconds || !running) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [running, tickSeconds]);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
