---
id: 7580
title: "Prepared path: `Object` statics as values, and the rule that decides when a static's call may fold"
status: done
completed: 2026-11-27
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
| realm holds | `native-realm-requirements.ts` | the one pin function pins a family constructor's own function members as it pins its prototype's (a static is held where a constant key names it; the constructor is an identity row, so a computed key that misses aborts); `heldCatalogRows` keeps a family row's property whose value is a callable held without a family only where the realm holds that callable as a value | `pinnedMembers`, `modelledRow` |
| backend | `native-realm.ts` | a callable held without a family is installed on the root only if the root names it (P1's methods); a static is a plain built-in function value | — |
| shared source facts | `src/shared/intrinsic-prototype-writes.ts` | the existing walk also records the intrinsics a non-inert use lets escape (`isInertUse` is #7350's escape test); one new query | `prototypeUse`, `isInertUse` |
| source fact | `source-plain-objects.ts` | `ProgramObjects` gains the statics the program reads as values and the native statics it may replace | `sourceWritesMemberNamed`, `sourceNamesReflectiveRoute`, `sourceRunsDynamicCode`, the new escape query |
| IR statics | `dynamic-object-statics.ts` | the algorithm takes its arguments explicitly; where the program holds the `object` family and may replace the static, the folded call is a [[Get]] of the static, an identity test, the algorithm, else the run-time abort | `identityTest`, `builtinMethodChain` |
| IR call | `dynamic-prototype-methods.ts` | a dispatcher call whose callee may be a held native static answers it by identity, arguments padded with `undefined`; tested where the call is detached or names the static, exactly `Array.isArray`'s rule (one `reads` predicate for both) | the one method-by-identity table |
| front end | `realm-static-call.ts` | #7574's one folded-receiver predicate becomes `realmReceiverRead`, which also names the member a non-folded read takes; `X.prototype` and the static values read it, no second position test | `foldedRealmReceiver` |
| flow rule | `source-dynamic-contracts.ts` | a call through a dynamic value is the dispatcher's like a method call on one: its arguments, and the fields of a literal passed (`d(o, k, { value: 1 })`), land in carriers (`dispatchedArgument`) | `landsInCarrier` |
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
  `d(o, "x", {value: 1})`, stored in an object / closure, passed as an argument, `({defineProperty: d}).defineProperty(…)`;
  the same for `getOwnPropertyDescriptor`, `create`, `defineProperties`; `getOwnPropertyNames` held (identity, `typeof`)
  with its call aborting. Every write route (before/after the call, in a called or never-called function, an alias, a
  parameter, a literal or computed key, `defineProperty`) never yields a folded answer. Shadowing means the user's
  binding. Each agreement has a wrong twin. No wrong value, invalid Wasm or exception out of `compile()`.
- Cost: programs that do not hold the `object` family, or that may not replace the static they call, are
  byte-identical to the base; the ordinary pipeline is byte-identical.
- Code quality: no `=== "Object"` test outside the catalog and key modules; one pin function; one identity table; one
  static algorithm; `src/ir/from-ast.ts` does not grow; IR→runtime import edges stay at 10.

## Result (2026-11-27, branch `claude/7580-object-statics`, base `claude/7574-object-value` f47efc338f)

**Built** (`src/`: about +230 / −65):

- Held as values (identity, `typeof`, `name`, `length`, stored, passed): `create`, `defineProperties`,
  `defineProperty`, `getOwnPropertyDescriptor` (callable through the value) and `getOwnPropertyNames` (held; its call is
  the run-time abort until #7574 slice 3). Every other static (`keys`, `getPrototypeOf`, `freeze`, …) keeps refusing by
  name. Each static is held where a constant key names it (the one pin function), so a program that reads none holds
  none.
- Called through the value: `var d = Object.defineProperty; d(o, "x", {value: 1})` is the static's algorithm (the same
  function as the folded call), arguments padded with `undefined`; tested on a detached call or a method call under the
  static's own name, exactly `Array.isArray`'s rule (one `reads` predicate now serves both). Under another name
  (`({f: d}).f(…)`) the dispatcher's built-in arm aborts: testing every name inlined each algorithm at every method call
  (measured: the prelude grew to 197 KB / 50 s).
- The escape rule: `ProgramObjects.replacedStatics` (`source-plain-objects.ts`, `programObjects`): the held statics a
  program holding the `object` family may replace (a member of that name written anywhere, a reflective route,
  dynamic code, or `Object` handed on). `dynamicObjectStatic` folds unless the static is in it; then the call reads
  the member `Object` holds and answers by identity, else aborts. The escape half is one set in the shared walk
  (`sourceLetsIntrinsicEscape`, `isInertUse`); #7574's `foldedRealmReceiver` became `realmReceiverRead`, which also names
  the member a read takes (`X.prototype` and the static values read it).
- Flow rule: a call through a dynamic value is the dispatcher's, so its arguments and a literal argument's fields land
  in carriers (`dispatchedArgument`, shared with the method-call case).
- Folded: the `A1b` history comment in `ordinary-to-primitive.ts`.

**Refuses or aborts:** a replaced static's folded call (alias, parameter, the root's `constructor`) aborts; the
statement forms `Object["m"] = f` and `Object.defineProperty(Object, "m", …)` refuse (expando: `Object` not
pristine, as before); `Object[k]` refuses (computed key); `Object.hasOwnProperty("m")` refuses (not in the identity
row); a prototype method moved under another name aborts (receiver rules unchanged). `Function`, `call`/`bind`/`apply`
untouched.

**Proof** (local node 22, load 4–7 from other agents):

- Probes vs node in a fresh realm, each agreement with a wrong twin: 29 programs: right 18, refused 5, aborted 6, wrong 0,
  invalid 0, exceptions 0. The coordinator's argument-position probe (`d(Object.prototype, "g", …)`, read off `1`)
  agrees.
- Tests: `tests/issue-7580-object-statics.test.ts` 25/25. Moved pin: #7574's "a static read as a value" refusal.
- Cost: `var d = Object.defineProperty;` 25,419 B (`var O = Object; typeof O` 24,840 B); the three harness lines
  28,129 B; prelude + three lines 118,627 B against prelude + `var __O = Object` 111,111 B on the base (+2.5 KB per held
  static; the rest is #7574's family). Compile time of that prelude 21.8 s vs 17.2 s under load 5–7 (not a clean
  measurement).
- Bytes: Prepared corpus (8 programs incl. the prelude) and 4 Object programs that fold without replacement
  (`typeof Object`, `instanceof Object`, `Object.create(null)`): identical. Ordinary pipeline 30 × 2 identical.
- Harness: the 12 `propertyHelper.js` programs of `built-ins/Object/defineProperty` first stop at line 31
  (`Function`) before and after; lines 28–30 alone refused on the base and compile now.
- test262 `mw-00` (87 rows): pass 19 / fail 11 / ce 57 before and after, every row identical.
- `src/ir/from-ast.ts` 17,393 → 17,393. Gates at the merge base all pass; with `LOC_GATE_BASE=origin/main` LOC and
  function budgets fail only in files this branch does not touch (main moving).
- Base test files run alone: #7574 (28), #7354-m-refusals (43), #7354-m-prototype-premise (17), #7352 arrays (29),
  #7561 wrappers (agreement slice). `issue-3518-native-realm-requirements` fails one catalog census row on the base too
  (#7561/#7352/#7574's native ids; this branch changes no `implementation`).
