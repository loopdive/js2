---
id: 2527
title: "Core-wasm module linking (shared store + canonical rec-group) for host-API shims and the shared runtime — CHOSEN approach"
status: ready
sprint: 64
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: module-linking
goal: architecture
related: [2512, 2514, 2525, 2523]
---

## Phase 0 spike result (2026-06-20) — GREEN ✅

Validated the premise: two **separately-compiled** WasmGC modules with
structurally-identical struct types share GC objects **zero-copy via engine
canonicalization**, on **both** target engines.

Method: module A declares `(type $cell (struct (field i32)))` and exports `make`
returning a struct as `(ref any)`; module B independently declares the **same**
struct, imports `make`, `ref.cast`s the result to its OWN `$cell`, reads the
field. (Assembled with binaryen 125 — wabt 1.0.39 has no GC support.)

- **V8 (Node 25):** B receives A-created struct, casts, reads → `42`. ✅
- **wasmtime 44** (`-W gc,function-references`, `--preload a=A.wasm --invoke test`)
  → `42`. ✅
- **Negative control:** a B′ declaring a *different* struct (extra field) → the
  cast **traps** ("illegal cast") — confirms real canonicalization, not a
  permissive cast. ✅
- **Binaryen stability:** `wasm-opt -O3 -Os` on A, then link with unoptimized B →
  still passes; a 2-member rec group with a *dead* type survived optimization with
  the **`(rec …)` group kept intact** (both types preserved) — so the whole-group
  canonical match held. ✅

Conclusion: the engine-canonicalization premise behind this issue **holds on V8
and wasmtime**, and default `wasm-opt -O3 -Os` preserves rec groups here. The GC
cross-module-identity question is settled positive — not a blocker.

Remaining engineering (Phase 1+), unchanged by the spike:
- Every js2wasm module must emit the **identical** frozen canonical rec group
  (same members + order) — canonicalization matches whole groups, not individual
  types.
- Validate at scale on the real js2wasm `String`/`Vec`/boxed rec group, and
  confirm no aggressive Binaryen pass (explicit type-pruning/merging) perturbs it
  — pin the type section or add a post-emit canonical-hash verification.

Repro scripts: `.tmp/gc-canon-binaryen.mjs`, `.tmp/recgroup-prune.mjs`.

## Decision

For modularizing both the **host-API shims** (#2512: process/fs/… as separately
compiled, link-on-demand modules) and the **shared runtime helpers** (#2514:
`number_toString`, string/vec/GC helpers), use **core-wasm module linking in a
shared store** — NOT the Component Model (tracked separately as the deferred
alternative in #2525). **Implement this version first.**

## Why core linking (the key fact)

WasmGC is **structural with canonicalization**: the engine canonicalizes
structurally-identical rec groups from separately-compiled modules into a single
runtime type (e.g. V8 maps every module's types into one global canonical index).
So two core modules that declare the **same** `String`/`Vec`/boxed rec group and
exchange those objects across a shared import/export get the **same** type —
**direct, zero-copy GC sharing**. The cross-module type identity we need is
**already provided by shipped runtimes**; this is an ABI engineering project, not
a standards gap.

The Component Model's Canonical ABI, by contrast, **copies** values across a
component boundary and does not hand core GC objects across — so it cannot give a
zero-copy shared GC runtime (it's fine for the byte-typed host-API boundary, but
that's the lesser win). Hence: core linking here.

## Shape

- A shared **`runtime.wasm`** (and per-host shim modules, e.g. `node-shim.wasm`
  over WASI, `deno-shim.wasm`) instantiated into the **same store** as the user
  module, sharing memory/tables/types.
- The user module declares its dependency the standard way: **core wasm imports**
  (`(import "js2wasm:runtime" "number_toString" (func …))`,
  `(import "node:io" "process_read" (func …))`). The import module-name + field
  *is* the in-wasm dependency declaration; a linker resolves it to the shim.
- A **frozen, versioned canonical rec group** (#2514) shared by `runtime.wasm`
  and every user module, so the GC types canonicalize to identity. Helpers pass
  GC objects directly; host-API shims pass bytes/scalars (no identity concern).

## Risks / work (the crux)

1. **Binaryen must preserve the canonical rec group verbatim** — `wasm-opt`
   merges/reorders types, which breaks canonical equality. Pin or post-process.
2. ABI versioning + distribution of `runtime.wasm` / shim modules.
3. Linking mechanism: plain multi-module instantiation in one store vs
   **shared-everything dynamic linking**
   (<https://github.com/WebAssembly/component-model/blob/main/design/mvp/examples/SharedEverythingDynamicLinking.md>)
   for the `.so`-style memory/table sharing. (Note: that design is linear-memory
   oriented; the GC-type sharing rides on engine canonicalization, separate from
   it.)

## Scope / phasing

- Phase 0: prove the canonical rec group canonicalizes across two
  separately-compiled js2wasm modules on the target engines (V8 + wasmtime), and
  that Binaryen can be made to preserve it. **DONE — GREEN (see above).**
- Phase 1: host-API shims (#2512) — byte/scalar boundary, simplest. **Scoped
  below.**
- Phase 2: shared runtime helpers (#2514) — GC boundary, on the canonical rec
  group.

## Phase 1 scope — `process` IO shim as a linkable core module

**Objective:** prove the host-API-shim linking pattern end-to-end on the smallest
real surface — `process.stdin.read` / `process.stdout.write` /
`process.stderr.write` — by relocating the WASI-backed implementation
(`node-process-api.ts`) out of every user module into one separately-compiled
`node-shim.wasm` the user module imports. Validates the pattern that later
generalizes to fs/path and to deno/other hosts (same interface, swap the shim).

**Boundary is GC-free (why Phase 1 is the easy one):** the user module already
keeps a **linear memory** for WASI iovecs and bridges its WasmGC `Uint8Array`
↔ linear memory around each `fd_read`/`fd_write` (today, inline). Phase 1 keeps
that GC↔linear copy in the user module and moves only the syscall side behind an
import over a **shared linear memory** — so nothing GC-typed crosses the link
(no canonical rec group needed; that's Phase 2).

**Deliverables**

1. A stable import interface (core-wasm functions over a shared linear memory),
   e.g. namespace `js2wasm:node-io`:
   - `stdin_read  (ptr i32, len i32) -> (i32)`   // bytes read into mem[ptr..]
   - `stdout_write(ptr i32, len i32) -> (i32)`
   - `stderr_write(ptr i32, len i32)`
   The user module **exports its memory**; the shim **imports** it (shared-
   everything linking) so the syscall reads/writes the same bytes.
2. js2wasm codegen: when a module uses `process` under `--target wasi`, emit an
   **import** of `js2wasm:node-io` + the existing GC↔linear bridge, instead of
   inlining the `fd_read`/`fd_write` glue. Keep the inline path behind a flag as
   fallback during bring-up.
3. `node-shim.wasm`: implements the interface over WASI
   `wasi_snapshot_preview1.fd_read`/`fd_write` on the shared memory. (A
   `deno-shim`/browser variant is a later, mechanical follow-up.)
4. A link step / doc: `wasmtime run --preload js2wasm:node-io=node-shim.wasm app.wasm`
   (mirrors the Phase 0 `--preload` linking), or a precompose helper.

**Acceptance**

- The native-messaging example compiles to a user module that **imports**
  `js2wasm:node-io` (no `wasi_snapshot_preview1` import in the user module
  itself), links against `node-shim.wasm`, and still round-trips a framed
  message under wasmtime (reuse the #2521 runtime test harness).
- The shim is the only module importing `fd_read`/`fd_write`.

**Open design decisions (resolve in the impl)**

- Shim granularity: raw syscalls vs a richer buffered API (stdin EOF/read-loop,
  argv/env). Start raw (smallest dedup, cleanest boundary); enrich later.
- Memory ownership: user exports memory + shim imports it (chosen), vs shim owns
  memory. User-exports is simpler given the GC↔linear bridge already lives there.
- Dependency declaration: the core-wasm import module-name (`js2wasm:node-io`) is
  the in-wasm declaration; revisit a WIT description only if/when #2525 is taken.

**Risks**

- Index-space / memory-export plumbing in the WASI codegen path.
- `--preload` is wasmtime-specific; document the equivalent for Node (instantiate
  shim, pass its exports as imports — exactly the Phase 0 harness) and browsers.

## Notes

Split from the #389-driven modularization discussion. The Component Model + WIT
alternative is #2525 (deferred). Corrects an earlier framing that called GC
cross-module sharing "blocked" — it is not; runtimes canonicalize identical
structs.
