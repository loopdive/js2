---
id: 4415
title: "Compile hot path: -17% from three allocation/env-read fixes (profiled)"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: performance
area: codegen
goal: velocity
# All three growths are comment, not code. The fixes themselves are net-neutral
# or negative in logic; what grew is the explanation of WHY, which is the part
# that stops someone re-introducing a per-call Set or a hot `process.env` read.
#   stack-balance.ts   +10  hoisting the Set out of the function + its rationale
#   compiler.ts         +9  resetDerivationFlagCache() call + why it lives there
#   registry/imports.ts +3  the 89,281-instructions-per-compile finding
loc-budget-allow:
  - src/codegen/stack-balance.ts
  - src/compiler.ts
  - src/codegen/registry/imports.ts
# compileSourceSync gains one call + the comment explaining why this is the one
# choke point where the flag cache can safely be reset (it is the only place
# every compile passes through, re-entrant runtime-eval included).
func-budget-allow:
  - src/compiler.ts::compileSourceSync
---

## Why

test262 CI time is dominated by `compile()`, not by TypeScript. Measured on a
harness-wrapped test262 source: TS front-end (`analyzeSource` with
`skipSemanticDiagnostics`) is **3–7 ms** against a **456–629 ms** compile —
under 1.2%. A CPU profile of 40 steady-state compiles put **54% in
`src/codegen`** and 9.6% in the garbage collector.

(The often-quoted "TypeScript is 90% of compile time" is true only with
semantic diagnostics ON — one `program.getSemanticDiagnostics()` call is
365 ms of a 404 ms compile. test262's production path already passes
`skipSemanticDiagnostics: true` via `scripts/compiler-fork-worker.mjs`, so it
never pays that. See "TS share" below for the nuance.)

## Result

Same benchmark, 3 runs each, 48 compiles per run over 3 harness-wrapped
test262 sources, warm process, median ms per compile:

| | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| `origin/main` | 544.0 | 506.5 | 513.7 | **513.7** |
| this change | 450.9 | 429.0 | 421.2 | **429.0** |

**−16.5%.** Run-to-run spread is ~7%, which is why every number here is a
median of three and not a single run.

Profile shifts (40 steady-state compiles, self time):

| | before | after |
| --- | --- | --- |
| `src/emit` | 12.6% | **5.7%** |
| `fixCallArgTypesInBody` | 4.8% | gone from top-20 |
| `fnctorCtorParamTypesFlagEnabled` | 2.3% | gone from top-20 |
| garbage collector | 2012 ms | 1824 ms |

## The three fixes

### 1. `SIMPLE_PRODUCERS` was rebuilt on every call — the big one

`fixCallArgTypesInBody` (`src/codegen/stack-balance.ts`) constructed a
~90-element `Set` of opcode names *inside the function*. The function recurses
into every `if` / `block` / `loop` / `try` of every function body, so the Set
was allocated and filled thousands of times per compile. Its contents are a
compile-time constant. Hoisted to module scope.

Worth **−19%** on its own, the single largest win here.

### 2. `process.env` reads in the hot lowering path

The seven predicates in `src/derivation-flags.ts` each read
`process.env.JS2WASM_*` on **every call**. `process.env.X` is not a property
read — V8 goes to the real environ block, measured **85× slower** than a cached
boolean (2M reads: 507 ms vs 6 ms). `fnctorCtorParamTypesFlagEnabled` alone was
2.3% of compile time, i.e. tens of thousands of env reads per compile to answer
a question that cannot change mid-compile.

Memoised **per compile**, not per process: ~244 sites under `tests/` set and
delete these variables between compiles, and a module constant would freeze the
first value and break them. `resetDerivationFlagCache()` is called from
`compileSourceSync` — the one choke point every compile passes through,
including the re-entrant runtime-eval path. Verified with
`tests/issue-743-method-edges-in-fixpoint.test.ts`, which flips these flags at
runtime and still passes.

### 3. `WasmEncoder` over a growable `Uint8Array`

`src/emit/encoder.ts` buffered into a boxed `number[]`, pushed one byte at a
time, and `finish()` copied it into a `Uint8Array`. `section()` made it
worse than linear: it encodes into a sub-encoder, finishes it, then copied the
result back **one byte at a time**, so nested sections re-copied their payload
per level. Also allocated a fresh `TextEncoder` per `name()` call — one per
import, export and function name in the module.

Now a growable `Uint8Array` with a bulk `set()` in `bytes()`, and one shared
`TextEncoder`. `finish()` deliberately stays a `slice` (copy), not a
`subarray`: the old contract returned a fresh array and `section()` keeps
writing to the encoder afterwards, so a view would alias.

Halved `src/emit` self time (12.6% → 5.7%). End-to-end this one is inside
benchmark noise on its own; it is justified by the profile, not by the
wall-clock delta.

## Verification

No behaviour change. Two independent sets, run on this change and on
`origin/main`, byte-identical results:

- 25 files (`issue-30xx` sample + the flag-mutating `issue-743` test):
  169 passed / 9 failed on both.
- 18 emit/binary/wat/link/component/wasi/standalone files:
  175 passed / 6 failed on both — including `emit-encodeinstr-failloud`, the
  encoder test.

Those 9 and 6 failures are **pre-existing on `origin/main`** and unrelated
(`issue-3009`, `issue-3014`, `issue-3000-c`, `issue-3017`,
`es5-standalone-*`, `emit-encodeinstr-failloud`).

## Not fixed — the remaining worklist

### `shiftGlobalIndices` is quadratic (still 1.5%)

`addStringConstantGlobal` calls `fixupModuleGlobalIndices` on every string
constant added once code exists. Instrumented: **32 calls walking 89,281
instructions per compile**. Replacing the `in` checks with direct property
reads bought ~1%; the walk itself is the cost.

The real fix is batching, and it **is provably equivalent**: successive calls
use thresholds t, t+1, t+2 … with delta +1 each, and any index ≥ t is a
module-defined global that takes every subsequent shift, while any index < t is
an import global that takes none — so k calls ≡ one shift of +k at threshold t.
What blocks it is the flush protocol, not the arithmetic: `fixupModuleGlobalIndices`
also patches `ctx.newTargetGlobalIdx`, `ctx.holeGlobalIdx`,
`ctx.genEagerFlagGlobalIdx` and `ctx.sharedEmptyVecGlobals`, and there are 259
scattered `addStringConstantGlobal` call sites interleaved with lowering, so
deferral needs every reader of those fields identified first. That is a design
change and deserves its own issue rather than a hot patch — CLAUDE.md already
flags late index shifting as an area that has burned people.

### Garbage collector, ~10%

Down in absolute terms (2012 → 1824 ms per 40 compiles) but unchanged as a
share. Root-causing it needs a **heap profile** (`--heap-prof`), which was not
run. The CPU profile cannot attribute allocation to its source.

### Next candidates from the current profile

`canonicalProgramAbiValType` 2.1%, `shiftGlobalIndices` 1.5%,
`fixupInstrs` 1.4%, `locateOperandProducers` 1.4%, `walkChildren` 1.4%.
`src/codegen` is still 55.8% of compile time.

## Reproduce

CPU profile: `npx tsx --cpu-prof --cpu-prof-dir=<dir> <driver>` compiling a
harness-wrapped test262 source 40× after a 3-compile warm-up, then attribute
self time per `callFrame.url`. Drop startup samples by burning a distinctive
frame before the measured loop — otherwise ~22% of samples are tsx module
loading, which is startup-only and never appears in steady state.
