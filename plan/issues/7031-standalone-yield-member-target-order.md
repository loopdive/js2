---
id: 7031
title: "standalone: `o.p = yield x` now compiles but evaluates the target reference AFTER the resume — a write lands on the object `o` names at resume time, not the one it named before the yield (§13.15.2)"
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
language_feature: generators, assignment
goal: generator-model
related: [7014, 7026, 2864, 680]
requested_by: ttraenkler/wave15-values-a
---

# #7031 — `o.p = yield x` evaluates the target after the resume (standalone)

Found while triaging `tests/issue-2864-yield-in-expression-position.test.ts`
for #7014 (wave 15). Its "BOUNDARY: a MEMBER assignment target stays on the
host path" test pins a standalone compile REFUSAL, because §13.15.2 evaluates
the target reference before the right-hand side. The refusal is gone: the
shape now compiles, and the order is wrong.

## Repro (`--target standalone`, upstream main `0727e2985b`)

```ts
let q: { p: number } = { p: 0 };
const q1 = q;
function* h(): Generator<number, void, number> { q.p = yield 1; }
export function t2(): number {
  const it = h();
  it.next(0);
  q = { p: 0 };   // rebind while suspended
  it.next(7);
  return q1.p * 10 + q.p;   // JS: 70 — compiled: 7
}
```

The non-rebinding shape (`o.p = yield 1; yield o.p` → 7) is correct, which is
why only the boundary test notices.

## Fix direction

Either restore the refusal for a member target whose base can change across
the suspension, or spill the evaluated base (and computed key) into the
generator state before the yield and write through the spilled reference on
resume. Then turn the boundary test into a value test with the rebinding
repro above.
