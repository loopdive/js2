---
id: 5262
title: "R2 body-emission accounting OVERWRITES the root-cause outcome code — an injected internal throw is reported as `body-emission-evidence`, not `unexpected-internal-throw` (5 tests skipped in issue-3519)"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: m
complexity: M
feasibility: medium
reasoning_effort: high
task_type: bug-fix
area: ir, codegen, tests
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [3519, 3521, 3523, 3565, 4502]
---

# R2 body-emission accounting overwrites the root-cause outcome code

## Problem

In `reconcileIrOverlayOutcomes` (`src/codegen/ir-overlay-outcomes.ts`) the R2
body-emission accounting check runs **last** and unconditionally replaces the
outcome that the preceding precedence chain computed:

```ts
if (bodyAccounting) {
  accountingFailure = functionBodyAccountingFailure({ ... });
  if (accountingFailure) outcome = observedFailure(base, accountingFailure);
}
```

When a unit fails for a real, already-classified reason and then falls back to
direct emission, `functionBodyAccountingFailure` (`:339`) fires:

```ts
if (input.outcome.kind === "invariant" && input.accounting.directBodyEmissions !== 0) {
  return bodyEmissionInvariant(
    `${unitId} reached an R2 invariant after ${n} direct body receipts; ` +
      "a fatal prepared owner may retain only zero or one exact IR patch receipt",
  );
}
```

so the recorded `code` becomes `body-emission-evidence` and the ROOT CAUSE
(`unexpected-internal-throw`, `missing-terminal-outcome`) is lost. The row is
still fail-closed — an `invariant` either way — so nothing mis-compiles; what
is lost is the diagnosis, which is the whole point of the typed-outcome ledger
(#3519).

Note also that the message and the condition disagree: the text says "may
retain only zero or one exact IR patch receipt" while the guard rejects
`directBodyEmissions !== 0`. Part of this issue is deciding which is intended.

## Evidence

Measured 2026-08-31 on pristine `origin/main` (both the test file and the
compiler sources taken from main), during #3523 gap 4:

| expected `code` | actual `code` |
| --- | --- |
| `unexpected-internal-throw` | `body-emission-evidence` |
| `missing-terminal-outcome` | `body-emission-evidence` |

Five tests in `tests/issue-3519-ir-outcomes.test.ts` assert the root-cause code
and fail on main because of this:

- `counts only executable overload implementations and ignores ambient signatures`
- `does not demote an unexpected Promise final-registration throw`
- `does not demote unexpected imported-call planning throws`
- `routes iterator registration throws through the owning source outcome`
- `turns an actual missing integration terminal into a reconciliation invariant`

They were **skipped** (`it.skip`, with the measurement recorded inline) by
#3523 gap 4, because gap 4 had to touch that file and touching a file pulls it
into the required `quality` gate's changed-root step. They were deliberately
NOT re-pointed at the current code: the tests are named "does not demote …",
so asserting the masked code would turn a red flag into a green lie.

## Why it was not caught earlier

`tests/issue-3519-ir-outcomes.test.ts` is only run when a PR touches it (see
#5259 and #5265). It has been red on main for some time with every gate green.

## Acceptance criteria

1. Decide and document the intended precedence: either the accounting check
   only fires when it is the FIRST failure for the unit, or it composes
   (root cause retained, accounting recorded alongside) — not silent overwrite.
2. Resolve the condition/message mismatch at `:339`.
3. The five tests above are **un-skipped** and pass asserting the root-cause
   code, unchanged in intent.
4. No new `body-emission-evidence` regressions: `pnpm run check:ir-only` stays
   READY and `tests/issue-3523-*` stay green.

## Out of scope

The M0-owner receipt defect behind the `issue-3525` skips (#5263) — same
violation code, different trigger.
