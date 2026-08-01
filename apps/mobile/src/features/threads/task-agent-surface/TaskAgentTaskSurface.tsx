import { memo, useCallback, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { TaskAgentRowTone, TaskAgentRowViewModel } from "./taskAgentSurface.logic";
import type {
  TaskAgentTaskSurfacePresentation,
  TaskAgentTaskTurnViewModel,
} from "./taskAgentTaskSurface.logic";
import { getTaskAgentTheme, type TaskAgentTheme } from "./taskAgentTheme";

export interface TaskAgentTaskSurfaceProps {
  readonly presentation: TaskAgentTaskSurfacePresentation;
  /** Lets the owning LegendList suspend end pinning before measured content changes height. */
  readonly onBeforeDisclosureToggle?: () => void;
}

function toneColor(theme: TaskAgentTheme, tone: TaskAgentRowTone): string {
  switch (tone) {
    case "active":
      return theme.text.info;
    case "success":
      return theme.text.success;
    case "danger":
      return theme.text.danger;
    case "cancelled":
      return theme.text.warn;
    case "neutral":
      return theme.text.dim;
  }
}

function TaskAgentEntityRow(props: {
  readonly backgroundColor: ColorValue;
  readonly borderColor: ColorValue;
  readonly row: TaskAgentRowViewModel;
  readonly theme: TaskAgentTheme;
}) {
  const { row, theme } = props;
  const statusColor = toneColor(theme, row.tone);
  const steeringReason = row.steering.kind === "unavailable" ? row.steering.reason : null;

  return (
    <View
      accessibilityLabel={`${row.title}, ${row.statusLine}${
        steeringReason === null ? "" : `. Steering unavailable. ${steeringReason}`
      }`}
      style={[
        styles.entityRow,
        { backgroundColor: props.backgroundColor, borderColor: props.borderColor },
      ]}
    >
      <View style={styles.glyphCell}>
        <Text style={[styles.glyph, { color: statusColor }]}>{row.glyph}</Text>
      </View>
      <View style={styles.entityBody}>
        <View style={styles.entityTitleLine}>
          <Text style={[styles.entityTitle, { color: theme.text.foreground }]}>{row.title}</Text>
          {row.returnedToParent ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>↩ returned</Text>
          ) : null}
          {row.unread ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>Unread</Text>
          ) : null}
        </View>
        <Text style={[styles.statusLine, { color: statusColor }]}>{row.statusLine}</Text>
        {row.elapsedLabel !== null ? (
          <Text style={[styles.elapsed, { color: theme.text.muted }]}>{row.elapsedLabel}</Text>
        ) : null}
        {steeringReason !== null ? (
          <View
            accessibilityRole="text"
            style={[styles.steeringRefusal, { backgroundColor: props.backgroundColor }]}
          >
            <Text style={[styles.steeringLabel, { color: theme.text.muted }]}>
              Steering unavailable
            </Text>
            <Text style={[styles.steeringReason, { color: theme.text.statedReason }]}>
              {steeringReason}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TaskAgentTurn(props: {
  readonly borderColor: ColorValue;
  readonly expanded: boolean;
  readonly theme: TaskAgentTheme;
  readonly turn: TaskAgentTaskTurnViewModel;
  readonly onToggle: (turnKey: string, expanded: boolean) => void;
}) {
  const { expanded, theme, turn } = props;
  const disclosureAction = turn.disclosure.availability.action;
  const handlePress = useCallback(() => {
    if (disclosureAction.kind === "toggle-turn") {
      props.onToggle(disclosureAction.turnKey, !expanded);
    }
  }, [disclosureAction, expanded, props]);

  return (
    <View
      style={[styles.turnCard, { backgroundColor: theme.card, borderColor: props.borderColor }]}
    >
      <Pressable
        accessibilityHint={
          expanded
            ? "Collapses agents from this turn"
            : turn.failureAccess.kind === "reachable"
              ? "Shows agents from this turn, including their failure reasons"
              : "Shows agents from this turn"
        }
        accessibilityLabel={`${turn.disclosure.label}, ${turn.row.outcome.label}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.turnHeader,
          { backgroundColor: pressed ? theme.background : theme.card },
        ]}
      >
        <View style={styles.turnChevron}>
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColor={theme.text.dim}
          />
        </View>
        <View style={styles.turnHeaderBody}>
          <Text style={[styles.turnTitle, { color: theme.text.muted }]}>{turn.row.label}</Text>
          <View style={styles.turnMeta}>
            <Text style={[styles.turnOutcome, { color: theme.text.dim }]}>
              {turn.row.outcome.label}
            </Text>
            {turn.row.outcome.counters.map((counter) => (
              <Text
                key={counter.kind}
                style={[
                  styles.counter,
                  {
                    color: counter.tone === "success" ? theme.text.success : theme.text.danger,
                  },
                ]}
              >
                {counter.label}
              </Text>
            ))}
          </View>
        </View>
      </Pressable>

      {expanded ? (
        <View style={[styles.agentRows, { borderTopColor: props.borderColor }]}>
          {turn.row.agents.map((agent) => (
            <TaskAgentEntityRow
              key={agent.id}
              backgroundColor={theme.background}
              borderColor={props.borderColor}
              row={agent}
              theme={theme}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TaskAgentTaskSurfaceComponent(props: TaskAgentTaskSurfaceProps) {
  const colorScheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = getTaskAgentTheme(colorScheme);
  const borderColor = useThemeColor("--color-border");
  const [turnExpansionOverrides, setTurnExpansionOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const { presentation } = props;

  const handleToggleTurn = useCallback(
    (turnKey: string, expanded: boolean) => {
      props.onBeforeDisclosureToggle?.();
      setTurnExpansionOverrides((current) => {
        const next = new Map(current);
        next.set(turnKey, expanded);
        return next;
      });
    },
    [props.onBeforeDisclosureToggle],
  );

  if (presentation.kind === "task-thread-surface-unavailable") {
    return (
      <View style={[styles.surface, { backgroundColor: theme.background }]}>
        <Text style={[styles.eyebrow, { color: theme.text.muted }]}>Task thread</Text>
        <View
          accessibilityLabel={`${presentation.title}. Task status unavailable. ${presentation.reason}`}
          style={[styles.unavailableCard, { backgroundColor: theme.card, borderColor }]}
        >
          <Text style={[styles.unavailableTitle, { color: theme.text.foreground }]}>
            {presentation.title}
          </Text>
          <Text style={[styles.unavailableStatus, { color: theme.text.dim }]}>
            Task status unavailable
          </Text>
          <Text style={[styles.unavailableReason, { color: theme.text.statedReason }]}>
            {presentation.reason}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.surface, { backgroundColor: theme.background }]}>
      <Text style={[styles.eyebrow, { color: theme.text.muted }]}>Task thread</Text>
      <TaskAgentEntityRow
        backgroundColor={theme.card}
        borderColor={borderColor}
        row={presentation.row}
        theme={theme}
      />

      <View style={styles.windowNote}>
        <Text style={[styles.windowLabel, { color: theme.text.muted }]}>
          {presentation.nativeAgentWindow.label}
        </Text>
        <Text style={[styles.windowDetail, { color: theme.text.statedReason }]}>
          {presentation.nativeAgentWindow.note}
        </Text>
      </View>

      <View style={styles.turnSection}>
        <Text style={[styles.sectionTitle, { color: theme.text.foreground }]}>Turn agents</Text>
        {presentation.turns.length === 0 ? (
          <Text style={[styles.emptyTurns, { color: theme.text.muted }]}>
            No provider-native agents are available in this bounded window.
          </Text>
        ) : (
          presentation.turns.map((turn) => (
            <TaskAgentTurn
              key={turn.row.key}
              borderColor={borderColor}
              expanded={turnExpansionOverrides.get(turn.row.key) ?? turn.row.expandedByDefault}
              onToggle={handleToggleTurn}
              theme={theme}
              turn={turn}
            />
          ))
        )}
      </View>
    </View>
  );
}

export const TaskAgentTaskSurface = memo(TaskAgentTaskSurfaceComponent);

const styles = StyleSheet.create({
  surface: {
    gap: 12,
    paddingBottom: 16,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.7,
    lineHeight: 17,
    textTransform: "uppercase",
  },
  entityRow: {
    alignItems: "flex-start",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  glyphCell: {
    alignItems: "center",
    height: 20,
    justifyContent: "center",
    width: 18,
  },
  glyph: {
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 18,
  },
  entityBody: {
    flex: 1,
    minWidth: 0,
  },
  entityTitleLine: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  entityTitle: {
    flexGrow: 1,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
    minWidth: 140,
  },
  marker: {
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 17,
  },
  statusLine: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  elapsed: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  steeringRefusal: {
    borderRadius: 10,
    gap: 3,
    marginTop: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  steeringLabel: {
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17,
  },
  steeringReason: {
    fontSize: 12,
    lineHeight: 17,
  },
  windowNote: {
    gap: 3,
    paddingHorizontal: 2,
  },
  windowLabel: {
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  windowDetail: {
    fontSize: 12,
    lineHeight: 17,
  },
  turnSection: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 19,
  },
  emptyTurns: {
    fontSize: 13,
    lineHeight: 19,
  },
  turnCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  turnHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  turnChevron: {
    alignItems: "center",
    height: 18,
    justifyContent: "center",
    width: 16,
  },
  turnHeaderBody: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  turnTitle: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  turnMeta: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
  turnOutcome: {
    fontSize: 12,
    lineHeight: 17,
  },
  counter: {
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17,
  },
  agentRows: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    padding: 10,
  },
  unavailableCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 5,
    padding: 14,
  },
  unavailableTitle: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
  },
  unavailableStatus: {
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  unavailableReason: {
    fontSize: 12,
    lineHeight: 17,
  },
});
