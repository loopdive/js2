---
name: reference_2042_s4_callsite_vs_2515_redefine_throw
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2042 "ValidateAndApplyPropertyDescriptor" splits across TWO disjoint code paths
in standalone — easy to conflate:

- **Native `$Object` runtime** (`object-runtime.ts` `__defineProperty_value`): the
  path for a DYNAMIC receiver (`function mk(): any { return {}; }`). sdev-reflect's
  #2042 S4 (PR #20) added the §10.1.6.3 preflight + catchable TypeError here.
- **Typed-struct call-site** (`object-ops.ts` `compileObjectDefineProperty`, the
  `needsValueCompare` branch ~L1684): the path an EMPTY `const o: any = {}` literal
  takes (lowers to an open typed struct → struct.set, NOT the native). This is task
  #21 (#2042 S4 call-site, sdev-validate PR #1858).

The call-site `needsValueCompare` branch had its own redefine-throw bug, triggered
by **two value-defines on the SAME key in one function** under nativeStrings:
`const o:any={}; defineProperty(o,"x",{value:5}); defineProperty(o,"x",{value:6})`.
It emitted `global.get <ctx.stringGlobalMap.get(msg)>` → `-1` sentinel under
nativeStrings → `global index out of range — -1` (#2043 class), AND threw a bare
string (so `assert.throws(TypeError,…)` never matched).

**#2515 S0 (already merged) took the emit-error HALF** — it replaced `global.get -1`
with `stringConstantExternrefInstrs` (sentinel-safe inline `$NativeString`). But it
STILL threw a bare string. So the remaining #2042-S4-callsite contribution is just
the bare-string→TypeError-instance wrapping: route through `emitThrowTypeError`
(body-swap pattern, mirrors `buildTemporalThrowInstrs`) — it keeps #2515's
sentinel-safety AND wraps in `__new_TypeError` for a real catchable instance.

Out of scope (deliberately): `getOwnPropertyDescriptor` readback returns `undefined`
for a RUNTIME-stored key on an empty `const o:any={}` literal (even a plain `o.x=5`
assign) — that's the #2187 dot-vs-bracket dual-storage / value-rep substrate
([[project_toprimitive_nominal_struct_gap]] neighbour), owned by sdev-strdispatch.
CompletePropertyDescriptor attribute-default false-encoding was ALREADY correct in
`computeRuntimeFlags` (object-ops.ts) — omitted attr → value bit 0 → false.
