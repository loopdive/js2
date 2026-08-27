---
id: 2527
title: "Core-wasm module linking (shared store + canonical rec-group) for host-API shims and the shared runtime — CHOSEN approach"
status: in-progress
sprint: 67
created: 2026-06-20
updated: 2026-08-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: module-linking
goal: architecture
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): GENUINELY OPEN, actively in-flight — open PR #1997 (feat: canonical runtime rec-group identity primitive for core-wasm linking, senior-dev). Phase 0 spike is GREEN; the linking implementation has NOT merged yet (no feat commit on main; only docs #2524/#2512/#2514). Senior-dev/architecture lane — NOT a routine dev pull. → in-progress (was ready; TaskList #56 'completed' was premature — impl not on main)."
related: [2512, 2514, 2525, 2523]
loc-budget-allow:
  - src/index.ts
  - src/compiler.ts
  - src/cli.ts
  - src/codegen/index.ts
  - src/emit/binary.ts
  - src/codegen/context/types.ts
  - src/codegen/registry/imports.ts
  - src/codegen/number-format-native.ts
  - src/bundle-manifest.ts
  - src/package-bundler.ts
  - src/package-linker.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/compiler.ts::runPipeline
  - src/emit/binary.ts::emitBinaryWithSourceMapUnguarded
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/package-bundler.ts::mergePackageProviders
  - src/package-linker.ts::compileLinkedProject
oracle-ratchet-allow:
  - src/codegen/index.ts
coercion-sites-allow:
  - src/codegen/index.ts
  - src/codegen/number-format-native.ts
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

## Phase 2 progress (2026-06-24) — canonical rec-group IDENTITY PRIMITIVE landed

Phase 1 (host-API shims, #2524) merged (PR #1791, renamed node-process #2625,
migrated to node:fs #2633). The remaining work for this issue is **Phase 2 —
shared runtime helpers (#2514) on the GC boundary**, whose documented *main
risk* (#2514 risk #2) is "Binaryen must preserve the canonical rec group
verbatim" and whose precondition is a *verifiable* notion of "two modules
declare the identical canonical rec group".

The initial identity primitive (`src/emit/canonical-recgroup.ts`) was the
keystone for the Phase-2 implementation. The current compiler extends it with
an emitted canonical group and a raw-binary drift gate:

- `RUNTIME_RECGROUP_TYPE_NAMES` — the closed, ordered, *name-stable* set of GC
  runtime types that cross a shared-store link boundary (string family +
  vec/arr family). `RUNTIME_RECGROUP_ABI_VERSION` versions it.
- `canonicalHashOfTypeGroup()` — a deterministic structural hash that is
  **name-independent and absolute-index-independent** (matching WasmGC
  isorecursive canonicalization) but **order/structure/topology-sensitive**.
  Equal hash ⇒ the engine canonicalizes the groups to the same runtime type ⇒
  GC objects can cross the link with zero copy.
- `extractRuntimeGroup()` / `fingerprintRuntimeGroup()` — locate the runtime
  types in a module's flat type table and produce a stable fingerprint, the
  building block for a CI drift gate (capture the reference `runtime.wasm`
  fingerprint, assert every user module reproduces it, including AFTER
  `wasm-opt`).

Exported from the public API (`src/index.ts`). Proven by
`tests/canonical-recgroup.test.ts`: (A) reproducible across recompiles, (B)
stable across *different* user programs sharing runtime types (the core ABI
premise), (C1–C4) name/index-independent but order/structure/topology-sensitive.

**Two empirical findings that shaped Phase 2 (recorded here so follow-on work
doesn't re-discover them):**

1. **Before P2a, the GC runtime types were NOT in a `(rec …)` group at all** —
   a probe of a real string+array module showed `computeRecGroups` (in
   `src/emit/binary.ts`) emitting every one as a *singleton*. P2a now emits the
   ABI members as **one contiguous frozen rec group in canonical order** and
   retains that range through DCE.
2. **`wasm-opt` renames/renumbers all named types** (`$__str_data` → `$6`) and
   is free to merge/reorder them — confirming risk #2 is real. The fingerprint
   is name/index-independent precisely so it can detect a post-`wasm-opt`
   *structural* perturbation. P2b now fails safe to the unoptimized bytes when
   that happens; CI packaging can add stricter optimizer pinning once the
   provider ABI grows beyond this slice.

**Note on member naming:** the eagerly reserved externref/f64 vec/arr members
use stable names and are now included in ABI v2. Later element-specific
variants can carry index-suffixed names, so they remain outside the closed
ABI list and are not linkable runtime types.

## Phase 2 implementation slice (2026-08-25) — frozen group, drift gate, runtime provider

The compiler now implements P2a/P2b and the first P2c helper family:

- Native-string codegen eagerly registers the complete ordered ABI-v2 member
  set, records one contiguous canonical range, roots that range during DCE,
  and emits it as one `(rec ...)` group. Any adjacent-group merge is rejected
  rather than silently changing the link contract.
- `CompileResult.runtimeRecGroupFingerprint` records the structural identity.
  `verifyRuntimeRecGroupBinary` parses raw emitted type sections without names
  or absolute indices. The compiler verifies codegen output and rejects
  optimizer output that drifts, retaining the unoptimized bytes with a warning.
- `runtimeProvider: true` publishes the native number-format exports under the
  `js2wasm:runtime` ABI. `scripts/build-runtime-provider.mjs` builds a
  content-addressed, zero-import provider and canary-verifies its exports and
  ABI metadata. Consumers opt in with `link: ["js2wasm:runtime"]`.

The prerequisite package-link slice now emits real content-addressed provider
binaries and a `PackageLinkPlan`, rewrites consumer imports into deterministic
`js2wasm:npm:<package>:<hash>` namespaces, and instantiates package DAGs in
provider-before-consumer order. Direct function declarations use an exact core
function ABI. Runtime values, objects, closures, classes, default exports, and
namespace objects use provider-owned getter adapters, with authority wrapping
that preserves provider-owned callable identity, mutable state, and fresh
instantiation lifecycles.
Relative and cross-package named/default/star barrels are resolved explicitly.
Every provider embeds its authoritative `js2wasm.provider.v1` manifest; cache
candidates and convenience metadata are rejected unless they match it.

The binary cache reports `compiledProviders` versus `cachedProviders` and may
reuse a manifest-verified ABI superset for a consumer requesting fewer exports.
TypeScript-realpathed npm/pnpm symlinks are recognized from the physical
package's `package.json`. `result.importObject` preserves legacy direct
instantiation callers while `instantiateLinkedProject` creates fresh provider
lifecycles. Package cycles, ambiguous multiple entrypoint targets, TypeScript
type-position identity, and unsupported namespace/re-export ambiguity remain
explicit deterministic monolithic fallbacks; they are never routed through
`externals`, which could silently erase a value boundary.

## Static npm bundle slice (2026-08-25) — manifest-driven `wasm-merge`

`compileProject({ packageLinking: "merge" })` now consumes the same cached,
manifest-verified provider modules and statically combines them with the root
application through Binaryen `wasm-merge`. `wasm-metadce` roots only the
application's public exports, so provider link exports remain internal and can
be eliminated after imports are connected. When optimization is requested, a
final `wasm-opt` pass runs after merge so cross-package calls can be inlined and
optimized as ordinary internal calls. The finalized module embeds an
authoritative `js2wasm.bundle.v1` custom section containing provider identities,
dependency order, source/cache fingerprints, boundary contracts, public root
exports, and the consolidated single-instance host/string adapter metadata.

This path deliberately continues to use complete core-Wasm modules rather than
the repository's older LLVM-style relocatable-object emitter. The ordinary
modules retain the provider ABI, are independently valid/cacheable artifacts,
and are the native input format of `wasm-merge`; relocation records are not
needed to connect already-typed core imports and exports.

The first static slice accepts direct function boundaries whose providers need
no provider-local host callback adapter. String-constant globals are safely
consolidated into the bundle host manifest. Getter boundaries (values, objects,
closures, classes, and namespace objects), deferred provider initialization,
and provider-local host callbacks retain the existing separate-module runtime
and report `PackageLinkPlan.mergeFallbackReason`. This is an explicit semantic
fallback, not a silent source bundle or erased boundary.

React DOM dogfood artifacts use package-derived identities (`react`,
`scheduler`, `react-dom-shared`, `react-dom-client`, `react-dom-server`, and
`react-dom-fizz`) rather than exposing the linker's internal “provider” role in
their package or module names. “Provider” remains terminology for a module that
satisfies another module's imports, not part of the user-facing filename ABI.

## Strict consumer failures and bounded adapters (2026-08-27)

The first full React DOM run exposed a fallback that defeated compile-once
semantics after the provider cache had succeeded. A linked consumer (the small
root module containing the lifted tests) could fail quickly with an ordinary
compiler diagnostic; `compileLinkedProject` then discarded that result and
retried the complete project monolithically, recompiling all cached provider
sources. A preserved `ReactDOMSelect` batch measured 18.6 seconds for the
authoritative linked-consumer refusal but 516.7 seconds when the bundled retry
was allowed to run to the same refusal.

Explicit `packageLinking: "separate"` is therefore strict at the consumer
compile boundary: it preserves that consumer result and provider-cache plan
without a bundled retry. Automatic API linking (`true`/omitted) retains the
compatibility fallback because a generated declaration/import adapter can fail
even when the original monolithic graph remains compilable. Planner failures
such as package cycles, type-position identity, ambiguous boundaries, and
signature validation continue to fall back explicitly in both modes.

The React DOM dogfood worker opts into strict separate mode. Its client adapter
batches are also bounded to 400,000 lifted-source characters and 32 tests. This
is separate from provider caching: two historical ~870 KB consumers still
needed 308–478 seconds and one emitted a 462 MB invalid module even with four
warm provider hits. Splitting those consumers keeps the provider modules cached
and independently linked while bounding the remaining root-codegen work.

## Measurement rule for whoever packages the runtime-eval provider (#2928 E7)

The first real consumer of this linker is #2928's `js2wasm:runtime-eval`
provider, and packaging it will generate standalone Test262 numbers. Two rules
come out of #2928 E7 (2026-08-01), where getting this wrong silently invalidated
a lane comparison:

1. **State the TIER with every standalone eval figure.** Without
   `TEST262_FULL_RUNTIME_EVAL=1` the harness links the cheap *refusal* provider
   and the number is CI-comparable. With it, the number is **interpreter-linked
   and NOT comparable** with the published baseline or the #1897/#2097 floor
   gates — until this issue actually publishes the interpreter provider to CI,
   at which point the two converge and this caveat retires. Every pre-E7 local
   eval figure in #2928 carries this qualifier, including E6's headline
   106→117 `eval-code` arm.

2. **Never let the harness silently select a capability the published lane
   lacks.** That is the general form of the defect: between E6 and E7 the worker
   linked the real interpreter whenever it happened to be cached — no flag, no
   log line naming the tier — while CI's cache was always cold. Local and CI
   diverged by roughly the interpreter's yield, and *neither report said so*.
   The fix has two halves and needs both: an explicit opt-in flag, and a tier
   announcement on **every** path including the successful one
   (`announceRuntimeEvalTier` in `scripts/test262-worker.mjs`). Provenance has
   to travel **with** the number — inside the table, not in the prose near it —
   or the number travels and the caveat does not.

Apply the same discipline to any other capability this linker makes optional
(host-API shims, `runtime.wasm` GC helpers): if a lane can run with or without
it, the artifact must say which, unprompted.

## Notes

Split from the #389-driven modularization discussion. The Component Model + WIT
alternative is #2525 (deferred). Corrects an earlier framing that called GC
cross-module sharing "blocked" — it is not; runtimes canonicalize identical
structs.
