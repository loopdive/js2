---
name: project_native_helper_funcidx_after_deps
description: "Hand-built native Wasm helpers must claim their funcIdx AFTER emitting any dependency functions, else the slot shifts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

When emitting a hand-built native Wasm helper (raw `Instr[]` pushed to
`ctx.mod.functions`, e.g. `__uri_encode` in `src/codegen/uri-encoding-native.ts`,
`emitNativeParseNumber`, the case-convert helpers), compute the helper's
`funcIdx = ctx.numImportFuncs + ctx.mod.functions.length` and
`ctx.funcMap.set(name, funcIdx)` **only right before the `mod.functions.push`** —
NOT early.

**Why:** if the helper calls `emitWasiErrorConstructor(ctx, "URIError", 1)` (or
any emitter that appends a function, e.g. `ensureNativeStringHelpers`,
`__new_*`) AFTER you captured `funcIdx`, that dependency function lands at your
captured index and your helper actually ends up one slot later. The stale-low
`funcMap` entry then makes the call site emit `call <wrong-fn>`, surfacing as a
Wasm validation error like `call[0] expected type externref, found i32.const`
(the call targets a different-arity function). Concretely in #2400: registered
`__uri_encode` funcIdx early → `emitWasiErrorConstructor` appended
`__new_URIError` at that index → call site dispatched to `__new_URIError`
(1 externref param) instead of `__uri_encode` (externref,i32).

**Fix pattern:** register ALL dependency funcs first (URIError ctor, string
helpers, the func type via `addFuncType`, the exn tag), build the body, THEN
claim the slot immediately before push. See [[project_type_index_shift_and_deadelim]]
and [[project_addunionimports_late_shift_hazard]] for the related type/import
index hazards.
