---
id: 6913
title: "Native regime / standalone: `arguments[k]` beyond the formals is lost in a HOF callback once any function carries an expando property"
status: done
assignee: ttraenkler/opus-6913
completed: 2026-10-09
created: 2026-10-07
updated: 2026-10-09
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: es5
goal: architecture
sprint: current
parent: 5385
related: [6898, 6880, 6877]
# 2026-10-10 (#6913): +1..+3 lines each — one call into the new
# closures/closure-type-sources.ts plus its import, at the sites where a closure
# value enters (or is looked up on) a shared wrapper type. The logic itself
# lives in the new module.
loc-budget-allow:
  - src/codegen/closures/method-trampolines.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/array-methods.ts
func-budget-allow:
  - src/codegen/closures/funcref-as-closure.ts::emitFuncRefAsClosure
---

# #6913 — `arguments[2]` is undefined in a 2-formal callback when the module has a function expando

## Problem

ES5 rows `built-ins/Array/prototype/filter/15.4.4.20-9-c-ii-11.js` and
`built-ins/Array/prototype/map/15.4.4.19-8-c-ii-11.js` pass on the host lane
(baseline 2026-10-07, both modes) and fail on standalone. They also fail on
the native regime once #6898 removes the unused `$262` shim (the regime used
to pass them only because the shim's direct `eval` put the module into
runtime-eval mode). ES5 is a `completed` edition, so #6898 cannot land while
they fail, and they are **not** eligible for the ratchet `exceptions` list:
the host lane passes them.

## Reduction (standalone and `native-first`, 2026-10-07)

```js
function assert(m) { return m; }
assert._isSameValue = function (a, b) { return a === b; };   // any function expando
function callbackfn(val, idx) { return val > 10 && arguments[2][idx] === val; }
var newArr = [11].filter(callbackfn);   // TypeError: Cannot access property on null or undefined
```

Delete the expando line and the same program answers `newArr.length === 1`.
Every test262 row has this shape, because `harness/assert.js` assigns
`assert._isSameValue`, `assert.sameValue` and so on. The extra (third)
argument `filter`/`map` pass to the callback never reaches its `arguments`
object: `arguments[2]` reads `undefined`/null. My guess is that the expando
switches function declarations onto the property-bag closure representation
(`closure-props.ts`), and that path's callback dispatch does not carry the
extras-argv (`emitSetExtrasArgv`) for arguments beyond the declared arity.

## Where to look

- `src/codegen/closure-props.ts` (function-object own properties) and the
  closure call path in `src/codegen/closures.ts`. opus-6877 is working in
  `closures.ts` (capture collector), so coordinate before editing.
- The HOF callback invocation in `array-prototype-borrow.ts` (`callClosure`)
  and `hof-native.ts` (`__apply_closure` with a 3-element args vec). Check
  which of the two the reduction reaches.

## Acceptance

- [x] Both rows pass on `--target standalone` and on `native-first`.
- [x] A focused test for the reduction (with and without the expando).
- [x] Default gc byte-identical.

## Root cause (2026-10-09, opus-6913)

Not the expando materialisation and not the `arguments` packing. A
capture-free closure and a function declaration's first-class value both
allocate the SHARED per-signature wrapper struct, and
`ctx.closureInfoByTypeIdx` is keyed by that struct type. Registering a function
expression (`registerClosureBindingInfo`) overwrote the type's entry with that
one source's facts: `needsCallSiteArity: false` ("never reads `arguments`") and
`inlineBody`. `assert._isSameValue = function (a, b) {…}` is constructible with
two externref params, exactly the wrapper type of `function callbackfn(val, idx)`,
so the array-HOF site for `[11].filter(callbackfn)` read `false` and skipped the
`__argc`/extras-argv plumbing; `arguments[2]` was then `undefined`.

The same defect miscompiled a second shape on every lane, gc included:

```ts
const o: any = {};
o.f = function (x: number): number { return x * 2; };
function d(x: number): number { return x + 100; }
[1, 2].map(d)   // was [2, 4]: the HOF inlined o.f's body for d
```

## Fix

New `src/codegen/closures/closure-type-sources.ts` records, per struct type,
every source known to allocate it (function expressions/arrows at
registration; function declarations and object-literal methods when their
value is materialised in `ensureFuncClosureSingleton` / `emitFuncRefAsClosure` /
`emitObjectMethodAsClosure`), and propagates each to ancestor entries (values
of a subtype are read through the supertype).

- One source: the entry carries its exact facts, as before.
- Two or more: `needsCallSiteArity` is the conservative merge (any `true` wins;
  `false` only if every source is known not to observe arity) and `inlineBody`
  is dropped.
- A declaration known not to read `arguments` is "neutral": it never lowers
  the conservative wrapper default, so declaration-only modules are unchanged.
- `setupArrayCallback` keeps a closure LITERAL's own facts
  (`exactClosureInfoForLiteral`): the value at that site is the literal, so
  `arr.map(x => x * 2)` still inlines when its type is shared.

Measurements (2026-10-09, this branch vs `.tmp/base-*` copies of upstream/main
fefc9c0e79): default-gc output is byte-identical on 132 probes (benchmarks
suites and 125 harness-prefixed Array HOF test262 files). The focused test
fails 9 of 12 on base and passes 12/12.

The two rows on the regime lane (`JS2WASM_EVAL_ENGINE=interpreter`,
`TEST262_SEMANTIC_PROVIDERS=native-first`, refusal provider prebuilt): `pass`
before and after on this branch. On main they already pass because the unused
`$262` shim still puts the module into runtime-eval mode; the failure only
shows once #6898 removes the shim, so the decisive before/after is the
reduction (standalone and `native-first` both TypeError before, pass after),
which `tests/issue-6913-*.test.ts` pins. A standalone-target row run hit the
10 s compile timeout under box load 40-170 and is not evidence either way.

Not fixed here: on the host (gc) lane, a callback passed through a *variable*
(`var v = callbackfn; [11].map(v)`) or a function parameter still loses
`arguments[2]`. It goes through the host bridge, the same on base, and it is
outside the regime/standalone scope of this issue.
