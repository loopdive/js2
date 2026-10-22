---
id: 7121
title: "CE: `v instanceof F` with a parameter `F` shadowing a top-level `function F` mutates a sealed prepared scope"
status: ready
created: 2026-10-22
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: crash-free
related: [7106, 7120]
---

# CE: `instanceof` on a parameter that shadows a top-level function constructor

## Reproduction (measured 2026-10-22 on main 8b707ede0f)

```ts
function F() {}
export function probe(v: any, F: any) {
  return v instanceof F;
}
```

Compile fails on `--target standalone` and on the default gc target:

```
Codegen error: ABI draft ir-binding:v1:support:ir-unit%3Av1%3Air-source…:top-level-function:0000000000000000:function-value-trampoline:0000000000000000
would mutate sealed prepared scope prepared-component:ir-unit:v1:ir-source…:root:top-level-function:0000000000000000
```

- `probe` itself is refused by IR selection (`body-shape-rejected`), and the
  top-level `F` ships an IR body. The failure comes while legacy compiles
  `probe`.
- A plain read of the same shadowing parameter (`return F;`) compiles.
- So the trigger is the `instanceof` right operand: a function-value
  trampoline is drafted for the TOP-LEVEL `F`, although the occurrence binds
  the parameter, after `F`'s prepared scope was sealed.

Found while building the #7106 `dyn.instanceof` arm (#6848), whose refusal
test uses a top-level `var F` instead of `function F` because of this. It is
identical without that change, and on the #6847 stack base.

## Likely cause (to confirm)

Legacy's `instanceof` dispatch keys the right operand by its NAME (`ctorName
= expr.right.text`). The fnctor arm (`tryEmitNativeUserCtorInstanceOf`, or the
function-object value path behind it) then resolves `F` as the top-level
function constructor, ignoring that the identifier binds the parameter. The
draft is the symptom; the name-keyed lookup is the bug. A shadowed name must
reach `emitDynamicInstanceOf`, the generic runtime operator.

## Acceptance criteria

- The reproduction compiles on standalone and default gc, and
  `probe(new F(), F)` / `probe({}, F)` answer as node.
- The top-level-`F` arms still apply when the identifier really binds the
  top-level function.
