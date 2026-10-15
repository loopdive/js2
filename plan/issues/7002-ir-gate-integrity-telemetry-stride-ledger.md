---
id: 7002
title: "ir gates: `trackIrOutcomes` is not observation-only (it flips real test262 files from success to failure) and the only detector of production compile-twice (`duplicate-direct-function-body-receipt`, 24 of 25 invariants in a test262 stride) exists only under telemetry; the IR ledger is measured on a 5-file corpus (38/38 READY) while a test262 stride shows 3% IR bodies / 90% legacy — add a stride ledger and make telemetry side-effect free"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: ir-telemetry, ci-gates
goal: ir-full-coverage
related: [3518, 3519, 3341, 7001]
# 2026-10-15: audit finding; scripts/ may gain one measurement script.
loc-budget-allow:
  - scripts/check-ir-only.ts
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
