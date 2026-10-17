---
id: 7017
title: "standalone: `x.length` on an `any` receiver that is a closed literal struct reads a NUMBER (0) instead of `undefined`, so `typeof obj.length === \"number\"` is true for plain objects and every deep-equality helper takes its array-like branch (expect().toEqual / assert.deepEqual false negatives across redux, hono, jest, styled-components, stylelint)"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: property-access, any, length
goal: standalone-gap
related: [6736, 7013]
---

# `.length` of a plain object reads 0 on standalone

Found by the [#7013](./7013-standalone-upstream-unit-lane.md) standalone
upstream unit lane. The shared assertion harness's `__upstreamSame` (behind
`toEqual`, `toStrictEqual`, `toHaveBeenCalledWith`, QUnit `deepEqual`) checks
`typeof a.length === "number"` to detect array-likes. On standalone that is
true for ordinary object literals, so `[{type:"A"}]` vs `[{type:"A"}]`
compares the objects as empty array-likes of length 0 against ... and fails.

## Repro (standalone; node → 0 / 1 / 0)

```ts
export function t1(): number { const xs: any[] = []; xs.push({ type: "A" }); const e: any = xs[0]; return typeof e.length === "number" ? 1 : 0; } // standalone 1, node 0
export function t3(): number { const xs: any[] = []; xs.push({ type: "A" }); const e: any = xs[0]; return e.length === undefined ? 1 : 0; }      // 1 (inconsistent with t1)
export function t2(): number { const e: any = { type: "A" }; return typeof e.length === "number" ? 1 : 0; }                                     // 0 (correct: widened to $Object)
```

Inside the upstream shim: `expect(xs).toEqual([{ type: "A" }])` fails when `xs`
is a local `any[]` filled by `push`; the same comparison over a module-level
array passes.

## Root cause

`src/codegen/expressions/standalone-any-length.ts` (`emitStandaloneAnyLengthGet`,
#6736). Arm 5 routes only an ordinary `$Object` (or number/boolean primitive)
to the real `__extern_get(recv, "length")`; arm 6 sends "any other carrier" to
`__extern_length`, whose ToLength(Get) turns an ABSENT `length` into `0`. The
header lists "a closed literal struct" among the carriers deliberately kept on
arm 6 — correct for structs that HAVE a `length` field (tuples/records), wrong
for a closed literal struct without one: §7.3.2 Get of a missing property is
`undefined`.

## Implementation Plan

1. In `emitStandaloneAnyLengthGet`, add an arm before arm 6: when the receiver
   `ref.test`s as a closed literal / user-declared struct
   (`isUserDeclaredStruct`, the same screen `instance-props.ts` uses —
   `instanceCarrierTypeIdxs`) whose struct type has NO field named `length`,
   answer `__extern_get(recv, "length")` (honours an expando or prototype
   `length`, else `undefined`). Build the type list at emit time; skip the arm
   when it is empty so binaries without such structs are unchanged.
2. Keep vec / TypedArray / rest-args arrays on arm 6 (the #6506 79-row lesson
   in the header) — the new arm must test struct types only.
3. Tests: the three repros above, plus `toEqual` over a pushed object literal
   through the upstream shim (`tests/dogfood/upstream-standalone-lane.test.ts`
   pattern), a struct WITH a numeric `length` field (still its value), an
   array (still its length), and an expando `o.length = 3` on a literal.
4. Scoped standalone test262: `built-ins/Array`, `built-ins/Object`,
   `language/expressions/typeof`, `built-ins/TypedArray` base vs fix.
5. Re-measure redux, hono, jest, styled-components, stylelint with the #7013
   lane.

## Acceptance

- Repros match node on standalone; gc binaries byte-identical.
- redux standalone `toEqual mismatch` failures (10 on 2026-10-16) drop to 0
  where the JS-host lane passes them.
