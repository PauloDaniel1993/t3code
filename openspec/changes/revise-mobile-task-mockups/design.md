## Context

v1 lives at `experiments/mobile-tasks-mockups/`: twelve files, four option directories, a shared `mockup.css`, a landing `index.html` with deep-link parameters, and `README.md` / `HANDOFF.md`. All four variants were verified rendering in a browser. Its `README.md:135-153` recommends shipping option 1 (thread list) + option 2 (bottom sheet) + option 4's task view, with option 3 and option 4's Agents tab as upgrades.

What v1 was working from matters for what v2 must fix. `HANDOFF.md` names two references. The first, `reference-mobile.png`, is present in the directory and is the real Android app: status bar, "T3 Code · ALPHA" header, search field, thread rows with repo icon, time-ago, "Working" state, branch, provider glyph, and unread badges. The second — the desktop sidebar's tasks/agents visual language — was **not** a file. It was a written description of disclosure chips, guide-line sub-rows, ✓/× counters, ↩ returned markers, and a Settle pill. Everything specific to tasks and agents in v1 is therefore an interpretation, not a match.

Three concrete constraints follow from reading v1 rather than assuming its shape:

**The contrast failure is one token, used everywhere.** `mockup.css:16` defines `--dim: #6b7280`. Against `--bg: #0a0a0a` that is 4.15:1; against `--card: #101013` it is 3.98:1. Both fail 4.5:1. `--dim` appears on roughly a dozen rules, and it is exactly the token carrying the small metadata lines. `--muted: #a3a3a3` measures 7.85:1 and is fine. So this is a one-token fix with a wide blast radius, which is an argument for fixing it in a forked stylesheet rather than patching pages.

**v1 has no light theme at all.** No `prefers-color-scheme` block, no `.light` class, no `[data-theme]` attribute. "Legible in both themes" is currently not a regression to fix but a variant to add, and that is real added scope worth stating rather than discovering.

**Every variant renders the same scenario.** One thread, one task, ten agents, six done, four failed. The rollup chip, the ✓/× counters, and the failed-agent row styling have never been rendered at any other cardinality — including the two most common ones, a single agent and zero failures.

## Goals / Non-Goals

**Goals:**

- Produce one coherent flow reviewers can walk end to end, rather than four things to choose between.
- Render every task lifecycle state at least once, so no state is left to a reviewer's imagination.
- Make the failure and edge cardinalities visible on one page, side by side.
- Fix the contrast defect at its single source and verify it by measurement.
- Preserve v1 intact as the baseline the findings refer to.
- Write requirements that survive into React Native, so the specification is not thrown away with the HTML.

**Non-Goals:**

- Any production code. No `apps/`, no `packages/`, no `docs/`.
- New design options. The decision has been made; v2 converges.
- A build step, a framework, or a package dependency. v1 opens over `file://` and v2 must too.
- Resolving v1's documented data gaps (`README.md:155-190`) — cross-level rollup, turn identity, ✓/× aggregation, ↩ semantics, push parity, agent→transcript lookup. Those are contract questions, and a mockup cannot answer them. v2 inherits and re-states them.
- Deciding sheet-versus-push as a shipped gesture. v2 renders the converged flow; the gesture mapping remains open.

## Decisions

### 1. Fork as a sibling directory rather than editing v1 in place

`experiments/mobile-tasks-mockups-v2/` sits beside v1. The findings above are statements _about v1_; if v1 is overwritten, there is no way to check whether v2 actually fixed them, and the review that produced these findings becomes unreproducible. `experiments/` already holds sibling directories (`messages-glass-lab`, `subagent-view-mockups`, `thread-tasks-mockups`), so this matches the existing organisation rather than inventing one.

Rejected: editing v1 in place (loses the baseline); a `v2/` subdirectory inside v1 (implies v1 contains v2, and breaks the flat sibling convention).

### 2. Fork the stylesheet and fix the token once

Copy `mockup.css` into v2 and correct `--dim` there, so every page inherits the fix from one edit. The failing value is a single token used across a dozen rules; patching per-page would guarantee drift and would make "did we fix it" unanswerable.

The replacement must clear 4.5:1 against **both** `--bg` and `--card`, because metadata lines appear on both surfaces and the card is the darker of the two. Checking only against `--bg` would leave the card case failing at a value that looks fixed.

Sharing one stylesheet between v1 and v2 was rejected for the same reason as decision 1: v1 must keep rendering exactly as reviewed.

### 3. Converge on three linked screens, not four parallel options

The flow is thread-list entry → bottom-sheet peek → full task view, which is v1's own recommendation (`README.md:137-149`) minus the optional upgrades. Deep links use v1's `?param` convention so both sets navigate the same way and a reviewer can hold them side by side.

Option 3's pinned in-thread card and option 4's Agents tab are not dropped as ideas — they are simply not what a convergence round is for. If they return, they return as additions to a settled flow rather than as alternatives to it.

### 4. Make the state matrix the primary deliverable

One page rendering every state side by side: queued and not started, one agent, zero failures, all failed, cancelled mid-flight, result returned but unread, and a native in-session agent. This is what v1 could not offer, and it is what makes the set reviewable in one pass instead of by clicking through variants and holding state in one's head.

The three edge cardinalities matter more than they look. "0 of 0" and "1 agents" are the classic pluralisation and division failures, and a rollup chip that renders a failure colour when nothing ran is worse than no chip — it teaches the user to distrust the indicator. All-failed is the state where a user most needs to know _why_, and v1 shows a reason on only one variant (option 4's `budget exceeded`).

The native in-session agent is the case that must **visibly refuse steering with the reason stated**, not merely grey out a control. v1's option 2 already does this; v2 promotes it from a nice touch to a requirement, because a disabled control with no explanation reads as a bug.

### 5. Write requirements about the design, not the HTML

Mockups are exploratory and OpenSpec is spec-driven; the fit is imperfect and pretending otherwise would produce requirements that are deleted the moment the mockup is. So the delta spec asserts what the _design_ must account for — every lifecycle state has a defined rendering, non-steerable means stated-reason, counts read honestly at every cardinality, failures carry a reason, text meets 4.5:1 — and the mockup is the evidence that it does. Those requirements transfer to React Native unchanged.

### 6. Add a light theme rather than deferring it

The contrast requirement is stated for both themes and v1 has only one, so v2 adds the light variant. Adding it now is cheap — the tokens are already centralised in one `:root` block — and adding it later means re-auditing every page a second time. The variant is a token block, not a second set of pages.

### 7. Keep the reference-alignment task open and honestly unchecked

The tasks/agents reference image is the single blocking input, and it gates only the alignment pass. State coverage, contrast, convergence, and the light theme are all independent, so waiting for the image would block roughly three-quarters of the work on one file. v2 ships with those complete and the alignment task explicitly unchecked; if the image lands mid-flight, that task closes in the same round.

Marking it done without the image would be the one failure mode that makes the whole artifact untrustworthy.

## Risks / Trade-offs

- **The reference image never arrives** → Everything except alignment still ships and is independently useful; the open task states plainly what was not verified rather than implying it was.
- **The alignment pass invalidates converged decisions** → Convergence is on flow and state coverage, which are structural; a reference match adjusts visual language on top of that structure. The state matrix in particular survives any restyle.
- **A "fixed" contrast token still fails on the darker card surface** → Verify against both `--bg` and `--card`, and record the measured ratios rather than asserting compliance.
- **v1 and v2 drift into inconsistent conventions** → Reuse v1's `?param` deep-link scheme and file layout deliberately, so the two sets stay comparable.
- **Fabricated data makes the mockups misleading** → Keep v1's discipline of using the real scenario from the reference screenshots; the new states are new _cardinalities_ of that scenario, not invented threads.
- **v1's data gaps get mistaken for solved** → Re-state them in v2's `README.md` rather than dropping them, since v2 does not resolve any of them.
- **OpenSpec archive semantics assume shipped behaviour** → Named in decision 5: the requirements describe the design contract, so archiving them records a design decision rather than a deployed feature.

## Migration Plan

Not applicable in the deployment sense — this change adds an experiments directory and ships no code. Sequencing within the change is: scaffold and fork the stylesheet first (so the contrast fix exists before any page inherits it), then the three flow screens, then the state matrix, then the documentation. Rollback is deleting `experiments/mobile-tasks-mockups-v2/`; v1 is untouched by construction.

## Open Questions

- What is the correct replacement value for `--dim`? Decided during implementation by measurement against both `--bg` and `--card`, not chosen up front.
- Does the light theme need its own status hues, or do the existing `--success` / `--warn` / `--danger` values clear 4.5:1 on a light surface unchanged? Almost certainly not unchanged, but it is a measurement rather than a guess.
- Sheet versus push for the task-row tap remains unresolved from v1 (`README.md:158-161`). v2 renders the converged flow without claiming to settle the gesture.
- Whether the state matrix should also cover the narrow 320 px sheet width inline, or rely on the documented resize pass. Leaning toward the resize pass, to keep the matrix readable.
