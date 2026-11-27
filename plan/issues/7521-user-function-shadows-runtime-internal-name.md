---
id: 7521
title: "A user function named `__make_callback` breaks callback crossing: runtime-internal names share the user namespace"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [3214, 7520]
---

# #7521: user code can shadow a runtime-internal name

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target. The result is the same with
`experimentalIR` on and off:

```ts
type i32 = number;
function __make_callback(_id: i32, capture: object): object { return capture; }
export function install(target: EventTarget, sink: HTMLElement): void {
  target.addEventListener("tick", () => { sink.textContent = "x"; });
}
```

The listener passed to `addEventListener` arrives as a null-prototype `{}`, not a function. Without the user
declaration of `__make_callback` it is a function. `caller(n)` / `independent(n)` in the second #3214 case still
return correct values; only the callback crossing breaks.

A JS program may legally declare any identifier, including `__make_callback`. The compiler resolves its own runtime
helper by a name that user code can reach.

## Fix direction (lead, 2026-11-26)

Put runtime-internal names in a namespace user code cannot reach, instead of detecting collisions one name at a
time.

## Acceptance criteria

- The program above registers a callable listener that sets `sink.textContent = "x"`.
- The two `__make_callback` cases of the #3214 rewrite in the #7520 issue file pass.
- No other runtime-internal helper can be shadowed by a top-level user declaration of the same name. Show this with a
  test over the helper name list.
