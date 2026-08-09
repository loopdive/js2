---
id: 3921
title: "tooling: per-type WasmGC allocation census — attribute struct.new/array.new volume by type"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: tooling
area: codegen, tooling
language_feature: compiler-internals
goal: performance
related: [3780, 3756, 3684, 3685, 3686, 3920, 3926, 3927]
loc-budget-allow:
  # The shared zero-length backing store (`src/codegen/empty-vec-store.ts`)
  # needs a hook at the empty-array-literal site and one context field; the
  # logic itself lives in the new module.
  - src/codegen/literals.ts
  - src/codegen/context/types.ts
  # (#3933) The shared-vec global cache must be shifted alongside
  # newTargetGlobalIdx / holeGlobalIdx / genEagerFlagGlobalIdx when a late
  # string-constant import global is inserted below the module globals. This is
  # the canonical home for that fix — the three sibling caches are shifted on
  # the adjacent lines — and the comment carries the root-cause analysis for
  # what is now the FOURTH occurrence of this bug, so the next reader does not
  # have to re-derive it from a merge-queue log.
  - src/codegen/registry/imports.ts
  # Two call sites (generateModule / generateMultiModule), 5 lines each plus the
  # import. The pass itself lives in src/codegen/alloc-census.ts, per the
  # "add code to the subsystem module, not the barrel" rule — what lands in
  # index.ts is only the hook, which has to be here because it must run after
  # dead-type elimination has remapped every typeIdx.
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
origin: "#3780 round 4 — allocation volume turned out to be the dominant standalone cost, and 34 MB of the 43.6 MB per acorn parse cannot be attributed with any existing tool"
---

# #3921 — per-type WasmGC allocation census

## Problem

#3780 round 4 established that **allocation volume is a first-class cost** in
the standalone lane and that nothing had been measuring it. Summing inter-GC
heap growth from `--trace-gc`, the standalone acorn module allocated **58.0 MB
per 226 KB parse** — ~257 bytes per source byte — against a GC share of 24-37%
of parse time on that box.

Two lowerings took it to 43.6 MB. The problem is what is left:

| | count / parse | our size | total |
| --- | ---: | ---: | ---: |
| AST `Node` structs | 32,487 | 292 B | 9.5 MB |
| AST arrays | 4,275 | ~56 B empty | ~0.2 MB |
| token string values | 41,889 tokens / 126 KB chars | 2 B/char + header | <1 MB |
| **accounted** | | | **~10 MB** |
| **measured** | | | **43.6 MB** |

**~34 MB per parse — roughly 810 bytes per token — is transient garbage that
the returned AST does not account for, and there is currently no way to say
what it is.**

## Why the existing tools do not answer it

Both measured, both negative — recorded so the next attempt does not repeat
them:

- **V8's sampling heap profiler does not observe WasmGC `struct.new`.**
  `HeapProfiler.startSampling` (2 KB interval) across a 58 MB parse sampled
  **0.2 MB total**, all of it attributed to a single `js-to-wasm` frame.
- **`--trace-gc-object-stats` is unavailable** on the Node build in use
  (accepted silently, prints nothing).
- A **V8 heap snapshot** cannot be taken mid-parse: the benchmark export is one
  synchronous call, and the AST is unreachable by the time it returns.
- **Static `struct.new` site counts are not volume.** The module has 1,137 vec
  sites and 1,926 string-carrier sites; that says where allocation *can*
  happen, not how often. Reading them as volume is the same
  axis-to-end-to-end extrapolation trap `#3684`'s whole-parse decomposition
  caught (an axis can be 4.5x off V8 and still be 2% of the mix).

So the census has to come from the emitter.

## Direction

Env-gated (`JS2WASM_ALLOC_CENSUS=1`), instrumentation-only, off by default:

1. At finalize, walk every function body and insert a **stack-neutral**
   `global.get $c_T / i32.const 1 / i32.add / global.set $c_T` immediately after
   each `struct.new` / `struct.new_default` / `array.new*`. The counter sequence
   leaves the freshly-allocated reference in place, so no body needs
   restructuring and no type changes.
2. One **exported** mutable `i32` global per allocated type. Export them by
   name — `wasm-opt` renumbers types, so a `typeIdx`-keyed reader would go
   stale, while export names survive.
3. A reader script that pairs each count with the type's computed instance size
   (fields × width + header) to produce bytes-per-type, which is the number the
   optimisation decisions actually need.

Notes for whoever builds it:

- Counts are only meaningful against a **known operation count** — report
  per-parse, not per-run.
- The instrumented binary is slower and larger; it is a measurement build, not
  something to benchmark against. Volume is what it is for, and volume is
  deterministic, so contention does not matter.
- `optimize: 4` still runs. Verify `wasm-opt` does not sink the increments past
  the allocation or merge counters for two types that got merged — comparing
  the census total against the independent `--trace-gc` sum (which needs no
  instrumentation) is the cross-check.

## Why this is the head of the queue

The standalone gap is ~9-10x and no identified lever is known to close it
alone. The ranked causes, and who owns them, are:

| # | cause | owner |
| ---: | --- | --- |
| 1 | allocation volume — 34 MB/parse unattributed | **this issue** |
| 2 | null-check/cast scaffolding inside compiled bodies | #3686 |
| 3 | untwinned generic bodies (twin admission 150/2,363 = 6.3%) | #3685 |
| 4 | `__extern_get` generic property lookup | #3926 |
| 5 | union-of-all-shapes fnctor structs (`Node` = 292 B for 3-6 live props) | #3927 |

This one is first not because it is the biggest — #3686/#3685 may well be —
but because it is the only one whose size is currently **unknown**, and it is
cheap to resolve relative to what it unblocks. Items 1 and 5 are both
allocation-side; sequencing 5 before this would risk spending an XL window on
a retained 9.5 MB while a transient 34 MB goes unexamined.

**Caveat that applies to the whole table:** these shares come from a Linux /
Node 22 profile whose GC bucket (24-37%) disagrees by an order of magnitude
with the two Node 24 / macOS profiles (1.5%, 4.3%). See the cross-box caveat
now recorded in #3684/#3685/#3686. If GC is genuinely ~2% on the reference
hardware, items 2-4 outrank items 1 and 5 there.

## RESULT — the acorn breakdown (2026-07-31)

Instrumented standalone runtime-dynamic build, 2,356,708 B, checksum 422,
counters snapshotted **after `__module_init` and before the parse** so the
table is per-parse rather than per-instance.

**647,346 allocations for one 226 KB parse** — about 15.5 per token.

| count/parse | share | wasm type | what it is | ~bytes ea | ~MB |
| ---: | ---: | --- | --- | ---: | ---: |
| **310,485** | **47.96%** | `(struct i32 i32 f64 eqref externref)` | **`$AnyValue` box** | 32 | **9.9** |
| 123,337 | 19.05% | `(array (mut externref))` | vec backing store (3 merged ids) | ~40 | ~4.9 |
| 54,825 | 8.47% | `(sub (struct i32 i32 (ref $i16arr)))` | native string carrier | ~24 | ~1.3 |
| 33,746 | 5.21% | `(array (mut i32))` | i32 array store | ~40 | ~1.3 |
| **32,468** | **5.02%** | `__fnctor_Node` | **the AST itself** | 292 | **9.5** |
| 31,414 | 4.85% | `__vec_externref` | vec header | 16 | 0.5 |
| 26,071 | 4.03% | `(array (mut i16))` | string char storage | ~40 | ~1.0 |
| 18,722 | 2.89% | `(struct i32 i32 (ref $i32arr))` | i32-backed vec | 24 | 0.45 |
| 7,252 | 1.12% | 5×f64 + externref | numeric record | 56 | 0.4 |

Byte estimates use 8 B headers, 4 B compressed refs and a nominal capacity-8
backing array; they sum to ~29 MB against the 43.6 MB `--trace-gc` total, so
**treat the byte column as indicative and the COUNT column as measured.** The
residual is almost certainly larger-than-nominal array capacities plus the
115-type tail; it does not move the ranking.

### The finding

**`$AnyValue` boxing is 48% of every allocation in the parse — 310,485 boxes,
~7.4 per token — and it appeared on no one's list.** The ranked table below put
allocation first but assumed the mass was AST-shaped; it is not. The AST is
**5%** of allocations by count and, even at 292 B each, only draws level with
`$AnyValue` on bytes.

This reorders the queue. `$AnyValue` is the carrier a value takes when a
statically-typed value flows somewhere its type is no longer known — the same
crossing #3899's boolean interning addressed one narrow case of. Whatever
fraction of those 310 K boxes is a value that was *provably* typed at the
producer and re-widened for a generic consumer is pure loss, and it is a
representation question (#3927/#3685 territory) rather than a GC-tuning one.

Also worth noting: **123,337 vec backing arrays against 4,275 arrays surviving
in the AST** — 29× more allocated than retained. Empty `[]` costs a header plus
a capacity-8 store, so a parser that speculatively creates lists it discards
pays ~56 B each time.

### Cross-check status

The census total has NOT been reconciled against the `--trace-gc` inter-GC sum
(29 MB estimated vs 43.6 MB measured). Closing that is the remaining
correctness step for this issue, and until it is closed the byte column must
not be quoted as measurement. The *counts* are exact — each is a counter
incremented at the allocation site.

## Follow-up measured 2026-07-31 — scalar replacement is NOT available

The cheapest possible fix for the 310,485 `$AnyValue` boxes would have been the
optimizer: most boxes are created, crossed and unboxed inside one expression,
which is exactly what Binaryen's `Heap2Local` promotes to locals. Tested before
proposing any codegen work, on the shipped 1,673,257 B standalone acorn binary:

| config | ArrayNew | StructNew |
| --- | ---: | ---: |
| shipped `-O3` | 731 | 3,759 |
| `+ --heap2local` | 731 | 3,759 |
| `+ --closed-world --heap2local` | 731 | 3,759 |
| `+ --closed-world --gufa --heap2local` | 731 | 3,759 |

**Zero allocation sites promoted, under every configuration.** `Heap2Local`
works by replacing a `struct.new` whose result provably does not escape; an
unchanged site count means nothing was provable. So either `-O3` already
extracted everything available, or — more likely given `$AnyValue`'s shape — the
boxes genuinely do escape into generic calls that the optimizer cannot see
through.

**Consequence: the `$AnyValue` fix must be "do not create the box" in codegen,
not "let the optimizer remove it".** That moves it out of tooling and into the
same representation family as #3685/#3927. It also means the remaining cheap
options are interning (constants only) and finding the producer that mints them
— it is worth reading the top producer's WAT to check whether its consumers
ever read more than one field of the 5-field union before assuming they need it.

Caveat: a static site count is not a dynamic allocation count. What this
measurement establishes is that no site was promoted, which is the precondition
for any dynamic win — not the size of a win that did not happen.

## Scope

- [x] Emitter-side census pass, env-gated and off by default (PR #3920).
- [x] Reader that reports count per type, per operation.
- [x] Publish the acorn breakdown — above.
- [ ] Reconcile the ~29 MB byte estimate with the 43.6 MB `--trace-gc` total:
      compute exact per-type sizes from the type table and the real array
      capacities instead of nominal ones.

## Acceptance criteria

- [ ] With the flag off, the emitted binary is byte-identical to today's.
- [ ] With the flag on, the standalone acorn parse yields a per-type allocation
      table whose total agrees with the independent `--trace-gc` measurement.
- [ ] The ~34 MB currently unattributed in #3780 is attributed to named types,
      or the discrepancy between census total and `--trace-gc` total is itself
      explained rather than left as a rounding remark.

## Follow-up 2026-07-31 — the "3.9 backing stores per vec" anomaly is NOT growth

The census showed 123,337 vec backing stores against 31,414 vec headers and I
attributed the ratio to the `max((len + argc) * 2, 4)` growth curve reallocating
from a cold start. **That was wrong.** Attributing each counter to its enclosing
function in the WAT gives:

| counter | count/parse | allocated in |
| --- | ---: | --- |
| `type_121` | 43,527 | `__objvec_new` (+ `__objvec_push`, `__vec_elem_set`) |
| `type_122` | 43,527 | **`__objvec_new` only** |
| `type_1` | 27,361 | 155 sites, dominated by `__call_fn_*` / `__call_fn_method_*` |

The two 43,527 figures are **identical**, and both trace to `__objvec_new`:
that helper allocates **two** backing arrays on every call — parallel key and
value stores for an open `$Object` — and it is called ~43.5 K times per parse,
about **once per token**.

So **87,054 array allocations per parse — 13.5% of all allocations, and 70% of
the vec-backing family — are two-per-call from `__objvec_new`**, not growth
reallocation at all. The growth curve may still be mistuned, but it is not what
the ratio was showing, and presizing or capacity tuning would have moved almost
none of it.

Two live questions this opens, both bigger than the shared-empty-store fix:

1. **Why is an open `$Object` constructed roughly once per token?** Acorn's hot
   path should be building closed fnctor instances (`Node`, `TokenType`), not
   open property bags. Whatever is falling back to the open representation is
   paying 2 arrays plus a struct every time.
2. **`__call_fn_*` argument vectors.** The remaining `type_1` mass is generic
   call dispatch materialising an args array per call. That is the same
   "generic dispatch is expensive" axis as #3926 and #3685, now with a
   first-party allocation number attached.

Recorded as a correction rather than a silent redirect: the growth-curve story
above is left in place because it was the stated reason for the previous change,
and it should be visible that measurement overturned it.

## #3933 — shipped, regressed, root-caused, re-landed (2026-08-01)

The first code change off this census (share one zero-length backing store per
element type, −8,922 allocations/parse) was auto-parked by the merge queue at
**net −2,621 test262 passes**: `illegal_cast` 77 → 3,711, `null_deref`
153 → 337, 400 modules failing to compile. Attribution was clean — a single-PR
merge group, and the run reported "0 test262-relevant commits separate the
baseline from main HEAD".

**Root cause — index bookkeeping, not the aliasing premise.**
`ctx.sharedEmptyVecGlobals` cached an **absolute** global index.
`addStringConstantGlobal` (`src/codegen/registry/imports.ts`) inserts each new
string literal as an **import global** at index `numImportGlobals` — *below*
every module-defined global — then calls `fixupModuleGlobalIndices` to shift
everything above it. That shifter updates the already-emitted `global.get`
instructions correctly, and separately updates a **hand-maintained list of
cached indices**. The new map was not on that list, so the next `[]` of the same
element type reused a stale index naming an unrelated global:

- stale index on an **i32/f64** global → module fails validation
  (`struct.new[1] expected type (ref null N), found global.get of type i32`) —
  the 400 `wasm_compile` failures;
- stale index on an **externref** global → the coercion layer repairs it with
  `any.convert_extern` + `ref.cast`, so the module validates and traps at run
  time — the +3,634 `illegal_cast`.

This is the **fourth** instance of the identical bug: `newTargetGlobalIdx`
(#2023), `holeGlobalIdx` (#2001), `genEagerFlagGlobalIdx` (#3032) each landed the
same one-line shift after the same class of failure, and each carries a comment
directly above the line the new cache should have been added to. A cache of a
live-baked global index is a standing hazard in this compiler; the durable shape
is deferred resolution at finalize (as `recordInModuleInitFlagRead` does for
`__in_module_init`), not a fifth entry in the list.

**The aliasing premise held.** A stress fixture forcing every empty array in a
program onto one shared singleton — `length=` grow, `fill`, `splice`,
`copyWithin`, `reverse`, `sort`, spread, `concat` — produced identical results
with the optimization off, on, and on-with-the-fix.

**Why the shipped tests could not fail** — two independent blind spots, both
measured, and worth carrying into any future backing-store sharing:

1. `target: "standalone"` forces `nativeStrings`, and `addStringConstantGlobal`
   early-returns without registering an import global. `numImportGlobals` stays
   0 and the shifter never fires. **Every test in the original file was
   standalone**, so the bug was invisible by construction.
2. The fixtures (`var a = [1]; a.pop()`) never reached the modified branch at
   all — small functions compile through the **IR front end**, which lowers `[]`
   itself and never calls `literals.ts`'s empty-array path. Instrumenting that
   exact body produced zero events and no `__empty_arr` global in the WAT.

The regression test now pins the JS-host lane with a real string-constant import
and two empty literals of one element type, and it was verified to FAIL with the
one-loop fix removed.
