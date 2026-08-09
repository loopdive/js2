---
id: 3580
model: fable
fable_role: spec
title: "value-rep: undefined-observability numeric leg — standalone $undefined singleton (S1) + sNaN/union-collapse (S2–S4), typeof-null (carved from #2106)"
status: ready
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime, standalone
language_feature: type-coercion, value-representation
goal: value-rep-substrate
related: [2106, 2004, 2051, 2030, 2001, 2773, 3251]
origin: "2026-07-24 split of #2106 (lead-approved): #2106's P3 headline shipped (PR #1701); this carries the open value-rep numeric-leg remainder as its own tracked fable/value-rep issue."
---

# #3580 — value-rep undefined-observability: the open numeric leg (carved from #2106)

**Split from #2106** (lead-directed, 2026-07-24). #2106's headline P3
deliverable — the observable-`undefined` channel — **shipped via PR #1701**
(commit `347f3c79a`); #2106 is now `done` against that shipped scope. This
issue carries the **open remainder**, which is fable-tier **value-rep substrate**
(atomic, senior-dev / max-effort), NOT a routine contained dev pull.

**Read #2106 for the full diagnosis history** — it retains the S1 merge_group
regression analysis, the ~40-site producer/consumer sweep spec, the default-flip
NO-GO measurements (PRs #2025/#2633/#2655/#2079/#1961), and the memory notes
(`project_2106_undefined_singleton_s1_atomic`). This file is the live tracker;
the analysis stays in #2106's body.

## Remaining slices (unchanged from #2106)

- **S1 — standalone tag-1 `$undefined` singleton.** The atomic ~40-site
  producer+consumer sweep. PR #2025 auto-parked (standalone floor breach, NET
  −1245 test262 rows) because it flipped the CONSUMER `__extern_is_undefined`
  to singleton-only WITHOUT the matching PRODUCERS (`__extern_get` missing-key
  return still `ref.null.extern`). No narrow floor-saving subset exists — needs
  the full sweep (architect re-spec).
- **S2** — sNaN carve-out.
- **S3** — `number | undefined` → externref.
- **S4** — union-collapse reversal (flagged `UNDEF_F64` sentinel / numeric
  carrier).
- typeof-null → "object".

## Acceptance

1. The standalone `$undefined` singleton lands as a floor-neutral-or-positive
   FULL producer+consumer sweep (no partial-subset floor breach).
2. S2–S4 numeric-carrier undefined observability per the #2106 spec.
3. No standalone floor regression (the guard that parked PR #2025).

## Lane

Fable / value-rep substrate (`model: fable`). Belongs with #2773 (value-rep
substrate epic) / #3251 (array-descriptor overlay). NOT an Opus-lane contained
slice.
