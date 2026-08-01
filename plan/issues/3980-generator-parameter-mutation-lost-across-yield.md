---
id: 3980
title: "A generator PARAMETER mutated in the body reverts to `undefined` after the first `yield` — locals survive, parameters do not"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: generators
goal: core-semantics
related: [3977]
---

# A generator parameter mutated in the body is lost across the first `yield`

## Problem

Assigning to a **parameter** inside a generator works until the generator
suspends. After the first `yield`, the parameter reads back as `undefined` —
the write went somewhere the generator frame does not preserve.

```js
function* g(a, b) {
  b = a; // any mutation; `b ??= a` behaves identically
  yield 0;
  yield b;
}
[...g(3)][1];
//  native: 3
//  wasm:   undefined
```

A **local** declared in the body, mutated the same way, survives correctly:

```js
function* g(a) {
  let b = a;
  yield 0;
  yield b;
}
[...g(3)][1]; // wasm: 3 — correct
```

So the defect is specific to **parameters**, not to mutation-across-suspension
in general. That asymmetry is the useful part of the diagnosis: whatever
mechanism spills body locals into the generator frame is not being applied to
the parameter slots.

## Measured

| program                                                       | native | wasm        |
| ------------------------------------------------------------- | -----: | ----------- |
| `function* g(a,b){ b ??= a; yield b; }` → first value          |      3 | 3 — OK      |
| `function* g(a,b){ b ??= a; yield 0; yield b; }` → second      |      3 | `undefined` |
| `function* g(a,b){ b = a; yield 0; yield b; }` → second        |      3 | `undefined` |
| `function* g(a){ let b = a; yield 0; yield b; }` → second      |      3 | 3 — OK      |
| `function* g(a,b){ b ??= a; for(let i=0;i<b;i++) yield i; }`   |      3 | **1**       |

The first row is what makes this dangerous: reading the parameter *before* any
suspension gives the right answer, so the bug is invisible to any test that
does not yield first.

The last row is how it actually shows up in real code, and it is the worst
shape — a **silent wrong answer, not a trap**. The loop bound re-reads `b`
after the first suspension, gets `undefined`, `i < undefined` is false, and the
generator stops after one element. A caller sees a short sequence, not an error.

## Where it came from

`lit-html`'s published `range` directive, via lit's own upstream test suite
(#3977). The published implementation is exactly this shape:

```js
function* o(o2, t, e = 1) {
  const i = void 0 === t ? 0 : o2;
  t ?? (t = o2); //  <-- parameter mutated
  for (let o3 = i; e > 0 ? o3 < t : t < o3; o3 += e) yield o3; //  <-- re-read after yield
}
```

`[...range(3)]` returns `[]` where it should return `[0, 1, 2]`, and
`[...range(2, 1)]` runs away — `Eager generator buffer exceeded 1000000 yields`
— because the loop bound became `undefined` and the direction test flipped.

`??=` is **not** implicated: plain `b = a` fails identically, and `??=` on a
local or in a non-generator function is fine.

## Acceptance criteria

- [ ] A parameter mutated in a generator body retains its value across every
      subsequent suspension, matching a body local.
- [ ] The five rows in the table above all match native.
- [ ] `lit-html`'s `range` directive passes its five upstream tests in the
      #3977 suite.
- [ ] An equivalence test covers read-after-yield for a mutated parameter,
      including the loop-bound shape — the case that fails silently rather than
      trapping.
