---
id: 3482
title: "Benchmark direct Porffor against JS2 typed SSA and shared-plan Porffor IR"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
pr: 3439
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: ir, codegen-linear, backend, benchmarking, ci
language_feature: compiler-internals
es_edition: n/a
goal: backend-agnostic-ir
depends_on: [3478]
related: [3288, 3295, 3297, 3298, 3299, 3300, 3336, 3478]
origin: "2026-07-20 explicit user request: fair plain/direct Porffor vs JS2 source-to-typed-SSA/shared-plan/Porffor-IR/native-C A/B"
---

# #3482 — Direct Porffor vs JS2 typed-SSA/shared-plan Porffor IR A/B

## Objective

Build one honest, reproducible comparison from one checked-in TypeScript byte
sequence through these two source-to-native routes:

```text
same .ts bytes ─┬─> pinned Porffor parse/codegen module ─> Porffor renderer ─> C
                │
                └─> JS2 source front end ─> typed SSA IrModule
                    ─> shared LinearMemoryPlan ─> JS2 Porffor IR adapter
                    ─> the same pinned Porffor renderer ─> C

both C outputs ─> the same external Clang flags ─> the same lane ABI/harness
```

Report four rows, not a single ambiguous "Porffor vs JS2" pair:

| Row id                                | Source/front end                                     | Value ABI                                              | Allocation row                         |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `direct-porffor-gc`                   | pinned Porffor directly consumes the `.ts`           | Porffor boxed `jsval` for ordinary TypeScript `number` | Porffor default global GC              |
| `direct-porffor-bump`                 | pinned Porffor directly consumes the `.ts`           | Porffor boxed `jsval`                                  | Porffor global `gc=false` bump control |
| `js2-porffor-arena-v1`                | JS2 source -> typed SSA -> shared plan -> Porffor IR | raw `f64` at the benchmark function boundary           | JS2 `arena-v1`                         |
| `js2-porffor-analysis-stack-arena-v1` | same JS2 pipeline and renderer                       | raw `f64`                                              | JS2 per-site `analysis-stack-arena-v1` |

The result is an engineering measurement, not a marketing winner table. The
end-to-end direct-vs-JS2 rows necessarily conflate front end, value ABI, object
layout, generated IR, and allocator. Only the two JS2 rows hold those factors
constant and isolate `LinearMemoryPlan` allocation policy.

## Dependency and readiness gate

The final PR is blocked on #3478 / PR #3432. Per the implementation handoff,
development starts from its exact green head
`4c7e3a01d31275163ec9940e864c7292f6961b20`; publication waits until that PR
lands and this branch has merged the latest `origin/main`. Consume, do not copy,
its:

- `tests/fixtures/porffor-source-to-native-canary.ts` checked-in source;
- exact source-derived `LinearIrResult.irModule` telemetry;
- exact `LinearIrResult.memoryPlan` paired with that module; and
- explicit `update=checkout` Porffor initialization pattern.

The planning handoff named `2509181c33516ca1fe2462f7008650f2d99eb129`
as the Ubuntu fix, but that object is not an ancestor of the exact green head.
The green head instead contains
`559109b723d8c08c0469594db9591f40b1fdfad0`; both commits have stable patch ID
`e45f9ef358b38d5dee543ccc2ca16f92962b193f`. The benchmark asserts the green
head and its reachable patch-equivalent fix. Once #3478 lands, replace the
string-valued `blocked_by` with `depends_on: [3478]`.

At implementation start, re-run the open-PR/open-issue duplicate scan and
verify `git log origin/main --grep="#3478"` contains the merged dependency.
Do not recreate the fixture or source telemetry on this issue's branch.

## Verified current state

Verified against `origin/main` `5d1ab095bd1638c190a5700b9eb0b926d7589e77`
and the open #3478 dependency:

- The gitlink and `src/ir/backend/porffor/compat.ts:3-4` pin Porffor to
  `60a1d41d60580ff4faa38ffd5f7783d23df68bad`.
- `src/ir/backend/porffor/compat.ts:131-163,184-305` freezes the renderer
  module shape, function shape, type/IR enums, commit assertion, renderer-input
  assertion, and output normalization.
- `src/ir/backend/porffor/loader.ts:49-118` dynamically loads only the pinned
  `compiler/ir.js` and `compiler/render.js`; ordinary builds remain independent
  of the optional submodule.
- `src/ir/backend/porffor/integration.ts:17-109` lowers a typed JS2 `IrModule`
  plus its `LinearMemoryPlan` into the frozen Porffor renderer record. Planned
  heap rows require `prefs.gc=false` because JS2 raw pointers are not Porffor
  GC roots.
- #3478 extends `src/ir/backend/linear-integration.ts` so
  `compile(..., { target: "linear" })` reports the exact verified
  source-derived `IrModule` passed to `planLinearMemory()`, beside the exact
  resulting plan. This is the only source/plan pair this benchmark may feed to
  `lowerIrModuleToPorffor()`.
- At the pin, `vendor/Porffor/porf c --module -O1 source.ts out.c` directly
  accepts TypeScript. Pinned `runtime/index.js:78-121,152-160` derives typed
  input from the `.ts` filename and dispatches to `compiler/index.js`.
- Pinned `compiler/index.js:63-105` exposes a pre-render
  `globalThis.compileCallback(cg)`, records parse/IR timestamps in `cg.times`,
  renders the returned module, and writes C. Pinned `compiler/codegen.js:5049-5195`
  returns the renderer record with `entry: "#main"`; pinned
  `compiler/render.js:1592-1598` emits C `main` only when `entry` is truthy.
  Clearing `entry` in the callback therefore preserves the direct compiler
  path while allowing the common external harness to own `main`.
- Pinned `compiler/render.js:255,785-910` gives each function the C symbol
  `p<index>_<sanitized-name>` and renders its declared ABI. The direct fixture's
  ordinary `number` parameter/result is boxed `jsval`; the JS2 Porffor-IR row
  intentionally remains raw `f64`. The benchmark must adapt both to one lane
  ABI and report the difference, not label them ABI-equivalent.
- The direct Porffor dynamic object is approximately 56 bytes at this pin and
  its allocator selection is global (default GC or global bump). The JS2
  fixture's fixed record is 24 bytes (8-byte header plus two `f64` fields), and
  JS2 can promote each proven non-escaping site independently. Record these
  facts in result metadata and interpretation.
- `scripts/benchmark-allocation-policies.mts:1-187` is a useful policy proof,
  but its Porffor side starts from `buildAllocationPolicyProof()` hand-built
  IR while its linear-Wasm side compiles a different source string; it also
  omits source compiler phase time. `docs/ir/porffor-allocation-policy-proof.md`
  must continue to describe that narrow proof, never this direct comparison.
- `package.json:78-161,166-193` does not declare `tsx` even though historical
  scripts invoke floating `npx` variants. This issue must use a declared,
  lockfile-backed runner and must not add another `npx --yes tsx` command.

### Duplicate check (2026-07-20)

- A complete query of all open `loopdive/js2` PR titles/bodies and GitHub
  issues for Porffor, source-to-native, shared-plan comparison, direct Porffor,
  and allocation-policy benchmark terms found only prerequisite PR #3432.
- Repository searches found #3288/#3297-#3300, #3336, and #3478, but no issue
  comparing the pinned direct Porffor source path with the JS2 source-derived
  Porffor-IR path.
- `scripts/claim-issue.mjs --allocate` reserved and claimed #3482 with a full,
  non-degraded open-PR scan.

## Root cause / missing evidence

The current measurements answer narrower questions:

- #3299/#3300 prove that JS2's typed SSA and shared plan can drive Porffor C
  and that changing only JS2 policy changes behavior and resource use as
  expected.
- #3478 proves a real `.ts` file reaches the exact shared module/plan pair and
  executes correctly through JS2 linear-Wasm and JS2 Porffor IR.

No measurement sends the identical checked-in TypeScript bytes through plain
Porffor and the JS2 source-derived route, normalizes both native artifacts to a
common callable ABI, builds both with identical external compiler/linker flags,
and records raw interleaved samples plus compile phases. Reusing #3300's
hand-built IR numbers as that comparison would be methodologically false.

## Implementation Plan

### 1. Reuse exactly one source file and establish the Node oracle

**File: `tests/fixtures/porffor-source-to-native-canary.ts` (from #3478; no
change expected)**

- Read this file once as a `Buffer`; compute and record its SHA-256 and UTF-8
  byte length. Pass that exact decoded byte sequence to both compiler workers.
- Use its exported seed-sensitive `porfforSourceNativeCanary(seed)` function.
  Do not create a `.js` twin, inline a second TypeScript string, or simplify the
  source separately for either compiler.
- Use #3478's bounded seed function/corpus when the merged fixture retains
  current legality: fixed canary seeds plus
  `((index * 17) % 257) - 128`. The performance checksum uses exactly 200,000
  calls. All values/checksums must stay finite, integral, and exactly
  representable below `2^53`.
- If the merged #3478 fixture is no longer directly accepted by pinned Porffor
  or no longer in JS2 Porffor legality, first document the exact unsupported
  instruction/parse failure. Only then may the implementation add one
  canonical standalone `.ts` fixture, with a written justification and one
  byte sequence still shared by all rows. A generated or hand-built IR
  substitute is not acceptable.

**File: `scripts/porffor-direct-ab-node-oracle.mjs` (new)**

- Run under the repository's pinned Node version and import the checked-in
  `.ts` with Node type stripping; do not transpile from a separately maintained
  JS file.
- Emit a small JSON record containing source SHA, fixed outputs, iteration
  count, seed formula/version, and checksum. The orchestrator treats this as
  the semantic oracle for every native row, not as a timed performance row.

### 2. Add a fingerprinted benchmark-only adapter for direct Porffor source

**File: `scripts/lib/porffor-direct-source-adapter.mts` (new)**

- Keep this under `scripts/`; it is benchmark tooling, not a JS2 public target
  or production compiler integration.
- Before importing any Porffor internal, run `git -C <root> rev-parse HEAD` and
  call `assertPorfforCommit()` from
  `src/ir/backend/porffor/compat.ts:184-189`. A mismatch must fail before parse,
  codegen, or render.
- In a dedicated one-row worker process, construct the exact direct-C argument
  model equivalent to:

  ```text
  porf c --module -O1 <the-shared-fixture.ts> <generated.c>
  ```

  Add only `--no-gc` for `direct-porffor-bump`; leave `gc` unset for
  `direct-porffor-gc`. Do not pass `--gc=false` (a string-valued preference can
  be truthy), and do not use `porf native`.

- Set `globalThis.file` to the real `.ts` path before dynamically importing
  pinned `compiler/index.js`. Install a temporary `globalThis.compileCallback`
  that captures the module immediately before rendering. Do not import or copy
  Porffor parser/codegen source into JS2.
- In the callback:
  - validate the captured record with `assertPorfforRendererInput()`;
  - assert `entry` names the generated top-level entry before changing it;
  - locate exactly one benchmark function and assert its index/name, one
    `jsval` parameter, `jsval` return, and expected direct-row GC preference;
  - assign `entry = null` on the captured module in place, because the pinned
    callback return value is ignored; then validate that same renderer input
    again before pinned `compiler/index.js` resumes rendering it.
- After render, normalize with `porfforRendererOutputText()`, assert no generated
  `int main(` remains, and assert the expected function declaration exists in
  the C text before generating a wrapper symbol. The fixture name contains
  only safe identifier characters; do not reimplement Porffor's general
  sanitizer.
- Preserve plain direct generated C after entry suppression. The only allowed
  text compatibility edit is the separately asserted pinned `%lld` LP64 cast;
  do not repair object-entry loads/stores in the primary direct rows. Hash the
  rendered C independently from the separate common wrapper.
- Guard every reliance on `compileCallback`, `cg.times`, module fields, boxed
  function ABI, C symbol spelling, `entry` suppression, `porf_init`,
  `porf_data_init`, and GC stack-anchor support behind the exact commit check
  and fail-loud structural assertions. A future Porffor update must change the
  fingerprint and adapter/tests together.
- Run each direct row in a fresh Node worker because Porffor's `Prefs`, compiler
  module state, and callback are process-global. Do not attempt concurrent
  direct compiles in one process.

**No production change expected:** `src/ir/backend/porffor/loader.ts` and
`compat.ts` should remain unchanged unless the implementer demonstrates an
assertion that is both reusable by production JS2 Porffor rendering and cannot
live safely in benchmark tooling. Any such change requires a focused
compatibility test and explicit justification in the issue update.

### 3. Build the two JS2 source-derived rows from #3478 telemetry

**File: `scripts/benchmark-porffor-direct-ab-worker.mts` (new)**

- Accept exactly one row id, source path/SHA, output directory, and mode
  (`optimized` or `sanitize`). Reject unknown options.
- For a JS2 row, call public `compile(source, { target: "linear", allocator,
fileName })` sequentially with:
  - `bump` -> required plan policy `arena-v1`;
  - `analysis-stack` -> required policy `analysis-stack-arena-v1`.
- Capture `getLastLinearIrReport()` immediately after `compile()` and before
  any other compile. Assert:
  - `compiled` contains exactly the fixture export and `rejected` is empty;
  - the report has one exact source-derived function and two stable object
    allocation ids;
  - the plan refers to those same ids and has the required policy;
  - the arena row plans both sites as arena;
  - the stack row proves both sites owned/local/fixed-size/stack-candidate and
    promotes both to stack with mark/restore plus arena overflow fallback;
  - the canonical record layout size is exactly 24 bytes.
- Pass only `report.irModule` and `report.memoryPlan` to
  `lowerIrModuleToPorffor()` with `prefs: { gc: false }`. Never call
  `planLinearMemory()` again, never lower the AST a second time, and never use
  `IrFunctionBuilder`.
- Load/render only through `loadOptionalPorffor()` and
  `porfforRendererOutputText()`. Assert `entry === null`, the benchmark
  function has one raw `f64` parameter/result, no `jsval` locals/ops, and the
  allocation nodes match the plan (`Alloc` for arena; stack
  mark/allocate/restore calls for promoted sites).
- Time and label the JS2 public compile as
  `js2SourceToLinearTelemetryMs`. It includes production linear-Wasm emission
  because #3478 intentionally exposes telemetry through the real public
  linear compile. Do not subtract guessed time or call it a pure front-end
  measurement. Separately time `js2IrToPorfforMs` and `porfforRenderMs`.
- The direct row may use the pinned `cg.times` boundaries for
  `porfforParseMs` and `porfforCodegenMs`; separately report render time. Use
  `null`, not zero, for phases that do not exist in a row.

### 4. Normalize both generated C files to one lane ABI

**File: `scripts/benchmark-porffor-direct-ab-worker.mts`**

- Append a small row-specific wrapper to the rendered C translation unit so it
  can call renderer-internal/static initialization while exporting exactly:

  ```c
  void js2_ab_init(int argc, char **argv, void *stack_top);
  double js2_ab_kernel(double seed);
  ```

- `js2_ab_init` calls `porf_init` and `porf_data_init`. For the default-GC
  direct row it also assigns the live harness-provided stack anchor required by
  Porffor GC; other rows explicitly ignore `stack_top`.
- `js2_ab_kernel` adapts only the boundary:
  - direct rows box `seed` with the pinned `porf_box_num`, call the asserted
    `jsval -> jsval` function, validate/extract its numeric payload, and return
    `double`;
  - JS2 rows call the asserted raw `f64 -> f64` function directly.
- Keep this ABI adaptation outside the timed function body as much as the
  actual lane permits. The direct row's per-call box/unbox is real ABI cost and
  must remain in the timed loop and in the interpretation.
- Record rendered-C bytes excluding the fixed wrapper, wrapper bytes, combined
  lane-C bytes, C SHA-256, object bytes, and executable bytes separately.

**File: `benchmarks/porffor-direct-ab-harness.c` (new)**

- Compile this exact file into a separate object. Reuse that same harness
  object when linking every row in a given mode/platform; do not concatenate a
  different `main` into each generated C file.
- Create a live stack anchor, call `js2_ab_init` before timing, then measure
  exactly 200,000 calls to `js2_ab_kernel` with the shared seed corpus.
- Use `CLOCK_PROCESS_CPUTIME_ID`, a `volatile double` checksum, and `%.17g`.
  Print one machine-readable record with CPU nanoseconds, checksum, and
  `getrusage(RUSAGE_SELF).ru_maxrss`; normalize Linux KiB vs Darwin bytes before
  reporting `peakRssBytes`.
- Initialization, process startup, and output are outside the timed interval.
  RSS remains whole-process high-water RSS and must be labelled that way.

### 5. Orchestrate a balanced, fresh-process four-row experiment

**File: `scripts/benchmark-porffor-direct-ab.mts` (new)**

- Fail unless the worktree is clean for a canonical capture, the Porffor
  checkout equals both the gitlink and `PORFFOR_IR_COMMIT`, Node/Clang are
  available, and the Node oracle succeeds.
- Require Clang for canonical results. Do not silently substitute `cc`, GCC,
  `porf native`, TCC, LTO, or `-march=native`.
- Build the common harness object once per mode. For each lane sample, spawn a
  fresh one-row Node worker, render C, compile the lane as a separate object,
  link it with the common harness object, then execute that lane in a fresh
  native process.
- Use identical optimized flags for all four generated lane objects and the
  harness. Canonical Ubuntu flags:

  ```text
  compile: clang -std=gnu11 -O3 -DNDEBUG -fno-lto
           -ffunction-sections -fdata-sections
           -Werror -Wno-unused-function -c
  link:    clang -O3 -fno-lto -Wl,--gc-sections <harness.o> <lane.o> -lm
  ```

  Record the exact argv arrays. Never let direct Porffor choose independent
  LTO/link flags through `porf native`.

- Run five complete warmup rounds, then 21 measured rounds. Every round runs
  all four lanes once in a deterministic cyclic Latin-square order; record the
  actual order so thermal/cache drift cannot silently favor one lane. Warmup
  samples remain in raw output but never enter summaries.
- Validate every fixed output and every 200,000-call checksum against the Node
  oracle before accepting a sample. Also require each row's generated C hash
  and sizes to remain stable across measured rounds.
- Retain all 21 measured raw samples per row. Summarize CPU milliseconds,
  whole-process peak RSS, total build wall time, and each compile phase with
  median/Q1/Q3. Use one specified quantile algorithm for all metrics: R-7
  linear interpolation, `h = (n - 1) * p`; with 21 samples Q1/median/Q3 are
  sorted indices 5/10/15.
- Compile-phase wall times and runtime CPU time are different metrics. Label
  them separately. Record compiler-worker high-water RSS using
  `process.resourceUsage().maxRSS` and Clang child RSS with the platform time
  tool; do not combine them with runtime RSS.
- Copy representative final C/wrapper/object/executable and all compiler
  command logs into the artifact directory. Temporary per-round directories
  are removed only after their sample has been validated and recorded.

### 6. Keep optimized measurements separate from semantic/sanitizer proof

**File: `tests/issue-3482-direct-porffor-js2-ir-ab.test.ts` (new)**

- With Porffor absent, validate argument/schema helpers and skip only the
  pinned native matrix. With `PORFFOR_NATIVE_REQUIRED=1`, absence of Porffor,
  Clang, a row, or sanitizer support is a failure.
- Run the exact CLI smoke
  `vendor/Porffor/porf c --module -O1 <fixture.ts> <out.c>` to retain proof that
  pinned plain Porffor directly accepts the shared TypeScript file.
- Exercise the programmatic direct adapter under both GC preferences and the
  #3478 source-derived JS2 pair under both plans. Assert source SHA, ABI
  metadata, no generated `main`, common wrapper ABI, outputs, and checksum.
- Build a separate sanitizer harness/object set with:

  ```text
  -std=gnu11 -O1 -g -fno-lto -Werror -Wno-unused-function
  -fsanitize=address,undefined -fno-omit-frame-pointer
  ```

  Link with the same sanitizer flags and `-lm`. Run a deterministic bounded
  correctness stress for every row with
  `ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=1` and
  `UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1`. Leak detection is disabled
  because arena/bump rows intentionally retain memory until process exit; all
  address, bounds, lifetime, alignment, and undefined-behavior checks remain
  enabled. Plain pinned Porffor's known misaligned dynamic-object `f64`
  accesses are an expected recorded result, not a skipped row: both direct
  rows must fail with the exact UBSan misaligned-address class. Both JS2 rows
  must complete all 20,000 calls with the exact checksum and no sanitizer
  finding. Any different direct failure or any JS2 finding fails the test.

- Never merge sanitizer samples or `-O1` artifact sizes into the optimized
  benchmark JSON/table.

### 7. Declare a reproducible runner and commands

**Files: `package.json`, `pnpm-lock.yaml`**

- Add `tsx` as an exact, lockfile-backed development dependency (for example
  through `pnpm add -D -E tsx` during implementation) rather than relying on a
  transitive optional peer or network-fetched `npx --yes tsx`.
- Add package scripts with stable names, using the local binary:
  - `benchmark:porffor-direct-ab` for optimized capture;
  - `test:porffor-direct-ab` for the focused semantic/sanitizer test.
- No command in the new files or documentation may use undeclared `npx`,
  `npx --yes`, or a floating remote runner.

### 8. Emit a versioned raw schema and auditable artifacts

**Files: `benchmarks/results/porffor-direct-ab/latest.json` and
`benchmarks/results/porffor-direct-ab/latest.md` (new)**

- `latest.json` is the canonical checked-in Ubuntu x86_64 capture from a manual
  workflow dispatch. It stores every warmup/measured sample, not only the
  summary. Use this top-level shape (additional fields may be additive):

  ```json
  {
    "schemaVersion": 1,
    "generatedAt": "ISO-8601",
    "repository": { "commit": "40-hex", "dirty": false },
    "dependency": {
      "issue": 3478,
      "pr": 3432,
      "requiredGreenHead": "4c7e3a01d31275163ec9940e864c7292f6961b20",
      "validatedFixCommit": "559109b723d8c08c0469594db9591f40b1fdfad0",
      "supersededPatchEquivalentCommit": "2509181c33516ca1fe2462f7008650f2d99eb129"
    },
    "environment": {
      "os": "linux",
      "arch": "x64",
      "cpu": "...",
      "node": "...",
      "pnpm": "...",
      "clang": { "path": "...", "version": "..." },
      "porfforCommit": "60a1d41d60580ff4faa38ffd5f7783d23df68bad"
    },
    "fixture": {
      "path": "tests/fixtures/porffor-source-to-native-canary.ts",
      "sha256": "64-hex",
      "bytes": 0,
      "function": "porfforSourceNativeCanary",
      "iterations": 200000,
      "oracle": { "fixedOutputs": [], "checksumDecimal": "..." }
    },
    "methodology": {
      "warmupRounds": 5,
      "measuredRounds": 21,
      "freshProcesses": true,
      "initTimed": false,
      "timer": "CLOCK_PROCESS_CPUTIME_ID",
      "quantile": "R-7",
      "compileFlags": [],
      "linkFlags": [],
      "interleaveOrders": []
    },
    "rows": [
      {
        "id": "direct-porffor-gc",
        "valueAbi": "boxed-jsval",
        "allocation": {
          "policy": "porffor-default-gc",
          "scope": "global",
          "objectBytes": 56,
          "objectBytesIsEstimate": true
        },
        "safety": {
          "generatedC": "plain-pinned-porffor",
          "sanitizerExpectation": "misaligned-object-entry-ubsan",
          "performanceAuthority": "ub-contaminated-non-authoritative",
          "finding": {
            "kind": "misaligned-dynamic-object-f64",
            "objectEntryStrideBytes": 20,
            "payloadOffsetBytes": 8,
            "secondEntryPayloadOffsetBytes": 28,
            "requiredAlignmentBytes": 8,
            "rawAccessSites": { "gcLoads": 2, "entryStores": 3, "entryLoads": 1 }
          }
        },
        "validity": {
          "performanceAuthority": "ub-contaminated-non-authoritative",
          "knownUndefinedBehavior": true
        },
        "artifacts": {
          "renderedCBytes": 0,
          "wrapperBytes": 0,
          "objectBytes": 0,
          "executableBytes": 0,
          "renderedCSha256": "64-hex",
          "cSha256": "64-hex"
        },
        "warmups": [],
        "samples": [
          {
            "round": 0,
            "order": 0,
            "compilePhasesMs": {},
            "compilerPeakRssBytes": 0,
            "clangPeakRssBytes": 0,
            "runtimeCpuNs": 0,
            "runtimePeakRssBytes": 0,
            "checksumDecimal": "..."
          }
        ],
        "summary": {
          "runtimeCpuMs": { "q1": 0, "median": 0, "q3": 0 },
          "runtimePeakRssBytes": { "q1": 0, "median": 0, "q3": 0 },
          "compilePhasesMs": {}
        }
      }
    ],
    "interpretation": {
      "endToEndConflates": ["frontend", "value-abi", "layout", "ir", "allocator"],
      "policyIsolationPair": ["js2-porffor-arena-v1", "js2-porffor-analysis-stack-arena-v1"]
    }
  }
  ```

  In `sanitize` mode, each row retains one sample verdict rather than a
  performance summary. Direct samples record
  `verdict: "expected-ubsan-failure"`, nonzero process status/signal, exact
  diagnostic class/line, and stdout/stderr hashes; their output/checksum are
  `null` because UBSan aborts during fixed canaries. JS2 samples record
  `verdict: "clean"`, status zero, and exact fixed outputs/checksum. A missing
  row, a different direct failure, or any JS2 sanitizer finding is invalid.

- Store checksums as decimal strings. Use bytes and nanoseconds as integer base
  units; derive display milliseconds only in summaries.
- `latest.md` is generated from that JSON and includes provenance, exact
  commands/flags, C/executable sizes, phase medians/quartiles, CPU/RSS
  medians/quartiles, and the interpretation caveat. It may not omit an
  unfavorable row or replace raw samples with selected runs.
- Do not auto-commit benchmark output. Updating `latest.*` is an intentional
  reviewed change from one complete workflow artifact.

**File: `docs/ir/porffor-direct-ab.md` (new)**

- Document the pipeline, four rows, common ABI/harness, source hash, sampling
  and quantile rules, portability boundary, raw-artifact path, and the exact
  conclusions the data can/cannot support.
- State prominently that direct standard-number `jsval` vs JS2 raw `f64`,
  approximately 56-byte dynamic objects vs 24-byte fixed records, and global
  Porffor allocation vs JS2 per-site escape-based promotion are real end-to-end
  differences. Only JS2 arena-vs-stack is a policy-isolating comparison.
- Link the checked-in raw JSON and record the workflow run URL/id used to
  refresh it. Artifact URLs expire; the checked-in raw sample is authoritative.

**File: `docs/ir/porffor-allocation-policy-proof.md`**

- Add a short scope note near the title/reproduction section: #3300 is a
  hand-built-IR policy proof with mismatched source paths and no source compile
  timing; it must not be cited as the direct compiler A/B. Point to #3482's
  methodology/results for the source-to-native comparison.
- Replace its `npx --yes tsx` reproduction command with the declared local
  package runner when #3482 adds one; do not rewrite its historical numbers.

### 9. Add advisory correctness CI and dispatch-only performance CI

**File: `.github/workflows/porffor-direct-ab.yml` (new)**

- Use an advisory semantic/sanitizer job on relevant pull-request paths and on
  `workflow_dispatch`. It is not a branch-protection context and does not run
  on `merge_group`.
- Checkout with `submodules: false`, then explicitly initialize only Porffor:

  ```sh
  git -c submodule.porffor.update=checkout \
    submodule update --init --checkout vendor/Porffor
  ```

  Verify checkout HEAD equals the superproject gitlink and
  `PORFFOR_IR_COMMIT` before install/test. This override is mandatory because
  `.gitmodules` intentionally declares `update = none`.

- Pin the repository's Node/Corepack/pnpm setup, require Ubuntu Clang, install
  with `pnpm install --frozen-lockfile`, and set
  `PORFFOR_NATIVE_REQUIRED=1`. The semantic job runs the four-row ASan/UBSan
  test and fails rather than skipping.
- A separate performance job runs **only** for `workflow_dispatch`, after
  semantic correctness. It executes the optimized benchmark without
  sanitizers, regression thresholds, baseline diffs, pass/fail speed ratios,
  or automatic commits.
- Upload `latest.json`, generated Markdown, representative C/wrappers,
  objects/executables, compiler logs, and environment/command manifests as one
  artifact even when a later step fails. Give the artifact a non-trivial
  retention period suitable for review.
- Performance CI validates schema, row completeness, source/checksum equality,
  pin equality, and sample counts only. Runtime magnitude is informational;
  noisy thresholds are explicitly out of scope.

**File: `docs/ci-policy.md`**

- List the workflow as advisory and explain the split between PR semantic
  sanitizer validation and dispatch-only optimized measurements. Do not add it
  to required checks.

## Fairness invariants

The implementation must fail loudly if any invariant is false:

1. One source path, byte length, and SHA feed Node, direct Porffor, and both
   JS2 rows. There is no JavaScript twin.
2. Direct rows use pinned Porffor's real `.ts` parser/codegen path. JS2 rows
   use #3478's exact source-derived `(IrModule, LinearMemoryPlan)` pair.
3. All rows render with the same Porffor commit and external Clang version.
4. Direct GC/bump differ only by Porffor's global GC preference. JS2
   arena/stack differ only by the planner policy.
5. All rows expose the same separate-object lane ABI and link to the same
   harness object with identical optimized flags and no LTO.
6. Every timed native sample is a fresh process, initializes before timing,
   performs exactly 200,000 calls, and matches the Node checksum.
7. Five full warmup rounds precede 21 complete, interleaved measured rounds;
   all raw samples and actual row order are retained.
8. ASan/UBSan uses separately built artifacts and never contributes optimized
   runtime, size, RSS, or compile summaries.
9. Plain direct rendered C retains its raw object-entry accesses. Its known
   UBSan failure is explicit, and direct optimized timings are always labelled
   UB-contaminated and non-authoritative.

## Portability

- Canonical comparable results are Ubuntu Linux x86_64 with Clang and
  `CLOCK_PROCESS_CPUTIME_ID`. The dispatch workflow is the authoritative
  capture environment.
- Darwin may run locally using the same compile flags and
  `-Wl,-dead_strip` instead of GNU `--gc-sections`; normalize Darwin
  `ru_maxrss` units. Mark those results as a different environment and never
  merge them into the Ubuntu summary.
- Windows native timing/linking is unsupported in this slice; use the Ubuntu
  workflow/WSL rather than substituting timers or linkers silently.
- Record CPU model, architecture, OS/kernel, Node, pnpm, Clang path/version,
  exact flags, repository SHA/dirty state, and Porffor gitlink/checkout/pin in
  every artifact.
- No `-march=native`, LTO, `porf native`, GCC fallback, TCC, or cross-machine
  ratio is permitted in the canonical table.

## Risks and mitigations

- **False equivalence from the old benchmark:** #3300's Porffor module is
  hand-built and its linear side uses different source. Keep its numbers and
  purpose separate and label them explicitly.
- **Unstable Porffor internals:** direct source compilation relies on globals,
  callback timing, module shape, and C symbol spelling. Assert the exact commit
  before import, validate every observed shape/ABI, and isolate each row in a
  fresh process.
- **Generated `main` contaminates linking/timing:** clear `entry` before render
  and assert no generated main remains; only the common harness owns `main`.
- **GC stack-root bug:** pass a live anchor from harness `main` to the lane init
  wrapper and set it only in the pinned direct-GC row before timed calls.
- **Optimizer deletes the kernel:** use a separate harness object, no LTO, an
  external lane symbol, volatile checksum, and oracle validation.
- **Compile telemetry overclaim:** JS2's public dependency seam includes
  linear-Wasm emission. Preserve its honest coarse label rather than claiming
  a pure source-to-SSA phase or modifying production just to manufacture one.
- **Timer/RSS unit drift:** use CPU ns and bytes as base units, normalize
  platform RSS explicitly, and record all raw fields/units in schema v1.
- **Thermal/cache/order drift:** fresh processes plus a recorded Latin-square
  row order balance positions; quartiles and all raw samples expose spread.
- **Sanitizer/optimized conflation:** separate builds, commands, artifacts, and
  workflow jobs; never copy sanitizer sizes/times into optimized results.
- **Plain direct Porffor undefined behavior:** do not normalize the offending
  generated accesses. Require the pinned direct UBSan failure, require clean
  JS2 rows, retain raw stderr and C hashes, and mark direct optimized timings
  UB-contaminated/non-authoritative.
- **Benchmark runner drift:** declare and lock `tsx`; do not rely on floating
  `npx --yes` downloads.

## Implementation notes (2026-07-20)

- Prerequisite PR #3432 merged as
  `eb661196016e06306d51cd39fb72294730eba535`. The implementation branch then
  merged that exact latest `origin/main`; it contains required green head
  `4c7e3a01d31275163ec9940e864c7292f6961b20` and the reachable
  patch-equivalent Ubuntu fix `559109b723d8c08c0469594db9591f40b1fdfad0`.
- The branch was created from exact green prerequisite head
  `4c7e3a01d31275163ec9940e864c7292f6961b20`, then planning commit
  `f891b3e0f4327c9f0c3ac2394bb95d48f5821cfc` was cherry-picked. No source
  fixture or telemetry was copied or reconstructed.
- Pinned direct Porffor renders the one source parameter plus hidden
  `#newtarget` and `#this` as three `jsval` C parameters. Its suppressed
  top-level `#main` remains necessary for source initialization, so the direct
  wrapper calls that symbol during lane initialization before timing. Both
  facts are exact-commit structural assertions, not generalized Porffor APIs.
- The first all-row ASan/UBSan run exposed misaligned `f64` accesses in pinned
  direct Porffor's 20-byte dynamic-object entries. With the payload at offset
  8, the second entry payload is at byte offset 28 and violates eight-byte
  alignment. A briefly attempted benchmark-only unaligned-helper rewrite was
  rejected before final capture because it would benchmark a repaired
  compiler rather than plain Porffor.
- The final adapter only counts the unchanged raw sites: three `entryPtr`
  stores and one load in each direct row, plus two GC traversal loads in the
  GC row. The separately built sanitizer matrix must record both direct rows'
  exact `runtime error: ... misaligned address` failure and must require both
  JS2 rows to complete 20,000 calls with fixed outputs
  `[-535, 235, 675, 3645]` and checksum `4711770`. No suppression or production
  `src/**` change is used. Optimized direct results are retained but explicitly
  UB-contaminated and non-authoritative.
- Corrected local evidence command:
  `PORFFOR_DIRECT_AB_REQUIRED=1 PORFFOR_DIRECT_AB_TEST_OUTPUT=.tmp/porffor-direct-ab-safety-corrected pnpm run test:porffor-direct-ab`.
  Direct GC aborts at representative `rendered.c:3006` with
  `runtime error: store to misaligned address` (rendered-C SHA-256
  `8dd5f0be49386b638cf3a631393573fe77aaecdeef2f1ff9ca6d3dc77660c93c`);
  direct bump aborts at `rendered.c:828` with the same class (SHA-256
  `9edf0adba0ea04679b3eb76adc375da533467ff409879b50f0f90854c4ed0517`).
  Both JS2 rows exit zero with the exact checksum. Raw stderr hashes/logs and
  exact argv are retained in that artifact; schema revalidation passes through
  the package runner.

### Complete local optimized capture

Command:
`pnpm run benchmark:porffor-direct-ab -- --output .tmp/porffor-direct-ab-darwin-20260720`.
The clean run at `d7386a1a2179b4160cd058c2df5c3651a8f232c7` completed five
warmups and 21 measured fresh-process samples per row, each with 200,000 calls,
fixed outputs `[-535, 235, 675, 3645]`, and checksum `46965020`.

This is **noncanonical Darwin/arm64 evidence only**: Apple M1 Pro, Darwin
25.3.0, Node 22.16.0, pnpm 10.30.2, and Apple Clang 17.0.0. It has no workflow
URL and must not be compared with another machine. Raw JSON SHA-256 is
`f87ceaaae547a2d7adbed87916e25019b2190db5d23becef9a9fd5b08d66376c`.

| Row | Authority | CPU ms Q1 / median / Q3 | RSS Q1 / median / Q3 | Total build ms Q1 / median / Q3 | C / object / executable bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| direct GC | UB-contaminated, non-authoritative | 17.925 / 18.521 / 19.900 | 27,639,808 / 27,639,808 / 27,656,192 | 1716.508 / 1730.566 / 1748.980 | 187,238 / 127,984 / 108,568 |
| direct bump | UB-contaminated, non-authoritative | 12.061 / 12.405 / 12.746 | 23,773,184 / 23,773,184 / 23,773,184 | 1395.607 / 1408.487 / 1427.896 | 105,860 / 75,968 / 73,736 |
| JS2 arena | within-capture informational | 1.457 / 1.484 / 1.523 | 10,911,744 / 10,911,744 / 10,911,744 | 1536.207 / 1574.960 / 1594.309 | 28,818 / 2,280 / 34,056 |
| JS2 stack/arena | within-capture informational | 0.727 / 0.731 / 0.748 | 1,310,720 / 1,310,720 / 1,310,720 | 1551.339 / 1570.830 / 1604.284 | 29,991 / 3,880 / 34,056 |

No direct-vs-JS2 speed winner is valid because both direct rows have known UB
and the end-to-end ABI/layout/frontend confounders remain. Only the
sanitizer-clean JS2 policy pair isolates allocation policy on this same
machine: its stack/arena median CPU was 0.731 ms versus 1.484 ms for arena
(50.74% lower), and median whole-process RSS was 1,310,720 versus 10,911,744
bytes (87.99% lower). Those directions are local microbenchmark observations,
not universal or cross-machine claims. The complete raw samples and generated
table are retained under `benchmarks/results/porffor-direct-ab/`.

## Acceptance criteria

- [x] #3478 / PR #3432 is merged, and main contains exact green head
      `4c7e3a01d` plus reachable patch-equivalent Ubuntu fix `559109b723d8`.
- [x] One checked-in `.ts` byte sequence and SHA feed all four rows and a Node
      oracle; no `.js` twin or hand-built replacement IR exists.
- [x] Pinned direct Porffor accepts the file through the exact
      `porf c --module -O1` path, and the programmatic adapter suppresses only
      generated `main` before render; apart from the asserted `%lld` cast, its
      object-entry C remains plain and independently hashed.
- [x] Every direct internal assumption is commit-fingerprinted and
      structurally asserted before its value is used.
- [x] JS2 rows consume the exact #3478 source-derived `IrModule` and
      `LinearMemoryPlan` with no re-lowering or re-planning.
- [x] The four required rows are present and honestly report boxed `jsval` vs
      raw `f64`, approximately 56-byte dynamic vs 24-byte fixed records, global
      Porffor policies vs JS2 per-site promotion, and allocator names.
- [x] All rows use one separate-object lane ABI/harness, one Clang version,
      identical optimized compile/link flags, no LTO, and init outside timing.
- [x] The benchmark records five warmup and 21 interleaved fresh-process
      measured rounds, 200,000 calls/checksum per sample, CPU time, Q1/median/Q3,
      RSS, C/object/executable size, and compile phases.
- [x] Every output/checksum matches the Node oracle before a sample enters the
      result; all 21 raw samples and actual orders are retained.
- [x] ASan/UBSan runs separately for all four rows, records both exact expected
      plain-direct misalignment failures, requires both JS2 rows clean, and is
      advisory CI rather than an optimized performance input.
- [x] Every direct optimized timing is labelled UB-contaminated and
      non-authoritative in raw JSON, generated Markdown, and methodology docs.
- [x] Performance CI is `workflow_dispatch` artifact-only, has no noisy speed
      thresholds, initializes Porffor with explicit `update=checkout`, and
      cannot pass with a skipped row.
- [x] `latest.json`, generated `latest.md`, and the methodology document contain
      provenance, exact commands, the required caveat, and the policy-isolating
      pair; if canonical Ubuntu is unavailable before merge, a complete local
      capture is retained with an unmistakable noncanonical Darwin label and
      no cross-machine claim.
- [x] The existing #3300 note is explicitly labelled a hand-built-IR policy
      proof, not the direct compiler comparison.
- [x] New commands use a declared lockfile-backed runner; no undeclared
      `npx --yes tsx` is introduced.
- [x] No public Porffor target, second parser, JS2 planner vocabulary change,
      allocation-policy change, or production compiler change lands unless a
      separately demonstrated blocker makes it necessary.

## Validation commands

After #3478 lands, the implementation PR should provide these stable commands
(exact script names may not drift without updating this issue):

```sh
git -c submodule.porffor.update=checkout \
  submodule update --init --checkout vendor/Porffor
test "$(git -C vendor/Porffor rev-parse HEAD)" = \
  "$(git rev-parse HEAD:vendor/Porffor)"

pnpm run test:porffor-direct-ab
pnpm run benchmark:porffor-direct-ab -- \
  --output .tmp/porffor-direct-ab

pnpm exec vitest run \
  tests/issue-3482-direct-porffor-js2-ir-ab.test.ts \
  tests/issue-3478-porffor-source-to-native-canary.test.ts \
  tests/issue-3295-porffor-compat.test.ts \
  tests/issue-3297.test.ts \
  tests/issue-3299.test.ts \
  tests/issue-3300.test.ts --reporter=dot

pnpm run typecheck
pnpm run build
pnpm run lint
pnpm run format:check
pnpm run check:linear-ir
pnpm run check:ir-fallbacks
pnpm run check:dead-exports
pnpm run check:issues
pnpm run check:issue-ids
GATE_BASE=origin/main pnpm run check:issue-ids:against-main
```

Do not run full local test262 for this benchmark/tooling slice. Normal PR and
merge-group CI own broad conformance; the optional pinned workflow owns native
Porffor semantic/sanitizer validation.

## Non-goals

- Declaring JS2 or direct Porffor universally faster from one fixed-record
  microbenchmark.
- Treating direct GC, direct bump, JS2 arena, and JS2 stack as equivalent
  allocator implementations.
- Isolating frontend, ABI, layout, and allocation simultaneously in an
  end-to-end pair; the issue reports those confounders instead.
- Replacing #3300's backend-neutral allocation-policy proof.
- Adding a public `target: "porffor"`, native CLI, stable C API, second parser,
  or production dependency on `vendor/Porffor`.
- Adopting Porffor `jsval`, dynamic object layouts, builtins, GC, or global bump
  policy in JS2.
- Adding a managed heap/root-slot/type-id contract for JS2 raw pointers.
- Expanding source/IR legality beyond the bounded #3478 fixture.
- Performance gating, auto-updating baselines, auto-committing results, or
  comparing results across unlike machines/toolchains.
- Using `porf native`, LTO, `-march=native`, or sanitizer timings as the A/B.

## Implementation handoff

Start from main after #3432 lands, verify the dependency's exact fixture and
telemetry first, then implement the benchmark-only adapter and correctness test
before the performance orchestrator. A valid handoff produces one auditable
artifact whose raw samples can reproduce every displayed number and whose
interpretation explicitly limits policy claims to the JS2 arena-vs-stack pair.
