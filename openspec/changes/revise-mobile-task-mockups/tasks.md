## 1. Scaffold and Shared Chrome

- [x] 1.1 Create `experiments/mobile-tasks-mockups-v2/` as a sibling of `experiments/mobile-tasks-mockups/`, and confirm v1 stays byte-identical throughout this change.
- [x] 1.2 Fork `mockup.css` from v1 into v2 so the contrast fix is made once and inherited by every page.
- [x] 1.3 Measure the current `--dim: #6b7280` against `--bg: #0a0a0a` and `--card: #101013`, confirming the 4.15:1 and 3.98:1 failures, and record the measured baseline. _Measured 4.0953:1 and 3.9296:1 — both fail, but the proposal's 4.15/3.98 do not reproduce; `CONTRAST.md` records the measured values._
- [x] 1.4 Replace `--dim` with a value clearing 4.5:1 against **both** `--bg` and `--card`, and re-measure to confirm; verify `--muted: #a3a3a3` still passes on both surfaces. _`--dim: #787e8a` → 4.8552:1 / 4.6583:1; `--muted` → 7.8486:1 / 7.5302:1._
- [x] 1.5 Add a light theme token block, which v1 has none of, and measure every text token against its light-theme surfaces including the status hues `--success`, `--warn`, and `--danger`.
- [x] 1.6 Copy v1's Android chrome — status bar, "T3 Code · ALPHA" header, search field, thread row anatomy, compose FAB, gesture bar — as traced from `reference-mobile.png`, so v2's chrome stays faithful to the real app. _Reference fidelity restored via `--hairline`/`--row-hover`/`--well`/`--btn`/`--alpha-*` tokens after v1 values drifted during tokenization._
- [x] 1.7 Add `index.html` as the v2 landing page linking every artifact with its deep-link parameters, matching v1's `?param` convention. _Adds the `?theme=dark|light` convention used by every v2 page._

## 2. Converged Flow

- [x] 2.1 Build the thread-list entry screen from v1's option 1, carrying the disclosure chip, guide-line sub-rows, and expanded-group anatomy. _Adds `?groups=collapsed|expanded` and `?peek=<unit>`._
- [x] 2.2 Build the bottom-sheet peek screen from v1's option 2, keeping its honesty rules verbatim: identical anatomy for tasks and agents, a disabled composer with the reason in words, and "Show in transcript" for agents. _Found and worked around a shared-CSS contrast defect: `.sh-composer.disabled { opacity: 0.65 }` drops the mandatory reason text to ~2.66:1 (verified). Fix must be promoted into `mockup.css` — see 2.4._
- [x] 2.3 Build the full task view from v1's option 4's task half, which v1's own recommendation calls non-negotiable because "Open thread" must land somewhere. _Accepts `?state=running|complete|failed` and `?view=`; fixes v1's bare-"failed" a7 row by giving it a reason._
- [x] 2.4 Wire the three screens as one flow — list entry to peek to full view — with working deep links between them and no dead ends. _All three forward hops were silently dropping their payload; fixed by accepting `?task=` alongside each page's canonical param. The "four tasks, one page" dead end resolved by modelling all four tasks in flow-3._
- [x] 2.5 Confirm the three screens present one consistent visual language rather than three inherited dialects from their source variants. _Twelve divergences found and resolved; wording pinned in `CONVENTIONS.md` §7.7._

## 3. State Matrix

- [x] 3.1 Add the state matrix page rendering every state side by side on one page; this is the deliverable v1 lacked. _Seven phones, one state each, deep-linked by `?state=`._
- [x] 3.2 Render the queued-and-not-yet-started task state, distinguishable from running, failed, and complete.
- [x] 3.3 Render the single-agent case with singular wording and correct counters.
- [x] 3.4 Render the zero-failures case with no failure count and no failure styling.
- [x] 3.5 Render the all-agents-failed case honestly, without implying partial success, with each failure carrying its reason.
- [x] 3.6 Render the cancelled-mid-flight task state, distinguishable from both completion and failure. _Uses amber `⊖` counters, not red — cancelled agents were stopped, not failed._
- [x] 3.7 Render the result-returned-but-unread state, distinct from the read completed state. _Read sibling rendered in the same phone for direct comparison._
- [x] 3.8 Render the native in-session agent refusing steering **with the reason stated in words**, promoting v1's option 2 treatment from a nice touch to the required pattern. _Reason renders, but at ~2.66:1 — both disabled composers on this page inherit the shared `opacity: 0.65` defect. Fix pending in 2.4._
- [x] 3.9 Verify no rollup renders "0 of 0", no count of one is pluralised, and no failure styling appears when nothing has failed. _Swept across all six pages; the only matches are comments and captions naming the forbidden forms._
- [x] 3.10 Verify every failed agent anywhere in v2 carries a failure reason, not a bare failure marker; v1 shows a reason only in option 4. _All 8 `.wrow.failed` rows, flow-2's 5 sheet rows, both native-agent sheets, and the failed backdrop row carry reasons in words. `flow-1-list` renders no individual failed agent — its aggregate `× 4` counter is the sanctioned rollup form, with reasons one tap away._

## 4. Documentation

- [x] 4.1 Write `README.md` in v1's format covering the converged flow, the state matrix, and per-screen notes.
- [x] 4.2 Add an explicit "what changed from v1 and why" section citing the three findings: the tasks/agents reference was a description rather than a file, one hardcoded scenario, and the measured contrast failure. _Cites the measured 4.0952:1 / 3.9291:1 and notes plainly that the proposal's 4.15:1 / 3.98:1 do not reproduce._
- [x] 4.3 Re-state v1's unresolved data gaps (`README.md:155-190`) — cross-level rollup, turn identity in the list, ✓/× counters, ↩ semantics on a working row, push-notification parity, and agent-to-transcript lookup — since v2 resolves none of them.
- [x] 4.4 Re-state the open interaction questions carried from v1, including sheet versus push for the task-row tap.
- [x] 4.5 Write `HANDOFF.md` in v1's format, naming which references v2 was built from and which remain unavailable.
- [x] 4.6 Add per-screen `NOTES.md` files matching v1's per-option convention. _Written by each screen's author; T8 corrected eleven drift points, preserving the authors' reasoning and attributing each change._
- [x] 4.7 Record the measured contrast ratios for every text token on every surface in both themes, so the claim is checkable rather than asserted. _All 40 token rows independently recomputed and reproduced to four decimals._

## 5. Reference Alignment

- [ ] 5.1 **Blocked, and to remain unchecked until the input exists.** Align the tasks/agents visual language to the reference image once it is available; v1's `HANDOFF.md` confirms this reference was a written description rather than a file, so nothing in v1 or v2 is yet confirmed against it. Do not mark this complete without the image.

## 6. Verification

- [x] 6.1 Serve and open every v2 page at 390 px width in both themes, confirming each renders completely. _All six pages × both themes rendered in headless Chrome; no blank regions, collapsed layouts, console errors, or failed loads._
- [x] 6.2 Repeat at 320 px, the narrow sheet width, confirming no overflow, clipping, or unreadable collapse. _Initially failed: the centred 390 px `.phone` overflowed into unreachable negative coordinates (x = −38…352). Fixed with a `max-width: 389.98px` override pinning `.stage` to `flex-start`; re-verified at phone x = 24…414 on all five pages in both themes, with the right edge reachable at max scroll and 390 px geometry byte-identical._
- [x] 6.3 Walk the state matrix and confirm each of the seven states renders as a real screen — the check v1 could not pass. _All seven rendered and ring-selected correctly in both themes; each honesty rule confirmed as rendered._
- [x] 6.4 Run a contrast check on the metadata lines specifically, on both `--bg` and `--card` and in both themes, since that is the known regression. _Measured from computed styles: 4.8552 / 4.6583 dark, 4.9335 / 5.2820 light. All four disabled-composer reasons now render at opacity 1 and pass. Only hues 215 and 255 present, at 7.22:1 and 10.71:1._
- [x] 6.5 Confirm every deep link resolves to the state its parameter names. _Click-driven and direct navigation both verified, including a full light-theme round trip that retained theme and task identity across four hops._
- [x] 6.6 Confirm no page references anything external and every page renders over `file://` with no build step and no network, matching v1. _24 page loads, no external protocols, no failed requests; the v1 reference image resolves (945 × 2048, `complete: true`)._
- [x] 6.7 Confirm `experiments/mobile-tasks-mockups/` is unmodified by this change, so the baseline the findings describe still exists. _`git diff --exit-code HEAD -- experiments/mobile-tasks-mockups` returns 0._
- [x] 6.8 Confirm task 5.1 remains unchecked if the reference image has not arrived, and that the documentation says so plainly rather than implying alignment was verified. _Both `README.md` and `HANDOFF.md` state plainly that the reference never arrived and the alignment pass was not performed._
