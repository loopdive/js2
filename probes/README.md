# Planning-lane probe artifacts (session 2026-09-02)

Throwaway census drivers, instrumentation patches and BEFORE records that the
F2-S5 implementation plan (#3526, family 2 slice 5) and the gap-6a plan (#3523,
R4 gap 6) cite. Files carry a `.txt` suffix so no lint or test runner picks
them up; strip it before use (`cp x.mts.txt .tmp/x.mts`). This branch is never
merged; it exists so a lane in another container can
`git fetch origin claude/probe-artifacts-2026-09-02` and read them.

## 2026-09-02 (later) — family-2 slices F2-S6 / F2-S7 / F2-S8

Added by the same planning lane for the three plan sections filed on
`claude/docs-r6-f2s6-s8-plans` (#3526, batched concat / charCodeAt /
string.const):

- `f2s6/` — `census-f2s6-batched-concat.md` (verdict at its head overrides the
  body), the 14-fixture × 6-lane driver `f2s6-matrix.mts`, the reach
  instrumentation `f2s6-instrument.py` (known defect: `ctx.mod.funcs` must be
  `ctx.mod.functions`), the shift re-run driver `f2s6-shift.mts`, the
  host-import-policy probe walker `f2s6-policy.mts`, and the 84-cell BEFORE
  record `matrix.{md,json,out}`.
- `f2s7/` — `census-charcodeat.md`, the 13-fixture × 5-lane driver
  `f2-cca-matrix.mts`, `f2-cca-instrument.py`, the strict-mode probe
  `f2-cca-probe-strict.mts`, the BEFORE record `f2-cca-matrix-before.{md,json}`
  and the two pin runs `f2-cca-pin-clean.out` / `f2-cca-pins-instrumented.out`.
- `f2s8/` — `census-string-const.md`, the 13-fixture × 6-lane driver
  `census-string-const-matrix.mts` (imports `../src/index.js`; run from a
  worktree's `.tmp/`), `census-string-const-instrument.py`, the BEFORE record
  `census-string-const-matrix.{md,json}` + `census-string-const-run.out`, the
  probes `census-string-const-probe{,2,3}.mts`, `booltpl.mts` and
  `matrix-wt.mts` (both hard-wired to a removed worktree path — re-point
  before use), and `f2s8-red-recheck.out` (post-#5465 red re-check at
  `f1739d2b52`).
- `f2s6-s8-plan-critiques.txt` — the critique verdicts and the revise-stage
  decisions/open questions for all three plans, as returned by the workflow.
