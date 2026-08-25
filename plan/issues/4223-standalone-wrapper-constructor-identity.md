---
id: 4223
title: "Standalone: `Object(5).constructor === Number` is false — the primitive-wrapper constructors have no carrier and wrappers resolve no `.constructor`"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: primitive-wrappers, property-model, native-prototypes
goal: es5
related: [4200, 4201, 3006, 2907, 4217, 4176, 4034, 3133, 3183]
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4223 — primitive-wrapper `.constructor` identity (standalone)

## Symptom

```js
Object(5).constructor === Number;        // false  (undefined === null)
new String("x").constructor === String;  // false
Number.prototype.constructor === Number; // false
```

30 of the 32 failing `built-ins/Object/S15.2.{1,2}.1_A*` files assert exactly
one of those shapes.

## Root cause — TWO halves, and neither alone flips a single test

Measured on the base commit with `runTest262File(..., "standalone")`:

| expression                     | reads       |
| ------------------------------ | ----------- |
| `Number` / `String` / `Boolean`| **`null`**  |
| `Number.prototype.constructor` | `undefined` |
| `Object(5).constructor`        | `undefined` |
| `Number.prototype`             | an object ✓ |
| `Object.getPrototypeOf(new Number(7)) === Number.prototype` | **true** ✓ |

**RHS half — no carrier.** #3006 gave `Set`/`Map`/`RegExp`/… an identity-stable
`__builtin_ctor_<Name>` singleton and deliberately excluded the wrapper
constructors; #4200 then hit the same wall from the other side and wrote the
omission down verbatim ("A builtin with NEITHER carrier — `Date`, `String`,
`Number`, `Boolean`, `Function` — declines and keeps today's `undefined` …
deliberately left to a follow-up that can measure the bare-value change on its
own"). This issue is that follow-up. `Number`, `String` and `Boolean` join
`BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`; `<B>.prototype.constructor` starts
resolving for free, because builtin-proto-constructor.ts already dispatches on
that predicate.

**LHS half — the wrapper's chain has no `$Object` that could hold the key.** A
standalone wrapper is a plain `$Object` carrying its
[[NumberData]]/[[StringData]]/[[BooleanData]] under the internal-slot key
`[[PrimitiveValue]]`. Its [[Prototype]] is a **`$NativeProto`**, not a
`$Object`, so `__extern_get`'s proto-walk (which follows `$Object.$proto`)
cannot reach a place where `constructor` lives. Every wrapper `.constructor`
read fell out of the chain as a miss.

Fixing either half alone flips **zero** tests: with only the carrier the
comparison is `undefined === <object>`, with only the arm it is
`<object> === null`.

## Fix

1. `src/codegen/builtin-static-globals.ts` — add `Number`, `String`, `Boolean`
   to `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`. Only the BARE-VALUE read changes:
   every syntactic use is intercepted earlier (`Number(x)` / `new Number(x)` at
   the call/construct site, `Number.MAX_VALUE` / `Number.prototype` at the
   property-access site, `typeof Number` at the typeof fold, `x instanceof
   Number` at the instanceof lowering). The value it changes FROM is
   `ref.null.extern`.

2. `src/codegen/wrapper-constructor-carrier.ts` (new) — demand-minted
   `__wrap_ctor_String/Number/Boolean()` accessors plus the `__extern_get` arm
   that classifies a wrapper by its `[[PrimitiveValue]]` box type and calls the
   matching accessor. The classification ladder is deliberately the same one
   `__protoidx_brand_off` (#4176) uses, so a wrapper cannot be classified one
   way for its inherited properties and another for its constructor.

### Three things worth knowing if you touch this

- **The accessor, not a `global.get`.** The carrier singleton is lazily
  materialized at each read site. `assert.sameValue(o.constructor, Number)`
  evaluates the LHS first, so the wrapper read is routinely the module's FIRST
  demand for `Number` — a bare `global.get` from inside `__extern_get` reads
  `null`. Same lesson as #4217's `vec-constructor-carrier.ts`.

- **The mint hangs off `ensureObjectRuntime`, not off a call site.** The
  consuming arm lives inside the shared `__extern_get`, and a `.constructor`
  read reaches it through at least three different lowerings — the legacy
  any-receiver path (`tryEmitConstructorViaTag`), the IR `dyn.member_get` path
  (`__dyn_member_get` is a thin `__extern_get` wrapper), and plain
  externref-receiver reads at module top level. Wiring the mint to one of them
  fixed only the tests that happened to use that lowering; the first two
  attempts here each flipped a different third of the probes. The demand gate is
  therefore a module-wide syntactic pre-scan (`moduleReadsConstructorProp`),
  mirroring #3133's `moduleTouchesConstructorProp`.

- **An own `constructor` must still shadow.** `constructor` is an ordinary
  writable INHERITED property (§7.3.2). The arm consults `__obj_find(o,
  "constructor")` first and declines when the wrapper carries its own entry.
  That check is also what makes PREPENDING the arm sound: it behaves as if it
  sat at the chain-exhausted miss.

## Acceptance criteria

- [x] `Object(5).constructor === Number`, `Object("x").constructor === String`,
      `Object(true).constructor === Boolean` — with cross checks
      (`Object(5).constructor === String` stays false) so the identity cannot be
      a null≡null tautology.
- [x] `new Number/String/Boolean(...).constructor` likewise, through a runtime
      receiver.
- [x] `<B>.prototype.constructor === <B>` for the three.
- [x] An own `constructor` expando shadows the carrier.
- [x] A module that never reads `.constructor` mints nothing.
- [x] gc/host lane untouched (standalone-gated at every site).

## Results

Instrument: `runTest262File(abs, cat, 30_000, "standalone")` — the #4162 seam,
not a hand-rolled instantiate. Population: the **209** ES5 files under
`built-ins/{Object/S15.2.x.1, Number, String, Boolean}` that the 2026-08-07
standalone baseline records as failing. Re-run on this branch:

| | files |
| --- | --- |
| population (all failing on base) | 209 |
| **now pass** | **28** |
| still fail | 164 |
| still compile-error | 17 |

The 28: `Object/S15.2.1.1_A2_{T1,T2,T3,T5,T6,T7,T12,T13,T14}`,
`Object/S15.2.1.1_A3_{T1,T3}`, `String/S15.5.2.1_A1_{T1..T7,T16,T17,T18}`,
`String/prototype/S15.5.3.1_A{1,2}`, `String/prototype/constructor/
S15.5.4.1_A1_T1`, `String/prototype/replace/S15.5.4.11_A1_T15`,
`String/fromCharCode/S15.5.3.2_A4`, `Number/S15.7.3_A{1,8}`.

`Number/S15.7.3_A1` (`Number.hasOwnProperty("prototype")`) and
`S15.7.3_A8` (`"length"`) flip as a side effect: the carrier arrives with the
#2984 `length`/`name`/`prototype` own-property seed, which a runtime
`hasOwnProperty` can now see.

**Regression sample.** 70 files under `built-ins/{Object,Number,String,Boolean}`
drawn (seeded) from those the ES5 standalone baseline does NOT list as failing:
43 pass, 27 not. All 27 were then re-run on the **base commit** with the change
reverted by file-copy A/B, and **every one reproduced identically** — they are
the local runtime-eval-provider instrument gap (`js2wasm:runtime-eval` unlinkable
without a prebuilt provider), regex named-group gaps, `Array.prototype.map` as a
value, and non-ES5 files that were never in the population. No regression found.
The authoritative sweep is still CI's merge_group run.

## What did NOT flip, and exactly why (measured, not guessed)

Both remaining clusters are ONE mechanism each, and both are a different
mechanism from this issue's:

1. **`new Object(<primitive>)` — 12 files** (`S15.2.2.1_A3/A4/A5/A6_T*`).
   `new Object(num)` has TS type `Object`, so #3133's
   `classifyPlainCtorReceiverNamespace` folds `.constructor` to the **`Object`**
   namespace carrier before any runtime read happens — the assertion now
   compares two real but DIFFERENT objects (`«[object Object]» vs «[object
   Object]»` in the failure text, which is what a wrong-carrier answer looks
   like). The construction itself is already right (#3118 routes `new Object(v)`
   through `emitObjectCoercion`), so the wrapper exists; only the static fold
   is wrong. Fixing it needs the fold to decline when the receiver's ToObject
   source is provably primitive. I implemented and MEASURED the obvious version
   — matching on a `new Object(<primitive>)` receiver EXPRESSION — and it flipped
   **zero** files, because the corpus always binds first
   (`var n_obj = new Object(num); … n_obj.constructor`), so the receiver at the
   read site is a plain identifier. It was reverted rather than left in as
   untested code. A working version has to trace the identifier's initializer
   (`oracle.variableInitializerOf`) and prove no reassignment.

2. **`Object(null)` / `Object(undefined)` — 6 files** (`S15.2.1.1_A1_T1..T5`,
   `A3_T2`). These produce an ordinary `$Object`, whose `.constructor` should be
   `Object`; the read is `any`-typed, so no static fold applies and the runtime
   answer is `undefined`. The arm this issue adds deliberately declines (no
   `[[PrimitiveValue]]` slot). Extending it to "plain `$Object` ⇒ `Object`"
   would be wrong for any receiver that inherits a `constructor` from a
   prototype `$Object` (every `new F()` instance), so it needs a
   `$proto == null` gate — sound-looking, but I could not validate the blast
   radius locally, and a wrong answer here is silent.

## Leftovers (deliberately NOT in scope)

- `Number.hasOwnProperty("MAX_VALUE"|"NaN"|"POSITIVE_INFINITY"|…)` (§21.1.2)
  and `Number.prototype.hasOwnProperty("toFixed"|"toString"|…)`: the carrier
  seeds only `length`/`name`/`prototype` (#2984), and the `$NativeProto` is not
  a `$Object` at all, so runtime own-property queries on it still answer
  absent. That is the #2984 / #4207 surface, not this one.
- `Date` and `Function` still have no carrier. `Function`'s bare value is the
  realm-owned `%Function%` intrinsic in runtime-eval builds
  (`emitStandaloneIntrinsicFunctionValue`), so it must be handled separately —
  #4200 says the same.
- `new String(x)` indexed access: `s[0]` and `s.length` already work; `s[-1]`
  reads `""` instead of `undefined` and `s.hasOwnProperty(0)` answers false.
  Those are the String-exotic own-index-property surface (§10.4.3), not
  constructor identity — filed as an observation here, unfixed.

## Permanent repro

Pinned by `tests/es5-standalone-ctor-identity.test.ts` (13 cases: bare-identifier
carriers, wrapper `.constructor` via `__extern_get`, gc-lane zero-`__wrap_ctor_`
pin, demand gate). Measured +28 flips across
`test262/test/built-ins/{Object,Number,String,Boolean}/` (per-file list above).
