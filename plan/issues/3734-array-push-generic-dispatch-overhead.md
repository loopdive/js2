---
id: 3734
title: "array.ts landing-page benchmark: IR compiles .push() to a non-inlined helper call while legacy fully inlines it — same IR-vs-legacy gap as #3739/#3741, not a generic-dispatch problem"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: arrays
goal: performance
depends_on: []
related: [3704, 3733, 3739, 3741]
---
# #3734 — `array.ts` push loop: IR emits a non-inlined helper call, legacy fully inlines

## REOPENED 2026-07-28 — the close-out below reached the WRONG conclusion

The close-out section immediately below is **correct about inlining** (the
repeated-`wasm-opt`-to-fixpoint pipeline really does inline
`__vec_elem_set_<N>`) but its **conclusion was wrong**. It attributed the
residual ~2-3x wasm-vs-js gap to "WasmGC array/struct representation
overhead vs. V8's native array fast paths" and closed the issue as
not-actionable-here. That attribution is refuted by direct measurement.

### The measurement that refutes it

Same source, same 4-round `-O4` fixpoint, same process, median of 9 rounds
× 200 calls after 200 warm-up calls:

| build                    | time     | vs JS             |
| ------------------------ | -------- | ----------------- |
| **legacy** (`experimentalIR: false`) | **36.5 µs** | **0.51x — 2x FASTER than JS** |
| JS (V8, native arrays)   | 71.8 µs  | 1.00x             |
| **IR** (default path)    | **200.9 µs** | **2.80x slower**  |

Legacy WasmGC beats V8's native arrays by 2x on this exact benchmark. So
there is **no architectural WasmGC-vs-native-array penalty** here — the
entire gap is an **IR-vs-legacy codegen gap** (5.5x), the same family as
#3739/#3741. Re-measured on the #3741 branch (`6a710844`): still 2.78x, so
#3741's i32-slot promotion as currently scoped does **not** cover this.

Both loops are uniformly ~5x slower, i.e. a per-iteration overhead, not an
allocation/growth artifact:

| variant              | IR       | legacy   | ratio |
| -------------------- | -------- | -------- | ----- |
| fill+sum (benchmark) | 203.8 µs | 38.9 µs  | 5.2x  |
| fill only            | 121.6 µs | 25.0 µs  | 4.9x  |
| sum ×10 (prefilled)  | 862.7 µs | 150.2 µs | 5.7x  |

### Cause 1 — i32-promotion analysis is keyed by variable NAME, not binding identity

The dominant cause. `bench_array` has two **sibling** `for` loops that each
declare their own block-scoped `let i`. These are two distinct bindings, but
the promotion analysis treats them as one name and conservatively rejects
**both**. Isolated on the #3741 branch (counting `i32.add`/`i32.lt_s` vs
`f64.add`/`f64.lt` in the loop bodies):

| case                                    | promoted?             |
| --------------------------------------- | --------------------- |
| one loop, counter `i`                   | ✅ i32                |
| two sibling loops, **both** named `i`   | ❌ **all f64**        |
| two sibling loops, `i` then `j`         | ✅ i32                |
| two sibling loops, both `i` (2nd trivial) | ❌ **all f64**      |

Renaming the second counter `i`→`j` — a pure alpha-rename, no semantic
change — takes the benchmark from **196.3 µs → 132.0 µs (33% faster)** on
the #3741 branch, both producing the correct `49995000`. Two sibling
`for (let i …)` loops is among the most common shapes in real JS/TS, so this
silently disables the optimization across a wide swath of ordinary code, not
just this benchmark. Legacy does **not** have this bug (it promotes both
counters in the same function), so this is specific to the IR port.

### Cause 2 — IR picks an f64 element type where legacy picks i32

Secondary, but structural. For the same `const arr: number[] = []` filled
exclusively with int32-range integers:

- **legacy** lowers `arr` to `(array (mut i32))` — 4 bytes/element, and
  widens with `f64.convert_i32_s` on read.
- **IR** lowers it to `(array (mut f64))` — 8 bytes/element, 2x the memory
  traffic over the 10k-element array, plus a `f64.convert_i32_s` on every
  store from an i32-typed counter.

### What's left after Cause 1

Renaming alone gets IR to 132 µs vs legacy's 36.5 µs — still 3.6x — so
Cause 2 (and possibly further per-iteration conversion overhead) accounts
for the remainder. Fixing Cause 1 is the cheap, high-leverage first step;
Cause 2 is a separate, larger element-type-inference question.

### Acceptance criteria (revised)

- [ ] Fix the name-keying: the promotion analysis must key on **binding
      identity** (symbol / declaration node), not the identifier's text, so
      sibling loops that reuse a counter name are each judged independently.
      Regression test: two sibling `for (let i …)` loops in one function
      must both promote, and must still produce identical results to JS.
- [ ] Re-measure `array.ts` — expect ≥33% improvement from Cause 1 alone.
- [ ] Decide separately whether to pursue Cause 2 (i32 element-type
      inference for integer-only `number[]`), or split it into its own issue.

### Note on ownership

Cause 1 lives in the same IR i32-promotion code #3741 is actively changing
(branch `claude/issue-3741-i32-loop-shadow`). It should be fixed **there**,
not in a parallel branch, to avoid two lanes editing `src/ir/from-ast.ts`
concurrently. This issue tracks the array.ts outcome and Cause 2.

---

## Superseded close-out (2026-07-28) — inlining claim correct, conclusion wrong

**Everything below this line is retained for the record. Its inlining
finding stands; its "residual gap is architectural" conclusion is refuted
by the measurements above.**

## Re-verified 2026-07-28: the real benchmark pipeline already inlines this — no code change landed

The "partially worked" experiment below (raising Binaryen inline thresholds)
was measured against the wrong optimize path. Directly reproducing the
**actual** landing-page artifact pipeline —
`compileMulti(..., {})` (no internal optimize, i.e. `optimize: 0`) followed
by up to 4 rounds of external `optimizeBinaryAsync({level: 4})` run to a
byte-identical fixpoint, exactly what `optimizeBenchmarkWasm()` in
`scripts/generate-playground-benchmark-sidebar.mjs` (and its `-no-jit`
sibling) does — shows **zero remaining calls** to `__vec_elem_set_<N>` inside
`bench_array`'s compiled body. Confirmed three ways: (1) grepping the `.wat`
for `call \d+` inside the function found none after the 4-round fixpoint,
where a single in-process `compile({ optimize: 4 })` call (only one
`setOptimizeLevel`+double-`mod.optimize()` pass, not a repeated-to-fixpoint
external pass) still leaves exactly one `call` per iteration — the discrepancy
is the number of optimization rounds, not a naming/measurement artifact; (2)
instantiating and running the fixpoint-optimized binary returns the
mathematically correct result (`49995000` = sum 0..9999), ruling out the
call site having been eliminated via whole-function constant-folding rather
than genuine inlining; (3) timing it directly gives ~240µs/call in local
sandbox measurement — real per-iteration work, not a near-zero folded
constant.

**Conclusion**: Binaryen's existing repeated-`wasm-opt -O4`-to-fixpoint
pipeline (already in place, unchanged) already achieves what this issue set
out to fix — no compiler source change was needed or made. The acceptance
criterion "`array.ts`'s IR-compiled `.push()` loop matches (or comes close
to) legacy's speed... under the same `-O4` settings the real landing-page
benchmark uses" is satisfied by the status quo. The residual ~2-3x wasm-vs-js
gap that remains even with full inlining (measured via the tier-pinned
warm-chart methodology, #3724/#3726) is a genuine, separate architectural
question — WasmGC array/struct representation overhead vs. V8's native array
fast paths — not a missing-inlining bug, and not scoped here. Closing this
issue; a new issue should be filed if that deeper architectural gap is worth
pursuing.

## Context

Discovered while investigating why the landing-page playground benchmark
(`website/playground/examples/benchmarks/array.ts`) shows wasm running
noticeably slower than JS. The benchmark is:

```ts
export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
```

## Original diagnosis (below) was based on the wrong code path — corrected 2026-07-28

The original write-up (kept below for the record) inspected `.wat` output
and concluded `.push()` on a statically-typed `number[]` was routing through
the generic, `any`-receiver `__vec_push` dispatcher (externref-boxing +
`ref.test` chain, `src/codegen/expressions/call-receiver-method.ts` lines
~3298-3406, the "#2784 S3 Native-vec-aware method dispatch" block). **That
block only fires for `any`/externref receivers whose concrete vec type is
NOT statically known** (its own comment: "a reconstructed-fnctor `T[]` field
read as externref"). `arr: number[]` in the benchmark has a statically known
type, so it **never reaches that dispatcher at all** — the original
diagnosis inspected the wrong branch.

### What's actually happening

Direct investigation (compiling the exact benchmark source and comparing
`experimentalIR: false` vs the default IR path — the same method used for
#3739/#3741) found this is **the same "IR path lacks legacy's optimization"
gap already documented in #3741**, just showing up on `.push()`/array
codegen instead of ToInt32/loop-counters:

- **Legacy already has a fully monomorphic, fully-inlined push fast path**:
  `compileArrayPush` in `src/codegen/array-methods.ts` (line 2938) — direct
  `struct.get`/`array.len`/`array.new_default`+`array.copy` (amortized
  growth)/`array.set`/`struct.set`, zero externref boxing, zero `ref.test`,
  and (being emitted inline into the caller's body, not a separate function)
  zero call overhead.
- **IR lowers `.push()` to a call into a separate, shared helper function**
  instead: `src/ir/from-ast.ts` (~line 5037, the "#2856 element-store
  helper" comment) emits `cx.builder.emitCall(irIntrinsicFuncRef("__vec_elem_set_<N>"), [recv, lenI32, val], null)`
  — reusing the SAME helper plain `arr[i] = v` index-assignment uses. The
  helper's body (materialized elsewhere) is structurally almost identical to
  legacy's inline sequence (same growth-check/`array.new_default`/`array.copy`
  shape) — but it's a genuine `call`, once per `.push()`, 10,000 times in
  this benchmark, not inlined into the loop body.
- Measured directly (same source, `-O4` applied both ways, matching the real
  benchmark's settings): **legacy ~95-140µs, tight; IR ~225-450µs and
  visibly noisy (some runs spike to 1000-1400µs)**. The noise pattern mirrors
  the V8-tiering instability documented for `loop.ts` in #3739 — not just
  raw instruction-count overhead.

### An experiment that only partially worked (not landed)

Tried the cheap, low-risk fix first: raise Binaryen's inlining thresholds
(`setFlexibleInlineMaxSize`/`setOneCallerInlineMaxSize`/`setAlwaysInlineMaxSize`)
so `wasm-opt -O4` inlines `__vec_elem_set_<N>` automatically at its (many)
call sites, no compiler source changes needed. This is safe in principle
(inlining is semantics-preserving) and would have been a very contained fix
if it had fully worked. It only helped partially — IR's measured time
dropped to ~225-500µs but the gap to legacy and the run-to-run noise both
persisted — meaning the overhead isn't purely "missing inlining"; something
about the call-boundary/value-shape itself (plausibly the same f64⇄i32
conversion-at-boundary pattern #3739/#3741 found, or the same tiering
sensitivity) is also in play. Not committed — reverted after the experiment.

### Point 2 from the original write-up (loop-invariant `arr.length` read) is unaffected by this correction

That observation (the sum loop's `for (i = 0; i < arr.length; i++)`
re-reading the length field every iteration instead of being hoisted) is
still accurate and still low-priority/optional — untouched by this
correction, kept for completeness.

## Recommendation

Don't treat this as an isolated "add a monomorphic push fast path" fix — the
generic dispatcher it originally blamed isn't involved. This is the same
underlying architecture gap as #3741 (IR systematically re-derives, via
non-inlined shared helpers and f64-default representations, work legacy
already does inline/natively) manifesting on `.push()`/array codegen.
Whoever picks this up should read #3741 first — the two are almost
certainly best solved together (or by the same underlying mechanism,
whatever that turns out to be), not as separate one-off patches per
benchmark.

---

## Original write-up (2026-07-28, before the above correction)

Compiled (`-O`, JS-host/GC target) and inspected the `.wat`. Two separate
observations, in order of suspected impact:

### 1. `arr.push(i)` calls the generic, polymorphic `__vec_push` helper

Every `.push()` call site compiles to a call into a single shared
`__vec_push(externref, externref) -> i32` runtime function (see
`src/codegen/array-methods.ts`) that:

1. Boxes the receiver to `externref` (`any.convert_extern`).
2. Runtime-dispatches which concrete vec struct type it is via a
   `ref.test`/`ref.cast` chain (checked at least 3 candidate struct type
   indices in the disassembly — presumably one per distinct element
   representation the module uses).
3. Only THEN does the actual amortized-doubling array-growth logic
   (`array.len` vs length field, conditional `array.new_default` + `array.copy`
   when capacity is exhausted, `array.set`, length-field bump) for whichever
   branch matched.

**(Corrected above: this generic dispatcher does not apply to a
statically-typed `number[]` receiver — this description is accurate for the
`any`-receiver case only.)**

### 2. The sum loop re-reads `arr.length` (a `struct.get`) every iteration

```
for (let i = 0; i < arr.length; i++) total = total + arr[i];
```

compiles to a `struct.get 4 0` (the length field) on every loop
iteration instead of being loop-invariant-hoisted once before the loop, even
though nothing in the loop body can change `arr`'s length. This is a single
cheap instruction per iteration (not a call), so likely much smaller impact
than #1 — flagged for completeness, lower priority than the push dispatch.

## Acceptance criteria

- [ ] Read #3741 first — this is very likely the same root cause / same fix.
- [ ] `array.ts`'s IR-compiled `.push()` loop matches (or comes close to)
      legacy's speed for the same source, under the same `-O4` settings the
      real landing-page benchmark uses.
- [ ] Equivalence tests pass, including polymorphic/`any`-typed array push
      call sites and the existing #2856 element-store IR tests (must still
      work — any fix here must not regress the shared `__vec_elem_set_<N>`
      helper's other caller, plain `arr[i] = v`).
- [ ] Re-run the playground benchmark generator and confirm `array.ts`'s
      wasm time improves materially and stops being noisy (check std-dev,
      not just mean — the noise itself is diagnostic).

## Out of scope

- This issue is analysis, not a landed fix — regression-risky enough
  (touches IR call-lowering / shared helper emission) that it should get
  its own dedicated implementation + review pass, very likely combined with
  #3741 rather than attempted separately.
