---
id: 4558
title: "check:linear-ir is RED on main: IR-compiled function count regressed 8 → 6, unowned"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [2855, 4551]
# id 4558 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-19 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: open PRs were 4646,
# 4649, 4650, 4651; only 4651 touches issue files and its highest id is 4402.
# Highest id on main is 4554, so the space above it was clear.
---

# #4558 — the linear-IR ratchet is failing on main

## Problem

`npm run check:linear-ir` fails on a clean `origin/main` worktree:

```
linear-ir ratchet: FAIL
  - IR-compiled function count DECREASED: 8 → 6
  - demotion bucket 'illegal:instr-vec.set_length' INCREASED: 0 → 2
  - demotion bucket 'select:string-builder-candidate' INCREASED: 0 → 2
```

Two functions that used to compile through the IR path now demote to the legacy
path instead. The ratchet is doing its job — it caught a real regression — but
nobody owns it, so the gate has been red long enough that it now reads as
background noise rather than a signal. That is the expensive failure mode: a
gate everyone has learned to skip past protects nothing.

## How it was confirmed (so nobody re-does this)

Observed while validating unrelated linear-lane work on
`claude/linear-memory-quickjs-backend-gkhszu`. To rule out that branch as the
cause, the gate was run in a **fresh worktree of clean `origin/main`** and
produced a **byte-identical** failure — same counts, same two buckets. So it is
pre-existing and independent of the linear/QuickJS work.

## Scope

- Bisect to the commit that dropped the count from 8 to 6.
- Decide per bucket whether the demotion is a **regression to fix** or an
  **intended re-scoping**:
  - `illegal:instr-vec.set_length` — an instruction the IR path rejects as
    illegal. Either the legality rule is too strict or the emitter genuinely
    lost the capability.
  - `select:string-builder-candidate` — the selector routing these functions
    away from IR on purpose. If intended, the baseline should have moved in the
    same PR.
- Then either fix the regression, or refresh the baseline with
  `pnpm run check:linear-ir -- --update` **and state in the commit why the
  decrease is intended**. Refreshing without that justification just relabels
  the regression as the new normal.

## Acceptance criteria

- [ ] The commit that caused the decrease is named.
- [ ] Each of the two buckets is classified regression-vs-intended, with a
      reason, not silently absorbed into a refreshed baseline.
- [ ] `npm run check:linear-ir` passes on `main`.
- [ ] If the baseline moved rather than the code, the commit message says which
      functions stopped compiling through IR and why that is acceptable.

## Why this matters beyond the number

`plan/log/ir-adoption.md` still carries 39 `direct-only`/`mixed` rows, so IR
coverage is the live constraint on anything that emits **from** IR — including
the C backend of [ADR-0021](../../docs/adr/0021-native-backend-targets-c.md),
whose stated prerequisite is finishing IR coverage. A ratchet drifting the wrong
way while that is the plan of record is worth more than its two-function size.
