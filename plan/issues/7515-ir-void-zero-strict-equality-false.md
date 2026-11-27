---
id: 7515
title: "`(void 0 as any) === (void 0)` is false on the IR default lane"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
task_type: bug
area: ir
goal: core-semantics
related: [7439]
---

# #7515 — `void 0 === void 0` compares false in the IR

## Problem

Found by PRV-7439 while probing #7439 on main 1a726b3e:

```ts
export function f(): boolean { return (void 0 as any) === (void 0); }
```

node: `true`. Legacy (`experimentalIR: false`): `true`. The default pipeline, where the IR claims `f`: `false`. No
shadowing is involved.

## Acceptance criteria

1. `true` on gc and standalone, default and legacy; pinned by a test that fails on main.
2. The fix lives in the IR's undefined-compare lowering (`tryLowerUndefinedCompare` / `isUndefinedCompareOperand`),
   not in a special case for this spelling.

## Measured (2026-11-26, main 1a726b3e64)

The IR lane gets these wrong on both gc and standalone; legacy gets all of them right:

| program | IR | node |
|---|---|---|
| `(void 0 as any) === (void 0)` | false | true |
| `(void 0 as any) === (void 0 as any)` | false | true |
| `(void 0)! === void 0` | false | true |
| `(void 0 as any) == (void 0)` | false | true |

These are already right: `(void 0) === (void 0)`, `(void 0 as any) === undefined`, `<any>void 0 === void 0`.

**Every plain-JS shape is right on gc and standalone:**
- `x === (void 0)` and `(void 0) === x` through a parameter;
- `!==`;
- an uninitialised var;
- `((void 0)) === (void 0)`;
- `o.x === (void 0)`.

So the defect is a TS assertion or `!` around `void 0` / `undefined`.

**Yield: 0 test262 rows.** Of the 16 ES5 files with a parenthesised `void 0` compare:
- all pass on the baseline;
- on the Prepared path, all stop earlier, at unrelated walls.

It is still a wrong value on the IR lane, so it is fixed (lead, 2026-11-26).

## Implementation Plan

- **Cause.** `isUndefinedCompareOperand` (`src/ir/analysis/operand-admissibility.ts`), the one predicate shared by the selector and the lowering, reads its operand directly. An `undefined` or `void 0` inside `as` / `<T>` / `satisfies` / `!` is not recognised. The operand then goes down the general compare paths, which fold it wrong.
- **One change, in that predicate.** It looks through `skipOuterExpressions` (`src/shared/binding-writes.ts`, already imported there: parentheses, `as`, `!`, `satisfies`, `<T>x`) before matching the identifier `undefined` or `void 0`. Reuse only; no new helper.
- **Shadowing callback.** It gets the peeled identifier as a second argument: `(name, id) => boolean`.
  - The two callers that ask about the node (`static-predicates/selection.ts`, `static-predicates/lowering.ts`: `isGlobalUndefined`) now ask about the identifier, not the wrapper. So the selector and the lowering keep answering the same question.
  - The name-based callers (from-ast, `select-object-statics.ts`, `literal-pattern-plan.ts`) are unchanged.
- **Second site, the same defect (found while implementing).** The loose forms `(void 0 as any) == (void 0)` and `!=` stayed wrong. They take from-ast's operand classification, where `isValueVoid` decides whether an f64 operand is the `void x` sentinel, and it peeled parentheses only (`peelParensExpr`). It now reads through `skipOuterExpressions` too. This is the same helper, so there is still no new helper.
- **Acceptance:**
  - A test that fails on main: the four shapes above, plus `(undefined as any) === (void 0)!`, are `true` (and `!==` is `false`) on gc and standalone, both default and legacy (`experimentalIR: false`).
  - Bytes: the 13 playground examples × default/standalone are identical.
  - `check:prepared-bytes` 804/804 is identical: no proving program has such a wrapper.
  - Mutation: drop the peel, and the test fails.
  - **Code quality:** two readers of an operand now read through the one shared `skipOuterExpressions`; one callback gains an argument; no new helper, no grant.

## Result (2026-11-26, `claude/7515-void-zero-compare`)

- `tests/issue-7515-ir-void-zero-wrapped-compare.test.ts`: 36/36. That is 9 shapes (strict, loose, `as`, `satisfies`, `!`) × gc/standalone × default/legacy, and node agrees on each.
  - Mutation (base sources restored): 16/36 fail, all on the IR lane.
- Bytes:
  - the 13 playground examples × default/standalone: 26/26 hashes identical;
  - `prepared-byte-identity.mts`: 804/804 identical.
- 40 related test files (grep: `void 0`, undefined-compare): the failure set is the same with and without the change (81 pre-existing failures in 20 files), so this change adds none.
