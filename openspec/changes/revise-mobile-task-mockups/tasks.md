## 1. Scaffold and Shared Chrome

- [ ] 1.1 Create `experiments/mobile-tasks-mockups-v2/` as a sibling of `experiments/mobile-tasks-mockups/`, and confirm v1 stays byte-identical throughout this change.
- [ ] 1.2 Fork `mockup.css` from v1 into v2 so the contrast fix is made once and inherited by every page.
- [ ] 1.3 Measure the current `--dim: #6b7280` against `--bg: #0a0a0a` and `--card: #101013`, confirming the 4.15:1 and 3.98:1 failures, and record the measured baseline.
- [ ] 1.4 Replace `--dim` with a value clearing 4.5:1 against **both** `--bg` and `--card`, and re-measure to confirm; verify `--muted: #a3a3a3` still passes on both surfaces.
- [ ] 1.5 Add a light theme token block, which v1 has none of, and measure every text token against its light-theme surfaces including the status hues `--success`, `--warn`, and `--danger`.
- [ ] 1.6 Copy v1's Android chrome — status bar, "T3 Code · ALPHA" header, search field, thread row anatomy, compose FAB, gesture bar — as traced from `reference-mobile.png`, so v2's chrome stays faithful to the real app.
- [ ] 1.7 Add `index.html` as the v2 landing page linking every artifact with its deep-link parameters, matching v1's `?param` convention.

## 2. Converged Flow

- [ ] 2.1 Build the thread-list entry screen from v1's option 1, carrying the disclosure chip, guide-line sub-rows, and expanded-group anatomy.
- [ ] 2.2 Build the bottom-sheet peek screen from v1's option 2, keeping its honesty rules verbatim: identical anatomy for tasks and agents, a disabled composer with the reason in words, and "Show in transcript" for agents.
- [ ] 2.3 Build the full task view from v1's option 4's task half, which v1's own recommendation calls non-negotiable because "Open thread" must land somewhere.
- [ ] 2.4 Wire the three screens as one flow — list entry to peek to full view — with working deep links between them and no dead ends.
- [ ] 2.5 Confirm the three screens present one consistent visual language rather than three inherited dialects from their source variants.

## 3. State Matrix

- [ ] 3.1 Add the state matrix page rendering every state side by side on one page; this is the deliverable v1 lacked.
- [ ] 3.2 Render the queued-and-not-yet-started task state, distinguishable from running, failed, and complete.
- [ ] 3.3 Render the single-agent case with singular wording and correct counters.
- [ ] 3.4 Render the zero-failures case with no failure count and no failure styling.
- [ ] 3.5 Render the all-agents-failed case honestly, without implying partial success, with each failure carrying its reason.
- [ ] 3.6 Render the cancelled-mid-flight task state, distinguishable from both completion and failure.
- [ ] 3.7 Render the result-returned-but-unread state, distinct from the read completed state.
- [ ] 3.8 Render the native in-session agent refusing steering **with the reason stated in words**, promoting v1's option 2 treatment from a nice touch to the required pattern.
- [ ] 3.9 Verify no rollup renders "0 of 0", no count of one is pluralised, and no failure styling appears when nothing has failed.
- [ ] 3.10 Verify every failed agent anywhere in v2 carries a failure reason, not a bare failure marker; v1 shows a reason only in option 4.

## 4. Documentation

- [ ] 4.1 Write `README.md` in v1's format covering the converged flow, the state matrix, and per-screen notes.
- [ ] 4.2 Add an explicit "what changed from v1 and why" section citing the three findings: the tasks/agents reference was a description rather than a file, one hardcoded scenario, and the measured contrast failure.
- [ ] 4.3 Re-state v1's unresolved data gaps (`README.md:155-190`) — cross-level rollup, turn identity in the list, ✓/× counters, ↩ semantics on a working row, push-notification parity, and agent-to-transcript lookup — since v2 resolves none of them.
- [ ] 4.4 Re-state the open interaction questions carried from v1, including sheet versus push for the task-row tap.
- [ ] 4.5 Write `HANDOFF.md` in v1's format, naming which references v2 was built from and which remain unavailable.
- [ ] 4.6 Add per-screen `NOTES.md` files matching v1's per-option convention.
- [ ] 4.7 Record the measured contrast ratios for every text token on every surface in both themes, so the claim is checkable rather than asserted.

## 5. Reference Alignment

- [ ] 5.1 **Blocked, and to remain unchecked until the input exists.** Align the tasks/agents visual language to the reference image once it is available; v1's `HANDOFF.md` confirms this reference was a written description rather than a file, so nothing in v1 or v2 is yet confirmed against it. Do not mark this complete without the image.

## 6. Verification

- [ ] 6.1 Serve and open every v2 page at 390 px width in both themes, confirming each renders completely.
- [ ] 6.2 Repeat at 320 px, the narrow sheet width, confirming no overflow, clipping, or unreadable collapse.
- [ ] 6.3 Walk the state matrix and confirm each of the seven states renders as a real screen — the check v1 could not pass.
- [ ] 6.4 Run a contrast check on the metadata lines specifically, on both `--bg` and `--card` and in both themes, since that is the known regression.
- [ ] 6.5 Confirm every deep link resolves to the state its parameter names.
- [ ] 6.6 Confirm no page references anything external and every page renders over `file://` with no build step and no network, matching v1.
- [ ] 6.7 Confirm `experiments/mobile-tasks-mockups/` is unmodified by this change, so the baseline the findings describe still exists.
- [ ] 6.8 Confirm task 5.1 remains unchecked if the reference image has not arrived, and that the documentation says so plainly rather than implying alignment was verified.
