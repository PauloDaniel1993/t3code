# TODO

## Small things

- [x] Submitting new messages should scroll to bottom — send re-engages live-follow and anchors to the live edge (`apps/web/src/components/ChatView.tsx`, `chat/timelineScrollAnchoring.ts`)
- [x] Only show last 10 threads for a given project — implemented as a configurable preview count (default 6, range 1–15; `packages/contracts/src/settings.ts`, `Sidebar.tsx`)
- [x] Thread archiving — full stack: `thread.archive`/`thread.unarchive` contract commands, sidebar context-menu + bulk archive, Archived view in Settings, mobile too
- [x] New projects should go on top — holds under the default `updated_at`/`created_at` sorts; note: under `manual` sort a new project still lands at the bottom (follow-up if that matters)
- [x] Projects should be sorted by latest thread update — project sort key is the max thread timestamp (`Sidebar.logic.ts` `getProjectSortTimestamp`/`sortProjectsByActivity`; archived threads excluded)

## Bigger things

- [ ] Queueing messages — still open: sending during a running turn currently steers (supersedes the running turn), and the composer's primary action while running is interrupt. A real per-thread FIFO follow-up queue does not exist yet.
