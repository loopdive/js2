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
batches are bounded to the exact generated `entry.ts` length (220,000 characters
by default) and 32 tests; the same entry builder sizes the batch and writes the
artifact, so generated setup and export scaffolding cannot escape the limit.
This is separate from provider caching: two historical ~870 KB consumers still
needed 308–478 seconds and one emitted a 462 MB invalid module even with four
warm provider hits.

A remaining compile-stage watchdog timeout is subdivided as a stable binary
tree, to at most six levels/127 attempts per original batch. Only a timeout
reported specifically during compilation triggers this recovery; diagnostics,
invalid Wasm, execution timeouts, and singleton timeouts remain terminal. The
terminal leaves alone own tests and native-oracle rows, while every attempted
parent and child remains in `compile.attempts` so recovered timeout cost and
provider-cache telemetry stay visible. Each retry links the same cached provider
modules from a unique consumer root rather than recompiling package sources.

The cold end-to-end control on 2026-08-30 took 9,584.84 seconds. Its 400,000
raw-character estimate produced four `ReactDOMFizzServer` entries between
453,639 and 466,648 generated characters; all four exhausted the 300-second
compile watchdog. The other 120 client batches recorded seven provider compiles
and 473 cache hits, and the legacy-server/browser-Fizz/node-Fizz/edge-Fizz lanes
recorded no timeout, isolating the remaining failure to oversized client roots.

With exact 220,000-character partitioning, a real focused rerun admitted all
166 client-side `ReactDOMFizzServer` tests as 18 batches and completed in 168.01
seconds. No attempt timed out or split; the largest entry was 219,029
characters, the slowest compile was 21.418 seconds, and all 72 provider
resolutions were cache hits in strict separate mode. Summed compiler work for
that file fell from 1,722.203 seconds in the 400,000-character control to
283.283 seconds, a 6.1x reduction. Ordinary async-shape/codegen diagnostics and
the existing emitted-Wasm validation failures remain visible as separate
correctness work rather than being mislabeled as timeouts.

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

## Narrow runtime-provider ABI alignment — implementation admission (2026-10-06)

Approved Astra prerequisite plan: align only the maintained provider builder's
strict expected ABI with canonical producer version 3, add a producer parity
test and exercise the exact extracted `verify` declaration. Preserve missing,
old and future metadata rejection, zero imports, five required exports, canary
instantiation and publication ordering. No shared loader, canonical producer,
IR, cache schema or Symbol-demand changes are admitted.

Sol 6.1 owns `codex/2527-runtime-provider-abi-sol61`, created from freshly fetched
upstream main `bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1`. The earlier
`e1d0485572bf189d887e4bbfbbbc2675cf26aa08` to current-main diff changes IR
monomorphization and reports, but not this builder, canonical producer, loader,
package manifest, lockfile or workspace configuration. Root reconciled the
exact script/test ownership: no identified active overlap; no foreign worktree
or primary-checkout edits are authorized.

At admission, native acceptance was UNEXECUTED. Provision a genuinely
private Node 24 and frozen dependency graph, build fresh compiler/runtime
bundles, then use the normal cold builder with unique own cache/output paths.
Require actual ABI 3 metadata and raw binary verification, matching manifest
inputs, zero imports, all exports and canary. Execute the existing canonical
provider/consumer scenario plus an actual formatting-value check; reject ABI 2
and wrong hash through the canonical binary verifier. Remove just the alignment
and repeat a cold builder rejection, restore it and repeat success. Retain
terminal receipts and never substitute a stale provider or an unchanged-cache
hit for attribution. Stop if metadata is absent/not 3 or binary verification
fails. Scoped checks precede publication; broad suites need root admission.

### Measured prerequisite acceptance (2026-10-06)

The production change is the script-local expected-version constant 3, its
strict equality and version diagnostic. The new test reads the exact AST
`verify` declaration and actual version/export initializers; it does not run
the CLI main or substitute a rewritten verifier. Current-version admission,
missing fingerprint/ABI, old ABI 2, future ABI 4, each of five missing exports
and nonempty imports are covered. All 12 guard/parity tests and all 10 existing
canonical-recgroup tests passed (22/22; 2/2 files) with private Vitest 3.2.7.
Scoped formatting, lint, LOC/function budgets, oracle ratchet, issue-document
integrity and issue-ID checks also passed without waivers. Publication uses the
normal repository commit/push hooks; broad suites were not run locally.

Own upstream source epoch has 1,841 source files and SHA256 digest
`f1d7c1f3042201a8fae0de085c2441532009c1a26adbde99637550dde8e7c8a5`.
The full private Node 24 copy contains 8,615 files; executable SHA256 is
`7f9f8346011946e63956e45d1860cc409631802529e8cb18a0c86eed2ff5bf2e`.
Normal frozen-lockfile installation retained lifecycle scripts and a private
copy store. Readback verified 45 roots, 825 installed snapshots, 171 supported
platform omissions, 1,636 edges and all eight Vitest packages at 3.2.7. Fresh
normal compiler and runtime bundles both terminated 0. Source, primary
dependencies/configuration and worktree-hook sentinels stayed unchanged.

Actual normal cold builder inputs were source `export {};\n` (SHA256
`8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881`),
the script's unchanged normal compile options, loader origin
`compiler-bundle.mjs`, compiler bundle hash `cf57d16657725e73`, and key
`84803e1bfa2640a06b5a9010`. Published and cache manifests/binaries matched;
manifest key, bundle hash, source hash, options and byte count were checked.
The actual 30,975-byte provider SHA256 is
`c4edcb1007da47cb9984cfd08795dc09ae88ac2583457e1de173a41f825930bf`.
Its fingerprint is ABI 3, count 10, hash `9f92591261f6a7b1`. Raw binary
verification passed; imports are empty, all five number exports exist and
canary instantiation succeeds. The same-store number-format consumer has the
identical fingerprint and passed raw verification. Its actual formatted results
were `"42"`, `"-123.5"`, `"0"` (3/3) through the supported normal host decoder.

The first acceptance driver failed after a successful builder because it
omitted normal `importObject.__setExports(instance.exports)` wiring. Preserve
that failed arm rather than count it as success. A same-source/same-provider
diagnostic measured three empty host strings before the supported hook and all
three exact expected strings after it. Only the ignored driver was corrected;
no runtime/loader or consumer-source change was made. A fresh cold builder arm
then passed the complete consumer value check.

For removal attribution, changing only the expected-version literal 3 to 2
made another normal cold builder terminate 1 with the ABI v2 metadata error,
before publishing any cache/output files. Exact restoration (builder SHA256
`911b762ade9323295ff7d8ab8508fadba3cea9a09a7629b4cf3ca49f5318ae8a`)
made a third unique cold cache build terminate 0 and reproduce the identical
provider bytes, current fingerprint and raw verification. Old ABI 2 and a
same-version wrong hash were rejected by the real canonical binary verifier.
Those negatives do **not** assert independent builder cache hash validation;
that remains outside this repair. No Symbol rows or conformance gains are
claimed, and the earlier failed Symbol compile's actual metadata remains unknown.

Retained own `.tmp/` receipts (all paths relative to this worktree):

- `2527-abi-private-deps.C33Q6v/graph-readback.json`, SHA256
  `86894096e7fc608789e45af78082fb82391c08d12706e136036b66cdfbeae271`.
- `2527-abi-build.AGcCbp/receipt.json`, SHA256
  `ff545e74ec5cdf7384148c1a874426e38143e2e294921491cea4bac0320f5597`.
- Failed first arm: `2527-abi-native-current.085zZm/` retains normal builder
  terminal, published binary/manifest and both decoder diagnostics.
- Successful corrected arm: `2527-abi-native-current.F5SRxX/receipt.json`, SHA256
  `7153b0d5c52a67894f1e815b78f69976245098379ffa4851f1d512224aab06bb`.
- Removed arm: `2527-abi-native-removed.iylgsO/receipt.json`, SHA256
  `2052ae284c0507eb9cdd2e06b6780f3b08b388db6420aed87f568c275ee4b883`.
- Restored arm: `2527-abi-native-restored.gcPbWK/receipt.json`, SHA256
  `38488a155372db87ea246efa135d5059fa74b948f004dc95f423335d7c2510b4`.
- Focused tests: `2527-abi-checks-focused.8pRXte/receipt.json`, SHA256
  `44fff179c7498dc13e1b88f961010e54b3469779f1ccc253a3f3630e8ba9f58a`.
- Scoped gates: `2527-abi-checks-gates.su6HwW/receipt.json`, SHA256
  `16df9f202a1a1805ab76797efce239298ba878c1e7105bc67067dadaf38fa3fc`.

## Notes

Split from the #389-driven modularization discussion. The Component Model + WIT
alternative is #2525 (deferred). Corrects an earlier framing that called GC
cross-module sharing "blocked" — it is not; runtimes canonicalize identical
structs.
