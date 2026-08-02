---
id: 4063
title: "`check:godfiles` is RED on main (2 regressions in src/codegen/index.ts) but gates nothing — wire it in or retire it"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `check:godfiles` is RED on main (2 regressions in src/codegen/index.ts) but gates nothing — wire it in or retire it

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
