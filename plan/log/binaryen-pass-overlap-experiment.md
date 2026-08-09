# Do our low-level passes still earn their keep once `wasm-opt -O3` runs?

**Date:** 2026-08-01 · **Status:** complete — measured, no code change proposed

## Question

`src/optimize.ts` already runs Binaryen's `wasm-opt` over the encoded binary.
Four of our own passes do work that is squarely inside `wasm-opt -O3`'s
wheelhouse:

| Pass | File |
| --- | --- |
| constant folding | `src/ir/passes/constant-fold.ts` |
| dead-code elimination | `src/ir/passes/dead-code.ts` |
| CFG simplification | `src/ir/passes/simplify-cfg.ts` |
| peephole | `src/codegen/peephole.ts` (284 lines) |

If Binaryen subsumes them, they are maintenance cost with no output benefit.
This experiment measures each pass's **marginal contribution to the shipped
artifact** — i.e. the `-O3` output, not the pre-optimizer binary.

## Method

Per-pass kill switches were added at the two call sites
(`runHygienePasses` in `src/ir/integration.ts`; `peepholeOptimize` in
`src/codegen/index.ts`) and driven by env vars. Six arms: baseline, each pass
off individually, and all four off. **The kill switches are experiment
scaffolding and are NOT part of any commit.**

Three corpora:

- **A — breadth.** All 17 `.ts` files under `website/playground/examples/`
  (the `check:ir-fallbacks` corpus) plus `benchmarks/suites/`. Size + compile
  time, median of 5 compiles.
- **B — behaviour.** The 28 programs in `tests/cross-backend/corpus.ts`, which
  carry declared call/argument tuples. Each arm instantiates the **`-O3`**
  binary and records every call's return value, so arms are diffed on
  observable behaviour, not just byte counts. 24 of 28 instantiate in this
  harness (4 need `wasm:js-string` / `string_constants` host wiring the harness
  does not provide); the same 4 are excluded in every arm.
- **C — scale.** acorn 8.16.0 (231 KB of source → 621 KB raw Wasm), the largest
  real module the repo compiles, and the one the `benchmark:acorn` dogfood lane
  already uses.

## Results

### Corpus A — 17 files

| arm | raw bytes | Δraw | **-O3 bytes** | **Δ-O3** | Δ-O3 % | compile ms |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 144,755 | 0 | 98,605 | 0 | 0.000% | 7,513 |
| no-constfold | 145,134 | +379 | 98,605 | **0** | 0.000% | 7,985 |
| no-dce | 144,755 | **0** | 98,605 | **0** | 0.000% | 8,055 |
| no-simplifycfg | 144,755 | **0** | 98,605 | **0** | 0.000% | 7,821 |
| no-peephole | 147,313 | +2,558 | 98,613 | **+8** | 0.008% | 8,033 |
| all four off | 147,712 | +2,957 | 98,613 | **+8** | 0.008% | 7,922 |

### Corpus B — 28 executable programs

| arm | raw bytes | Δraw | **-O3 bytes** | **Δ-O3** | observable result diffs |
| --- | --- | --- | --- | --- | --- |
| baseline | 26,645 | 0 | 14,080 | 0 | — |
| no-constfold | 27,850 | +1,205 | 14,080 | **0** | **0** |
| no-dce | 26,645 | **0** | 14,080 | **0** | **0** |
| no-simplifycfg | 26,645 | **0** | 14,080 | **0** | **0** |
| no-peephole | 27,186 | +541 | 14,080 | **0** | **0** |
| all four off | 28,430 | +1,785 | 14,080 | **0** | **0** |

### Corpus C — acorn 8.16.0

| arm | raw bytes | Δraw | **-O3 bytes** | **Δ-O3** | Δ-O3 % | compile ms (median of 3) |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 620,951 | 0 | 343,881 | 0 | 0.000% | 21,438 |
| no-constfold | 620,953 | +2 | 343,881 | **0** | 0.000% | 21,065 |
| no-dce | 620,951 | **0** | 343,881 | **0** | 0.000% | 21,401 |
| no-simplifycfg | 620,951 | **0** | 343,881 | **0** | 0.000% | 22,416 |
| no-peephole | 637,635 | +16,684 | 343,935 | **+54** | 0.016% | 19,925 |
| all four off | 637,637 | +16,686 | 343,935 | **+54** | 0.016% | 20,054 |

On the largest real module in the repo, the entire contribution of all four
passes to the shipped artifact is **54 bytes out of 343,881** — and every one
of those 54 bytes comes from `peephole`. The three IR passes together move the
`-O3` output by **zero bytes** and the pre-optimizer binary by **2 bytes**.

### Did each pass do anything at all, pre-`wasm-opt`?

Instrumented `runHygienePasses` to count how many `IrFunction`s each pass
actually **changed** (reference inequality), so "no size delta" can be told
apart from "never ran".

| corpus | IR fns through hygiene | constant-fold changed | dead-code changed | simplify-cfg changed |
| --- | --- | --- | --- | --- |
| examples + bench suites | 57 | 9 | 13 | **0** |
| acorn 8.16.0 | **25** | 1 | 2 | **0** |

**This is the most important number in the experiment, and it cuts against a
deletion.** Only **25** IR functions pass through hygiene for the whole of
acorn — 621 KB of raw Wasm. The rest of the module is still compiled by the
legacy direct AST→Wasm front-end, which these passes never see. So the
measurement above is "what the passes are worth **at today's IR coverage**",
not "what they are worth". As `ir-full-coverage` (#2855/#3518) advances, these
passes will see a much larger share of the program and the answer can change.

Two secondary readings:

- `simplify-cfg` changed **0 functions on both corpora**. It is not
  "redundant with Binaryen" — on this evidence it never fires at all. That is a
  different (and more actionable) finding than redundancy.
- `dead-code` **did** change 13 functions on corpus A and 2 on acorn, yet the
  raw binary was byte-identical in both. Its edits are absorbed downstream
  before encoding, independently of `wasm-opt`.

## Reading

1. **`wasm-opt -O3` absorbs essentially all of it.** Turning off all four passes
   grows the pre-optimizer binary by 2.0% (corpus A) / 6.7% (corpus B) and moves
   the shipped `-O3` artifact by **8 bytes out of 98,605** (corpus A), **0
   bytes** (corpus B) and **54 bytes out of 343,881** (corpus C, acorn) — all
   54 of which come from `peephole`; the three IR passes move acorn's `-O3`
   output by zero bytes.
2. **…but the passes barely run.** Only 25 IR functions in all of acorn reach
   the hygiene pipeline. A pass cannot demonstrate value on code it never
   sees, so this is weak evidence for redundancy and strong evidence that the
   experiment must be repeated after IR adoption advances.
3. **No behaviour changed.** 24 executable programs × every declared call,
   zero diffs in any arm. Independently confirmed by the equivalence gate:
   with all four passes disabled, `SHARD=1/8 node scripts/equivalence-gate.mjs`
   reported `5 failing, 178 passing, 36 known-failures in baseline` and
   `✓ No new equivalence regressions` — every failure already in the committed
   baseline, none introduced by disabling the passes.
4. **Compile time is not a reason to keep or drop them.** The spread across arms
   (7,513–8,055 ms) is smaller than run-to-run variance and is not ordered by
   how much work was disabled — the slowest arm (`no-dce`) disables a pass that
   provably does nothing.

## What this does NOT establish

- **Runtime performance was not measured** — only size and observable results.
  A pass could in principle produce faster code at the same size; nothing here
  rules that out.
- **These passes may be load-bearing for something other than output.** IR
  verification, later-pass preconditions, or compile-time blowup on pathological
  input are all plausible; none were tested.
- **`--optimize` is opt-in.** `optimizeBinaryAsync` no-ops when neither the
  `binaryen` package nor a system `wasm-opt` is present, and the CLI only runs
  it under `--optimize`/`-O`. Every number above assumes the optimizer runs;
  in an unoptimized build these passes are worth 2–7% of binary size.

## Recommendation

**Split the verdict by pass — they are not one decision.**

- `peephole` is the only one of the four with a measurable output effect, and
  it is tiny but real and consistent: +8 bytes on corpus A, +54 on acorn, 0 on
  corpus B. It also does the most pre-optimizer work of the four (+2.7% raw on
  acorn). It is not a deletion candidate on this evidence.
- The three IR passes (`constant-fold`, `dead-code`, `simplify-cfg`) contribute
  **zero bytes** to the shipped artifact on every corpus measured. But see the
  coverage caveat below before reading that as redundancy.

**Do not delete these passes on this evidence.** The original hypothesis
("Binaryen subsumes them, so they are pure maintenance cost") is not what the
data shows. What the data shows is that the passes are *nearly unexercised*,
which is a coverage finding, not a redundancy finding — and deleting code
because it is currently unreachable is how you discover why it existed.

Scoped follow-ups, in priority order:

1. **`simplify-cfg` fired zero times on both corpora.** Find out whether it is
   dead code, gated off, or simply never applicable to the shapes IR currently
   claims. This is the one cheap, decisive question here.
2. **Re-run this experiment after `ir-full-coverage` advances.** The 25-of-acorn
   figure is the gate: when the IR front-end claims most of a module, the
   measurement becomes meaningful. Until then it cannot settle the question.
3. **Add a runtime arm.** Only size and observable results were measured; a pass
   could produce faster code at identical size.
4. **Check for downstream preconditions** (verifier, later IR passes, backend
   legality) before any deletion is contemplated.
5. **Settle the unoptimized-build policy.** `--optimize` is opt-in; without it
   these passes are worth 2–7% of binary size outright.

The passes that are **not** candidates for deletion, and were not tested here:
`monomorphize.ts`, `tagged-unions.ts`, `alloc-discipline.ts`, and everything in
`src/ir/analysis/` (`escape`, `ownership`, `stack-alloc`, `string-evidence`,
`encoding`). Those depend on JS-level facts that are destroyed by lowering, so
Binaryen structurally cannot do them.

## Reproducing

The harnesses were scratch files under `.tmp/` and did not survive the session
(the equivalence gate clears that directory). They are not recoverable, so
reproduction means rebuilding them from this description — which is why the
method is spelled out concretely above rather than by reference:

1. Add env-gated early-outs at `runHygienePasses` (`src/ir/integration.ts`) for
   the three IR passes and at both `peepholeOptimize(mod)` call sites
   (`src/codegen/index.ts`). Six arms: baseline, each pass off, all four off.
2. For each corpus, `compile()` each source, then `optimizeBinaryAsync(binary,
   { level: 3 })`, and record `binary.byteLength` before and after.
   acorn needs `{ fileName: "acorn.mjs", skipSemanticDiagnostics: true }` and
   `setupAcorn()` from `tests/dogfood/setup-acorn.mjs`.
3. For corpus B, instantiate the **-O3** binary and invoke each program's
   declared `calls` from `tests/cross-backend/corpus.ts`, diffing return values
   across arms.
4. For the effectiveness counts, instrument `runHygienePasses` to count
   reference-inequality per pass per `IrFunction`.
5. For correctness, run `scripts/equivalence-gate.mjs` with all four disabled.
