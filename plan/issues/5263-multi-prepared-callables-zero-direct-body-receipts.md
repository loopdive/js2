---
id: 5263
title: "Standalone multi-source prepared callables record ZERO direct body receipts — `body-emission-evidence` invariants red on main (6 tests skipped in issue-3525)"
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
related: [3521, 3523, 3525, 5262]
---

# Standalone multi-source prepared callables record zero direct body receipts

## Problem

Six tests in `tests/issue-3525-multi-prepared-callable-bindings.test.ts` fail on
`main` with `body-emission-evidence` invariants of the form:

```
<unitId> fell back to direct emission without exactly one direct body receipt (observed 0)
```

for every callable in a standalone multi-source graph — e.g. `add` in
`dep.ts`, `run` in `entry.ts`, and all five units of the same-spelled-provider
component. The compile reports `success: false`.

Either the units genuinely fall back without entering an audited direct-body
root (a real ownership hole in the M0/M2 prepared-callable route), or the
receipt audit does not see roots it should. Both are worth knowing; the
`observed 0` says the audit counted nothing at all, which points at the second.

## Evidence

Measured 2026-08-31 during #3523 gap 4, by checking BOTH this test file and the
compiler sources out of pristine `origin/main` and re-running: the same six
fail there, identically. They are not a regression from gap 4 — gap 4's row
carries no `unitId` and enters no prepared-callable denominator (recorded as
the consumer-3 evidence in #3523).

Affected tests:

- `stages one exact cross-source component and publishes it after exact body skips`
- `prepares same-spelled providers as one exact five-unit component`
- `prepares the named-default alias matrix with exact five-unit ownership`
- `publishes two disjoint components together and rejects a stale second scope with a zero prefix`
- `keeps the sibling component publishable when the left component fails preparation`
- `keeps the sibling component publishable when the right component fails preparation`

They were **skipped** by #3523 gap 4 with the measurement recorded inline,
because gap 4 had to touch the file for the terminal/non-executable partition
and touching it pulls the file into the required `quality` gate.

## Acceptance criteria

1. Root-cause named: whether the direct-body roots are missing or unaudited.
2. The six tests are **un-skipped** and pass, with their assertions unchanged in
   intent (they pin exact five-unit ownership; do not weaken them to counts).
3. `pnpm run check:ir-only` stays READY; `tests/issue-3523-*` stay green.

## Notes

The `unresolved-legacy-entry` violation on the whole-program `__module_init`
(`compileModuleInitBody __module_init has no exact source/unit/class identity`)
is a SEPARATE, also-pre-existing finding measured in the same session; it
belongs to #3523 gap 1, not here.
