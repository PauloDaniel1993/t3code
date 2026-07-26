import { createFileRoute, notFound } from "@tanstack/react-router";

import { TimelineActivityScrollFixture } from "../components/TimelineActivityScrollFixture";

export const Route = createFileRoute("/dev/timeline-activity-scroll")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
  component: TimelineActivityScrollFixture,
});
