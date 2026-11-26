---
id: 7374
title: "`g()?.toFixed()`, `c.a?.toFixed()` and `b?.toString()` on `boolean | undefined` return `undefined` for a defined receiver"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7370, 7360]
---

# #7374 — optional calls on receivers #7370 leaves out

## Problem

#7370 makes `x?.toFixed()` call the method on a defined primitive receiver when the receiver is an identifier or
`this`. Three shapes still return `undefined`, on main and with #7370, gc and standalone alike:

```ts
let n = 0;
function g(): number | undefined { n++; return 2; }
g()?.toFixed(0);                 // node "2" (and n === 1); we return undefined

class C { a: number | undefined = 4; }
new C().a?.toFixed(0);           // node "4"; we return undefined

function f(b: boolean | undefined) { return b?.toString(); }
f(true);                         // node "true"; we do not return "true"
```

## Cause

- **Non-repeatable receivers** (a call, a property chain): #7370 calls the method through the ordinary
  receiver-method ladder (`compileReceiverMethodCall`), which reads the receiver again. That is only safe for an
  identifier or `this`, so these shapes keep the old short-circuit. Fixing them needs the ladder to take the
  receiver value already tested and held in a temp, instead of re-reading it.
- **`boolean | undefined`**: the parameter lowers to a bare i32 that cannot hold `undefined`, so `f(true)` and
  `f(undefined)` cannot be told apart at the call. This is a representation gap in the boolean slot (compare the f64
  sentinel #7360 uses for `number | undefined`), not an optional-call defect.

## Acceptance criteria

- The three reproducers answer like node on gc and standalone; `g()` runs exactly once.
- Repeatable receivers (#7370) keep their bytes.
