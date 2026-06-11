---
id: 1911
title: "standalone RegExp Phase 2d: u/v/d flags, Unicode escapes, lookaround, modifiers"
status: in-progress
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp-unicode, regexp-lookaround
goal: standalone-mode
related: [1909, 1539, 682, 1474, 1444]
test262_bucket: standalone-regexp-phase-2d
test262_count: 833
---

# #1911 — Standalone RegExp Phase 2d

## Problem

The standalone RegExp residual bucket still contains high-volume syntax and
semantic families that the pure-Wasm matcher explicitly defers to Phase 2d:
`u`/`v`/`d` flags, Unicode property escapes, UnicodeSets, lookahead/lookbehind,
and regexp modifiers.

Representative signatures from the 2026-06-07 standalone JSONL:

- `flags "u" (u/v/d are #1539 Phase 2d)` in property-escape and Unicode tests.
- `flags "v" (u/v/d are #1539 Phase 2d)` in UnicodeSets tests.
- `lookahead (?= / ?!) — #1539 Phase 2d`.
- `unsupported group form '(?-' — #1539 Phase 2d` in regexp-modifier tests.

## Scope

- Implement or embed the native-engine path needed for these Phase 2d pattern
  forms in standalone mode.
- Preserve compile-time refusals for forms that remain unsupported; do not route
  them back to JS-host imports.
- Keep the classifier bucket focused on Phase 2d diagnostics.

## Acceptance Criteria

- Representative `u`/`v`/`d`, Unicode property, lookaround, and modifier
  test262 rows leave the `standalone-regexp-phase-2d` bucket.
- Any remaining refusals cite the specific follow-up phase or issue.
- Focused standalone tests prove no `env.RegExp_*` host import is emitted.

## Implementation Notes — Slice A (fable-rx-engine, 2026-06-10)

Landed (stacked on #1912 / PR #1300):

- **Lookahead `(?=) (?!)` + lookbehind `(?<=) (?<!)`** — new
  `ReOp.LOOKAROUND [subPc, bit0 negated | bit1 behind]`. Bodies compile to
  SUB-PROGRAMS appended after the main MATCH; the VM runs them as a fresh
  anchored attempt via a _recursive_ `__regex_run` call (new `entryPc` + `dir`
  params), which is what makes assertions atomic — no backtrack entries leak
  into the outer attempt. Lookbehind bodies are compiled REVERSED (concat
  order flipped, capture SAVE slots swapped so spans stay [left, right]) and
  run with direction -1, reading the unit at sp-1 — the Irregexp approach.
  Backrefs inside lookbehind match right-to-left. Captures from a successful
  positive lookaround persist; all other outcomes restore the pre-assertion
  capture snapshot (§22.2.2.4).
- **Direction-aware Wasm VM** — the dispatch head computes a per-step
  `inb`/unit pair from `dir`; CHAR/CHARI/ANY/CLASS/BACKREF advance `sp += dir`.
  (Found and fixed during this slice: the CHAR/CHARI arms had their own inline
  `sp+1` advance separate from `advance1()` — multi-unit lookbehind walked the
  wrong way until they were unified.)
- **Inline modifier groups `(?ims-ims:…)`** (regexp-modifiers proposal) —
  pure compile-time flag scoping: the bytecode emitter's i/m/s state nests
  with the group; lookaround bodies snapshot the modifier state at their
  syntactic position since they compile later. Invalid modifier syntax
  (`(?I:`, duplicates, both-sides, empty) refuses at parse and lowers to a
  runtime SyntaxError at `new RegExp(...)` sites via the #1912 host oracle.
- **Quantified lookarounds** (Annex B QuantifiableAssertion) rewrite to their
  zero-width-idempotent equivalent at parse (`X*` → `X?`, `X+` → `X`,
  `X{0,0}` → ε) — correct because a lookaround is deterministic at a fixed
  position, and it avoids a zero-progress SPLIT loop.
- **`d` flag accepted** — no matching-semantics change; the `.indices` result
  surface belongs to #1914 (fable-rx-surface).

## Remaining — Slice B (u/v code-point semantics)

- `u` flag: `\u{…}` escapes, astral code points via surrogate-pair
  desugaring (regexpu-style alternation), code-point `.`, Unicode case
  folding for `i`.
- `\p{…}`/`\P{…}` property escapes — planned approach: expand to plain
  range lists at COMPILE TIME by enumerating code points against the host
  `RegExp` (the compiler runs on Node; no runtime tables, no host imports),
  then astral-desugar. Cache per (class, flags).
- `v` flag (UnicodeSets): same host-enumeration approach for char-class
  semantics; `\q{…}` string disjunctions stay refused.
- Negative u/v syntax tests already pass via the #1912 host-oracle runtime
  SyntaxError lowering at `new RegExp(...)` sites.
