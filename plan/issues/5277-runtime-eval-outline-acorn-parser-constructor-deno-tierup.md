---
id: 5277
title: "perf(runtime-eval): outline Acorn Parser construction so the standalone provider survives V8 background tier-up (Deno POC)"
status: ready
created: 2026-08-31
updated: 2026-09-02
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: eval
goal: runtime-eval
requested_by: ttraenkler/codex-sol-ultra
related: [2928, 1710, 4642]
origin: "Migrated from GitHub issue loopdive/js2#5381, filed 2026-08-31 by the Codex lane (GPT-5.6 Sol Max) as the handoff from PR #5380 (fix(interp): outline runtime-eval dispatch, merged 2026-09-01). Plan issues live as markdown files, not GitHub issues; the GitHub issue is closed by the PR that adds this file."
---

## Context

The Deno/js2wasm POC has its V8 API/module work in
[loopdive/v8x#1](https://github.com/loopdive/v8x/pull/1). The runtime-eval
interpreter dispatcher was outlined in
[PR #5380](https://github.com/loopdive/js2/pull/5380) (merged 2026-09-01),
which removed the original monolithic interpreter `run` function as the
dominant native V8 tier-up failure. Generated bodies after #5380:

| function | body size |
| --- | --- |
| `run` | 1,201 bytes |
| `dispatchNext` | 344,845 bytes |
| largest opcode-family helper | 423,880 bytes |

The provider builds to 50,122,820 bytes and all five functional canaries pass.
Interpreter fixtures pass 75/75 and eval-environment tests pass 57/57.

## Problem — remaining blocker

A plain Node process that invokes all five provider canaries still aborts
during **background Wasm tier-up** after roughly 14 seconds with a native V8
compiler-zone OOM in `WasmGCTypeAnalyzer`.

`--trace-wasm-inlining` localizes the remaining hot function to index 1325,
`__fnctor_Parser_new`:

- raw function body: 120,258 bytes
- emitted graph: about 61,439 nodes
- property-call sites: about 2,950
- references Acorn `getOptions` (function 205; 634,663-byte body), which V8
  reports is not called often enough to inline

This is **Acorn parser construction/initialization**, not the interpreter
dispatch loop. The self-compiled Acorn (
[#1710](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1710-acorn-via-js2wasm))
constructor is emitted as one oversized function body.

## Implementation Plan

1. **Reproduce** from current `main` (contains #5380) with the raw provider
   builder and confirm all five canaries complete:
   ```bash
   NODE_OPTIONS=--max-old-space-size=6144 node --import tsx scripts/build-runtime-eval-provider.mjs
   ```
2. **Outline Acorn `Parser` initialization.** Prefer a general compiler
   transform for oversized constructors / property-initializer runs over
   modifying the pinned Acorn source. Preserve constructor ordering,
   derived-constructor rules, closure captures, and observable property
   initialization order.
3. **Add focused regressions** for constructors with many property
   initializers and for nested/derived constructors where relevant.
4. **Rebuild the provider** and invoke all five canaries from ordinary Node.
   Acceptance: the process stays alive for at least 30 seconds with no
   tiering flags and no enlarged runtime heap.
5. **Update the js2 pin in v8x#1.** While #5380 was unmerged, that draft
   deliberately fetched commit `4024b398c547c26850063b44752c82c2d7c906b3` from
   `ttraenkler/js2`; #5380 has landed, so switch the CI remote back to
   `loopdive/js2` and pin a `main` commit.
6. **Rebuild both raw and Wasmtime AOT artifacts**, then run patched Deno's
   full `cargo nextest -p deno_core` suite.

After tier-up is stable, the v8x side still needs complete source-phase and
deferred-import contracts: retain a real source-module object from the host
callback, propagate dependency phase metadata, and implement lazy deferred
namespace evaluation. Cover `core_testing`'s `import_defer`,
`source_phase_imports`, and `source_phase_imports_dynamic` integrations.

## Constraints carried over from #5380

- `src/interp/loop.ts` sits at 1,556 lines against a 1,563-line LOC budget.
  Any further interpreter work must extract `DispatchState` and/or
  opcode-family helpers into an interpreter subsystem module rather than grow
  the driver.
- #5380's repair note: a cross-module extraction of the dispatcher *state*
  compiled under Node tests but **miscompiled in the self-hosted standalone
  provider**; only stateless helpers were safe to move. Any constructor
  outlining transform must be validated on the self-compiled provider, not
  just on the Node test suite.

## Known-green checks (at handoff, 2026-08-31)

- js2 repository pre-push suite
- interpreter fixtures: 75/75
- eval-environment tests: 57/57
- provider compilation plus five functional canaries
- v8x `cargo fmt --check`
- v8x runtime-backend `cargo check`
- v8x js2wasm module tests: 7/7

## Acceptance criteria

- [ ] Acorn `Parser` construction no longer emits a single >100 KB function
      body; `__fnctor_Parser_new` (or its successor) is split into bounded
      helpers by a general transform, with Acorn source unmodified.
- [ ] Focused regression tests for many-initializer and derived constructors
      pass, and observable initialization order is unchanged.
- [ ] Plain Node invoking all five provider canaries survives ≥ 30 s of
      background tier-up with default flags and default heap.
- [ ] Interpreter fixtures (75) and eval-environment tests (57) still pass;
      the provider still self-compiles.
- [ ] v8x#1 pins a `loopdive/js2` `main` commit and `cargo nextest -p deno_core`
      passes on patched Deno.

The full Deno POC is intentionally not claimed green until the plain-Node
tier-up hold and the `deno_core` suite both pass.
