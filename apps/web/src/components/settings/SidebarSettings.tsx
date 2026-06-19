import {
  ArchiveIcon,
  ArchiveX,
  ArrowDownIcon,
  ArrowUpIcon,
  PanelLeftIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { type SidebarCategory } from "@t3tools/contracts/settings";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UNCATEGORIZED_CATEGORY_NAME } from "../../sidebarOrganization/categories";
import {
  REPOSITORY_GROUPING_LABEL,
  REPOSITORY_GROUPING_MODE_LABELS,
  describeRepositoryGroupingMode,
} from "../../sidebarOrganization/repositoryGrouping";
import {
  createSidebarOrganizationPatch,
  selectSidebarOrganization,
} from "../../sidebarOrganization/settings";
import {
  canResetSidebarOrganization,
  createSidebarCategoryFromSettings,
  deleteSidebarCategoryFromSettings,
  getSidebarSettingsCategories,
  hideSidebarCategoryFromSettings,
  renameSidebarCategoryFromSettings,
  reorderActiveSidebarCategoryByOffset,
  resetSidebarOrganizationFromSettings,
  unhideAllSidebarCategories,
  unhideSidebarCategoryFromSettings,
} from "./SidebarSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

interface EditableSidebarCategoryRowProps {
  readonly category: SidebarCategory;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onRename: (categoryId: string, nextName: string) => string | null;
  readonly onMove: (categoryId: string, offset: -1 | 1) => void;
  readonly onHide: (categoryId: string) => void;
  readonly onDelete: (categoryId: string) => void;
}

function EditableSidebarCategoryRow(props: EditableSidebarCategoryRowProps) {
  const { category, canMoveUp, canMoveDown, onRename, onMove, onHide, onDelete } = props;
  const [draftName, setDraftName] = useState(category.name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftName(category.name);
  }, [category.id, category.name]);

  const commitRename = useCallback(() => {
    const nextName = draftName.trim();
    if (nextName === category.name) {
      setError(null);
      return;
    }
    const nextError = onRename(category.id, draftName);
    setError(nextError);
  }, [category.id, category.name, draftName, onRename]);

  return (
    <SettingsRow
      title={category.name}
      description="Custom sidebar category used to organize logical project rows."
      control={
        <div className="flex flex-wrap items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canMoveUp}
                  aria-label={`Move ${category.name} up`}
                  onClick={() => onMove(category.id, -1)}
                />
              }
            >
              <ArrowUpIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move up</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canMoveDown}
                  aria-label={`Move ${category.name} down`}
                  onClick={() => onMove(category.id, 1)}
                />
              }
            >
              <ArrowDownIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Move down</TooltipPopup>
          </Tooltip>
          <Button size="xs" variant="outline" onClick={() => onHide(category.id)}>
            Hide
          </Button>
          <Button size="xs" variant="destructive-outline" onClick={() => onDelete(category.id)}>
            Delete
          </Button>
        </div>
      }
    >
      <div className="grid gap-1.5 pb-3">
        <span className="text-xs font-medium text-foreground">Name</span>
        <Input
          aria-label={`${category.name} category name`}
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
            if (error) {
              setError(null);
            }
          }}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            }
          }}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </SettingsRow>
  );
}

function HiddenSidebarCategoryRow({
  category,
  onUnhide,
}: {
  readonly category: SidebarCategory;
  readonly onUnhide: (categoryId: string) => void;
}) {
  useRelativeTimeTick();

  return (
    <SettingsRow
      title={category.name}
      description={`Hidden ${formatRelativeTimeLabel(category.archivedAt ?? new Date().toISOString())}`}
      status={category.archivedAt ? `Archived at ${category.archivedAt}` : undefined}
      control={
        <Button size="xs" variant="outline" onClick={() => onUnhide(category.id)}>
          <ArchiveX className="size-3.5" />
          Unhide
        </Button>
      }
    />
  );
}

export function SidebarSettingsPanel() {
  const updateSettings = useUpdateSettings();
  const sidebarOrganization = useSettings(selectSidebarOrganization);
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const categoryExpandedById = useUiStateStore((state) => state.categoryExpandedById);
  const resetSidebarOrganizationUiState = useUiStateStore(
    (state) => state.resetSidebarOrganizationUiState,
  );
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryError, setNewCategoryError] = useState<string | null>(null);

  const { activeCategories, hiddenCategories } = useMemo(
    () => getSidebarSettingsCategories(sidebarOrganization),
    [sidebarOrganization],
  );
  const canReset = useMemo(
    () =>
      canResetSidebarOrganization({
        sidebarOrganization,
        categoryExpandedById,
      }),
    [categoryExpandedById, sidebarOrganization],
  );

  const applySidebarOrganization = useCallback(
    (nextSidebarOrganization: typeof sidebarOrganization) => {
      updateSettings(createSidebarOrganizationPatch(nextSidebarOrganization));
    },
    [updateSettings],
  );

  const handleCreateCategory = useCallback(() => {
    const result = createSidebarCategoryFromSettings({
      sidebarOrganization,
      name: newCategoryName,
    });
    if (result.error) {
      setNewCategoryError(result.error);
      return;
    }
    applySidebarOrganization(result.sidebarOrganization);
    setNewCategoryName("");
    setNewCategoryError(null);
  }, [applySidebarOrganization, newCategoryName, sidebarOrganization]);

  const handleRenameCategory = useCallback(
    (categoryId: string, nextName: string) => {
      const result = renameSidebarCategoryFromSettings({
        sidebarOrganization,
        categoryId,
        name: nextName,
      });
      if (!result.error) {
        applySidebarOrganization(result.sidebarOrganization);
      }
      return result.error;
    },
    [applySidebarOrganization, sidebarOrganization],
  );

  const handleHideCategory = useCallback(
    (categoryId: string) => {
      applySidebarOrganization(
        hideSidebarCategoryFromSettings({
          sidebarOrganization,
          categoryId,
          archivedAt: new Date().toISOString(),
        }),
      );
    },
    [applySidebarOrganization, sidebarOrganization],
  );

  const handleUnhideCategory = useCallback(
    (categoryId: string) => {
      applySidebarOrganization(unhideSidebarCategoryFromSettings(sidebarOrganization, categoryId));
    },
    [applySidebarOrganization, sidebarOrganization],
  );

  const handleUnhideAllCategories = useCallback(() => {
    applySidebarOrganization(unhideAllSidebarCategories(sidebarOrganization));
  }, [applySidebarOrganization, sidebarOrganization]);

  const handleDeleteCategory = useCallback(
    async (categoryId: string) => {
      const category = sidebarOrganization.categories[categoryId];
      if (!category) {
        return;
      }
      const api = readLocalApi();
      const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
        `Delete the "${category.name}" category? Assigned projects will move to ${UNCATEGORIZED_CATEGORY_NAME}.`,
      );
      if (!confirmed) {
        return;
      }
      applySidebarOrganization(deleteSidebarCategoryFromSettings(sidebarOrganization, categoryId));
    },
    [applySidebarOrganization, sidebarOrganization],
  );

  const handleMoveCategory = useCallback(
    (categoryId: string, offset: -1 | 1) => {
      applySidebarOrganization(
        reorderActiveSidebarCategoryByOffset(sidebarOrganization, {
          categoryId,
          offset,
        }),
      );
    },
    [applySidebarOrganization, sidebarOrganization],
  );

  const handleResetSidebarOrganization = useCallback(async () => {
    if (!canReset) {
      return;
    }
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      "Reset sidebar organization? This removes custom categories, clears project assignments, and restores hidden categories.",
    );
    if (!confirmed) {
      return;
    }

    const resetState = resetSidebarOrganizationFromSettings({
      uiState: useUiStateStore.getState(),
    });
    applySidebarOrganization(resetState.sidebarOrganization);
    resetSidebarOrganizationUiState();
  }, [applySidebarOrganization, canReset, resetSidebarOrganizationUiState]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Sidebar" icon={<PanelLeftIcon className="size-3.5" />}>
        <SettingsRow
          title={REPOSITORY_GROUPING_LABEL}
          description="Choose the default logical project grouping for the sidebar. Per-project repository grouping overrides remain available from the main sidebar."
          status={describeRepositoryGroupingMode(
            projectGroupingSettings.sidebarProjectGroupingMode,
          )}
          control={
            <Select
              value={projectGroupingSettings.sidebarProjectGroupingMode}
              onValueChange={(value) => {
                if (value !== null) {
                  updateSettings({
                    sidebarProjectGroupingMode: value as SidebarProjectGroupingMode,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Sidebar repository grouping">
                <SelectValue>
                  {
                    REPOSITORY_GROUPING_MODE_LABELS[
                      projectGroupingSettings.sidebarProjectGroupingMode
                    ]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(
                  Object.entries(REPOSITORY_GROUPING_MODE_LABELS) as Array<
                    [SidebarProjectGroupingMode, string]
                  >
                ).map(([mode, label]) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Categories">
        <SettingsRow
          title="New category"
          description="Create a custom sidebar category for organizing logical project rows."
          control={
            <Button size="xs" variant="outline" onClick={handleCreateCategory}>
              <PlusIcon className="size-3.5" />
              Create
            </Button>
          }
        >
          <div className="grid gap-1.5 pb-3">
            <span className="text-xs font-medium text-foreground">Category name</span>
            <Input
              aria-label="New sidebar category name"
              value={newCategoryName}
              onChange={(event) => {
                setNewCategoryName(event.target.value);
                if (newCategoryError) {
                  setNewCategoryError(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreateCategory();
                }
              }}
            />
            {newCategoryError ? (
              <p className="text-xs text-destructive">{newCategoryError}</p>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          title={UNCATEGORIZED_CATEGORY_NAME}
          description="Logical projects without an explicit category assignment appear here."
          status="Built-in bucket"
        />

        {activeCategories.length === 0 ? (
          <SettingsRow
            title="No custom categories"
            description="Create a category to start organizing logical projects into the sidebar tree."
          />
        ) : (
          activeCategories.map((category, index) => (
            <EditableSidebarCategoryRow
              key={category.id}
              category={category}
              canMoveUp={index > 0}
              canMoveDown={index < activeCategories.length - 1}
              onRename={handleRenameCategory}
              onMove={handleMoveCategory}
              onHide={handleHideCategory}
              onDelete={handleDeleteCategory}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Hidden categories"
        icon={<ArchiveIcon className="size-3.5" />}
        headerAction={
          hiddenCategories.length > 0 ? (
            <Button size="xs" variant="outline" onClick={handleUnhideAllCategories}>
              Unhide all
            </Button>
          ) : null
        }
      >
        {hiddenCategories.length === 0 ? (
          <SettingsRow
            title="No hidden categories"
            description="Hidden categories will appear here so they can be restored without changing the main sidebar."
          />
        ) : (
          hiddenCategories.map((category) => (
            <HiddenSidebarCategoryRow
              key={category.id}
              category={category}
              onUnhide={handleUnhideCategory}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Organization actions">
        <SettingsRow
          title="Reset sidebar organization"
          description="Remove custom categories, clear project assignments, restore hidden categories, and reset category collapse state without touching repository grouping or project ordering."
          status={
            canReset
              ? "Category organization changes are ready to reset."
              : "Sidebar organization is already using defaults."
          }
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canReset}
              onClick={() => void handleResetSidebarOrganization()}
            >
              Reset
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
