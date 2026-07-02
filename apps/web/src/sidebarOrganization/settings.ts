import type {
  ClientSettingsPatch,
  SidebarOrganization,
  UnifiedSettings,
} from "@t3tools/contracts/settings";

export function selectSidebarOrganization(
  settings: Pick<UnifiedSettings, "sidebarOrganization">,
): SidebarOrganization {
  return settings.sidebarOrganization;
}

export function createSidebarOrganizationPatch(
  sidebarOrganization: SidebarOrganization,
): ClientSettingsPatch {
  return {
    sidebarOrganization,
  };
}
