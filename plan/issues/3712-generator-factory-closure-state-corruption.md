---
id: 3712
title: "Two generator instances created from the same closure-returning factory corrupt each other's captured state"
status: blocked
sprint: current
blocked_on: 1687
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: hard
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3690 — new tests/differential/corpus/generators/06-closure-state.js surfaced this on first run"
related: [3690]
---

# #3712 — Concurrent generator instances from a shared closure factory corrupt captured state

## Repro

```js
function makeCounter() {
  let total = 0;
  return function* () {
    while (true) {
      total += 1;
      yield total;
    }
  };
}
const start = makeCounter();
const g1 = start();
const g2 = start();
console.log(g1.next().value); // 1
console.log(g1.next().value); // 2
console.log(g2.next().value); // 3 (shares `total` with g1 — same closure)
console.log(g1.next().value); // 4
```

## Symptom

- V8: `1\n2\n3\n4`
- js2wasm: `1\n2\n1000002\n3`

This is not a simple off-by-one: `1000002` is a value that never appears in
the correct trace at all, suggesting the two generator instances (`g1`,
`g2`) are not correctly sharing the single `total` ref-cell from the
enclosing `makeCounter` closure — likely each generator instance is getting
its own copy of (or a corrupted pointer into) the captured variable state
rather than sharing the one mutable cell, and/or generator-local state and
closure-captured state are aliasing incorrectly across the two live
instances. **Flag as correctness-sensitive**: this is a case where two
independently-advancing generator objects share mutable closure state, a
pattern real code (iterator adapters, shared-counter utilities) can hit.

## Repro file

`tests/differential/corpus/generators/06-closure-state.js` (see #3690).

## Root cause (confirmed 2026-07-27) — the smoking gun for the eager-buffer model

Found it exactly: `src/runtime.ts` implements generators via an
**eager-buffer** host runtime (`__gen_create_buffer` / `__gen_push_f64` /
`__gen_push_i32` / `__gen_push_ref`), with a documented, deliberate hard
cap:

```
// Eager-generator hard cap (#991/#992): we lower generators to an array
// that is fully populated before .next() can be called. An infinite
// generator (e.g. `while (true) { yield; }`) would push forever, OOMing
// the Node process ... The cap is high enough (1M) that real-world
// generators are never affected.
const __EAGER_GEN_LIMIT = 1_000_000;
```

**`1000002` in the mismatch is not a random wrong value — it's the cap
leaking into observable output.** `start()` (calling the closure-returning
factory) creates a generator whose body is `while (true) { total += 1;
yield total; }`. Because the model is eager, *creating* `g1` immediately
runs that infinite loop to the 1,000,000-yield cap, incrementing the
**shared closure variable `total`** all the way from 0 to 1,000,000 (buffer
`[1..1000000]`) — before a single `.next()` is called. Creating `g2` right
after does the same thing again, against the SAME now-already-1,000,000
`total`, producing buffer `[1000001..2000000]`. `g1.next()`/`g1.next()`
then just pop 1, 2 from `g1`'s buffer (looks correct by coincidence); the
first `g2.next()` pops `g2`'s buffer head, in the `1,000,00x` range — hence
`1000002` instead of the lazily-correct `3`.

This confirms the `generator-model` goal doc's own diagnosis verbatim:
*"The current eager-buffer implementation is fundamentally broken (infinite
generators are impossible, lazy evaluation lost)."* This repro is a clean,
concrete demonstration of exactly that: not just "infinite generators
misbehave" in the abstract, but **silent, wrong-answer data corruption of
ordinary mutable closure state**, with no error or diagnostic — the
program still runs and prints a plausible-looking (wrong) number.

**Not fixed here.** This needs the same Phase-3 native lazy-generator work
as #3710/#3711 (`src/codegen/generators-native.ts`, `#1687`), specifically
extending native-generator candidacy to generator factories that close
over mutable outer-scope state and infinite/unbounded loop bodies — a
genuinely architectural change to when/how generator bodies execute, not a
local patch. Flagging as the highest-severity of the three sibling issues
(silent correctness bug vs. #3710's wrong-value / #3711's trap) and a good
canonical repro for that work's acceptance criteria.
