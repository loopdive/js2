---
name: reference_2583_any_strict_eq_tag5_host_only
description: "#2583 — standalone __any_strict_eq/__any_eq tag-5 string compare was host-only (wasm:js-string equals) → const 0; native __str_flatten+__str_equals fallback. Plus any.indexOf routing intercept by guarded-string else-arm."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2583 standalone any-array `indexOf`/`lastIndexOf`/`includes` had TWO root
causes (WAT-confirmed; the spec's assumed `__extern_method_call` path was dead):

1. **Routing intercept.** For an `any` receiver + a STRING_METHODS name,
   `compileMethodCall` (calls.ts ~L8926) fires `compileGuardedNativeStringMethodCall`
   (string-ops.ts) FIRST — a runtime `ref.test $AnyString` guard whose non-string
   **else**-arm returned a benign `0`/`NaN`. The array case never reached the
   closed-method dispatcher `__call_m_<m>_<arity>`. Fix: route that else-arm to the
   dispatcher for the 3 methods (arity≥1, standalone/wasi) and unbox the boxed
   result back to the string-arm's result kind.

2. **Substrate bug (broader than #2583).** `__any_strict_eq` AND `__any_eq`'s
   **tag-5 (string)** content-compare arm used the HOST `wasm:js-string equals`
   import (`strEqualsIdx = ctx.jsStringImports.get("equals")`). Standalone/wasi
   has NO host string import → `strEqualsIdx === -1` → arm collapsed to
   `i32.const 0`. So two EQUAL boxed strings compared UNEQUAL whenever `===`/`==`
   routed through `__any_strict_eq`/`__any_eq` (boxed-string operands: array
   elements via `__extern_strict_eq`, object property values, etc.). Bare-identifier
   `a === b` worked because it uses the *static* `===` lowering with native
   `__str_equals` — a different path. Fix: `tag5StringEqThen()` in any-helpers.ts
   prefers the host import (gc/host unchanged) else falls back to native: recover
   each operand's tag-5 `externval` (fieldIdx 4) via `extern.convert_any` +
   `ref.cast $AnyString`, `__str_flatten` → `$NativeString`, then native
   `__str_equals`. Shared by both helpers.

The `$__vec_base` brand arm itself (closed-method-dispatch.ts `fillClosedMethodDispatch`,
deps reserved at reserve time #1719) uses `__extern_strict_eq` (indexOf/lastIndexOf)
vs `__extern_same_value_zero` (includes) → correct NaN: indexOf(NaN)=-1,
includes(NaN)=true.

This touches the SAME tag-5 field-4 arm as parked #2585 (proto-identity ref.eq) —
#2583 added content-eq only, no ref.eq short-circuit. See [[reference_1629b_boxed_primitive_typeof_eq_layers]].
Pre-existing unrelated wasi loose-eq failure: `tests/issue-2081.test.ts`
`__defineProperty_value` late-import shift (#2043 class) — fails identically on
clean main, not a #2583 regression. PR #1883.
