---
name: project-dstr-outer-body-shift-orphan
description: "destructureParamObject's struct-fast-path detaches the OUTER fn body via a plain JS-local swap (not pushBody) — a late-import shift orphans it; track it in ctx.liveBodies"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

A distinct late-import funcIdx-shift orphan source (sibling of
[[project-addunionimports-late-shift-hazard]]): a codegen site that swaps
`fctx.body` to a then/else branch buffer with a **plain JS-local swap**
(`const savedBody = fctx.body; fctx.body = branchBuf; … fctx.body = savedBody`)
leaves the **OUTER body orphaned** during the recursive descent — it is NOT on
`fctx.savedBodies`, NOT in `ctx.liveBodies`, and not the active `fctx.body`. If a
late import is added deep inside that recursion, `shiftLateImportIndices` (and
`addUnionImports`' walker) never reach the orphaned outer body, so any `call` /
`ref.func` already emitted into it keeps a stale-low funcIdx.

**Concrete case (#2158 fix, 2026-06-18):** `destructureParamObject`'s externref
struct-fast-path (`src/codegen/destructuring-params.ts`) does exactly this for
its `ref.test ? then : else` branches. The then/else buffers are tracked in
`liveBodies` (#779d) but the outer body was not. For
`function f({ x: [y] } = { x: [42] })` the param-default missing-arg guard
`(if (call __extern_is_undefined …))` (emitted into the outer body before the
destructuring loop) had its i32-producing condition call shift-orphaned to point
at `__object_seal` (externref producer) → `if[0] expected type i32, found call
of type externref`, invalid Wasm. The triggering late import is the nested array
sub-pattern's `__array_from_iter_n` / `__extern_get_idx` / `__extern_length`.

**Fix pattern:** add the orphaned outer `savedBody` to `ctx.liveBodies` for the
recursion window (mirror the then/else tracking), guarded with an
`outerAlreadyLive` check so a re-entrant call doesn't double-delete (the #2182
liveBodies-balance invariant throws otherwise).

**Diagnosis tip:** dump the binary and `wasm-dis -all` (node_modules/.bin;
plain `wasm2wat` chokes on the GC type forms). Then instrument the captured
funcIdx at emit vs `ctx.funcMap.get(name)` at finalize, and log
`shiftLateImportIndices` firings + whether the call is reachable from
`fctx.body`/`savedBodies` — a `reachable=false` at a shift firing pinpoints the
orphan window and its swap site (the stack trace shows which destructuring helper
is mid-swap).
