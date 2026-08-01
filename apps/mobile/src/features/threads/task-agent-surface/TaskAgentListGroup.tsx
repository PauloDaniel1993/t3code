import { memo, useCallback, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
  type GestureResponderEvent,
} from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import {
  buildTaskAgentListEntries,
  buildTaskAgentDisclosureContent,
  taskAgentThreadRowsRenderEqual,
  type TaskAgentListEntry,
  type TaskAgentRollupThreadRowViewModel,
  type TaskAgentRowTone,
  type TaskAgentRowViewModel,
} from "./taskAgentSurface.logic";
import { getTaskAgentTheme, type TaskAgentTheme } from "./taskAgentTheme";

export interface TaskAgentListGroupProps {
  readonly row: TaskAgentRollupThreadRowViewModel;
  readonly expanded: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onPressRow: (row: TaskAgentRowViewModel) => void;
}

export interface TaskAgentDisclosureChipProps {
  readonly row: TaskAgentRollupThreadRowViewModel;
  readonly expanded: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onExpandedChange: (threadKey: string, expanded: boolean) => void;
  readonly onPressThread: () => void;
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

function counterColor(theme: TaskAgentTheme, tone: "success" | "danger"): string {
  return tone === "success" ? theme.text.success : theme.text.danger;
}

function TaskAgentEntityRow(props: {
  readonly entry: Extract<TaskAgentListEntry, { readonly kind: "entity-row" }>;
  readonly pressedBackgroundColor: string;
  readonly theme: TaskAgentTheme;
  readonly onPressRow: (row: TaskAgentRowViewModel) => void;
}) {
  const { entry, theme } = props;
  const row = entry.row;
  const color = toneColor(theme, row.tone);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      props.onPressRow(row);
    },
    [props, row],
  );

  return (
    <Pressable
      accessibilityHint={
        row.kind === "task" ? "Opens task details" : "Opens in-session agent details"
      }
      accessibilityLabel={`${row.title}, ${row.statusLine}${row.unread ? ", unread result" : ""}`}
      accessibilityRole="button"
      onPress={handlePress}
      style={({ pressed }) => [
        styles.entityRow,
        { paddingLeft: 2 + entry.nestingLevel * 18 },
        pressed ? { backgroundColor: props.pressedBackgroundColor } : null,
      ]}
    >
      <View style={styles.statusGlyphCell}>
        <Text style={[styles.statusGlyph, { color }]}>{row.glyph}</Text>
      </View>
      <View style={styles.entityBody}>
        <View style={styles.entityTitleLine}>
          <Text numberOfLines={1} style={[styles.entityTitle, { color: theme.text.foreground }]}>
            {row.title}
          </Text>
          {row.returnedToParent ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>↩ returned</Text>
          ) : null}
          {row.unread ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>Unread</Text>
          ) : null}
        </View>
        <Text style={[styles.statusLine, { color }]}>{row.statusLine}</Text>
      </View>
    </Pressable>
  );
}

function TaskAgentTurnRow(props: {
  readonly entry: Extract<TaskAgentListEntry, { readonly kind: "turn-row" }>;
  readonly pressedBackgroundColor: string;
  readonly theme: TaskAgentTheme;
  readonly onToggle: (turnKey: string, expanded: boolean) => void;
}) {
  const { entry, theme } = props;
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      props.onToggle(entry.turn.key, !entry.expanded);
    },
    [entry.expanded, entry.turn.key, props],
  );

  return (
    <Pressable
      accessibilityHint={
        entry.expanded ? "Collapses agents from this turn" : "Shows agents from this turn"
      }
      accessibilityLabel={`${entry.turn.label}, ${entry.turn.outcome.label}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: entry.expanded }}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.turnRow,
        { paddingLeft: 2 + entry.nestingLevel * 18 },
        pressed ? { backgroundColor: props.pressedBackgroundColor } : null,
      ]}
    >
      <View style={styles.statusGlyphCell}>
        <SymbolView
          name={entry.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={theme.text.dim}
        />
      </View>
      <View style={styles.turnBody}>
        <Text numberOfLines={1} style={[styles.turnTitle, { color: theme.text.muted }]}>
          {entry.turn.label}
        </Text>
        <View style={styles.turnMeta}>
          <Text style={[styles.turnOutcome, { color: theme.text.dim }]}>
            {entry.turn.outcome.label}
          </Text>
          {entry.turn.outcome.counters.map((counter) => (
            <Text
              key={counter.kind}
              style={[styles.counter, { color: counterColor(theme, counter.tone) }]}
            >
              {counter.label}
            </Text>
          ))}
          {entry.returnedToParent ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>↩ returned</Text>
          ) : null}
          {entry.unread ? (
            <Text style={[styles.marker, { color: theme.text.info }]}>Unread</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function TaskAgentDisclosureChipComponent(props: TaskAgentDisclosureChipProps) {
  const colorScheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = getTaskAgentTheme(colorScheme);
  const borderColor = useThemeColor("--color-border");
  const surfaceColor = props.pane === "sidebar" ? theme.card : theme.background;
  const interactiveSurfaceColor = props.pane === "sidebar" ? theme.background : theme.card;
  const content = buildTaskAgentDisclosureContent(props.row, props.expanded);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The chip sits above a sibling thread-open target. Stop the JS event at
      // the chip; the ancestor ReanimatedSwipeable remains the sole owner of
      // horizontal gesture recognition across the whole card.
      event.stopPropagation();
      props.onExpandedChange(props.row.key, !props.expanded);
    },
    [props.expanded, props.onExpandedChange, props.row.key],
  );

  return (
    <View style={styles.disclosureLine}>
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={props.onPressThread}
        style={StyleSheet.absoluteFill}
      />
      <Pressable
        accessibilityHint={content.accessibilityHint}
        accessibilityLabel={content.chipLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        hitSlop={8}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.disclosureChip,
          {
            backgroundColor: pressed ? surfaceColor : interactiveSurfaceColor,
            borderColor,
          },
        ]}
      >
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={10}
          tintColor={theme.text.muted}
        />
        <Text style={[styles.disclosureLabel, { color: theme.text.muted }]}>
          {content.chipLabel}
        </Text>
      </Pressable>
      {props.row.unread ? (
        <View
          accessibilityLabel="Unread task result"
          pointerEvents="none"
          style={styles.unreadMarker}
        >
          <View style={[styles.unreadDot, { backgroundColor: theme.text.info }]} />
          <Text style={[styles.unreadLabel, { color: theme.text.info }]}>Unread result</Text>
        </View>
      ) : null}
    </View>
  );
}

function TaskAgentListGroupComponent(props: TaskAgentListGroupProps) {
  const colorScheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = getTaskAgentTheme(colorScheme);
  const borderColor = useThemeColor("--color-border");
  const [turnExpansionOverrides, setTurnExpansionOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());

  const entries = useMemo(
    () => buildTaskAgentListEntries(props.row, turnExpansionOverrides),
    [props.row, turnExpansionOverrides],
  );
  const surfaceColor = props.pane === "sidebar" ? theme.card : theme.background;
  const interactiveSurfaceColor = props.pane === "sidebar" ? theme.background : theme.card;
  const disclosureContent = buildTaskAgentDisclosureContent(props.row, props.expanded);
  const handleToggleTurn = useCallback((turnKey: string, expanded: boolean) => {
    setTurnExpansionOverrides((current) => {
      const next = new Map(current);
      next.set(turnKey, expanded);
      return next;
    });
  }, []);

  if (!props.expanded) return null;

  return (
    <View collapsable={false} style={{ backgroundColor: surfaceColor }}>
      <View
        style={[
          styles.nestedRows,
          props.pane === "sidebar" ? styles.sidebarNestedRows : styles.screenNestedRows,
          {
            backgroundColor: surfaceColor,
            borderBottomColor: borderColor,
            borderLeftColor: borderColor,
          },
        ]}
      >
        {disclosureContent.expandedQualification ? (
          <Text style={[styles.expandedQualification, { color: theme.text.dim }]}>
            {disclosureContent.expandedQualification}
          </Text>
        ) : null}
        {entries.map((entry) =>
          entry.kind === "entity-row" ? (
            <TaskAgentEntityRow
              key={entry.key}
              entry={entry}
              onPressRow={props.onPressRow}
              pressedBackgroundColor={interactiveSurfaceColor}
              theme={theme}
            />
          ) : (
            <TaskAgentTurnRow
              key={entry.key}
              entry={entry}
              onToggle={handleToggleTurn}
              pressedBackgroundColor={interactiveSurfaceColor}
              theme={theme}
            />
          ),
        )}
      </View>
    </View>
  );
}

function taskAgentListGroupPropsEqual(
  previous: TaskAgentListGroupProps,
  next: TaskAgentListGroupProps,
): boolean {
  return (
    previous.expanded === next.expanded &&
    previous.pane === next.pane &&
    previous.onPressRow === next.onPressRow &&
    taskAgentThreadRowsRenderEqual(previous.row, next.row)
  );
}

function taskAgentDisclosureChipPropsEqual(
  previous: TaskAgentDisclosureChipProps,
  next: TaskAgentDisclosureChipProps,
): boolean {
  return (
    previous.expanded === next.expanded &&
    previous.pane === next.pane &&
    previous.onExpandedChange === next.onExpandedChange &&
    previous.onPressThread === next.onPressThread &&
    taskAgentThreadRowsRenderEqual(previous.row, next.row)
  );
}

export const TaskAgentDisclosureChip = memo(
  TaskAgentDisclosureChipComponent,
  taskAgentDisclosureChipPropsEqual,
);
export const TaskAgentListGroup = memo(TaskAgentListGroupComponent, taskAgentListGroupPropsEqual);

const styles = StyleSheet.create({
  disclosureLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    minHeight: 30,
  },
  disclosureChip: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  disclosureLabel: {
    fontSize: 11,
    fontWeight: "500",
  },
  unreadMarker: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
  },
  unreadDot: {
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  unreadLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  nestedRows: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingBottom: 6,
    paddingLeft: 12,
    paddingTop: 2,
  },
  expandedQualification: {
    fontSize: 11,
    lineHeight: 15,
    paddingBottom: 2,
    paddingLeft: 2,
    paddingRight: 8,
    paddingTop: 5,
  },
  screenNestedRows: {
    marginLeft: 22,
    marginRight: 14,
  },
  sidebarNestedRows: {
    marginLeft: 14,
    marginRight: 8,
  },
  entityRow: {
    alignItems: "flex-start",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    paddingBottom: 7,
    paddingRight: 8,
    paddingTop: 7,
  },
  statusGlyphCell: {
    alignItems: "center",
    height: 17,
    justifyContent: "center",
    width: 15,
  },
  statusGlyph: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 16,
  },
  entityBody: {
    flex: 1,
    minWidth: 0,
  },
  entityTitleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  entityTitle: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 17,
  },
  statusLine: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  marker: {
    fontSize: 11,
    fontWeight: "600",
  },
  turnRow: {
    alignItems: "flex-start",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    paddingBottom: 7,
    paddingRight: 8,
    paddingTop: 7,
  },
  turnBody: {
    flex: 1,
    minWidth: 0,
  },
  turnTitle: {
    fontSize: 12.5,
    lineHeight: 17,
  },
  turnMeta: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 1,
  },
  turnOutcome: {
    fontSize: 11,
    lineHeight: 15,
  },
  counter: {
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 15,
  },
});
