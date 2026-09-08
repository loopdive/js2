---
id: 5348
title: "Eager `T | nullish` struct registration poisoned the empty object type, breaking redux object identity"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-05 — this fix must live where the faulty branch lives: the union
# early-return inside `ensureStructForType` in src/codegen/index.ts. The
# predicate itself was moved OUT to src/codegen/shapeless-object-type.ts to keep
# god-file growth minimal, so what remains in index.ts is one import, the guard
# in the condition, and the comment naming the mechanism. There is no smaller
# form: the branch cannot be guarded from another module.
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::ensureStructForType
---

# #5348 — shapeless `T | nullish` members must not be pre-registered as structs

## Symptom

`tests/dogfood/redux-upstream-suite.mjs` regressed on 2026-09-05:

| | combineReducers.spec.ts | package |
| --- | --- | --- |
| before | 13/16 | 64/82 |
| after | 10/16 | 61/82 |

The three new failures were identity-shaped — two of them `toBe` on objects,
i.e. **referential** equality, not value equality:

```
ignores all props which are not a function            :: assertion 1 toEqual mismatch
maintains referential equality if the reducers it is… :: assertion 1 toBe: object != object
should return the same state when reducers passed to… :: assertion 1 toBe: object != object
```

The three `expected matching throw` failures in the same file are older and are
**not** part of this regression; they still fail after this fix (13/16, not 16/16).

## Culprit — bisected, not reasoned

PR **#5390** (`codex/1058-typescript-binder`), merge `470ceba797`.

Merge-vs-first-parent, which is the only sound boundary (a PR's own branch
commits can sit on an older, already-bad base):

| commit | | combineReducers | package |
| --- | --- | --- | --- |
| `b08dd4589c` | first parent of #5390 | **13/16** | 64/82 |
| `470ceba797` | #5390 merge | **10/16** | 61/82 |

Two earlier suspects were **exonerated by measurement**, not by argument:

- **#5606** (call-produced array element carrier) — its own first parent
  `104dc660fb` already measured 10/16, so the regression predates it.
- **#5625** (module-init census) — lands after `104dc660fb`, likewise already bad.

Narrowing inside #5390: of its 13 `src/` files, restoring **only**
`src/codegen/index.ts` to its pre-merge content on the bad merge restored
13/16 · 64/82 with exactly one file changed in the tree.

Inside that file, the regression is one hunk — the new union early-return in
`ensureStructForType`. Deleting only that block restored 13/16 · 64/82.

## Mechanism (verified by instrumentation, not inferred)

`ensureStructForType` gained a branch that eagerly registers the single
non-nullish member of a two-member `T | nullish` union. A parameter written
`state = {}` gives its **call sites** the contextual type `{} | undefined`, so
passing an object literal there registered the **empty object type `{}`**.

Instrumenting the branch while compiling redux's `combineReducers.spec.ts`:

```
12 [union-reg] {} | undefined => {}
 1 [union-reg] string | undefined => string
```

(`string` is harmless — it is not an object type and returns immediately.)

Registering `{}` produces a **closed zero-field struct**, and registration is a
**global** mutation of `ctx.anonTypeMap`. So the damage lands far from the
trigger: every later `{}`-typed value resolves through `resolveStructName` to
that empty struct. Instrumenting `resolveStructName` for the type `{}`:

| | `{}` → struct hits | of which `Object.keys` sites |
| --- | --- | --- |
| parent | 53 (`__anon_28`) | **3** |
| with fix | 50 (`__anon_32`) | **0** |

Those three `Object.keys` sites are the whole regression — 3 sites, 3 failing
tests. Their exact locations:

```
2  Object.keys(reducer(undefined, { type: 'push' }))  @ combineReducers.spec.ts:858
1  Object.keys(state)                                 @ redux dist/redux.mjs:323
```

`compileObjectKeysOrValues` takes the struct path when the argument type
resolves to a struct name, so it enumerated the struct's **zero** fields instead
of the live host object. In redux's `combination`:

```js
hasChanged = hasChanged || finalReducerKeys.length !== Object.keys(state).length;
return hasChanged ? nextState : state;
```

the right-hand side read `0`, so `hasChanged` was pinned **true** and
`combination` returned the fresh `nextState` instead of the `state` it was
handed. That is precisely the lost referential identity the two `toBe` tests
assert; the spec:858 site is the `Object.keys` (`toEqual`) failure.

## Fix — forward, not a revert

#5390 fixed large real regressions, so it is not reverted. The eager
registration is **narrowed**: it now fires only when the non-nullish member
actually carries a shape.

`src/codegen/index.ts` — new `isShapelessObjectType(type)` (no properties, no
index signature, no call/construct signature; `{}` is the canonical case), and
the union branch skips registration for such members. Shapeless members have
nothing to pre-register, so they stay on the externref/host-MOP path exactly as
before #5390.

This keeps #5390's own motivation intact: its comment names an **optional local
interface**, and an interface has members, so it is not shapeless and still
registers.

The predicate uses the `ts.Type` accessors (`getProperties`,
`getCallSignatures`, …) rather than `ctx.checker`, so it adds no raw-checker
references and stays off the oracle ratchet.

## Result

| suite | before | after |
| --- | --- | --- |
| `test/combineReducers.spec.ts` | 10/16 | **13/16** |
| redux package | 61/82 | **64/82** |

No other redux file moved: `applyMiddleware` stays 3/5 and `createStore` stays
34/42, so the +4 from the concurrent redux fix is preserved rather than masked.

## Regression test — what it does and does not pin

`tests/issue-5348-default-empty-object-param-identity.test.ts` pins the
referential-equality property end to end on redux's `combineReducers` shape
(untyped JS implementation + TypeScript consumer — how redux actually ships:
`dist/redux.mjs` + `redux.d.ts`), deciding identity **inside Wasm** with `===`
so a structural copy cannot satisfy it.

**It is a property guard, not a reproduction, and it passes on the parent too.**
Stated plainly because a test that looks like a guard but guards nothing is
worse than none: a synthetic project also registers `{}` through the ordinary
object-literal path (`compileObjectLiteral`'s own `ensureStructForType` call),
which masks the union-path fault. Reproducing it needs redux's exact
checker-type-identity conditions, which several hand-built two-file projects
(default-parameter, annotated `{} | undefined`, JS-impl/TS-consumer) did not
recreate.

The **discriminating** pin is therefore the redux upstream dogfood suite, which
CI runs, plus the instrumented `Object.keys`-fold counts above (3 → 0).

## Guard against recurrence

The general hazard this exposes: `ensureStructForType` mutates a global map, so
any widening of *what* it eagerly registers can break code that never mentions
the triggering type. Shapeless object types are the sharpest case because a
zero-field struct silently answers "no properties" to every consumer.
