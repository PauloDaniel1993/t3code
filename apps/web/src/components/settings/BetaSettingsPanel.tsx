import { useEffect, useState } from "react";

import {
  MAX_THREAD_TASK_MAX_RUNNING,
  MAX_THREAD_TASK_MAX_TOTAL,
  MIN_THREAD_TASK_MAX_RUNNING,
  MIN_THREAD_TASK_MAX_TOTAL,
  resolveThreadTaskLimits,
  THREAD_TASK_TOTAL_PER_RUNNING,
} from "@t3tools/contracts";

import {
  useClientSettings,
  usePrimarySettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;

/**
 * Bounded integer field. A local draft lets the box be emptied mid-edit; the
 * setting only moves on a valid value and snaps back to the persisted one on
 * blur.
 *
 * With `onClear`, emptying the box is itself a commit — that is how a nullable
 * setting is returned to its derived default.
 */
function BoundedNumberInput({
  value,
  min,
  max,
  placeholder,
  label,
  onCommit,
  onClear,
}: {
  value: number | null;
  min: number;
  max: number;
  placeholder?: string;
  label: string;
  onCommit: (next: number) => void;
  onClear?: () => void;
}) {
  const persisted = value === null ? "" : String(value);
  const [draft, setDraft] = useState(persisted);
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  return (
    <Input
      type="number"
      min={min}
      max={max}
      className="w-full sm:w-24"
      value={draft}
      {...(placeholder === undefined ? {} : { placeholder })}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() === "") {
          onClear?.();
          return;
        }
        // Number(), not parseInt: "3.5" must be rejected rather than silently
        // truncated to a committed 3 while the field still shows 3.5.
        const parsed = Number(next);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(persisted)}
      aria-label={label}
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const sidebarAutoSettleAfterDays = useClientSettings(
    (settings) => settings.sidebarAutoSettleAfterDays,
  );
  const threadTasksEnabled = useClientSettings((settings) => settings.threadTasksEnabled);
  const updateSettings = useUpdateClientSettings();

  // The task caps are server settings: the decider enforces them, and that is
  // also the path an agent's own `task_create` takes.
  const threadTaskMaxRunning = usePrimarySettings((settings) => settings.threadTaskMaxRunning);
  const threadTaskMaxTotal = usePrimarySettings((settings) => settings.threadTaskMaxTotal);
  const updateServerSettings = useUpdatePrimarySettings();
  const resolvedLimits = resolveThreadTaskLimits({
    maxRunning: threadTaskMaxRunning,
    maxTotal: threadTaskMaxTotal,
  });

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Sidebar v2"
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title="Auto-settle inactive threads"
              description="Threads with no activity for this long settle automatically. Threads on merged or closed PRs always settle."
              control={
                <Switch
                  checked={sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <BoundedNumberInput
                    value={sidebarAutoSettleAfterDays}
                    min={AUTO_SETTLE_MIN_DAYS}
                    max={AUTO_SETTLE_MAX_DAYS}
                    label="Days of inactivity before auto-settle"
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
        <SettingsRow
          title="Thread tasks"
          description="Delegate work to a sub-thread that runs on its own and returns its results here, waking this thread when it finishes. You and the agent can both start one. Needs an up-to-date server. Turning this off hides the task surface — task threads stay in the sidebar as ordinary threads, and nothing is lost."
          control={
            <Switch
              checked={threadTasksEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ threadTasksEnabled: Boolean(checked) })
              }
              aria-label="Enable the thread tasks beta"
            />
          }
        />
        {threadTasksEnabled ? (
          <>
            <SettingsRow
              title="Tasks running at once"
              description={`How many tasks one thread may have queued or running at the same time. Creating one past the limit is refused until a slot frees up — the agent is told to wait or cancel. Between ${MIN_THREAD_TASK_MAX_RUNNING} and ${MAX_THREAD_TASK_MAX_RUNNING}; every running task is a full provider session, so raise it as far as your machine and your plan can carry.`}
              control={
                <BoundedNumberInput
                  value={threadTaskMaxRunning}
                  min={MIN_THREAD_TASK_MAX_RUNNING}
                  max={MAX_THREAD_TASK_MAX_RUNNING}
                  label="Tasks one thread can run at once"
                  onCommit={(next) => updateServerSettings({ threadTaskMaxRunning: next })}
                />
              }
            />
            <SettingsRow
              title="Tasks in total per thread"
              description={`How many tasks one thread may create over its whole life, counting finished and deleted ones. This is the backstop on a task waking its parent, which starts another task, and so on. Leave it empty to keep it at ${THREAD_TASK_TOTAL_PER_RUNNING}× the concurrent limit — currently ${resolvedLimits.maxTotal}.`}
              control={
                <BoundedNumberInput
                  value={threadTaskMaxTotal}
                  min={MIN_THREAD_TASK_MAX_TOTAL}
                  max={MAX_THREAD_TASK_MAX_TOTAL}
                  placeholder={String(resolvedLimits.maxTotal)}
                  label="Tasks one thread can create in total"
                  onCommit={(next) => updateServerSettings({ threadTaskMaxTotal: next })}
                  onClear={() => updateServerSettings({ threadTaskMaxTotal: null })}
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
