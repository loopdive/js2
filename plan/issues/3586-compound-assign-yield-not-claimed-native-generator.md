---
id: 3586
title: "`s += yield` (yield in compound-assignment RHS) not claimed by the native generator machine: host lane silently returns 0, standalone emits env imports"
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
language_feature: generators
goal: spec-completeness
related: [2662, 3032, 2864, 3582]
umbrella: 2662
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probes a4d/a4k"
---

# Compound-assignment yield knocks a generator off the native machine

## Problem (verified on main 7652f0337)

A generator whose yield sits in **compound-assignment RHS position**
(`s += yield i`) is not claimed by the native lazy state machine:

```ts
export function test(): number {
  function* g(): Generator<number, number, number> {
    let s = 0;
    for (let i = 0; i < 3; i++) {
      s += yield i; // ← the trigger
    }
    return s;
  }
  const it = g();
  it.next();
  it.next(10);
  it.next(20);
  return it.next(30).value; // node: 60
}
```

- **gc (host, default)**: returns **0** — SILENT wrong answer. The generator
  falls to the eager-buffer backend (#2662): the body runs up-front with all
  sent values as 0, yields are buffered (yielded `i` values still look right),
  and the accumulated return value is 0.
- **standalone**: module demands an `env` import → `WebAssembly.instantiate`
  fails ("Import #0 env: module is not an object or function"). LOUD, but a
  standalone compile that silently emits host imports is itself a gap
  (`strictNoHostImports`-class).

## Control (proves the trigger is the compound-assignment position)

The de-sugared form is claimed and fully correct on **both** lanes, same loop,
same driver:

```ts
function* g(): Generator<number, number, number> {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const t: number = yield i;
    s = s + t;
  }
  return s;
}
// node / gc / standalone all: value 60 ✓  (probe a4k)
```

Note `s = s + (yield i)` (yield nested in a binary RHS) also failed in a
combined-module probe (a4e-g2) — the claim gate likely rejects any yield that
is not a statement / variable-initializer position. The fix should cover
yield in general expression positions, or at minimum pre-desugar
`x op= yield e` into the claimed form.

## Why this matters

This is the engine-selection-boundary hazard in its sharpest form: two
spellings of the same accumulation loop — `s += yield i` vs
`const t = yield i; s = s + t` — get different engines with different
semantics, and the broken one is the DEFAULT lane with no diagnostic.

## Suspected area

The native-generator shape gate (`src/codegen/generators-native.ts` claim
predicate / `buildNativeGeneratorPlan`) rejecting yields in non-canonical
expression positions; host lane then falls back to the eager buffer
(`src/runtime.ts` buffered generator, #2662), standalone falls back to host
imports.

## Acceptance

- The probe returns 60 on gc AND standalone (standalone with zero imports).
- A regression test covering `s += yield`, `s = s + (yield e)`, and yield as a
  call argument (`f(yield e)`).
