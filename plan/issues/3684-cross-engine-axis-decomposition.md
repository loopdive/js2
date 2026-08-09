---
id: 3684
title: "perf: what actually makes node and Porffor faster — per-axis decomposition, and the two gaps it leaves unowned"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen, runtime, benchmarks
goal: value-rep
horizon: m
sprint: current
related: [3673, 3674, 3675, 3683, 1946, 1947, 1584, 3288]
---

# #3684 — What actually makes node and Porffor faster

## Why this issue exists

We have been reasoning about compiled-acorn performance from a single
aggregate number, and that number is **misleading in a way that points the
roadmap at the wrong thing**. Measured on acorn 8.16.0 parsing its own 245 KB
`dist/acorn.js`:

| engine | median/parse | vs node |
| ------ | ------------ | ------- |
| node (V8) | 10.7 ms | 1x |
| Porffor (JS -> C -> native) | 253 ms | ~24x |
| js2 **host** lane | 3,534 ms | ~330x |
| js2 **standalone** lane | (cannot run yet — see #3673 follow-ups) | — |

Read naively this says "Porffor is 14x faster than us." That conclusion is
wrong, because it compares Porffor against the js2 **host** lane, whose cost is
dominated by the JS-bridge tax (#3673), not by codegen quality. **The lane we
actually ship for pure-Wasm targets — standalone — beats Porffor on most axes.**

So: a per-axis decomposition, same source, same checksums, three engines.

## Harness (committed, reproducible)

`benchmarks/cross-engine/` — `axes-core.js` is plain ES5 that node, Porffor and
js2 all accept verbatim; every bench returns a checksum and **all three engines
agree on every one**, so no engine is skipping work.

```bash
node benchmarks/cross-engine/run-node-porffor.mjs
node --import tsx benchmarks/cross-engine/run-js2.mjs
```

## Measured (min-of-5 after warmup; 8-core container, 2026-07-27)

| axis | node | Porffor | js2-standalone | js2/node | porf/node |
| ---- | ---- | ------- | -------------- | -------- | --------- |
| numeric loop (1M iters, no objects) | 1.274 ms | 3.819 ms | **1.236 ms** | **0.97x** | 3.0x |
| property r/w on object literal (300K) | 0.560 ms | 6.837 ms | 0.766 ms | 1.4x | 12.2x |
| **prototype method dispatch (300K)** | 0.472 ms | 7.168 ms | 12.268 ms | **26x** | 15.2x |
| short-lived object alloc (100K) | 0.122 ms | 7.040 ms | **0.121 ms** | **1.0x** | 57.8x |
| **tokenizer shape (`this` fields + `this.m()`)** | 0.065 ms | 1.791 ms | 2.208 ms | **34x** | 27.4x |
| bare loop, isolated (700K iters) | 0.435 ms | 0.769 ms | **0.428 ms** | **0.98x** | 1.8x |
| **`charCodeAt`, isolated (700K calls)** | 0.440 ms | 2.806 ms | 1.969 ms | **4.5x** | 6.4x |

The last two rows are the string axis re-measured at 20x scale. **The first cut
was invalid**: at 35 K chars, deleting `charCodeAt` entirely did not change the
time, i.e. it measured loop overhead, not string access. Recorded here because
the same trap will catch the next person — anything under ~0.1 ms on this
harness is loop-bound.

## Re-measured after #3683 S2 + S4a landed (2026-07-27)

The table above was taken BEFORE #3683 S2 (typed-`this` twin compilation, 244
twins on acorn) and S4a (provably-numeric fnctor fields promoted to physical
f64 slots) landed on the branch. Re-run on the same box, same session, all
three engines re-measured together, checksums identical throughout:

| axis | node | Porffor | js2 before | js2 now | js2/node before → now |
| ---- | ---- | ------- | ---------- | ------- | --------------------- |
| numeric loop | 1.249 ms | 3.969 ms | 1.236 ms | **1.233 ms** | 0.97x → **0.99x** |
| property r/w (literal) | 0.548 ms | 6.807 ms | 0.766 ms | 0.762 ms | 1.40x → 1.39x |
| **method dispatch** | 0.485 ms | 8.163 ms | 12.268 ms | **8.759 ms** | 26.0x → **18.1x** (−29%) |
| string scan | 0.043 ms | 0.183 ms | 0.179 ms | 0.175 ms | 4.17x → 4.08x |
| object allocation | 0.122 ms | 6.969 ms | 0.121 ms | 0.134 ms | 0.99x → 1.10x |
| **tokenizer (`this`-loop)** | 0.065 ms | 1.717 ms | 2.208 ms | **1.376 ms** | 33.8x → **21.1x** (−38%) |

**The prediction held.** This issue argued the deficit was concentrated in one
axis — dynamic `this` dispatch — and that #3683 owned it. The two axes that
moved are exactly those two, and *only* those two: numeric, property, string
and allocation are flat within noise, which is what a targeted fix should look
like. A broad regression or a broad win would both have been evidence the
decomposition was wrong.

**js2-standalone now beats Porffor on the tokenizer axis** (1.376 ms vs
1.717 ms — a 1.25x lead where it was 1.23x behind), and is within 7% of it on
method dispatch (8.76 vs 8.16, previously 1.7x behind). That makes it **6 of 7
axes ahead of Porffor**, on identical source.

Caveats, so nobody over-reads this:

- The allocation row moved 0.121 → 0.134 ms. Repeat runs of that axis span
  ~0.121–0.135 ms across the session, so this is run-to-run variance, **not** a
  measured S4a regression. Do not quote it as one without a dedicated run.
- 18x and 21x are still 18x and 21x. This is a large step on the dominant axis,
  not arrival. S3 (direct-call devirtualization between admitted methods) has
  not landed.

## Re-measured after #3683 S3 + S3b (2026-07-27, later)

Third run, after S3 (direct-call devirtualization between typed twins) and S3b
(arity-padding trampolines) landed, plus rounds 26–38.

**Read the ratio column, not the ms column.** This run is on a DIFFERENT
container instance — the box itself is ~2x slower than the previous two runs
(node's own numeric axis went 1.249 → 2.463 ms on identical source). Diffing
raw ms against the earlier tables would report a catastrophic across-the-board
js2 regression that did not happen. All three engines were re-measured together
here; checksums identical.

| axis | node | Porffor | js2 | **js2/node** | prev | porf/node |
| ---- | ---- | ------- | --- | ------------ | ---- | --------- |
| numeric loop | 2.463 ms | 4.644 ms | 2.402 ms | **0.98x** | 0.99x | 1.89x |
| **property r/w** | 1.081 ms | 8.139 ms | 1.082 ms | **1.00x** | 1.39x | 7.53x |
| **method dispatch** | 0.934 ms | 8.068 ms | 9.085 ms | **9.73x** | 18.1x | 8.64x |
| string scan | 0.063 ms | 0.223 ms | 0.312 ms | 4.98x | 4.08x | 3.56x |
| object allocation | 0.236 ms | 7.520 ms | 0.235 ms | **1.00x** | 1.10x | 31.9x |
| **tokenizer (`this`-loop)** | 0.106 ms | 2.225 ms | 0.784 ms | **7.37x** | 21.1x | 20.9x |

### The dominant axis has now improved ~4.6x across three runs

- **tokenizer: 33.8x → 21.1x → 7.37x**
- **method dispatch: 26.0x → 18.1x → 9.73x**
- **property r/w reached parity: 1.40x → 1.39x → 1.00x** — new this round; S3's
  direct calls remove the dispatch that the literal-object path was still paying.
- numeric and allocation held parity throughout (0.98x / 1.00x).

**js2-standalone now beats Porffor on 4 of 6 axes**, including the tokenizer by
**2.8x** (0.784 ms vs 2.225 ms) — an axis where it was 1.23x *behind* two runs
ago. It remains slightly behind Porffor on method dispatch (1.13x) and string
scan (1.40x).

### Caveats

- **The string axis is the one that looks worse (4.08x → 4.98x) and should not
  be read as a regression.** node's own string number moved 0.043 → 0.063 ms on
  this box, and the axis sits at ~0.06 ms — under the ~0.1 ms floor this
  harness's own README flags as loop-bound. It needs the 20x-scaled variant to
  say anything; the scaled numbers in the section above are the ones to trust.
- Still 7–10x on the two dynamic-dispatch axes. Real progress, not arrival.

### What the table says

1. **js2-standalone already matches V8 on scalar loops (0.97x) and on
   allocation (1.0x)**, and beats Porffor on 5 of 7 axes — by 58x on
   allocation and 9x on property access.
2. **One axis dominates everything: dynamic `this` dispatch** — 26x on method
   calls, 34x on the tokenizer shape. That single axis is the whole
   compiled-acorn story. It is already owned by **#3683**; this issue does not
   duplicate it, it quantifies it against the other engines.
3. **Porffor's acorn win is not codegen quality.** It has no host boundary,
   and js2's host lane does. On like-for-like codegen (the tokenizer proxy)
   Porffor is only ~1.2x ahead of js2-standalone, not 14x.
4. **String element access is ~4.5x off V8 and is unowned** (see Deliverable 2).

## Why node is faster — the mechanisms

V8 wins the two axes where we lose, and it wins them with runtime feedback that
an AOT compiler does not have:

- **Hidden classes + inline caches.** `this.pos` becomes a shape check plus a
  load at a constant offset; `p.inc()` becomes a shape check plus a direct,
  usually inlined, call. We must instead resolve a name at runtime, because we
  have no feedback to speculate on. This is exactly the gap #3683 closes
  *statically* via write-once prototype admission.
- **Speculation with deopt as a safety net.** V8 assumes monomorphism and bails
  out if wrong. An AOT compiler has to *prove* it — hence #3683's conservative
  admission analysis — or stay generic. Proving is strictly harder, which is
  why 26x is not going to become 1x, but 26x -> low single digits is available.
- **Unboxed Smi/double + generational bump allocation.** We already match this:
  the numeric and allocation axes are at parity, and i31 boxing (#3673 round 7)
  plus WasmGC's nursery are why.

## Why Porffor is faster than our host lane — the mechanisms

Read from source (this checkout is the `loopdive/porffor` fork, which compiles
**direct to C**; the README's "Wasm IR + 2c" description is stale — `2c.js` no
longer exists):

- **No host boundary at all.** One uniform in-process representation, so a
  property read never crosses into JS. This — not codegen — is the entire
  delta against our host lane.
- **Values never heap-allocate.** `typedef struct jsval { f64 val; i32 type; }`
  (`compiler/render.js:4728`) travels in registers; the type tag is the second
  struct field, NaN-boxed into a u64 only when spilled to memory
  (`porf_pack`/`porf_unpack`, `render.js:4884-4899`).
- **Compile-time property hashing.** `codegen.js:2779-2808` reimplements the
  runtime hash in the compiler, so `obj.foo` compiles to a call with a
  *constant* 32-bit hash immediate.
- **Static builtin dispatch.** `str.charCodeAt(i)` collapses at compile time to
  a direct C call (`codegen.js:1907-1943`, `typeSwitch` collapse at
  `:2126-2133`) — no lookup at all.
- **The C backend does the optimizer's job**: register allocation, SROA (which
  is what splits `jsval` into two registers and deletes the dead tag half),
  inlining, LICM, jump tables. Porffor itself has *no lowering passes*
  (`compiler/ir.js:1-6`) and delegates all of it to `cc -O3 -flto`. Note it is
  `-O3`, not `-Ofast`, and `-march` is unset (`compiler/index.js:119-235`) —
  the README is stale here too.

### What Porffor gives up for it — and why we cannot copy the wins wholesale

Its property model is a **linear scan comparing hashes only, never the key**
(`compiler/builtins/_internal_object.ts:496-523`). Consequences, all
source-verifiable:

- A 32-bit hash collision returns the **wrong property**. There is no key
  compare fallback and no runtime detection.
- Builtin prototype methods are statically bound and **cannot be shadowed or
  monkey-patched** (`codegen.js:1926-1933`) — an own property named `map` on an
  array is ignored.
- Own properties are capped at **65535** (u16 size field); string index-property
  materialization is skipped above 4096 chars.

These are correctness-for-speed trades that a compiler targeting test262
conformance cannot take. The measurements also show the model's cost: O(N)
per access is *why* Porffor is 12x node on property access and 58x on
allocation, both axes where we are already at parity with V8. **We should not
adopt Porffor's object model.**

## D3 discharged (2026-07-31): standalone CAN run acorn, and here is the whole-parse number

D3 below says "the standalone lane cannot run acorn yet — blocked on
#3675". **That is now stale**: the standalone runtime-dynamic lane runs
the full 226 KB acorn self-parse and is a committed benchmark row
(`benchmark:acorn:standalone-dynamic`). So the headline compiled-acorn
number can and should be the standalone one, per D3's own instruction.

**Measured (mine), tip `af7d6f875b35e5`, this container.** Harness
protocol: 2 warm-up + **9 measured rounds**, 5 iterations per round,
node control measured **in the same process** as the wasm lane:

| | min | median | max | std |
| --- | ---: | ---: | ---: | ---: |
| standalone wasm | 60,542.9 µs | **96,888.1 µs** | 145,689.7 µs | 25,691 µs (26.5%) |
| native node | 6,312.4 µs | **8,057.0 µs** | 11,837.9 µs | 1,612 µs (20.0%) |

- **median/median → node 12.03x faster**
- **min/min → node 9.59x faster**
- Load average **6.72 → 5.12** across the run (10 cores, ~7 concurrent
  agents). An earlier run of the same lane at load **7.36 → 8.10** gave a
  median ratio of 11.04x.

**Read the min pair, not the median pair, on a contended box.** The
26.5% wasm / 20.0% node standard deviations are contention, not
workload variance: node's own control moved from ~4,900 µs (uncontended,
committed artifact) to 8,057 µs median here on identical source. The
least-contended sample pair (min/min = **9.59x**) is the honest estimate
and it is stable across runs; the medians drift with whatever else the
box is doing. **Do not quote 12.03x as a regression against the
committed 9.77x** — that would be a local-vs-CI diff across different
hardware, which is exactly the phantom-delta trap this file's own
methodology caveats warn about.

**Bottom line: standalone compiled acorn is ~10x native node on a real
226 KB parse**, consistent with this issue's per-axis table (method
dispatch 9.73x, tokenizer shape 7.37x) — i.e. the whole-parse gap is
what the two non-parity axes predict, and the four parity axes
(numeric 0.98x, property 1.00x, allocation 1.00x, plus the loop) are
genuinely contributing nothing to it.

## Whole-parse decomposition (2026-07-31, mine) — and why D2 is NOT the lever

The axis table above measures **isolated microbenchmarks**. This section
measures **where the time actually goes in the real 226 KB acorn
self-parse**, which is a different question and gives a different answer.
This is the check the axis table cannot do for itself: an axis can be
4.5x off V8 and still be irrelevant if it is 2% of the mix.

**Method.** `--lane standalone-dynamic` compiled once with
`--preserve-debug-names --inspect-binary`, then profiled via
`--reuse-standalone-binary --profile-runtime wasm --profile-iterations 30`
(binary reuse skips the ~7-minute level-4 compile, so profile iteration is
seconds — worth knowing). Self-time per function from
`samples`/`timeDeltas`; **V8 profiler overhead (`post [node:inspector]`,
3.84% of raw samples) excluded from the denominator**, which is 2,443.0 ms
over 1,188 samples. Load average **12.8-13.9** on 10 cores — high, which
is why this is reported as **shares**, not times; shares are far more
contention-robust than wall-clock, but see the caveat at the end.

| family | share | largest members |
| --- | ---: | --- |
| **compiled parser body** | **56.90%** | `__closure_339` 3.38%, `__closure_378__typed_this` 2.64%, `__closure_184` 2.62% |
| property lookup | 10.10% | **`__extern_get` 8.03%**, `__obj_find` 0.53% |
| direct-call trampolines `__dc_*` | 7.66%¹ | `__dc_Parser_eat_1_g` 0.78%, `__dc_Parser_startNode_0` 0.34% |
| call dispatch | 7.45% | `__call_fn_method_0` 1.87%, `_7` 1.84%, `_1` 1.18% |
| value ops / coercion | 6.42% | `__extern_strict_eq` 2.13%, `__to_primitive` 1.53%, `__any_from_extern_honest` 1.08% |
| regexp engine | 4.76% | `__regex_search` 4.13% |
| GC | 4.31% | |
| **string runtime** | **2.10%** | `__str_flatten` 1.22%, `__str_equals` 0.88% |
| array runtime | 0.30% | `__vec_push` 0.24% |

¹ the `__dc_*` bucket is the #3683-S3 / #3780-round-2 direct-call
trampolines; arguably parser body too, which would take that bucket to
~61%.

### Finding 1 — D2 (string element access) cannot deliver parity. Do not spend a window on it.

**The out-of-line string runtime is 2.10% of the parse.** Zeroing it
entirely moves ~10x to ~9.8x. D2's "4.5x vs V8" is a true statement about
an isolated 700 K-`charCodeAt` loop where string access is ~100% of the
work; in a real parse the mix is dominated by everything else. This is
the axis-table-to-end-to-end extrapolation trap, caught by measuring the
mix instead of assuming it.

**Honest caveat that limits this claim.** `charCodeAt` on a flat native
string lowers **inline** (`array.get_u` off a `struct.get` data pointer —
#3673 round 34), so inline character reads are attributed to the *calling
closure* and sit inside the 56.90% parser-body bucket, not in
`__str_flatten`/`__str_equals`. So **2.10% is a floor on out-of-line
string cost, not a ceiling on total string cost.** What it does establish
is that the *rope/flatten/intern/compare machinery* — the part D2
proposed to hoist — is 2.10%. Settling the inline half needs a paired A/B
with the `i32→f64→i32` round trip removed, not a profile; #3673 round 36
priced that at ~27% of a *hand-typed tokenizer*, and acorn's parse is far
more than tokenizing.

### Finding 2 — the typed-`this` machinery IS firing on the hot path; the residual is INSIDE the twins

Splitting the parser-body bucket by whether a twin was emitted:

| | share |
| --- | ---: |
| parser body, **typed-`this` twins** | **37.10%** |
| parser body, **generic / no twin** | **19.80%** |
| direct-call trampolines `__dc_*` | 3.92%² |

² this counts only `__dc_*` frames attributed as parser body; the 7.66%
row above is the full `__dc_*`+misc-helper bucket.

So #3683 S2/S3 is not failing to apply — **37% of the whole parse already
runs inside typed twins**. That relocates the question: the cost is not
"we never proved the receiver", it is **what the twin bodies still
contain**. That is exactly #3686's scaffolding axis (null-check/throw +
`ref.cast` re-narrowing per field access). #3686's own repricing is
+23-29% on a pure walk; applied to a 37.10% share that is roughly
**8-11% end-to-end** — the largest single named lever in this table, and
far larger than D2.

### Finding 3 — the two hottest functions in the entire parse have NO twin

| share | function | |
| ---: | --- | --- |
| 3.38% | `__closure_339` | **generic** |
| 2.62% | `__closure_184` | **generic** |
| 2.64% | `__closure_378__typed_this` | twin |
| 2.21% | `__fnctor_Node_new` | generic |
| 2.33% | `__closure_352__typed_this` | twin |
| 2.11% | `__closure_543` | **generic** |

The single largest and third-largest compiled functions are **untwinned**,
and 19.80% of the parse sits in generic bodies. #3685's own S1 note
records the admission rate as **150 of 2,363** non-`this` accesses (6.3%)
and names the two dominant unproven shapes — `this.options.<x>` (a
field-read receiver) and `state.<x>` in the RegExp validator (a parameter
whose call sites pass a field read). Widening admission to reach the top
generic closures is worth more than the entire string family.

### Ranked levers on the real workload (supersedes reading the axis table alone)

1. **Scaffolding inside existing twins** (#3686) — ~37% share × 23-29% ⇒ ~8-11%.
2. **Widen twin admission to the top generic closures** (#3685) — 19.80% is untwinned.
3. **`__extern_get`** (#3669/#3671) — 8.03%, the largest single non-parser function.
4. Call dispatch 7.45% · value ops 6.42% · regexp 4.76% · GC 4.31%.
5. **String runtime 2.10%** — real, but not a parity lever.

**Contention caveat, applied to my own numbers first.** Taken at load
12.8-13.9 on a 10-core box with ~7 concurrent agents. Shares are robust
to contention in a way wall-clock is not, but GC share in particular can
move under memory pressure, and a 1,188-sample profile gives roughly
±1pp resolution on a 2% bucket. The **ranking** is what this section
asserts; treat individual sub-1% figures as indicative.

## Cross-box caveat on this issue's ranking (#3780 round 4, 2026-07-31)

Every share quoted in this issue comes from a profile of the standalone acorn
self-parse. A fourth profile, taken on a **4-core Linux container / Node
22.22.2** (rounds 1-3 of #3780 and both cross-validated profiles above were
Node 24 / arm64 macOS), disagrees on one bucket by an order of magnitude:

| bucket | Node 24 / macOS profiles | Node 22 / Linux container |
| --- | ---: | ---: |
| GC | 1.5% and 4.3% | **24-37%** |

The Linux figure is corroborated by an independent, profiler-free measurement
(summing inter-GC heap growth from `--trace-gc`: 22.5 ms of a ~120 ms parse
after #3780 round 4's lowerings, 30.1 ms before). I do not know whether the
cause is the V8 version, heap sizing, or the container.

**Why it matters here:** the non-GC buckets are shares of a denominator that
moves with it. If GC is really ~2% on the reference hardware, this issue's
share is correspondingly *larger* there than the Linux profile suggests, and
allocation-side work (#3921/#3927) is correspondingly smaller. Re-measure on
the target hardware before using any of these shares to sequence work.

## Deliverables

**D1 — the harness itself (done in this issue's PR).**
`benchmarks/cross-engine/` committed and reproducing. Re-run it whenever a
perf claim spans engines, and quote the axis, never the aggregate.

**D2 — string element access: 4.5x vs V8, currently unowned.**
The isolated measurement (700 K `charCodeAt` calls, loop cost subtracted) is
0.63 ns/call on node vs 2.81 ns on js2 — and the bare loop around it is already
at V8 parity, so this is genuinely the string access, not the loop. Worth a
scoped look at whether the rope/flat + one-byte/two-byte discrimination can be
hoisted out of the per-element path when the receiver is a loop-invariant flat
native string. Porffor is *worse* here (4.01 ns) despite compile-time static
dispatch, which suggests the cost is in the representation, not the dispatch.

**D3 — stop quoting the host-lane number as "our" acorn performance.**
The host lane's 330x is a bridge-tax measurement (#3673/#3669/#3671); the
standalone lane is the one to compare against other AOT engines. The
standalone lane cannot run acorn yet — blocked on **#3675** (the
`parseFloat`/`reset` illegal cast) plus two bugs not yet owned by any issue
(a `raise`/`getLineInfo` null deref on any syntax error, and `for-in` over a
fnctor instance enumerating nothing, which breaks acorn's `copyNode` and so
shorthand destructuring). Once those land, re-run acorn on standalone and
replace the headline number. Note the harness itself trips **#3674** — a
single 245 KB string literal overflows the compiler, hence the chunking in
`benchmarks/cross-engine/run-js2.mjs`.

## Explicitly NOT in scope

- **Method dispatch / typed-`this`** — owned by **#3683** (typed twin emission,
  direct-call devirtualization, numeric locals). This issue supplies the
  cross-engine numbers that size that work; it must not fork it.
- The host-lane bridge tax — #3673, #3669, #3671.
- Porffor-backend integration — #3288 and the existing
  `benchmark:porffor-direct-ab` / `benchmark:landing-four-lane` harnesses,
  which measure *lanes end-to-end*. This harness is complementary: it isolates
  *axes* within a lane.

## Methodology caveats (read before quoting these numbers)

- Absolute times are machine-specific; only same-axis ratios transfer.
- Porffor was measured on **plain JS**, matching what acorn is. With `.ts`
  annotations it promotes locals to raw `i32`/`f64` (`codegen.js:2370-2375`)
  and the numeric axis improves substantially. Do not quote its numeric row as
  its ceiling.
- The microbenchmarks are statically analysable in a way real parser code is
  not — js2's monomorphisation handles the object-literal property axis but
  does not survive acorn's dynamic `this`. That is exactly why the tokenizer
  axis is in the table: it is the shape that has to survive, and it is the one
  where we are 34x off.
