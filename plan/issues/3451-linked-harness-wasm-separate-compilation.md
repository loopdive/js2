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
