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

## SECOND CORRECTION (2026-07-31): the mechanism is right, the LANE and the MAGNITUDE are wrong

The first correction (above) fixed "super-linear" → "flat constant factor".
It left the **root-cause hypothesis** intact: that the ~400-500x is
dominated by `this.<method>()` **method dispatch**. That hypothesis is
**reframed, not simply refuted** — and getting the distinction right
matters, because "the hypothesis was wrong" would itself be wrong.

**Attribution note (read before quoting anything below).** Numbers are
labelled by who measured them. Nothing here diffs a local measurement
against a committed CI baseline — that comparison produces phantom
deltas across different hardware and is not made.

### 1. The ~400-500x is a JS-HOST-lane number, and it is bridge tax

The entire repro in this issue runs through
`scripts/generate-npm-compat-report.mjs`'s **JS-host** lane. **#3780's
measurement (theirs, not mine)** put an exact, allocation-free import
counter on one host-lane parse of acorn's own 226 KB dist:

| dynamic work group | Wasm→host calls |
| --- | ---: |
| numeric boxing/unboxing, type, truth, compare, index | 11,032,750 |
| extern property reads/writes, lookup, method dispatch | 5,656,932 |
| arrays, argument vectors, iteration | 866,913 |
| object creation/registration/deletion | 58,870 |
| regexp and string helpers | 54,500 |
| **total** | **17,669,965** |

Largest single helpers: `__box_number` 2,995,053 · `__extern_get`
1,852,765 · `__get_undefined` 1,718,875 · `__host_compare` 1,698,487 ·
`__unbox_number` 1,564,754 · `__host_eq` 1,463,415 · `__typeof_number`
1,321,348 · `__is_truthy` 1,309,535.

`__get_undefined` is literally `() => undefined` in `src/runtime.ts`
(L9814), called 1.72 M times per parse. So the host lane's dominant term
is **crossing the JS boundary for value-level operations**, not method
dispatch. Method dispatch is present (it is inside the 5.66 M
property/method bucket) but it is not what makes the number ~400x.

### 2. Method dispatch IS a real axis — it is just a ~10x one, and it lives in standalone

**#3684's committed cross-engine harness (theirs)**, `benchmarks/cross-engine/`,
run 3, all three engines re-measured together, checksums identical:

| axis | js2-standalone vs node |
| --- | ---: |
| numeric loop | **0.98x (parity)** |
| property r/w | **1.00x (parity)** |
| object allocation | **1.00x (parity)** |
| string scan | 4.98x *(loop-bound at this scale — see #3684's own caveat)* |
| **tokenizer shape (`this` fields + `this.m()`)** | **7.37x** |
| **method dispatch** | **9.73x** |

So the dispatch mechanism this issue named is genuine and is one of only
**two** non-parity axes. Its size is single-digit-x, not 400x.

### 3. The lane where parity is reachable is STANDALONE

**My own re-baseline (mine)**, tip `af7d6f875b35e5`, harness protocol
(2 warm-up + 9 measured rounds), node control measured **in the same
process** so the ratio is self-normalising:

- acorn standalone runtime-dynamic: **node is ~11x faster**
  (wasm-advantage ratio 0.0906).
- Box load **7.36 → 8.10 → 5.96** across the run (10 cores, ~7 concurrent
  agents). **Treat as provisional**: contention does not degrade both
  sides equally, so this is quoted as an order of magnitude only.

The same parse in the **host** lane is ~290-400x. The standalone lane
makes **zero** host crossings. That ~25-30x lane difference is the bridge
tax measured directly, and it is why the ~400x number cannot be read as
evidence about codegen or dispatch quality.

### What this means for the scope below

- The original scope ("verify the method-dispatch hypothesis, then fix
  it") aimed a **standalone-sized** mechanism at a **host-lane** number.
- Method dispatch / typed-`this` is owned by **#3683** (typed twins,
  direct-call devirtualization) and #3685 — not by this issue.
- The remaining standalone axes are **method dispatch / tokenizer shape**
  (#3683/#3685) and **string element access** (#3684's D2, ~4.5x,
  explicitly unowned).
- The host-lane bridge tax is a *separate, lower-priority* fight
  (#3673/#3669/#3671), not this issue's dispatch hypothesis.

Recorded rather than silently redirected, per the same principle the
first correction used: the raw numbers in this file are accurate; the
causal story attached to them was aimed at the wrong lane.

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

### Also ruled out: JS↔Wasm bridge / AST marshaling (2026-07-28)

A natural hypothesis is that the measured cost is really the returned AST
object graph crossing the bridge back to JS (the npm-compat harness calls
`exp.parse(src, opts)` and gets a full AST). **Measured directly and
ruled out.** Two separate compiles of the SAME pinned acorn — one
unmodified (parse called from JS, full AST marshalled back), one with an
in-wasm driver epilogue that runs an identical parse but returns only
`ast.body.length` (a scalar, so no AST crosses the boundary):

| input | A: full AST → JS | C: scalar only | native | AST-marshal cost (A−C) |
| --- | ---: | ---: | ---: | ---: |
| 19,600 B | 940.1ms (154x) | 1100.3ms (181x) | 6.09ms | −160ms (noise) |
| 78,400 B | 4884.5ms (539x) | 4680.9ms (516x) | 9.07ms | 204ms (4.2%) |

Removing the AST from the return path does **not** help — the two are
within noise of each other (C is even slower at the smaller size). The
in-wasm parse alone is **~96-117% of the total measured time**, i.e. the
entire cost is inside the compiled parse; bridge/marshaling is
effectively free here. (Consistent with the harness design: it's ONE
`parse()` call per iteration, not per-token bridge traffic.) So the gap
is genuinely compiled-code execution speed, which keeps method dispatch
as the leading hypothesis below.

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

## Scope (rewritten 2026-07-31 — see SECOND CORRECTION)

The original scope is struck: it asked this issue to verify and fix
method dispatch against a host-lane number. Dispatch is owned elsewhere,
and the host-lane number is bridge tax. What remains for *this* issue:

- [x] Method-dispatch hypothesis resolved against measured evidence
      (see SECOND CORRECTION): it is a real axis at **9.73x** (method
      dispatch) / **7.37x** (tokenizer shape) on standalone per #3684's
      harness, **not** the driver of the ~400-500x host-lane figure,
      which is **17.67 M Wasm→host crossings per parse** per #3780's
      import census.
- [x] Establish which lane parity is reachable in: **standalone**
      (~11x, my re-baseline; zero host crossings) rather than JS-host
      (~290-400x).
- [ ] Route the two live standalone axes to their owners rather than
      duplicating them here: method dispatch / typed-`this` → **#3683 /
      #3685**; string element access (~4.5x, unowned) → **#3684 D2**.
- [ ] `tests/dogfood/README.md` / the npm-compat page (#3757): state the
      **standalone** ratio as the headline compiled-acorn number and stop
      quoting the host-lane figure as "our acorn performance" (this is
      #3684's D3, and it is the same correction).

## Acceptance criteria

- [x] Method-dispatch axis hypothesis confirmed or refuted with a clean
      measurement rather than inference — **resolved as "reframed"**: the
      mechanism is real and measured, but it is a single-digit-x
      standalone axis, and the ~400-500x this issue was filed against is
      a different cause (host-boundary value operations) in a different
      lane.
- [x] The misleading causal text is corrected in place, with each number
      attributed to whoever measured it, rather than the issue being
      quietly repurposed.
- [ ] `tests/dogfood/README.md` / the npm-compat website page (#3757)
      updated so the headline compiled-acorn number is the standalone
      one.
