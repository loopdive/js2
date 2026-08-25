---
id: 4558
title: "check:linear-ir is RED on main: IR-compiled function count regressed 8 → 6, unowned"
status: done
sprint: current
created: 2026-08-19
updated: 2026-08-21
completed: 2026-08-21
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

- [x] The commit that caused the decrease is named.
- [x] Each of the two buckets is classified regression-vs-intended, with a
      reason, not silently absorbed into a refreshed baseline.
- [x] `npm run check:linear-ir` passes on `main`.
- [x] If the baseline moved rather than the code, the commit message says which
      functions stopped compiling through IR and why that is acceptable.

## Resolution (2026-08-21)

**Causing commit: `0f7f4039c` — "fix(ir): preallocate canonical counted array
pushes" (2026-07-30).** It introduced the `vec.set_length` IR instruction for
the proven empty-array counted-push loop (`const arr: number[] = []; for (…)
arr.push(i)` — exactly `bench_array` in `benchmarks.ts` and
`benchmarks/array.ts`) and wired `emitVecSetLength` into every backend emitter
— including `LinearEmitter` (an `i32.store` at the vec layout's
`lengthOffset`) and `PorfforSink` — but never admitted the instruction in the
backend legality allow-lists (`linearInstrError` / `porfforInstrError` in
`src/ir/backend/legality.ts`). So every function using the new lowering was
rejected at the emit boundary despite the emitter supporting it.

Per-bucket classification:

- `illegal:instr-vec.set_length` (×2) — **regression, fixed.** Legality⇄emitter
  desync as above; `vec.set_length` is now admitted in the linear AND porffor
  profiles. Verified by execution probe: the counted-push shape compiles
  through the IR overlay on `--target linear`, instantiates, and returns
  values identical to plain JS and to the direct path (`JS2WASM_LINEAR_IR=0`),
  for both the 10k-push and a 5-push partial-capacity variant.
- `select:string-builder-candidate` (×2) — **intended re-scoping, baseline
  refreshed.** `663208791` (#3740, 2026-07-28) later narrowed by #3744: the
  constant-count literal-fragment append loop (`let s = ""; for (…) s = s +
  "abcde"` — exactly `bench_string` ×2) is ALWAYS deferred to legacy because
  legacy folds it into one `repeat(N)` + concat (#1004), which IR does not
  own. The gc-lane `check:ir-fallbacks` baseline classifies the same two
  functions as `deferred` — the linear baseline now matches. The #3740 PR
  should have refreshed this baseline; it didn't, which is how the gate went
  red silently.

Refreshed baseline also banks three improvements that had accrued since the
last update (`551c00632`, #2956 L4): `build` 2→0, `select:call-graph-closure`
12→11, `select:non-export-modifier` 15→0. `npm run check:linear-ir` passes.

Permanent repro: `tests/issue-4558.test.ts` — pins that the counted-push
shape stays IR-compiled on the linear overlay with no
`illegal:instr-vec.set_length` reject, that overlay/direct/JS values agree,
and that `vec.set_length` is legal in both the linear and porffor
instruction profiles (`verifyIrBackendLegality`).

## Why this matters beyond the number

`plan/log/ir-adoption.md` still carries 39 `direct-only`/`mixed` rows, so IR
coverage is the live constraint on anything that emits **from** IR — including
the C backend of [ADR-0021](../../docs/adr/0021-native-backend-targets-c.md),
whose stated prerequisite is finishing IR coverage. A ratchet drifting the wrong
way while that is the plan of record is worth more than its two-function size.
