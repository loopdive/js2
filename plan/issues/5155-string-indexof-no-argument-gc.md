---
id: 5155
title: "String.prototype.indexOf() with no argument answers -1 in the gc lane where the spec requires searching the string \"undefined\""
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
---

# One wrong cell: gc-lane `String.prototype.indexOf()` zero-arg

Found during #5121-S1 (PR #5153), measured 2026-08-28 on the #5121 branch's
base (`origin/main` @ `30a3335b80`) — the four `String.prototype` shapes were
byte-identical across that fix, so this is pre-existing and untouched by it:

| expression | gc | standalone | spec |
| --- | --- | --- | --- |
| `"aundefinedb".indexOf()` | **-1** ⚠ | `1` | `1` |
| `"aundefinedb".indexOf(undefined)` | `1` | `1` | `1` |
| `"aundefinedb".lastIndexOf()` | `1` | `1` | `1` |

Per §22.1.3.9, `indexOf(searchString)` runs `ToString(searchString)` — absent
argument becomes the string `"undefined"`, which occurs at position 1 in the
probe. Exactly one cell is wrong: the gc lane's zero-argument `indexOf`. The
standalone lane, the explicit-`undefined` spelling, and `lastIndexOf` in both
lanes are all correct, so this is the same missing-argument-default shape as
the Array-side family (#5095 `at()`, #5121 `indexOf`/`lastIndexOf`), one
lowering over — in `string-ops.ts`, not `array-methods.ts`.

**Not a duplicate of #3763** (checked against the codex lane's claim ledger
2026-08-28 before filing): #3763 is `done` (2026-07-28) and fixed the
*explicit-argument* spelling — an undefined-**valued** variable collapsing to
`ref.null.extern` so the host searched `"null"`. This issue is the
**absent-argument** spelling (`arguments.length === 0`), still wrong on the
2026-08-28 base after #3763's fix, and only in the gc lane. The fix likely
lands next to #3763's `string-indexof-undefined` subsystem module. Distinct
from #5121 because the default here is `ToString` (a string search value),
not a strict-equality element search — no S2-style value-representation limit
applies, so this should be a small self-contained fix.

## Acceptance criteria

- `"aundefinedb".indexOf()` answers `1` in both lanes; byte-identity for
  `indexOf(x)`, `lastIndexOf()`/`lastIndexOf(x)`, and the Array-side family.
- The zero-argument form compiles byte-identical to `indexOf(undefined)` in
  the gc lane (the #5121 pin pattern), or the divergence is measured and
  explained.
- A/B per the #5095/#5121 method: base copy at first edit, pinned tests red
  on base, equivalence shards clean by name.
