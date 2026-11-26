---
id: 7415
title: "Prepared: the same prepared program is validated in full at every use (8× per compile)"
status: wont-fix
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7365, 7397, 7398]
---

# #7415 — one full validation per unchangeable prepared program

## Problem

Found while profiling #7365. The Prepared consumer, the physical planner and
the native invocation each call `assertPreparedIrProgram(program)` on the same
prepared program: 8 full validations per compile at every size of the #7365
prelude-shaped program. On `claude/7354-o` + B′ + #7397 + #7398 at size f,
`assertPreparedIrProgram` accounts for 2.8 s (9.5 %) of the profile.

## Implementation Plan

- **Module:** `src/ir/program/settled-validation.ts` (new, `ir-program`
  layer). `assertSettledPreparedIrProgram(program)` is the settled entry.
  These call sites switch to it:
  - `program-consumer.ts` (3);
  - `program-physical-plan.ts` (2);
  - `program-native-invocation.ts` (3).
- **`validation.ts` is not changed.** Its bytes are pinned by the #3518
  program-validator relocation witness (`tests/helpers/ir-program-validator-relocation.json`
  and the chain above it). The other callers keep the full check:
  - `program.ts`, `program-codec.ts`, `program-native-async-resources.ts`,
    which are pinned too;
  - `program-prepare-ir.ts`, which passes verification options.
- **Reuse:** `PreparedIrSettledChecks` from `settled-verdict.ts` (#7354 Perf),
  keyed by the program object.
  - While the program can still change, every call is today's full check.
  - Once it is deeply frozen (decided before the check), the verdict holds.
    It also requires the shared prototypes to be unchanged.
- **Purity audit (2026-11-19).** `assertPreparedIrProgram` reads only
  `program` and pure derivations of it, such as
  `numberFormatRadixSupportDeclarations(batch.sourceId)`, a fresh
  `ProgramAbiMap`, and an allocation registry rebuilt from the program's own
  snapshot. `validation.ts` and the validators it calls hold no module-level
  mutable state: population, class layouts, allocations, runtime support,
  runtime-support dependencies, runtime validation, formatter support, ABI,
  callable results and `runtime/verify.ts`.
- **Contract:** neutral. A changeable program is validated at every use, as
  before, and `assertPreparedIrProgram` itself is unchanged.
- **Quality criterion:**
  - one settled entry, built from the existing settled-checks class;
  - no copy of the immutability walk;
  - no change to the pinned validator.

## Measured (2026-11-19)

The #7365 prelude-shaped program, through
`src/test262/test262-prepared-entry.ts`. Each size is compiled 2× in one
process.

| base | q | h | f | sha1 |
|---|---|---|---|---|
| `claude/7354-o` + B′ + #7397 + #7398 | 8.8 / 8.1 s | 13.3 / 13.0 s | 25.3 / 30.5 s | 247da933 / 28148a80 / e6ec6c68 |
| + #7415 (prototype at the same call set) | 8.2 / 7.5 s | 11.9 / 12.6 s | 22.7 / 25.2 s | identical |

- Validations on q: 8 calls per compile, 1 full.

## Acceptance criteria

1. Prelude q/h/f before/after, sha1 identical (above).
2. `tests/issue-7415-settled-program-validation.test.ts`:
   - a genuine prepared program is deeply immutable and is validated once
     over 5 calls;
   - an unfrozen program is validated at every use, and a later mutation is
     refused;
   - `assertPreparedIrProgram` itself still validates at every call;
   - a shared-prototype change re-validates a settled program.
3. Every test file that calls program validation or the three switched
   callers shows no new failures against `claude/7354-o`.
4. Gates: loc, func, coercion, oracle, dead-exports, import-cycles, and the
   compiler-boundaries inventory (the new module is classified `ir-program`).

## Suspended Work (2026-11-20, budget window closed)

- **Branch:** `claude/7415-settled-program-validation`, based on
  `claude/7354-o` 0c7109594b. There is no PR.
- **State:**
  - the new module `src/ir/program/settled-validation.ts` is done, with its
    8 call-site switches and its boundaries entry;
  - `tests/issue-7415-settled-program-validation.test.ts` passes 4/4;
  - `issue-3518-program-validator-relocation` shows 9 failures, the same 9 as
    on the base.
- **Next steps:**
  1. Merge `claude/7354-perf2` when it lands, or stack on it. The lead asked
     to keep `PreparedIrSettledChecks` in perf2's generalised form; the
     `void` output works unchanged.
  2. Finish the base-vs-new comparison of the 86 related test files, one
     process per file. Only 66 new-side files had run when it was paused.
  3. Run the gates.
  4. Re-measure prelude q/h/f with the final module.
  5. Open the PR with hold.
- **Open review threads:** none.

## Superseded (2026-11-26)

Closed as superseded by #7354 Perf3–Perf6, merged to main on 2026-11-21/22. On
main 6694a8b839, the full-prelude program (source sha1 c70fb78b, S1's `t3.mts`)
compiles in 3.6–4.2 s, peak RSS about 580 MB, and the output runs. On
2026-11-20 it took 1,002 s (base) and 475 s with #7436. Perf6 checks a native
string plan as issued instead of re-planning it for each literal, which removes
the per-literal re-derivation measured above. No PR was opened from this
branch.
