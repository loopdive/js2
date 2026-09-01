---
id: 4063
title: "`check:godfiles` is RED on main with 39 regressions but gates nothing — wire it in or retire it"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-31
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `check:godfiles` is RED on main with 39 regressions but gates nothing — wire it in or retire it

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Reported by g-arraylen 2026-08-01; independently verified by the lead.

STATE: `pnpm run check:godfiles` (= `node scripts/profile-godfiles.mjs --check`) reports
2 regressions in `src/codegen/index.ts` — `generateMultiModule` and `planIrOverlay` — on
a tree where the reporting agent had not touched that file. So it is red on main, not
branch-local.

VERIFIED NON-GATING: `profile-godfiles` appears nowhere under `.github/`. Both
`check:godfiles` and `profile:godfiles` exist in package.json but no workflow invokes
either. It therefore blocks nothing today.

CORROBORATED 2026-08-02, independently and from the opposite direction: the
`H-crashes` lane observed `quality` **passing** on PR #4007 while `check:godfiles`
was red on the same tree, and separately confirmed the redness is not
branch-local by kill-switch (reverting its own change entirely, the gate reports
the identical two regressions). Re-verified here: `grep -rl godfiles .github/`
returns nothing. So the "it gates nothing" half of this issue is now confirmed
by three independent routes — source grep, a passing `quality` on a red tree,
and a kill-switch — while the "it is red on pristine main" half is confirmed by
two.

THE ACTUAL DECISION (do not just re-baseline it): a check that is permanently red and
wired to nothing is worse than no check — it trains agents to ignore a red signal, and
it cannot catch the god-file growth it was built to catch. Pick one:
  (a) fix the 2 regressions and WIRE IT INTO `quality`, so it starts gating; or
  (b) retire the scripts and the package.json entries.
Choosing (a) means accepting it as a required gate with a ratchet; choosing (b) means
deleting it rather than leaving it decorative.

Note the adjacent precedent: #3984 removed god-file mass ARCHITECTURALLY (moving
ArraySetLength into `src/codegen/array-length-define.ts`, shrinking `object-ops.ts` by
312 lines) rather than buying a budget allowance. If this gate were live it would have
banked that improvement automatically.

LOW PRIORITY — nothing is blocked on it. Do not let it displace ES5/standalone lever
work.

## 2026-08-31 — current measurement: 2 regressions became 39

The original evidence remains valid but its scale and priority are stale.
`node scripts/profile-godfiles.mjs --check` now exits 1 with **39**
regressions across five files, while no workflow under `.github/` invokes the
profiler.

Largest measured growth:

- `ensureObjectRuntime`: **4,234 → 5,669 LOC** (+1,435);
- `compileCallExpression`: **1,811 → 2,307** (+496);
- `emitIteratorMethodExport`: **169 → 595** (+426);
- `generateModule`: **1,269 → 1,718** (+449);
- `generateMultiModule`: **768 → 1,155** (+387);
- `ensureAnyToStringHelper`: **467 → 660** (+193).

The result includes numerous new 150+ LOC mega-functions in `calls.ts`,
`index.ts`, `object-runtime.ts`, `array-methods.ts`, and `native-strings.ts`.
Thirty-seven additional violations accumulated while the red check remained
decorative. Raising this issue to medium reflects that demonstrated ratchet
failure; it still should not displace correctness work.

PR preflight against `upstream/main` at
`c39de6dac8c376482b4f2cd628e445c6d8441728` re-ran the gate after 22 upstream
commits beyond the audit base. It remains at **39** regressions; intervening
codegen work increased `generateModule` from the audit's measured 1,684 LOC to
1,718 LOC, which is reflected above.

### Updated acceptance criteria

- [ ] Pristine main is green because violations were reduced/reconciled, not
      because the current 39 were blindly banked.
- [ ] An intentional function growth above the configured margin is a red
      positive control.
- [ ] A required workflow invokes the meaningful ratchet, or the profiler and
      package scripts are explicitly retired.
