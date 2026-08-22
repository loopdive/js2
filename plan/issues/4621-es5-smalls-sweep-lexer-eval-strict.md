---
id: 4621
title: "ES5 standalone: smalls sweep — regexp-literal lexing code-units, strict eval/arguments-assignment TypeErrors, switch(null), with-scope writes, comment compile-timeouts, Math_random host-import CE (~35 rows)"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: misc
goal: standalone-gap
related: [4426, 4484, 4485]
origin: "2026-08-16 residual map at 97.26%. Long-tail buckets grouped into bounded slices."
---

# #4621 — ES5 smalls sweep

## Problem (measured 2026-08-16) — seven bounded families

- **A — regexp-literal lexing (7)**: `S7.8.5_A*_T2` + annexB
  `RegExp-{leading,trailing}-escape-BMP` — "Code unit: 0 Expected
  SameValue(«undefined», …)": the literal's source/exec on escape shapes
  loses code units; plus `RegExp-control-escape-russian-letter` +
  "Unsupported dynamic regular expression pattern" (2 in built-ins/RegExp).
- **B — strict-mode eval/arguments assignment TypeErrors (~4)**:
  `10.2.1.1.3-4-16-s`/-18-s etc. — assigning to an immutable binding in
  strict code must throw TypeError.
- **C — global-object value props round 2 (2)**: `S10.2.3_A1.1/1.2_T3`
  `Date === null` — the #4485-B carrier family for CONSTRUCTOR globals
  (needs callable with own length/name/prototype; #4485's residual
  recorded exactly this).
- **D — operator smalls round 2 (~8)**: `switch(null)` (2 — null case
  dispatch), `equals/does-not-equals` ToPrimitive-order rows (2),
  `addition S11.6.1_A3.2_T2.4` (`new String("1") + null`), `in` rows (2 —
  may be #4506-walled, verify), `new/S11.2.2_A4_T5` (`new new Math()`
  TypeError).
- **E — with-scope writes (2)**: `S12.10_A5_T4/T5` `x === 1` got
  undefined — a WRITE inside `with` to an outer var.
- **F — compile timeouts (2)**: `comments/S7.4_A5/A6` (10s timeout —
  pathological comment lexing; likely a lexer loop, diagnose with a
  smaller repro).
- **G — Math_random host-import CE (1)**: `S15.8.2.14_A1` — standalone
  emitted `env::Math_random`; needs a native PRNG (spec allows any
  implementation-defined randomness; a simple xorshift seeded
  deterministically is acceptable) or decline-with-skip.
- **H — try/throw property-on-null (2 + throw twin)**: `S12.14_A18_T6`,
  `S12.13_A2_T6` — catch-parameter object property access.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; F (timeouts) and G (CE) are crash/CE class — first.
2. F: reduce the comment shape; fix the lexer loop bound.
3. A: the regexp LITERAL path (lexer→pattern encoding); compare with the
   dynamic-pattern path; the escape families are table-driven.
4. B: strict-assignment machinery from #4484-C (spec-non-writable arm) —
   extend to immutable env-record bindings.
5. C: extend the #4485-B carrier family per its residual note (callable
   constructor carriers).
6. D/E/H: per-row; E reads the with-statement lowering (#1387-guarded) —
   the write-through arm for proven-closed shapes.
7. Verify: per-family scoped runs before/after (own runs); pins
   4484/4485 + regexp suites green; ≥18 of ~35 flip, zero regressions;
   residuals with owners.
