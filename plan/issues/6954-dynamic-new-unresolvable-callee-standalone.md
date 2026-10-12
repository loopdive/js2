---
id: 6954
title: "standalone: `new <callee>(…)` whose callee is a local alias or member slot holding a user closure the compiler cannot resolve statically (nested function decl exported via `NS.g = g`, or the RESULT of `Class.create()`) never attempts [[Construct]] on the runtime closure — returns null or throws `is not a constructor` (Octane box2d init `new F` in `b2Mat22.FromVV`; raytrace `new Flog.RayTracer.Material.BaseMaterial()`)"
status: in-progress
assignee: ttraenkler/claude-session-d
sprint: current
created: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, dynamic-dispatch
goal: standalone-gap
related: [874, 6943, 6941, 1472, 3981, 2872, 5197, 6612, 6951]
loc-budget-allow:
  # 2026-10-11 (#6954) — new-super.ts +149: the standalone dynamic-`new`
  #   chains gain a user-closure [[Construct]] arm (prepare/emit helper pair,
  #   called from the class-free chain and from `emitDynamicNewFallback`'s
  #   no-match base), and Pattern 2 / the terminal refusal route a member slot
  #   typed as an ordinary user `function` to the native construct driver. The
  #   brief for this issue pinned the change to this file; both chains it
  #   extends live here, and the helpers read their locals.
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-10-11 (#6954) — the arms themselves are helpers; what remains inline
  #   is the call into them: compileNewExpression +13 (the Pattern-2 flag and
  #   native route, the terminal route, the class-free chain's tail call),
  #   emitDynamicNewFallback +7 (registering the arm on the live body before the
  #   no-match base is built detached, and the one-line base call).
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
---

# Dynamic `new` on an unresolvable user-closure callee has no [[Construct]] arm in standalone

Found by the Octane standalone triage (Session D, 2026-10-10, `c-octane-integ`). It is the FIRST runtime failure
of `box2d` (module init: `opaque wasm exception`) and the first runtime failure of `raytrace` once the #1472
compile error is out of the way (`.tmp/patch-rt-extend.mjs`; function trace `.tmp/trace-rt.log` ends in
`Class.create` @ raytrace.js:426 → `__extern_get` → TypeError).

Traces (`wasm-opt --log-execution`, `JS2WASM_CLOSURE_NAME_MAP=1`):
- box2d: last user closure `F.FromVV` (box2d.js:553, `FromVV=function(p,B){var Q=new F;Q.SetVV(p,B);return Q}` with
  `F=Box2D.Common.Math.b2Mat22` an IIFE-local alias; `b2Mat22` is `function g(){g.b2Mat22.apply(this,arguments);…}`
  nested in an earlier IIFE and exported by `Box2D.Common.Math.b2Mat22=g`) → `__construct_runtime_eval` →
  `__builtin_collection_dyn_construct` → `__new_TypeError`.
- raytrace: `Flog.RayTracer.Material.Solid.prototype = Object.extend(new Flog.RayTracer.Material.BaseMaterial(), {…})`
  (:357) where every `Flog.RayTracer.X = Class.create()` (:77,195,216,280,298,…) returns `function(){ this.initialize.apply(this, arguments); }`.

## Minimized (node left; standalone right)

| file | shape | standalone |
| --- | --- | --- |
| `.tmp/b3.js` / `.tmp/b5.js` | `(function(){ function g(){this.v=7;} NS.g=g; })(); (function(){ var F = NS.g; var Q = new F(); out = Q.v; })();` | init throws (opaque) |
| `.tmp/b4.js` | same but `g` is a TOP-LEVEL declaration | `7` ✓ |
| `.tmp/b6.js` | nested `g`, constructed directly `new NS.g()` (no alias) | `7` ✓ (#6943 member-callee admission) |
| `.tmp/rt6.js` | `function create(){ return function(x){this.x=x;}; } NS.C = create(); new NS.C(3).x` | `Cannot access property on null` (construct returned null) |
| `.tmp/rt7.js` | same but `var P = create(); new P(3).x` | `3` ✓ |
| `.tmp/rt5.js` | `Flog.RayTracer.Color = Class.create(); Flog.RayTracer.Color.prototype = {…}; new Flog.RayTracer.Color(2)` | `TypeError: is not a constructor` |
| `.tmp/rt2b.js` | `var P = Class.create(); P.prototype = {init…}; new P().x` | `called value is not a function` |

Controls that pass today: `.tmp/rt3c.js`/`.tmp/rt3d.js`/`.tmp/rt2c.js`/`.tmp/rt4.js` (statically resolvable fnctors, with
and without whole-prototype replacement), `.tmp/b1.js` (`var Vector = Array; new Vector()`).

## Root cause

`compileNewExpression` (`src/codegen/expressions/new-super.ts`) admits a dynamic callee to the native closure
construct driver (`__native_construct_<N>`, `native-construct.ts:188`, IsConstructor guard + `[[Construct]]` on
ordinary closures, lines 690-800) only when `isMemberHeldUserFunctionNewCallee` (:859) resolves it STATICALLY to a
member-held user function — `resolvesToMemberHeldUserFunction` needs a visible `NS.x = function…`/identifier-of-fn
write; it fails for a nested declaration exported inside an IIFE (b5) and for a call result (rt5/rt6/rt2b). Those
callees fall to `emitDynamicNewFallback` (:4463) whose standalone no-match base (:5110-5125) only tries the
compiled-class tags, `emitBuiltinFnNotAConstructorGuard`, TypedArray, builtin-ctor-value, collection, Array and
Promise arms — there is no "ordinary user closure" arm, so the result is `ref.null.extern` (rt6) or, when the closure
carries a `$fnmeta` slot that the builtin-fn guard misreads, `TypeError: is not a constructor` (rt5). The
`useRuntimeArgv` base (:5127-5137) throws unconditionally.

## Implementation Plan (standalone; host lane untouched)

1. **`new-super.ts` `emitDynamicNewFallback`, standalone non-argv `noMatchBase` (:5110)**: before
   `emitBuiltinFnNotAConstructorGuard`, add a user-closure arm: `descLocal` (anyref) → `extern.convert_any` → the
   `__native_construct_<args.length>` driver (reuse the arming sequence at :4040-4070: `ensureLateImport __extern_get/
   __object_create`, `addStringConstantGlobal("prototype")`, `markClassValueConstructSite`,
   `armConstructIsConstructorGuard`, `reserveNativeConstructDriver(ctx, n, protoKey)`); if the driver answers
   non-null, that is the result; else continue into the existing builtin arms. For `n > MAX_NATIVE_CONSTRUCT_ARITY`
   use `emitNativeConstructRuntimeArgv` (:4346). The driver already performs §13.3.5.1 IsConstructor
   (`constructIsConstructorGuard`) so arrows/methods throw the right TypeError.
2. **`useRuntimeArgv` base (:5127)**: same arm via the argv driver before the unconditional throw.
3. **Ordering**: the builtin-fn guard (`__builtinfn_is_builtin`, #5197) must run AFTER the user-closure arm, or
   gate it on "not an ordinary `$fn_wrap*` closure" — rt5's `is not a constructor` shows a user closure reaching
   it (the `$fnmeta` subtype shares the builtin metadata family; verify with `ref.test` on
   `ctx.constructibleClosureTypeIdxs`).
4. **Follow-up inside the same issue**: `.tmp/rt2b.js` (identifier callee holding a call result + prototype
   replacement) — after step 1 verify `P.prototype = {…}` is honoured by the driver (`callee.prototype` via
   `__extern_get` on the closure bag, native-construct.ts:734-742); if it still reads the OLD proto, the write arm
   for `<closure>.prototype = objLiteral` on a non-fnctor closure value is the remaining gap (cite #6945).

### Edge cases
- Callee is a class singleton: class-tag arms run first (unchanged).
- Non-callable value: driver returns null → fall through → existing outcome.
- `new F` without parens (box2d): `args.length === 0`, same arm.
- Byte-neutrality: arms are emitted only when `noJsHost(ctx)`; gc output unchanged.

### Acceptance
- `tests/issue-<id>.test.ts` standalone vs node: b3/b5 → `7`, b2 → `3`, rt5 → `24`, rt6 → `3`, rt2b → `3`; controls
  b4/b6/rt4/rt7 unchanged; `new (() => 1)()` still throws TypeError; `new Vector()` (`b1`) unchanged.
- box2d: `node --import tsx .tmp/octane-sa.mjs box2d --script --no-eval` gets past module init (NEXT failure unknown;
  compile is ~165 s on this branch — see `.tmp/plan-6941.md`).
- raytrace: with the #1472 compile fix, `octane_run(1)` proceeds past `Material.Solid` init (next failure unknown; the
  `Class.create` → `this.initialize.apply(this, arguments)` ctor body is the next candidate — rt2 shape).
- Size: **M** (one arm in two bases + guard ordering; ~60 lines).

## Ownership / overlap
`new-super.ts` dynamic-new region (`emitDynamicNewFallback`). #6943 (member-callee admission, same file, lines
859-871 / 4030-4150) is already merged on this branch; #6949 touches `fnctor-prototype.ts`, #6950 `declarations.ts` — no
line overlap, but merge `origin/main` before starting.

## Implementation notes (2026-10-11, senior-dev)

Measured paths (temporary return-line instrumentation of `compileNewExpression`, then removed) — the plan's
single-arm picture was incomplete; the repros reach THREE different places:

| repro | callee | where it went on base | outcome |
| --- | --- | --- | --- |
| b3/b5 (box2d) | `any`-typed var alias | class-free module: the `#2872` chain after `emitDynamicNewFallback` declines (no class candidates); class-bearing module: `emitDynamicNewFallback`'s standalone no-match base | every arm declines → `null` |
| rt6 | member, function type WITH a JS-inferred construct signature | falls to the terminal `Unsupported new expression` refusal | `undefined`/null |
| rt5 | member, function type with call signatures only (`Class.create()` result) | **Pattern 2** (`callSigs > 0 && constructSigs == 0`) | static `TypeError: is not a constructor` |

Changes, all in `src/codegen/expressions/new-super.ts`, all gated `noJsHost` (gc output unchanged):

1. `prepareUserClosureConstructOnNull` + `emitUserClosureConstructOnNull`: a last "on null" arm for both standalone
   chains. Gated at runtime on `__typeof_function`, it calls `__native_construct_<N>` with a null supplied
   prototype (the driver reads `callee.prototype` and runs the #6612 IsConstructor guard, so arrows/methods still
   throw TypeError). It runs AFTER the builtin arms (TA, bound, builtin-ctor-value, collection, Array, Promise),
   so an aliased `Array`/`Map` still constructs natively — plan step 3's ordering concern did not materialize:
   on base no user closure tripped the `__builtinfn_is_builtin` guard; rt5's TypeError was Pattern 2. The
   registration runs on the LIVE body (late-import flushes do not reach the detached no-match base).
   The class-free chain skips it for the `Function`-typed identifier `emitOrdinaryFunctionConstructOnNull`
   (#6651 W2a) already claims.
2. `isOrdinaryFunctionValueNewCallee`: a non-identifier callee whose call AND construct signatures are all
   declared by plain (non-generator, non-async) user `function` expressions/declarations is an ordinary function
   value. Pattern 2 now routes it to `tryCompileNativeConstructFromValue` (new `ordinaryFunctionValue` admission)
   instead of throwing, and the terminal refusal does the same. Methods/accessors/arrows/lib declarations decline.
3. Not done: plan step 2 (`useRuntimeArgv` base). That base materializes args into `$ObjVecArr`, a different
   vector than the argv driver's; a runtime-length spread on an unresolvable closure still throws TypeError.

Results (node vs standalone, `--script --no-eval`): b2 `3` ✓, b3 `7` ✓, b5 `7` ✓, rt6 `3` ✓ (all failed on base);
controls b4/b6/rt4/rt7 unchanged; arrow/method/generator values still throw TypeError; `Array`/`Map` aliases
still construct. Two pinned residuals in existing tests flipped to node's answer and were updated:
`issue-6651-sp1` "new on a closure read out of a property" (11 → 7) and `issue-6611` bound-identifier pair
(-2/-2 → 55/36).

Octane, standalone (`pnpm run -s benchmark:octane -- --only box2d,raytrace --lanes standalone --timeout 400`,
measured on a throwaway local merge of this branch into `c-octane-integ`, base = the same merge with
`c-octane-integ`'s `new-super.ts`):

| bench | base | head |
| --- | --- | --- |
| box2d | runtime-error: opaque wasm exception at module init (`new F` in `b2Mat22.FromVV`) | runtime-error: `illegal cast` in `$parseInt`, reached from a user closure via `__apply_closure` → `__call_fn_method_1` (past module-init construction; next blocker, not a `new` site) |
| raytrace | compile-error (#1472) | compile-error (#1472), unchanged; with `.tmp/patch-rt-extend.mjs` base and head fail identically at `Flog.RayTracer.Color = …` (`__set_member_nonstrict_Color` → TypeError), before any `new` |

## Remaining

- **rt5 / rt2b (raytrace) — out of this file's scope.** After step 2 they construct, but the instance's
  `[[Prototype]]` is `Object.prototype`, not the replaced `P.prototype = { … }`. Root cause (probe
  `p6.js`/`p7.js`): the driver's `__object_create(proto)` drops a proto that is a CLOSED object-literal struct;
  the same write with an open `$Object` (`Object.create(Object.prototype)` + expandos) works (`p7` = node). The
  fnctor path avoids this because `F.prototype = {…}` is stored canonicalized into the per-fnctor global. Fix
  lives in `src/codegen/native-construct.ts` (canonicalize the proto before `__object_create`) or the object
  runtime's `__object_create`, or in the `<closure>.prototype = objLiteral` write — overlaps #6951 G2.
- `b1.js` (`var Vector = Array; new Vector()`) fails on base AND head on `origin/main` ("dereferencing a null
  pointer"); the plan listed it as passing on `c-octane-integ`. Not touched here.
- Runtime-argv base (step 3 above).
