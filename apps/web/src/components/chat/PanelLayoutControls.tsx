import {
  Globe2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  projectBrowserAvailable: boolean;
  projectBrowserOpen: boolean;
  projectBrowserTabCount: number;
  projectBrowserActive: boolean;
  projectBrowserShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
  onToggleProjectBrowser: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  projectBrowserAvailable,
  projectBrowserOpen,
  projectBrowserTabCount,
  projectBrowserActive,
  projectBrowserShortcutLabel,
  onToggleTerminal,
  onToggleRightPanel,
  onToggleProjectBrowser,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-3.5" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {terminalAvailable
            ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
            : "Terminal drawer is unavailable"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label="Toggle right panel"
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-3.5" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
            : "Right panel is unavailable"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="relative shrink-0 [-webkit-app-region:no-drag]"
              pressed={projectBrowserOpen}
              onPressedChange={onToggleProjectBrowser}
              aria-label="Toggle Project Browser"
              variant="ghost"
              size="sm"
              disabled={!projectBrowserAvailable}
            >
              <Globe2Icon className="size-3.5" />
              {projectBrowserTabCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-[8px] leading-3 text-primary-foreground">
                  {projectBrowserTabCount > 9 ? "9+" : projectBrowserTabCount}
                </span>
              ) : null}
              {projectBrowserActive ? (
                <span className="absolute bottom-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-emerald-500" />
              ) : null}
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {projectBrowserAvailable
            ? `Toggle Project Browser${projectBrowserShortcutLabel ? ` (${projectBrowserShortcutLabel})` : ""}`
            : "Project Browser is unavailable"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
