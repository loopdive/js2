---
id: 7496
title: "Calling `JSON.parse` through an `any`-typed `JSON` value throws \"not yet implemented in --target standalone\" on every lane (legacy)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7469]
---

# #7496: `(JSON as any).parse("5")` throws

## Problem

Checked through the test262 runner (`runTest262File`) on main `c3b7be667a`, in
a `.ts` fixture:

| program | gc | standalone | node |
|---|---|---|---|
| `JSON.parse("5")` | 5 | 5 | 5 |
| `(JSON as any).parse("5")` | throws | throws | 5 |
| `(JSON as any)?.parse?.("5")` | throws | throws | 5 |

Both lanes throw `TypeError: JSON.parse is not yet implemented in --target
standalone`, **including the gc lane**. So the call does not go through the
static `JSON.parse` dispatch. It goes through the `JSON.parse` function value,
which is a not-implemented stub on every target.

Found while fixing PR #7434
([#7469](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7469-optional-call-non-struct-receiver-skips-call)).
That PR sends `JSON?.parse?.(…)` and `JSON.parse?.(…)` to the static dispatch,
but a receiver typed `any` still reaches the function value.

## Related, Session B

- `(Math as any).PI` reads `undefined` on gc and standalone; node gives
  `Math.PI`. `Math` used as a value is a carrier object that holds only its
  methods, not its constants. This is in Session B's (Math) area and is only
  recorded here.

## Acceptance criteria

- A pin test checks that `(JSON as any).parse("5")`,
  `(JSON as any)?.parse?.("5")` and a `JSON.parse` value stored in a variable
  and called later all match node on gc, standalone and wasi. It fails on main.
- The fix gives the `JSON.parse` function value the same native implementation
  the static call uses. It adds no second parser.
- Bytes are unchanged for programs that only call `JSON.parse(...)` directly.
