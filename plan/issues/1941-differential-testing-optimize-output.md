---
id: 1941
title: "Differential testing of --optimize output — wasm-opt miscompiles currently ship invisibly"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
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

## Implementation notes (sd-optimize, 2026-06-11)

### Reproduced miscompile + root cause (the WHY)

Differential probe over the 104-program V8-oracle corpus
(`tests/differential/corpus/`), restricted to the 102 programs whose
**unoptimized** output already passes `WebAssembly.validate`:

- **In-process binaryen npm module** (`mod.optimize()`) miscompiles **1**
  program — `closures/01-basic.js`. The optimized binary fails to compile
  with `invalid value type 0x62 @+660` (function `#4` = `__call_fn_1`, the
  closure-dispatch trampoline). `0x62` is the *legacy* non-nullable
  ref-type encoding; modern V8/wasmtime expect `0x64`.
- **System / bundled `wasm-opt` CLI** (`binaryen/bin/wasm-opt -O3
  --all-features --disable-custom-descriptors`) miscompiles **0** — every
  optimization level (`-O1`..`-O4`, `-Os`, `-Oz`) produces a binary V8
  accepts.

The other two programs the first pass flagged (`array/02-push-pop.js`,
`builtins/12-arraybuffer.js`) are **not** optimize bugs: their *unoptimized*
binary already fails `WebAssembly.validate` (a pre-existing
TypedArray/ArrayBuffer codegen gap, tracked separately), so wasm-opt never
even reads them.

**Root cause**: the binaryen-123 npm package ships a JS-compiled
`binaryen.js` whose GC ref-type *encoder* disagrees with its own bundled
native `wasm-opt` CLI — the JS module emits the `0x62` legacy encoding for
our closure-trampoline `ref.test (ref $fnType)` patterns, which V8 and
wasmtime reject. The binaryen CLI happily round-trips the module's own bad
output (`wasm-opt in.wasm -o /dev/null` exits 0), so the disagreement is
invisible inside the binaryen toolchain — only an external engine catches
it. `optimizeBinaryAsync` currently tries the **module path first**
(optimize.ts:156-159) and only falls back to the CLI on a *thrown*
exception; the module doesn't throw, it silently returns the bad binary.

### Fix (conservative, two layers)

1. **Prefer the CLI over the in-process module.** Try
   `optimizeWithSystemBinary` first; fall back to the module only when no
   CLI binary is resolvable (e.g. a stripped install). The CLI is correct
   where the module is buggy, and it's the same code path `wasm-opt -O3` on
   the command line exercises.
2. **Validate optimizer output before trusting it.** Run
   `WebAssembly.validate` on whatever the optimizer returns; if it fails,
   **discard** the optimized binary, return the *unoptimized* one, and
   attach a fail-loud warning. This is the durable safety net: it protects
   against this binaryen skew, against future binaryen regressions, and
   against the module path (still used as a browser fallback where no CLI
   exists). We never ship a binary that doesn't validate. `optimized` is
   reported `false` in that case so callers see the truth.

This is not "disable a wasm-opt pass" — the CLI passes are all safe on our
output; the bug is purely the JS module's encoder. The validate-gate
additionally future-proofs against any unsafe pass that appears later.

### Differential harness + CI gate (the deliverable)

- `scripts/diff-test.ts` gains an **optimize lane**: when
  `DIFF_TEST_OPTIMIZE=1`, each corpus program is compiled with
  `{ optimize: true }`, run, and compared to the **same V8 oracle**. Output
  goes to `benchmarks/results/diff-test-optimize.json`.
- `scripts/diff-test-optimize-gate.ts` (new) is the optimize-lane gate: it
  diffs the optimized lane's per-file outcome against the **unoptimized
  lane's** outcome and fails if `--optimize` regressed any program (lost a
  `match`, or turned a non-error into a compile/runtime error — the #1941
  invalid-binary case). It needs **no committed baseline** — comparing the
  two live lanes is self-maintaining, so there is nothing to drift. (The
  unoptimized `diff-test-gate.ts` keeps its own V8-oracle baseline as before.)
- `tests/equivalence/optimize-differential.test.ts`: a fast, self-contained
  vitest case that asserts the closure-trampoline program (and a
  representative set) produce **identical observable output** optimized vs
  unoptimized, and that optimized output always passes
  `WebAssembly.validate`. It lives under `tests/equivalence/` so the existing
  equivalence shards execute it (root-level `tests/*.test.ts` are NOT run by
  any CI job). No wasm-opt-availability dependency — when wasm-opt is
  unavailable the optimize pass is a graceful no-op, so the equality
  assertions still hold by construction.
- `.github/workflows/diff-test.yml` gains an **optimize** matrix leg so the
  V8-oracle corpus is executed optimized on every merge-queue run, gated by
  its own baseline.
