## ADDED Requirements

### Requirement: Nest task rows under their parent in the sidebar

The sidebar SHALL remove task threads from the top-level thread list and render them as an indented
group directly beneath their parent row, joined by a guide line. The parent's own sort position
SHALL be unchanged by owning tasks.

#### Scenario: Parent with tasks

- **WHEN** a thread owns one or more non-archived tasks
- **THEN** its row gains a disclosure chevron and an `N tasks` count chip beside the branch label,
  and its task rows render indented beneath it when the group is expanded

#### Scenario: Task rows are not duplicated at top level

- **WHEN** the sidebar renders the thread list
- **THEN** a task thread appears only inside its parent's group and not as a top-level row

#### Scenario: Task row anatomy

- **WHEN** a task row renders
- **THEN** it shows a status icon, the task title, and an elapsed-time label, where the icon is a
  blue spinner while running, a green check when finished, and carries a return marker when the task
  returned results to the parent

#### Scenario: Task rows stay in the group

- **WHEN** a task thread becomes settled, snoozed, or quiet
- **THEN** it renders as a slim row inside its parent's group and does not move into the global
  Snoozed or Settled shelves

#### Scenario: Archived parent

- **WHEN** a parent thread is archived
- **THEN** its task rows leave the active list with it and do not appear as orphan top-level rows

#### Scenario: Collapsing a group

- **WHEN** the user clicks the disclosure chevron
- **THEN** the task rows hide, the count chip remains, and the collapse state persists per parent
  thread across reloads

#### Scenario: Default expansion

- **WHEN** a parent's group has no persisted collapse state
- **THEN** it renders expanded while any task is running or has undelivered results, and collapsed
  otherwise

### Requirement: Mark parents with unread task results

The sidebar SHALL show a blue dot on a parent row when a task returned results and resumed that
thread since the user last visited it. The marker SHALL be visually distinct from the existing woke
and done indicators.

#### Scenario: Result arrives while the user is elsewhere

- **WHEN** a task delivers its result to a parent the user has not visited since the delivery
- **THEN** the parent row shows the blue unread-results dot

#### Scenario: Visiting the parent clears the marker

- **WHEN** the user opens the parent thread after a delivery
- **THEN** the blue dot clears

#### Scenario: Never-visited parent

- **WHEN** a parent has a delivery but no recorded visit timestamp
- **THEN** the parent row shows the blue dot

#### Scenario: Skipped delivery

- **WHEN** a task's result delivery was skipped
- **THEN** the parent row does not show the unread-results dot for that task

### Requirement: Offer manual task creation from the sidebar and the active thread

The web UI SHALL expose a hover-visible `+ New task` row at the end of a parent's task group and a
`New task…` action in the active thread's actions menu. Both SHALL open the same creation dialog.

#### Scenario: Sidebar entry point

- **WHEN** the user hovers a parent thread's expanded task group
- **THEN** a `+ New task` row appears at the end of the group and opens the creation dialog for that
  parent

#### Scenario: Active thread entry point

- **WHEN** the active thread is eligible to own tasks
- **THEN** its actions menu exposes `New task…` and opens the creation dialog for that thread

#### Scenario: Entry points hidden on ineligible threads

- **WHEN** the thread is a task thread, is archived, or the environment does not advertise
  `threadTasks`
- **THEN** neither entry point is offered

#### Scenario: Creation dispatch

- **WHEN** the user confirms the dialog
- **THEN** the UI dispatches `thread.task.create` with the chosen title, prompt, context spec, and
  optional model, closes on acknowledgement, and shows the new task row in the parent's group

#### Scenario: Rejected creation

- **WHEN** the server rejects the create for caps, eligibility, or provider readiness
- **THEN** the dialog stays open and shows the rejection reason without discarding the entered prompt

### Requirement: Choose task context in the creation dialog

The creation dialog SHALL offer a context picker with Full thread, Selected messages, and No context,
defaulting to Full thread. Selecting Selected messages SHALL reveal a checkbox list of the parent's
transcript messages.

#### Scenario: Default context

- **WHEN** the dialog opens
- **THEN** Full thread is preselected

#### Scenario: Picking messages

- **WHEN** the user chooses Selected messages
- **THEN** the dialog shows the parent's completed transcript messages newest-first with checkboxes
  and a running count of selected messages

#### Scenario: Selection bounds

- **WHEN** the user has selected no messages, or attempts to exceed the selected-message cap
- **THEN** the dialog blocks submission and explains the bound

#### Scenario: No context

- **WHEN** the user chooses No context
- **THEN** the message list is hidden and the task is created with only its prompt

### Requirement: Peek at a task in a mini thread window

Clicking a task row SHALL open a floating mini thread window anchored to that row with a caret, while
the clicked row stays highlighted. The window SHALL close on Escape, on an outside click, and when
its group is collapsed.

#### Scenario: Opening the window

- **WHEN** the user clicks a task row
- **THEN** the mini thread window opens anchored to the row and the row renders as highlighted

#### Scenario: Window anatomy

- **WHEN** the mini thread window is open
- **THEN** it shows a status line, an `Open thread ↗` button, a close control, the task title, chips
  for creator, context, and model, a mini timeline, and a steer composer

#### Scenario: Status line content

- **WHEN** the task is running
- **THEN** the status line reads as working with the elapsed time
- **AND WHEN** the task has finished
- **THEN** the status line reads as done with the time since completion

#### Scenario: Returned-results chip

- **WHEN** the task delivered its result to the parent
- **THEN** the chips include a returned-and-woke-parent chip

#### Scenario: Mini timeline content

- **WHEN** the mini thread window is open
- **THEN** the mini timeline shows the task's prompt as a user bubble, its latest assistant activity,
  and, for a delivered task, an event line stating that it returned to the parent and resumed the
  main thread

#### Scenario: Live updates

- **WHEN** the task produces new activity while the window is open
- **THEN** the status line and mini timeline update live without a page navigation

#### Scenario: Dismissal

- **WHEN** the user presses Escape, clicks outside the window, or collapses the parent's group
- **THEN** the window closes and the row highlight clears

#### Scenario: Opening the full thread

- **WHEN** the user activates `Open thread ↗`
- **THEN** the app navigates to the task thread as a normal full thread view

### Requirement: Steer a task from the mini thread window

The mini thread window SHALL offer a plain-text steer composer that sends a message to the task
thread without navigating away from the current thread.

#### Scenario: Sending a steer

- **WHEN** the user submits non-empty text in the steer composer
- **THEN** the message is dispatched to the task thread, appears in the mini timeline, and the
  current route does not change

#### Scenario: Composer scope

- **WHEN** the steer composer renders
- **THEN** it offers text entry and send only, without attachments, slash commands, mentions, or a
  model picker

#### Scenario: Empty submission

- **WHEN** the user submits with no sendable content
- **THEN** nothing is dispatched and no busy state engages

#### Scenario: Task awaiting approval or input

- **WHEN** the task thread has a pending approval or user-input request
- **THEN** the mini window shows that state and directs the user to open the full thread rather than
  inlining the response controls

#### Scenario: Cancelling from the window

- **WHEN** the user cancels a running task from the mini thread window
- **THEN** `thread.task.cancel` is dispatched and the row's status icon reflects the cancellation

#### Scenario: Returning results again

- **WHEN** the task has already finished and the user activates the return-again action
- **THEN** a fresh delivery is requested for the current result and the parent is woken again

### Requirement: Render task lifecycle rows in the parent timeline

The parent thread timeline SHALL render task creation and task completion as quiet event rows, and
SHALL NOT render the injected `task-result` message as an ordinary user bubble.

#### Scenario: Agent-created task row

- **WHEN** the parent timeline contains a `task.created` activity with creator `agent`
- **THEN** it renders a quiet row reading as an agent-created task with the task title and a link to
  open the task thread

#### Scenario: User-created task row

- **WHEN** the parent timeline contains a `task.created` activity with creator `user`
- **THEN** it renders a quiet row naming the user as creator, the task title, and the chosen context

#### Scenario: Wake-up row

- **WHEN** a task's result was delivered to the parent
- **THEN** the parent timeline renders an info-blue tinted row stating that the task finished, what
  it returned, and that the main thread resumed

#### Scenario: Injected message is not a user bubble

- **WHEN** the parent transcript contains a message with `source: "task-result"`
- **THEN** the timeline does not render it as a user bubble and instead surfaces its text through the
  corresponding wake-up row

#### Scenario: Inspecting the injected text

- **WHEN** the user expands a wake-up row
- **THEN** the injected result text becomes visible

#### Scenario: Skipped delivery row

- **WHEN** a task finished but its delivery was skipped
- **THEN** the parent timeline states the outcome and the reason rather than claiming the thread
  resumed

### Requirement: Degrade cleanly where tasks are unsupported

The web UI SHALL suppress task affordances rather than fail when the environment does not support
tasks or the viewport is not the desktop layout.

#### Scenario: Server without task support

- **WHEN** the environment descriptor omits `threadTasks`
- **THEN** the sidebar renders threads without task groups, chevrons, count chips, or `+ New task`,
  and no task commands are dispatched

#### Scenario: Mobile layout

- **WHEN** the sidebar renders in the mobile layout
- **THEN** task rows still render nested under their parent, and activating one opens the full task
  thread instead of the mini thread window

### Requirement: Gate the task surface behind a beta setting

The web UI SHALL expose a client setting under Beta features that controls whether the task surface
renders at all, defaulting to off. Turning it off SHALL hide the surface without hiding any thread.

#### Scenario: Setting off by default

- **WHEN** a client has never touched the setting
- **THEN** no task groups, chevrons, count chips, `+ New task`, mini thread window, `New task…` menu
  item, or task lifecycle rows render, and no task commands are dispatched

#### Scenario: Task threads stay reachable when the setting is off

- **WHEN** the setting is off and the parent already owns task threads
- **THEN** each task thread renders as an ordinary top-level sidebar row rather than disappearing
  with the group that would have held it

#### Scenario: Wake-up messages stay suppressed either way

- **WHEN** the setting is off and the parent carries a delivered `task-result` message
- **THEN** the transcript still omits it, because a message nobody typed must never render as a user
  bubble regardless of the setting

#### Scenario: Turning the setting on

- **WHEN** the setting is turned on against a server that advertises `threadTasks`
- **THEN** the full task surface renders for existing tasks without any further action
