---
id: 6462
title: "test262: stop recompiling the harness prelude per test — link a per-worker prelude module"
status: wont-fix
created: 2026-09-13
updated: 2026-09-13
completed: 2026-09-13
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: perf
area: test262-runner, compiler
goal: test262-conformance
sprint: Backlog
es_edition: n/a
related: [3433, 3451, 3461, 6463]
---

# #6462 — reuse the compiled harness prelude across tests

> **Closed as a duplicate of #3451** (2026-09-13). #3451 already carries the
> decision (single statically linked module), the slice plan and the ABI
> inventory; the measurements and the slice-2 smoke results from this work
> were recorded there. Nothing further tracked here.

## Problem

Every test262 compile in the honest lane is `runtime shim + assert.js + sta.js
+ includes + body`. The prelude is ~75 % of the compile and the cost is
superlinear in assembly size; measured 2026-09-10 (in-process, warm,
`skipSemanticDiagnostics`):

| assembly | compile |
| --- | --- |
| body only (1.9 KB) | 58 ms |
| assert.js + sta.js (5.6 KB) | 215 ms |
| full, 7 KB | ~220 ms |
| full with propertyHelper.js, 26 KB | ~650 ms |

Compile is ~98 % of a test's wall time, so the prelude alone is ~70 % of the
whole test262 run (66 host + 36 standalone shards, ~13 min per host shard).
#3433 removed the quadratic rescans; #6463 removed the redundant strict rerun.
What remains is the linear cost of re-lowering the same 6–26 KB of harness for
each of ~44k tests.

The fast native-harness lane (#3461, `TEST262_ORACLE_MODE=fast`) shows the
ceiling: median `compile_ms` 92 ms vs 1,304 ms on the same slice. But it runs
the harness natively in the host, which flips verdicts (28 vs 9 failures on the
slice), so it cannot replace the honest oracle.

## Approach

Compile the harness prefix ONCE per worker into a Wasm module and link the
body module against it, keeping the harness in Wasm (honest) while paying its
compile once per `(includes, async)` key instead of once per test.

`assembleLinkedHarness()` (#3451) already splits the assembly at exactly this
boundary and `scripts/test262-linked-harness-inventory.ts` inventories the
harness ABI (every top-level binding the body can reach). What is missing is
the link itself:

1. **Prelude module**: compile `harnessPrefix` as a standalone unit that
   EXPORTS its top-level bindings (functions, `var`s as mutable globals or
   ref cells). Cache by `harnessParts` key per worker.
2. **Body module**: compile `bindingShim + body` with the harness bindings
   declared as IMPORTS, typed from the prelude's export signatures. The
   `bindingShim` (#3461, `buildBindingShim`) already enumerates the referenced
   names; instead of `var assert = globalThis.assert`, lower them to imports.
3. **Instantiate** the body against the prelude instance. A fresh prelude
   instance per test keeps realm hygiene (harness state such as
   `Test262Error` prototypes must not leak across tests); instantiation is
   cheap, compilation is not.
4. **Strict rerun** links the same prelude artifact (the harness is
   strict-neutral by construction, see #3451).

## Hard parts (call out in the plan before implementation)

- **Shared object identity across modules.** `Test262Error`, `assert`,
  `verifyProperty` are objects created in the prelude; the body must see the
  SAME instances, and `instanceof Test262Error` across the module boundary
  must hold. WasmGC struct types are nominal per rec-group; the runtime
  rec-group must be canonical across the two modules (the wasm-opt rec-group
  drift check in `src/compiler.ts` is the precedent).
- **Prelude-internal closures that capture body-provided values** (e.g.
  `assert.throws(fn)` calling into the body). Calls cross the module boundary
  in both directions; `funcref` typing and `this` binding must match the
  single-module lowering exactly.
- **Semantic providers / Temporal (#5248)** must be linked once, shared by
  prelude and body.
- **Honesty bar**: cache compilation work, never verdicts. Any per-test
  difference in harness lowering (e.g. type inference specialised by body
  usage, `inferModuleStrictArguments`) must be shown to be absent or made
  body-independent first — otherwise the linked lowering is a different
  compiler than the one the baseline measured.

## Acceptance criteria

- Full merge-group run: pass count unchanged vs baseline for host and
  standalone lanes (per-test diff, not count).
- Median `compile_ms` on the `Array.prototype.map` + `for-of` slice
  ≤ 300 ms at `COMPILER_POOL_SIZE=1` (from 914 ms after #6463).
- `TEST262_LINKED_HARNESS=0` (or equivalent) falls back to the single-module
  assembly for bisecting.
- The #3451 inventory test asserts the linked variant's byte-level split
  is unchanged.

## Expected gain

Prelude share ~70 % of run time → ≈ 3× faster shards, i.e. ~13 min → ~5 min
per host shard, or a third of the shard count at equal wall time.
