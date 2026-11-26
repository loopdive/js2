---
id: 7515
title: "`(void 0 as any) === (void 0)` is false on the IR default lane"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
task_type: bug
area: ir
goal: core-semantics
related: [7439]
---

# #7515 — `void 0 === void 0` compares false in the IR

## Problem

Found by PRV-7439 while probing #7439 on main 1a726b3e:

```ts
export function f(): boolean { return (void 0 as any) === (void 0); }
```

node: `true`. Legacy (`experimentalIR: false`): `true`. The default pipeline, where the IR claims `f`: `false`. No
shadowing is involved.

## Acceptance criteria

1. `true` on gc and standalone, default and legacy; pinned by a test that fails on main.
2. The fix lives in the IR's undefined-compare lowering (`tryLowerUndefinedCompare` / `isUndefinedCompareOperand`),
   not in a special case for this spelling.
