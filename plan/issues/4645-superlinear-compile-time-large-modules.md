---
id: 4645
title: "Compile time goes superlinear past ~100 KB — 157 KB module does not terminate in 45 min"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-28
completed: 2026-08-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, performance
goal: dogfood
related: [4628, 4644]
# (#4645) The finalize passes are named IN PLACE — a phase marker only means
# anything at the call site whose time it attributes, and acceptance criterion 3
# is precisely "the profiler can attribute the post-module-init window". The
# instruction-counting helper it needs was moved OUT to
# src/codegen/module-scale-profile.ts; what remains in index.ts is +18 lines of
# `profilePhase("finalize/…", () => …)` wrappers around existing calls.
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4645 — Compile time goes superlinear past ~100 KB

## Problem

Compiling a single large module stops terminating. Measured on the linked
`@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle during the #4628 spike, on
prefixes cut at top-level statement boundaries (every prefix compiles with
**zero** errors — this is purely a time curve, not a correctness cliff):

| Input size | Compile time |
| --- | --- |
| 39 KB | 9.1 s |
| 49 KB | 8.4 s |
| 60 KB | 10.1 s |
| 69 KB | 11.7 s |
| 83 KB | 18.2 s |
| 106 KB | 52.6 s |
| ~138 KB | **killed at 38 min** |
| 157 KB | **killed at 45 min** |

The same 342 top-level statements, compiled as 14 separate slices, sum to
**~24 s**. So the work itself is cheap; something is superlinear in
whole-module size.

## Where the time goes

`JS2WASM_COMPILE_PROFILE=stream` on the 157 KB run:

- `module-init-pass1` — 3.50 s
- `module-init-pass2` — 1.77 s
- heap ~297 MB at that point
- then **no phase marker closes for the remaining ~44 minutes**
- steady 100 % of one core, RSS flat at ~600 MB

Flat RSS with pinned CPU rules out a memory blowup or GC thrash — it is
CPU-bound in per-function codegen, after module-init. The profiler's markers
are too coarse past module-init to narrow it further, which is itself worth
fixing: **the profile cannot currently attribute 98 % of a pathological
compile.**

## Suggested approach

1. **Get attribution first.** Add per-function (or at least per-phase) markers
   to the post-module-init codegen path in `src/compile-profile.ts` so the
   44-minute window resolves into something. Without this, any fix is guessed.
   A cheaper interim: attach a sampling profiler (`node --cpu-prof`) to the
   106 KB case — 52.6 s is long enough to sample and short enough to finish.
2. **Suspect anything keyed by a whole-module collection** that is rescanned
   per function — a linear scan inside a per-function loop is the classic
   shape for "fine in slices, quadratic whole". The slice-vs-whole gap
   (~24 s vs ≥45 min for identical statements) points hard at cross-function
   state rather than at any single function's complexity.
3. **Set a regression floor** once fixed, so this cannot silently return.

## Why this matters

- **Blocks Option A in #4628** — compiling `@js-temporal/polyfill` as the
  runtime `Temporal` implementation requires compiling the whole bundle, which
  currently does not finish.
- **Blocks dogfooding generally.** 157 KB is not a large JavaScript module by
  modern standards. The `tests/dogfood/` catalog compiles real npm packages,
  and the UMD lane of the polyfill (242 KB) was not even attempted because it
  is further past the cliff.
- Per `tests/dogfood/README.md`, a compile timeout is an unverified workload,
  never a pass — so this converts silently into missing coverage rather than
  into a visible failure.

## Reproduce

```bash
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

Harness from #4628 / PR #4789. It compiles both whole-bundle and sliced lanes;
the whole-bundle lane is the one that hangs. Prefix cutting at statement
boundaries is how the curve above was produced — reuse it to bisect the cliff.

## Acceptance criteria

1. The 157 KB linked bundle compiles to completion, with the time recorded.
2. The scaling curve above is re-measured and is no longer superlinear — state
   the new numbers against the old ones.
3. Whatever the root cause, the profiler can attribute it: a repeat of this
   investigation should not start with "no phase closes for 44 minutes".
4. A guard so the cliff cannot silently return.

## Notes

Do not treat "it finished in 40 minutes instead of 45" as fixed. The target is
the shape of the curve, not one data point — the sliced ~24 s is the evidence
that near-linear is achievable.

---

## Resolution (2026-08-28)

### Root cause — an exponential, not a quadratic

The guess in "Suggested approach" (a whole-module collection rescanned per
function) was **wrong**, and measuring is what showed it. Naming the finalize
passes and re-running the ladder gave this, for a 2.8x source increase
(39 KB → 109 KB):

| finalize phase | 39 KB | 109 KB | ratio |
| --- | --- | --- | --- |
| `stack-balance` | 0.34 s | 27.82 s | 82x |
| `ir-inline` | 0.17 s | 15.22 s | 91x |
| `cross-hierarchy-operands` | 0.16 s | 10.19 s | 65x |
| `repair-struct-types` | 0.02 s | 7.69 s | 328x |

Every whole-module pass grew 50–300x. No pass is 300x more quadratic than
another — they were all linear passes over a module that had itself exploded.
The `scale` checkpoint proves it:

| input | funcs | unique instrs | instrs VISITED | amplification |
| --- | --- | --- | --- | --- |
| 83 KB | 751 | 132,401 | 140,699 | 1.06x |
| 109 KB | 1,299 | 215,907 | 9,731,399 | **45x** |

The instruction graph is a **DAG**, not a tree. Each `__get_member_*` /
`__set_member_*` / `__sget_*` dispatcher is a chain of arms, and for a
collision-stamped struct (#2009/#2853) five independent builders wrote the arm
as two nested `if`s that **both named the same "rest of the chain" array
object**:

```
local.get $any; ref.test $T
if                             ;; type matched
  <shape stamp == K?>
  if  then <hit>  else <next>  ;; ← next
else <next>                    ;; ← next AGAIN, same array object
```

So the chain's tail gets two parents and the root-to-node path count **doubles
per stamped arm** — 2^k, not k^2. Nothing dedupes: every whole-module walk
re-traverses the shared tail once per path, **and so does the binary encoder**,
which is why this was never only a speed bug. `__set_member_year` in the
polyfill: 266 distinct instructions, 1,315,939 visits (4,947x ≈ 2^12).

The cliff's suddenness is now explained too. It is not a threshold in module
size; it is the point where enough colliding shapes carry the same property name
for `k` to get large. Below that, amplification is ~1.

### Fix

`src/codegen/shape-guarded-arm.ts` — one `buildShapeGuardedArm` helper computing
the guard as an i32 and branching on it **once**, so `next` has exactly one
parent and the chain is a list again. Applied at all five sites:
`member-get-dispatch.ts` (x2), `member-set-dispatch.ts`, `member-set-f64.ts`,
`struct-field-exports.ts::buildNestedIfElse`.

Behaviourally identical: same tests, same order, same short-circuiting. In
particular the `ref.cast` still runs only on the `ref.test`-true path. Folding
the two conditions with `i32.and` would be shorter and **wrong** — both operands
evaluate eagerly, so the cast would run on a receiver that failed `ref.test`.
(`__sset_*` in `struct-field-exports.ts` does use the `i32.and` form and is
therefore worth a look independently; it is not touched here.)

### Result — the curve, re-measured

Same machine, same fixture, before vs after. Emitted binary size in brackets.

| input | before | after |
| --- | --- | --- |
| 39 KB | 7.2 s [249 KB] | 7.4 s [249 KB] |
| 60 KB | 9.5 s [326 KB] | 9.5 s [322 KB] |
| 83 KB | 17.5 s [447 KB] | 19.6 s [422 KB] |
| 109 KB | 109.4 s [**29.4 MB**] | 32.3 s [733 KB] |
| 142 KB | (not reached) | 38.5 s [1.07 MB] |
| **157 KB (full bundle)** | **killed at 45 min** | **44.4 s [1.14 MB]** |

Acceptance criterion 1 and 2 met: the full linked bundle compiles, and the curve
is ~4x time for ~4x input across the whole range instead of falling off a cliff.
At 109 KB the emitted binary is **40x smaller**.

Not claimed: the remaining curve is not perfectly linear (83→109 KB is 1.31x
input for 1.65x time). That is ordinary superlinearity in the passes, orders of
magnitude away from the reported cliff, and was not chased.

### Profiler (criterion 3)

- Every whole-module finalize pass is now a named phase
  (`finalize/dead-layout`, `finalize/repair-struct-types`, `finalize/peephole`,
  `finalize/ir-inline`, `finalize/cross-hierarchy-operands`,
  `finalize/stack-balance`, `finalize/extern-convert-any`), plus `bodies` and
  `struct-field-accessors`, in BOTH the single- and multi-source pipelines. The
  44-minute window with no marker is gone.
- New `profileModuleScale` (`src/compile-profile.ts`) +
  `reportModuleScale` (`src/codegen/module-scale-profile.ts`) emit
  `scale <checkpoint> funcs=… imports=… types=… globals=… instrs=… uniqueInstrs=…`.
  The `instrs` vs `uniqueInstrs` gap is the specific instrument that separates
  "this pass is quadratic" from "the module blew up", which is the distinction
  the original investigation could not make.

### Guard (criterion 4)

`tests/issue-4645-dispatch-chain-size.test.ts`, running by default (an opt-in
env-gated test would guard nothing). Three assertions:

1. A synthetic fixture of `n` structurally-identical, differently-named object
   literals sharing one dynamically-accessed property. Doubling `n` from 4 to 8
   must not more than triple the emitted binary. Fixed: 6,839 → 10,444 = 1.53x.
   Broken: 9,716 → 52,974 = 5.45x — **verified to fail on the pre-fix tree**.
   `n=4→8` is deliberately the smallest separating fixture: at `n=16` the broken
   build emits 11.5 MB and OOMs the vitest worker, a worse failure mode than a
   clean assertion. Binary size is used rather than wall-clock for the same
   reason `scripts/check-harness-compile-budget.ts` uses a deterministic proxy.
2. A unit assertion that `buildShapeGuardedArm` references `next` exactly once.
3. A unit assertion that the `ref.cast` sits inside the guard's `then` arm, so a
   future "simplify it with `i32.and`" cannot silently reintroduce the trap.

### Validation

- All **8 equivalence shards** pass `scripts/equivalence-gate.mjs` with no new
  regressions.
- `typecheck`, `lint`, `check:coercion-sites`, `check:oracle-ratchet`,
  `check:dead-exports` clean.
- **No test262 delta is claimed** — not measured locally; CI owns it.
- The polyfill binary still fails `WebAssembly.compile` at every prefix, with
  **byte-for-byte the same first error before and after** (`__call_toString`
  "not enough arguments on the stack" ≤83 KB — that is #4644, owned by another
  lane; `JSBI_BigInt` "immutable global cannot be assigned" ≥109 KB, unowned).
  Both are pre-existing and out of scope here; this issue is the time/size
  curve. #4628's compile lane is unblocked, its validate lane is not.
