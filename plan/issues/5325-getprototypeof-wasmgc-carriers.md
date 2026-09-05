---
id: 5325
title: "Object.getPrototypeOf answers Object.prototype for a Date and null for an Array when the receiver arrives as a parameter"
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
# 2026-09-05 — +5 lines in src/runtime.ts and +4 in resolveImport. The whole
# mechanism (helper, discriminators, rationale, decline list) lives in the new
# subsystem module src/runtime/wasm-carrier-prototype.ts, which cut the first
# implementation's +87/+8 to +5/+4. What remains is one import line and the
# three-line call site, and it cannot move: the query has to be answered INSIDE
# the `__getPrototypeOf` arm, after the explicit-link / Object.create / fnctor
# checks and before the `__is_data_struct` default, so the ordering IS the fix.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
---

## Problem

`Object.getPrototypeOf(x)` gives a wrong answer whenever `x` reaches the host as
an opaque WasmGC carrier — which is exactly what happens when the receiver
arrives through a call boundary rather than being written inline at the query.
Measured (native passes, Wasm fails):

```js
function isObjProtoAny(obj) { return Object.getPrototypeOf(obj) === Object.prototype; }
isObjProtoAny(new Date())   // Wasm: true   expected false

function protoIsNull(obj) { return Object.getPrototypeOf(obj) === null; }
protoIsNull([1, 2])         // Wasm: true   expected false
```

Chaining a second hop off the array then throws `Cannot convert null to object`.

This is the whole of redux 5's `isPlainObject`:

```js
let proto = obj;
while (Object.getPrototypeOf(proto) !== null) proto = Object.getPrototypeOf(proto);
return Object.getPrototypeOf(obj) === proto || Object.getPrototypeOf(obj) === null;
```

so a `Date` takes the first disjunct (its answer IS the walk terminal) and an
`Array` the second — `isPlainObject` answered **true for everything**. Every
`isPlainObject`-style guard in published JS has the same shape, so this is broad
runtime correctness, not one package.

Inline forms were already correct, which is what hid it: codegen folds
`Object.getPrototypeOf` at compile time on a long cascade keyed on the ARGUMENT
EXPRESSION SHAPE (`src/codegen/expressions/call-builtin-static.ts`,
`expressions/object-get-prototype-of.ts`). A bare parameter identifier matches
none of those arms and falls through to `emitBuiltinGetPrototypeOfFallback` →
the `__getPrototypeOf` host import.

## Root cause

`src/runtime.ts`, the `__getPrototypeOf` host import. For a receiver with no
explicit `setPrototypeOf` link, no `Object.create` record and no fnctor ctor,
there were exactly two answers:

| discriminator | answer | correct? |
| --- | --- | --- |
| `__is_data_struct(obj) === 1` | `%Object.prototype%` | right for an object literal, **wrong** for a Date carrier |
| anything else → native walk | `null` | **wrong** for a vec (Array) and for a compiled closure |

Instrumented at the boundary (wrapped host import, receivers as they actually
cross):

| receiver | `__is_data_struct` | `__is_vec` | `__is_closure` | `__\0js2_is_date` | `__dv_byte_len` | answered |
| --- | --- | --- | --- | --- | --- | --- |
| `new Date()` | 1 | 0 | 0 | **1** | -1 | `Object.prototype` |
| `[1,2]` / `["a"]` / `[{}]` | 0 | **1** | 0 | 0 | -1 | `null` |
| `function(){}` / `() => 1` | 0 | 0 | **1** | 0 | -1 | `null` |
| `new ArrayBuffer(4)` / `new DataView(...)` | 0 | **1** | 0 | 0 | **4** | `null` |
| `{x:1}` | 1 | 0 | 0 | 0 | -1 | `Object.prototype` (correct) |
| class instance / `A.prototype` | 1 | 0 | 0 | 0 | -1 | `Object.prototype` |
| Map / Set / RegExp / Error / TypedArray | — | — | — | — | — | real host objects, already correct |

## Fix

New subsystem module `src/runtime/wasm-carrier-prototype.ts` exporting
`wasmCarrierBuiltinPrototype`, consulted from the `__getPrototypeOf` arm in
`src/runtime.ts` **before** the `__is_data_struct` default and before the native
walk, using the module's own positive discriminators:

- `__\0js2_is_date(obj) === 1` → `Date.prototype`
- `__is_vec(obj) === 1` and NOT byte-backed → `Array.prototype`
- `__is_closure(obj) === 1` → `Function.prototype`

The explicit `_wasmStructProto` link, the `Object.create` record and the fnctor
ctor are all still checked first, so nothing that already had an answer moves.

Returning the **host realm's** `X.prototype` is the right identity: in JS-host
mode every compiled `X.prototype` read resolves to that same object (verified
across Object/Array/Date/Function/RegExp/Error/Map/Set/String/Number/Boolean),
so `Object.getPrototypeOf(d) === Date.prototype` holds by `===` and the next hop
off it is a real host object the native walk understands.

### Deliberately not answered

- **The byte-backed vec carriers.** `ArrayBuffer` and `DataView` both lower to an
  i32_byte vec and `__is_vec` cannot separate them from each other. They are
  EXCLUDED from the `Array.prototype` answer via `__dv_byte_len` (their positive
  discriminator, -1 for an ordinary array) rather than mislabelled as arrays, so
  they keep today's `null`.
- **A compiled CLASS INSTANCE.** It is a named data struct — and so is the
  class's own prototype singleton, which `emitLazyProtoGet` materializes as a
  struct of the same type. Nothing the module exports tells them apart, so
  answering here would need a new codegen-side discriminator plus a way to reach
  (and lazily materialize) the class's prototype global from the host. That is a
  separate change; the class arm keeps the `%Object.prototype%` default.

### Cost

Three extra `ref.test` cascade calls per `__getPrototypeOf` MISS (a receiver with
no explicit link, no `Object.create` record, no fnctor ctor). Deliberately not
micro-ordered around `__is_data_struct`: a Date IS a data struct, so the date
probe has to run before that arm either way, and the remaining two are `ref.test`
chains over the module's own type set. This import is not a hot loop — it is
reached only by a reflective `Object.getPrototypeOf` on a dynamic receiver, and
every fold-able shape is already answered at compile time without a host call at
all (verified: the inline forms make ZERO host calls).

## Measurements

At `upstream/main` 64f6913141.

**redux's real `src/utils/isPlainObject.mjs`**, 13 receiver kinds through the
upstream harness (native 13/13 in both runs):

| | before | after |
| --- | --- | --- |
| Wasm | 10/13 | **12/13** |

The three that were wrong were `Date`, `Array` and class instance; the class
instance is the residual above. `Object.create(null)`, the object literal,
strings/numbers/null, RegExp, Map and Error were correct before and after.

**`Object.getPrototypeOf(<param>)` identity matrix**, 21 receiver kinds compared
against the compiled module's own `X.prototype` values: 5 wrong before
(`Date`→ObjProto, `Array`→null, function→null, arrow→null, ArrayBuffer→null),
2 wrong after (ArrayBuffer, class instance — both listed above).

**redux upstream suite:**

| | before | after |
| --- | --- | --- |
| redux total | 60/82 | **61/82** |
| `createStore.spec.ts` | 33/42 | 34/42 |

`isAction.spec.ts` stays 0/1 — its only test asserts `new Action()` at assertion
7, i.e. the class-instance residual. `isPlainObject.spec.ts` stays 0/1 for a
different reason entirely, recorded below.

Regression test `tests/issue-5325-getprototypeof-wasmgc-carriers.test.ts`,
untyped `.js` fixtures in a two-file project:

| | before | after |
| --- | --- | --- |
| test file | 3/7 | **7/7** |

The 3 that pass in both runs are the preservation checks (object literal,
`Object.create(null)`, `Object.create(<literal>)`, explicit `setPrototypeOf` on a
struct) and the class-instance residual.

## Cross-package A/B

17 npm upstream suites, both runs at the SAME head (`upstream/main` 64f6913141),
one suite at a time, compared per test FILE as well as per package. `hono` and
`uuid` never print an `admitted` headline, so they are scored per file
(37/52 and 75/75 respectively). Every suite exited 0 in both runs.

| package | before | after |
| --- | --- | --- |
| axios | 191/231 | 191/231 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| hono (per file) | 37/52 | 37/52 |
| jest | 299/356 | 299/356 |
| jsdom | 6/6 | 6/6 |
| lodash | 53/62 | 53/62 |
| marked | 2/30 | 2/30 |
| moment | 4/10 | 4/10 |
| prettier | 51/151 | 51/151 |
| **redux** | **60/82** | **64/82** |
| styled-components | 9/9 | 9/9 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| three | 17/18 | 17/18 |
| uuid (per file) | 75/75 | 75/75 |
| webpack | 16/16 | 16/16 |

**No package moved except redux, and no individual test FILE moved except
redux's two.** The "after" column is both fixes applied; the split is
`applyMiddleware.spec.ts` 0/5 → 3/5 from #5324 and `createStore.spec.ts`
33/42 → 34/42 from #5325, each confirmed by its own single-fix redux run
(#5324 alone: 63/82; #5325 alone: 61/82).

## Adjacent gaps found while measuring, NOT fixed here

- **`import vm from 'vm'` is unmodelled.** `typeof vm` is not `"object"` and
  `vm.runInNewContext('fromAnotherRealm = {}', sandbox)` is a silent no-op, so
  `sandbox.fromAnotherRealm` stays `false`. `typeof vm.runInNewContext === 'function'`
  reads true (graceful-null member read), which is what stops it failing loudly.
  redux's `isPlainObject.spec.ts` asserts the cross-realm case FIRST, so that file
  is 0/1 regardless of this issue.
- **`Object.setPrototypeOf` on an array literal never reaches
  `__host_set_struct_proto`**, so no explicit link is recorded for the vec. Before
  this change the query answered `null`; now it answers `Array.prototype`. Neither
  is the assigned prototype. Asserted in the regression test as a residual so it
  cannot move silently.
- **A compiler hang** on a `getPrototypeOf` chain-walk written inline in a test-body
  arrow (`it('t', () => { let p = {x:1}; while (Object.getPrototypeOf(p) !== null) p = Object.getPrototypeOf(p); })`)
  did not finish compiling in 900 s; the same walk inside an imported `.mjs`
  function compiles in ~7 s. Reproducible on demand, not chased here.
