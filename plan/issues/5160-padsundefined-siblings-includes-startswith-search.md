---
id: 5160
title: "includes()/startsWith()/search() with no argument are wrong in the gc lane — the same padsUndefined omission #5155 fixed for indexOf"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [5155, 3763]
---

# Three more one-entry fixes in the `padsUndefined` set

Found during #5155 (PR #5168), which surveyed the zero-argument form of the
whole `String.prototype` family (15 methods, both lanes). Three more methods
carry the identical defect — the omitted externref argument slot reaches the
host as `ref.null.extern` (JS `null`) instead of `undefined`, so the host
coerces the wrong search value. All gc-lane-only; standalone is correct:

| shape | gc (measured) | standalone | spec |
| --- | --- | --- | --- |
| `"aundefinedb".includes()` | **false** | `true` | `true` |
| `"undefinedb".startsWith()` | **false** | `true` | `true` |
| `"aundefinedb".search()` | **-1** | `0` | `0` |

Each fix is one more entry in the `padsUndefined` set inside
`compileReceiverMethodCall` (`src/codegen/expressions/call-receiver-method.ts`)
— the exact change PR #5168 made for `indexOf`, whose record documents the
mechanism and the evidence pattern to reuse.

**The current wrong values are PINNED as tests** in
`tests/issue-5155-string-indexof-no-argument.test.ts` (with the spec answers in
comments) so the behavior cannot drift silently — the fix MUST update those
pins to the spec values.

Note for `search()`: §22.1.3.19 routes through `RegExp(undefined)` = an empty
regexp matching at 0, not `ToString`; verify the host arm actually receives
`undefined` and produces `0` before assuming the same one-entry shape suffices.

## Acceptance criteria

- The three shapes answer the spec values in the gc lane; standalone unchanged.
- The #5168 pins updated; byte-identity for every other `String.prototype`
  shape in both lanes (reuse the #5168 43-shape sweep).
- A/B per the established method; pinned tests red on base; equivalence shards
  clean by name.
