---
id: 7580
title: "Prepared path: `Object` statics as values, and the rule that decides when a static's call may fold"
status: done
completed: 2026-11-28
sprint: current
created: 2026-11-27
updated: 2026-11-28
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

> Superseded by Review r1 below: this source rule was incomplete and is removed; the kernel holds the invariant.

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
  static's own name, exactly `Array.isArray`'s rule (r1: one table of held statics at the dispatcher). Under another name
  (`({f: d}).f(…)`) the dispatcher's built-in arm aborts: testing every name inlined each algorithm at every method call
  (measured: the prelude grew to 197 KB / 50 s).
- The escape rule: as first built, `ProgramObjects.replacedStatics` (a source rule). Review r1 found it incomplete; it
  is removed (see Review r1). What remains of the source walk is precision only: `staticValues`, every held static
  where `Object` is handed on (`sourceLetsIntrinsicEscape`, `isInertUse`), else those a read names; #7574's
  `foldedRealmReceiver` became `realmReceiverRead`, which also names the member a read takes (`X.prototype` and the
  static values read it).
- Flow rule: a call through a dynamic value is the dispatcher's, so its arguments and a literal argument's fields land
  in carriers (`dispatchedArgument`, shared with the method-call case).
- Folded: the `A1b` history comment in `ordinary-to-primitive.ts`.

**Refuses or aborts:** a write that would change a static of `Object` (alias, parameter, the root's `constructor`,
a descriptor's `value`) aborts where it runs (r1); the
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

## Review r1 (2026-11-28)

**Finding (blocking):** the base aborted, the head answered wrong:

```js
function g(k){ return Object.getOwnPropertyDescriptor(Object.prototype, k); }
var e = g("construc" + "tor");
Object.defineProperties(e.value, {create: {value: function(){ return "f"; }}});
var out = typeof Object.create(null);   // node "string", head "object"
```

`Object` is reachable without escaping and without a reflective name (the root's `constructor` under a key the source
does not spell), and the write walk counted only `defineProperty`'s key, not a `defineProperties` / `Object.create`
map's. The source rule could not be argued complete; #7579's computed keys add a further route.

**Invariant chosen:** a direct `Object.m(…)` is the folded built-in, read from nothing, and that is right because **no
run-time write changes a static of `Object`**. The kernel enforces it, not the source walk: `%Object%` names its held
statics in the catalog (`NativeRealmIntrinsic.fixed`); where a realm holds one, the bag carries `BUILTIN_FIXED_FLAG`
and a define, an effective [[Set]] and an effective delete on it abort (`abortWhereFixed`, used by
`buildBuiltinFunctionDefine`, `buildBuiltinFunctionWriteOwn`, `buildBuiltinFunctionDeleteOwn` and OrdinarySet,
`buildSourceObjectSetDefinition`). Where a realm holds none, a write of one misses the identity row, which aborted
already. Every route ends in one of those bodies, so a route the source walk never thought of is an abort, never a
stale answer.

**Why this and not a wider source rule:** completeness of a source rule needs every way to obtain `Object` and every
way to write a key, and both sets grow with each slice. The kernel sees the write itself. The alternative of keeping a
compile-time "may be replaced" set next to the backstop (so that a replaced static could be called through its alias)
would have carried a source fact into the realm seed for programs no harness file contains; it is left out.

**Cost of the choice:** `var O = Object; O.create = f` now aborts at the write (as on the base), where the first round
ran it and aborted at the next folded call. A write that takes no effect is unchanged (`O.length = 9`,
`O.prototype = 1` are ignored as in node). A program that holds no static is byte-identical to the base.

**What changed:**

- removed: `ProgramObjects.replacedStatics`, the [[Get]]-and-identity form of the folded call
  (`dynamicObjectStatic` is the algorithm again), the four shared-walk questions `replaces` asked;
- added: the catalog field, the mark in `realmFamilySeed`, `abortWhereFixed` (one body, shared with the
  identity-only miss through `abortWhereMarked`), `holdsFixedProperty` (`native-realm-families.ts`);
- `Array.isArray` is not under this rule and needs none: no call of it is folded, every call reads the member and
  tests identity. It and the held `Object` statics are now one table at the dispatcher
  (`dynamicPrototypeMethodCall`, `statics`). Probed: alias write, `defineProperty` on an alias, the descriptor route
  through `Array.prototype`, a held value after replacement: all node's answer.
- folded nits: dead imports in `dynamic-error-constructors.ts`; lines over 120 columns this branch wrote; the
  hoisting nit is moot (the function is gone).
- the delete arm is not reachable from source today (`delete` has no Prepared lowering); it is kept because the
  invariant is the kernel's and `deleteOwn` is one of the bag's three mutators.

**Proof** (node 22, load 3–6 throughout, never under 3.5):

- Probes vs node in a fresh realm, wrong twin for each agreement: 30 programs: right 14, aborted 14, refused 2
  (`delete`, a computed-key store), wrong 0, invalid 0, exceptions 0. The finding's program and its variants (three
  statics; call inside and outside a function; write before and after; `({}).constructor`; a descriptor's `value` by
  `defineProperties`, by assignment; a parameter; a held `defineProperty` / `defineProperties` on an alias) abort;
  `O.create(p, map)` on an alias, a write in a never-called function and ignored read-only writes answer as node.
- Bytes: 10 programs with direct calls only (two behind the `assert.js` + `sta.js` prelude) identical to the base;
  ordinary pipeline 30 × 2 identical to the base record of round one.
- Cost: prelude + the three harness lines 118,802 B against prelude + `var __O = Object` 111,111 B on the base
  (+7.7 KB, 2.6 KB per held static: its realm entry and its identity row at the prelude's detached calls); compile
  12.4 s against 11.9 s (medians of 3 at load 4.7–6: not a clean measurement). Round one's head measured 13.1 s in the
  same session; its extra time was the [[Get]]-and-identity form at folded calls, now gone.
- Tests alone: `issue-7580-object-statics` 33/33 (8 new rows), `issue-7574-object-value` 28/28,
  `issue-7352-arrays` 29/29. Typecheck clean. Gates pass at the merge base; with `LOC_GATE_BASE=origin/main` the LOC
  and function budgets fail only in files this branch does not touch. `src/ir/from-ast.ts` 17,393.
- Boundaries inventory: no error, no transitive violation; r1 adds no module edge. Against the base the branch has
  one more unenforced inventory edge, round one's `source-plain-objects.ts` → `shared/intrinsic-prototype-writes.ts`
  (seven sibling IR modules import the same walk).
- Not re-run in r1: the `mw-00` test262 sample.
