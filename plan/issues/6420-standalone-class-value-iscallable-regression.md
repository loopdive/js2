---
id: 6420
title: "Standalone IsCallable conflates class values with `typeof \"function\"` after #5383's class-value tag repair"
status: backlog
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: classes
goal: standalone-mode
requested_by: ttraenkler/codex-5350-super-rescue
related: [5350, 5383, 4221, 5242]
---

# #6420 — class values are not callable, even though `typeof classValue` is `"function"`

## Problem

The standalone class-value fix in #5383 correctly made a materialised class
value report `typeof value === "function"`. It did that by adding a
class-singleton identity arm to `__typeof_function` in
`src/codegen/typeof-natives-finalize.ts` (commit
`3b9744f0562becc42f9070ca1d2f673a1c2f1ebd`, #5383 S2f R12/R13).

That is a `typeof` repair, not an `IsCallable` repair. A class constructor has
`[[Construct]]` but no `[[Call]]`; calling it without `new` must throw a
`TypeError`. The pre-existing #5350 object-literal super-call lowering instead
uses `__typeof_function` as its callable guard:

```js
class K { constructor() {} }
const proto = { v: K };
const o = { __proto__: proto, m() { return super.v(); } };
o.m(); // TypeError: class K is not callable without new
```

On Node v22.23.2 the reduction reports `typeof K === "function"` and catches
`TypeError` (`function|TypeError|true`). On current main
`d4108568d43f14c361ecc3a58c82633027eaae39`, standalone instead routes `K`
through `__apply_closure`, which has no class-object dispatcher and returns the
null/undefined carrier; the #5350 pin consequently observes `0` rather than
its expected `2`.

This is directly covered by the existing regression assertion
`throws TypeError when an object literal's super member is a class` in
`tests/issue-5350-super-property-r1.test.ts`. Its adjacent plain-object
non-callable control and callable-carrier control remain important: the repair
must not turn ordinary, bound, arrow, generator, async, builtin, or
getter-returned functions into throws.

### Bisect / provenance

The exact unchanged pin was run in detached source archives with shared
dependencies:

| revision | result for the one pin | conclusion |
| --- | --- | --- |
| `0236a6122361a487340d61f3fefc02465549fed0` | 1 passed, 32 skipped | last good |
| `3b9744f0562becc42f9070ca1d2f673a1c2f1ebd` | 1 failed, 32 skipped (`0`, expected `2`) | first bad, direct child of the last good |
| `d4108568d43f14c361ecc3a58c82633027eaae39` | 32 passed, 1 failed | still bad |

The historical #5350 rescue commit
`357b05f68c8c76b8c4888690941edf9d247243ab` runs its full 41-case pin file
green. A current-main rescue candidate runs 40/41: the seven intended
super-property gains pass and only this independently introduced class-value
callability regression remains. Therefore it is neither caused by the rescue
nor a missed hunk from its historical patch.

The semantic distinction is normative: [ECMAScript `EvaluateCall`, step
5](https://tc39.es/ecma262/#sec-evaluatecall) requires an `IsCallable` check,
while [`typeof`](https://tc39.es/ecma262/#sec-typeof-operator) deliberately
reports a class constructor as `"function"`. Object-literal `super.v()` first
resolves the SuperProperty reference and then follows that call path; see
[SuperProperty](https://tc39.es/ecma262/#sec-super-property).

## Implementation plan

1. Inventory every standalone consumer of `__typeof_function` and classify it
   as a real `typeof` query or an `IsCallable` query. Do not weaken the #5383
   identity arm: dynamic `typeof K` must remain `"function"`.
2. Introduce or factor a host-free `IsCallable` predicate with an explicit
   carrier contract. It must recognise compiled closures, bound functions,
   async/generator callables, callable builtin carriers, and valid link-boundary
   callables, while rejecting local and linked class-object singletons,
   instances, and ordinary data objects. `__reflect_is_constructor` cannot
   substitute for it because constructible ordinary functions are callable too.
3. Route the #5350 object-literal super-call guard through that predicate, while
   preserving `EvaluateCall` order: get the super member, evaluate arguments,
   test callability, then invoke with the original receiver. A rejected class
   must throw before `__apply_closure` can manufacture its null result.
4. Audit other dynamic-call guards that currently equate `typeof ===
   "function"` with `IsCallable`; split only the ones proved to have the same
   class-value exposure. Keep a focused first PR if a shared predicate is not
   yet safe to widen.
5. Add an issue-local test covering local and linked class values, the direct
   object-literal super reduction above, a plain-object negative control, and
   the existing callable carriers. Test `typeof K === "function"` alongside the
   throwing call so the two abstract operations cannot be conflated again.

## Acceptance criteria

- The reduction throws and the existing #5350 class-super pin returns `2` on
  standalone, matching Node; `typeof K` remains `"function"`.
- Plain-object and missing-member negative controls still throw, while ordinary,
  bound, arrow, getter-returned, generator, async, builtin, and linked callable
  controls still invoke normally.
- Local and linked class values are rejected by the call predicate without
  changing dynamic construction (`new K(...)`) or the #5383 Temporal/provider
  `typeof` fixes.
- Focused issue suites, affected class/callable neighbours, typecheck, lint,
  formatting, and the applicable ratchets pass; changed authoritative Test262
  rows are measured with a pass-to-fail set difference.

## Handoff

This issue was found while rescuing #5350 onto current main. It is deliberately
**not implemented on that rescue branch**: the first bad commit belongs to the
independent #5383 class-value representation/callability mechanism, and a
correct solution needs a shared carrier inventory rather than a special case in
object-literal super lowering. Start from fresh `upstream/main`, retain #5383's
correct `typeof` result, and use the bisect and existing #5350 pin above as the
baseline proof.
