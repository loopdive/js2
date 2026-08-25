---
id: 4665
title: "ES5 standalone: the dynamic-pattern refusal is the GENERAL runtime-grammar gap — regexp-dynamic-pattern.ts recognises only literals, `.`, `|` and CharacterEscapes"
status: ready
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp
goal: standalone-gap
related: [4654, 682, 4492]
origin: "split out of #4654 part C. The #4654 issue ASKED whether the refusal was narrow for these specific patterns; the lane MEASURED that it is not, and the table below is that measurement."
# The dynamic compiler owns the runtime RegExp representation and all four
# token walks. This bounded group-envelope step must update those walks and the
# SAVE-slot constructor in place; moving it would duplicate the grammar/plumbing
# boundary and risk the same count/emission drift this issue is fixing.
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/codegen/regexp-dynamic-pattern.ts::ensureDynamicPatternTokenDecoder
---

## Problem

`TypeError: Unsupported dynamic regular expression pattern` is an explicit refusal in
the standalone RegExp backend (#682's dual backend). #4654 asked whether the refusal
was narrow for its specific rows. **Measured answer: it is not.**

`src/codegen/regexp-dynamic-pattern.ts` recognises literals, `.`, `|` and
`CharacterEscape`s, and refuses everything else.

| row | pattern that refuses | missing feature |
| --- | --- | --- |
| `built-ins/RegExp/S15.10.2_A1_T1.js` | `[^<]+` | character classes + `+` |
| `built-ins/RegExp/S15.10.2.8_A3_T15.js`, `…_T16.js` | 200 nested `(`…`)` | capture groups |
| `annexB/built-ins/RegExp/…-control-escape-russian-letter.js` | `\c*`, `\c+`, `\c?` | quantifiers |

Two corrections from the lane, both worth keeping:

- **`S15.10.2_A1_T1.js` is NOT a distinct root**, as #4654 suspected it might be. It is
  part of this gap and fails with the identical `#0: … [^<]+` message before and after
  the #4654 fix.
- **The Annex B `\c`-not-followed-by-an-ASCII-letter rule is already implemented** — see
  the grammar table in `regexp-dynamic-pattern.ts`. Despite its name, that file's rows
  refuse on the **metacharacters in the ASCII half of its generator**, not on `\c`.

## Not in scope — three part-C rows with different roots

Filed here only so they are not re-attributed to this gap:

- `built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js` — `new RegExp.prototype.constructor`
  → `TypeError: is not a constructor`. **Builtin-as-value family (#4492 lane).**
- `built-ins/RegExp/S15.10.4.1_A6_T1.js` — needs `Object.prototype.toString`, which
  reports `not yet implemented in --target standalone`. Separate family.
- `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js` — `__re.lastIndex = {valueOf(){throw "intoint"}}`
  must **store** the object (§22.2.7.1) and coerce inside `exec`. The standalone
  `$StandaloneRegExp` struct types `lastIndex` as an `f64` **field**, so the coercion
  happens at **assignment** — one statement above the test's `try`, which is why the raw
  `"intoint"` escapes uncaught. **A value-representation change to the regexp struct, not
  a coercion bug.**

## Implementation Plan

Grow the runtime grammar in `src/codegen/regexp-dynamic-pattern.ts`. Order by
rows-per-unit-of-risk, and land incrementally — each step is independently shippable:

1. **Quantifiers** (`*`, `+`, `?`, `{n,m}`, and their lazy forms). Smallest grammar
   delta; unblocks the Annex B row.
2. **Character classes** (`[...]`, `[^...]`, ranges, class escapes). Unblocks
   `S15.10.2_A1_T1.js`.
3. **Capture groups** (`(`…`)`, plus non-capturing `(?:`…`)`). The `_T15`/`_T16` rows use
   **200 nested groups**, so whatever you build must not be recursive-descent with a
   per-group stack frame that blows at that depth — check the depth bound explicitly.

Every step keeps the refusal fail-closed for what it still cannot parse: a pattern the
grammar does not recognise must continue to raise the explicit `TypeError`, never
compile to something that silently matches differently.

## Acceptance

- The rows in the table above pass in standalone, step by step.
- The `_T15`/`_T16` depth case is verified at its **actual** 200-group depth, not a
  reduced-depth proxy.
- Unrecognised patterns still refuse explicitly (add a pin for one).
- Blast-radius sweep per `plan/method/es5-standalone-agent-brief.md`: this widens a
  parser that gates a whole backend, so the sweep covers `built-ins/RegExp`,
  `annexB/built-ins/RegExp` and `language/literals/regexp`.
- The three not-in-scope rows above are **not** claimed as fixed by this issue.
