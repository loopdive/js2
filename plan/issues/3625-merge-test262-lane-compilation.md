---
id: 3625
title: "CI: merge the compilation of the two test262 lanes so the corpus is compiled once, not twice"
status: wont-fix
assignee: ttraenkler/opus-3622
sprint: current
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: ci
area: ci
goal: maintainability
related: [3431, 3433, 3450, 3461, 3462, 3470]
created: 2026-07-25
completed: 2026-07-25
updated: 2026-07-26
---

# Merge the two test262 lanes' compilation — MEASURED, recommend closing

> Renumbered **3622 → 3625**: a concurrent `--allocate` in the other lane
> reserved 3622 and landed first (`plan/issues/3622-lastindexof-...`). The
> `assignee` slug keeps the original agent name. Branch/PR names still say 3622.

## Problem as posed

`.github/workflows/test262-sharded.yml` runs a two-entry `target` matrix — `gc`
(js-host) and `standalone` — over the same ~43k-file corpus. Both lanes read,
parse, typecheck and build IR for the same source; only the backend lowering
differs (`--standalone` forces `nativeStrings` and refuses JS-host imports). The
proposal: do the shared front-end work once and emit both targets, so the corpus
is traversed once instead of twice.

Three candidate designs, most to least ambitious:

1. **One process, two lowerings** — parse/check/IR once per file, emit both targets.
2. **Cache the shared front-end artifact** across the lanes' shards (per-SHA).
3. **Merge the matrix only** — one shard does both targets for its slice.

## Verdict

**Do not build. Close.** Two independent findings kill it:

- The shared front end is **1.9 %** of both-lane compile time (measured, n = 90).
  Sharing it saves **≤ 0.9 %**. The optimistic ceiling — front end shared AND
  every type-checker query of the second lowering served from the first
  lowering's memo cache — is **13.2 %**, and that ceiling is **unreachable**
  because the two lanes do not check the same source text (below).
- The parallelism premise does not hold: the two lanes **already run
  concurrently** in ONE 106-entry matrix, so merging the matrix frees no
  capacity and saves no wall clock. Design 3 is a pure cost.

The lever that _is_ real sits elsewhere and is already scoped: the assembled
**harness prefix is ~72 % of host-lane compile cost** (independently reproduced
here; matches #3433's "75–97 % of every compile"). That is #3450 / #3461 / #3462,
parked on a stakeholder decision — roughly **5× larger** than the best case here.

## 2026-07-26 follow-up: persistent language service

#700 / PR #3650 changes one implementation fact below: the incremental compiler
can now retain a versioned TypeScript Language Service, `Program`, checker, lib
snapshots, and document registry across compilations. Identical input no longer
requires intentionally rebuilding a fresh `Program` and checker on every call.

That improvement does **not** change this issue's verdict:

- host and standalone still hand different processed source to TypeScript in
  87/90 measured files because the standalone-only pre-parse transforms remain;
- the measured parse/program/bind share is still 1.94%, so sharing only the
  unchanged front-end work has a ≤0.91% both-lane ceiling;
- target-sensitive checker queries remain nested in generation, and IR/runtime
  lowering is not target-neutral;
- the CI target lanes still run concurrently and must keep independent failure
  domains.

The exact maintained shard-1/57 A/B performed for #700 also found that retaining
the service past the old 100-test reset did not move aggregate compile time:
summed `compile_ms` was 682,101 ms with the reset and 681,904 ms without it
(0.03% lower, effectively identical). Wall time was noisy (reset-free mean 1.1%
faster, with the paired ordering reversing), while all 836
`file + strict + status` tuples were identical.

The active follow-up is #3451: key and compile the repeated literal harness
prefix separately, then link body-only objects after the linker can preserve the
shared Test262 realm. Its 2026-07-26 corpus inventory found 64 strict-neutral
harness sources, versus 82,628 potential harness-bearing variants per lane.

## Measurement

### Method

Probe replicates exactly what `scripts/test262-worker.mjs doCompile()` does in
`originalHarness` mode — the path both CI lanes take: same
`assembleOriginalHarness(...).primary.source` compile unit, same options
(`allowJs`, `fileName: "test.js"`, `sourceMap: true`, `emitWat: false`,
`skipSemanticDiagnostics: true`, `deferTopLevelInit: true`), differing **only** in
`options.target` (`undefined` for the host lane — `TEST262_TARGET=gc` maps to
`undefined` in `parseTest262Target()` — vs `"standalone"`).

Phase timing came from temporary env-gated `performance.now()` hooks placed in
`src/compiler.ts` around: the standalone pre-parse elision, the
parse+`createProgram`+bind+syntactic-diagnostics block, `generateModule`,
`emitBinaryWithSourceMap`, and `generateDts`/`generateImportsHelper`. All lazy
`ts.TypeChecker` work performed _during_ codegen was captured separately by
wrapping `entryAst.checker` in a timing Proxy — this catches every query
regardless of call site (oracle or raw `checker.*`) and is **nested inside**
`generate`, so it is a subset, not an addend. The Proxy adds per-call overhead,
so the checker share is an **over**-estimate — which biases the ceiling in favour
of building, and it still comes out small.

The instrumentation was reverted before this PR; the probe lives in `.tmp/`
(gitignored). A positive control asserted the hooks actually fired on the first
sampled file — the first pilot run reported all-zero phases (a detached
accumulator object) and would otherwise have read as "the front end costs
nothing".

**Sample**: 90 files, uniform-random over the full eligible corpus (48,092 files
discovered by `findTestFiles` across `TEST_CATEGORIES`, minus `shouldSkip`),
deterministic seed 20260725, first 10 measured files discarded as V8 warm-up.
Single process, no execution — compile only.

### Results (n = 90, 206.8 s of measured compile across both lanes)

| Phase                                                     | Share of both-lane compile time |
| --------------------------------------------------------- | ------------------------------- |
| front end (parse + program + bind + syntactic diags)      | **1.94 %**                      |
| standalone pre-parse elision (#3418)                      | 0.18 %                          |
| `generate` (IR + codegen)                                 | 84.74 %                         |
| — of which `ts.TypeChecker` (nested)                      | 24.87 %                         |
| `emit` (binary + source map)                              | 9.46 %                          |
| `.d.ts` + imports helper                                  | 0.08 %                          |
| unaccounted (pre-parse rewrites, diagnostics loop, widen) | 3.60 %                          |

- **Max saving if the front end is shared: 0.91 %.**
- **Max saving if front end AND all checker work is shared: 13.15 %.**

Robustness: the most expensive single file is 6.0 % of the grand total and the
top 5 are 15.9 % — no outlier domination. Median per-file front-end share 1.85 %
tracks the aggregate 1.94 %. A second independent run (n = 60, different phase
set) reproduced 1.34 % / 12.35 %.

### The blocker for design 1: the lanes do not check the same source

`compileSourceSync` applies two **target-conditional pre-parse source rewrites**
before the checker ever sees the text:

- `injectIteratorStaticsPrelude` — standalone/wasi only;
- `elideWithIrIds` (#3418) — standalone/wasi only: blanks dead pure top-level
  bindings so unreachable bodies do not register host imports.

Measured: the source handed to the checker differed between the two lanes in
**87 of 90** files, and the elision changed the source in **87 of 90**. Byte
lengths are identical (elision blanks with same-length whitespace) — an
equality-by-length check would have wrongly concluded the sources match.

This is not incidental. The test262 compile unit is harness + body, and most of
the harness's top-level functions are unused by any given test, so elision fires
on essentially every standalone compile. Sharing one parsed/checked AST between
the lanes therefore requires either eliding on the host lane too (a change to the
**published host baseline**) or dropping elision on standalone (which
re-introduces the host-import registrations #3418 exists to remove — and
standalone is a required gate with its own floor guard, #1897/#2097). Both are
oracle-affecting changes far out of proportion to a ≤13 % compile saving.

At measurement time, the 13.2% ceiling additionally assumed a `ts.Program` /
`ts.TypeChecker` shared across two lowerings while
`IncrementalLanguageService.analyze` built a fresh Program and checker every
call (#973). #700 / PR #3650 has since replaced that behavior with versioned,
persistent language-service state. As documented in the follow-up above, this
removes the stale implementation objection but not the source-identity blocker:
the two target snapshots still differ before TypeScript sees them, so one
checked tree cannot represent both lanes.

### The blocker for design 3: the lanes already run concurrently

`test262-shard-mg` is a **single job** with a **single 106-entry `matrix.include`**
(`scripts/gen-test262-mg-matrix.mjs`: 72 js-host + 34 standalone). Both lanes are
dispatched in the same wave — the generator's own note records that the earlier
34/19 split "started all 53 jobs within one second". The corpus is therefore not
traversed twice _in sequence_; the two traversals are already overlapped across
one runner pool.

Consequences:

- Merging the matrix into 106 shards that each emit both targets is the **same
  total work over the same 106 runners** — the same bin-packing, the same job
  count, the same per-job fixed overhead. Zero wall-clock gain.
- The "~14 idle runners" are not idle: `MERGE_GROUP_RESERVED_RUNNERS = 14` is a
  deliberate reservation for the overlapping `quality` / `equivalence-gate` /
  differential / gate jobs that must run beside the shard matrix.
- There is no intra-shard parallelism headroom either: every shard already runs
  `COMPILER_POOL_SIZE=4` on its 4 cores.

And it has a real cost: design 3 would put both lanes' verdicts for a slice in one
job, so one lowering's crash, OOM or 25-min timeout takes out the other lane's
results for that slice. The two lanes are separate **required** gates; that
coupling is exactly the failure mode the current split makes impossible.

## Correction to the 2.13:1 premise

The 72/34 split is sized on a **2.13:1** measured js-host:standalone work ratio.
That ratio is **not** a per-file compile-cost asymmetry. This probe measured the
per-compile host:standalone ratio at **0.99:1** (n = 90) and **1.18:1** (n = 60) —
the two lanes cost about the same _per compile_.

The lane-total difference comes from **variant count**: the strict rerun fires
only when the primary variant passed (`tests/test262-shared.ts` —
`if (r.status === "pass" && harnessAssembly.strictRerun)`). The host lane passes
far more tests, so it performs far more strict recompilations. The workflow's own
note says the same thing ("Host also reaches more passing tests and therefore
performs more strict-mode recompilations").

**Actionable consequence, independent of this issue**: the 72/34 split is a
function of the _standalone pass rate_. As standalone conformance improves
(goal `standalone-gap`), standalone's strict-rerun count rises, its lane gets
more expensive, and the split drifts out of balance — the lanes stop finishing
together and wall clock is set by whichever lane is now under-provisioned. The
split should be re-derived from lane timings periodically rather than treated as
a constant. This is cheap and is where the shard-count attention belongs.

## Where the real win is

Same probe, same 60-file sample, comparing the full assembled unit against the
body-only unit (`assembleNativeHarness(...).bindingShim + body` — the #3461 split):

|                | bytes              | share of compile cost  |
| -------------- | ------------------ | ---------------------- |
| harness prefix | 76 % of unit bytes | **72.3 % (host lane)** |
| test body      | 24 %               | 27.7 %                 |

Cost share tracks byte share closely, which is the consistency check one wants.
This independently reproduces #3433's "the assembled prelude is 75–97 % of every
compile" on a fresh random sample. (The standalone body-only figure, 48 %, is not
trustworthy — the binding shim's `globalThis` reads take a different path under a
host-import-refusing target — so only the host number is quoted.)

`#3461` already built the host-lane split (`TEST262_ORACLE_MODE=fast` + harness
prefix executed natively + binding shim), and `#3462` built the two-baseline lane
stamping so `diff-test262` refuses to compare a fast candidate against an honest
baseline. **`TEST262_ORACLE_MODE` is set by no workflow** — the fast oracle is
built and switched off, parked behind the `#3450` stakeholder decision
(ORACLE*VERSION 8 → 9; a native-JS harness changes what a verdict \_measures*:
cross-boundary `Test262Error` identity, `verifyProperty` MOP on wasm-created
objects, script-global sharing).

That is the ~5× bigger lever, it is mostly built, and it is blocked on a decision
rather than on engineering. Effort aimed at test262 CI compile cost belongs there,
not here.

## Acceptance

- [x] Shared fraction quantified with stated method and sample size.
- [x] Recommendation delivered: **close**; do not build any of the three designs.
- [x] Verdict independence constraint analysed — design 3 would violate it.
- [x] Shard-count premise re-derived; follow-up recorded (re-tune from lane
      timings as standalone conformance moves, not from a frozen 2.13 constant).
