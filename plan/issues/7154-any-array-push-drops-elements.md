---
id: 7154
title: "Native-first and host lanes: an any[] literal that later receives an array via push loses its earlier elements"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-27
completed: 2026-10-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7147, 7146, 7152]
import-cycles-allow:
  - largestSccSize: 724 # 2026-10-27 (#7154): inferArrayVecType moved out of statements/variables.ts (LOC budget) into statements/array-vec-inference.ts, which imports resolveWasmType from codegen/index.ts and is imported back by variables.ts, so the split file joins the existing SCC
---

# #7154 — `any[]` literal + `push(array)` drops earlier elements

Found during #7147 (PR #6908). On **every** lane, host-assisted included, on
`origin/main` before and after #7147:

```js
const a: any[] = [1];
a.push([2]);
console.log(a.join());        // ",2"   (node: "1,2")

let cur: any[] = [1];
for (let i = 0; i < 100; i++) { const b: any[] = [i]; cur.push(b); cur = b; }
// the chain prints "1" at depth 100 instead of the nested join
```

The literal-initialised vec carries a numeric element storage; pushing an
array element migrates the storage (externref / boxed) and the migration does
not carry the existing elements across — the earlier numbers come back as
holes. This is a silent wrong result, not a compile error, and it also
limits what #7147's tests can exercise (they build cycles with `push` on
empty arrays for this reason).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the two programs on gc host-assisted, gc native-first and
   standalone; dump WAT around the `push` and find the storage-migration
   site (`array-element-inference.ts` evolving-array evidence and the `push`
   lowering in `array-methods.ts`; the same storage-vs-checker source as
   #7146).
2. When a push changes the element representation of an existing vec, copy
   the existing elements through the element coercion (number → boxed/extern)
   into the new storage before appending; if the migration is instead decided
   statically (the literal is lowered as a numeric vec although the
   declaration is `any[]`), lower an `any[]`-declared literal with the dynamic
   element storage from the start and state the byte delta.
3. Audit the siblings that append (`unshift`, `splice`, index store past
   length, `concat` into an `any[]`) for the same migration path.
4. Tests: `tests/equivalence/issue-7154-*.test.ts` with the two programs plus
   mixed pushes (number, string, object, array) into `any[]`, `unknown[]` and
   untyped `const a = [1]` literals, all three lanes vs node; afterwards
   change #7147's cyclic test rows to build the cycle on a literal-initialised
   array.

## Resolution (2026-10-27)

Root cause was static, not a runtime migration: `inferArrayVecType` (the
legacy slot-type inference for an `Array<any>` / initially-empty binding)
pinned the vec element kind from `push` / index-store arguments only. For
`const a: any[] = [1]; a.push([2])` it chose a vec-of-`number[]` slot, so the
literal's `1` was coerced to a null element on the declaration store. Fix
(moved into `src/codegen/statements/array-vec-inference.ts`):

- a non-empty literal initializer's elements count as stores (holes and
  spreads force the dynamic `externref` carrier);
- `unshift`, `fill` and `splice` insert arguments count as stores too, but
  only constrain a kind that a push / index store already pinned, so a binding
  without those keeps its checker-typed slot;
- share groups (review rounds 2-6): a binding shares its vec with another
  place through `x = arr`, `const x = arr`, `o.f = arr`, `arr = <expr>` or a
  non-literal initializer, seen through value wrappers (parens, `!`,
  `satisfies`; `as T` / `<T>` classified by `T`), `,` / nested `=`, `?:`
  branches and `||` / `??` / `&&` operands. Starting from the binding, every
  member reachable through shares is collected (initializers and use sites,
  both directions). The group takes the dynamic carrier only when every
  member is an `any` / `unknown` element binding, an array literal, or a
  value whose static type is an `any` / `unknown` array (`any[] | undefined`
  included; a call by its return type). Any typed member — a `T[]` binding or
  field, a call returning `T[]`, a bare `any` / `unknown` value (it usually
  holds a typed vec at run time), `x as number[]` — keeps every member on the
  layout it infers, as before this fix, because differing slot types convert
  by COPYING and lose pushes. Typed swap / `cur = next` buffers stay unboxed.
  This also fixes #7181 (`reverse()` / `slice()` / `concat()` results).
- array literals behind value wrappers and literals assigned later
  (`xs = [1]`) seed elements like the initializer.

`concat` returns a new array and needed no change. Test:
`tests/equivalence/issue-7154-any-array-push-migration.test.ts` (52 rows, gc
native-first, standalone, wasi vs node); the #7147 cyclic row now builds its
cycle on a literal-initialised array too
(`tests/equivalence/issue-7147-nested-array-join.test.ts`), and
`tests/equivalence/issue-7154-any-array-share-sweep.test.ts` generates 288
wrapper x partner-kind x init/assign rows (38 known gaps as `it.fails`).

Left out (wrong on main and on this fix, not worse):

- `const s: any[] = ["a"]; const a: any[] = [0, ...s]; a.push([1])`: wrong
  on all lanes (the spread seeds the dynamic carrier, the value is still off).
- wasi `[1, , 3]` + `push(4)` (review report; tracked with the wasi hole
  family in #7180).
- An `any[]` passed to a function that pushes a different element kind
  (`function f(a: any[]) { a.push([9]); }`): the callee's stores are not seen
  by the caller's inference.
- `(string | number)[]` aliases with pushes of the other kind on one side,
  and `any[][]` aliases then pushed: wrong on all lanes.
- `Map<string, any[]>` + `m.get(k)!.push(..)`: invalid Wasm.
- A three-way chain `any[]` -> `any[]` -> `number[]`
  (`const b: any[] = a; ...; const c: number[] = b; c.push(3)`) traps with
  `illegal cast`, as on main.
- An `any[]` whose own stores mix kinds before it is assigned a typed array
  (`xs.push(0); xs = n` with `n: string[]`): no single layout fits both, so
  later pushes through `xs` are lost (main is wrong the same way).
- Assigning an unasserted `any` value that holds a typed vec to a pinned
  `any[]` slot (`xs.push(2); xs = o` with `o: any`): `illegal cast` (main
  too). `xs = (ys = o as any[])` with `o: unknown` and a store-less `ys`: `ys`
  keeps the default dynamic layout while `xs` is typed (main too). Both are
  `it.fails` rows in the sweep.
- Shares through destructuring assignment (`[xs] = [n]`), object / array
  literal fields, call arguments and `return` are not followed; generic
  `<T>(x: T[])` aliasing, `get(): any[]` returning a `number[]`, tagged
  templates and tuples are wrong on main too.
