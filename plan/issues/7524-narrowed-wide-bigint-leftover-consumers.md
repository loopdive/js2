---
id: 7524
title: "A typeof-narrowed wide BigInt still loses its bits in a template literal, `[t]`, `t ? t : 0` and `k = t`"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7497, 7506, 6656]
---

# #7524 — narrowed wide BigInt: the consumers #7497 did not reach

## Problem

#7497 (PR #7459) keeps a `typeof`-narrowed BigInt on its reference carrier when the consumer asks `compileExpression`
for a reference. These consumers do not ask, so the narrowed read still unboxes to i64 and loses every bit past 64.
Found by RV7459 (review of #7459, comment 7191343512): each fails on main, with #7459, at 688eb4de41 and at
89bd4bd78a^, so none is part of #7497's regression.

Measured by S18 on #7459's head fe902f44f0 (base main 1a726b3e64), TypeScript,
`function f(t: any) { if (typeof t === "bigint") { … } }`, called with `2n ** 64n`:

| consumer | node | gc | standalone |
| --- | --- | --- | --- |
| `` return `${t}` `` | `"18446744073709551616"` | wrong | wrong |
| `const a: any[] = [t]; return a[0]` | `2n ** 64n` | wrong | wrong |
| `return t ? t : 0` | `2n ** 64n` | wrong | wrong |
| `let k: any = 0; k = t; return k` | `2n ** 64n` | wrong | wrong |
| control: `const k: any = t; return k` | `2n ** 64n` | right | right |

RV7459 also lists `t === 2n ** 64n` on a narrowed `t` as wrong; S18's form (`return t === 2n ** 64n` from an `any`
function) answers right on both targets, so that row needs RV7459's exact program before it is pinned.

Not reproduced, from the same review: the runtime-eval fallback reads in `src/codegen/expressions/identifiers.ts`
(`compileIdentifierCore(ctx, fctx, id, true)` at ~L811, ~L1002, ~L1035) do not forward `expectedType`. At ~L1002 the
static arm is coerced to externref straight after, so a narrowed BigInt there would still pass through i64. No repro:
sloppy direct `eval` plus narrowing is a validation CE on main, and the `with`-scope variant fails on main too.

## Likely cause

Each consumer compiles the narrowed identifier with no expected type (or a non-reference one) and coerces afterwards:
the template span, the array-literal element, the conditional arms, and the assignment right-hand side to an `any`
local. The fix is the same as #7497's: those sites pass the reference expectation they already coerce to, so
`emitNullablePrimitiveUnbox` keeps the carrier.

## Acceptance criteria

- The four rows answer like node on gc and standalone; the control stays right.
- Pins fail on main and pass after; bytes unchanged where no narrowed BigInt reaches these consumers.
- The runtime-eval fallback reads either forward `expectedType` with a repro that fails before, or the item is closed
  as unreachable with the reason.
