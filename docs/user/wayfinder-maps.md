# Wayfinder Maps

A wayfinder map turns a large effort into a graph of decision tickets. Use it to see what is ready
to pick up, what is already settled, and what a ticket is waiting on without opening each ticket
one at a time.

The Map surface is read-only. Your agent creates and updates the map; T3 Code keeps the view in
sync as it changes.

## Open the Map Surface

Open the right panel, use the add-surface menu, and choose **Map**. If the panel has no open
surfaces, choose **Map** from its empty state instead.

The Map surface is available in the web and desktop apps. It is not available in the mobile app.

## Move Between Maps, Tickets, and Blockers

The surface has three levels:

1. **Maps** lists the wayfinder maps in the current project, with ticket and frontier counts.
2. **Map** shows the selected effort as a constellation or a list.
3. **Ticket** shows one decision and what still blocks it.

Choose a map, then choose a star or list item to open its ticket. Use **Back** to move up one level.
Pressing `Escape` also moves back one level instead of closing the right panel. When a ticket names
a blocker, choose that blocker to open its ticket.

## Read the Constellation

Each star is a ticket. Its colour shows the ticket's current state:

- Blue is open.
- Amber is claimed.
- Green is resolved.
- Red is out of scope.

A pulsing star is on the **frontier**: the ticket is not resolved or out of scope, and all of its
blockers are resolved or out of scope. The pulse answers "what can I pick up now?"; the colour
still tells you whether that ticket is open or already claimed.

Lines connect blockers to the tickets waiting on them. Select a ticket when you want the exact
blocker names and decision details.

## Use List View

Use the **Map / List** toggle to switch between the constellation and a parallel ticket list. The
list carries the same status and blocker information, works with the keyboard and screen readers,
and keeps its selection in sync with the map.

List view is the default in a narrow panel. It is also the default when reduced motion is enabled;
in that mode the constellation remains static and does not animate.

## When No Map Is Available

You can open the Map surface even when the current project has no wayfinder map. It shows **No
wayfinder map in this project** until an agent creates one.

If T3 Code finds a map but cannot read it, the surface shows the parsing warnings instead of the
no-map message. If only part of a map can be read, the usable tickets still appear and the warnings
remain available.
