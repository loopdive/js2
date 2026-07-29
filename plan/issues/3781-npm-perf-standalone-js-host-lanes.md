---
id: 3781
title: "Report npm package performance in standalone and JS-host harness lanes"
status: done
sprint: current
created: 2026-07-29
updated: 2026-07-29
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: tooling, dogfood, website
language_feature: npm packages, standalone, JS host
goal: performance
assignee: "ttraenkler/codex"
depends_on: [3778, 3779, 3780]
related: [1710, 3748, 3751, 3782]
files:
  - benchmarks/results/npm-compat-perf.json
  - benchmarks/results/npm-compat.json
  - package.json
  - plan/issues/3781-npm-perf-standalone-js-host-lanes.md
  - plan/issues/backlog/backlog.md
  - scripts/generate-npm-compat-report.mjs
  - scripts/lib/npm-compat-perf.mjs
  - tests/issue-3781-npm-perf-lanes.test.ts
  - website/components/npm-compat-chart.js
  - website/public/npm-compat.html
  - website/public/benchmarks/results/npm-compat-perf.json
  - website/public/benchmarks/results/npm-compat.json
origin: "user correction that npm numbers must distinguish tests compiled into standalone Wasm from tests executed by the JavaScript host"
---

# #3781 — report npm package performance in standalone and JS-host harness lanes

## Problem

The npm compatibility benchmark currently publishes one `wasmUs` value without
making the placement of the test driver explicit. That is insufficient:

- a **standalone** result must compile the package and the complete benchmark
  driver into a `target: "standalone"` Wasm module;
- a **JS-host** result must keep the inputs, repeated-call loop, result
  observation, and assertion in Node while invoking the compiled package
  export;
- native Node must execute the same observed package operation and remain the
  shared reference.

Moving the loop changes boundary frequency and can change which
compiler/runtime implementation is exercised.
The two placements must never be conflated.

## Plan

1. Give the report generator an explicit `--lane standalone|js-host|both`
   selector. Focused package commands remain non-writing and must also be able
   to skip the other lane.
2. Define one consumed/checksummed workload per package. Both lanes use the
   same package version, inputs, output observation, warm-up count, measured
   rounds, and native Node reference.
3. In the standalone lane compile a batched driver with the package using
   `target: "standalone"` and divide the outer invocation time by the number of
   package operations. Native Node owns an equivalent batch function so both
   optimizers see the same loop scope. Record compile, validation, or runtime
   failure explicitly instead of dropping the lane.
4. In the JS-host lane keep the repeated-call loop and output checks in Node.
   A minimal fixed-arity ABI adapter is permitted for `clsx` because its public
   variadic export cannot cross the fixed-arity Wasm boundary directly; the
   workload and arguments remain host-owned.
5. Emit both lanes in the package JSON and chart rows, retain temporary
   top-level JS-host aliases for existing consumers, and label both placements
   on the npm compatibility page.

## Acceptance criteria

- [x] `clsx`, `cookie`, and Acorn each emit a `perf.lanes.jsHost` entry and a
      `perf.lanes.standalone` entry.
- [x] A successful lane reports raw samples, median, standard deviation,
      iteration count, optimization level, binary size, workload placement, and
      native Node denominator.
- [x] An unsupported standalone lane reports a stable non-success status and
      first diagnostic; it is not omitted and is not plotted as zero.
- [x] Both lanes consume a result-derived numeric checksum and verify it
      against the native package before timing.
- [x] `--only` skips unrelated packages and `--lane` skips the unselected
      execution placement without writing aggregate artifacts.
- [x] Focused tests prove the lane schema, batched per-operation denominator,
      and explicit failure-row behavior.
- [x] The npm compatibility cards and performance chart distinguish
      `standalone` from `JS host`.
- [x] Every lane records and displays whether inputs are
      `compile-time-static` or `runtime-dynamic`; the page explains that a
      generic compiler may eliminate closed static work and never combines the
      two modes.

## Outcome

The committed report now keeps the two execution placements separate and
publishes all nine raw samples for every successful lane:

| Package | Placement  | Input knowledge     |     Wasm median | Node median | Outcome             |
| ------- | ---------- | ------------------- | --------------: | ----------: | ------------------- |
| Acorn   | JS host    | runtime dynamic     | 1,264,727.29 us | 4,196.54 us | Node 301.37x faster |
| Acorn   | standalone | compile-time static |    76,983.28 us | 3,775.61 us | Node 20.39x faster  |
| clsx    | JS host    | runtime dynamic     |       0.3866 us |   0.0162 us | Node 23.80x faster  |
| clsx    | standalone | compile-time static |      0.00065 us |   0.0099 us | Wasm 15.27x faster  |
| cookie  | JS host    | runtime dynamic     |     142.6372 us |   0.2580 us | Node 552.93x faster |
| cookie  | standalone | compile-time static |      0.00065 us |   0.2586 us | Wasm 396.32x faster |

The standalone clsx and Cookie drivers now use the IR backend after a generic
closed-call proof. Their 20,340-byte zero-import modules contain the scalar
test loop rather than the residual package hot path. The JS-host rows remain
the parameterized runtime-execution measurements and are reported separately.

Standalone Acorn now initializes and performs the real 226 KB parse in a
1,803,554-byte zero-import module. It is about 16.4x faster than the current
JS-host Wasm route, but remains 20.39x slower than Node and does not yet land on
the IR path.
