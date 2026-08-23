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
loc-budget-allow:
  # Six families, six arms, each of which must sit inside an existing ORDERED
  # dispatch. Arm ORDER is the load-bearing property in every one of these
  # files, so an arm cannot be lifted into a subsystem module without lifting
  # the ordering decision with it — which is the bug class this campaign keeps
  # re-fixing, not a refactor it wants. Each entry is majority COMMENT: the
  # measured reason is longer than the emitted code.
  #
  #  - early-errors/node-checks.ts +37: two `on([...])` registrations plus the
  #    `nodeIsParserSynthesizedMissing` predicate. This file IS the early-error
  #    registry — a check that lives anywhere else is a check `runNodeChecks`
  #    never runs. Real code is ~12 lines; the rest explains why TS code 1109 is
  #    tolerated in compiler.ts and why re-raising exactly two parser-recovered
  #    zero-width shapes is sound.
  #  - statements/control-flow.ts +33: the NULL arm of `emitSwitchStrictEq`. It
  #    wraps the existing tag cascade (now a named `taggedCascade` array) in one
  #    `if`, ~11 instructions. It cannot move: the cascade closes over `lTmp`/
  #    `rTmp` and over the `refArm`/`identityArm` locals allocated in this
  #    function, and the arm must precede the tag dispatch.
  #  - native-strings.ts +31: the `ref.is_null → "null"` arm at the top of
  #    `__any_to_string`'s body. Five instructions. The helper is built here and
  #    cached under `nativeStrHelpers`; the arm has to be the FIRST test, ahead
  #    of the `$AnyString` / `$AnyValue` shape tests, so it is structurally part
  #    of this builder.
  #  - expressions/assignment.ts +30: the §19.1.1-19.1.3 bare-identifier arm.
  #    The predicate and the name table live in the subsystem module
  #    (`builtin-nonwritable-write.ts`, where #4484 C already put its twin);
  #    what stays here is the ~8-line call site plus the note on why it must sit
  #    above the `localMap` lookup and why the shadowing proof is load-bearing.
  #  - binary-ops.ts +23: one extra disjunct on `rightIsAbstractNonString`
  #    (three lines) plus the note recording that this file's own #2503 comment
  #    already described the object case the flag did not test.
  #  - expressions/new-super.ts +56: the nested-`new` arm, which must sit inside
  #    `compileNewExpression`'s unwrap block next to the direct
  #    NAMESPACE_NON_CONSTRUCTORS arm it shares a set with (that set is hoisted
  #    to module scope by this change so the two arms cannot drift). Already
  #    carried by #4506's grant for the same path; listed here for attribution.
  - src/compiler/early-errors/node-checks.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/native-strings.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # The same three edits seen per-function; the fourth (`compileNewExpression`)
  # is already granted by #4506 for this path.
  #  - ensureAnyToStringHelper 606 -> 637: this function IS `__any_to_string`'s
  #    body builder. The new arm is the body's outermost `if`.
  #  - compileAssignment 531 -> 557: this function is the ORDERED chain of
  #    identifier/target assignment arms; a new arm is one more link and its
  #    position is the fix.
  #  - compileBinaryExpression 1647 -> 1670: the route-selection preamble that
  #    decides between the string fast path and the runtime-tag cascade. The
  #    change is to that decision, so it cannot live outside it.
  - src/codegen/native-strings.ts::ensureAnyToStringHelper
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
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
