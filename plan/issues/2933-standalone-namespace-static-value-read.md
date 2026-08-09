---
id: 2933
title: "Standalone: Math/JSON/Reflect/Atomics namespace static VALUE reads refuse — fold constants / native static-method closures"
status: done
completed: 2026-07-24
created: 2026-07-02
updated: 2026-07-24
priority: medium
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: 76
horizon: m
related: [2860, 2861, 1907, 1888]
umbrella: 2860
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/context/types.ts
coercion-sites-allow:
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/call-identifier.ts
---

# Standalone: namespace static VALUE reads refuse

## Problem

Split-out follow-up from #2861 (which the Implementation Plan explicitly deferred
here). In `--target standalone`, reading a **namespace** builtin's static member
as a first-class VALUE (not calling it) refuses with the `#1907`/`#1888 S6-b`
"built-in static property value read is not supported" compile error:

```
Codegen error: JSON.stringify built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

`Math`, `JSON`, `Reflect`, `Atomics` are **namespaces**, not constructors — the
read is `Math.LN2` (a static data prop) or `JSON.stringify` (a static method as a
value), NOT `Math.prototype.x`. They do NOT go through the `$NativeProto`
proto-glue that #2861 wired for the real ctors, and their `.length`/`.name` are
`undefined` (so #2861's `BUILTIN_CTOR_ARITY` fold deliberately excludes them).

## Scope (measured against current main, 2026-07-02)

Already working on current main (do NOT re-do):

- Namespace static **data constants** with a statically-known name — `Math.PI`,
  `Math.E`, `Math.LN2`, `Number.MAX_SAFE_INTEGER`, `Symbol.iterator` — already
  fold to `f64.const` / `i32.const` (`hasNativeBuiltinConstantHandler` +
  downstream emitter in `property-access.ts`).
- Static-method **calls** — `Math.max(...)`, `JSON.stringify(...)`,
  `Reflect.ownKeys(...)`, `Atomics.add(...)` — compile via the call path.

Still refusing / wrong (this issue):

1. **Static-method VALUE reads** — `const f = JSON.stringify; f(o)`,
   `const g = Math.max; g(1,2)`, `Reflect.get` / `Atomics.add` as a value. These
   hit the `reportUnsupportedStandaloneBuiltinValueRead` refusal. Fix: emit a
   native static-method closure (reuse the `ensureStandaloneBuiltinStaticMethodClosure`
   factory / the #2175 `"static"` path, `property-access.ts`).
2. **Reflective `namespace[computedKey]`** — `const k = "PI"; Math[k]` currently
   reads back `0` (wrong value, not a CE); `Reflect.ownKeys(o).length` reads back
   `0`. Distinct correctness bug — route the reflective read to the folded
   constant / native method.
3. **`globalThis.Math.PI`** currently TRAPs (niche).

## Acceptance criteria

- [x] `const f: any = JSON.stringify; f({a:1})` works in standalone (returns the
      JSON string), zero host imports. — landed 2026-07-06 (opus-2933); **but
      see the 2026-07-16 note below: the object-arg case has since regressed on
      main** (pre-existing relative to the variadic slice, needs re-root-cause).
- [x] `const g: any = Math.max; g(1,2,3) === 3` in standalone. — landed
      2026-07-16, see Progress (fable-eqfix).
- [x] `Math["PI"]` (reflective, `any`-typed key) reads π, not 0. — landed
      2026-07-02, see Progress.
- [x] No host-mode regression (`ctx.standalone`-gated). — the reflective fold is
      observationally identical in host mode.

## Closed done (2026-07-24, dev-std-3) — verify-first reconcile

All acceptance criteria PASS host-free on current main (measured 2026-07-24 via
standalone compile + `imports === []` + run). The 2026-07-16 "JSON.stringify
object-arg regressed" caveat on criterion 1 is **STALE** — re-measured and it
now passes:

- `const f: any = JSON.stringify; f({a:1}) === '{"a":1}'` → pass, host-free
- `const f: any = JSON.stringify; f(5) === '5'` → pass, host-free
- `const g: any = Math.max; g(1,2,3) === 3` → pass, host-free
- `const o: any = {a:1,b:2}; Reflect.ownKeys(o).length === 2` → pass, host-free
- `const f: any = Reflect.get; f({a:7},"a") === 7` → pass, host-free
- `const k: any = "PI"; (Math as any)[k]` reads π → pass, host-free

Nothing left to implement; this was a false-`ready` (acceptance met but status
never flipped). Marked `done`. Any deeper namespace edges (`toExponential`/
`toPrecision` no-arg delegation, `globalThis.Math.PI` trap) are tracked with the
Number/namespace work (#3175/#3081), not here.

## Progress (2026-07-02, opus-12c) — reflective namespace-constant read landed

Sub-part 2 (reflective `namespace[computedKey]`) is fixed for the `Math`/`Number`
**numeric constants**. A statically-resolvable computed key on `Math`/`Number`
(`Math["PI"]`, `(Math as any)["PI"]`, `const k = "PI"; Math[k]`,
`Number["MAX_SAFE_INTEGER"]`, …) now folds to the SAME `f64.const` the syntactic
dot read (`Math.PI`) emits — via a new `tryEmitBuiltinNamespaceConstantValue`
helper (single source of truth: `MATH_CONSTANT_VALUES` / `NUMBER_CONSTANT_VALUES`)
called from an early branch in `compileElementAccess` (`src/codegen/property-access.ts`).
Standalone previously returned `0`; host mode round-tripped `__extern_get`
(same value) — the fold is host-observationally identical and the only host-free
lowering for the computed form. Non-constant keys (`Math[i]`) and non-constant
members (`Math["max"]`) fall through unchanged. Covered by `tests/issue-2933.test.ts`
(9 cases incl. regression guards).

**Remaining (this issue stays open):**

1. Static-method VALUE reads (`const f = JSON.stringify; f(o)`,
   `Reflect.ownKeys` as a value) — needs the `ensureStandaloneBuiltinStaticMethodClosure`
   value-closure wiring. `JSON.stringify` carries a native-`$AnyString`-return →
   externref coercion at the any-call boundary + a 7-arg `__json_stringify_value`
   call, so it is not a one-line switch add; scope carefully.
2. `Math.max` / `Math.min` **as a value** (`const g = Math.max; g(1,2,3)`) is
   genuinely VARIADIC — value-closures are fixed-arity, so it needs
   variadic-closure support. Recommended to split into its own follow-up.
3. `Reflect.ownKeys(o).length` reflective-read-of-result and `globalThis.Math.PI`
   (niche trap) also remain.

## Progress (2026-07-04, dev-3023) — fixed-arity `Reflect.*` value closures landed

Sub-part 1 is now landed for the **fixed-arity `Reflect.*`** methods
(`Reflect.get`, `Reflect.has`, `Reflect.set`, `Reflect.ownKeys`). Reading any of
these as a VALUE under `--target standalone` (`const f: any = Reflect.get;
f(o, "k")`) previously refused with the `#1907`/`#1888 S6-b` "built-in static
property value read is not supported" compile error; it now reifies a native
static-method closure and calls host-free.

**Mechanism** — the standalone CALL path already backs these four with a simple
externref/i32 native (`calls.ts` §"Reflect API": `__extern_get` / `__extern_has`
/ `__reflect_set` / `__object_keys`). This slice adds the matching cases to
`ensureStandaloneBuiltinStaticMethodClosure` (`src/codegen/property-access.ts`)

- `STANDALONE_STATIC_METHOD_META` (`src/codegen/builtin-fn-meta.ts`), so the
  value closure calls the SAME native → observationally identical to the call
  form. `Reflect.get`/`set` are fixed at arity 2/3 (no explicit-receiver slot),
  matching the call path which already refuses the receiver form under standalone
  (#2046). Standalone-gated only — host mode (which reads the real JS `Reflect.get`
  via `__get_builtin`/`__extern_get`) is untouched; identity is singleton-stable
  via the existing `pushBuiltinFnSingletonValueInstrs` path (#2963).

Covered by `tests/issue-2933-reflect-static-method-value.test.ts` (10 cases:
get/has/set/ownKeys value calls, identity stability, distinct-method
inequality, call-path regression guard, and JSON.stringify/Math.max
scope-boundary refusal assertions). `tsc --noEmit` + `biome` clean; existing
`#2933` / `#2963` / `#2896` suites green.

**Remaining (this issue stays open):**

1. Static-method VALUE reads (`const f = JSON.stringify; f(o)`,
   `Reflect.ownKeys` as a value) — needs the `ensureStandaloneBuiltinStaticMethodClosure`
   value-closure wiring. `JSON.stringify` carries a native-`$AnyString`-return →
   externref coercion at the any-call boundary + a 7-arg `__json_stringify_value`
   call, so it is not a one-line switch add; scope carefully.
   **(Partially addressed 2026-07-04: the fixed-arity `Reflect.get`/`has`/`set`/
   `ownKeys` value reads now work — see Progress above. `JSON.stringify` remains.)**
2. `Math.max` / `Math.min` **as a value** (`const g = Math.max; g(1,2,3)`) is
   genuinely VARIADIC — value-closures are fixed-arity, so it needs
   variadic-closure support. Recommended to split into its own follow-up.
3. `Reflect.ownKeys(o).length` reflective-read-of-result and `globalThis.Math.PI`
   (niche trap) also remain.

## Progress (2026-07-06, opus-2933) — JSON.stringify value read landed

Sub-part 1's remaining `JSON.stringify` value read now works host-free under
`--target standalone`. `const f: any = JSON.stringify; f({a:1})` previously
refused with the `#1907`/`#1888 S6-b` "built-in static property value read is not
supported" compile error; it now reifies a native static-method closure that
serialises via the existing 1-arg native `__json_stringify_root`
(`anyref -> ref $AnyString`, `json-codec-native.ts`) — the SAME entry the direct
`JSON.stringify(o)` call path uses.

**Mechanism** — added a `JSON.stringify` case to
`ensureStandaloneBuiltinStaticMethodClosure` (`src/codegen/property-access.ts`)

- `STANDALONE_STATIC_METHOD_META` (`src/codegen/builtin-fn-meta.ts`). The value
  closure is fixed 1-arg (externref value in): `local.get; any.convert_extern;
call __json_stringify_root; extern.convert_any`. It calls `emitJsonStringifyValue`
  (idempotent) to register the codec, then boxes the `$AnyString` result back to
  externref at the any-call boundary. Standalone-gated; identity is singleton-stable
  via `pushBuiltinFnSingletonValueInstrs` (#2963). Objects / numbers / strings /
  nested objects serialise correctly and reify **zero host imports** (a
  standalone-floor-visible CE-to-run flip).

**Known limitation (inherited, NOT a regression):** an array reaching the closure
through `any`-boxing serialises to `"null"` — but this is the SAME pre-existing
substrate gap the DIRECT `const x:any=[1,2,3]; JSON.stringify(x)` path already
has on main (verified). The closure is observationally identical to that direct
any-path, so it introduces no new divergence; the top-level any-boxed-array gap
belongs to the separate $Object/array dynamic-reader substrate work. Replacer /
space args remain out of scope (matching the standalone call-path narrowing).

Covered by `tests/issue-2933-json-stringify-value.test.ts` (9 cases) + the
`JSON.stringify`-refusal assertion in
`tests/issue-2933-reflect-static-method-value.test.ts` retargeted to the new
"now works" behaviour. `tsc --noEmit` + prettier clean; `#2933` / reflect suites
green.

**Remaining (this issue stays open):**

1. `Math.max` / `Math.min` **as a value** — genuinely VARIADIC (value-closures
   are fixed-arity); needs variadic-closure support. Split follow-up.
2. Top-level `any`-boxed **array** → JSON.stringify serialises `"null"`
   (substrate: $Object/array dynamic reader) — shared with the direct any-path,
   tracked separately.
3. `globalThis.Math.PI` still TRAPs (niche).

## Progress (2026-07-16, fable-eqfix) — variadic Math.max/Math.min value closures landed

Sub-part 2's remaining `Math.max`/`Math.min` **as a value** now works host-free
under `--target standalone`, at EVERY call-site arity: `const g: any =
Math.max; g(1,2,3) === 3` (the acceptance criterion), plus `g()` → `-Infinity`,
NaN propagation (`g(1, NaN, 3)` → NaN, `ToNumber(undefined)` → NaN), signed-zero
ordering (`max(+0,-0)=+0` / `min(+0,-0)=-0`), boolean ToNumber coercion, and
singleton identity (`Math.max === Math.max`, `Math.max !== Math.min`).

**Mechanism — canonical VARIADIC closure convention** (value-closures are
fixed-arity, so a per-arity family was impossible without breaking identity):

- `ensureStandaloneBuiltinStaticMethodClosure` (`builtin-value-read.ts`) reifies
  `Math.max`/`Math.min` with lifted func type
  `(self, (ref null $vec_externref)) -> externref` — ONE args-vec param instead
  of positional formals. The body folds the vec with `f64.max`/`f64.min`
  (Wasm semantics are §21.3.2.24/.25-exact: NaN propagates, signed zeros order
  correctly), seeding ±Infinity; every element runs the ENGINE ToNumber
  pipeline `__any_from_extern` → `__any_to_f64` (no hand-rolled coercion
  matrix); the result is boxed with the native `$BoxedNumber` carrier
  (`__box_number`) — the same box every dynamic-dispatch return arm uses, so
  call-site unboxing and `__any_strict_eq` (NaN ≠ NaN, #3174) recover it.
  Substrate is pre-registered via `addUnionImports` BEFORE the wrapper/func
  creation (#2704 first-registration-mid-body hazard).
- The convention is published as `ctx.variadicBuiltinClosure`; BOTH methods
  share the one lifted func type (`call_ref` dispatches via the funcref value).
- `tryEmitInlineDynamicCall` (`expressions/calls.ts`) gains an INNERMOST
  dispatch arm (just above the null default, so exact-arity candidates stay
  preferred): funcref `ref.test` against the variadic type → pack ALL saved
  arg locals (already externref, true call-site count, no padding) into a
  fresh vec → `call_ref`. The variadic closure is FILTERED out of the generic
  candidate scan (its vec formal must not be marshalled positionally — the
  generic arm would `ref.cast` arg0 to the vec type → illegal cast).
- The callable-param dispatch (`expressions/call-identifier.ts`) gains the
  matching arm for declared-signature callees.
- `STANDALONE_STATIC_METHOD_META` adds `Math.max`/`Math.min` (`length: 2` per
  spec) so `.name`/`.length`/gOPD meta stays correct.

**Byte-neutrality**: everything is gated on `ctx.variadicBuiltinClosure` being
set (only at a Math.max/min VALUE read, standalone/wasi only) —
`prove-emit-identity check` over the 56-entry (file,target) corpus is
IDENTICAL vs main. Host mode untouched (the host dynamic-call
`const g: any = Math.max; g(...)` silently returns 0 on clean main —
pre-existing, verified, separate host gap).

**Gate allowances (#3131)**: `loc-budget-allow` (calls.ts /
call-identifier.ts / context/types.ts) + `coercion-sites-allow`
(builtin-value-read.ts, call-identifier.ts). The `__any_to_f64` count growth
is engine USAGE (routing ToNumber through the #1917 keystone helpers), not a
fresh hand-rolled matrix — same reviewed-step argument as #90/#3154.

Covered by `tests/issue-2933-variadic-math-value.test.ts` (7 tests: all
arities, NaN/undefined, signed zero, booleans, identity, direct-call + fixed-
arity value-read regression guards). `#2933`/Reflect/base suites green.

**Remaining (this issue stays open):**

1. **REGRESSION (found 2026-07-16, pre-existing on clean main):**
   `tests/issue-2933-json-stringify-value.test.ts` — 3 of 9 tests now FAIL on
   main: `const f: any = JSON.stringify; f({a:1})` serialises `"null"` (4
   chars) instead of `{"a":1}`; numbers/strings still work. The 2026-07-06
   slice was green when it landed, so a later substrate change regressed the
   OBJECT-arg path (the known limitation note only covered any-boxed ARRAYS).
   Not caught by CI because issue tests are not in required CI (#3008).
   Needs re-root-cause.
2. Top-level `any`-boxed **array** → JSON.stringify serialises `"null"`
   (substrate: $Object/array dynamic reader) — shared with the direct
   any-path, tracked separately.
3. `globalThis.Math.PI` still TRAPs (niche).

## Notes

Umbrella #2860. Follows #2861 (ctor/prototype value reads + `<Ctor>.length`/
`.name`, done). ~120 of the original 882-test `#2861` cluster live here.
