---
id: 7002
title: "ir gates: `trackIrOutcomes` is not observation-only (it flips real test262 files from success to failure) and the only detector of production compile-twice (`duplicate-direct-function-body-receipt`, 24 of 25 invariants in a test262 stride) exists only under telemetry; the IR ledger is measured on a 5-file corpus (38/38 READY) while a test262 stride shows 3% IR bodies / 90% legacy — add a stride ledger and make telemetry side-effect free"
status: in-progress
sprint: current
created: 2026-10-15
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: ir-telemetry, ci-gates
goal: ir-full-coverage
related: [3518, 3519, 3341, 7001, 7070, 7071]
---

# IR gate integrity: telemetry changes results; the ledger does not see test262 scale

Found by the 2026-10-15 audit (measurement). Numbers below were measured in-container on main `5586e2d5`.

## Evidence

- `compile(src, { target: "standalone" })` on `test262/test/language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-math.js` → `success: true`; the same call with `trackIrOutcomes: true` → `success: false` with four `IR outcome invariant [body-emission-evidence] … [duplicate-direct-function-body-receipt]` errors (each accessor `directBodyEmissions: 2`). The WAT has no duplicate function names, so the first direct compile is discarded — compile-twice on the production path, visible only when telemetry is on, and when telemetry is on it fails the compile.
- Stride-40 standalone sweep (1,353 files, 1,793 terminal units, telemetry on): emitted 57, both 13, legacy 1,605, invariant 70 (`patch:body-emission-evidence` 24/25 in the stride-120 crosstab; the other is `build:unexpected-internal-throw: Cannot read properties of undefined (reading 'getLineAndChar…')`). By unit kind (stride 120): functions 43/138 IR, class members 11/135, module-init 3/392. 193/1,353 files produced NO telemetry rows at all.
- `select:body-shape-rejected` = 1,234 of 1,634 rejections, while `scripts/ir-fallback-baseline.json` says the bucket is 0 (playground corpus).
- IR-first ON vs OFF on 670 test262 files: 0 success divergences, binary differs in 2 files.
- `benchmarks/results/test262-ir-status.json` says IR-only test262 is `unavailable`.
- `check:ir-only` on the 5 playground files: READY, 38/38.

## Implementation Plan

1. **Telemetry must not change the result.** Find where `trackIrOutcomes` turns an `invariant` outcome into a compile ERROR (`formatIrPathFallbackDiagnostic` / `legacy-body-audit.ts` violations → `errors`). Under production compile the same condition is silently tolerated; pick ONE behaviour: record the invariant row and keep `success` as it would be without telemetry (recommended — the gate reads the rows, not `success`), or hard-fail in both modes (then it is a real breaking change and needs the #7002 compile-twice fix first). Add a test: for every file in a small fixed list (the five playground files + the accessor test262 file above) `compile(src).success === compile(src, {trackIrOutcomes:true}).success` and the binaries are byte-identical.
2. **Fix the compile-twice** behind `duplicate-direct-function-body-receipt`: trace why computed-name accessors of a class EXPRESSION (`let C = class { get [expr]() {} }`) get two direct body emissions (likely the class-expression initializer compiled once for the module-init body and once for hoisting/shape probing). Make the second a cache hit or a skip. If this is a separate owner's area (#3522 classes), do steps 1, 3, 4 here and file the fix as its own issue linked from this file.
3. **Stride ledger.** Add `scripts/ir-claim-ledger.mts` (or extend `check-ir-only.ts` with a `--stride N --target standalone` mode): deterministic stride sample of `test262/test` + playground, `trackIrOutcomes: true`, tally per unit kind × outcome kind, `unsupportedByStageCode`, invariant codes, and `noTelemetry` file count; write `benchmarks/results/ir-claim-ledger-standalone.json`. Wire it as a non-blocking CI job (nightly, like `test262-honest-audit`) that uploads the JSON; do NOT make it required. The point is that the number exists and is refreshed.
4. **Document.** In `plan/log/ir-adoption.md`'s generator (`scripts/gen-ir-adoption.mjs`), add a sentence under the bucket table stating the corpus the baseline is measured on and linking the ledger; update `plan/goals/ir-full-coverage.md` "Current state" with the stride numbers.

## Acceptance

- Telemetry parity test passes on the fixed file list.
- The ledger script runs in under 15 minutes at stride 40 and its JSON is committed once as a seed.
- No required CI check added or changed.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7002-ir-gate-integrity-telemetry-stride-ledger.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-18)

Measured in-container on main `2cc15166` plus this branch. The container was
shared with other agents (load average 7–9 on 4 cores), so wall-clock numbers
are upper bounds.

### Step 1 — telemetry is observation-only

Two telemetry-only paths changed the result; both fixed:

1. `recordObservedIrOutcomes` (`src/codegen/index.ts`) reported the reconcile
   diagnostics (`IR outcome invariant […]`, accounting notes) with severity
   `error`. They now report as `warning`; the `invariant` ROW is unchanged and
   is what `check:ir-only` and the ledger count. (Chosen behaviour: record the
   row, keep `success` as without telemetry. Hard-failing in both modes would
   need #7070 first.)
2. `sourcePosition` in `src/codegen/legacy-body-audit.ts` threw on a node with
   no SourceFile (`Cannot read properties of undefined (reading
   'getLineAndCharacterOfPosition')`) — the `build:unexpected-internal-throw`
   invariant from the evidence above. It now returns an unanchored position.
   Repro: test262 `built-ins/Function/prototype/S15.3.3.1_A3.js` raw,
   standalone: success without telemetry, "Internal error compiling
   expression" with it.

Parity, telemetry off vs on (success AND byte-identical binary), after the fix:

| Sample | Result |
| --- | --- |
| test262 stride 200, standalone (268 files) | 268/268 identical (before: 1 diff + the accessor file) |
| test262 stride 200 offset 100, gc (268 files) | 268/268 identical |
| `check:ir-only` five + 2 repros, standalone and gc | all identical except gc `js/async.ts` (bytes only, #7071) |

The test (`tests/equivalence/issue-7002-ir-gate-integrity-telemetry-stride-ledger.test.ts`)
covers the five `check:ir-only` entries, the class-expression accessor repro
and the S15.3.3.1_A3 repro, on standalone and gc: same `success`, same bytes.
A/B: with this branch's two `src/` files reverted, 6 of its 20 cases fail.

**Tests that encoded the telemetry-only failure.** Three existing tests
asserted `success === false` for an injected internal IR throw under
`trackIrOutcomes` (`tests/issue-3519-ir-outcomes.test.ts` ×2,
`tests/issue-4573-standalone-native-promise-delay.test.ts` ×1). Without
telemetry the same injection compiles successfully (legacy body kept), so that
assertion was the divergence this issue removes. They now assert the
`invariant / unexpected-internal-throw` row (unchanged) plus a warning
diagnostic, and `success === true`. Scoped run of the 105 test files that
mention invariants or the body-route audit: 127 failures on this branch vs 124
on the base sources (A/B by file copy, same container); the 3-test difference
is exactly these three, fixed. The 124 base failures are pre-existing in this
container and unrelated.

**Left out — #7071.** gc `js/async.ts` still differs in bytes (not in
`success`): `src/compiler.ts` gives the IR inventory the compiler-origin map
only under telemetry, so the timer-shim prelude is inventoried as
`synthetic-support` and takes the isolated timer-shim route. Forcing the map on
reproduces the telemetry bytes without telemetry. Either direction changes a
production route or the telemetry identity, so it is its own issue; the test
lists it in `KNOWN_BYTE_DIVERGENCE` and fails once it is fixed.

### Step 2 — compile-twice → #7070

Not small and not shared IR code. `var C = class {…}` is compiled by
`compileClassBodies` twice — once under the binding (`C_m`) from
`compileClassesFromStatements`, once under the synthetic identity
(`__anonClass_0_m`) from `compileAnonymousClassBodiesInNode` — the #1394
dual-registration design in the direct path (frozen; #3522 owns class
compile-once). Applies to methods as well as accessors. Filed as #7070.

### Step 3 — stride ledger

`scripts/ir-claim-ledger.mts`: playground + every 40th sorted test262 file,
`trackIrOutcomes: true`, round-robin over `--jobs` worker processes (default
cores − 1). Writes `benchmarks/results/ir-claim-ledger-standalone.json`
(seed committed). Advisory workflow `.github/workflows/ir-claim-ledger.yml`:
nightly 03:41 UTC + dispatch, uploads the JSON; not required.

Stride 40, standalone, `--jobs 3`: **8 m 35 s** wall (509 s measured) on the
loaded container. Numbers:

| Population | Units | IR | both | legacy | neither | invariant | no telemetry |
| --- | --- | --- | --- | --- | --- | --- | --- |
| playground, 13 files | 73 | 48 | 0 | 14 | 11 | 0 | 0 files |
| test262, 1,340 files | 1,720 | 9 | 13 | 1,592 | 106 | 69 | 193 files |

test262: 1,087 compile ok, 234 fail, 19 throw (each throws identically
without telemetry). `select:body-shape-rejected` 1,233 of 1,621 rejections.
All 69 invariants are `patch:body-emission-evidence` (#7070); the
`unexpected-internal-throw` invariant is gone (step 1.2).

### Step 4 — docs

`scripts/gen-ir-adoption.mjs` adds a note under the bucket table (corpus =
playground; link to the ledger); `plan/log/ir-adoption.md` regenerated.
`plan/goals/ir-full-coverage.md` gains a dated "Wide-corpus ledger" block.

### Gates

No required check added or changed. `check:ir-only` READY, `check:ir-fallbacks`
OK, LOC/func/coercion/oracle/dead-exports OK (also with
`LOC_GATE_BASE=origin/main`), compiler-boundaries inventory valid,
import-cycles and flat-dir budget OK.
