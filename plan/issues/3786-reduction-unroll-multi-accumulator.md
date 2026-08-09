---
id: 3786
title: "beat V8 on `loop.ts`: an i32-wrapping reduction is latency-bound on its accumulator chain — unroll with k independent partial sums (measured 192.1 µs, 1.92x FASTER than JS, vs 451.4 µs / 1.22x slower today)"
status: done
completed: 2026-07-29
sprint: 77
created: 2026-07-29
updated: 2026-07-30
priority: high
horizon: l
feasibility: medium
reasoning_effort: max
task_type: performance
area: codegen
language_feature: loops
goal: performance
depends_on: []
related: [3739, 3741, 3758, 3777, 3785]
# `from-ast.ts` +53: `literalCounterEntry` (the counter's compile-time entry
# value AND the slot the init wrote it to) plus the guarded call site in
# `lowerForStatement`. Both must live here — the helper reads `cx.scope` after
# the init has lowered, and the call site sits between buffer collection and
# `emitForLoop`, which is the only point where cond/body/update exist separately
# and are already typed i32. The transform itself (211 lines) is in the new pure
# module `src/ir/reduction-unroll.ts`, not in the god-file.
loc-budget-allow:
  - src/ir/from-ast.ts
---

# #3786 — the accumulator chain is the wall, not the instruction count

## Where we actually are

`loop.ts` is `let s = 0; for (let i = 0; i < 1000000; i++) s = (s + i) | 0;`.

Post-#3740 the emitted code is already about as tight as a naive lowering can
be — native i32 slots, no boxing, no ToInt32 dance:

```wat
(func $bench_loop (result f64)
  (local $i i32) (local $s i32)
  (loop $L
   (if (i32.lt_s (local.get $i) (i32.const 1000000))
    (then
     (local.set $s (i32.add (local.get $i) (local.get $s)))
     (local.set $i (i32.add (local.get $i) (i32.const 1)))
     (br $L))))
  (f64.convert_i32_s (local.get $s)))
```

Four operations per iteration. And yet it loses to V8. Measured on Node 26
with the #3785-fixed harness, `--no-liftoff`, JS pinned to TurboFan, median of
9 rounds, every variant result-checked against the JS answer:

| variant                              | time         | vs JS                     |
| ------------------------------------ | ------------ | ------------------------- |
| **current (what we ship)**           | 451.4 µs     | **1.22x slower**          |
| rotated (bottom test, 1 branch/iter) | 413.7 µs     | 1.12x slower              |
| unroll×4, single accumulator         | 383.6 µs     | 1.04x slower              |
| multi×2                              | 289.7 µs     | 0.78x — faster            |
| multi×4                              | 216.6 µs     | 0.59x — faster            |
| **multi×8**                          | **192.1 µs** | **0.52x — 1.92x faster**  |
| multi×16                             | 196.4 µs     | 0.53x (register pressure) |
| JS (V8 TurboFan)                     | 369.2 µs     | 1.00x                     |

## Why counting instructions was the wrong model

369 µs for 1,000,000 iterations is **~0.37 ns/iter, ≈1.1 cycles**. There is no
room there for "emit fewer instructions" to matter much — the loop is **bound by
the latency of the serial dependency on `s`**. Every iteration's `i32.add` must
wait for the previous one to retire, so the floor is one add-latency per
iteration no matter how cheap the surrounding code gets.

That is exactly what the table shows. Removing a branch (rotation) buys 8%.
Unrolling ×4 while keeping **one** accumulator buys another 7% — small, because
it shortens nothing on the critical path. Splitting into **independent partial
sums** is what actually moves it, because k chains retire in parallel and the
loop becomes throughput-bound: **2.35x** from the same instruction budget.

`k=8` is the knee; `k=16` regresses slightly on register pressure.

## Why the reassociation is legal

`(s + i) | 0` is ToInt32 of the sum, i.e. **addition modulo 2³²**, which is
associative and commutative. Partitioning the addends across k accumulators and
summing the partials at exit yields the identical bit pattern. This is _not_
valid for float `+` (non-associative), which is why it must be gated on the
i32-wrapping form specifically — the same `| 0`-anchored proof #3741 already
established for slot promotion.

It is also why **V8 cannot do this for us**: in JS, `s + i` is float addition
that V8 has _speculatively_ narrowed to int32. It will not reassociate a
reduction it only knows to be int32 by speculation. Our `| 0` makes the wrapping
semantics explicit and static, so we are entitled to an optimization the JIT is
not. That is the interesting part of this result — it is a place where AOT
knowledge beats a JIT on principle, not by out-tuning it.

## Implementation — must be at the IR level, NOT an AST rewrite

The obvious design is a source-level rewrite: synthesize `s0..s7`, unroll the
body, lower normally, and inherit every existing proof for free. **This does not
work, and the reason is worth recording:** synthetic `ts` nodes carry no symbols,
so the checker cannot type them, so `proveUnboxedNumberLocal` (#2782/#2790)
cannot discharge its proof on the new accumulators. They would fail the gate —
the very one #3784/#3805 just made demote cleanly — and the function would fall
back to legacy, losing the entire win. Verified by inspection of the gate's
dependency on `d.name` + `cx` checker types.

So the transform belongs where values are **already typed i32**: on the
instruction buffers, in `lowerForStatement` (`src/ir/from-ast.ts:6673`), which
already collects `cond` / `body` / `update` separately before calling
`builder.emitForLoop({cond, condValue, body, update, loopLabel})`.

Proposed shape — a new pure module `src/ir/reduction-unroll.ts`:

```
tryUnrollReduction({ cond, condValue, body, update, builder }) -> buffers | null
```

Recognition (all of these, else return `null` and lower unchanged):

1. **cond** is exactly `slot_get(i)`, `i32.const N`, `i32.lt_s` with `N` a
   literal — so the trip count is known at compile time.
2. **update** is exactly `slot_get(i)`, `i32.const 1`, `i32.add`, `slot_set(i)`.
3. **body** is exactly one accumulate: `slot_get(acc)`, `slot_get(i)`,
   `i32.add`, `slot_set(acc)` — with `acc` an i32-promoted slot, `acc ≠ i`, and
   `acc` read/written nowhere else in the body.
4. No control flow, no calls, no memory/GC ops anywhere in the buffers.

Emission, with `N` known and `k = 8`:

- `floor(N / k)` iterations of a k-way unrolled body over k fresh i32 slots
  (`builder` allocates them; they are i32 by construction, so no proof needed).
- the `N mod k` remainder as **straight-line** iterations after the loop — no
  residual loop required, because `N` is a compile-time constant. This is what
  keeps the first slice small and fully verifiable.
- combine: `acc = s0 + s1 + … + s(k-1)` at exit.

Deliberately out of scope for the first slice: non-literal bounds (needs a real
residual loop), steps other than 1, `-=` / `^=` / `*=` reductions (all legal mod
2³², all mechanical follow-ups), and multiple accumulators in one loop.

Loop **rotation** (row 2 of the table, ~8% on its own and independent of this)
is worth its own issue: it changes the shape for _every_ loop and has to keep
`continue` targeting the update, so it carries different risk.

## Acceptance criteria

- [x] `loop.ts` measures faster than the JS lane on Node 26 through the
      #3785-fixed harness. **191.2 µs vs 367.4 µs — 0.52x, i.e. 1.92x faster.**
      Target was ≤250 µs; the emitter landed on the hand-measured 192.1 µs
      ceiling almost exactly.
- [x] Differential against real JS over trip counts covering every remainder
      mod 8: `N ∈ {0,1,2,7,8,9,15,16,63,64,65,100,127,128,1000,999999,1000000}`.
      All agree.
- [x] Wrap-past-2³¹ exercised explicitly (`N=1000000` sums to 499,999,500,000;
      the wrapped answer 1,783,293,664 matches JS).
- [x] Reject list, each of which would be a miscompile if accepted: float
      accumulator, accumulator aliased in the body, non-literal bound, step ≠ 1,
      and init declaring a different binding than the cond tests. A rejected
      loop is additionally asserted to still compute the JS answer.
- [x] Equivalence gate: no new regressions.

## What landed

Measured end-to-end through the full generator on real `node v26.5.0`:

| benchmark     | wasm         | js           | ratio            |
| ------------- | ------------ | ------------ | ---------------- |
| `fib.ts`      | 3892.8 µs    | 9756.8 µs    | 2.51x faster     |
| **`loop.ts`** | **191.2 µs** | **367.4 µs** | **1.92x faster** |
| `string.ts`   | 5.3 µs       | 5.1 µs       | parity           |
| `array.ts`    | 45.5 µs      | 62.7 µs      | 1.38x faster     |

Emitted shape, post-`wasm-opt -O4` fixpoint — 8 independent chains, trip count
125,000 (= 1,000,000 / 8), one compare:

```wat
(loop $label
 (if (i32.lt_s (local.get $1) (i32.const 125000))
  (then
   (local.set $2 (i32.add (local.get $0) (local.get $2)))
   (local.set $3 (i32.add (local.get $3) (i32.add (local.get $0) (i32.const 1))))
   (local.set $4 (i32.add (local.get $4) (i32.add (local.get $0) (i32.const 2))))
   ...
```

### The trap that made the first version a silent no-op

#3741 deliberately keeps a promoted counter's `ScopeBinding.type` at **f64**
while its **slot** is i32 — that asymmetry is precisely how it avoided a
consumption-site blast radius. So the natural guard, "only proceed if the
binding's IrType is i32," rejects every loop this transform exists for. The
first version compiled, typechecked, passed all 17 differential fixtures — and
fired on **0 of 17**, because a no-op is trivially correct. Only the
`[unrolled]` column in the fixture output revealed it. The slot's i32-ness is
now established structurally instead: the recogniser accepts only a
cond/update/body built from `i32.lt_s` / `i32.add` against that same slot index.

Worth remembering as a category: for an optimization, "all tests pass" and "the
optimization ran" are independent claims, and only the second one is at risk of
being silently false.

## Provenance

Measured while answering why the landing page and a browser re-run disagreed.
All numbers here are from a real `node v26.5.0` (CI's engine) with the #3785
harness fix applied, on hand-written `.wat` A/B variants optimized through the
same 4-round `wasm-opt -O4` fixpoint the artifact pipeline uses — i.e. the
ceiling is measured, not projected. The recogniser design was checked against
the actual `lowerForStatement` structure and the `proveUnboxedNumberLocal`
dependency before being written down.
