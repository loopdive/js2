---
id: 6969
title: "standalone: native `parseInt` / `parseFloat` `ref.cast $AnyString` the externref argument without ToString — a boxed number / i31 argument (externref param, `arr[i]`, member-held closure) traps `illegal cast` (Octane box2d `parseInt(e.m_vertexCount)`, `parseInt(-1)` in `postDefs`)"
status: ready
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
