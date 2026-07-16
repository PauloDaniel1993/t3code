import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettings } from "../components/settings/AppearanceSettings";

function SettingsAppearanceRoute() {
  return <AppearanceSettings />;
}

export const Route = createFileRoute("/settings/appearance")({
  component: SettingsAppearanceRoute,
});
