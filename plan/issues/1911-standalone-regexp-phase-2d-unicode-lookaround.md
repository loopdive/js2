---
id: 1911
title: "standalone RegExp Phase 2d: u/v/d flags, Unicode escapes, lookaround, modifiers"
status: done
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-10
completed: 2026-06-10
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

## Implementation Notes — Slice B (fable-rx-engine, 2026-06-10)

Landed as planned (stacked on Slice A / PR #1308): u/v code-point semantics
via COMPILE-TIME host enumeration (`src/codegen/regex/unicode.ts`):

- Class-like atoms (`[...]`, `\p{…}`/`\P{…}`, shorthands, ui single chars)
  resolve into exact code-point range sets by scanning the class source with
  `g`+`u`/`v` flags over a one-time string of every non-surrogate code point
  (~10-300ms per unique class, cached; the 2048 lone surrogates probed
  individually). The host is V8 — full property tables and Canonicalize
  folding for free (Kelvin sign, σ/ς/Σ, \w ui ſ/K, v-mode set operations,
  class negation incl. lone surrogates). Host participates only at COMPILE
  time; the module stays pure Wasm.
- Range sets desugar regexpu-style into the unit-level VM AST: BMP class +
  astral surrogate-pair alternations + lone-surrogate arms guarded by the
  Slice A lookarounds (`lead(?!trail)` / `(?<!lead)trail`). One code point
  per match, so quantifiers iterate by code point.
- Parser u/v mode: `\u{…}`, `\uHHHH` escape-pair combining, literal astral
  pairs as one atom, strict DecimalEscape, modifier-scoped `i` threading
  into enumeration, compile-time `udot` (modifier-scoped dotAll).
- u/v literals host-pre-validate (invalid → compile refusal); ctor sites
  already lower to runtime SyntaxError (#1912).

Fail-loud residuals (documented refusals, NOT silent wrongness):

- `\b`/`\B` under u+i (VM IsWordChar is ASCII; ui adds ſ/K).
- Backreferences under u+i (VM folds ASCII; spec needs Canonicalize).
- `\q{…}` string disjunctions in v mode (match strings, not code points).
- Pre-existing 2a engine residual: star/plus with empty-matching bodies
  backtrack to the step cap (needs an empty-progress check op).

Validation: tests/regex-bytecode.test.ts + tests/issue-1911-regex-phase2d.test.ts
Slice B sections (astral dot/classes, property escapes, Kelvin/sigma folds,
v-mode subtraction, lone surrogates, literal-refusal + ctor-SyntaxError
probes); full scoped regex suite 645 tests green.
