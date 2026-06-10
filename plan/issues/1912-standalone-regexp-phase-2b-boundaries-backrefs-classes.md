---
id: 1912
title: "standalone RegExp Phase 2b: word boundaries, backrefs, and character-class compatibility"
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
language_feature: regexp
goal: standalone-mode
related: [1909, 1539, 682, 1474]
test262_bucket: standalone-regexp-phase-2b
test262_count: 104
---

# #1912 — Standalone RegExp Phase 2b parser/runtime features

## Problem

The standalone RegExp matcher still refuses Phase 2b pattern features and some
ES-compatible character-class forms. Current samples include word-boundary
assertions, backreferences, negated shorthand inside character classes, and
class range compatibility cases.

Representative signatures from the 2026-06-07 standalone JSONL:

- `word-boundary \b — #1539 Phase 2b`.
- `word-boundary \B — #1539 Phase 2b`.
- `backreference \# — #1539 Phase 2b`.
- `negated shorthand \W inside [...] — #1539 Phase 2b`.
- `class range out of order`.

## Scope

- Add the missing bytecode/VM support for word-boundary assertions and
  backreferences, or keep narrowed refusals if a smaller native-engine slice
  lands first.
- Reconcile parser behavior for legacy character-class forms that test262
  accepts outside Unicode mode.
- Keep this distinct from Phase 2d Unicode/lookaround work.

## Acceptance Criteria

- Representative boundary/backreference/class compatibility tests pass in
  standalone mode or move to a more precise residual bucket.
- Refusals remain compile-time diagnostics with no JS-host RegExp imports.
- Focused tests cover both pattern parsing and Wasm execution.

## Implementation Notes (fable-rx-engine, 2026-06-10)

Landed in the pure-WasmGC matcher (no host imports, dual-implemented in the
TS reference VM and the Wasm VM, mirrored opcode-for-opcode):

- **Word boundaries `\b` / `\B`** — new `ReOp.WBOUND [negated, 0]`
  (§22.2.2.6 IsWordChar, ASCII). The Wasm arm reuses the dispatch-head `CH`
  ("after" unit) and guards the "before" read so out-of-bounds neighbours
  never trap; `matched = boundary ^ negated`.
- **Backreferences `\1`…`\99` + `\k<name>`** — new `ReOp.BACKREF
[groupIdx, ci]` (§22.2.2.9). An unset group matches empty (forward refs
  like `\1(a)` work). The `i` flag compares ASCII-folded units (operand b),
  consistent with `CHARI`. A pre-scan pass counts groups + named-group table
  before the descent parse, because DecimalEscape classification needs the
  WHOLE pattern's capture count and `\k<name>` may forward-reference.
- **Annex B decimal-escape fallback** — `\N` beyond the capture count is a
  legacy octal escape (`\05`, `(a)\2` → `\x02`); `\8` `\9` are identity.
  `\cX` control letters and class-internal octals also land.
- **Negated shorthand in classes** (`[\D]` `[\W]` `[\S]`) — complemented to
  plain ranges at compile time (`complementRanges` over [0, 0xFFFF]) since the
  run-length class table is a union of ranges.
- **Annex B class hyphen compatibility** — `[\d-z]` / `[a-\d]` treat the `-`
  adjacent to a shorthand as a LITERAL `-` (never a range). This also fixes a
  silent 2a mis-parse where `[\d-z]` became the range U+002D–U+007A.
- **Runtime SyntaxError lowering (the "class range out of order" bucket)** —
  the S15.10.1/S15.10.2.15 families construct INVALID patterns via
  `new RegExp("[b-ac-e]")` and assert a _catchable runtime SyntaxError_.
  `compileStandaloneRegExpConstructor` now consults the compile-time host
  `RegExp` constructor as a spec-exact validity oracle: host-rejected
  (pattern, flags) pairs lower to `__new_SyntaxError` + `throw` + `unreachable`
  at the construction site (§22.2.3.2), instead of failing the compile. The
  `unreachable` makes the post-throw stack polymorphic so the claimed
  `$NativeRegExp` result type validates without materializing a struct.
  Host-VALID patterns outside the matcher subset keep the compile-time
  narrowed refusal. Regex _literals_ keep the compile diagnostic (early
  error). Invalid flags (`"gg"`) ride the same path.
- **Quantified assertions** (`\b*`, `^*`) are genuine SyntaxErrors (verified
  against V8) and now refuse at parse instead of emitting a zero-progress
  SPLIT loop that would spin to the step cap.

Known residual (pre-existing 2a behavior, unchanged): a star/plus whose body
can match empty (`/(a?)*/`, `/\1*/` with an unset group) backtracks to the
1M step cap and reports no-match instead of matching empty — needs an
empty-progress check instruction (left to a matcher-hardening follow-up).

Validation: `tests/regex-bytecode.test.ts` (#1912 dual-run corpus, 23
patterns vs native), `tests/issue-1912-regex-phase2b.test.ts` (end-to-end
standalone Wasm with empty import object + runtime-SyntaxError probes),
existing 1539/1474/682 regex suites all green.
