import { createFileRoute } from "@tanstack/react-router";
import { SidebarSettingsPanel } from "../components/settings/SidebarSettings";

function SettingsSidebarRoute() {
  return <SidebarSettingsPanel />;
}

export const Route = createFileRoute("/settings/sidebar")({
  component: SettingsSidebarRoute,
});
