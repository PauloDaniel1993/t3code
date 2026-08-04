---
name: Merge upstream into fork
description: Integrating new upstream (pingdotgg/t3code) commits into this fork's long-lived branches
---

# Merging upstream into this fork

When integrating upstream into `dev` or any long-lived fork branch, read and follow
`.agents/skills/merge-upstream-into-fork/SKILL.md`.

Key points, so you know whether it applies:

- Analyse before touching history. `git merge-tree --write-tree --name-only main dev`
  predicts the exact conflict set in seconds with zero mutation.
- Prefer **merge** over rebase on published fork branches. Verify with
  `git cherry dev main` that no incoming commit duplicates.
- The expensive work is never the reported conflicts. It is fork features whose
  dependency upstream deleted underneath them — those produce no conflict markers.
- Never call a failing test "merge-caused" until you have checked it against the
  pre-merge backup branch and against upstream `main`.
