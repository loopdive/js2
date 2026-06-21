---
name: project_brand_check_swap_savedbodies
description: Body-swap to capture a throw/else branch MUST use pushBody/popBody so a late string-constant import shift reaches the already-emitted receiver global.get
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

When codegen compiles a receiver expression (emitting e.g. `global.get $self`
for a closed-over module global), then swaps `fctx.body` out to a fresh buffer
to capture a failure/throw branch, and that branch calls `emitThrowTypeError`
(or anything that adds a LATE string-constant import), the swap MUST register
the saved buffer via the canonical `pushBody(fctx)` / `popBody(fctx, saved)`
helpers (`src/codegen/context/bodies.ts`) — NOT a raw
`savedBody = fctx.body; fctx.body = []`.

**Why:** the late import runs `fixupModuleGlobalIndices`
(`src/codegen/registry/imports.ts`), which bumps every module-global index and
rewrites `global.get/set` indices only in REGISTERED bodies (it walks
`fctx.savedBodies`, `ctx.currentFunc.body`, `ctx.liveBodies`, …). A raw swap
reassigns `ctx.currentFunc.body` to the empty buffer (since
`fctx === ctx.currentFunc`), so the fixup walks the empty array and the
detached real body — holding the receiver's `global.get` — is skipped. That
`global.get` keeps its pre-shift index and reads the neighbouring (often f64)
global → invalid Wasm: `any.convert_extern[0] expected externref, found
global.get of type f64`.

**How to apply:** any `fctx.body` swap whose captured branch can emit a string
literal / throw / coercion that flushes imports → use pushBody/popBody. This was
the root cause of #2563 (private-field brand-check read on a closed-over module
global; the field-read path AND the getter/method-read path in
`property-access.ts` both hand-rolled the swap and missed registration). Same
discipline already used correctly at property-access.ts ~L1530 / ~L4743. Links:
[[project_type_index_shift_and_deadelim]], [[project_native_helper_funcidx_after_deps]].
