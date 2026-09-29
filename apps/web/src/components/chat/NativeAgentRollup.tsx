import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  deriveNativeAgentRollup,
  type NativeAgentRollupGroup,
} from "@t3tools/client-runtime/state/native-agent-rollup";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentId, ScopedThreadRef, ServerProvider, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { NativeAgentOutcomeSummary } from "./NativeAgentOutcomeSummary";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { SubagentTimelineLink } from "./V2LifecycleRow";

/** A bounded native roster in the thread card, alongside V2's complete lineage. */
export function NativeAgentRollup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const agents = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (thread) => thread?.projection.subagents,
  );
  const runs = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (thread) => thread?.projection.runs,
  );
  const rollup = useMemo(
    () => deriveNativeAgentRollup({ subagents: agents ?? [], runs: runs ?? [] }),
    [agents, runs],
  );
  const providers = useServerConfigs().get(props.environmentId)?.providers ?? [];
  const navigate = useNavigate();
  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };
  if (rollup.agentCount === 0) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-native-agents-heading" title="Turn agents">
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto overscroll-contain">
        {rollup.groups.map((group) => (
          <NativeAgentTurn
            key={`${scopedThreadKey(ref)}:${group.key}`}
            group={group}
            parentRef={ref}
            providers={providers}
            onOpenThread={openThread}
          />
        ))}
      </div>
      {rollup.hiddenSettledCount > 0 ? (
        <p className="px-1.5 pt-2 text-3xs text-muted-foreground">
          {rollup.hiddenSettledCount} older settled agents remain in the transcript.
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}

function NativeAgentTurn(props: {
  readonly group: NativeAgentRollupGroup;
  readonly parentRef: ScopedThreadRef;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? props.group.expandedByDefault;
  return (
    <div className="rounded-lg border border-border/60 bg-card/30">
      <Collapsible open={expanded} onOpenChange={setOverride}>
        <CollapsibleTrigger
          render={<button type="button" className="flex w-full items-center gap-2 p-2 text-left" />}
          aria-description={props.group.summary.label}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">{props.group.label}</span>
            <NativeAgentOutcomeSummary agents={props.group.agents} />
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          {expanded
            ? props.group.agents.map((agent) => (
                <SubagentTimelineLink
                  key={agent.id}
                  parentRef={props.parentRef}
                  subagentId={agent.id}
                  driver={agent.driver}
                  provider={props.providers.find(
                    (provider) => provider.instanceId === agent.providerInstanceId,
                  )}
                  title={formatSubagentDisplayTitle(
                    agent.title?.trim() || agent.prompt.trim().slice(0, 80) || "Subagent",
                  )}
                  status={agent.status}
                  result={agent.result}
                  progress={agent.progress}
                  startedAt={agent.startedAt}
                  completedAt={agent.completedAt}
                  threadId={agent.childThreadId}
                  onOpenThread={props.onOpenThread}
                />
              ))
            : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
