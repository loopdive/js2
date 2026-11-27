---
id: 7580
title: "Prepared path: `Object` statics as values, and the rule that decides when a static's call may fold"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7574]
related: [7574, 7350, 7561, 7352, 7354]
---

# #7580 — `Object` statics as values on the Prepared path

## Problem

`harness/propertyHelper.js` (about 900 ES5 tests) reads three statics as values at its lines 28–30:

```js
var __defineProperty = Object.defineProperty;
var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var __getOwnPropertyNames = Object.getOwnPropertyNames;
```

On #7574's head a static read as a value refuses by name (`Object.defineProperty is not reachable on this path yet`):
`%Object%` is an identity row that holds only `length`, `name` and `prototype`. This is slice 2 of #7574's slicing
table. #7574's open question 1 (who builds #7350's escape rule) is answered here: nobody else has claimed it, so this
slice builds it.

## Implementation Plan

### What changes, by module

| layer | module | change | reuses |
| --- | --- | --- | --- |
| contract | `native-realm-catalog.ts` | `HELD_OBJECT_STATICS` (the four native statics and `getOwnPropertyNames`) join `%Object%`'s `identityOnly`; their ids are appended to `NATIVE_VALUE_INTRINSICS` | `realmMethodId`, `identityOnly` |
| realm holds | `native-realm-requirements.ts` | the one pin function pins a family constructor's own function members as it pins its prototype's (a static is held where a constant key names it, every one where a key may be computed); `heldCatalogRows` keeps a family row's property whose value is a callable held without a family only where the realm holds that callable as a value | `pinnedMembers`, `modelledRow` |
| backend | `native-realm.ts` | a callable held without a family is installed on the root only if the root names it (P1's methods); a static is a plain built-in function value | — |
| shared source facts | `src/shared/intrinsic-prototype-writes.ts` | the existing walk also records the intrinsics a non-inert use lets escape (`isInertUse` is #7350's escape test); one new query | `prototypeUse`, `isInertUse` |
| source fact | `source-plain-objects.ts` | `ProgramObjects` gains the statics the program reads as values and the native statics it may replace | `sourceWritesMemberNamed`, `sourceNamesReflectiveRoute`, `sourceRunsDynamicCode`, the new escape query |
| IR statics | `dynamic-object-statics.ts` | the algorithm takes its arguments explicitly; where the program holds the `object` family and may replace the static, the folded call is a [[Get]] of the static, an identity test, the algorithm, else the run-time abort | `identityTest`, `builtinMethodChain` |
| IR call | `dynamic-prototype-methods.ts` | a dispatcher call whose callee may be a held native static answers it by identity (statics ignore `this`), arguments padded with `undefined` | the one method-by-identity table |
| tests | `tests/issue-7580-object-statics.test.ts` | node agreement with wrong twins; refuses/aborts rows | `tests/helpers/prepared-node-agreement.ts` |

### The escape rule (one rule, one place: `source-plain-objects.ts`, consumed only by `dynamic-object-statics.ts`)

A call `Object.m(…)` keeps the folded built-in unless both hold:

1. the program holds the `object` family (`holdsFamily`): only then can any code obtain `%Object%` at all (the root's
   `constructor` is seeded with the family), so without it no write to a static exists;
2. the program may replace `Object.m`: in some source file a member named `m` is written, deleted or defined on any
   object (`sourceWritesMemberNamed`), a reflective route is named (`constructor`, `Reflect`, … —
   `sourceNamesReflectiveRoute`), dynamic code may run (`sourceRunsDynamicCode`), or `Object` escapes (a use that is
   no callee, member-access object, `typeof` / `instanceof` / equality operand — the existing walk's `isInertUse`).
   A write under an unspelled name (`sourceMayWriteUnspelledMember`) reaches `Object` only through one of these
   (`d(Object, k, v)` and `Object[k] = v` hand it on), so it is not asked: a program with an ordinary computed store
   keeps its fold.

Then the call reads the static's current value and answers by identity; any other value is the run-time abort (never
the stale fold). The write half reuses the shared walk (no second member-write walker); only the escape half is new,
and it is one set recorded in that walk's existing branch.

### Duplicates removed

- The pin rule's constructor half is the prototype half's code (one loop over the constructor's modelled row and the
  prototype's row), not a second function.
- The static algorithm is one function called from the folded call and the dispatcher's identity row.
- Folded on the way: the history comment citing `A1b` in `ordinary-to-primitive.ts`.

### Acceptance

- Correctness: `var d = Object.defineProperty`, `typeof d`, `d === Object.defineProperty`, `d.name`, `d.length`,
  `d(o, "x", {value: 1})`, stored in an object / closure, passed as an argument, `({f: Object.defineProperty}).f(…)`;
  the same for `getOwnPropertyDescriptor`, `create`, `defineProperties`; `getOwnPropertyNames` held (identity, `typeof`)
  with its call aborting. Every write route (before/after the call, in a called or never-called function, an alias, a
  parameter, a literal or computed key, `defineProperty`) never yields a folded answer. Shadowing means the user's
  binding. Each agreement has a wrong twin. No wrong value, invalid Wasm or exception out of `compile()`.
- Cost: programs that do not hold the `object` family, or that may not replace the static they call, are
  byte-identical to the base; the ordinary pipeline is byte-identical.
- Code quality: no `=== "Object"` test outside the catalog and key modules; one pin function; one identity table; one
  static algorithm; `src/ir/from-ast.ts` does not grow; IR→runtime import edges stay at 10.

## Result

(pending)
