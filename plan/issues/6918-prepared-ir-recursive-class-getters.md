---
id: 6918
title: "Prepared IR recursive class detection must not invoke getters"
status: in-progress
sprint: current
created: 2026-10-08
updated: 2026-10-08
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [3518, 6865]
---

# #6918 — Prepared IR recursive class detection must not invoke getters

## Problem

Both prepared DATA freezing APIs inspect active graph cycles with the private
`isRecursiveIrClassShape` predicate in `src/ir/program/data.ts`. The predicate
reads the class brand and five shape fields as ordinary properties. A back edge
visited before a later accessor therefore executes that accessor before the
normal descriptor walk can reject it. The `classId` accessor executes twice.
This also affects untrusted cyclic allocation evidence screened by these APIs.

The defect reproduces on canonical main
`8452732f0b88c14c5c7634ece58f83240970ea4c` with the same late-accessor fixtures
used for the corrected run: 12 negative controls fail and two genuine recursive
class controls pass. The six accessor fields are `IR_CLASS_SHAPE_CELL`, `classId`,
`className`, `fields`, `methods`, and `constructorParams`, through each of
`freezePreparedIrValue` and `freezePreparedIrRuntimeValue`.

## Implementation plan

The adopted Astra plan is confined to the existing private predicate:

1. Inspect each field with `Object.getOwnPropertyDescriptor` and accept its value
   only when the descriptor has its own `value` field. Never read an accessor or
   inherited property to decide whether a cycle is a recursive class cell.
2. Snapshot the own DATA `classId` once. Preserve the existing brand, string
   prefix, class name, and array-shape conditions. Preserve ordinary traversal,
   copy semantics, in-place semantics, and accepted canonical recursive graphs.
3. Exercise all six late accessor fields through both APIs. Put the back edge
   before the factory fields so the predicate is reached before ordinary
   descriptor traversal. Require `PreparedIrProgramInvariantError` and zero
   getter calls in every negative control.
4. Pair each API with a real recursive class cell from the existing codec
   fixture. Verify its factory fields, brand, class ID, recursive back edge,
   nested frozen graph, copied identity, and in-place identity.

No new DATA export, graph framework, class factory, or allocation algorithm is
introduced. Source growth is four lines. The allocation-facts implementation
associated with #6865 remains a separate workstream.

## Qualification

`tests/issue-6865-ir-class-cycle-data.test.ts` contains 14 controls. On unchanged
main the result is **12 failed / 2 passed / 14 collected / 0 skipped**. With the
predicate change the same controls are **14 passed / 14 collected / 0 skipped**.
The existing codec replay file contributes its genuine recursive class row:
**1 selected passed / 27 collected / 26 excluded by the name filter**. The
combined run is 15 passed and 26 filter exclusions across 41 collected rows.
All runtime qualification used Node 25.9.0 and one Vitest worker.

Stock LOC and function budgets, coercion-sites, oracle-ratchet, and `git diff
--check` pass. Normal pre-commit formatting, Biome, and both stock budgets pass.
No budget baseline or allowance was changed.

The legacy reachability command with `preservation-v1` and required core node
and type controls exits zero with these distinct results:

- Core-node execution: 12/12 observed callers pass; dispatch-cut is UNKNOWN.
- Core-type references: 10/10 full and 10/10 dispatch-cut class-free pass.
- Moved-runtime preservation: 6/6 full source witnesses and 6/6 cut pass.

Production-rooted strict closure is still **OPEN**, and retirement/deletion is
**NOT CERTIFIED**. The two inherited unresolved nonliteral dynamic imports are
`src/optimize.ts#getBinaryenModule` at line 412 and
`src/runtime/platform-capability-adapter.ts#resolvePlatformCapabilityImport`
at line 151. Preservation success does not certify that broader closure.

Raw baseline/fixed failures and qualification logs are preserved in the
isolated delivery worktree's private `.tmp/data-cycle` directory. An initial
normal-hook commit reached signing but created no commit object because its
process lacked the existing SSH agent socket; signing and hooks remain enabled.

## Coordination

Issue allocation was verified on upstream `issue-assignments` at
`2e6eadd927917dc866d13fd79940ced00d2c0b7f`: owner
`ttraenkler/codex-ir-native-linear-source-facts-sol61-20261008`, write ID
`64498-ih0vkb8o`, branch `codex/6865-ir-class-cycle-own-data-20261008`.
Only the new issue file, predicate hunk, and focused tests belong to this
independent delivery. Existing held claims and pending allocation ownership
handoffs remain intact.
