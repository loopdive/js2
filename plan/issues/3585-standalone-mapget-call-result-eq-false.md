---
id: 3585
title: "Standalone: `m.get(k) === lit` false in direct call-result position (true via a local); an any-keyed Map poisons even typed Maps module-wide"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: Map, equality
goal: standalone-gap
related: [2773, 2141, 2040, 3053]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probe s2h/s2i"
---

# Standalone: Map.get result compared in direct call-result position answers false

## Problem (verified on main 7652f0337, target: standalone)

Comparing a `Map.get()` call result **directly** against a numeric literal
answers `false`, while routing the identical value **through a local** answers
`true` — in the same module, same map, same key:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const arr: any[] = [a];
  const m = new Map<any, number>();
  m.set(a, 7);
  let code = 0;
  if (m.get(a) == 7) code += 1; // direct loose  — FALSE (wrong)
  if (m.get(a) === 7) code += 2; // direct strict — FALSE (wrong)
  const g = m.get(a);
  if (g == 7) code += 10; // local loose  — true
  if (g === 7) code += 20; // local strict — true
  if (arr.length === 1) code += 100;
  return code; // node/gc: 133 · standalone: 130
}
```

**Silent wrong answer** — no trap, no refusal. `if (map.get(k) === v)` is an
extremely common idiom, so the blast radius is large.

### Module-composition sensitivity (worse)

The presence of an **any-keyed Map elsewhere in the module** poisons even a
fully **typed** `Map<object, number>`:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const m = new Map<any, number>();
  m.set(a, 7); // ← any-keyed map present
  const m2 = new Map<object, number>();
  const plain = { v: 2 };
  m2.set(plain, 3);
  const g = m2.get(plain);
  let code = 0;
  if (g === 3) code += 1; // via local  — true
  if (m2.get(plain) === 3) code += 10; // direct strict — FALSE (wrong)
  if (m2.get(plain) == 3) code += 100; // direct loose  — FALSE (wrong)
  return code; // node/gc: 111 · standalone: 1
}
```

In **isolation** (no any-keyed Map in the module) the typed-map version passes
(probe s2c: 111110 everywhere). So which reader/eq path `m2.get` takes is
decided by unrelated module contents — a representation-coherence violation of
exactly the #2773 class: the call-result-position value reaches the eq lowering
in a different representation than the local-materialized one, and the
module-wide carrier selection shifts when an any-keyed Map exists.

Not IR-related: identical divergence with `experimentalIR: false`.

Host (gc) lane is correct in all variants. `m.has(...)` is correct; arithmetic
on the value (`(g as number) + 0 === 7`) is correct — only the ==/=== lowering
against the direct call result is wrong.

## Suspected area

Standalone Map carrier value read (collections codegen) returning an
externref/boxed rep in expression position, vs the any-eq / tag-5 classifier
path (`src/codegen/any-eq-helpers.ts`, `any-helpers.ts` tag5 emit) not
unboxing that rep. The local-assignment path forces an unbox via rep
inference, which is why the local variant works.

## Acceptance

- Both probes above return the node value (133 / 111) under
  `target: "standalone"`.
- Add both as standalone regression tests (direct-position and
  module-composition variants).
