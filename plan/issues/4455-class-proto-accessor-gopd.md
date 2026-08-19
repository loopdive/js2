---
id: 4455
title: "gOPD on a class prototype returns undefined for accessors — blocks setter/static-method length-dflt files (R1 of #4440)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [4440, 2885, 2158, 3976, 1888]
origin: "2026-08-15 wave 10 — #4440's R1 residual: 3 setter/static-method-length-dflt files, identical on its base; gOPD on a class prototype answers undefined for accessor members."
---

# #4455 — gOPD on class-prototype accessors

READ FIRST: #4440's issue file R1 (the 3 blocked files + evidence), the #2885
descriptor-reflection core, and #2158 (class-prototype descriptor residual).
`Object.getOwnPropertyDescriptor(C.prototype, "m")` must synthesize an
ACCESSOR descriptor ({get, set, enumerable:false, configurable:true}) for
get/set members; today it answers undefined, so the propertyHelper-driven
`*length-dflt` files die before their length assert. Fix at the gOPD
synthesis for class-prototype receivers; verify the 3 files + the #4440 pin
+ a class-heavy control sample; gc/host byte-identity.

## Root cause — measured, not inferred

`#3976` slice 1 (`src/codegen/class-proto-object.ts`) already made
`C.prototype` a genuine `$Object` under standalone and installed instance
METHODS on it as own data properties, so every reflective native answers
through its existing `$Object` path. It excluded accessors **on purpose** — a
getter installed as a data property whose value is the getter function is a
silently WRONG answer, worse than absence — and left the real fix
(`$PropEntry.$get/$set`) to a later slice. That later slice is this one.

Probe on this branch's base, `--target standalone`, via `.tmp/run-one.mts`
(the real `runTest262File`), one class carrying both kinds:

```js
class C { m() {} set s(v) {} }
Object.getOwnPropertyDescriptor(C.prototype, 'm')   // → {value: function …}
Object.getOwnPropertyDescriptor(C.prototype, 's')   // → undefined
```

The same setter written as an **object literal** already answered a full
accessor descriptor, because `literals.ts` routes object-literal accessors
through `__defineProperty_accessor`. So this was not a missing runtime
capability at all: the storage (`$PropEntry.$get/$set` + `FLAG_ACCESSOR`, #1888
S5), the write native (`__defineProperty_accessor`), the read native
(`__getOwnPropertyDescriptor`) and the live-invocation arms in
`__extern_get`/`__extern_set` have all shipped. Only the class-prototype
singleton was not calling them.

Two consequences fell out of that, and both are fixed here:

1. `standaloneClassProtoObjectApplies` required at least one installable
   **method**, so an accessor-ONLY class (`class C { set m(x) {} }` — the exact
   shape of the blocked test262 files) kept the legacy defaulted struct and
   answered `undefined` for *every* own-property query.
2. Even for a class that qualified via its methods, the accessor members were
   simply not installed.

## What changed

- **New module `src/codegen/class-proto-accessors.ts`** — `installableClassAccessors`
  (own, non-static, non-private, resolvable instance accessors, in declaration
  order) and `emitClassProtoAccessorInstalls` (one
  `__defineProperty_accessor(obj, key, get|null, set|null, flags)` per member).
- **`src/codegen/class-proto-object.ts`** (+31/−7) — the applies-predicate now
  also accepts an accessor-only class; the emitter installs the accessors after
  the methods and before `constructor`; the stale "ACCESSORS are excluded"
  scope bullet is corrected rather than left to rot.

Two details that are load-bearing:

- **The halves are the CACHED singleton closures** (`emitCachedMethodClosureAccess`,
  keyed `C_get_m` / `C_set_m`), not fresh per-site closures. That is what makes
  `gOPD(C.prototype,"m").set` carry the `$fnmeta` slot #4440 attached to the
  physical member name — so the extracted setter reports the §15.1.5
  `length` (0 for `set m(x = 42)`) rather than the declared formal count of 1.
  Without it the descriptor would be right and the `*length-dflt` assert would
  still fail one line later.
- **Flag encodings differ between the two define natives.**
  `__defineProperty_value` takes bits 0/1/2 as writable/enumerable/configurable
  VALUES; `__defineProperty_accessor` takes the `computeRuntimeFlags`
  specified/value encoding. §15.7.14's `{enumerable:false, configurable:true}`
  is therefore `(1<<4)|(1<<5)|(1<<2)`, not the method arm's `0x05`. Bits 8/9
  ([[Get]]/[[Set]] specified) are left clear so the runtime reads "both halves
  specified" — a setter-only member must store its getter as ABSENT, not merge
  one in.

## Test Results

All runs are mine, on this worktree, `--target standalone` unless stated.
Base = `.tmp/base-class-proto-object.ts` (captured at the first edit) copied
back over the source; after = `.tmp/new-class-proto-object.ts`.

### The three files #4440's R1 named — 2 of 3 flip

| file | base | after |
| ---- | ---- | ----- |
| `language/statements/class/setter-length-dflt.js` | FAIL | **PASS** |
| `language/expressions/class/setter-length-dflt.js` | FAIL | **PASS** |
| `language/expressions/class/static-method-length-dflt.js` | FAIL | FAIL (R1 below — different root cause) |

### Class-heavy control population — 515 files, +2 / −0

Every `.js` at `maxdepth 1` under `test/language/{statements,expressions}/class`
(the whole directory level, not a sample), run on base and after:

| | base | after |
| - | ---- | ----- |
| pass | 292 | **294** |
| non-pass | 223 | 221 |

Diff: `+2` (the two files above), `−0`, and zero non-pass files changed
failure SHAPE. No collateral of any kind in the population most exposed to a
class-prototype representation change.

### Pins

- `tests/issue-4440.test.ts` — 14/14 pass.
- `tests/issue-4437.test.ts` — 19/19 pass.
- `tests/issue-4455.test.ts` (new, 7 tests) — 7/7 pass after; **6/7 fail on
  base**. The one that passes on base is the over-reach guard ("a static
  accessor stays OFF the prototype"), which base satisfies vacuously by
  answering `undefined` to everything.

### gc/host byte-identity — measured with a POSITIVE CONTROL

The first attempt at this was vacuous and is worth recording: hashing raw
test262 sources through `compile()` without `await` returned `success:
undefined` for all 60, so "60/60 identical" meant "60/60 failed identically".
The numbers below are from awaited compiles that produced real binaries.

| corpus | lane | identical |
| ------ | ---- | --------- |
| 60 accessor-bearing test262 class files (58 compile in host, 57 standalone) | host/gc | **60/60** |
| 16 synthetic sources (classes with methods / getters / setters / statics / inheritance, plus 5 class-free controls) | host/gc | **16/16** |
| 2-file positive control | host/gc | **2/2** |
| 2-file positive control | standalone | **1/2 — the accessor module's bytes MOVE, the method-only module's do not** |

The positive control is what makes the host row mean anything: it proves the
change is present in the build and does move standalone bytes exactly where
expected, so host identity is a real invariant here and not an artifact of
measuring nothing. (The 60- and 16-file corpora are byte-identical in the
standalone lane too — neither reads `C.prototype` reflectively, and the
prototype singleton is only emitted for modules that do.)

### Gates

`typecheck`, `biome lint` (changed files), `check:oracle-ratchet` (+0/+0),
`check:loc-budget`, `check:func-budget`, `check:stack-balance`,
`check:ir-fallbacks` — all OK, no new allowances needed. The new logic is a new
module, so neither budget gate saw growth attributable to this issue.

## Residuals, with owners

| id | residual | why it is not fixed here | owner |
| -- | -------- | ------------------------ | ----- |
| **R1** | `language/expressions/class/static-method-length-dflt.js` still fails. **This is NOT a gOPD-on-prototype defect** — #4440's R1 grouped it with the two setter files, and that grouping is wrong. Narrowed here: `var m1 = class { static m(x = 42) {} }.m` — a static member read directly off a class EXPRESSION value — evaluates to **`null` at runtime** while `typeof m1` folds to `"function"` and `m1.length` folds to `0`. Probe output, one module: `typeof=function \| ===undefined:false \| ===null:true \| call THREW TypeError: Cannot access property on null or undefined \| hasOwn:false`. The `TypeError: Cannot convert undefined or null to object` the test dies on is `__getOwnPropertyDescriptor`'s §19.1.2.8 ToObject guard firing on that null. The same class written as a DECLARATION (`class C { static m(x = 42) {} } var m1 = C.m`) passes — `language/statements/class/static-method-length-dflt.js` is green on both base and after. So the defect is the class-expression static-member value carrier, and the compile-time/runtime disagreement (folded `typeof`/`length` vs. null value) is the real bug, of which the failing test is one symptom. | **#4460 (filed 2026-08-15)** |
| **R2** | Accessors with a COMPUTED or symbol key (`get [Symbol.toStringTag]() {}`) are still not installed. `resolveClassMemberName` returns `undefined` for them, so they never enter `classMethodNames` and this module never sees a key to install under. Declining is the safe state — absent, never wrong — and is the same root as #4440's R2 and #4437's R2. | **unowned** |
| **R3** | STATIC accessors are not own properties of the class object. #3976 deliberately did not convert `__class_<C>` to an `$Object` (`new-super.ts::emitDynamicNewFallback` `ref.test`s that value against each `$ClassName` struct type by design), so there is no `$Object` to install onto. Pinned as absent by `tests/issue-4455.test.ts`. | **unowned — blocked on the #3976 class-object slice** |
| **R4** | The prototype `$Object`'s own `[[Prototype]]` is still null, so `D.prototype.__proto__ === C.prototype` and `%Object.prototype%` inheritance do not hold for accessor lookup up the chain. Inherited-accessor `set` through the proto chain is called out as out of scope by the #1888 S5 runtime arm itself. Unchanged by this slice. | **unowned — inherited from #3976** |
