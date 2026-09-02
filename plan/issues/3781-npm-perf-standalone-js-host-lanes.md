---
id: 3781
title: "Report npm package performance in standalone and JS-host harness lanes"
status: done
sprint: 77
created: 2026-07-29
updated: 2026-07-30
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
# 2026-09-02: standalone lanes for react/redux were host-import-error
# (`__get_process_env`, lib.dom `NavigationHistoryEntry_getState` bound to an
# `any` receiver). Two small host-free arms; growth granted here.
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
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
- [x] Acorn additionally reports runtime-dynamic input with the complete test
      loop inside standalone Wasm, keeping harness placement and input
      knowledge as independent dimensions.

## Outcome

The committed report now keeps the two execution placements separate and
publishes all nine raw samples for every successful lane:

| Package | Placement  | Input knowledge     |     Wasm median | Node median | Outcome                 |
| ------- | ---------- | ------------------- | --------------: | ----------: | ----------------------- |
| Acorn   | JS host    | runtime dynamic     | 1,241,301.50 us | 4,204.58 us | Node 295.23x faster     |
| Acorn   | standalone | runtime dynamic     |    71,248.30 us | 4,129.78 us | Node 17.25x faster      |
| Acorn   | standalone | compile-time static |       0.0247 us | 4,658.37 us | Wasm 188,335.86x faster |
| clsx    | JS host    | runtime dynamic     |       0.3961 us |   0.0160 us | Node 24.83x faster      |
| clsx    | standalone | compile-time static |      0.00065 us |   0.0112 us | Wasm 17.15x faster      |
| cookie  | JS host    | runtime dynamic     |     148.1413 us |   0.2657 us | Node 557.64x faster     |
| cookie  | standalone | compile-time static |      0.00065 us |   0.2577 us | Wasm 395.33x faster     |

The standalone clsx and Cookie drivers now use the IR backend after a generic
closed-call proof. Their 20,340-byte zero-import modules contain the scalar
test loop rather than the residual package hot path. The JS-host rows remain
the parameterized runtime-execution measurements and are reported separately.

Standalone Acorn first initializes and performs the real 226 KB parse in a
1,784,473-byte zero-import evaluation-stage module. Generic staged evaluation
then emits a 20,874-byte zero-import residual whose benchmark export uses the
IR backend. The stage runs the exact operation once inside Wasm, records its
421.46 ms cost, and has no cache or Node-derived result. This static row is
therefore reported separately from runtime execution.

The Acorn JS-host row still performs every parse after compilation and remains
295.23x slower than Node. Its standalone runtime-dynamic counterpart performs
the same class of work with no host imports and narrows the gap to 17.25x.
Neither runtime result is combined with the static residual result.

## 2026-09-02 — why four packages had a JS-host trend line but no standalone one

The landing/dashboard perf-over-time graph plots `npm-compat-history.json`,
which only records a lane whose `status` is `measured`. `uuid`, `react`,
`hono` and `redux` were all `measured` on js-host and failed on standalone,
so their standalone series was empty for their whole history (measured over
343 recorded runs: acorn/clsx/cookie have both lanes; lit/react/hono/redux/uuid
have js-host only).

Two of the four causes were compiler defects and are fixed here:

- **`process.env.<x>` kept a `__get_process_env` host import** (react, redux).
  Standalone has no `process` to read, and the JS-host import itself answers
  `{}` when none exists — so the host-free lane now materializes that empty
  object directly (`src/codegen/property-access-dispatch.ts`).
- **A method call on an `any` receiver bound the first extern class declaring
  that name** (redux). `store.getState()` first-matched lib.dom's
  `NavigationHistoryEntry.getState`, emitting an `env` import no standalone
  instance can satisfy. Under `noJsHost` that whole first-match loop is now
  skipped, so the call falls through to the native `__extern_method_call`
  route (`src/codegen/expressions/calls-closures.ts`). Same defect family as
  the `.join` (#3342) and DisposableStack (#3237) arms already sitting above
  it, generalized instead of adding a fourth name-specific escape.

Result: **redux now measures on all three lanes** (standalone static,
standalone dynamic, js-host), so it gains a standalone trend line.

The remaining two are NOT compiler bugs in this area and are deliberately left
out of this change:

- **hono** — `compile-error`: `String.prototype.replace()` with a RegExp search
  value is unsupported under `--target standalone` (#1474). A feature gap with
  its own issue, not a lane defect.
- **uuid** — `host-import-error`: the binary retains `__crypto_get_random_values`
  and `__crypto_random_uuid`. Needs a Wasm-native entropy source for standalone
  (the dual-mode rule in CLAUDE.md), which is its own piece of work.
- **react** — `host-import-error` is fixed by the `process.env` arm above, but
  the lane then fails at `__module_init`: react's `index.js` is the classic
  `if (process.env.NODE_ENV === "production") module.exports = require(
  "./cjs/react.production.js") else … require("./cjs/react.development.js")`
  gate. `src/cjs-rewrite.ts` only rewrites `require()` in DECLARATION
  statements, so a `require` inside module-level control flow survives as a
  bare call — fine with a JS host, a throw in a host-free module.
  Hoisting both branches to eager imports was tried and abandoned: it makes the
  dev AND prod builds share one module graph, and the two builds declare
  same-named nested functions (`cloneAndReplaceKey`, `mapIntoArray`) which the
  NAME-KEYED capture registry then mixes across frames —
  `codegen invariant: 'cloneAndReplaceKey' references out-of-range local(s)
  154, 198 after local dedup (params=2, locals=9, before=9)`. Each build
  compiles cleanly on its own; only the two together fail. So react's standalone
  lane needs either statically folding the NODE_ENV gate (so one branch is
  dropped) or module-scoping the capture registry — both larger than this
  change and worth their own issue.
