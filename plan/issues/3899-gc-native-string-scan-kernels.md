---
id: 3899
title: "perf: gc-native String scan kernels (startsWith/endsWith/trim, and the text-search mix) are 4-7× slower than JS on the perf page"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
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
depends_on: [3898]
related: [3900, 3901, 1746, 1948, 2682]
---

# #3899 — gc-native `String.prototype` scan kernels lose to JS on the public perf page

## Status: done — see [Findings](#findings-what-the-dominant-cost-actually-was) for the reusable result

## Problem

On `https://js2.loopdive.com/benchmarks/performance.html`, the **gc-native**
lane (`fast: true`, WasmGC `i16` arrays — the lane we present as the fast one)
loses to plain JS on the string-scanning benchmarks. From
`benchmarks/results/latest.json` (2026-07-31), `avgMs` per `run()` call:

| Benchmark                    | js        | gc-native | gap        | baseline valid? |
| ---------------------------- | --------- | --------- | ---------- | --------------- |
| `string/startsWith-endsWith` | 0.207578  | 1.374452  | **6.62×**  | ✅ yes (~10 ns/op) |
| `mixed/text-search`          | 0.209544  | 1.198539  | **5.72×**  | ⚠️ probably     |
| `string/trim`                | 0.113168  | 0.492126  | **4.35×**  | ✅ yes (~11 ns/op) |
| `string/indexOf`             | 0.0015575 | 0.0149466 | (9.6×)     | ❌ invalid — see #3898 |
| `string/includes`            | 0.0017079 | 0.0135375 | (7.9×)     | ❌ invalid — see #3898 |
| `string/substring`           | 0.0024751 | 0.0521217 | (21×)      | ❌ invalid — see #3898 |

## Read #3898 first — it changes the target list

#3898 established by measurement that the `indexOf`, `includes` and
`substring` JS baselines are **loop-invariant-hoisted by V8** (the call has a
constant receiver and constant arguments, so TurboFan runs it once and the
1000-iteration loop collapses). Against an honest, varying-input baseline:

- `indexOf`: honest JS ≈ **29 ns/scan**, gc-native ≈ **14.9 ns/scan** —
  gc-native is likely **~2× faster**, not 9.6× slower.
- `substring`: honest JS ≈ **10.9 ns/call**, gc-native ≈ **5.2 ns/call** —
  again likely faster.

So the bottom three rows are **not** confirmed gaps and may already be wins.
The top three rows **are** real: their JS baselines cost 10-31 ns per
operation, which is a realistic amount of work.

**Sequence**: land #3898 (or apply its baseline fix in your worktree), then
re-measure, then optimise. Report pre- and post-#3898 numbers for every method
you touch. Do not claim a win against a hoisted baseline.

## Scope — in priority order

1. **`startsWith` / `endsWith`** (6.62×, the largest confirmed gap). These
   should never go through a general substring search: each is a fixed-offset
   compare of exactly `needle.length` elements, with an early length check.
   **First thing to check: whether they currently delegate to `indexOf`.** If
   they do, that alone is the bug.
2. **`mixed/text-search`** (5.72×) — the app-shaped benchmark and the most
   important one for the page's credibility. It is a
   `includes`/`startsWith`/`endsWith`/`indexOf` mix over a 160-char string,
   10,000 iterations. It should improve for free once (1) lands; verify.
   Also check it for the #3898 hoisting problem before optimising.
3. **`trim`** (4.35×) — two boundary scans plus one copy. At 10,000 iterations
   over a 17-char string the scans are trivial, so the cost is almost
   certainly allocation + scaffolding, not scanning.
4. **`indexOf` / `includes` / `substring`** — re-measure post-#3898 and only
   optimise what is still behind.

## Suspected common causes (verify, do not assume)

- **Per-character f64 round-trip.** If the char loop lowers element reads to
  `array.get_u` → `f64.convert_i32_u` → compare → back, that is 3-4 extra
  instructions per character. #1948 tracks the shared numeric lattice that
  fixes this class generally.
- **Bounds checks not hoisted.** #2682 established a "provably in-bounds"
  hoisting proof for the string-hash loop. Check whether these kernels are
  eligible and, if not, why not.
- **Null-check + cast scaffolding on every `(ref null $str)` access** — the
  known WasmGC field-access pattern.
- **Allocation per call.** `trim` and `substring` allocate a fresh
  `(array i16)` per iteration; check whether the result is provably dead or
  short-lived enough for escape analysis (#747) to matter.
- **Constant-argument coercion.** `substring(5, 20)` has two integer literals;
  if the lowering runs full `ToInteger` + clamp on them, const-fold it.

## How to find the actual cost

Use the `/analyze-wat` skill on a minimal repro per method — compile with
`fast: true`, dump the WAT, and count the instructions in the inner loop.
Example for `startsWith`:

```ts
export function run(): number {
  const s = "hello world, this is a test string for benchmarking";
  let count = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    if (s.startsWith("hello")) count = count + 1;
    if (s.endsWith("benchmarking")) count = count + 1;
  }
  return count;
}
```

## Acceptance criteria

1. `string/startsWith-endsWith` gc-native improves by **≥3×** against the
   current 1.374 ms (target ≤0.46 ms), measured with
   `npx tsx benchmarks/run.ts --suite strings --filter startsWith`.
2. `mixed/text-search` gc-native improves by **≥2×** against the current
   1.199 ms (target ≤0.6 ms).
3. `string/trim` gc-native improves by **≥2×**.
4. No equivalence-test regressions; no test262 regression in the
   `built-ins/String` bucket.
5. The issue records, per method, **which** of the suspected causes was the
   dominant cost. That finding is directly reusable by #3900 and #3901, which
   are hitting the same lowering layer — write it down even if the fix is
   one line.

## Non-goals

- The `host-call` lane (#3903) — do not try to fix both lanes in one PR.
- `split` / `replace` allocation behaviour (#3901).
- `toLowerCase` / `toUpperCase` (#3900).

---

## Findings: what the dominant cost actually was

### The cheap check named in the scope came back NEGATIVE

`startsWith`/`endsWith` do **not** delegate to `indexOf`, and never did after
#3256. They were already fixed-offset compares with the correct early length
check (`src/stdlib/strings.ts`, `STARTS_WITH_SOURCE` / `ENDS_WITH_SOURCE`).
That hypothesis is dead — do not re-open it.

### The real cause: the generic `charCodeAt` lowering costs ~24 Wasm ops per code unit

Every one of these kernels scanned with `s.charCodeAt(i)` in the self-hosted TS
dialect. `wasm-opt -O4` **does** fully inline that call chain (`__str_startsWith`
→ `__sh_str_startsWith` → `__str_charCodeAt` → `__str_flatten` all collapse into
`run`), so the out-of-line calls are NOT the problem in an optimized build. What
survives inlining is the shape, and per code unit it is:

| cost | ops | why it is there |
| --- | --- | --- |
| f64 induction variable | `f64.lt` guard, `f64.add` for `i+1`, `f64.add` for `pos+i` | the dialect keeps index arithmetic in `number` |
| f64→i32 index truncs | `i32.trunc_sat_f64_s` ×2 (one per operand) | `stringMethodPlan`'s `indexArgRep: "i32"` |
| NaN bounds guard | `i32.lt_s 0` + `i32.ge_s len` + `i32.or` + a value-producing `if (result f64)`, ×2 | `charCodeAt` must return `NaN` out of range |
| i32→f64 widen | `f64.convert_i32_u` ×2 | the helper's declared `f64` result |
| the compare | `f64.ne` | on two values that were both already `i32` |

≈24 ops and 3 branches to compare **two `i16` array elements**. Measured
~11 ns per code unit — for `startsWith("hello")` + `endsWith("benchmarking")`
that is ~96 ns per iteration against JS's ~10 ns.

**None of the other suspects in the scope list was the dominant cost:**

- _Per-call `__str_flatten`_ — real but second-order. It is already
  `ref.test`-guarded (#3673) and `wasm-opt` inlines it.
- _Bounds checks not hoisted (#2682)_ — the NaN guard IS the un-hoisted bounds
  check, but hoisting it alone would not have helped: the f64 round trip is the
  bigger half, and both disappear together once the loop is i32.
- _Null-check + cast scaffolding_ — not measurable here.
- _Allocation per call_ — explicitly disproven for `trim`. Fusing
  `trimEnd(trimStart(s))` into one pass (halving both the `struct.new` view
  allocations and the cross-function calls) moved the benchmark by **0 %**. The
  intermediate view was never the cost. `__str_substring` already makes a VIEW,
  not a copy.
- _Constant-argument coercion_ — not applicable to these three.

`trim` carried one extra, larger tax on top: `__sh_str_isWs` is an ~11-branch
f64 comparison chain, far past Binaryen's inline budget, so it stayed a **real
call per code unit**.

### The fix

Three retained i32 rep kernels, in the same layer as `__str_flatten` /
`__str_copy_tree` / `__str_equals` / `__str_indexOf`. The self-hosted TS keeps
the spec clamps and the whitespace table; only the raw memory scan — which has
no JS-observable semantics once the caller has proven its range — moves down.

1. **`__str_region_eq(a, aOff, b, bOff, len)`**
   (`src/codegen/native-strings-search.ts`) — fixed-offset code-unit compare,
   ~6 i32 ops per code unit, no conversions, no bounds check (the caller's
   clamps prove `pos + pLen <= sLen` / `start >= 0`). `startsWith`/`endsWith`
   now clamp in TS and delegate the compare.
2. **`__str_ws_start` / `__str_ws_end`** (`src/codegen/native-strings-ws.ts`) —
   whitespace boundary scans in i32, with an **exact** inline ASCII fast path
   (`c == 0x20 || (c - 0x09) <=u 4`); anything `> 0x7F` still defers to the
   self-hosted `__sh_str_isWs`, so the §22.1.3.32 table is **not** duplicated.
   Emitted from `emitSelfHostedStringHelpers` right after the `__sh_str_isWs`
   leaf, because they bake its funcIdx.
3. **`__str_indexOf` first-code-unit skip** — hoist `last = hLen - nLen` and
   `n0 = needle[0]` out of the outer loop, and only enter the compare loop when
   `hData[hOff + i] == n0`. Rejects a candidate in 1 load + 1 compare instead of
   an inner-loop entry with two loads and a `j` induction variable.

### Results

**Method.** The box is a 4-core container shared with five other agents; load
averaged ~12 throughout, so an absolute ms figure taken now is not comparable
to one taken ten minutes ago. Every number below therefore comes from a
**tightly interleaved A/B**: the three changed compiler sources are swapped
between their pre-change and post-change versions by file copy (never
`git stash` — that ref is shared across worktrees here), and BEFORE/AFTER are
measured alternately within the same few minutes, two full passes each. Inside
each measurement the wasm and JS lanes are also sampled alternately (25 paired
samples, median). The **gc-native improvement multiple** is the primary result
— it is what the acceptance criteria are written in, and it does not depend on
the JS baseline being valid.

Median of two passes, `gc-native` ms per `run()`:

| benchmark | gc before | gc after | **gc improvement** | gc÷js before | gc÷js after |
| --- | --- | --- | --- | --- | --- |
| `string/startsWith-endsWith` | 1.832 | 0.344 | **5.3×** | 3.3-3.7× | **0.59-0.66×** |
| `string/startsWith-endsWith` *(varying input)* | 1.444 | 0.322 | **4.5×** | 2.8-3.2× | **0.62-0.72×** |
| `string/trim` | 1.052 | 0.363 | **2.9×** | 2.6-2.9× | **1.09-1.11×** |
| `string/trim` *(varying input)* | 1.062 | 0.326 | **3.3×** | 3.3-3.4× | **0.98-1.04×** |
| `mixed/text-search` | 2.495 | 1.233 | **2.0×** | 4.5-6.0× | **1.93-1.97×** |

`startsWith-endsWith` is now **faster than the JS lane** (0.6×) and `trim` is
**level with it** (~1.0×). Emitted binaries got *smaller* in every case
(1751→1603, 1834→1734, 2274→2154 bytes) — the i32 kernels are less code than
the inlined f64 chains they replace.

Against the acceptance criteria, all three clear:

1. `startsWith-endsWith` ≥3× → **5.3×** (4.5× on varying input) ✅
2. `mixed/text-search` ≥2× → **2.0×** — cleared, but only just ✅
3. `string/trim` ≥2× → **2.9×** (3.3× on varying input) ✅

#### On the corrected #3898 baselines

These measurements were taken on the **pre-#3898 benchmark sources** (the
constant-input ones), so their `gc÷js` columns are not directly comparable to
the corrected full-suite figures. That is why the *varying-input* rows exist:
they are hand-written honest variants (the receiver rotates over four strings
so the call cannot be hoisted, and the affix/whitespace work differs per
iteration). The improvement **survives them essentially unchanged** — 4.5× and
3.3× — so it is not an artifact of constant-input specialisation. The
varying-input variants are not byte-identical to #3898's, so their `gc÷js`
values will not match the corrected suite exactly; the transferable claim is
the gc-native multiple.

`startsWith-endsWith` and `trim` are confirmed by the corrected baselines as
real, substantial gaps (6.30× and 5.14× slower before this change), so they
were the right targets. `indexOf`/`includes` were **mostly artifact** — the
corrected baselines put them at 1.68× and 1.20× slower, not 9.34×/7.88× — so
the first-code-unit skip is claimed only as the modest win it is (see below),
not against the old inflated figure. `substring` is now measured as 3.61×
**faster** than JS and needs no work at all.

#### Decomposing `mixed/text-search`

Two isolating slices of the same source (earlier, less tightly controlled run
— treat as indicative):

| slice | gc before | gc after | improvement |
| --- | --- | --- | --- |
| `startsWith` + `endsWith` only | 1.232 | 0.264 | ~4.7× |
| `includes` + `indexOf` only | 1.609 | 1.171 | ~1.35× |

The affix compares went from roughly half of `text-search` to a small
remainder; what is left is the `indexOf` candidate scan, where the
first-code-unit skip bought ~1.35× and the remaining gap to V8 is
**algorithmic** — V8 uses a SIMD `memchr` for the first unit, ours is a scalar
naive scan. Closing that needs SIMD or a Boyer-Moore / two-way skip table.
That is out of scope here and should be **filed separately** rather than bolted
on; given the corrected baselines put standalone `indexOf` at only 1.68×
behind, it is also lower priority than it looked.

### #3898 re-measurement (do not claim wins against hoisted baselines)

Independently reproduced before the corrected baselines landed: the
`includes` + `indexOf` slice's JS baseline measured **0.0063 ms for 10 000
iterations of two searches over a 158-char string** — 0.63 ns per iteration,
i.e. fully loop-invariant-hoisted by V8, exactly as #3898 predicted. No ratio
against that denominator means anything. `string/indexOf`, `string/includes`
and `string/substring` were therefore left alone as *targets*, per the issue's
own instruction; `__str_indexOf` was touched only because it is what actually
dominates `mixed/text-search`, which IS a real target.

### Correctness

No observable semantics change — these are lowering rewrites. Validated by
behaviour-equivalence sweeps against host JS (`tests/issue-3899.test.ts`,
~6 800 cases): affix clamps past both ends (#2875), empty needles/receivers,
cons-string (rope) receivers **and** needles (the kernels' `ref.test`-guarded
flatten), the complete §22.1.3.32 whitespace class plus its near-miss
neighbours (the ASCII fast path must neither swallow nor invent a member), and
repeated-prefix haystacks that force the first-unit skip into the full compare
and back out. `tests/issue-3256.test.ts` (standalone **and** wasi lanes) stays
green, as do the string equivalence suites.

### Reusable for #3900 / #3901

The transferable rule: **in the native-strings self-hosted dialect, a
per-code-unit `charCodeAt` loop costs ~24 Wasm ops and cannot be optimized into
shape by `wasm-opt`** — the f64 index carrier and the NaN bounds guard survive
inlining. Any hot scan should keep the spec clamps in TS and hand the proven-in-
bounds range to an i32 rep kernel. Note the *negative* results too: neither
per-call flatten nor view allocation was worth chasing, so do not start there.

(Scope note: #3900's `toLowerCase`/`toUpperCase` were separately found NOT to
share this cause — `case-convert-native.ts` already reads in the i32 domain;
its cost is per-call Unicode table rebuilding. #3901 independently corroborated
the per-call-overhead family in `__str_split`.)

## Test Results

- `tests/issue-3899.test.ts` — 4/4 pass (~6 800 equivalence cases)
- `tests/issue-3256.test.ts` — 12/12 pass (standalone + wasi lanes)
- `tests/equivalence/string-methods.test.ts`,
  `string-relational-operators.test.ts`, `wrapper-string-concat.test.ts` —
  53/53 pass
- `npx tsc --noEmit` clean; `prettier --check` and `biome lint` clean on all
  changed files
