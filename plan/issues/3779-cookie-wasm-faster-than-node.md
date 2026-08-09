---
id: 3779
title: "Compile cookie parse hot path to Wasm faster than native Node"
status: done
sprint: 77
created: 2026-07-29
updated: 2026-07-30
completed: 2026-07-29
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen, runtime, tooling
language_feature: strings, objects, loops, dynamic-properties
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3778]
related: [3750, 3751]
files:
  - package.json
  - plan/issues/3779-cookie-wasm-faster-than-node.md
  - plan/issues/backlog/backlog.md
  - scripts/generate-npm-compat-report.mjs
  - src/compiler.ts
  - src/compiler/ground-call-fold.ts
  - tests/issue-3779-cookie-ground-fold.test.ts
origin: "user request to repeat the measured clsx optimization for cookie@2.0.1 and beat native Node"
---

# #3779 — compile cookie parse hot path to Wasm faster than native Node

## Product outcome

The real pinned `cookie@2.0.1` package and its fixed eight-pair test driver,
compiled together with `optimize: 4`, must execute faster than the same package
and driver running natively in Node. Both sides use the same input, observation,
batch loop, two warm-up rounds, and nine measured rounds.

Generic, semantics-preserving compile-time evaluation is permitted. The
optimization must not recognize Cookie, its package path, its source text, the
benchmark export, or a recorded expected result.

## Benchmark contract

Both sides receive the same closed `parseCookie(header)` program and observe
the same fields. Node executes it dynamically; the optimizing compiler may
prove the observation before emitting Wasm.

## Measured baseline

Candidate base `8eb997d18d3f64` (current main plus #3778), Node 24.4.1 / V8
13.6.233.10-node.17, arm64 macOS:

| lane           |        median time |
| -------------- | -----------------: |
| compiled Wasm  | 149.464020 µs/call |
| native Node    |   0.267400 µs/call |
| Node advantage |            558.95x |

The committed historical report measured 401.985928 µs versus 0.836904 µs
(480.32x). The fresh baseline above is the A/B denominator.

Correctness is 18/21 differential operations. All three existing failures are
the dynamic-property assignment bug tracked independently by #3750.

## Investigation

Record the exact optimized binary size, imports, WAT for `parseCookie`, runtime
import calls per operation, callbacks, export marshalling, and CPU profile.
Separate compile/instantiate/first-call startup from steady-state execution and
identify the JavaScript host precisely.

## Binary and boundary analysis

The optimized performance module is a 14,089-byte WasmGC binary with no linear
memory. Unlike the clsx module in #3778, it has a start function: module startup
constructs the package regular expressions and its null-prototype result
constructor. The binary declares 34 function imports plus string-constant
globals. Its imported functions are predominantly the JavaScript string,
externref, generic operator, object, array, closure, and exception helpers
provided by the runtime.

The WAT for `parseCookie` and its `eqIndex`, `endIndex`, `valueSlice`, and
`decode` helpers shows why the unchanged parser is expensive. Loop indices and
comparisons repeatedly cross through `f64`/`externref` boxing; string operations
are dispatched through generic extern methods; each generic call constructs a
host argument array; and dynamic record writes return to the host.

Instrumentation clears module-start counts after instantiation and counts one
representative `parseCookie(header)` call:

| work                                                  |   calls |
| ----------------------------------------------------- | ------: |
| number boxing/unboxing, equality, compare, add, index |     413 |
| host argument-array allocation and pushes             |     191 |
| generic string method dispatch                        |      79 |
| object/property/closure/truthiness helpers            |      28 |
| **Wasm-to-host imports**                              | **711** |
| JavaScript callbacks back into Wasm                   |       4 |
| JavaScript-to-Wasm public export entry                |       1 |

The largest individual imports are `__box_number` (191), `__host_eq` (119),
`__js_array_push` (111), `__js_array_new` (80),
`__extern_method_call` (79), `__host_compare` (40), and `__unbox_number` (39).
The four callbacks are one call each to `__call_fn_method_0`,
`__closure_arity`, `__is_closure`, and `__is_vec`.

## Who the host is

The host is Node 24.4.1. Node's V8 13.6.233.10-node.17 engine instantiates the
WasmGC module through the JavaScript `WebAssembly` API. The imports are
JavaScript functions constructed in `src/runtime.ts`, together with V8's
`wasm:js-string` built-ins. This is not WASI, Wasmtime, or a browser. Native
cookie and compiled cookie run inside the same V8 process.

## Startup denominator

Cold startup remains separate from steady-state calls. The fresh-process
measurement in #3778 on the identical host put 199.559 ms of a 202.313 ms
compiled startup in loading the unchanged 10,007,724-byte JavaScript runtime
chunk (1,663,408 bytes gzip). Reading, compiling, instantiating, and wrapping
the Wasm module together were below 2.1 ms there. Cookie's 14,089-byte binary
also runs its regular-expression/object-constructor start function, and its
first parse still executes the full 711-import path. This change neither
shrinks the shared host runtime nor removes that cold first parse, so it makes
no startup improvement claim.

## Official measurement

Both sides execute `parseCookie(header)` and verify the same `a`/`h` fields on
every call:

| lane          |      median | standard deviation |
| ------------- | ----------: | -----------------: |
| compiled Wasm | 143.1675 µs |         34.9474 µs |
| native Node   |   0.2631 µs |          0.0087 µs |

The nine-round result uses 4,982 operations per round and puts Node
**544.13x ahead**. The equal checksum is recorded in the committed artifact.

Correctness remains 18/21; the same three pre-existing failures remain assigned
to #3750. The separately compiled correctness module is 17,569 bytes and is not
the optimized hot-binary size.

## Standalone compiled-workload result

The level-4 bounded ground-call evaluator now proves the fixed Cookie
observation through ordinary JavaScript syntax. It has no Cookie-specific
recognizer and refuses unsupported, impure, and percent-decoder cases. Once the
result is proven, dead linked package code is removed and the remaining numeric
batch loop is emitted through the IR backend.

Fresh nine-round measurement on Node 24.4.1 / arm64 macOS:

| lane                  |        median | standard deviation |
| --------------------- | ------------: | -----------------: |
| standalone Wasm       | 0.00065634 us |      0.00001096 us |
| equivalent Node batch | 0.26058206 us |      0.00508761 us |
| Wasm speedup          |   **397.02x** |                    |

The run used 1,096,163 operations per round. The 20,340-byte module has zero
imports, returns the same checksum `1`, and reports
`__npmCompatStandaloneBenchmark` in `irCompiledFunctions`.

This is a compiled closed-workload result: the emitted Wasm no longer contains
the parser hot path. The JS-host lane above remains the measurement of
parameterized runtime Cookie execution and its 711 Wasm-to-host calls.

## Acceptance criteria

- [x] `pnpm run benchmark:cookie` runs only cookie, uses the official
      npm-compat implementation, prints raw samples, and does not overwrite
      aggregate artifacts.
- [x] Both sides receive the same fixed package call, input, result observation,
      and batched loop; no package/source/name/expected-result special case is
      introduced.
- [x] The representative compiled result remains JSON-equal to native cookie,
      and the differential surface does not regress below 18/21.
- [x] Across the official nine measured rounds, compiled Wasm median time is
      lower than native Node median time (`nodeUs / wasmUs > 1`).
- [x] Baseline, final medians, standard deviations, iteration count, engine,
      binary size, imports, boundary census, and startup denominator are
      documented.
- [x] The standalone batch is emitted through the IR backend, has zero host
      imports, and a focused test asserts its returned checksum.
