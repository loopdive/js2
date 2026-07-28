---
id: 3754
title: "perf: the `method` axis is 6.21x node — the second-largest remaining gap after #3753"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [3753, 3683, 3684, 3685]
origin: "benchmarks/cross-engine — measured on main 02a5512e0, 2026-07-28"
---

# #3754 — the `method` axis, 6.21x

## Measurement

Same run as #3753 (one container, checksums matching, min-of-5):

| axis      |  node |   js2 |  js2/node |
| --------- | ----: | ----: | --------: |
| method    | 0.552 | 3.433 | **6.21x** |
| tokenizer | 0.076 | 0.725 |     9.54x |

#3753 addressed the tokenizer axis (now 1.92x better there). `method` is
untouched and is now the largest gap.

## Why it is a separate issue from #3753

The tokenizer axis is a fnctor with `this.<field>` state; #3753's levers were
field REPRESENTATION and the boxed arithmetic around it. The `method` axis
(`benchmarks/cross-engine/axes-core.js`) isolates **dispatch** — repeated calls
through a receiver — with far less field traffic, so #3753's two fixes do not
obviously transfer. It needs its own profile before any lever is chosen.

Notably js2 is only 2.61x off Porffor here while being 10.96x BETTER than
Porffor on `prop` — so the deficit is specific to call dispatch, not to object
representation generally.

## Profile (done — 2026-07-28, Node 24, main + #3753)

Re-measured after #3753's slices landed on the branch. Node 24 this time, so the node column moved;
only the same-run ratios are meaningful:

| axis       |  node |   js2 |  js2/node |
| ---------- | ----: | ----: | --------: |
| alloc      | 0.659 | 0.128 |     0.19x |
| numeric    | 1.258 | 1.231 |     0.98x |
| prop       | 0.549 | 0.546 |     1.00x |
| string     | 0.117 | 0.135 |     1.15x |
| tokenizer  | 0.140 | 0.606 |     4.32x |
| **method** | 0.426 | 3.783 | **8.88x** |

#3753 took the tokenizer axis from 9.54x to 4.32x and `prop` to parity.
`method` is now the worst by a wide margin.

### The loop body, calls resolved by index

`benchMethod` is `s = s + p.inc()` 300,000 times, where `p` is a **plain
local** — not `this`:

```
call $__dc_P_inc_0_g     ;; guarded devirtualized call
call $__to_primitive     ;; the returned externref -> primitive
call $__unbox_number     ;;                        -> f64
```

Two conversion calls per iteration, plus a `ref.test` guard inside the `_g`
trampoline.

### What did NOT fix it

#3753 S2's numeric-operand recognition was restricted to `this.<m>()` — an
accident of where it was measured (a tokenizer, whose calls are all
`this.next()`). Widening it to ANY receiver is sound (the verdict is a
whole-program property of the method NAME, not of the receiver) and is landed,
but it moved the axis only 3.783 -> 3.756ms. So boxing at the ARITHMETIC is not
the cost here — the cost is the ABI.

### The actual cost, and the fix

`P.prototype.inc` returns a number, but its typed twin is declared to return
`externref`, so every call boxes on the way out and pays `__to_primitive` +
`__unbox_number` on the way in. That is the **numeric-return twin** — the very
first thing #3753 proposed, deferred twice because it changes the trampoline
ABI, and now the measured blocker on the largest remaining axis.

Required together (they must agree or the module fails validation):

1. twin declared `results: [f64]` when its returns are provably numeric;
2. `reserveDirectCallTrampoline` results follow the twin;
3. the legacy degradation arm unboxes once, so both arms yield the same wasm
   result type;
4. the generic body's shim can no longer `return_call` across differing
   results — it needs `call` + box.

A second, independent lever: `__dc_P_inc_0_g` is GUARDED. With a receiver whose
class is proven for the whole loop, the `ref.test` should hoist out rather than
run per call.

## Acceptance criteria

- [x] A per-call cost table for the `method` axis, calls resolved by name.
- [x] The dominant cost named, with WAT evidence: the externref twin ABI, not
      the arithmetic.
- [ ] Numeric-return twins implemented across all four points above.
- [ ] Measured by same-container interleaved A/B behind a kill switch, with
      matching checksums.
