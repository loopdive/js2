---
id: 3745
title: "string-hash under IR still uses i64 ToInt32 bit-manipulation, not native i32, even after #3741's loop-accumulator inference"
status: done
created: 2026-07-28
completed: 2026-07-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: performance
area: ir
language_feature: bitwise-operators, loops
goal: performance
related: [3740, 3744, 3741, 3739, 1948, 3758]
---

# #3745 — string-hash residual IR-vs-legacy gap survives #3741

## Context

#3744 promoted the #1210 string-builder optimization into the IR pipeline
and made IR claim the landing `string-hash` benchmark by default. Measuring
that fix found IR ~16x slower than legacy for this specific benchmark, and
attributed the gap to IR lacking legacy's i32-coerced-local promotion for
loop arithmetic (`(i * 13) & 31` etc.) — pointing at #1948.

While #3744 was in flight, **#3741** ("IR path has no equivalent to
legacy's #1120 i32-coerced-local promotion") landed independently on `main`
(PR #3718), fixing exactly this class of gap for the `loop.ts` benchmark
accumulator pattern (`let s = 0; for (...) s = (s + i) | 0;`). Merging it in
and re-measuring `string-hash` showed real improvement — warm avg dropped
from ~3.1ms to ~1.8ms — narrowing the gap from ~16x to ~9x. **But a
substantial gap remains**: legacy still measures ~0.18ms for the same
input.

## Finding: #3741's inference doesn't reach this specific loop shape

Disassembling the current default-IR-compiled `run` (optimize 3) shows
**zero** `i32.mul` anywhere in the function body — despite three
multiplications needing it (`i * 13`, `hash * 31`, twice: once in the build
loop, once in the hash loop). Instead there are 100+ `i64.*` instructions —
the newer #3739 "ToInt32 via IEEE-754 bit manipulation" technique
(`i64.reinterpret_f64` + exponent/mantissa extraction), which is faster than
the OLD div/floor/mul-by-2^32 float dance #3739 replaced, but still nowhere
near native `i32.mul`/`i32.and`.

So #3741's fix, while real and independently valuable (confirmed on
`loop.ts`), does not generalize to `string-hash`'s shape:

- **Build loop**: TWO locals (`a`, `b`) each derived from a bitwise
  expression over the SAME loop counter `i` (`a = (i * 13) & 31; b = (a + 7)
& 31;`), then used as array-index arguments to `charAt`. #3741's pattern
  is (per its own issue) a single accumulator reassigned via `s = (s + i) |
0`, i.e. one local, one enclosing bitwise/`| 0` context, no downstream
  index use. `string-hash`'s shape has two chained bitwise-derived locals
  per iteration, feeding a call argument rather than being returned/re-used
  as the SAME accumulator.
- **Hash loop**: a genuine single accumulator (`hash = (hash * 31 +
text.charCodeAt(i)) | 0`) that LOOKS like #3741's target shape, but its
  RHS is `hash * 31 + charCodeAt(i)`, not the simpler `s + i` #3741 was
  built against — worth checking in isolation (a minimal repro
  `let hash = 0; for (...) hash = (hash * 31 + arr[i]) | 0;` without the
  string-builder loop) to see whether #3741 covers accumulator-with-multiply
  at all, or only accumulator-with-add.

## Suggested next step

1. Reproduce and bisect the two loops SEPARATELY (in isolation, without
   string-building) to find out whether #3741's inference is missing the
   _build loop's_ two-chained-bitwise-locals shape, the _hash loop's_
   multiply-then-add shape, or both.
2. Extend #3741's i32-inference (or generalize its underlying analysis) to
   cover whichever shape(s) are missing. This is very likely NOT a new
   epic-scale feature — #3741 already proved the core mechanism works for
   one shape; this is about widening its recognized pattern set.
3. Re-measure `string-hash` after the extension; if it closes the remaining
   ~9x gap, consider whether #3744's `JS2WASM_IR_STRING_BUILDER` kill switch
   is still needed at all (it currently exists so anyone can force legacy
   for A/B comparison, independent of whether IR reaches parity).

## Non-goals

This is scoped to closing the measured perf gap, not to any correctness
issue — `string-hash` already produces byte-identical results through IR
today (verified in #3744's tests); this is purely about the residual
constant-factor slowdown from i64-bit-manipulation ToInt32 instead of
native i32 ops.

## Outcome

Closed by **#3758**, on the second attempt — a first attempt at exactly
this fix landed on this same PR branch and was **reverted** for a genuine
soundness bug (using saturating `i32.trunc_sat_f64_s` as a substitute for
arithmetic composition, which diverges from ECMA-262 ToInt32's wrap
semantics on overflow — caught by the four-lane sanitizer probe on the
`fib` benchmark). #3758's corrected version adds genuine native
`i32.add`/`i32.sub`/`i32.mul` `IrBinop`s (which wrap correctly) instead.

Measured outcome is more modest than this issue's ~9x-gap framing hoped:
the fix genuinely speeds up pure-arithmetic bitwise code (`fib.js`: ~13%
faster; an isolated build-loop-shape microbenchmark: ~14% faster), but the
**actual `string-hash.js` benchmark shows no measurable wall-clock change**
— its build loop's real cost is dominated by string operations (`charAt`,
concatenation), not the bitwise arithmetic this fix touches, and the hash
loop (likely the larger cost, since it runs once per character) is
**explicitly excluded** by this fix (its accumulator's RHS includes
`text.charCodeAt(i)`, a call expression, which the fast path's predicate
deliberately does not treat as a leaf — see #3758's own follow-up note).
Closing that remaining gap needs the #2682-style "provably in-bounds
charCodeAt" hoisting proof, tracked as a separate follow-up since it's a
substantial loop-preheader hoisting feature IR doesn't have an equivalent
of, not a small patch.
