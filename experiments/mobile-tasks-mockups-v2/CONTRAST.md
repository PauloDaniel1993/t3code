# Contrast measurements

These ratios were computed from the literal token values in `mockup.css` using the WCAG 2.x relative-luminance method. For each 8-bit sRGB component, first set `sRGB = component / 255`, then calculate:

```text
linear = sRGB / 12.92                              when sRGB <= 0.04045
linear = ((sRGB + 0.055) / 1.055) ^ 2.4           otherwise
L = 0.2126 * Rlinear + 0.7152 * Glinear + 0.0722 * Blinear
contrast = (max(L1, L2) + 0.05) / (min(L1, L2) + 0.05)
```

The pass threshold is **4.5:1**. Ratios below are rounded to four decimal places for display; PASS/FAIL was evaluated using the unrounded result.

The text-token inventory is `--fg`, `--muted`, `--dim`, `--info`, `--success`, `--warn`, `--danger`, `--teal`, `--violet`, and `--coral`. `--info` and `--teal` are included because the stylesheet uses them as text colors; the reserved `--violet` and `--coral` accents are conservatively treated as text-capable too. `--primary` is only a control background. The three status tokens are included even where a later page will supply their first text use.

## V1 `--dim` baseline (before)

| Theme     | Text token | Text value | Surface token | Surface value |    Ratio | Result |
| --------- | ---------- | ---------- | ------------- | ------------- | -------: | ------ |
| Dark (v1) | `--dim`    | `#6b7280`  | `--bg`        | `#0a0a0a`     | 4.0952:1 | FAIL   |
| Dark (v1) | `--dim`    | `#6b7280`  | `--card`      | `#101013`     | 3.9291:1 | FAIL   |

The proposal's claimed 4.15:1 and 3.98:1 values did not reproduce. The WCAG 2.x computation above yields 4.0952:1 and 3.9291:1 (4.10:1 and 3.93:1 when rounded to two decimal places). Both the claimed and measured values fail 4.5:1, but the measured values are retained here rather than silently adopting the claims.

## Dark theme (v2)

| Text token  | Text value | Surface token | Surface value |     Ratio | Result |
| ----------- | ---------- | ------------- | ------------- | --------: | ------ |
| `--fg`      | `#f1f3f7`  | `--bg`        | `#0a0a0a`     | 17.8216:1 | PASS   |
| `--fg`      | `#f1f3f7`  | `--card`      | `#101013`     | 17.0987:1 | PASS   |
| `--muted`   | `#a3a3a3`  | `--bg`        | `#0a0a0a`     |  7.8486:1 | PASS   |
| `--muted`   | `#a3a3a3`  | `--card`      | `#101013`     |  7.5302:1 | PASS   |
| `--dim`     | `#787e8a`  | `--bg`        | `#0a0a0a`     |  4.8552:1 | PASS   |
| `--dim`     | `#787e8a`  | `--card`      | `#101013`     |  4.6583:1 | PASS   |
| `--info`    | `#60a5fa`  | `--bg`        | `#0a0a0a`     |  7.7871:1 | PASS   |
| `--info`    | `#60a5fa`  | `--card`      | `#101013`     |  7.4712:1 | PASS   |
| `--success` | `#34d399`  | `--bg`        | `#0a0a0a`     | 10.2985:1 | PASS   |
| `--success` | `#34d399`  | `--card`      | `#101013`     |  9.8808:1 | PASS   |
| `--warn`    | `#fbbf24`  | `--bg`        | `#0a0a0a`     | 11.8597:1 | PASS   |
| `--warn`    | `#fbbf24`  | `--card`      | `#101013`     | 11.3786:1 | PASS   |
| `--danger`  | `#f87171`  | `--bg`        | `#0a0a0a`     |  7.1573:1 | PASS   |
| `--danger`  | `#f87171`  | `--card`      | `#101013`     |  6.8670:1 | PASS   |
| `--teal`    | `#2dd4bf`  | `--bg`        | `#0a0a0a`     | 10.6356:1 | PASS   |
| `--teal`    | `#2dd4bf`  | `--card`      | `#101013`     | 10.2042:1 | PASS   |
| `--violet`  | `#c084fc`  | `--bg`        | `#0a0a0a`     |  7.4926:1 | PASS   |
| `--violet`  | `#c084fc`  | `--card`      | `#101013`     |  7.1887:1 | PASS   |
| `--coral`   | `#e0764e`  | `--bg`        | `#0a0a0a`     |  6.4776:1 | PASS   |
| `--coral`   | `#e0764e`  | `--card`      | `#101013`     |  6.2149:1 | PASS   |

The replacement `--dim` remains visually subordinate to `--muted`: its measured contrast is lower on both dark surfaces while still clearing 4.5:1.

## Light theme (v2)

| Text token  | Text value | Surface token | Surface value |     Ratio | Result |
| ----------- | ---------- | ------------- | ------------- | --------: | ------ |
| `--fg`      | `#18181b`  | `--bg`        | `#f7f7f8`     | 16.5480:1 | PASS   |
| `--fg`      | `#18181b`  | `--card`      | `#ffffff`     | 17.7168:1 | PASS   |
| `--muted`   | `#52525b`  | `--bg`        | `#f7f7f8`     |  7.2199:1 | PASS   |
| `--muted`   | `#52525b`  | `--card`      | `#ffffff`     |  7.7298:1 | PASS   |
| `--dim`     | `#6b6b73`  | `--bg`        | `#f7f7f8`     |  4.9335:1 | PASS   |
| `--dim`     | `#6b6b73`  | `--card`      | `#ffffff`     |  5.2820:1 | PASS   |
| `--info`    | `#1d4ed8`  | `--bg`        | `#f7f7f8`     |  6.2595:1 | PASS   |
| `--info`    | `#1d4ed8`  | `--card`      | `#ffffff`     |  6.7016:1 | PASS   |
| `--success` | `#047857`  | `--bg`        | `#f7f7f8`     |  5.1221:1 | PASS   |
| `--success` | `#047857`  | `--card`      | `#ffffff`     |  5.4839:1 | PASS   |
| `--warn`    | `#8a5a00`  | `--bg`        | `#f7f7f8`     |  5.5360:1 | PASS   |
| `--warn`    | `#8a5a00`  | `--card`      | `#ffffff`     |  5.9270:1 | PASS   |
| `--danger`  | `#b91c1c`  | `--bg`        | `#f7f7f8`     |  6.0432:1 | PASS   |
| `--danger`  | `#b91c1c`  | `--card`      | `#ffffff`     |  6.4700:1 | PASS   |
| `--teal`    | `#0f766e`  | `--bg`        | `#f7f7f8`     |  5.1122:1 | PASS   |
| `--teal`    | `#0f766e`  | `--card`      | `#ffffff`     |  5.4733:1 | PASS   |
| `--violet`  | `#7e22ce`  | `--bg`        | `#f7f7f8`     |  6.5226:1 | PASS   |
| `--violet`  | `#7e22ce`  | `--card`      | `#ffffff`     |  6.9833:1 | PASS   |
| `--coral`   | `#b45309`  | `--bg`        | `#f7f7f8`     |  4.6903:1 | PASS   |
| `--coral`   | `#b45309`  | `--card`      | `#ffffff`     |  5.0216:1 | PASS   |

The light `--dim` is also subordinate to light `--muted` on both surfaces while remaining above 4.5:1. The light status variants retain green, amber, and red identities respectively.

---

## Shared-chrome fixes (task 1.6b)

Measured from the literal values in `mockup.css` after the chrome revision, same WCAG 2.x
method as above. These complement the token tables above, which still hold: the chrome fixes
changed surfaces and component colors, not the text-token set.

### Compose FAB (WCAG 1.4.11 non-text contrast, 3:1 minimum)

Before: one hardcoded surface `#f2f2f4` for both themes. Against the light page `#f7f7f8` that
is roughly **1.04:1** — the FAB was invisible in light theme. After: per-theme `--fab-bg` /
`--fab-fg` — white in dark (unchanged, matches `reference-mobile.png`), dark charcoal in light.

| Theme | Pair              | Values                 |     Ratio | Result |
| ----- | ----------------- | ---------------------- | --------: | ------ |
| Dark  | surface vs screen | `#f2f2f4` on `#000000` | 18.7826:1 | PASS   |
| Dark  | glyph vs surface  | `#111113` on `#f2f2f4` | 16.8694:1 | PASS   |
| Light | surface vs page   | `#18181b` on `#f7f7f8` | 16.5480:1 | PASS   |
| Light | surface vs screen | `#18181b` on `#ffffff` | 17.7168:1 | PASS   |
| Light | glyph vs surface  | `#fafafa` on `#18181b` | 16.9739:1 | PASS   |

### Repo avatar initials (text, 4.5:1 minimum)

The review measured white-on-avatar at 5.64:1 for the default hue 215 and 2.36:1 at a warm hue 60. Re-measured here: **5.6124:1** at 215 (reproduces) and **1.9978:1** at 60 (the claimed 2.36
does not reproduce at exactly hue 60; either way it fails badly, and the fix is the same).

Chosen fix: **both** mechanisms. Lightness drops 45% → 38%, and the hue set is constrained to
**200–260** (documented as a hard rule in `CONVENTIONS.md` §7; the scenario's only hues are 215
and 255, and pages may not invent repos). Lightness alone could not keep the vivid reference
blue and pass at every hue — yellow at 65% saturation needs ≤ 28% lightness, which turns the
signature T3 icon navy; the constraint keeps the failure impossible rather than merely measured.

| Formula              | Hue                          | White-on-avatar ratio | Result                          |
| -------------------- | ---------------------------- | --------------------: | ------------------------------- |
| old `hsl(h 65% 45%)` | 215 (default)                |              5.6124:1 | PASS                            |
| old `hsl(h 65% 45%)` | 60 (worst of all hues)       |              1.9978:1 | FAIL                            |
| new `hsl(h 65% 38%)` | 200 (worst inside 200–260)   |              5.0469:1 | PASS                            |
| new `hsl(h 65% 38%)` | 215                          |              7.1954:1 | PASS                            |
| new `hsl(h 65% 38%)` | 255                          |             10.7023:1 | PASS                            |
| new `hsl(h 65% 38%)` | 260                          |             10.2882:1 | PASS                            |
| new `hsl(h 65% 38%)` | 60 (outside the allowed set) |              2.7867:1 | FAIL — excluded by the hue rule |

At 215 the avatar moves from `rgb(40,102,189)` to `rgb(34,86,160)` — a modest darkening, still
visibly the reference blue.

### Header chrome text (4.5:1 minimum)

The ALPHA pill returns to v1's opaque `#1b1b1f` (tokenized as `--alpha-bg`), which requires its
own text token: `--dim` on that pill measures only 4.2104:1. `--alpha-fg` restores v1's exact
pair. The search field (`--well`) and header buttons (`--btn`) likewise return to v1's traced
values; their text was re-measured on the restored surfaces.

| Theme | Pair                                      | Values                          |    Ratio | Result |
| ----- | ----------------------------------------- | ------------------------------- | -------: | ------ |
| Dark  | ALPHA text vs pill                        | `#8a8a90` on `#1b1b1f`          | 5.0024:1 | PASS   |
| Dark  | search placeholder vs field               | `--dim #787e8a` on `#121215`    | 4.5856:1 | PASS   |
| Dark  | header button icon vs button              | `--muted #a3a3a3` on `#17171a`  | 7.0918:1 | PASS   |
| Dark  | `--dim` vs pill (why `--alpha-fg` exists) | `#787e8a` on `#1b1b1f`          | 4.2104:1 | FAIL   |
| Light | ALPHA text vs chip composite              | `#52525b` on `rgb(239,239,239)` | 6.7131:1 | PASS   |
| Light | search placeholder vs field               | `--dim #6b6b73` on `#f0f0f2`    | 4.6409:1 | PASS   |
| Light | header button icon vs button              | `--muted #52525b` on `#f0f0f2`  | 6.7917:1 | PASS   |

### Translucent surfaces

`.sheet`, `.pcard`, `.toast`, `.concept`, `.backlink` are translucent again via
`color-mix(in srgb, var(--card|--bg) N%, transparent)`, so their `backdrop-filter` blur has
show-through in both themes. Text on them was re-checked against the worst-case composite (the
surface over the darkest possible backdrop): `--dim` on the dark sheet composite
`rgb(15,15,18)` measures **4.6921:1** PASS; `--dim` on the light pill composite measures
**4.9335:1** PASS. All other text tokens sit higher than `--dim` (tables above), so they pass
on these surfaces too.

Non-text changes in the same pass (no contrast implication, recorded for completeness): the
hairline separators return to v1's `rgba(255,255,255,0.05)` in dark (`--hairline`), the thread
row hover to `rgba(255,255,255,0.025)` (`--row-hover`), the gesture bar to opacity 0.6
(composite `rgb(72,76,83)`, v1: `rgb(77,77,77)`), and the phone bezel keeps its dark physical
frame with only its cast shadow themed (`--bezel-shadow`).

---

## Effective contrast — what this file measures, and what it cannot (T7)

The token tables above measure **token against token at full opacity**. Two of the three real
contrast defects found in the v2 run were invisible to that method, because they came from
**rendering effects applied on top of the tokens**:

1. **An `opacity` multiplier.** `.sh-composer.disabled { opacity: 0.65 }` composited every text
   inside the disabled composer 35% toward the background. The token table says `--dim` passes
   on the sheet composite (4.69:1); the _effective_ text measured 2.65:1. Token tables cannot
   see this — the measurement has to be redone on the composited color.
2. **An `hsl()` hue variable.** `.picon` is `hsl(var(--h) 65% 38%)` — the avatar's luminance is
   a function of a runtime parameter, not a token. That is why §7.5 constrains `--h` to 200–260
   and why the table above measures the _formula's_ worst case instead of a value.
3. **Translucency.** Elevated surfaces (`--sheet-bg` etc.) are `color-mix` percentages over
   whatever is behind them; the tables measure them against the worst-case composite (stated
   above), which is the only honest way — but it is a modeled composite, not a pixel sample.

**Rule this file now follows:** any text rendered through an effect (opacity, blend, tint,
composite) must be measured at its _effective_ color, and the effect must be named in the
table. Token-vs-token tables are the necessary minimum, not the sufficient one.

### The disabled-composer defect and its fix (measured)

The mandatory disabled-composer reason sentence (CONVENTIONS.md §7.2) is the one text the
non-steerability requirement exists to keep legible. With the old `opacity: 0.65`:

| Surface                                 | Text                               | Effective text     | Background         |    Ratio | Result |
| --------------------------------------- | ---------------------------------- | ------------------ | ------------------ | -------: | ------ |
| Dark sheet                              | `--dim` at 0.65 over the composite | `rgb(83,87,96)`    | `rgb(15,15,18)`    | 2.6492:1 | FAIL   |
| Light sheet                             | `--dim` at 0.65 over the composite | `rgb(156,156,161)` | `rgb(247,247,247)` | 2.5460:1 | FAIL   |
| Dark card (flow-3 standalone composer)  | `--dim` at 0.65                    | `rgb(84,88,96)`    | `#101013`          | 2.6439:1 | FAIL   |
| Light card (flow-3 standalone composer) | `--dim` at 0.65                    | `rgb(156,156,161)` | `#ffffff`          | 2.6410:1 | FAIL   |

The fix keeps the disabled read in the send pill and drops the opacity entirely
(`.sh-composer.disabled .sh-send` greys via `--border2`; `.composer.disabled .send` mirrors
it). The note text then measures at full strength — the token-table values, now actually true:

| Surface                | Pair                                                           |    Ratio | Result     |
| ---------------------- | -------------------------------------------------------------- | -------: | ---------- |
| Dark sheet             | `--dim` on the sheet composite `rgb(15,15,18)`                 | 4.6921:1 | PASS       |
| Light sheet            | `--dim #6b6b73` on the sheet composite `rgb(247,247,247)`      | 4.9126:1 | PASS       |
| Dark card              | `--dim` on `--card #101013`                                    | 4.6583:1 | PASS       |
| Light card             | `--dim #6b6b73` on `--card #ffffff`                            | 5.2820:1 | PASS       |
| Dark sheet (non-text)  | disabled send glyph: `--dim` on `--border2` over the composite | 3.1999:1 | PASS (3:1) |
| Light sheet (non-text) | disabled send glyph: `--dim` on `--border2` over the composite | 3.3832:1 | PASS (3:1) |

The greyed send glyph is a non-text UI indicator (WCAG 1.4.11, 3:1 minimum); the _meaning_ of
the disabled control is carried by the adjacent reason sentence at 4.69:1 or better, per §7.2.
