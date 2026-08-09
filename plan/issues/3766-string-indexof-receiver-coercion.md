---
id: 3766
title: "String.prototype.indexOf receiver coercion loses primitive undefined results"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: s
feasibility: moderate
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-methods
goal: test262-conformance
assignee: "ttraenkler/codex-es5-string-indexof-receiver"
related: [2742, 3751, 3763]
loc-budget-allow:
  - src/codegen/coercion-engine.ts
  - src/codegen/type-coercion.ts
  - src/codegen/shared.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - tests/issue-3766-string-indexof-receiver-coercion.test.ts
func-budget-allow:
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/type-coercion.ts::tryStructStringHintHostDispatch
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/new-builtin-globals.ts::emitStringWrapperValue
---

# #3766 — preserve primitive `undefined` during String receiver coercion

## Root cause

The ES5 `String.prototype.indexOf` T8/T9 tests construct their receivers through
`String(object)` and `new String(object)`. Their conversion methods return the
primitive `undefined` by falling off the function body.

Two representation gaps changed that result:

- native String coercion treated a void-returning method as a failed
  OrdinaryToPrimitive attempt instead of the successful primitive
  `undefined`;
- the host wrapper constructor deferred object coercion to the runtime bridge.
  Top-level Test262 code runs in the Wasm start section, before the host can call
  exported closure dispatchers, so it fell back to `"[object Object]"`.

The fix dispatches statically-known void-returning object-literal methods in
Wasm, observes string-hint ordering (`toString` before `valueOf`, skipping a
non-callable own property), and normalizes the result to the string
`"undefined"`. `new String(value)` now applies the shared ToString engine before
constructing the wrapper in both host and standalone modes.

## Stack dependency

This branch is stacked on ready PR #3751, which introduced native
`new String(value)` ToString coercion. Its commit is replayed above the latest
`origin/main`; #3766 extends that route to the host lane and completes the
void-result/fallback semantics. #3751 remains unchanged and is not merged by
this lane.

## Validation

- exact ES5 T8/T9 receiver shapes at module-start timing in host and standalone;
- focused method-order and exactly-once side-effect guards;
- same-SHA host/standalone A/B over the explicit ES5 and full
  `String.prototype.indexOf` cohorts;
- typecheck, lint/format, oracle ratchet, structural budgets, and focused
  wrapper/string regression suites.

### Same-SHA Test262 A/B

Both controls use dependency/base commit `27086a8313bb0c`, with only the #3766
working-tree patch added for the fixed arm.

| target     | explicit ES5 (34)    | full indexOf (47)      | status changes  |
| ---------- | -------------------- | ---------------------- | --------------- |
| host/GC    | 29→31 pass, 5→3 fail | 34→36 pass, 13→11 fail | T8/T9 fail→pass |
| standalone | 26→28 pass, 8→6 fail | 30→32 pass, 17→15 fail | T8/T9 fail→pass |

After excluding T8/T9, sorted `file/status/error_category/error_signature`
fingerprints are byte-identical between arms:

- host/GC:
  `ef5897e0c2aa169c65307df2b61296e58c5e45f7d1b7a5f42aab138bea14c3d9`;
- standalone:
  `6a859a54be467e19d13e91183db2f2fc90d9f3584b5003aa481292f1e9720148`.

## Merge-queue regression repair

The first merge-group run exposed two assumptions that were narrower than the
ECMAScript operations this code serves:

- the struct fast path ran for the `"default"` hint as well as `"string"`.
  That changed `BigInt(object)` from `valueOf`-first to `toString`-first and
  trapped the exact Test262 row
  `built-ins/BigInt/call-value-of-when-to-string-present.js`;
- an `externref` closure result was treated as proof that `toString` returned a
  primitive string. `externref` is only the Wasm carrier and can also contain an
  object/function, in which case OrdinaryToPrimitive must continue to
  `valueOf`.

The repair therefore keeps the direct closure call restricted to the string
hint and classifies opaque host results with the existing Type(x)-is-Object
predicate. A primitive result is stringified; an object result falls through to
the next method, and a second object result throws the required TypeError.

The same failed merge group also caught a representation boundary in
`new String(value)`: a host `externref` can be a dynamic object whose
conversion methods live in the host sidecar, including properties assigned
after literal construction. Pre-stringifying that value during module start
cannot invoke its callback-backed methods. Host `externref` values now remain
raw for the real `__new_String` constructor, while statically-known WasmGC refs
still use the module-start-safe in-Wasm conversion above.

Regression controls use the exact two merge-queue rows:

- `built-ins/BigInt/call-value-of-when-to-string-present.js` guards default-hint
  ordering;
- `built-ins/String/S15.5.2.1_A1_T13.js` guards object-result fallthrough and a
  dynamically assigned throwing `valueOf`.

A focused closed-struct case separately proves that opaque `toString` results
are classified before the in-Wasm `valueOf` dispatch.

## Coercion-engine gate repair

The merge-queue repair initially reserved and looked up the host
`externref`-to-string import directly in `type-coercion.ts`. Although the
runtime behavior was correct, that created a second owner for sealed ToString
vocabulary and failed the coercion-site drift gate.

The canonical provider reservation now lives in `coercion-engine.ts`, and both
the engine's ordinary dynamic-externref arm and the nested struct dispatch use
that provider. A registered delegate in `shared.ts` breaks the existing
engine↔type-coercion import cycle; it does not duplicate the conversion matrix.
This matters beyond satisfying the gate: future changes to default-hint versus
string-hint host routing now have one implementation point.
