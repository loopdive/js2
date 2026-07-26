---
id: 3673
title: "Compiled Acorn self-parse is 1,300–1,500× slower than node-acorn"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: compiler, codegen, runtime, observability
language_feature: dynamic-dispatch
goal: performance
es_edition: n/a
related: [1710, 1712, 2928, 3437, 3675]
---

# #3673 — Make compiled Acorn self-parse performance usable

## Problem

Acorn 8.16.0 compiled by js2wasm now produces exact ESTree for every tracked
Test262 parser input (#1712), but parsing Acorn's own distribution is roughly
three orders of magnitude slower than node-acorn. Correctness is complete for
the JS-host artifact; performance is not production-ready.

The measured input was the pinned `acorn@8.16.0` `dist/acorn.mjs`:

- 230,975 UTF-8 bytes;
- SHA-256
  `efb0124a960b34d53f9928c4926bfcfd300bb6a3d7ab64ee949b3a8bed1c7e5f`;
- options `{ ecmaVersion: 2025, sourceType: "module" }`;
- compiler revision `2bf320a91f330727ac2b7d9cc05cf13aeb982bae`;
- Node 24.4.1 on macOS arm64.

The protocol used three warmups, fifteen measured samples, alternating lane
order, and forced GC outside each timed sample.

### Public `parse()` lane

This lane calls the public parser export and materializes the complete AST on
the host.

| Metric     |  node-acorn | compiled Acorn |
| ---------- | ----------: | -------------: |
| median     |   19.745 ms |  25,914.072 ms |
| p25        |   18.809 ms |  25,318.868 ms |
| p75        |   24.724 ms |  28,138.480 ms |
| mean       |   21.252 ms |  27,111.723 ms |
| throughput | 11.698 MB/s |  0.008913 MB/s |

The median slowdown is **1,312.451×** and the mean slowdown is **1,275.740×**.
The compiled artifact is 681,946 bytes. js2wasm compilation took 8,351.925 ms,
while native `WebAssembly.compile` and instantiation took 1.465 ms and
16.270 ms respectively.

### In-module body-length lane

To separate parser execution from AST host marshalling, a second module calls
Acorn internally and returns only `Program.body.length`.

| Metric     |  node-acorn | compiled Acorn |
| ---------- | ----------: | -------------: |
| median     |   17.394 ms |  26,691.089 ms |
| p25        |   13.810 ms |  26,254.397 ms |
| p75        |   19.996 ms |  27,540.707 ms |
| mean       |   17.068 ms |  27,869.387 ms |
| throughput | 13.279 MB/s |  0.008654 MB/s |

The median slowdown is **1,534.511×** and the mean slowdown is **1,632.884×**.
The augmented module is 915,284 bytes. Its js2wasm compilation,
`WebAssembly.compile`, and instantiation took 10,285.972 ms, 2.544 ms, and
20.879 ms.

Because the in-module lane is not faster than the public lane, AST host
marshalling is not the dominant cost. The remaining cost is inside compiled
parser execution and its runtime/dynamic-dispatch paths. A profile is required
before assigning the cost to a particular call family.

## Required investigation

- Check in a repeatable benchmark with both the public-AST and in-module scalar
  lanes, the pinned input hash, warmups, sample count, alternating order, and
  percentile output.
- Capture profiles/counters that separate generated parser work from runtime
  method/property dispatch, string operations, RegExp operations, allocation,
  and host bridge calls.
- Identify the smallest set of hot paths responsible for at least 80% of
  compiled wall time. Do not infer that AST marshalling is the bottleneck from
  the public lane.
- Optimize the measured hot path without replacing Acorn with a parser-specific
  intrinsic or changing the public
  `parse(nativeString, optionsObject) -> ESTree object` contract.

## Acceptance criteria

- The benchmark is reproducible from a clean checkout and emits
  machine-readable raw samples plus median, p25, p75, mean, throughput, binary
  size, compiler time, Wasm compile time, and instantiation time.
- A before/after profile records the dominant cost centers and explains at
  least 80% of the compiled execution time.
- Both compiled lanes improve by at least **10×** from the measurements above
  on the same machine/protocol, with no more than a 10% node-acorn control
  drift. If host variability prevents that comparison, use paired sample
  ratios and record the control distribution.
- The required 23-input Acorn corpus, the exact full Test262 AST differential,
  and the zero-import standalone scalar canaries remain green.
- Any remaining gap above 10× native is split into measured, non-overlapping
  follow-up issues before this issue closes.

## Scope boundary

This issue owns parser execution performance. The standalone full-source
illegal cast is #3675. Oversized static string initialization is #3674.
