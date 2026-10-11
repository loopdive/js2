---
id: 6969
title: "standalone: native `parseInt` / `parseFloat` `ref.cast $AnyString` the externref argument without ToString — a boxed number / i31 argument (externref param, `arr[i]`, member-held closure) traps `illegal cast` (Octane box2d `parseInt(e.m_vertexCount)`, `parseInt(-1)` in `postDefs`)"
status: done
completed: 2026-10-11
assignee: ttraenkler/claude-session-d
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: parseInt, coercion
goal: standalone-gap
related: [874, 1663, 6954, 4492]
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/parse-number-native.ts::emitNativeParseNumber
---

# `parseInt(<externref holding a number>)` traps instead of ToString-ing

Found by the Octane standalone triage (Session D, 2026-10-11). box2d (compile ≈200 s) fails at
module init with `RuntimeError: illegal cast` inside `$parseInt`. Octane box2d calls `parseInt`
~40 times, ALWAYS on numbers (`F.parseUInt=function(y){return Math.abs(parseInt(y))}`,
`parseInt(e.m_vertexCount)`, `parseInt(-1)` inside `Box2D.postDefs.push(function(){…})`, …).

## Minimized (`.tmp/bx8.js`, node `-7:3`; standalone `RuntimeError: illegal cast`)

```js
var F = {};
F.parseUInt = function (y) { return parseInt(y); };
export function main() { return F.parseUInt(-7) + ":" + F.parseUInt(3); }
```

Also `.tmp/bx7.js` (`function g(y){return parseInt(y)}` fed from a mixed array `[5,"6",7.5]`) and
`.tmp/bx4.js` (`g(5)`, `g("12")`, `g(-1)`, `parseInt(o.n)`). Controls: `.tmp/bx5.js` (param
inferred f64 — the call site converts) and `.tmp/bx6.js` (string param) pass.

## Root cause

`src/codegen/parse-number-native.ts` — both natives take `externref` and immediately do
`any.convert_extern` + `ref.cast $AnyString` + `__str_flatten`:
- `emitParseInt` prologue (~657-663);
- `externToFlat` (~133-143), the parseFloat prologue.

ECMA-262 §19.2.5 step 1 is `Let inputString be ? ToString(string)`; the native assumes the call
site already passed a string. Every call site that holds the argument as an externref (a
non-f64 parameter, an `any` element read, a member-held closure's parameter) passes a boxed
number (`ref.i31` or `$BoxedNumber`), `undefined`, `null`, or an object — all trap. #6954
("ordinary user function value" construct) only moved WHERE the closure runs; the cast was
always unguarded.

## Implementation Plan

**File: `src/codegen/parse-number-native.ts`**

1. In `emitNativeParseNumber`, after `ensureNativeStringHelpers(ctx)`, call
   `ensureAnyToStringHelper(ctx)` (`src/codegen/native-strings.ts:386`, `__any_to_string:
   (anyref) -> (ref $AnyString)` — the sanctioned ToString spelling, `ANY_TO_STRING_HELPER`). It is
   a DEFINED function appended at the end of the func space (no index shift); both natives are
   minted afterwards.
2. Replace the unguarded cast in both prologues (`externToFlat` and the `emitParseInt` body) with:
   ```wasm
   local.get 0  any.convert_extern  local.tee $any
   ref.test (ref $AnyString)
   if (result (ref $AnyString)) local.get $any ref.cast (ref $AnyString)
   else local.get $any call $__any_to_string end
   call $__str_flatten
   ```
   (add an `anyref` scratch local to both natives' `locals` lists; `__any_to_string` must handle
   a null anyref → "undefined"/"null" per its contract — verify at native-strings.ts:386-525;
   if it does not, emit the `ref.is_null` → `"undefined"` literal branch before the call, so
   `parseInt(undefined)` → NaN, `parseInt(null)` → NaN).
3. Keep the signature `(externref, f64) -> f64`; no call-site change (host lane unaffected — the
   import does ToString in JS).

### Edge cases
- `parseInt(1e21)` → ToString gives "1e+21" → 1 (spec-correct, matches node).
- `parseInt(-0.5)` → "-0.5" → -0; `parseInt(7.5)` → 7. `parseFloat(" 3.5x")` unchanged.
- Symbol argument: `__any_to_string` should throw TypeError (spec) — accept whatever it does today.
- Performance: the `ref.test` is one instruction on the string fast path.

### Acceptance
- `tests/issue-<id>.test.ts` standalone vs node: `.tmp/bx8.js` → `-7:3`; `.tmp/bx7.js` →
  `5:6:7`; `.tmp/bx4.js` → `5:12:-1:7:8`; `.tmp/bx1.js` → `7:-1:3`; plus `parseFloat` through an
  externref param (`g(2.5)` → 2.5) and `parseInt(undefined)` → NaN.
- box2d: `node --import tsx .tmp/octane-sa.mjs box2d --script --no-eval` (compile ≈200 s) must
  get past init. Simulated (`--patch .tmp/patch-box2d-parseint.mjs`, `parseInt(` → `Math.trunc(`):
  init passes and the NEXT failure is `TypeError: Cannot read properties of undefined (reading
  'SetV')` during `octane_run`. `.tmp/box2d-trace.log` (wasm-opt `--log-execution`, last 60
  functions) shows only runtime helpers before the throw: repeated `__closure_prop_get` /
  `__closure_bag_lookup` / `__fnctor_proto_start` (a dynamic `inst.m()` chain), then
  `__extern_get → __obj_find → __object_terminal_allows_implicit_proto → __protoidx_get_k →
  __nullish_to_null → __new_TypeError` — i.e. a property read on an `$Object` that walked the
  prototype index and came back undefined, and the receiver of `.SetV` is that result. box2d's
  `.SetV(` receivers are `this.m_vertices[u]`, `this.m_normals[u]`, `b2Vec2` fields (`t.v`,
  `m_localPlaneNormal`) — candidates: a `Vector`-typed (`var Vector = Array`) element read, or a
  `b2Vec2` field on a fnctor instance reached through `__super`/`prototype` chaining
  (`A.prototype.b2PolygonShape = function(){ this.__super.b2Shape.call(this); … }`). Next step:
  `--patch` box2d to wrap the ~30 `.SetV(` call sites with a receiver check that throws the call
  text (regex `(\w[\w.\[\]]*)\.SetV\(` → `(chk($1, "$1")).SetV(`), rerun once (≈200 s compile).
- Then `pnpm run -s benchmark:octane -- --only box2d --lanes node,standalone --timeout 600`
  (needs `--timeout ≥ 300` for the compile).
- Size: **S**.

## Implementation notes (2026-10-11)

**Deviation from plan step 1 — the ToString arm is filled at finalize, not at emission.**
Calling `ensureAnyToStringHelper` inside `emitNativeParseNumber` is unsafe: the parse natives are
minted at IMPORT COLLECTION (measured: at that moment `__any_to_string`, `objectRuntimeTypes`,
`__to_primitive` and `__extern_toString` do not exist yet), and `__any_to_string` is cached
module-wide, so building it there would bake it WITHOUT its object / ToPrimitive / class arms for
the whole module — the first-consumer ordering hazard #3216 / #2875 fixed. So the change uses the
reserve-then-fill pattern (approved scope extension: one hook in `src/codegen/index.ts`):

- `parse-number-native.ts` `externToFlat` (now shared by `parseFloat` and `parseInt`):
  `local.get 0; any.convert_extern; local.tee $arg; ref.test $AnyString; if (result ref $AnyString)
  local.get $arg; ref.cast | else <arm> end; call __str_flatten`. The arm starts as `unreachable`
  (the old trap) and is recorded per-ctx; each native gets an `anyref` scratch local.
- `fillParseNumberToStringArms(ctx)` (called next to `fillSymbolAnyToStringArm` in both finalize
  paths) splices `extern.convert_any; call __extern_toString; any.convert_extern; ref.cast` when the
  object runtime exists (ToString ∘ ToPrimitive — `parseInt([5])` = 5, `parseInt({toString(){…}})`),
  else, on standalone/WASI, `call __any_to_string` built then, when every dependency it captures
  exists. Placed before the symbol/callable `__any_to_string` arm fills so a freshly built helper
  still receives them. A host-backed native-first lane without a native ToString keeps the trap.
- `__str_to_number` is untouched (it is only ever handed strings).

**Byte-identity:** modules that never mint the parse natives are byte-identical (8 playground
`.ts` examples, standalone + gc, hashed base vs head). Standalone JS *scripts* always mint them
(the realm's global `parseInt`/`parseFloat`), so those grow by ~54 bytes (the guard).

**The #3518 donor receipt now carries the #6969 delta.** `tests/issue-3518-native-string-number-resources.test.ts`
pins `parse-number-native.ts` to a historical donor. It now strips exactly the 11 hunks in
`tests/fixtures/issue-6969-parse-number-tostring-delta.json` (exact `[live, donor]` text pairs —
any other adapter edit still fails), admits only the four new imports (`ANY_TO_STRING_HELPER`, `EXTERN_TO_STRING_HELPER`,
`ensureAnyToStringHelper`, `definedFuncAt`; the mocks throw if emission reaches them), and
projects the recorded parseFloat/parseInt back by undoing exactly the 6-instruction guard and
the appended `arg` local. Two new mutation rows prove the delta is exact.

**Alternatives rejected:** a call-site ToString in `call-identifier.ts` covers the legacy
`parseInt(<any>)` call (bx8) but not the IR-lowered direct call (`function g(y){return
parseInt(y)}` with an inferred-f64 `y` boxes straight into the native — bx7/pi3 still trap) nor
the first-class `parseInt` value / `arr.map(parseInt)` wrappers; fixing the callee covers all.

**Validation:** `tests/issue-6969-parse-number-tostring.test.ts` 36 cases (module + Octane
options): base 4/36 (the string controls), head 36/36. Repros `bx1/bx4/bx7/bx8` node-identical.

## Review fix (2026-10-11): a Symbol argument must throw a TypeError

Review P1 on PR #6649: `F.pi = function (y, r) { return parseInt(y, r) }; F.pi(Symbol("5"))`
returned normally (0 from the `try`) where node throws a TypeError (1); `parseFloat` alike. Step 1
of §19.2.4 / §19.2.5 is ABSTRACT ToString (§7.1.17), which throws for a Symbol. The fill used
`__extern_toString`, which renders `Symbol(5)` because it also backs `String(sym)` (§22.1.1.1
step 1.a, SymbolDescriptiveString) — the wrong contract here.

**Fix:** the fill now calls the existing throwing provider `__extern_to_string_spec`
(`ensureSpecExternrefToStringProvider`, coercion-engine.ts, #6651 B6 — the RegExp `@@` protocol's
ToString). It throws for a Symbol input, a Symbol wrapper (`Object(sym)`), and a Symbol produced by
ToPrimitive, and otherwise delegates to `__extern_toString` (ToPrimitive runs once, so an object's
own conversion exception still propagates unchanged). Outside standalone/WASI or in a module with no
`$Symbol` carrier it returns `__extern_toString` itself, so those modules are unchanged. Its `fctx`
parameter is widened to `FunctionContext | null`: the finalize fill has no body to flush, and the
standalone lanes it builds for carry no imports to shift.

The `__any_to_string` arm (no object runtime) is not changed: every Symbol-carrying shape probed
(member-held, plain helper, `any`-typed and `.ts` callers) builds the object runtime and takes the
`__extern_toString` arm.

**Not fixed here (pre-existing, outside this PR):** a DIRECT `parseInt(sym)` on a Symbol-typed
binding is stringified at the call site (`call-identifier.ts` scalar-arg `emitToString`), not in the
native; and `parseInt(x, radix)` converts `radix` at the call site before the native's ToString,
so `parseInt(Symbol(), { valueOf() {…} })` runs `valueOf` first (node does not).
