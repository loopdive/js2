---
id: 6759
title: "perf(codegen): the post-codegen repair passes walk every function body and cost ~31 % of a standalone test262 compile"
status: done
completed: 2026-09-29
sprint: current
priority: high
horizon: m
goal: maintainability
reasoning_effort: max
assignee: ttraenkler/opus-standalone-repair-passes
requested_by: ttraenkler/opus-lead
created: 2026-09-29
related: [6480, 6722, 6723, 2710]
# 2026-09-29 (#6759): stack-balance.ts grows by the opcode-delta cache, the
# lazily compared branch contexts and the per-function tree flag (+58 lines);
# ir-inline.ts by the fused call-graph/hotness helper, the fused callee-facts
# walk and the specialisation-size memo (1500 -> ~1572). Both are pass-local
# fast paths whose invariants live next to the code they skip.
# index.ts (+17): both finalize pipelines compute one sharing analysis for
# repair-struct + peephole and one for cross-hierarchy + stack-balance +
# extern.convert_any, and pass it down (generateModule +9 / generateMultiModule
# +7 for the same lines).
loc-budget-allow:
  - src/codegen/stack-balance.ts
  - src/codegen/ir-inline.ts
  - src/codegen/index.ts
# 2026-09-29 (#6759): computeInstrDelta is the former instrDelta ladder
# (318 lines on main, unchanged in length) renamed behind a cached wrapper.
func-budget-allow:
  - src/codegen/stack-balance.ts::computeInstrDelta
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

## Problem

Standalone test262 compiles are the long pole of every merge group (#6722):
median 2.25 s per row, 38.8 core-hours per full corpus. The linked-harness route
to cut that (#6723) failed its P2 gate (10,401 pass→fail, ≤1.4× at best), so the
remaining lever is the standalone compile itself.

## Measurement (2026-09-29)

`node --cpu-prof --import tsx` over 40 warm in-process standalone compiles of a
seeded random sample of passing non-Temporal rows (`random.seed(7)` over the
promoted standalone baseline; honest whole-assembly source via
`assembleOriginalHarness(...).primary`), `target: "standalone"`. 64.0 s for 40
compiles (1.6 s each). Main-thread profile, inclusive time:

| function | share |
|---|---:|
| `generateModule` (all codegen) | 81.9 % |
| `stackBalance` (`src/codegen/stack-balance.ts`) | 9.3 % |
| `inlineUserFunctions` (`src/codegen/ir-inline.ts`) | 8.8 % |
| `fixupExternConvertAny` (`src/codegen/fixups.ts`) | 6.6 % |
| `repairCrossHierarchyOperands` (`src/codegen/cross-hierarchy-operands.ts`) | 6.6 % |
| garbage collector (self) | 8.1 % |

Self time by file: stack-balance 9.5 %, ir-inline 8.7 %, fixups 8.1 %,
call-arg-producers 4.4 %, cross-hierarchy-operands 3.7 %, instruction-walk 2.6 %.

The four passes are whole-module: each re-walks every function body after
codegen, including the large standalone runtime helpers the module links in,
which are the same on every compile.

## Implementation Plan

Goal: cut the cost of these passes on standalone compiles with **byte-identical
output**. No verdict may change, so no test262 re-baseline is needed.

1. Instrument first: per pass, how many bodies are walked, how many are actually
   changed, and how much of the walked instruction count belongs to runtime /
   helper bodies versus user bodies. That decides the lever.
2. Candidate levers, in order of expected payoff:
   - **Skip bodies that cannot need repair**: a body emitted by a helper
     generator that is already stack-balanced and typed can be marked clean at
     emission, and each pass skips clean bodies. The bit must be conservative:
     any later mutation of a body clears it.
   - **Fuse traversals**: passes that each walk every instruction array
     (`walkInstructionArrays`, `forEachInstr`, `crossFunctionBodies`) can share
     one traversal where their order constraints allow. Document every ordering
     constraint before fusing.
   - **Cut allocation**: `cloneInstr` and per-walk arrays drive the 8 % GC.
3. Keep each lever as its own commit with its own measurement.

## Acceptance

- Output byte-identical: sha256 of every `.wasm` equal before and after on a
  ≥ 200-row standalone sample, a ≥ 200-row host sample, and
  `node scripts/equivalence-gate.mjs` with no new regressions.
- Standalone compile time on the same 40-row sample reduced by ≥ 20 %, measured
  with three interleaved rounds per variant (noise is ±10 %).
- Full CLAUDE.md gate chain green.

## Implementation (2026-09-29)

Every number below comes from a run made on this branch on 2026-09-29, on the
40-row sample and the harness copied from the measurement above
(`.tmp/prof/prof.mts`, `.tmp/prof/files.txt`). The base is `origin/main` at
`6a7997c7cb`, swapped in by file copy.

### Instrumentation: what the passes walk and what they change

A temporary hook around each pass (not committed) serialized every function
body before and after the pass. "User" means a function whose name does not
start with `__`, or starts with `__closure_`/`__fn_`/`__method_`. That includes
the test262 harness, which is compiled source. Of the 40 rows, 36 reach the
passes; the table gives means per compile.

| pass | bodies walked | bodies changed | user bodies walked / changed | instructions walked | user share of instructions |
|---|---:|---:|---:|---:|---:|
| `inlineUserFunctions` | 789 | 167.1 | 103 / 10.1 | 193,269 | 29.1 % |
| `repairCrossHierarchyOperands` | 789 | 8.2 | 103 / 4.4 | 193,283 | 29.1 % |
| `stackBalance` | 789 | 71.7 | 103 / 12.5 | 194,260 | 29.0 % |
| `fixupExternConvertAny` | 789 | 0.0 | 103 / 0.0 | 194,260 | 29.0 % |

What this means for the levers:

- **Runtime helper bodies are 71 % of what is walked, but three of the four
  passes change some of them on every compile.** Stack-balance changes about 59
  runtime bodies per compile and the inliner about 157, so a "skip clean runtime
  bodies" bit has no clean population to skip. Only `fixupExternConvertAny`
  never changed anything; it got the "skip what provably cannot fire" lever.
- **The cost is per array and per instruction.** A module has about 30,000
  nested instruction lists, roughly 7 instructions each. Profiling a
  non-minified bundle of the harness pointed at four costs:
  - megamorphic probes of `body`/`then`/`else`/`catches`/`catchAll` on
    hundreds of instruction shapes;
  - weak-collection traffic, several `WeakSet`/`WeakMap` operations per list
    per walk;
  - an array and a closure allocated per instruction;
  - opcode comparison and regex ladders run once per instruction.
- **No module in the sample is a tree.** Each has 13–86 instruction lists with
  more than one parent (shared throw arms and similar), so a module-wide
  "tree" shortcut never fires. The shipped shortcut records only the lists
  with more than one parent.

### Levers (one commit each)

| commit | lever |
|---|---|
| `63e40d5a86` | L1: `fixupExternConvertAny` skips its forward stack model and per-call walk on lists with no `ref.null.extern`. `instrPopsPushes` caches opcode-only effects. One non-allocating `crossFunctionInstrArrays`. |
| `58682cbcad` | L2: the repair walks probe child-list fields only on the five structured opcodes. A shared sharing analysis gives them their visited-set. The forward model tests operand-dependent opcodes first and reports only the consumers its caller reads. One scan gates the `extern.convert_any` rewrites. |
| `6f745b71a1` | L3: stack-balance caches opcode-only deltas. Its preflight keeps one owner table plus one per-function visit table and compares block contexts structurally (serializing only on a real revisit). Functions with no revisited list run the five repair walks without a visited-set. The `struct.new` simulation skips lists with no `struct.new`. |
| `d902f0f535` | L4: ir-inline runs one walk per function for both the call graph and the hotness, one walk per callee for all five callee facts, and memoizes the constant-specialisation size per (callee, constants), cloning only when kept. It skips call-free callers and never-called snapshots. |
| `29edc4a15e` | L5: one sharing analysis serves repair-struct and peephole, and one serves cross-hierarchy, stack-balance and extern.convert_any. Each lists the multi-parent arrays, so visited-sets and the stack-balance preflight do bookkeeping only for those. |

Ordering constraints I checked before sharing one analysis across passes:

- Repair-struct and peephole run back to back and only replace, insert or
  remove leaf instructions.
- Cross-hierarchy, stack-balance and extern.convert_any are separated only by
  telemetry. Their edits are:
  - cross-hierarchy and extern.convert_any: leaf insertions and replacements;
  - stack-balance: leaf insertions and replacements, dead-code removal, and
    fresh `else: []` arms.
- None of these creates a list with a second parent or a second owner.
- Stack-balance can drop a cross-function reference as dead code. So
  extern.convert_any reuses the analysis only when the cross-function set is
  empty; otherwise it recomputes it.
- A walk visits nested lists before it edits its own list, so lists inserted
  during a pass are never walked by that pass.

Per-lever phase times: `JS2WASM_COMPILE_PROFILE=1`, 2 interleaved rounds,
seconds summed over the 40-row sample, mean of the 2 rounds, including the
profiler's own overhead (`.tmp/phab.sh`).

| state | wall | ir-inline | cross-hier. | stack-balance | extern-conv. | peephole | repair-struct |
|---|---:|---:|---:|---:|---:|---:|---:|
| base | 89.2 | 8.98 | 6.64 | 8.23 | 6.76 | 2.69 | 2.16 |
| + L1 | 80.2 | 8.62 | 5.43 | 7.74 | 2.67 | 2.67 | 1.64 |
| + L2 | 76.6 | 8.83 | 3.53 | 7.80 | 1.84 | 2.64 | 1.38 |
| + L3 | 75.0 | 8.81 | 3.61 | 5.49 | 1.90 | 2.68 | 1.35 |
| + L4 | 70.5 | 5.46 | 3.40 | 5.35 | 1.90 | 2.52 | 1.28 |

### Acceptance timing (no profiler, 3 interleaved rounds, `.tmp/ab.sh`)

The box was shared with other agents during these runs. Absolute times drift
by up to 30 % between sets, so compare the rows within a set only.

| set | base (s) | new (s) | change |
|---|---|---|---:|
| standalone, final state (L1–L5) | 60.77 / 58.75 / 58.93 | 46.87 / 45.86 / 46.29 | **−22.1 %** |
| standalone, L1–L5 before the multi-parent refinement | 74.53 / 72.52 / 69.65 | 60.02 / 58.93 / 54.56 | −19.9 % |
| standalone, L1–L4, set A | 81.40 / 76.48 / 76.55 | 65.38 / 65.22 / 67.19 | −15.6 % |
| standalone, L1–L4, set B | 75.75 / 79.29 / 77.77 | 63.46 / 60.32 / 62.47 | −20.0 % |
| host lane, final state | 19.95 / 19.73 / 19.86 | 18.64 / 19.18 / 19.63 | −3.5 % |
| host lane, L1–L4 | 26.23 / 25.41 / 25.13 | 23.28 / 22.87 / 23.10 | −9.9 % |

The host lane gains little because it compiles far fewer runtime helpers.

### Byte identity

`.tmp/hash.mts` hashes the `.wasm` of 240 standalone rows and 240 host rows.
The rows are a seeded sample of the two promoted baselines in
`/home/user/js2/.test262-cache/`, frozen as file lists in
`.tmp/h/list-{standalone,host}.txt`. Of those rows, 207 standalone and 214 host
rows produce a binary.

- Every lever state (L1, L1–L2, L1–L3, L1–L4, final) matches base on every
  binary. The standalone rows match `.tmp/h/base-standalone.txt`, captured
  before the first edit. The host rows match `.tmp/h/base2-host.txt`.
- Why base2: the first host capture (`base-host.txt`) differs from a second run
  of the *unchanged* base in 3 rows. Those rows are async/Atomics tests, and the
  difference comes from the order they compile in within one process. Freezing
  the file list changed that order, so host comparisons use a base captured with
  the same order (`base2-host.txt`). That base reproduces exactly across all
  five states.
- This order dependence is a pre-existing nondeterminism in the host lane, not
  something this change introduced.

### Tests and gates

- `node scripts/equivalence-gate.mjs` on the final state: 1720 passing, 22
  failing, all 22 in the known-failures baseline, so no new regressions.
- Green on the final state:
  - `check-loc-budget` and `check-func-budget`, each against the merge-base and
    with `LOC_GATE_BASE=origin/main`; the growth grants are in this file's
    frontmatter;
  - `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`;
  - `typecheck`;
  - `check:stack-balance`, with no fixup-bucket increases;
  - `check:host-import-policy`;
  - `check-compiler-boundaries --mode inventory`, with no new source modules.
- `tests/issue-6759-repair-pass-caches.test.ts` (13 tests) pins each invariant
  a shortcut relies on:
  - operand-dependent opcodes are never served from a cache (stack deltas and
    the forward model);
  - the call-only view of the forward model stops where the full model stops;
  - the sharing analysis and the multi-parent visited-sets are exact;
  - stack-balance with a supplied sharing analysis repairs exactly as without
    it;
  - block contexts compared lazily still block a real conflict;
  - the extern fixup still fires on each seed alone;
  - the walker's pre-order is unchanged;
  - memoized specialisation is keyed per constant vector.

  Removing `call` from the operand-dependent set makes the first test fail.
- `tests/issue-2934-packed-forof-valtype.test.ts` is memory-sensitive. On
  `main` it passes at the local default 512 MB fork heap with little margin:
  - base fails at 500 MB and passes at 505 MB;
  - after its first test the heap sits at 522 MB after GC;
  - with this branch it OOMs in about 1 of 3 runs at 512 MB and passes at
    ≥ 530 MB.

  CI runs issue tests at 1024 MB and 4096 MB (`ci.yml`). Converting the passes'
  weak tables to strong ones cost several MB of peak heap; they are weak again
  in the shipped state.
- Two related tests changed on the way and were fixed:
  - `tests/issue-3518-canonical-instruction-walk.test.ts` pins the exact text of
    `src/wasm/model/instruction-walk.ts`, so the walker change there was
    dropped.
  - The 2934 margin above.

  The other 15 failures among the 94 test files that import the touched passes
  fail identically on base.
