import { useCallback } from "react";
import { Pressable, ScrollView, StyleSheet, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { useThemeColor } from "../../../lib/useThemeColor";
import type {
  TaskAgentRowTone,
  TaskAgentRowViewModel,
  TaskAgentTurnRowViewModel,
} from "./taskAgentSurface.logic";
import {
  type TaskAgentPeekAction,
  type TaskAgentPeekControl,
  type TaskAgentPeekViewModel,
} from "./taskAgentPeek.logic";
import { getTaskAgentTheme, type TaskAgentTheme } from "./taskAgentTheme";

export interface TaskAgentPeekSheetProps {
  readonly peek: TaskAgentPeekViewModel;
  readonly onAction: (action: TaskAgentPeekAction) => void;
  readonly onClose: () => void;
}

export interface TaskAgentPeekUnavailableSheetProps {
  readonly reason: string;
  readonly onClose: () => void;
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

function failureReason(row: TaskAgentRowViewModel): string | null {
  if (row.failure === null) return null;
  return row.failure.kind === "task" ? row.failure.reason : row.failure.attribution.reason;
}

/** One renderer for both task and provider-native agent rows. */
function TaskAgentPeekRow(props: {
  readonly borderColor: ColorValue;
  readonly row: TaskAgentRowViewModel;
  readonly theme: TaskAgentTheme;
}) {
  const { row, theme } = props;
  const statusColor = toneColor(theme, row.tone);
  const reason = failureReason(row);

  return (
    <View
      accessibilityLabel={`${row.title}, ${row.statusLine}`}
      style={[styles.entityRow, { backgroundColor: theme.card, borderColor: props.borderColor }]}
    >
      <View style={styles.glyphCell}>
        <Text style={[styles.glyph, { color: statusColor }]}>{row.glyph}</Text>
      </View>
      <View style={styles.entityBody}>
        <View style={styles.titleLine}>
          <Text numberOfLines={2} style={[styles.entityTitle, { color: theme.text.foreground }]}>
            {row.title}
          </Text>
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
        {reason !== null ? (
          <Text style={[styles.failureReason, { color: theme.text.danger }]}>{reason}</Text>
        ) : null}
      </View>
    </View>
  );
}

function TaskAgentPeekTurn(props: {
  readonly borderColor: ColorValue;
  readonly theme: TaskAgentTheme;
  readonly turn: TaskAgentTurnRowViewModel;
}) {
  const { turn, theme } = props;

  return (
    <View style={[styles.turnSection, { borderColor: props.borderColor }]}>
      <View style={styles.turnHeader}>
        <View style={styles.turnHeaderText}>
          <Text style={[styles.turnTitle, { color: theme.text.muted }]}>{turn.label}</Text>
          <Text style={[styles.turnOutcome, { color: theme.text.dim }]}>{turn.outcome.label}</Text>
        </View>
        <View style={styles.counterRow}>
          {turn.outcome.counters.map((counter) => (
            <Text
              key={counter.kind}
              style={[
                styles.counter,
                { color: counter.tone === "success" ? theme.text.success : theme.text.danger },
              ]}
            >
              {counter.label}
            </Text>
          ))}
        </View>
      </View>
      <View style={styles.agentRows}>
        {turn.agents.map((agent) => (
          <TaskAgentPeekRow
            key={agent.id}
            borderColor={props.borderColor}
            row={agent}
            theme={theme}
          />
        ))}
      </View>
    </View>
  );
}

function TaskAgentPeekControlView(props: {
  readonly control: TaskAgentPeekControl;
  readonly onAction: (action: TaskAgentPeekAction) => void;
  readonly theme: TaskAgentTheme;
}) {
  const { control, theme } = props;
  const handlePress = useCallback(() => {
    if (control.availability.kind === "action") props.onAction(control.availability.action);
  }, [control.availability, props]);

  if (control.availability.kind === "unavailable") {
    return (
      <View
        accessibilityLabel={`${control.label}. ${control.availability.reason}`}
        accessibilityRole="text"
        style={[styles.unavailableControl, { backgroundColor: theme.card }]}
      >
        <Text style={[styles.controlLabel, { color: theme.text.muted }]}>{control.label}</Text>
        {/* This opaque card deliberately has no opacity multiplier. The stated
            reason token is contrast-verified on this exact card surface. */}
        <Text style={[styles.controlReason, { color: theme.text.statedReason }]}>
          {control.availability.reason}
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityHint="Performs this task action"
      accessibilityLabel={control.label}
      accessibilityRole="button"
      onPress={handlePress}
      style={({ pressed }) => [
        styles.actionControl,
        { backgroundColor: pressed ? theme.background : theme.card },
      ]}
    >
      <Text style={[styles.controlLabel, { color: theme.text.foreground }]}>{control.label}</Text>
    </Pressable>
  );
}

function PeekSheetChrome(props: {
  readonly children: React.ReactNode;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly theme: TaskAgentTheme;
  readonly title: string;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: props.theme.background }]}>
      <View style={styles.topBar}>
        <Text style={[styles.sheetTitle, { color: props.theme.text.foreground }]}>
          {props.title}
        </Text>
        <Pressable
          accessibilityLabel={props.closeLabel}
          accessibilityRole="button"
          hitSlop={8}
          onPress={props.onClose}
          style={({ pressed }) => [
            styles.closeButton,
            { backgroundColor: pressed ? props.theme.background : props.theme.card },
          ]}
        >
          <Text style={[styles.closeLabel, { color: props.theme.text.muted }]}>Close</Text>
        </Pressable>
      </View>
      {props.children}
    </View>
  );
}

export function TaskAgentPeekUnavailableSheet(props: TaskAgentPeekUnavailableSheetProps) {
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = getTaskAgentTheme(themeAppearance, themeId);

  return (
    <PeekSheetChrome
      closeLabel="Close peek"
      onClose={props.onClose}
      theme={theme}
      title="Peek unavailable"
    >
      <View style={styles.unavailableScreen}>
        <Text style={[styles.unavailableTitle, { color: theme.text.foreground }]}>
          Peek unavailable
        </Text>
        <Text style={[styles.unavailableDetail, { color: theme.text.statedReason }]}>
          {props.reason}
        </Text>
      </View>
    </PeekSheetChrome>
  );
}

export function TaskAgentPeekSheet(props: TaskAgentPeekSheetProps) {
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = getTaskAgentTheme(themeAppearance, themeId);
  const borderColor = useThemeColor("--color-border");
  const { peek } = props;

  return (
    <PeekSheetChrome
      closeLabel={peek.closeLabel}
      onClose={props.onClose}
      theme={theme}
      title={peek.title}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.scrollView}
      >
        <TaskAgentPeekRow borderColor={borderColor} row={peek.row} theme={theme} />

        <View style={styles.windowNote}>
          <Text style={[styles.windowLabel, { color: theme.text.muted }]}>
            {peek.nativeAgentWindow.label}
          </Text>
          <Text style={[styles.windowDetail, { color: theme.text.statedReason }]}>
            {peek.nativeAgentWindow.note}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text.foreground }]}>
            {peek.turnAgents.title}
          </Text>
          {peek.turnAgents.emptyMessage !== null ? (
            <Text style={[styles.emptyTurns, { color: theme.text.muted }]}>
              {peek.turnAgents.emptyMessage}
            </Text>
          ) : (
            peek.turns.map((turn) => (
              <TaskAgentPeekTurn
                key={turn.key}
                borderColor={borderColor}
                theme={theme}
                turn={turn}
              />
            ))
          )}
        </View>

        <View style={styles.controlList}>
          {peek.controls.map((control) => (
            <TaskAgentPeekControlView
              key={control.id}
              control={control}
              onAction={props.onAction}
              theme={theme}
            />
          ))}
        </View>
      </ScrollView>
    </PeekSheetChrome>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  closeButton: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  closeLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 20,
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
  titleLine: {
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
  failureReason: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
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
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  emptyTurns: {
    fontSize: 13,
    lineHeight: 19,
  },
  turnSection: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    overflow: "hidden",
    padding: 12,
  },
  turnHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  turnHeaderText: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  turnTitle: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  turnOutcome: {
    fontSize: 12,
    lineHeight: 17,
  },
  counterRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "flex-end",
  },
  counter: {
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17,
  },
  agentRows: {
    gap: 8,
  },
  controlList: {
    gap: 8,
    paddingBottom: 16,
  },
  actionControl: {
    borderRadius: 14,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  unavailableControl: {
    borderRadius: 14,
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  controlLabel: {
    fontSize: 13,
    fontWeight: "800",
    lineHeight: 18,
  },
  controlReason: {
    fontSize: 12,
    lineHeight: 17,
  },
  unavailableScreen: {
    flex: 1,
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  unavailableTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  unavailableDetail: {
    fontSize: 14,
    lineHeight: 20,
  },
});
