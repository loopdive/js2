---
name: project-addunionimports-late-shift-hazard
description: Standalone codegen helpers that bake cross-function call indices can desync under addUnionImports late shift — emit inline into fctx.body instead
metadata: 
  node_type: memory
  type: project
  originSessionId: d18f1f78-abd6-42a5-9401-6f2dda1f555b
---

When adding a standalone (native-strings / `--target standalone`) codegen
feature that needs to call another lazily-emitted helper (`number_toString`,
`__str_concat`, a nested helper), **emit the lowering INLINE into `fctx.body`**
(the current function body) rather than into a separate cached helper function
whose body bakes the callee's `funcIdx`.

**Why:** `addUnionImports`/late-import registration shifts every function index
by `delta` and `shiftFuncIndices` walks `ctx.mod.functions` + `fctx.body` to bump
baked `call` indices. But a helper whose body is **built but not yet pushed**
to `ctx.mod.functions` when a shift fires (e.g. a `nativeStringLiteralInstrs` or
`emitNativeNumberFormat` call mid-construction triggers `addStringImports`) is
NOT walked → its baked `call funcIdx` goes stale → the module fails validation
("call expected (ref null 5), found anyref", or a stack-balancer-inserted
`i32.trunc_sat_f64_s` + stray value → "not enough arguments on the stack").

This caused #1448 (#2007): a `patchAnyToStringVecArm` + cached `__vec_join_*`
helper approach regressed standalone test262 by **net −7755 (wasm_compile
+7755)** in CI. The proven-safe pattern is `compileArrayJoinNative` in
`array-methods.ts` — it emits the join loop inline into `fctx.body`.

**Pre-existing sibling hazard:** even inline, having a closure-allocating array
method (`map`/`filter`/…) lowered earlier in the same function corrupts a later
native array-join (`a.join(",")` fails this on baseline too). The #2007 fix
guards with a new `FunctionContext.emittedClosureArrayMethod` flag (set in
`compileArrayMethodCall`) and bails the vec-concat join to `$__any_to_string`
("[object Object]", baseline) when it's set. See [[project-dev-session-infra-gotchas]].
