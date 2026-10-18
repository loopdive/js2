---
id: 7017
title: "standalone: `x.length` on an `any` receiver that is a closed literal struct reads a NUMBER (0) instead of `undefined`, so `typeof obj.length === \"number\"` is true for plain objects and every deep-equality helper takes its array-like branch (expect().toEqual / assert.deepEqual false negatives across redux, hono, jest, styled-components, stylelint)"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-18
completed: 2026-10-17
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

### Plan revision (2026-10-17, before implementing)

Measured on the parent (`70f2a4e801`): a "no `length` field" screen is not
enough. Structs that DO carry `length` were also wrong on arm 6, because
`__extern_length` is ToLength(Get): `{ length: -2.5 }.length` read 0 and
`{ length: "abc" }.length` read 0, and a class `get length()` read 0 (the
getter is not a field). So the new arm covers every user-declared struct and
reads through the finalize-filled `__get_member_length` dispatcher (#2674)
instead of a bare `__extern_get`:

- gate: `__is_instance_expando_carrier(recv)` — the existing finalize-filled
  `ref.test` chain over `isUserDeclaredStruct` shapes (`instance-props.ts`),
  so structs registered after the read site are still covered; tuples, vecs,
  TypedArrays and rest arrays are not carriers and stay on arm 6;
- value: `__get_member_length(recv)` — field arms (the raw value, boxed),
  class getter arms (#3041), method arms, else `__extern_get` (expando,
  prototype chain, `undefined`). A bare `__extern_get` misses class getters
  unless some computed read elsewhere in the program demanded them.

## Acceptance

- Repros match node on standalone; gc binaries byte-identical.
- redux standalone `toEqual mismatch` failures (10 on 2026-10-16) drop to 0
  where the JS-host lane passes them.

## Resolution

Landed in PR #6729 (merged 2026-10-17), stacked on #6718 (#7013 lane).

- **Mechanism.** `emitStandaloneAnyLengthGet` gained arm 5b, which applies
  when `__is_instance_expando_carrier(recv)` is true. It reads through
  `__get_member_length(recv)`, giving the shape's own field value or class
  getter, else `__extern_get` (expando, prototype chain, `undefined`).
  Vecs, TypedArrays, tuples and rest arrays are not carriers and stay on
  `__extern_length`. No host imports. The gc binaries of four fixtures are
  byte-identical (sha256), and the redux JS-host lane stays at 76/82.
- **Test.** `tests/issue-7017-standalone-any-length-struct.test.ts` fails on
  the parent and passes with the fix. Anti-vacuity: `toEqual` over
  differing literals still fails.
- **Upstream unit suites (standalone).** Base and fix were both measured on
  `70f2a4e801`, with a per-test diff and 0 pass→fail transitions:

  | suite | base | fix |
  | --- | --- | --- |
  | redux | 58/82 | 66/82 |
  | hono | 32/324 | 41/324 |
  | jest | 185/356 | 190/356 |
  | stylelint | 100/108 | 102/108 |
  | cookie | 114/63740 | 148/63740 |

  The other 14 suites are unchanged.
- **Scoped standalone test262.** The sample was one row in three of
  `built-ins/{Array,Object,TypedArray,TypedArrayConstructors}` plus all of
  `language/expressions/typeof`: 2,909 rows. Base and fix gave 2,403 vs
  2,404 passes. All 28 rows that differed were compile timeouts on the
  shared box. Re-run alone with a 480 s budget, they gave identical
  verdicts on both sides (23 pass, 5 fail), so there is no real change.
  `Array/prototype/unshift/clamps-to-integer-limit.js` never returns
  in-process on either side.
- **Acceptance.** The redux `toEqual mismatch` rows dropped from 10 to 3.
  The 3 left have other causes:
  - `bindActionCreators` ×2: `fn.apply(thisArg, array)` called directly
    leaves `[...arguments]` empty.
  - the thunk-middleware row: not diagnosed.

  styled-components `escape` ×3 was misattributed to #7017: on standalone,
  `"foo-bar".replace(/(^-|-$)/g, "")` returns a string of length 8.

