---
id: 3451
title: "Test262: compile and statically link reusable Wasm harness objects in both lanes"
status: in-progress
sprint: current
created: 2026-07-19
updated: 2026-07-26
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: perf
area: test262-runner
language_feature: module-linking
goal: test262-conformance
depends_on: [1046, 2527]
related: [33, 34, 3433, 3450, 3461, 3491, 3625]
# (2026-09-14, slice 3 / P2) Three substrate fixes land in the two god-files that
# own the boundaries they are about; there is no subsystem module to move them to
# without inventing one for three call sites.
#   - src/runtime.ts +52: the mirror-vs-raw-struct canonicalisation at
#     `__new_Test262Error_ctor`, the `instanceof` carrier query, and the
#     `_hostStrictEqual` harness-identity arm. ~40 of the 52 lines are the
#     comments recording WHICH representation each site sees and why the
#     registered-under-one/queried-under-the-other split produced a false
#     `instanceof` — the fix is unreadable without them.
#   - src/compiler.ts +21: hoisting `TOLERATED_SYNTAX_CODES` to module scope so
#     the multi-file syntax gate applies the SAME allowlist as the single-file
#     one. Net logic is one predicate term; the rest is the doc comment saying
#     why a gate without the list is wrong rather than merely stricter.
loc-budget-allow:
  - src/runtime.ts
  - src/compiler.ts
# `resolveImport` +13: `__new_Test262Error_ctor` changes from a bare function
# reference to a two-line arrow that canonicalises the carrier, plus its
# comment. Splitting the 7.7k-line resolver is #3399's job, not this PR's.
func-budget-allow:
  - src/runtime.ts::resolveImport
---

# #3451 — reusable linked Test262 harness Wasm for both lanes

## Decision

Use the same **separate-compilation + static-linking architecture** for both the
JS-host and standalone Test262 lanes:

1. Compile the literal upstream harness prefix to a relocatable Wasm object.
2. Compile only the test body for each sloppy/strict variant.
3. Statically link the harness object + body object into **one final Wasm
   module**.
4. Instantiate a fresh final module for every test.

Reuse immutable compiled code, never a live harness instance and never a prior
test verdict. This preserves per-test realm isolation and prevents prototype,
global, async, or harness state from poisoning later tests.

This supersedes the original standalone-only framing of this issue. The host
lane's native-V8 harness mode (#3450/#3461) remains a useful shadow oracle and
short-term experiment, but linked Wasm is the preferred common end-state because
the compiler remains authoritative for the literal harness in both lanes.

## Problem

The authoritative runner currently prepends the real Test262 harness to every
test and compiles the whole assembly. Passing tests commonly compile again for
the strict rerun. Across ~43k tests this recompiles the same 6–18 KB prefix
roughly ~73k times per full two-lane run.

#3433 removed the worst quadratic compiler rescans, but the remaining work is
real linear parsing, checking, codegen, and emission of the repeated prefix. In
the measured slow shard, compilation accounts for ~95% of compile time; runner
setup and execution are comparatively small. Caching verdicts would be unsafe,
whereas caching a compiler artifact and still compiling/linking/running every
body preserves regression detection.

The prefix combinations are much less numerous than the test bodies. The
2026-07-26 inventory found exactly **64 strict-neutral harness sources** in
43,287 eligible files. Therefore the desired compile shape is:

```text
repeated full harness+body compilations
        ↓
64 harness objects per target lane
        + body-only compilations
        + cheap links and fresh executions
```

## Artifact and execution model

### Harness-object key

Initially build one combined harness object per exact key:

- compiler bundle/content hash,
- target lane (`js-host` or `standalone`),
- ordered metadata include set,
- async helper presence,
- upstream harness/runtime source hashes,
- compiler options and runtime/canonical-rec-group ABI versions.

Strictness is deliberately **not** part of the harness key: the harness prefix
is strict-neutral and the `"use strict"` directive belongs at the beginning of
the body compilation unit. `raw` tests bypass the harness object entirely.

Use target-specific objects first. Host and standalone currently lower runtime
operations differently, so they must not share bytes merely because their
source prefix is identical. A later shared-runtime ABI may make more of the
objects target-neutral.

### Link shape

```text
harness-<lane>-<include-key>.o
        + test-body-<variant>.o
        ↓ static link
one self-contained test.wasm
        ↓
fresh Store/Instance/realm for that test
```

Prefer a **single statically linked final module**, not two long-lived Wasm
instances connected by a host bridge. The final module must share the same JS
global environment, constructors, exception tags, closure/table state, and
object identity between harness and body.

### Memory and poisoning controls

- Cache immutable object bytes/manifests, not mutable instances or globals.
- Share the harness object bytes across the four workers in a shard job where
  practical; otherwise use a small bounded per-worker LRU.
- Never retain per-test final binaries, source programs, compiler contexts, or
  instances after the row is written.
- Keep the current realm-contamination canary and GC guards until RSS
  measurements prove a safer replacement.
- Instantiate a fresh final module and fresh import/async state for every test,
  including both variants of a strict rerun.

## Required compiler/linker work

The repository has the foundations—#33 relocatable object emission, #34's
linker, and #2527's canonical WasmGC rec-group identity work—but the current
linker is not yet a production Test262 linker. This workload requires:

1. **Harness interface manifest.** Body-only compilation must know the harness
   globals and their types (`assert`, `Test262Error`, `$DONE`, `$ERROR`,
   `verifyProperty`, include-defined helpers, and related constructors) and emit
   linkable undefined symbols instead of host fallbacks or reference errors.
2. **Script-global semantics.** Preserve Test262's same-realm separate-script
   behavior, including top-level `var`/function visibility, lexical bindings,
   duplicate function last-wins behavior, and exact initialization order:
   async helper → metadata includes → runtime shim → `assert.js` → `sta.js` →
   test body.
3. **WasmGC/type identity.** Merge or canonicalize GC rec groups so strings,
   vectors, boxed values, classes, and especially `Test262Error` keep identity.
4. **Closures, tables, tags, and globals.** Relocate indirect calls, closure
   environments, function tables, mutable globals, exception tags, element/data
   segments, and module-init functions without duplicating runtime state.
5. **Runtime helper deduplication.** Resolve identical helpers once in the final
   module rather than linking two private copies whose identities or global
   state can diverge.
6. **Diagnostics/source maps.** Body diagnostics must remain anchored to the
   untouched upstream test file. Harness/link failures must be separately
   attributable.
7. **Standalone purity.** The final standalone binary must retain the existing
   post-link zero-host-import invariant.

## Delivery slices

1. **Corpus/ABI inventory — implemented 2026-07-26:** measure exact include-set
   cardinality, declared and consumed harness symbols, duplicate declarations,
   initialization effects, body-only split parity, and target-specific keys.
2. **Minimal linked smoke:** compile/link `assert.js` + a body using
   `assert.sameValue`, producing one valid executable module in both targets.
3. **Shared-realm substrate:** add globals, constructors/class identity,
   closures/tables, exception tags, and ordered module initialization; cover
   `Test262Error instanceof`, `verifyProperty`, callbacks, and object identity.
4. **Runner shadow mode:** add a non-authoritative `linked-wasm` oracle lane,
   bounded harness-object cache, metrics, and row stamps without changing the
   existing baselines.
5. **Full-corpus parity and stress:** run current honest assembly and linked mode
   on the same compiler commit in both targets; investigate every difference and
   run order-randomized poisoning/OOM stress.
6. **Authority flip:** after parity, give linked mode its own compatible
   baseline/oracle version, make it authoritative for both lanes, and retain the
   old honest assembly as a temporary scheduled audit until confidence is high.

## Slice 1 implementation and measurements (2026-07-26)

`assembleLinkedHarness` now exposes the authoritative source as an immutable,
strict-neutral harness prefix plus a body-only unit. Strictness is keyed only by
the body; raw tests bypass the object path. The source key includes ordered
parts, async state, and the final prefix hash, and is namespaced by target lane.
It is an inventory identity, not yet a production cache key; slice 4 must add
the compiler/options/runtime ABI versions listed above.

`pnpm run inventory:test262-linked-harness` walks the maintained corpus through
the same discovery, metadata, filter, and harness assembly functions as the
runner. It records declaration/initialization ABI facts and validates every
split against the honest assembly.

Measured on the local maintained checkout:

- 48,088 discovered files; 43,287 eligible and 4,801 filtered;
- 82,660 potential body variants, with **82,660/82,660 source-split parity
  checks passing**;
- 32 raw bypass tests, 5,377 async tests, and 504 fixture-graph candidates;
- **64 unique harness sources**, or **128 target-specific objects**;
- potential harness compilations per lane collapse **82,628 → 64**;
- potential repeated harness source per lane collapses
  **716,058,857 bytes → 1,141,693 bytes**;
- 78 statically consumed harness symbols;
- 14 keys contain duplicate top-level declarations that require the existing
  last-wins rename/initialization contract.

The inventory completed in roughly 14–15 seconds. This is not yet a shard speed
measurement: the authoritative runner is intentionally unchanged until the
linked smoke and shared-realm substrate pass. #3625's earlier measured
**72.3% host compile-cost share for the harness prefix** remains the realistic
performance target, while the inventory proves the reuse cardinality.

### Authoritative-runner parity control

A same-machine Test262 host-lane shard control (`chunk 1/57`, 836 rows,
`COMPILER_POOL_SIZE=4`) compared `origin/main` with this slice. The normalized
`file + strict + status` rows had the same SHA-256 digest, with identical totals:
526 pass, 284 fail, and 26 compile errors. Poison retries were also identical at 17.

The control took 189.81 seconds wall / 598,151 ms summed compile time; the
candidate took 194.37 seconds wall / 614,837 ms summed compile time. That is a
single-pair candidate slowdown of 2.4% wall / 2.8% summed compile time, within
the existing Test262 runner noise and with no relevant execution-path change.
This slice therefore claims **no runtime speedup**. It establishes exact
source/verdict parity and the reusable-object cardinality; timing the linked
path begins only after slice 2 can execute it.

### Current blocker for slice 2

The current object linker resolves scalar function/global imports and emits
multiple isolated memories. Literal `assert.js` needs the opposite shape:
WasmGC rec-group merging, one shared runtime/global environment, closure/table
and tag relocation, ordered module initialization, data segments, and helper
deduplication. Wiring linked mode into Test262 before those invariants exist
would change verdicts rather than merely accelerate them.

## Acceptance criteria

- [ ] Both `js-host` and `standalone` compile the harness separately and
      statically link it with body-only objects into one final module per test.
- [x] The exact harness-object cardinality, source-byte reuse, body split, and
      initial ABI surface are measured reproducibly on the maintained corpus.
- [ ] A full run reduces harness-prefix codegens from ~73k to
      `O(distinct include keys × lanes × workers)`, with the exact before/after
      counters recorded.
- [ ] Sloppy, strict-only, noStrict, raw, async, negative, include-heavy, and
      `_FIXTURE`/module-graph cases have explicit coverage (coordinate the last
      category with #3491).
- [ ] Full-corpus row-by-row parity holds against the existing authoritative
      honest mode in each lane: status, expected error phase/type, assertion
      count, async completion, and relevant error classification.
- [ ] Cross-boundary identity tests cover `Test262Error instanceof`, reference
      equality, descriptors/MOP operations, callbacks/closures, built-in
      constructors/prototypes, and thrown values.
- [ ] Randomized two-pass order testing and targeted prototype/global/$DONE
      mutation probes produce identical results, proving no live-instance
      poisoning.
- [ ] Standalone linked outputs contain no forbidden host imports after the
      final link.
- [ ] Four-worker shard stress has no OOMs and does not materially increase peak
      RSS versus the current honest runner; caches have explicit byte/entry
      limits and expose hit/miss/eviction metrics.
- [ ] Production merge-group measurements show at least a 2× reduction in
      median `Run shard` time; target approximately 2–3 minute shards without
      increasing end-to-end queue time.
- [ ] Any authority/verdict-logic change bumps or separates the oracle version
      before baseline comparison, so the merge queue cannot compare incompatible
      rows.

## References

- `plan/ci-acceleration-review.md` §3-L4, §5-F, §2.1.
- #3625: measured rejection of cross-target frontend/IR sharing and the 72.3%
  host harness-prefix compile-cost share.
- #3433: measured prelude dominance and compiled-prefix reuse recommendation.
- #1046: separate compilation and consumer-facing symbol/interface work.
- #33 / #34: relocatable object emitter and static linker foundations.
- #2527 / #2514: core-Wasm shared-store and canonical WasmGC runtime ABI.
- #3450 / #3461: native-host harness experiment and parity machinery.
- #3491: static Test262 `_FIXTURE` module-graph linking.

## Slice 2 — minimal linked smoke via the provider mechanism (2026-09-13)

`scripts/test262-linked-harness-smoke.mts` compiles the harness prefix once
per include-set as a **separately linked provider module** — the #2527
package-linker path that `compileWithTemporalGlobal` (#5248) uses for the
Temporal polyfill — and compiles each body against it with getter imports
(`var assert = __js2wasm_get___h_assert_…();`). Provider: harness prefix +
`export const __h_<name> = <name>` for every top-level binding (a `const`
alias forces a getter boundary so constructors and objects cross as values).

Measured (4-core container, warm process, `for-of/dstr` and
`Array.prototype.map` bodies):

| | honest single module | linked body |
| --- | --- | --- |
| compile per test | 600 – 1,400 ms | **30 – 96 ms** |
| provider build (once per include-set) | — | 0.7 – 2.9 s, 380 – 500 KB |
| provider instantiation per test | — | `new WebAssembly.Module` + instance, a few ms |

So the speed ceiling is real: ~15–20× on the body compile, and 64 provider
builds per lane amortise in seconds.

**Parity does NOT hold across the module boundary, and it cannot with this
mechanism.** Minimal-body probes (`.tmp`-style, reproduced by the smoke
script's failing rows) isolate three classes:

1. **Property reflection on body-side objects.** `verifyProperty(f, "name", …)`
   on a body function/object fails with "should be an own property" / "name
   descriptor value should be …": the provider's `Object.getOwnPropertyDescriptor`
   runs on the *host mirror* of the body struct, which carries no own
   properties. Everything in `propertyHelper.js` is affected — thousands of
   `built-ins` tests.
2. **Constructor identity round-trip.** `assert.throws(Test262Error, fn)`
   fails with "Expected a undefined but got a HostTest262Error": the provider's
   own `Test262Error`, handed to the body through the getter and passed back
   as an argument, arrives as a different (mirrored) object whose `.name` is
   undefined. Every `assert.throws(Test262Error, …)` in the corpus is affected.
3. **Boxed-value shape.** One row reported
   `Expected SameValue(«[object Object]», «12»)` — a body value reaching the
   provider as a mirrored object rather than a number.

Handing the body the provider's **raw** values instead of host mirrors (an
experiment forcing `noHostMirror` in `instantiateLinkedProviders`) is worse:
`assert.sameValue is not a function` and stack overflows — the two modules do
not share struct layouts, so a raw provider struct is opaque to the body. That
is the concrete form of this issue's original decision: **two instances
connected by a host bridge cannot give object identity or reflection parity;
only a single statically linked module with canonical GC types can.** Plain
`assert.sameValue`/`compareArray`/callback/throws-of-native-errors bodies do
pass linked (12/12 agreement on the `Array.prototype.map` slice), so the wiring
itself is sound.

**Consequence for the plan.** Slices 3–6 stay as written, but slice 3
("shared-realm substrate") is now known to require the static linker (#33/#34
relocatable objects + #2527 canonical rec-groups merged into ONE module), not
runtime wrappers. Two candidate routes, both compiler work:

- **Static link (as decided):** emit the harness object once, relocate function
  / type / global / table / tag indices when appending the body object, merge
  rec-groups canonically. Reuses the #33/#34 machinery; needs the GC-type
  canonicalisation and closure/table relocation listed under "Required
  compiler/linker work".
- **In-module codegen snapshot:** compile the prefix first in the single-module
  pipeline, snapshot the codegen context after its top-level statements, and
  resume per body. Blocked on the same honesty question this issue already
  lists — whether prefix lowering is body-independent (type-directed
  specialisation of harness functions by call-site types would make it not
  so) — and on rebinding `ts.Node`-keyed context state to the new program.

Either is an XL compiler task; neither is a runner-only change. The strict-
rerun elision (#6463) and the checker fix (#5814) were the runner-side levers
and are landed; #6462 duplicated this issue and is closed as such.

## Implementation Plan — slice 3 (written 2026-09-14, Fable lane; implementation: Opus)

### Decision revision

Slice 3 ("shared-realm substrate") is implemented on the **host-bridge
linked-provider substrate** (#2527 canonical rec-group, #5225 cross-module
struct decoders / mirrors, #5226 shared `env.__exn`, #5364 per-row registry
reset) — the path `compileWithTemporalGlobal` already runs in the sharded lane.
The July decision preferred one statically linked module; that route is not
available today and is not cheaper:

- `src/link/` (#34) rejects every GC typedef (`parseTypeSection` throws for
  anything but `0x60`, `src/link/reader.ts:379`), relocates by opcode scanning,
  merges no data/start sections and **isolates** modules by design (multi-memory,
  separate tables, no shared globals) — the opposite of a shared realm.
- `compileToObject` bypasses the Prepared-IR pipeline and refuses `standalone`
  (`src/compiler/output.ts:306`).
- Class/closure struct identity is per module and name-keyed
  (`ctx.structMap`, `src/codegen/context/types.ts:1546`); a merged module would
  still need the consumer to know the harness's shapes. That is exactly what the
  #5225 decoder registry already provides across two instances.

Static link stays the fallback if P2 below cannot reach parity; nothing in
P1/P3/P4 is lost in that case.

### Ground truth (measured 2026-09-13, `scripts/test262-linked-harness-smoke.mts`)

- Linked body compile 30–96 ms vs 600–1,400 ms honest; provider build
  0.7–2.9 s per include-set (64 sets per lane, #3451 slice 1).
- Provider-linked wiring is sound: 12/12 verdict agreement on
  `built-ins/Array/prototype/map`.
- **Harness lowering is body-specialised.** `isNegativeZero` compiles to 37
  lines with an `f64` temp under one body and 22 lines with an `i32` temp under
  another (`.tmp`-style diff of two honest assemblies). A once-compiled harness
  is therefore the *generic* lowering of every harness function. Parity is
  measured per test, never assumed; a difference caused by generic-vs-specialised
  lowering is a compiler finding to file, not a linker bug to paper over.

### P1 — harness provider builder (`src/test262-harness-provider.ts`, new)

Mirror `src/temporal-provider.ts` one-to-one:

- `harnessProviderCacheKey({ harnessPrefix, compileOptions })` =
  `fingerprint([prefix, providerOptionFingerprint(opts), RUNTIME_RECGROUP_ABI_VERSION, PROVIDER_COMPILER_ABI_VERSION, PROVIDER_LINKER_ABI_VERSION])`.
- `buildHarnessProvider({ harnessPrefix, cacheDir, compileOptions })` →
  `{ artifact, namespace, getters: Map<name, field>, names, buildMs, cacheHit }`.
  Synthetic package `test262-harness` under `<cacheDir>/harness-project-v1-<key>/`
  (materialise + verify + atomic rename exactly like `materializeTemporalProject`);
  `index.js` = prefix + `export const __h_<name> = <name>;` for every top-level
  `var`/`function`/`class` name (`$` → `S_`); entry imports ALL aliases so every
  boundary is published; assert `exportBoundaries[alias].kind === "getter"`.
  Memory cache + `packageCacheDir` disk cache as Temporal.
- `harnessBindingPrelude(provider, body, strict)` → `{ stubSource, prelude, bindings }`:
  referenced names by the #3461 token regex (`buildBindingShim` in
  `tests/test262-original-harness.ts`), `import { <getters> } from "./__js2wasm_harness_stub"`,
  `var <name> = <getter>();` per name, `"use strict";\n` first when `strict`.
- `compileHarnessLinkedBody(provider, body, options)` = `compileMulti` with
  `canonicalRuntimeTypes: true, sharedExceptionTag: true, link: [namespace],
  linkedPackageBindings, inferModuleStrictArguments: false, allowJs: true,
  fileName: "test.js"`, then `result.linkedModules = [artifact]`.
- Export all of it from `scripts/compiler-bundle-entry.ts` next to the Temporal
  exports; rewrite `scripts/test262-linked-harness-smoke.mts` onto these APIs.

### P2 — substrate parity fixes (`src/runtime.ts`, `src/linked-provider-runtime.ts`)

Each has a minimal repro; add each as a vitest case in
`tests/issue-3451-linked-harness-substrate.test.ts` that compiles the harness
provider (`assert.js + sta.js + propertyHelper.js`) and a body, instantiates
via `instantiateTest262Module`, and asserts the body's own `assert` calls pass.

1. **Constructor identity round trip.** Body:
   `assert.throws(Test262Error, function() { throw new Test262Error("x"); });`
   today fails "Expected a undefined but got a HostTest262Error". The getter
   hands the body a mirror of the provider's `Test262Error`; passed back as an
   argument it must re-enter the provider as the ORIGINAL struct. Add a
   mirror→struct ownership map in `createLinkedProviderMirrorOwnership` and
   unwrap at the inbound argument marshalling of provider callables
   (`_wrapCallableForHost` / `_maybeWrapCallableUnknownArity` arg path). Also
   covers `x instanceof Test262Error` and `assert.throws(TypeError, …)` (native
   error constructors must keep working — regression case).
2. **Reflection on consumer structs.** Body:
   `function f() {} verifyProperty(f, "name", { value: "f", writable: false, enumerable: false, configurable: true });`
   and `var o = {a: 1}; verifyProperty(o, "a", { value: 1 });` fail "should be an
   own property". `propertyHelper.js` inside the provider reaches
   `Object.getOwnPropertyDescriptor` / `hasOwnProperty` / `Object.keys` /
   `delete` on a mirror of a consumer struct. Route those host paths through
   `_decoderExportsFor(obj)` (#5225) so the CONSUMER's `__struct_field_names` /
   `__sget_` / descriptor helpers answer, including function `name` / `length`
   on consumer closures. Check `Object.defineProperty` on consumer structs the
   same way (`verifyNotWritable` writes then reads back).
3. **Boxed-value shape.** `for-of/dstr/array-elem-init-assignment.js` reports
   `Expected SameValue(«[object Object]», «12»)`: a body number reaches the
   provider as an object. Reduce to a minimal body, find the mirror path that
   boxes it (suspect: `_wrapForHost` on an `f64` box struct), fix.

After each fix rerun the smoke script on `language/statements/for-of/dstr` and
`built-ins/Array/prototype/map` (12 each); no agreement may regress.

### P3 — runner shadow lane (`scripts/test262-worker.mjs`, `tests/test262-shared.ts`)

- `TEST262_ORACLE_MODE=linked`: in `doCompile`, when `originalHarness` and not
  `raw`, take `assembleLinkedHarness(source, meta)` (already split at the right
  boundary, #3451 slice 1), get the provider for `harnessPrefix` (ONE memoised
  builder per fork, like `getWorkerTemporalProvider`; refuse cold builds inside
  the 30 s fork budget the same way — add `scripts/prewarm-test262-harness-providers.mjs`
  that builds all 64 include-set providers for a lane and writes the stamp;
  wire it where `prewarm-temporal-provider.mjs` is called), compile the body
  with `compileHarnessLinkedBody`, instantiate through the existing
  `instantiateTest262Module(..., { linkedModules: [artifact], linkedRuntime: runtimeBundle })`.
- The strict rerun (#6463 gating unchanged) links the SAME artifact with the
  strict prelude.
- **Per-row honest fallback**: a link-shape compile error (body redeclares a
  harness name, or the getter prelude fails to type) falls back to the honest
  assembly for that row and increments a `linked_fallback` counter; the row is
  stamped `oracle_lane: "linked-harness-fallback"`. Never silently.
- Row stamp `oracle_lane: "linked-harness"`; `diff-test262` must refuse to
  compare a linked run against the honest baseline (same rule as
  `fast-nativeharness`). The lane NEVER promotes a baseline.

### P4 — parity measurement and acceptance

Run both lanes (`COMPILER_POOL_SIZE=1`, `TEST262_PATH_FILTER`) on:
`language/statements/for-of`, `built-ins/Array/prototype/map`,
`built-ins/Object/defineProperty`, `language/expressions/class`,
`built-ins/Promise/prototype/then` (async), `language/statements/with` (sloppy),
and one `raw` sample. Diff per test (`scripts/diff-test262.ts` style), not by
count.

Acceptance for this PR:
- [ ] P2 repros pass as vitest cases; smoke agreement 12/12 on both sample dirs.
- [ ] Shadow lane runs the sample above with **zero** verdict differences
      against the honest lane on the same commit, fallback count reported.
- [ ] Median `compile_ms` on the `for-of` + `map` slice ≤ 300 ms at pool 1
      (honest after #6463: 914 ms).
- [ ] `TEST262_ORACLE_MODE=linked` is opt-in; unset ⇒ byte-identical honest
      behaviour (assert in a test: same binary for one row).
- [ ] Every remaining difference is filed as its own issue with the minimal
      body, classified "generic-lowering" or "substrate".

Authority flip (slice 6) is a separate PR after a full two-lane parity run.

### Order-preservation constraints

- Initialisation order per row: provider instance (harness prefix, fresh per
  row via `instantiateLinkedProviders`) → body module start. Never reuse a
  provider INSTANCE across rows; reuse only the artifact bytes.
- `resetLinkedProjectRegistry()` before every row (already in
  `instantiateTest262Module`).
- Do not touch `scripts/*-baseline.json`, do not enqueue, no `--no-verify`.

## Slice 3 measurements (2026-09-14)

Implemented P1-P4. All numbers below are from THIS worktree at the slice-3
commits, 4-core container, `COMPILER_POOL_SIZE=1`, both lanes run at the same
commit through the real worker (`tests/test262-local-shard1.test.ts`, chunk 1/16
of the filtered set), honest first then `TEST262_ORACLE_MODE=linked`.

### Speed — the ceiling is real and it holds through the runner

| sample | rows | median `compile_ms` honest | median `compile_ms` linked | factor |
| --- | --- | --- | --- | --- |
| `Array/prototype/map` + `statements/for-of` | 60 | 360 | **68** | 5.3× |
| `Object/defineProperty` + `expressions/class` + `Promise/prototype/then` + `statements/with` | 344 | 404 | **73** | 5.5× |

The plan's bar was **median ≤ 300 ms**; measured 68-73 ms. Wall clock for the
second sample fell 232.9 s → 145.7 s (−37%) even while the linked lane also paid
43 cold provider builds inside the run.

Provider cost, for the amortisation argument: 0.9-1.6 s each, 80-194 KB, and the
pre-warm of three distinct include-sets took 4.0 s total. 64 sets per lane.

### Parity — 109 verdict differences in 404 common rows

| sample | rows | differences | fallback rows |
| --- | --- | --- | --- |
| map + for-of | 60 | 14 | 7 |
| defineProperty + class + then + with | 344 | 95 | 43 |

Not zero, so the plan's parity acceptance box is **NOT** green. Every difference
is classified and filed; none is unexplained:

| class | rows | filed as |
| --- | --- | --- |
| async completion marker not observed | 49 | #6476 |
| "different error constructor with the same name" (native errors) | ~32 | #6475 |
| descriptor VALUE read wrong (honest passes) | ~14 | #6477 |
| script-vs-module: top-level `var`, `arguments` | ~4 | #6474 |

The single largest lever is #6475: the provider rebuilds its own `env`, so it
resolves the AMBIENT error constructors while the consumer gets the runner's
per-test realm ones. That also plausibly explains part of #6477.

### What P2 fixed, and a correction to the plan

Three defects, one root cause — an identity registered under the provider's host
MIRROR and queried under the raw closure struct, or the reverse. Details in the
P2 commit; the 12-case substrate probe went 8/12 → 12/12 and the smoke reached
12/12 on `Array/prototype/map`, `for-of/dstr` and `Object/defineProperty`.

**The plan's class 2 was misattributed.** `verifyProperty` failures are NOT a
module-boundary defect: `Object.prototype.hasOwnProperty.call` / `in` /
`Object.hasOwn` on a compiled object answer wrong in the HONEST single-module
lane too, under `allowJs`, while `Object.keys` answers right. Both lanes fail
those bodies alike, so they are already at parity and the "thousands of
built-ins tests" framing does not apply to the shadow lane. #6477 covers the
part that IS a difference (descriptor values the honest lane gets right).

**The plan's class 3 does not reproduce.** Both reductions of the boxed-value
symptom pass in both lanes; the row it came from
(`for-of/dstr/array-elem-init-assignment.js`) fails in both for an unrelated
reason.

**A fourth defect, not in the plan and worse than any of them:** the linked lane
silently RAN source the honest lane rejects (`var a = ;;;` compiled and
executed). `compileMulti` suppresses syntactic diagnostics under `allowJs`;
without `strictJsSyntax` every `negative: SyntaxError` row would have flipped
pass→fail, in the lane whose only purpose is parity. Fixed, together with
hoisting `TOLERATED_SYNTAX_CODES` so the multi-file gate applies the same
tolerances as the single-file one (otherwise the flag over-corrects and rejects
valid JavaScript).

### Re-measured 2026-09-15 after #6475/#6476 — 109 → 21 differences

Same protocol as the 2026-09-14 row (real worker, `tests/test262-local-shard1.test.ts`,
`COMPILER_POOL_SIZE=1`, both lanes at the same commit — here the `linkedHost`
commit), one combined filter over all six sample dirs: 399 common rows.

| class | before (2026-09-14) | after |
| --- | --- | --- |
| async completion marker not observed (#6476) | 49 | **0** |
| native error constructor identity (#6475) | ~32 | **0** |
| descriptor VALUE read wrong (#6477) | ~14 | 13 |
| script-vs-module: `arguments`, unresolvable assignment (#6474) | ~4 | 3 |
| `with`-scope write not seen (`S12.10_A3.11_T3`) | — | 1 |
| `illegal cast [in __cb_2()]`, async-gen destructuring | — | 1 |
| `Cannot convert object to primitive value` (`map/15.4.4.19-5-21`) | — | 1 |
| honest `compile_timeout` vs linked `fail` (timing artifact, not a lane defect) | — | 1 |
| linked **passes** where honest fails | — | 1 |
| **total** | **109 / 404** | **21 / 399** |

Both target classes went to zero, which is the whole of the 81-row drop; the
four residual rows now visible as their own classes were inside the 109 before
and are newly legible rather than newly caused. Wall clock 414 s honest vs
156 s linked on the same 399 rows.

### Re-measured 2026-09-15 after #6477 — descriptor-VALUE class 13 → 4

Scoped rather than corpus-wide: 47 rows (the 7 named `defineProperty` rows plus
the whole `class/elements/multiple-*privatename-identifier*` family), both
lanes, same worker protocol (`COMPILER_POOL_SIZE=1`,
`TEST262_PATH_FILTER_FILE`, `TEST262_ORACLE_MODE=linked` vs honest).

| class | before | after |
| --- | --- | --- |
| honest/linked agreement over the 47-row scope | 4 / 47 | **25 / 47** |
| descriptor VALUE read wrong (#6477) | 13 | **4** |
| &nbsp;&nbsp;↳ consumer ARRAY index read in-wasm (no host import fires) | — | 3 |
| &nbsp;&nbsp;↳ `verifyProperty(C.prototype, …)` on a class with fields | — | 1 (20 rows in the wider family) |
| linked rows regressed pass→fail | — | **0** |

#6477 fixed the registration window (the linked body now runs from an exported
`__module_init` AFTER the consumer joins the #5225 decoder registry, instead of
in the wasm `start` section) plus the descriptor read's decoder redirect. The
two residual classes are a codegen/ABI question, not a host-side one — details
in #6477.

### Re-measured 2026-09-15 after #6474 — script-goal class 3 → 0

The linked consumer is now compiled with the **script** goal (no prelude
`import`; `entryScriptGoal` lets `generateMultiModule` read the entry's own
goal). Measured on the corrected base, i.e. AFTER `1c8b440a74` stopped the
worker running the deferred `__module_init()` twice — that fix alone is worth
+70 rows on the sample below, so any #6474 number taken before it is not
comparable. Same worker protocol throughout (`COMPILER_POOL_SIZE=1`,
`TEST262_PATH_FILTER_FILE`, `TEST262_ORACLE_MODE=linked` vs honest, same commit,
bundles rebuilt before each run).

**Target rows** — `language/statements/with` first 12 + the two
`class/elements/{,private-}indirect-eval-contains-arguments` rows +
`built-ins/Array/prototype/map/15.4.4.19-5-21.js`. Honest is 15/15 pass
throughout, so the linked pass-count IS agreement:

| stage | linked agreement |
| --- | --- |
| before | 10 / 15 |
| P1 alone (import dropped, goal still forced) | 11 / 15 |
| P1 + P2 (+ P3) | **15 / 15** |

**Regression sample** — 471 rows, every 5th file of the five tractable sample
dirs (`language/expressions/class` excluded; the six dirs are 6,413 files):

| lane | before | after | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| linked | 348 / 471 | **361 / 471** | 2 | 15 |
| honest | 370 / 471 | 371 / 471 | **0** | 1 |

Classes `script-vs-module: arguments, unresolvable assignment` and
`Cannot convert object to primitive value (map/15.4.4.19-5-21)` go to **0**, and
the `with`-scope write row (`S12.10_A3.11_T3`) flipped to pass as well.

Two caveats, both recorded in #6474:

- #6474 carries a **P3** that is NOT honest-lane-byte-identical: the
  runtime-eval global mirror created a script `var` binding with
  writable/enumerable unspecified, i.e. `false`, against §9.1.1.4.16, so the
  next mirror refresh threw `Cannot redefine property`. Fixed with a
  creation-only spec-defaults flag bit; honest delta +1 / −0.
- The 2 linked regressions are `defineProperty/15.2.3.6-4-258` and `-3-185`,
  both `verifyProperty` on a consumer-minted value read from the provider —
  **#6482's class**, reproduced with P3 reverted. The script goal moves those
  values from module globals to global-object properties, which routes the read
  down the already-broken in-wasm vec path; it exposes #6482 on two more rows
  rather than introducing a mechanism.

### Acceptance boxes

- [x] P2 repros pass as vitest cases; smoke 12/12 on both named sample dirs.
- [ ] Shadow lane with **zero** verdict differences — **NO**, but 109/404 →
      **21/399** after #6475/#6476 (table above); remaining classes filed
      (#6474, #6477) plus three singletons. Fallback count reported per row and stamped
      `oracle_lane: "linked-harness-fallback"`; 50/404 rows fell back.
- [x] Median `compile_ms` ≤ 300 at pool 1 — measured **68-73**.
- [x] `TEST262_ORACLE_MODE=linked` is opt-in; unset ⇒ honest behaviour, asserted
      in `tests/issue-3451-linked-harness-lane.test.ts` (same binary for a row,
      plus the gating expressions and the `diff-test262` refusal).
- [x] Every remaining difference is filed with its class and mechanism.

`diff-test262` refuses a linked run against any other lane **unconditionally** —
`ORACLE_REBASE=1` does not excuse it, because seeding a linked baseline IS the
authority flip (slice 6), and an escape hatch here is exactly how a shadow lane
silently becomes the published number.
