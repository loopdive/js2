---
id: 3329
title: "host-callback closures: two closures sharing one mutable captured local get SEPARATE ref cells — writes diverge (last writeback wins)"
horizon: m
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-s2
sprint: current
created: 2026-07-16
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: closures, host-callbacks
related: [1794, 1695, 859, 929]
origin: "2026-07-16 fable-s2, discovered while wiring #1794 EventEmitter Tier 0"
---

# Host-callback shared mutable capture: per-closure ref cells diverge

## Problem

When TWO (or more) closures that cross the host boundary (`__make_callback` /
callback-classification host path) capture the SAME mutable outer local, each
closure creation mints its OWN ref cell (closures.ts `refCellLocals`). Writes
made by one callback are invisible to the other, and the caller-side
writebacks apply in creation order — the LAST cell's (possibly stale) value
wins.

Repro (JS-host lane, #1794 EventEmitter):

```ts
import { EventEmitter } from "node:events";
export function test(): number {
  const e = new EventEmitter();
  let sum = 0;
  e.addListener("n", (v: number) => {
    sum = sum + v;
  }); // cell A
  e.on("n", (v: number) => {
    sum = sum + v * 10;
  }); // cell B
  e.emit("n", 3); // A writes 3 into cellA; B reads cellB (stale 0) → 30
  return sum; // writebacks: cellA→local (3), cellB→local (30) → 30, want 33
}
```

Control: the same two closures invoked directly wasm-side return 33 — the
divergence is specific to the host-callback ref-cell path. The needsThis
lane already shares via `fctx.boxedCaptures` + `localMap` repoint
(closures.ts ~2890); the non-needsThis lane does not.

## Expected

Per-LOCAL cell unification: the first boxing of a captured-mutable local
repoints `localMap` (or records in `boxedCaptures`) so every subsequent
closure capturing the same local reuses the SAME cell — like the needsThis
lane already does. Writebacks then become single-source.

## Affected surfaces

- EventEmitter multi-listener shapes (#1794 — test scoped around it)
- DisposableStack defer/use/adopt with multiple callbacks sharing a local (#1695)
- Any host HOF taking two callbacks that co-mutate an outer local

## Acceptance

- The repro returns 33.
- tests/issue-1794.test.ts multi-listener test upgraded back to a SHARED
  accumulator local.
- No regression in tests/disposable-stack\*, tests/issue-1794.test.ts,
  closure equivalence tests.
