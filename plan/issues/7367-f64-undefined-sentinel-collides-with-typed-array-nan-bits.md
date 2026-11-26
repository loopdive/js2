---
id: 7367
title: "A NaN read from a DataView or Float64Array with the f64 `undefined` sentinel's bits reads as `undefined`"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7360, 3369]
---

# #7367 — the f64 `undefined` sentinel is reachable by data

## Problem

An f64 slot that can hold `undefined` carries it as `UNDEF_F64_BITS` (`0x7FF00000DEADC0DE`, a signaling NaN). The
nullish tests (`===`/`==` against `undefined` in `binary-ops.ts`, and since #7360 `??`/`??=`) compare those exact
bits. An ordinary NaN (`0 / 0`, `NaN`) never has them, but a program can make them from data: a `DataView` or
`Float64Array` read of 8 bytes holding that pattern returns a NaN number with the sentinel's bits, and the compiled
program then treats that number as `undefined`.

Found by the #7360 review (RV7307, finding 3); the `===` half is already on `origin/main` (ee3fcdd610).

```ts
const dv = new DataView(new ArrayBuffer(8));
dv.setUint32(0, 0x7ff00000);
dv.setUint32(4, 0xdeadc0de);
const v = dv.getFloat64(0);
v === undefined; // node false (v is NaN); main: true

function f(x: number | undefined): number { return x ?? 7; }
f(dv.getFloat64(0)); // node NaN; with #7360: 7
```

Measured 2026-11-19, gc and standalone alike: the `===` row on main ee3fcdd610; the `??` row on
`claude/7360-nullish-f64` (main answers NaN there only because its `??` never tested the sentinel at all).

## Candidate fix (not yet planned)

Make the sentinel unreachable by data: canonicalise NaN where raw bits become a number, i.e. at the
`DataView.prototype.getFloat64`/`getFloat32` and `Float64Array`/`Float32Array` element reads (any NaN → the
canonical quiet NaN `0x7FF8000000000000`). JS cannot observe a NaN's payload except through those same typed-array
and DataView writes, and the spec lets an implementation pick any NaN bit pattern on such a write (§25.1.3.17
NumericToRawBytes, "implementation-distinguishable NaN"), so canonicalising on read is unobservable for a
conforming program. Check, before planning:

- every raw-bits → f64 boundary (typed-array element get, DataView get, `Atomics`, structured reads in the native
  runtime);
- that the canonicalisation does not touch the internal vector/struct reads that legitimately carry the sentinel
  (#3369 holes, `vec-f64-hole-*`);
- the cost on typed-array-heavy benchmarks (one `f64.ne` + `select` per read).

## Acceptance criteria

- Both reproducers above answer like node on gc and standalone.
- Typed-array and DataView round-trips of ordinary values and of NaN keep their test262 verdicts.
