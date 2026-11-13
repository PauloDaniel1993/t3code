import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  flowStepRunList,
  latestStepAttempts,
  flowStepInstanceKey,
} from "@t3tools/client-runtime/flows";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  FlowRunSnapshot,
  FlowStepRunState,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { flowEnvironment } from "../../state/flows";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function FlowRunStatusChip({
  threadRef,
  projectId,
}: {
  threadRef: ScopedThreadRef;
  projectId: FlowRunSnapshot["summary"]["projectId"];
}) {
  const lookup = useEnvironmentQuery(
    flowEnvironment.runForThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const runs = useEnvironmentQuery(
    lookup.data?.role === "flow_run_thread"
      ? flowEnvironment.runs({ environmentId: threadRef.environmentId, input: { projectId } })
      : null,
  );
  const recent = runs.data?.runs.find((run) => run.id === lookup.data?.flowRunId);
  const older = useEnvironmentQuery(
    lookup.data?.role === "flow_run_thread" && runs.data && !recent
      ? flowEnvironment.run({
          environmentId: threadRef.environmentId,
          input: { flowRunId: lookup.data.flowRunId },
        })
      : null,
  );
  const summary = recent ?? older.data?.summary;
  return summary ? (
    <Text
      className="rounded bg-secondary px-2 text-xs text-foreground"
      accessibilityLabel={`Flow run ${summary.status.replaceAll("_", " ")}`}
    >
      {summary.status === "waiting_approval"
        ? "Needs approval"
        : summary.status.replaceAll("_", " ")}
    </Text>
  ) : null;
}

export function FlowRunCard({ threadRef }: { threadRef: ScopedThreadRef }) {
  const lookup = useEnvironmentQuery(
    flowEnvironment.runForThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const detail = useEnvironmentQuery(
    lookup.data
      ? flowEnvironment.run({
          environmentId: threadRef.environmentId,
          input: { flowRunId: lookup.data.flowRunId },
        })
      : null,
  );
  const openThread = useOpenLinkedThread();
  if (!lookup.data) return null;
  if (!detail.data)
    return <Text className="p-3 text-foreground-muted">{detail.error ?? "Loading flow run…"}</Text>;
  const snapshot = detail.data;
  if (lookup.data.role === "step_thread")
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          openThread({
            environmentId: threadRef.environmentId,
            threadId: snapshot.summary.flowRunThreadId,
          })
        }
      >
        <Text className="p-3 text-primary-text">
          Part of {snapshot.summary.flowTitle} · run {snapshot.summary.runNumber}
        </Text>
      </Pressable>
    );
  return <FlowRunDetails environmentId={threadRef.environmentId} snapshot={snapshot} />;
}

function FlowRunDetails({
  environmentId,
  snapshot,
}: {
  environmentId: EnvironmentId;
  snapshot: FlowRunSnapshot;
}) {
  const stop = useAtomCommand(flowEnvironment.stop);
  const resume = useAtomCommand(flowEnvironment.resume);
  const canStop = useAtomValue(flowEnvironment.stop.permissionAtom(environmentId));
  const canResume = useAtomValue(flowEnvironment.resume.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = snapshot.summary;
  const latest = latestStepAttempts(snapshot);
  const now = useVisibleSecondClock(
    snapshot.stepRuns.some((step) => step.startedAt !== null && step.finishedAt === null),
  );
  return (
    <View className="m-3 gap-2 rounded-xl border border-border-subtle bg-secondary p-3">
      <Text className="font-t3-medium text-foreground">
        {summary.flowTitle} · Flow run {summary.runNumber}
      </Text>
      <Text className="text-sm text-foreground-muted">{summary.status.replaceAll("_", " ")}</Text>
      <Text className="text-xs text-foreground-muted">
        Started: {summary.startedAt ?? "Not started"}
        {"\n"}Finished: {summary.finishedAt ?? "Not finished"}
        {"\n"}Base ref: {snapshot.baseRef ?? "Unavailable"}
      </Text>
      {summary.error ? (
        <Text className="text-danger-foreground">{summary.error.message}</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {(summary.status === "cancelled" && summary.startedAt !== null) ||
      ["starting", "running", "waiting_approval"].includes(summary.status) ? (
        <Button
          label={summary.status === "cancelled" ? "Resume" : "Stop"}
          disabled={busy || !(summary.status === "cancelled" ? canResume : canStop)}
          onPress={async () => {
            setBusy(true);
            setError(null);
            const command = summary.status === "cancelled" ? resume : stop;
            const result = await command({ environmentId, input: { flowRunId: summary.id } });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
              setError(String(squashAtomCommandFailure(result)));
            setBusy(false);
          }}
        />
      ) : null}
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Nested in the thread feed, which owns the header scroll view. */}
      <LegendList
        style={{ maxHeight: 360 }}
        nestedScrollEnabled
        data={flowStepRunList(snapshot)}
        extraData={{ environmentId, snapshot, now, latest }}
        estimatedItemSize={72}
        recycleItems={false}
        keyExtractor={(step) => step.id}
        renderItem={({ item }) => (
          <View style={{ paddingLeft: item.depth * 12 }}>
            <FlowStepRow
              environmentId={environmentId}
              snapshot={snapshot}
              step={item}
              now={now}
              label={item.scopeLabel}
              latest={latest.get(flowStepInstanceKey(item))?.id === item.id}
            />
          </View>
        )}
      />
    </View>
  );
}

function FlowStepRow({
  environmentId,
  snapshot,
  step,
  label,
  latest,
  now,
}: {
  environmentId: EnvironmentId;
  snapshot: FlowRunSnapshot;
  step: FlowStepRunState;
  label: string | null;
  latest: boolean;
  now: number;
}) {
  const openThread = useOpenLinkedThread();
  const retry = useAtomCommand(flowEnvironment.retryStep);
  const answer = useAtomCommand(flowEnvironment.answerApproval);
  const canRetry = useAtomValue(flowEnvironment.retryStep.permissionAtom(environmentId));
  const canAnswer = useAtomValue(flowEnvironment.answerApproval.permissionAtom(environmentId));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approval = snapshot.approvals.find(
    (entry) => entry.stepRunId === step.id && entry.decision === null,
  );
  const answerApproval = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const result = await answer({
      environmentId,
      input: {
        stepRunId: step.id,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  return (
    <View className="gap-2 border-t border-border-subtle py-3">
      <Pressable
        accessibilityRole="button"
        disabled={!step.threadId}
        onPress={() => {
          if (step.threadId) openThread({ environmentId, threadId: step.threadId });
        }}
      >
        <Text className="font-t3-medium text-foreground">
          {step.stepPath.at(-1)}
          {label ? ` · ${label}` : ""}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {step.status.replaceAll("_", " ")} · attempt {step.attempt} ·{" "}
          {step.startedAt
            ? formatDuration(
                Math.max(
                  0,
                  (step.finishedAt ? Date.parse(step.finishedAt) : now) -
                    Date.parse(step.startedAt),
                ),
              )
            : "Not started"}
        </Text>
      </Pressable>
      {step.error ? <Text className="text-danger-foreground">{step.error.message}</Text> : null}
      {latest &&
      ["failed", "interrupted"].includes(step.status) &&
      ["failed", "running"].includes(snapshot.summary.status) ? (
        <Button
          label="Retry"
          disabled={busy || !canRetry}
          onPress={async () => {
            setBusy(true);
            setError(null);
            const result = await retry({ environmentId, input: { stepRunId: step.id } });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
              setError(String(squashAtomCommandFailure(result)));
            setBusy(false);
          }}
        />
      ) : null}
      {approval && step.status === "waiting_approval" ? (
        <>
          <Text className="text-foreground">{approval.prompt}</Text>
          <TextInput
            accessibilityLabel="Approval comment (optional)"
            placeholder="Comment (optional)"
            className="rounded border border-border-subtle p-2 text-foreground"
            value={comment}
            onChangeText={setComment}
            multiline
            editable={!busy && canAnswer}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Approve"
              disabled={busy || !canAnswer}
              onPress={() => void answerApproval("approve")}
            />
            <Button
              label="Reject"
              tone="danger"
              disabled={busy || !canAnswer}
              onPress={() => void answerApproval("reject")}
            />
          </View>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
