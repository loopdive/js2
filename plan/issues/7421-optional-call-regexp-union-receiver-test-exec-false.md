---
id: 7421
title: "`g?.test(s)` / `g?.exec(s)` answer false when `g` is still typed `RegExp | undefined` at the call"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7395, 7374]
---

# #7421 — RegExp optional calls on an un-narrowed `RegExp | undefined` receiver

## Problem

Found while fixing #7395 (RV7336 round 1). Measured on the #7395 branch, head 37ed68c008, on gc and standalone alike:

| program | node | we answer |
| --- | --- | --- |
| `function f(g: RegExp \| undefined) { return g?.test('a'); }` then `f(/a/)` | `true` | `false` |
| `let g: RegExp \| undefined = /a/ as any; g?.test('a')` | `true` | `false` |
| `... g?.exec('a')` (same shapes) | the match | `null` |
| `const g: RegExp \| undefined = /a/; g?.test('a')` (TypeScript narrows `g` to `RegExp`) | `true` | `true` |

The answer is the same before #7395, on #7374's head bdeedb9f89.

## Cause

`?.` calls reach the native RegExp arms through `tryCompileStandaloneRegExpMethod` (`src/codegen/regexp-method-call.ts`,
added by #7395). Each arm reads the receiver's checker type itself, for example
`isGlobalRegExpType(getTypeAtLocation(propAccess.expression))` in `tryCompileStandaloneRegExpTest`. For an
un-narrowed receiver that type is the union `RegExp | undefined`, so the arm declines. The call then falls to the
generic receiver ladder, which has no RegExp arm and yields the default value.

`emitStandaloneRegExpToStringFromExpr` already takes `getNonNullableType()`, which is why `g?.toString()` answers
correctly.

## Acceptance criteria

- `g?.test(s)` and `g?.exec(s)` on a `RegExp | undefined` parameter or local answer like node, including the
  `undefined` case (short-circuit), on gc and standalone.
- The native arms judge the receiver's non-nullable type through one shared rule (`optionalChainReceiverType` exists
  for exactly this), not one ad-hoc strip per arm.
- No test262 byte change outside RegExp optional calls.
