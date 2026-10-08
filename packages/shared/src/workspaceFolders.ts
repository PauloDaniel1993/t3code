import type { WorkspaceFolderEntry } from "@t3tools/contracts";

// A label is one path segment: no separators, no characters Windows reserves
// in file names, no control characters.
const UNSAFE_LABEL_CHARACTERS = /[\\/:*?"<>|\p{Cc}]+/gu;

function sanitizeLabel(candidate: string): string | undefined {
  const label = candidate.replace(UNSAFE_LABEL_CHARACTERS, "-").trim();
  return label === "" || label === "." || label === ".." ? undefined : label;
}

function lastSegment(location: string): string {
  return location.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "";
}

/**
 * Give each workspace folder its unique canonical path label, as in
 * `<label>/src/main.ts`. The label is the folder's name made a safe path
 * segment, else its basename, else `folder`. Every folder reserves its
 * preferred label first, unavailable folders included, so availability never
 * renumbers labels. Repeats then take the next free `-2`, `-3`, … in entry
 * order, compared case-insensitively: `app, app, app-2` becomes
 * `app, app-3, app-2`.
 */
export function allocateFolderLabels<Entry extends WorkspaceFolderEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry & { readonly label: string }> {
  const preferred = entries.map(
    (entry) =>
      sanitizeLabel(entry.name) ??
      sanitizeLabel(lastSegment(entry.path ?? entry.uri ?? "")) ??
      "folder",
  );
  const taken = new Set(preferred.map((label) => label.toLowerCase()));
  const claimed = new Set<string>();
  return entries.map((entry, index) => {
    const label = preferred[index] ?? "folder";
    if (!claimed.has(label.toLowerCase())) {
      claimed.add(label.toLowerCase());
      return { ...entry, label };
    }
    let suffix = 2;
    while (taken.has(`${label}-${suffix}`.toLowerCase())) suffix += 1;
    const allocated = `${label}-${suffix}`;
    taken.add(allocated.toLowerCase());
    return { ...entry, label: allocated };
  });
}
