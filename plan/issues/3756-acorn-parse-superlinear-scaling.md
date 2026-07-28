---
id: 3756
title: "Compiled acorn's parse() is ~400-500x slower than native at real-file scale — large constant-factor gap, likely method-dispatch overhead (NOT super-linear, see correction)"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen, runtime
language_feature: n/a
goal: performance-optimization
origin: "scripts/generate-npm-compat-report.mjs (#3757) head-to-head perf measurement — compiled acorn parsing its own 226KB dist/acorn.mjs took ~6.7s vs native's ~17ms (≈400x). Isolated with a clean scaling benchmark, independent of acorn's specific source, to rule out a one-off input artifact."
related: [1710, 3729, 3757, 3753]
---

# #3756 — acorn `parse()` is ~400-500x slower than native (large constant-factor gap)

## CORRECTION (2026-07-28): this is NOT super-linear scaling

The issue was originally filed as "super-linear scaling" based on a
ratio-vs-input-size table showing the ratio growing from 14x at 4.9KB to
424x at 313KB. **That framing was wrong** — investigated further at the
user's request and corrected here rather than silently fixed, since the
original repro/table below is still real data, just mis-interpreted.

Root of the mistake: the original scaling measurement used only 2 warmup
rounds and a single timed sample per size, with native's absolute time
staying almost flat (43.73ms → 57.95ms) across a 64x input increase. That
flatness is NOT native scaling well — it's **native's small-input runs
being dominated by V8 JIT/cold-start overhead**, making native look
artificially fast at small sizes. A corrected measurement (2 warmup
rounds + median-of-3 per size, 7 points from 4.9KB to 313.6KB) shows the
TRUE picture:

| reps | bytes | compiled `us/byte` | native `us/byte` | ratio |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 4,900 | 64.28 | 0.826 | 77.8x |
| 100 | 9,800 | 65.19 | 0.315 | 206.8x |
| 200 | 19,600 | 65.15 | 0.203 | 320.7x |
| 400 | 39,200 | 57.24 | 0.134 | 426.1x |
| 800 | 78,400 | 61.00 | 0.158 | 387.2x |
| 1,600 | 156,800 | 65.75 | 0.128 | 511.7x |
| 3,200 | 313,600 | 66.57 | 0.140 | 474.8x |

**Compiled acorn's per-byte cost is flat** (~57-66 µs/byte across the
entire range — no growth trend). **Native's per-byte cost drops and then
levels off** (0.826 → ~0.13-0.16) purely because its fixed per-call
overhead gets amortized over more bytes as input grows — that's the
entire source of the "growing ratio" illusion. The real, corrected
finding: **compiled acorn parsing has a large but roughly CONSTANT
~400-500x throughput gap vs native**, not a scaling defect. Apologies for
the original mischaracterization — leaving the below repro/history
intact since the raw numbers are accurate, only the "super-linear"
interpretation was wrong.

## What was ruled out (isolated, scaling-clean measurements)

Before concluding it's a constant-factor / dispatch-cost issue, the
following primitives were tested in isolation and are all fast AND
genuinely flat/linear — none reproduce acorn's ~60µs/byte real cost:

| primitive | measured cost | scaling |
| --- | --- | --- |
| `str.charCodeAt(i)` in a loop, various string sizes | ~1.8 µs/byte (converges) | flat |
| `arr.push(<heterogeneous object literal>)` in a loop | sub-µs/push | flat |
| object-literal construction with string fields | ~70 ns/object | flat |
| 10-deep chain of plain (non-`this`) function calls | ~180 ns/call | flat |

This rules out the original hypotheses (non-amortized array/string
growth, GC pressure from over-allocation) as the dominant cost — none of
those primitives are slow, and none scale badly.

## Where the cost most likely actually is

`--prof` couldn't usefully attribute time (98%+ landed in an
undifferentiated "C++" bucket — V8's sampling profiler doesn't
symbolicate individual wasm functions without extra tooling not
available in this environment), and GC ticks were near-zero (~0.1%),
ruling out allocation/GC pressure as the driver.

The strongest remaining lead is **method dispatch** (`this.<method>()`
calls) — #3753's OWN cross-engine measurement (before its fix) found
TWO separate slow axes, not one:

- **tokenizer axis: 9.54x** — `this.<field>` string access
  (externref-boxed field → guard/cast/flatten). **#3753 fixed this one.**
- **method axis: 6.21x** — `this.<method>()` call dispatch. **Still
  unaddressed** — #3753's scope was explicitly the field-access cost,
  not method dispatch.

Acorn's real parser is a deeply recursive-descent, heavily
`this.<method>()`-based class (`parseStatement` → `parseExpression` →
`parseMaybeAssign` → `parseMaybeConditional` → `parseExprOps` →
`parseMaybeUnary` → `parseExprSubscripts` → `parseExprAtom`, etc. — many
chained `this.foo()` calls per token). This is exactly the shape the
"method axis" measures and exactly what the ruled-out synthetic tests
above (flat functions, no `this`) don't exercise. #3753's own numbers
project this axis alone could still cost multiple x on top of whatever
remains after the tokenizer-axis fix, and is a very plausible dominant
contributor to the still-large ~400-500x gap.

**Not verified further** — confirming this precisely (and fixing it)
requires the same kind of careful, isolated-microbenchmark rigor #3753
used before touching the dispatch path, which is real compiler-internals
work, not something to guess at from a synthetic repro. Deliberately not
attempted here without that rigor.

## Repro — scaling table (original, kept for reference; see CORRECTION above for the accurate framing)

A single fixed 98-byte snippet (`function foo(a,b){...} var x = {...};`),
repeated N times and parsed as one `sourceType: "script"` unit (sloppy
mode, so `foo`/`x` redeclaration across repeats is legal — this isolates
pure scanning/parsing cost, not a semantic-error path):

| reps | bytes | compiled-acorn | native acorn | ratio |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 4,900 | 618.6ms | 43.73ms | **14.1x** |
| 200 | 19,600 | 1,361.6ms | 21.23ms | **64.1x** |
| 800 | 78,400 | 5,087.7ms | 33.97ms | **149.8x** |
| 3,200 | 313,600 | 24,558.2ms | 57.95ms | **423.8x** |

Real-world confirmation: parsing acorn's own actual 226KB
`dist/acorn.mjs` takes **~6.7 seconds** compiled vs **~17ms** native — a
≈400x gap, consistent with the corrected constant-factor finding above
(not the scaling-table's "growing ratio," which was a native-side
measurement artifact).

## Verified against #3753's fix after it landed (2026-07-28)

#3753 (fnctor string-field typing, the "tokenizer axis" fix) merged as
`loopdive/js2@d4cb839a` shortly after this issue was filed. Re-measured
on top of it (calibrated median-of-9 via
`scripts/generate-npm-compat-report.mjs`):

| | before #3753 | after #3753 |
| --- | ---: | ---: |
| full acorn dist parse, compiled | ~6.75s | ~6.21s |
| full acorn dist parse, native | ~18.2ms | ~15.3ms |
| **ratio** | **~370x** | **~407x** |

The ratio didn't move (within noise), even though #3753 measurably
helped in absolute terms (~8% faster compiled wasm time here, consistent
with fixing ONE axis of a multi-axis gap). This is now understood
correctly per the correction above: #3753 fixed the tokenizer-axis
constant, the method-axis constant (never addressed) is the likely
remaining dominant cost, and — since the overall relationship is a flat
per-byte cost, not scaling — a partial fix to one axis simply shows up as
a smaller flat number, not a change in scaling shape (there was never a
scaling shape to fix).

## Scope

- [ ] Verify the method-dispatch-axis hypothesis directly: reproduce
      #3753's `method` axis cross-engine microbenchmark (or a close
      variant with a `this.<method>()`-heavy call chain matching acorn's
      actual recursive-descent depth) in isolation, confirm it's still
      slow post-#3753, and profile it specifically.
- [ ] If confirmed as the dominant cost: design and land a fix with the
      same rigor as #3753 (isolated verification before touching the
      dispatch path — devirtualization/monomorphization already exists
      per #3753's own notes; the question is what's still costly on top
      of that).
- [ ] Re-run `pnpm run generate:npm-compat` after any fix — expect the
      acorn ratio to drop meaningfully from ~400-500x; a `tests/dogfood/`
      /npm-compat page note once it does.
- [ ] If method dispatch is NOT the dominant cost once profiled, this
      scope needs revisiting — the ruled-out list above only tested
      flat/non-`this` call patterns.

## Acceptance criteria

- [ ] Method-dispatch axis hypothesis confirmed or refuted with a clean,
      isolated measurement (not just inference from #3753's table).
- [ ] If confirmed: fixed, and the corrected scaling table above (or a
      fresh equivalent) shows the acorn ratio meaningfully improved,
      still flat (not literally growing — there's no scaling defect to
      fix, just a constant to shrink).
- [ ] `tests/dogfood/README.md` / the npm-compat website page (#3757)
      updated with a note once this lands and the numbers improve.
