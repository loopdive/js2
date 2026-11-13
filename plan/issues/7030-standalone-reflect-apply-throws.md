---
id: 7030
title: "standalone: `Reflect.apply(f, thisArg, [x])` compiles since #5140 but throws for ordinary closures — the #1905/#2046 refusal tests still expect a compile refusal"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: Reflect
goal: standalone-mode
related: [7014, 7026, 5140, 1905, 2046, 1472]
requested_by: ttraenkler/wave15-values-a
---

# #7030 — standalone `Reflect.apply` throws for ordinary closures

Found while triaging `tests/issue-1905.test.ts` and `tests/issue-2046.test.ts`
for #7014 (wave 15). Both still assert that standalone REFUSES
`Reflect.apply`; since dea875d1b1 (#5140, "ES2015 proxy conformance wave 1")
it compiles through the native `__apply_closure` arm in
`call-namespace-static.ts`. The refusal tests cannot simply be flipped,
because the compiled form is wrong for common shapes.

## Repro (`--target standalone`, upstream main `0727e2985b`)

```ts
function add(this: any, a: number, b: number): number { return (this ? this.base : 0) + a + b; }
function dbl(x: number): number { return x * 2; }
export function t1(): number { return Reflect.apply(add, { base: 100 }, [1, 2]) as number; } // 103 ✓
export function t2(): number { return Reflect.apply(Math.max, undefined, [3, 9, 4]) as number; } // 9 ✓
export function t3(): number { return Reflect.apply(dbl, null, [21]) as number; } // throws, want 42
export function t4(): number { const f = (x: number) => x * 2; return Reflect.apply(f, undefined, [21]) as number; } // throws, want 42
```

The same with `experimentalIR: false`, so it is the legacy arm.

## Acceptance

- t3/t4 return 42 standalone; the #1905 / #2046 refusal tests are rewritten
  to assert the native behaviour (they are red on main since #5140).
