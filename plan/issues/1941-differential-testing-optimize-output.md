---
id: 1941
title: "Differential testing of --optimize output — wasm-opt miscompiles currently ship invisibly"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: compiler-internals
goal: correctness
---
# #1941 — Differential testing of --optimize output

## Problem

Three independent reviewers in the 2026-06 quality review converged on this
as the single largest untested correctness surface: **optimized output is
never executed by any gate.**

- The equivalence harness compiles with defaults only
  (`tests/equivalence/helpers.ts:234` — no optimize flag).
- The only optimize coverage is `tests/wasm-opt-optimize.test.ts` — 6 tests
  that check compilation *succeeds* (magic bytes, `WebAssembly.validate`),
  never that optimized output **behaves identically**.
- The differential corpus lane (`scripts/diff-test.ts`) also uses default
  compile options.
- js2wasm emits unusual WasmGC patterns (externref laundering, guarded
  casts, rec-groups) — exactly the territory where wasm-opt GC passes have
  historically had bugs. The `--disable-custom-descriptors` workaround in
  `optimize.ts:393-400` proves the team is already living on this edge. A
  wasm-opt-induced miscompile today is discovered only by user bug reports.

## Proposed approach

1. Add `JS2WASM_EQUIV_OPTIMIZE=1` to `compileToWasm` in
   `tests/equivalence/helpers.ts` (pass `{ optimize: true }`).
2. Run **one of the 8 equivalence CI shards** in optimize mode (cheapest
   slot: extend the ci.yml matrix with a 9th entry `shard: 1, optimize: 1`),
   gated against its own known-failure baseline.
3. Add an optimize lane to `scripts/diff-test.ts` (the V8-oracle corpus —
   104 programs, fast) and gate deltas like the existing lane.
4. Optionally: one test262 chunk with `optimize: true` weekly
   (workflow_dispatch first to size the cost).
5. Any failures found are *real shipped bugs* — file individually.

## Acceptance criteria

- CI executes optimized binaries and compares behavior against the JS
  oracle on every PR (at least the equivalence shard + diff-test lane).
- Baseline file for optimize-mode known failures, ratcheted.

## Source

Compiler quality review 2026-06 (testing, optimization, and linear/emit
reviews all flagged it). Related: #1855 (fuzzer would also run this lane),
optimize.ts custom-descriptors note.
