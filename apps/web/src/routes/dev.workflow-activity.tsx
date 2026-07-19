import { createFileRoute, notFound } from "@tanstack/react-router";

import { WorkflowActivityBrowserFixture } from "../components/WorkflowActivityBrowserFixture";

export const Route = createFileRoute("/dev/workflow-activity")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
  component: WorkflowActivityBrowserFixture,
});
