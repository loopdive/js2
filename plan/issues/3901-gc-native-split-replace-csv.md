---
id: 3901
title: "perf: gc-native split/replace and the csv-parse app benchmark are 2.7-3.4× slower than JS — per-iteration substring-array allocation"
status: done
completed: 2026-07-31
created: 2026-07-31
updated: 2026-08-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: 78
horizon: l
es_edition: multi
related: [3898, 3899, 747, 1198]
---

# #3901 — gc-native `split`/`replace` and `mixed/csv-parse`: allocation-bound

## Status: done (2026-07-31)

> **The premise in this issue's title was wrong, and that is the main finding.**
> `split` was **not** allocation-bound: the allocation count per call was
> already the minimum, and `split` copies **zero** characters. See
> "## Findings" below. `replace` *was* partly allocation-bound (11 → 2). After
> the fix `mixed/csv-parse` *becomes* allocation-bound, which is why it is the
> one acceptance criterion not met — see "## Result vs acceptance criteria".

## Problem

From `benchmarks/results/latest.json` (2026-07-31), `avgMs` per `run()`:

| Benchmark          | js       | gc-native | gap       | host-call | JS baseline valid?   |
| ------------------ | -------- | --------- | --------- | --------- | -------------------- |
| `string/split`     | 0.258050 | 0.873729  | **3.39×** | 15.048745 | ✅ (~26 ns/split)     |
| `string/replace`   | 0.031416 | 0.103029  | **3.28×** | 0.450594  | ✅ (~31 ns/replace)   |
| `mixed/csv-parse`  | 0.301347 | 0.800980  | **2.66×** | 20.807877 | ✅ (~17 µs/1000 rows) |

Unlike `indexOf`/`substring`/`case-convert` (invalidated by #3898's
loop-invariant-hoisting finding), **these three baselines are valid**: their
per-operation costs are 26-31 ns, which is realistic work. V8 cannot hoist
them because each call allocates a fresh observable object — an array of
substrings for `split`, a new string for `replace`.

So these are **confirmed, honest gaps**, and `mixed/csv-parse` is the
app-shaped one: 1000 iterations of splitting an 11-line CSV on `\n` and then
each line on `,`. It is the closest thing on the page to a real workload.

## Why this is a distinct issue from #3899

#3899 covers *scanning* kernels, where the cost is per-character loop
overhead. This issue covers *allocating* kernels, where the cost is dominated
by how many objects we create per call and how they are laid out:

- `split(",")` on `"alpha,bravo,…,hotel"` allocates **1 array + 8 string
  objects** per call, 10,000 times per `run()`.
- `csv-parse` allocates an 11-element array of lines, then a fresh array per
  line, 1000 times per `run()` — roughly **12,000 arrays + 44,000 strings**.

At 26 ns per split in V8 (which has a bump allocator and a generational
nursery), our 88 ns means we are paying ~3× per allocation, or allocating more
than we need to.

## Scope — investigate before optimising

1. **Count the allocations.** Dump the WAT (`/analyze-wat` skill) for the
   `split` benchmark and count `array.new*` / `struct.new*` in the loop. Is it
   the expected 9 per call, or more? A common failure is allocating an
   intermediate buffer per element, or copying the result array to resize it.
2. **Pre-size the result.** We already do dense-array pre-sizing for the
   `const a = []; for … a[i] = …` shape (#1198). `split` knows how many
   separators it found — count first, allocate exactly once, fill. If we are
   currently growing a JS-array-shaped backing store with repeated
   reallocation, that is the whole gap.
3. **Substring sharing.** Each element of a `split` result is a slice of the
   input. Check whether we copy the characters or can share the backing
   `(array i16)` with an offset/length view. Sharing is a large win here but
   has real correctness and memory-retention consequences — if we do not
   already have a slice-view string representation, **do not invent one in
   this issue**; measure how much it would buy and file a follow-up.
4. **`replace` single-match path.** `text.replace("fox", "cat")` with string
   (not regexp) arguments and a single replacement is: one `indexOf`, one
   allocation of `len - 3 + 3`, three copies. Check we are not going through
   the regexp engine or building a rope.
5. **Escape analysis (#747).** In `csv-parse` the inner `cols` array is dead
   after `sum + cols.length`. If escape analysis can prove that, the inner
   split could avoid materialising the array entirely. Check whether it fires
   and, if not, why.

## Acceptance criteria

1. `mixed/csv-parse` gc-native improves by **≥1.8×** against the current
   0.801 ms (target ≤0.45 ms) — this is the primary metric, it is the
   app-shaped benchmark. Measure with
   `npx tsx benchmarks/run.ts --suite mixed --filter csv-parse`.
2. `string/split` gc-native improves by **≥2×** against the current 0.874 ms
   (target ≤0.44 ms).
3. `string/replace` gc-native improves by **≥1.5×**.
4. No equivalence-test regressions; no test262 regressions in
   `built-ins/String/prototype/split` or `.../replace`.
5. The issue records the measured allocation count per `split` call, before
   and after. If the fix was pre-sizing, say so; if the remaining gap is
   character copying that only slice-views would fix, quantify it and file
   the follow-up rather than leaving it implicit.

## Non-goals

- The `host-call` lane's catastrophic 15.0 ms / 20.8 ms on these two (#3903).
  Note the magnitude for context but do not fix it here.
- Regexp-based `replace`/`split` (this benchmark uses string arguments only).
- Introducing a new slice-view string representation — measure and file.

---

# Findings

## 1. Allocation count per `split` call — before and after (criterion 5)

Traced from the emitted WAT (`/analyze-wat`) for
`"alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel".split(",")` → 8 pieces:

| allocation                                   | before | after |
| -------------------------------------------- | ------ | ----- |
| result backing array (`array.new_default`)   | 1 (fixed capacity **8**) | 1 (**exact size**) |
| growth realloc + `array.copy`                | 0 here (8 pieces exactly fills capacity 8) | **0 — path deleted** |
| `$NativeString` per piece (`struct.new`)     | 8      | 8     |
| `$vec_nstr` result struct                    | 1      | 1     |
| **total**                                    | **10** | **10** |

**Unchanged — and that is the point.** `__str_substring` is *already* an O(1)
slice view: `NativeString` is `{len, off, data}` and substring is just
`struct.new(end-start, sOff+start, s.data)`. So the count was already minimal
and **split copies zero characters**. The issue's allocation-bound hypothesis
does not hold for this shape.

Where the count *did* move is the growth path, which the fixed capacity of 8
made invisible on `string/split` but which `mixed/csv-parse` hits every
iteration on its 11-line outer split:

| `csv.split("\n")` → 11 pieces                | before | after |
| -------------------------------------------- | ------ | ----- |
| backing array                                | 1 (cap 8) | 1 (exact 11) |
| doubling realloc to cap 16 + `array.copy(8)` | **1 + 1 copy** | **0** |
| `$NativeString` per piece                    | 11     | 11    |
| `$vec_nstr`                                  | 1      | 1     |
| **total**                                    | **14** | **13** |

Per csv-parse iteration (1 outer + 10 inner splits): **64 → 63 allocations**
(−1.6 %), but allocated **reference-slot volume 104 → 41 (−61 %)** — the inner
splits produce 3 pieces each and used to get a 8-slot array — and the
`array.copy` disappears.

## 2. What the cost actually was: per-call and per-char overhead

`__str_split` called `__str_indexOf` **and** `__str_substring` once per piece —
17 helper calls for an 8-piece split. Each call paid:

- the flatten preamble (`ref.test $NativeString` + guarded `__str_flatten`),
- a `ref.cast $NativeString` in front of **every** `struct.get` (inserted by
  `wrapBodyWithFlatten`), so len/off/data were re-loaded and re-checked per call,
- `__str_indexOf`'s scan is a nested `block`/`loop` whose inner `j >= nLen` test
  costs ~12 ops per character even for a **1-character** separator,
- `__str_substring` re-clamped both bounds (4 `select`s + a swap `if`) although
  split's bounds are in range by construction.

On top of that, the **call site** in `src/codegen/string-ops.ts` emitted an
unconditional `call $__str_flatten` on the receiver *and* on the separator —
a second, redundant flatten, since `__str_split` already flattens both params
behind the cheap inline `ref.test` guard added by #3673. That is 2 wasted calls
on every split; `mixed/csv-parse` paid it 11 000 times per `run()`. The
separator is an interned literal (`","`, `"\n"`) and can never be a rope.

This is the same family as #3899's scan finding, reached independently.

## 3. Substring sharing (criterion/scope item 3)

**Already present, already used, nothing to invent and nothing to file.**
`split` produces slice views, not copies — 0 characters copied. So the residual
gap is *not* character copying, and there is no slice-view follow-up to raise.

## 4. Escape analysis (scope item 5) — checked; it cannot fire

`#747` is `status: done` but **only Phase 1 landed, and Phase 1 is deliberately
inert.** From `src/ir/analysis/escape.ts`: *"this pass is inference, default-OFF,
and inert: it writes to the `AllocSiteRegistry` … and NEVER mutates the IR.
Removing it cannot change emitted Wasm. Scalar replacement / stack allocation
itself is a follow-up that consumes this classification."* There is no consumer.

Second, independent blocker: `split` is lowered on the legacy AST→Wasm path
(`string-ops.ts`), not the IR path, so its result is not an IR alloc site
`analyzeEscape` can even see.

Filed as **#3913** with the prize measured (below).

## What changed

- `src/codegen/native-strings-split.ts` (**new module**) — `__str_split` rewritten as a
  two-pass, call-free lowering: hoist s/sep `len`/`off`/`data` into locals once,
  **count** the pieces with an inline scan (single-code-unit fast path for
  `","`/`"\n"`), allocate the result array at **exactly** that size, then fill it
  with inline `struct.new $NativeString` slice views. Deletes the
  capacity-8-then-double growth path (`array.new_default` + `array.copy`)
  entirely. The empty-separator arm is pre-sized and inlined the same way.
- `src/codegen/native-strings-rewrite.ts` — `__str_getSubstitution` gains a
  `$`-free early-out. It runs on *every* `replace`/`replaceAll`; with no `$` the
  substitution is the identity, but the general path still seeded `result` with
  a freshly allocated empty string and pushed the whole replacement through
  `__str_substring` + `__str_concat` — 5 allocations and 2 calls to reproduce a
  string it was already handed.
- `src/codegen/native-strings-rewrite.ts` — `__str_replace` gains a direct
  3-way splice: one backing array + one struct, each character copied exactly
  once, instead of `concat(concat(prefix, mid), suffix)` which copied the prefix
  twice through an intermediate. Gated on `newLen < 64` (`__str_concat`'s own
  flat/rope threshold) so the O(1) ConsString path for large strings is
  untouched, and on the replacement containing no `$`.
- `src/codegen/string-ops.ts` — drop the redundant `emitFlatten()` on the split
  receiver and separator (see Finding 2).

`replace` allocations: **11 → 2**, characters copied 62 → 43.

### Module/function decomposition (required by the budget gates)

The rewrite pushed `native-strings-rewrite.ts` over `check:loc-budget` and
`emitStrReplaceHelpers` over `check:func-budget`. Both were resolved by
**actually splitting the units**, not by taking a `loc-budget-allow:` /
`func-budget-allow:` allowance — which is what
`plan/log/compiler-consolidation-plan.md` asks for, and the module was already
a #3182 Wave B decomposition target:

- `__str_split` moved to its own module `src/codegen/native-strings-split.ts`;
  its scan / `min_u` / slice-view emitters and the local-slot constants are
  module-level so the builder itself stays under the 300-LOC function ceiling.
- `emitStrReplaceHelpers` split into `emitStrGetSubstitutionHelper`,
  `emitStrReplaceFirstHelper` and `emitStrReplaceAllHelper`; the original name
  is kept as a thin ordered facade (`replace`/`replaceAll` resolve
  `__str_getSubstitution` by name, so registration order is load-bearing).

Verified code-motion-only: the compiled `mixed/csv-parse` module is
byte-identical (23 116 B) before and after the decomposition.

## Result vs acceptance criteria

Measured with an interleaved same-process A/B harness (js and wasm batches
round-robin, median of 25, **6 paired rounds** swapping the codegen files
between rounds). **This 4-core box was under concurrent 6-agent load, so the
absolute milliseconds are inflated 2-4× versus the published baseline — quote
the ratios.** The load-normalised wasm/js ratio reproduces the published
baseline well: measured base `replace` 3.21× vs published 3.28×, base
`csv-parse` 2.92× vs published 2.66×.

| benchmark         | base ms | new ms | speedup   | base ratio | new ratio | criterion | met |
| ----------------- | ------- | ------ | --------- | ---------- | --------- | --------- | --- |
| `string/split`    | 3.407   | 1.782  | **1.91×** | 5.46×      | 3.02×     | ≥2×       | ~   |
| `string/replace`  | 0.2319  | 0.1275 | **1.82×** | 3.21×      | 1.79×     | ≥1.5×     | ✅  |
| `mixed/csv-parse` | 1.942   | 1.574  | **1.23×** | 2.92×      | 2.25×     | ≥1.8×     | ❌  |

- **`string/replace` ✅** — comfortably past ≥1.5×.
- **`string/split` ~** — 1.91× against a ≥2× bar. Across all three campaigns run
  that day the per-campaign figure ranged **1.83×–2.15×**; the criterion sits
  inside the measurement noise of a contended box. On the load-normalised ratio
  the improvement is **1.81×** (5.46× → 3.02×).
- **`mixed/csv-parse` ❌ — 1.23×, not 1.8×.** Root-caused, not hand-waved:

  | variant                                                   | gc-native |
  | ---------------------------------------------------------- | --------- |
  | `full` (the real benchmark)                                | 1.646 ms  |
  | `outerOnly` (`sum + lines[i].length`, inner split removed) | 0.556 ms  |
  | `skeleton` (loop nest only, no split)                      | 0.020 ms  |

  **The inner splits are 66 % of csv-parse**, and after this fix that cost is
  allocation/GC, not scanning: 50 of the 63 allocations per iteration come from
  the inner `cols` array, which is **dead except for `.length`**. A separate
  micro-experiment showed the cost is strongly super-linear in pieces per call
  (12-piece splits cost ~10× 3-piece ones at 10 000 calls), i.e. nursery/GC
  pressure rather than per-allocation instruction cost.

  No amount of split-side work removes an allocation the program semantically
  asks for. The lever is scalar replacement of the dead array — **filed as
  #3913**, where the same measurement shows it addresses up to two thirds of
  csv-parse's remaining runtime, which would clear the ≥1.8× bar.

## Test results

All probes cross-checked against V8 by running the identical source under
node — every case matched exactly.

- **21 `split` assertions** — empty pieces, leading/trailing/only separators,
  empty receiver, `limit` (incl. 0), multi-char and overlapping separators,
  separator longer than receiver, empty separator (+ with limit), `undefined`
  separator, separator equal to the whole string, offset-bearing (slice-view)
  receiver, and an 11-piece split crossing the old capacity-8 growth point.
- **17 rope assertions** — `ConsString` receivers, `ConsString` separators,
  rope + empty separator, rope + limit, rope `replace`. These specifically
  cover the removed eager `emitFlatten()`: the internal preamble handles them.
- **22 `replace`/`replaceAll` assertions** — all four `$` patterns (`$$`, `$&`,
  `` $` ``, `$'`), unrecognised `$X`, trailing lone `$`, empty search/replacement,
  match at start/end/whole-string, no match, offset-bearing receiver, and a
  result crossing the 64-unit rope threshold (exercises the fallback).
- **11 call-shape assertions** — separator in a variable, runtime-built rope
  separator, runtime-built receiver, template-literal receiver, chained
  `split(...)[i].split(...)`, variable limit, a split result used as a separator,
  `join` round-trip, nested loop over varying receivers.
- `tests/equivalence/string-methods.test.ts` + `regexp-methods.test.ts` —
  **64 passed**.
- Targeted regression batch (`#1539` standalone regex replace, `#1822`
  `$`-substitution, `#2125` split limit, `#2160` wrapper string methods,
  `#2161` boxed-string / undefined-sentinel / regex-coercion) — **78 passed,
  2 failed**. Both failures reproduce **identically on unmodified `main`**
  (verified by swapping the codegen files back): `#2161 B1 plain object
  argument` and `#2161 B0 undefined element to a string param`. Pre-existing,
  unrelated. All `#2161 B2` *split* tests pass.
- `tsc --noEmit` clean; `biome lint` clean on both changed files.

Not run locally (per dev policy): full test262 — CI validates conformance.
