---
id: 3899
title: "perf: gc-native String scan kernels (startsWith/endsWith/trim, and the text-search mix) are 4-7× slower than JS on the perf page"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
depends_on: [3898]
related: [3900, 3901, 1746, 1948, 2682]
---

# #3899 — gc-native `String.prototype` scan kernels lose to JS on the public perf page

## Status: open

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
