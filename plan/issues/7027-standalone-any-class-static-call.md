---
id: 7027
title: "standalone: `(C as any).staticMethod(x)` returns the wrong value — the closed-method dispatcher treats a static-only `<Class>_<name>` as an instance method and passes the class object as the first argument"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, static-methods
goal: standalone-mode
related: [7014, 7026, 2151, 1051, 1983]
requested_by: ttraenkler/wave15-values-a
---

# #7027 — standalone `(C as any).staticMethod(x)` dispatches the static as an instance method

Found while triaging `tests/issue-1051.test.ts` for #7014 (wave 15). Regression
since July: the July 24 tree resolves the call statically (`call $C_id`).

## Repro (`--target standalone`, upstream main `0727e2985b`)

```ts
class C { static id(value: any): any { return value; } }
export function t(): number { const v: any = (C as any).id(42); return v === 42 ? 1 : 0; }
```

Returns `0` (`(C as any).id(42)` yields the class object, so `t5` style
`return v` gives `NaN`). July 24 tree: `1`. Host lane: correct once the
instance is wired.

## Mechanism

`(C as any).id` is no longer resolved by the static arm in
`call-namespace-static.ts` (it requires a bare identifier receiver), so the
call reaches the #2151 closed-method dispatcher (`closed-method-dispatch.ts`,
`collectMethodEntries`). That looks up `classMemberFuncKey(ctx, "C_id",
"instance")`; with no collision the static method's key IS `C_id`, so it is
admitted as an instance arm, guarded by `ref.test $C` (the class-object
singleton has the instance struct type) and called as `C_id(receiver)` — the
receiver lands in `value` and 42 is dropped.

## Fix direction

1. Skip static-only members in `collectMethodEntries`
   (`ctx.staticMethodSet.has(fullName) && !ctx.classMethodSet.has(fullName)`)
   — measured: this turns the wrong value into a thrown TypeError.
2. Then add a static arm: `ref.eq` against the class-object global
   (`ctx.classObjectGlobals`) ahead of the instance arms, calling the static
   with the arguments only. Alternatively restore static resolution for
   `(C as any).m(...)` when the receiver unwraps to a class identifier.

## Acceptance

- The repro returns 1 standalone; `C.put` with a static private field
  (`tests/issue-1051.test.ts` shapes) works standalone.
- An instance call on an instance of the same class is unchanged.
