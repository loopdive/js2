---
id: 7196
title: "IR selector: refuse native-i32 field initializers and class string-literal element reads before the claim"
status: ready
sprint: Backlog
created: 2026-10-29
updated: 2026-10-29
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7136
related: [7137, 7183]
---

# #7196 — two post-claim demotions the selector should refuse up front

## Problem

Found in the #6961 re-review (PR loopdive/js2#6961, 2026-10-29). Both already
demote **after the claim** on `--target standalone` on `origin/main`
(`54258e5d29`); #7136's WASI console claim makes WASI reach them too. Both
compile (legacy fallback) and print the right value, but they break the
no-claim-then-demote rule (`irPostClaimErrors` is non-empty).

| Program (`main` body) | post-claim error |
| --- | --- |
| `type i32 = number; class C { v: i32 = 5 }` … `const x: number = c.v;` | `local 'x' annotated as f64 but initializer is i32` |
| `class C { v: number = 5 }` … `c['v'] + 1` (any field type) | `element access on class<C> with index StringLiteral not in slice 12` |

## Implementation Plan

- **Native-i32 initializer.** The selector's local-declaration arm should judge
  an annotated `number` slot against a native-i32 field read with the shared
  `slotWriteVerdict("number", "int32")` (inadmissible), reusing the
  `isNativeI32SlotRead` selection option and the `int32` labelling that
  `nativeI32OperandsAdmissible` (`ir/analysis/operand-admissibility.ts`)
  already does for binary operands. No second predicate.
- **Class string-literal element read.** Either lower `c['v']` as the field
  read `c.v` (same field, same shape) in from-ast, or refuse the element access
  on a class receiver with a literal index in the selector's element-access arm
  until it does. Lowering is preferred: it is the same `class.get`.
- Quality criterion: each fix extends an existing selector arm through the
  shared admissibility predicates; no new parallel check.

## Acceptance

- Both programs on standalone and WASI: compile, legacy-identical stdout, and
  `irPostClaimErrors` is `[]`.
- gc byte-identical on the playground examples.
