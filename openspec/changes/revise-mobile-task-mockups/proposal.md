## Why

`experiments/mobile-tasks-mockups/` (v1) shipped four parallel options for how tasks and their turns' provider-native agents surface on mobile, and recommended combining option 1 + option 2 + option 4's task view. Three findings make a converged v2 the right next step rather than a fifth option.

**v1 never saw the tasks/agents reference.** Its own `HANDOFF.md` says so: the Android chrome was traced from `reference-mobile.png`, which is in the directory, but the tasks/agents visual language came from "the desktop/web sidebar's tasks/agents UI (not embeddable)" — a description, not a file. Everything derived from it is plausible and none of it is confirmed against what was actually wanted.

**v1 hardcodes one scenario.** All four variants render the same "10 agents, 6 done, 4 failed" turn. The rollup chips, the counters, and the failed-agent styling are untested at the sizes that actually occur most: one agent, zero failures, and everything-failed.

**Contrast fails, measurably.** `--dim: #6b7280` on `--bg: #0a0a0a` is **4.15:1**, and on `--card: #101013` it is **3.98:1** — both under 4.5:1. That token carries the metadata lines (`Explore · done · 4.1k tokens · 3 tools · 3s`) throughout the set. v1 is also dark-only: it defines no light theme at all, so "legible in both themes" is currently unverifiable rather than merely unverified.

Four parallel options was the right shape for a first pass. The decision has been made, so a second round of four would be procrastination.

## What Changes

- Add `experiments/mobile-tasks-mockups-v2/` as a **sibling** of v1, not an overwrite. v1 is the artifact these findings refer to; destroying it removes any way to check whether v2 fixed what was raised, and sibling directories are already how `experiments/` is organised.
- **Converge on one flow** built from v1's own recommendation — thread-list entry → bottom-sheet peek → full task view — instead of re-branching into independent variants.
- **Render the states v1 skipped**, each as a real screen: task queued and not yet started; exactly one agent; zero failures; all agents failed; task cancelled mid-flight; a result returned but unread; and a native in-session agent, which is the case that must visibly refuse steering.
- Add a **state matrix page** rendering every one of those states side by side. This is the deliverable v1 lacked and the thing that makes the set reviewable at a glance.
- **Fix and assert contrast.** Correct the failing token once in the forked stylesheet so every page inherits it, and check the metadata lines specifically rather than eyeballing the result.
- **Add a light theme**, since v1 has none and the contrast requirement is stated for both.
- Carry v1's `?param` deep-link convention forward so the two sets navigate the same way.
- Leave the reference-alignment pass as one **explicitly open, unchecked task** until the tasks/agents reference image exists.

## Capabilities

### New Capabilities

- `mobile-task-agent-surface`: How the mobile client presents tasks and the agents running inside them — lifecycle-state rendering, steerability and its stated reason, honest rollup counts at every cardinality, failure attribution, and text contrast.

### Modified Capabilities

None.

## Impact

- **New** `experiments/mobile-tasks-mockups-v2/` — a forked `mockup.css`, three linked flow screens, a state matrix page, an `index.html` landing page, and `NOTES.md` / `README.md` / `HANDOFF.md` in v1's format with an explicit "what changed from v1 and why" section citing the three findings.
- **No change to** `experiments/mobile-tasks-mockups/` (v1), which stays as the comparison baseline.
- **No production code.** This touches no `apps/`, `packages/`, or `docs/` path. Nothing ships to users from this change.
- Mockups are exploratory artifacts and OpenSpec is spec-driven, so the fit is imperfect and worth naming. The requirements are therefore written about **what the design must account for**, not about the HTML — so they survive into the eventual React Native implementation instead of being thrown away with the mockup.
- The tasks/agents reference image is the one blocking input, and it gates **only** the alignment pass. State coverage, contrast, and convergence are independent and proceed now; if the image lands mid-flight, that task closes in the same round.
