---
id: 3754
title: "perf: the `method` axis is 6.21x node — the second-largest remaining gap after #3753"
loc-budget-allow:
  # The numeric-return twin touches exactly the four sites that must agree on
  # the ABI (twin minting, trampoline results, the shim, the verdict itself),
  # each carrying the soundness argument for why it can impose a type the
  # declaration does not have.
  - src/codegen/typed-this.ts
  - src/codegen/closures.ts
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
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
- [x] Numeric-return twins implemented across all four points above.
- [x] Measured by same-container interleaved A/B behind a kill switch, with
      matching checksums.

## Result (2026-07-28)

Implemented across all four points. `refinedTwinReturnType` (typed-this.ts) is
the single verdict both the twin's minting and the trampoline's reservation
consult, so they cannot disagree; `JS2WASM_NUMERIC_TWINS=0` restores the boxed
ABI byte-for-byte.

### Measurement — same container, interleaved, checksums matching

Three interleaved rounds of the js2 leg, `JS2WASM_NUMERIC_TWINS` on/off. Every
checksum matched on every axis in every round. Round 1 is discarded as warmup:
its `numeric` reading (3.63 ms against a 1.41 ms steady state) shows the
container was still noisy, and `numeric` is an axis this change cannot touch —
which is exactly what makes it a usable noise detector rather than a judgement
call.

| axis      | twins off | twins on | note                        |
| --------- | --------: | -------: | --------------------------- |
| method    |     4.22 | **0.95** | **4.4x**                    |
| numeric   |     1.41 |     1.41 | untouched (the noise probe) |
| prop      |     0.63 |     0.64 | untouched                   |
| alloc     |    0.138 |    0.139 | untouched                   |
| tokenizer |     0.76 |     0.74 | untouched (within noise)    |

Against node measured in the same container minutes later (0.426 ms → 0.474 ms
this run), the `method` axis goes from **8.88x to 1.99x**.

### What the loop body became

    call $__dc_P_inc_0_g     ;; -> f64
    f64.add

The two conversion calls per iteration that #3754's profile named
(`__to_primitive`, `__unbox_number`) are gone, and the twin no longer ends in
`__box_number`.

## The second lever, now PRICED (2026-07-28) — worth 2.24x, still open

The per-call `ref.test` in the guarded `__dc_*_g` trampoline was measured the
same way #3755 was falsified: a throwaway patch making the fill emit the twin
arm unconditionally (unsound in general; valid for this benchmark, whose
receiver really is a `P`). That measures the CEILING of any hoisting scheme.

Same container, interleaved, checksums matching:

| arm             | numeric | method     |
| --------------- | ------: | ---------: |
| guarded (today) |  1.4017 |     0.9501 |
| **unguarded**   |  1.4186 | **0.4240** |
| guarded (today) |  1.4134 |     0.9556 |
| **unguarded**   |  1.4170 | **0.4331** |

**2.24x.** And 0.424 ms is *node parity* — node measured 0.426–0.474 ms on this
axis in the same container. `numeric` is flat across all four arms, so this is
signal, not drift.

That is a much larger residual than expected for one `ref.test`: ~1.8 ns per
iteration, far more than a well-predicted branch. The likely mechanism is not
the test itself but the two-armed `if` around it defeating inlining of the
trampoline at the call site — worth confirming before choosing an approach,
because it changes which fix is right.

### Three experiments, and what they actually pin (2026-07-28)

| shape of the guarded trampoline                | method |
| ---------------------------------------------- | -----: |
| today: `ref.test` + inlined legacy else arm     |  0.950 |
| guard removed entirely (twin arm unconditional) |  0.424 |
| guard KEPT, else arm shrunk to `unreachable`    |  0.420 |
| guard KEPT, else arm lifted to a `call $..._slow` | 0.954 |

Read together these are decisive, and they rule out the two obvious fixes:

1. **It is not the `ref.test`, and not the branch.** Keeping both while making
   the else arm `unreachable` recovers the entire win (0.420 vs 0.424).
2. **It is not the arm's SIZE either.** Lifting the legacy sequence into its own
   `__dc_<F>_<m>_<n>_slow` function — implemented, verified emitting a 30-line
   trampoline whose else arm is a single forwarding call — recovers **nothing**
   (0.954). That change was written, measured, and reverted rather than landed:
   it is sound and it works, but shipping a no-op complexity increase is worse
   than not shipping it.

So the cost is the **presence of a second reachable call** in the trampoline.
With `unreachable` the function has exactly one call and the engine inlines it
into the hot loop; with any real fallback — inline or out-of-line — it has two
and does not. Moving the fallback around inside the function cannot fix that.

### What the fix therefore has to be

The fallback must leave the hot function ENTIRELY, which means the call site
must be able to choose the **unguarded** `__dc_<F>_<m>_<n>` trampoline. That in
turn requires the receiver-flow verdict to be a PROOF rather than an inference —
today it is explicitly not one. `provenReceiverClass` says so in as many words:
"Soundness does not rest on it — the emitted `ref.test` does."

The verdict is close, though. `analyzeReceiverFlow`'s `source: "new-binding"`
already means "initialised from `new F(…)` and never written after", and pass 3
withdraws on `=`, `delete` and `++`/`--`. To promote that to a proof, pass 3
must also withdraw on the write forms it currently misses:

- compound assignment (`p += …`, and every other assignment-operator token),
- destructuring assignment targets (`[p] = …`, `({p} = …)`),
- `for (p of …)` / `for (p in …)` loop bindings.

Plus one check the analysis does not make today: a constructor that explicitly
returns an object makes `new F(…)` yield something other than `$__fnctor_F`, so
an unguarded `ref.cast` would trap. Admission must require the class's
constructor to have no object-returning `return`.

With those closed, `source === "new-binding"` is sound to lower unguarded, and
no loop-invariant code motion is needed at all.

### The superseded approach (kept for the reasoning)

The guard exists because a receiver-flow verdict (#3685) is a whole-program
*inference*, so an unguarded `ref.cast` would turn imprecision into a trap.
But the benchmark's shape is stronger than an inference:

```js
var p = new P(0);          // the ONLY definition of this slot
for (…) { s = s + p.inc(); }
```

A local whose **every** definition is a `new <Class>(…)` has a *proven* class,
not an inferred one — the same "every def" formulation `numericSlots` already
uses, on the same `ScopeTable`/`Slot` machinery. For that narrow case the
unguarded `__dc_<F>_<m>_<n>` trampoline is sound with no hoisting pass at all.

That is the recommended slice: strengthen the admission for write-once
`new`-initialised locals, rather than building loop-invariant code motion.

## Follow-on status

- **second lever** — priced at 2.24x above, NOT yet implemented.
- **#3755** (per-call `__str_flatten`) — measured, worth 0, closed wont-fix.
- **#3765** (numeric locals stay boxed) — the tokenizer's real remaining lever,
  filed from the same profiling round.
