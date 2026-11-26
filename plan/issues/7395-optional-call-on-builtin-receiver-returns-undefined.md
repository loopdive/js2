---
id: 7395
title: "`s?.toUpperCase()`, `a?.push(3)` and `m?.get(k)` on a defined string, array, Map or Set receiver return `undefined`"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7370, 7374]
depends_on: [7370, 7374]
loc-budget-allow:
  # 2026-11-19 (RV7336 round 2): `tryCompileStandaloneRegExpMethod` (~25 lines) chains the four native RegExp
  # method arms and must sit beside them. As its own module it added an unclassified compiler-boundaries entry
  # and grew the import SCC (708 -> 709), failing `quality`.
  - src/codegen/regexp-standalone.ts
---

# #7395 — an optional method call on a built-in receiver never runs

## Problem

```ts
function f(s: string | undefined) { return s?.toUpperCase(); }
f("abc");                       // node "ABC"; we return undefined

function g(a: number[] | undefined) { a?.push(3); return a!.length; }
g([1, 2]);                      // node 3; we return 2 — push never ran
```

Plain `s.toUpperCase()` / `a.push(3)` work. Only the `?.` call form is wrong; `?.[i]` and `?.length` are correct.

## Measurement (2026-11-19)

Probe: 280 programs, each run under node and under our gc and standalone targets (`main()` returns 2 for
`undefined`, 1 for node's answer, 0 otherwise). Receivers `string | undefined`, `number[] | undefined`,
`string[] | undefined`, `Map<string, number> | undefined`, `Set<number> | undefined`, and a class instance `| undefined`
as control. Each receiver is defined (D) and `undefined` (U), as a local, parameter, field, module global and chain
(`o.r?.m()`). gc and standalone agree on every row.

Same rows fail on all three heads:

- `origin/main` 89e4748241: 145 of 280 fail.
- #7370 head `c9983ac91b`: 145 of 280 fail (no row fixed).
- #7374 head `107c33343d`: 145 of 280 fail (no row fixed).

| receiver | form | D (defined) | U (`undefined`) |
| --- | --- | --- | --- |
| `string` | `?.toUpperCase()` `?.slice(1)` `?.indexOf("b")` `?.charAt(1)` | **all 5 kinds return `undefined`** | ok, except local |
| `string` | `?.[1]`, `?.length` | ok | ok |
| `number[]`, `string[]` | `?.indexOf` `?.join` `?.push` (used and dropped) `?.map(..).length` | **all 5 kinds wrong** (push not executed) | ok, except local; `map` traps (null deref) |
| `number[]`, `string[]` | `?.includes` | all 5 kinds wrong | all 5 kinds wrong |
| `number[]`, `string[]` | `?.[1]`, `?.length` | ok | ok |
| `Map` | `?.get` `?.set` (dropped) | **all 5 kinds wrong** | ok, except local |
| `Map`, `Set` | `?.has` | all 5 kinds wrong | all 5 kinds wrong |
| `Set` | `?.add` (dropped) | **all 5 kinds wrong** | — |
| `Map`, `Set` | `?.size` | all 5 kinds wrong; param/field/global fail Wasm validation | param, field fail validation |
| class `K` (control) | `?.m()`, `?.bump()` | ok | ok, except local |
| any receiver, `const r: T \| undefined = undefined` | every method form | — | **wrong for every type**, the class control included |

Three of the failing groups are other mechanisms and are not this issue:

- **Local U** (every receiver, the class control included): `const r: T | undefined = undefined` narrows `r` to
  `undefined`, and that path answers wrongly for every receiver (the separate row above).
- **`?.includes` / `?.has` results**: the result type is `boolean | undefined`, which lowers to a bare i32 that
  cannot hold `undefined` (the #7374 representation gap). U never reads as `undefined`.
- **`?.size`**: an optional *property* access, not a call; it emits invalid Wasm for parameter, field and global
  receivers. #7401 owns it (`property-access.ts`).

## Cause

`compileOptionalCallExpression` (`src/codegen/expressions/calls-optional.ts`) resolves the method in the non-null
branch with its own arms: extern class, user class, struct, and a string arm. If none claims, it emits the default
value, so the call silently does not happen.

- **Strings.** The string arm calls the native string lowering only under `ctx.fast && ctx.nativeStrTypeIdx >= 0`.
  `ctx.fast` is the old i32-number mode, which is off on both targets. The fallback looks up a host
  `string_<method>` import, which native strings never register. So no string method is ever emitted.
- **Arrays, Map, Set.** No arm handles a built-in collection. Only `any`/`unknown` receivers (#4292) and, with #7370,
  Number/Boolean/BigInt receivers are delegated to the generic receiver-method ladder (`compileReceiverMethodCall`),
  which is what lowers `a.push(3)` / `m.get(k)` in a plain call.

## Where the fix lives: stacks on #7370 and #7374

The fix widens the delegation that #7370 and #7374 build, so it cannot land on `origin/main` alone:

- #7370 (`c9983ac91b`) adds the primitive gate (`isPrimitiveMethodReceiver`), the real-`undefined` short-circuit
  value (`optionalUndefinedInstrs`), and `optionalChainReceiverType`, which makes the ladder dispatch on the
  non-nullable receiver type.
- #7374 (`107c33343d`) adds `compileHeldReceiverMethodCall`, which runs the ladder with the receiver bound to the temp
  the nullish test holds. That removes the identifier/`this` restriction, so field, global and chain receivers work.

This branch must be re-based on #7374's branch (`claude/7374-optional-call-receiver-binding`) before step 3.

## Implementation Plan

Module: `src/codegen/expressions/calls-optional.ts` only.

1. **One gate for "the ladder owns this receiver".** Replace `isPrimitiveMethodReceiver` with one predicate,
   `isLadderMethodReceiver(type)`. It is true for `any`/`unknown`, Number/Boolean/BigInt (today's union rule), string
   (`isStringType`), and a built-in nominal receiver (`isBuiltinTypeName(type.getSymbol()?.name)` from
   `builtin-tags.ts`; the user-class arms above have already run). The `any`/`unknown` flag test folds into it too,
   so the delegation `if` reads `!methodResolved && isLadderMethodReceiver(tsReceiverType)`.
2. **Delete the string arm** (about 70 lines: the `ctx.fast` native call and the host `string_<method>` import
   branch with its `substring`/`slice`/`split` default-argument special cases). The ladder's string arm already
   lowers the same calls for plain `s.m()`, through `compileNativeStringMethodCall`, the symbol-protocol dispatch and
   the String-wrapper override. The optional path then uses the same lowering as a plain call instead of a stale copy.
3. **Short-circuit value.** For a ladder receiver the `then` branch yields the lane's real `undefined`
   (`optionalUndefinedInstrs`, extended from #7370's `primitiveReceiver` test to the new predicate). A throwaway
   prototype on `107c33343d` that did only steps 1–2 fixed 67 rows. It also broke 12 U rows (`?.indexOf` on strings,
   `?.join` on arrays): the delegated result type (f64, string ref) replaced the TS result type, and the `then`
   branch then gave `0` or `null` instead of `undefined`. So `then` must give `undefined` in the joined result type:
   the f64 sentinel for f64 (the #7360 helper in `value-tags.ts`), and externref with a real `undefined` for a
   reference result. Reuse those helpers; do not add a third encoding.
4. **`m?.get(k)` on a non-local receiver** still returned `undefined` in the prototype. Find out why before writing
   code. The likely cause is the receiver's ValType (the temp holds `ref_null`, but the ladder's Map arm expects what
   a fresh compile yields). Fix it at that seam, not with an optional-call special case.

Out of scope (recorded above): local-`undefined` narrowing, `boolean | undefined` results, `?.size`.

**Code-quality acceptance criterion.** The optional path keeps one rule for "which receivers the ladder lowers", and
it has no string lowering of its own. Net LOC of `calls-optional.ts` goes down. No new predicate duplicates
`isBuiltinTypeName` or `isStringType`. Repeatable and class receivers keep their bytes, and the 100-file test262
sample compiles byte-identically on gc and standalone.

## Acceptance criteria

- Every D row in the string, array, Map `get`/`set` and Set `add` groups answers like node on gc and standalone.
  This includes `a?.push(3)` with the result dropped (the push runs).
- No U row that passes today regresses.
- `tests/issue-7395-optional-call-builtin-receiver.test.ts` covers those rows on both targets, with expected values
  written by hand to match node.

## Result (2026-11-19)

On `claude/7395-optional-call-builtin-receivers`, base be33813e0a (#7374 107c33343d merged with #7370 18f3b2ad88).

What changed, against the plan:

- **Plan steps 1–2 as written.** `isPrimitiveMethodReceiver` became `isLadderMethodReceiver`: the primitive mask
  gains `StringLike`, and a built-in nominal receiver (`isBuiltinTypeName`) also qualifies. The `ctx.fast`-gated
  string branch is gone, including its host `string_<method>` import fallback.
- **Step 3: one join helper.** `undefinableJoin` sits next to `nullableJoin` and `optionalUndefinedInstrs`, and both
  the ladder arm and `compileOptionalValueReceiverCall` use it. Its job is to give the call result a type that the
  short-circuit `undefined` also fits:
  - a number becomes an f64 carrying the sentinel; an i32 result (a string `indexOf`) is converted only when the
    declared type is a number;
  - an anyref result (`Map.get`) becomes an externref;
  - any other reference takes its nullable form.

  `optionalUndefinedInstrs` now yields the sentinel for an f64.
- **Step 4: the cause was not the ValType.** `compileExternMethodCall` (`expressions/extern.ts`) read the receiver as
  the raw `Map<…> | undefined` union, so no class name matched and the native Map/Set dispatch was skipped. It now goes
  through `optionalChainReceiverType`, the same rule the ladder uses.

Measurements:

- **Probe** (280 programs): 145 fail on the base, 66 on the head, and no row regresses. Every in-scope D row passes:
  string methods; array `indexOf`/`join`/`push`/`map`; Map `get`/`set`; Set `add`. The U rows that passed still pass.
- **#7401's three reproducers** (local Set `add`, local Map `set`, `s?.has(1) ? 1 : 0`) pass on gc and standalone.
- **`tests/issue-7395-optional-call-builtin-receiver.test.ts`**: 14 programs × gc/standalone, with expected values
  checked against node. The base fails all 28; the head passes 28/28.
- **Neighbour suites**: 24 files (optional-call/chain, string/array method, Map/Set, #7360/#7370/#7374). The base
  has 285 passing and 42 failing; the head has 313 passing and 14 failing. The 14 head failures are the same tests
  that fail on the base, and the 28 fixed are the new tests.
- **Byte identity**: 100 test262 files × gc/standalone, identical against the be33813e0a sources (200/200).
- **Gates**: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet and dead exports
  all pass. `calls-optional.ts` goes from 504 to 464 lines.

### RV7336 round 1 (2026-11-19)

- **Must-fix, RegExp.** Two separate causes made `g?.test('a')`, `g?.exec('a')` and `g?.toString()` on a
  `RegExp | undefined` fail to compile (`Missing import for method: RegExp_test`):
  - the held-receiver ladder skipped the native RegExp arms, which only the plain call path in `calls.ts` asked;
  - `compileExternMethodCall` narrowed every receiver class, but only Map and Set have a native dispatch there.

  The RegExp arms (exec, test, toString, compile) are now one helper, `tryCompileStandaloneRegExpMethod`
  (in `regexp-standalone.ts`, beside the four arms; a separate module failed the compiler-boundaries and import-cycle checks, RV7336 round 2). The plain call path and `compileHeldReceiverMethodCall` both call it. The extern read
  narrows only Map / Set / ReadonlyMap / ReadonlySet.
  - A narrowed `const g: RegExp | undefined = /a/` now answers like node: 111, where #7374's head gave 0.
  - `let g: RegExp | undefined; g?.test('a')` compiles again.
- **Should-fix 1.** Merged #7374's head bdeedb9f89 into this branch.
- **Should-fix 2.** `undefinableJoin` gave `Set.has`'s i32 result an unbranded i32, so `String(s?.has(1))` read "1".
  An i32 result now takes the declared type's boolean brand.
- **Pins.** 4 programs × gc/standalone added. 6 of the 8 rows fail on the pre-fix merge head; all 8 pass now.
- **Neighbour suites.** 88 files, 1,294 tests (regexp / optional): 44 failing before, 38 after. The only change is
  the 6 newly pinned rows.
- **Byte identity.** 200/200 identical to the pre-fix merge head.

### Left open

- `const r: T | undefined = undefined` locals (the row above): wrong for every receiver type.
- `boolean | undefined` results (`?.includes`, `?.has` stored in a variable): the i32 cannot hold `undefined`. Widening
  the result to an f64 made those U rows pass, but it stores `true` as the number 1, so it was dropped.
  Testing the result directly (`s?.has(1) ? …`) works.
- `?.size`: #7401.
- A RegExp receiver whose type is still `RegExp | undefined` at the call (a parameter, or a value via `as any`)
  compiles, but `test` / `exec` answer `false`, as on the base. The native arms check the unnarrowed type.
- `a?.map(f).length` with `a` undefined: the chain past the call does not short-circuit, so it traps (null deref).

