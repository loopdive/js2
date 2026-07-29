---
id: 3780
title: "Compile Acorn parse hot path to Wasm faster than native Node"
status: in-progress
sprint: current
created: 2026-07-29
updated: 2026-07-29
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen, runtime, tooling
language_feature: strings, objects, arrays, classes, parser
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3779]
related: [1710, 1712, 3756]
files:
  - package.json
  - plan/issues/3780-acorn-wasm-faster-than-node.md
  - plan/issues/backlog/backlog.md
  - scripts/generate-npm-compat-report.mjs
  - src/compiler.ts
  - src/index.ts
  - src/ir/types.ts
  - src/runtime.ts
loc-budget-allow:
  - src/compiler.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/fnctor-escape-gate.ts::analyzeProtoMethodWriteOnce
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/compiler/ground-call-fold.ts::foldGroundCallsInMultiFiles
origin: "user request to repeat the measured clsx and cookie optimization process for Acorn and beat native Node"
---

# #3780 — compile Acorn parse hot path to Wasm faster than native Node

## Product outcome

The real pinned `acorn@8.16.0` package, compiled with `optimize: 4`, must execute
the existing self-host parse workload faster than the same pinned package
running natively in Node. The official operation parses Acorn's own distribution
bundle through public `parse(source, options)` on every call, with the same
source and options on both lanes and the existing two-warm-up/nine-measured
round protocol.

The optimized export must retain parameterized behavior for arbitrary source
text and supported options. No Acorn package, file, source-text, export-name, or
expected-output special case is permitted.

## Benchmark contract

Both sides parse and observe the same source on every measured call. The issue
remains open until that operation beats native Node.

## Investigation

Establish a fresh same-host baseline. Record optimized and correctness binary
sizes, Wasm imports and start shape, representative WAT, per-operation
Wasm-to-host imports and host callbacks, export marshalling, CPU attribution,
and compile/instantiate/first-call startup. Identify the host precisely and
report cold startup separately from the repeated-call hot benchmark.

## Measured baseline

Candidate base `6bf34f1099ea15` (current main plus #3778 and #3779), Node
24.4.1 / V8 13.6.233.10-node.17, arm64 macOS:

| lane           |           median | standard deviation |
| -------------- | ---------------: | -----------------: |
| compiled Wasm  | 1,323,300.108 µs |      22,041.787 µs |
| native Node    |     4,023.425 µs |         271.059 µs |
| Node advantage |          328.89x |                    |

The baseline used five iterations, two warm-up rounds, and nine measured
rounds. Correctness was 3,507/3,518 official Acorn tests (99.69%), matching the
pre-existing surface.

## Binary and execution analysis

The optimized performance module is a 330,903-byte WasmGC binary; the separate
correctness binary is 596,610 bytes. It has no linear memory. Its start function
initializes Acorn's token types, parser prototypes, accessor closures, regular
expressions, and lookup tables before exports are wired.

The optimized binary declares 77 function imports plus a large string-constant
global namespace. The WAT contains typed WasmGC structs for `Parser`, `Node`,
`TokenType`, `TokContext`, source locations, regexp validation state, arrays,
and many closure/functor shapes. Parser fields and generic operations repeatedly
move through `externref`, `f64`, boxed booleans/numbers, generic property
helpers, and closure dispatch. The public `parse` wrapper is small; the cost is
the recursive parser graph it enters.

An exact, allocation-free per-instance import counter measured one changed
source parse after module initialization:

| dynamic work group                                    | Wasm-to-host calls |
| ----------------------------------------------------- | -----------------: |
| numeric boxing/unboxing, type, truth, compare, index  |         11,032,750 |
| extern property reads/writes, lookup, method dispatch |          5,656,932 |
| arrays, argument vectors, and iteration               |            866,913 |
| object creation, registration, deletion               |             58,870 |
| regexp and string helpers                             |             54,500 |
| **total**                                             |     **17,669,965** |

The largest individual helpers are `__box_number` (2,995,053),
`__extern_get` (1,852,765), `__get_undefined` (1,718,875),
`__host_compare` (1,698,487), `__unbox_number` (1,564,754),
`__host_eq` (1,463,415), `__typeof_number` (1,321,348), and
`__is_truthy` (1,309,535). This direct census explains the flat
constant-factor cost more precisely than attributing the 1.323-second sample to
the compact public wrapper. Host-to-Wasm callbacks are not counted on the miss:
wrapping Acorn's callback exports changes its closure ABI. The counter therefore
reports that dimension as unavailable rather than a false zero.

## Who the host is

The host is Node 24.4.1. Its V8 engine instantiates the WasmGC binary through
the JavaScript `WebAssembly` API. JavaScript functions built by
`src/runtime.ts` satisfy the module's `env` imports, and V8 supplies the
`wasm:js-string` built-ins. Native Acorn and compiled Acorn run in the same V8
process. This is not WASI, Wasmtime, or a browser.

## Startup denominator

The final clean run separated build time from deployed startup:

| phase                                       |          time |
| ------------------------------------------- | ------------: |
| compile 226 KB JavaScript source at level 4 | 10,572.719 ms |
| `WebAssembly.compile` optimized binary      |      0.779 ms |
| instantiate, including Acorn module start   |      2.382 ms |
| wire runtime exports                        |      0.001 ms |
| wrap public exports                         |      0.110 ms |
| first parse                                 |  1,283.007 ms |
| second parse                                |  1,228.122 ms |

Source compilation is a build-time denominator, not deployed startup. If the
shared host runtime is not already loaded, #3778 measured another 199.559 ms to
load its unchanged 10,007,724-byte JavaScript chunk (1,663,408 bytes gzip).
This optimization does not shrink that runtime or the 330,903-byte Wasm module.
The first/new-source parse still performs the full parser and snapshot, so no
cold-start improvement is claimed.

## Benchmark setup

`pnpm run benchmark:acorn` runs only Acorn, retains the committed correctness
and performance implementations, prints all nine samples and diagnostics, and
does not update aggregate artifacts. `pnpm run benchmark:acorn:perf` skips the
correctness harness and official suite for iteration. `--diagnostics-only`,
`--inspect-boundaries`, and `--inspect-wat` isolate binary/startup, boundary,
and WAT attribution work.

Both lanes use one shared iteration count calibrated against the slower lane.
This changes only run duration; both lanes still execute the same count in
every round.

## Official measurement

Both sides parse Acorn's same 226 KB distribution source and observe
`ast.body.length === 422` on every call:

| lane          |           median | standard deviation |
| ------------- | ---------------: | -----------------: |
| compiled Wasm | 1,279,410.541 µs |       5,701.569 µs |
| native Node   |     4,323.208 µs |         579.186 µs |

The nine-round result uses one full parse per round and puts Node
**295.94x ahead**. Matching checksum 422 is recorded in the committed artifact.
Correctness remains exactly 3,507/3,518 (99.69%).

## Host-free standalone progress

The standalone lane now completes module initialization and returns the same
checksum `422` from the real parse. A generic lowering expands stable
runtime-filled `Object.defineProperties` maps on function prototypes, which
handles Acorn's generated accessor installation without a host import. The
test driver and its invariant source/options setup are compiled into the
module.

Fresh nine-round measurement on Node 24.4.1 / arm64 macOS:

| lane                  |       median | standard deviation |
| --------------------- | -----------: | -----------------: |
| standalone Wasm       | 76,983.28 us |        2,627.81 us |
| equivalent Node batch |  3,775.61 us |          144.29 us |
| Node advantage        |   **20.39x** |                    |

The run used three parses per round. The 1,803,554-byte WasmGC module has zero
imports. Build-time compilation took 35,706.16 ms; deployed
`WebAssembly.compile`, instantiate, explicit module initialization, and first
batch took 9.21 ms, 4.87 ms, 4.15 ms, and 470.63 ms respectively.

This removes about 16.4x of the current JS-host execution time, but it does not
meet the faster-than-Node goal. The parse remains on the legacy backend
(`irCompiledFunctions` is empty); moving Acorn's dynamic parser graph through
the IR remains the principal optimization frontier.

## Acceptance criteria

- [x] `pnpm run benchmark:acorn` runs only Acorn, uses the official npm-compat
      correctness and performance implementations, prints raw samples, and does
      not overwrite aggregate artifacts.
- [x] The benchmark continues to invoke parameterized public
      `parse(source, options)` on both lanes; no package/source/file/export-name
      special case or constant driver is introduced.
- [x] The representative compiled AST remains equivalent to native Acorn, and
      the official correctness surface does not regress.
- [ ] Across the official nine measured rounds, compiled Wasm median time is
      lower than native Node median time (`nodeUs / wasmUs > 1`).
- [x] Baseline, final medians, standard deviations, iteration count, engine,
      binary size, imports, boundary census, CPU attribution, and startup
      denominator are documented.
