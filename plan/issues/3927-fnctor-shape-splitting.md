---
id: 3927
title: "perf: a widened fnctor struct is the union of every shape its constructor ever takes — acorn's `Node` is 292 B for a 3-6 property object"
status: in-progress
assignee: "ttraenkler/claude-fable-6"
sprint: current
created: 2026-07-31
updated: 2026-08-06
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
language_feature: objects, classes
goal: performance
related: [4157, 3780, 3921, 3686, 3685, 743, 684]
origin: "#3780 round 4 — after packing the presence flags, `Node` is still 292 B, and the residue is the union-of-all-shapes widening itself"
---

# #3927 — per-shape splitting of widened fnctor structs

## Problem

A constructor whose instances take different property sets is lowered to ONE
closed struct carrying the **union** of every property any instance ever gets.
Acorn's `Node` is the clean example: every AST node kind — `Identifier`,
`CallExpression`, `TryStatement`, … — is the same `new Node(...)`, so the struct
carries the union of the whole ESTree surface.

Measured on the standalone acorn module (#3780 round 4):

| | fields | bytes/instance |
| --- | ---: | ---: |
| before round 4 | 130 (63 externref + 63 presence `i32` + 2 f64 + 2 ref) | 536 B |
| after round 4 (presence packed) | 69 | **292 B** |
| live properties on a typical AST node | 3–6 | — |

Round 4 removed the presence-flag half. The remaining 292 B is **62 `externref`
slots, of which a given node uses a handful.** At 32,487 nodes per 226 KB parse
that is 9.5 MB of the 43.6 MB allocated — and unlike the transient garbage in
#3921, this part is *retained* for the life of the AST, so it is paid twice:
once by the scavenger copying it, once by promotion.

## Why this is filed as hard, and what it is NOT

This is asking for the thing V8 does with hidden classes, done statically. The
honest framing:

- **A per-`type`-string split is not sound in general.** Acorn happens to set
  `node.type` before the shape settles, but nothing in the language says a
  constructor's instances partition by a string field, and the compiler cannot
  assume it.
- The tractable version is a **whole-program shape-set analysis**: collect the
  set of property sets an instance of `F` can reach, and if that set is small
  and statically separable, emit a struct per member with a common prefix
  (subtyping already supports the prefix rule — `$__vec_base` uses it). Where
  the analysis fails, keep today's union struct.
- Related prior art in-tree: #743 (whole-program type-flow analysis), #684
  (`any`-typed variable inference). This is the object-shape analogue and
  should reuse their fixpoint rather than grow a third one.

## Sequencing — do NOT start this first

Two things should land before this is worth attempting:

1. **#3921 (allocation census).** 34 MB of the 43.6 MB per parse is currently
   unattributed. If the census shows the transient 34 MB dwarfs the retained
   9.5 MB — which it does on the only measurement we have — then a cheaper
   transient-allocation fix outranks this. Do not spend an XL window on the
   9.5 MB before knowing what the 34 MB is.
2. **#3686 / #3685.** Splitting shapes makes more field accesses statically
   typed, which is the input those two want. Doing this first would mean
   re-deriving their admission logic against a moving representation.

There is also a **latent cycle guard** to fold in, recorded in
`plan/agent-context/dev-acorn-throughput.md` §6 and in #3686: `objectIrTypeFromTsType`
↔ `tsTypeToFieldIr` (`src/codegen/index.ts`) carry no seen-set, and today's code
survives only because a self-referential shape (`class Node { left: Node }`)
bails to the legacy path before it can recurse. Splitting makes those shapes
typed-and-reachable, which is exactly when the guard becomes live.

## Scope

- [ ] Whole-program shape-set analysis: per constructor, the set of reachable
      property sets, with an explicit "unknown / too many" verdict.
- [ ] Emit per-shape structs sharing a common prefix where the set is small and
      separable; keep the union struct otherwise.
- [ ] Fold in the `objectIrTypeFromTsType` ↔ `tsTypeToFieldIr` seen-set, with
      the repro that proves it — the same PR that makes the shape reachable is
      the one that can supply it.

## Acceptance criteria

- [ ] Acorn's `Node` allocation drops measurably in the `--trace-gc` per-parse
      accounting, reported alongside the census total from #3921.
- [ ] A constructor whose shapes are NOT separable still compiles, via the
      union struct, with no behaviour change.
- [ ] `for…in` / `Object.keys` / `in` answer identically before and after for
      every split shape — see #3920, which shows this surface is already
      lane-divergent and must not be made worse.
- [ ] No standalone test262 regression.

## Results — 2026-08-06 slice: re-profile + measured GC-sensitivity probe (splitting itself NOT landed)

**What landed**: `JS2WASM_FNCTOR_PAD_SLOTS=<N>` (src/codegen/fnctor-identity-fields.ts,
inside `appendFnctorInternalFields`) — an env-gated layout probe in the
`JS2WASM_PACKED_PRESENCE_BITS=0` idiom that appends N never-referenced
`externref` slots to every derived fnctor struct, plus
`tests/issue-3927-fnctor-pad-probe.test.ts`. Default OFF = byte-identical
(pinned by test). The probe exists to measure d(wall)/d(slot) of the `Node`
union BEFORE paying any splitting slice's dispatcher-surface risk. The
headline: **that derivative is ~10x larger than the allocation-share
arithmetic that demoted this issue predicted.**

### 1. Re-profile, main @ 431ea77d5 (post-#4174 scanner-flatten)

`scripts/profile-buckets.mjs`, 300 parses, 48,854 samples: **gc-engine
20.66%** — the largest bucket, GROWN from the 18.49% in #4157's 2026-08-06
table because #4174 shrank string-runtime (flatten 3.73 → 2.78%).
`__fnctor_Node_new` self 1.14%. Full ranking: gc 20.66 / dynamic-lookup 15.03
/ compiled 14.70 / scanner 12.64 / call-dispatch 10.50 / regexp 8.06 /
dynamic-eq 6.79 / cast-convert 5.63 / string-runtime 4.38 / alloc-helpers 1.39.

### 2. Allocation census, current main (`JS2WASM_ALLOC_CENSUS=1`, 3 parses)

607,469 allocations/parse, checksum 422·iters intact. Top rows (census
type-index → shape verified against the optimize:0 type section):

| count/parse | share | type | what it is |
| ---: | ---: | --- | --- |
| 283,370 | 46.7% | type_75 | `$AnyValue` box (5 fields, ~32 B, transient) — #3685/#743 |
| 54,623 | 9.0% | type_7 | `$AnyString` header |
| 41,811 ×2 | 13.8% | type_123/124 | `__objvec_new` key/value pair (#3921 Q1, ~once per token) |
| 33,727 | 5.6% | `__anon_14` | open `$Object` (per token) |
| 32,468 | 5.3% | `__fnctor_Node` | **the retained AST — 292 B/instance ≈ 9.5 MB/parse** |
| 31,414 + 27,361 | 9.7% | vec headers + arg arrays | call/array plumbing |

`__fnctor_Node` today: **69 fields = 62 externref + 3 ref_null + 2 f64 + 2 i32**
(unchanged from the round-4 measurement; verified in the emitted type section).
292 B = 65 compressed 4 B refs + 2×8 f64 + 2×4 i32 + 8 header — exact.

### 3. Why the three sketched slices price at ~zero on the motivating corpus

Three structural facts, all verified in `tests/dogfood/.acorn/package/dist/acorn.mjs`:

1. **One allocation-site class.** Exactly 3 `new Node` sites (`startNode`
   :3882, `startNodeAt` :3886, `copyNode` :3912), all inside shape-agnostic
   factory methods. The shape is chosen by the ~100 *callers* of
   `startNode()`, after allocation.
2. **The tag is applied at `finishNode`,** i.e. after the variant fields are
   already written — the discriminant is not knowable at the `struct.new`.
3. **`toAssignable` (:2094) rewrites `node.type` and fields IN PLACE** on live
   nodes (ObjectExpression→ObjectPattern, AssignmentExpression→AssignmentPattern).
   Any static partition of instances must put expressions and their pattern
   twins in the same member, collapsing the split exactly where the mass is.

Hence: **(a) trailing-zero-field elision per allocation-site class** — one
site class whose downstream union is the full union ⇒ zero elidable fields.
**(b) two-way stmt/expr split keyed on statically-known downstream `type`** —
never statically known at the ctor site; pushing the key to `startNode`'s
callers requires interprocedural cloning of the startNode→finishNode flows
(this issue's XL analysis), and fact 3 still merges the expr/pattern halves.
**(c) full #4074 declared partition** — supplies the per-TAG field sets but
not the per-instance tag at allocation; same obstacle as (b) plus the `.d.ts`
plumbing. None is affordable-with-payoff in one pass.

### 4. Field-population distribution (native acorn, same 226 KB corpus)

32,468 nodes (matches the census count exactly); 47 of the 62 union fields
populated; median instance populates **1** union field (0 fields 6.9%, one
43.9%, two 14.6%, three 18.1%, four 14.6%, six 1.9%). Top-K coverage (nodes
whose EVERY populated field is in the top-K by instance count): K=16 → 87.9%,
K=20 → 92.4%, **K=24 → 97.3%**, K=32 → 99.7%. Repro: `.tmp/field-freq.mjs`
(session scratch; recreate from this table's method: walk the native AST,
tally own enumerable fields minus type/start/end/loc/range/sourceFile).

### 5. The measured sensitivity — pad A/B (the number that reprices this issue)

`standaloneDynamic`, 3 back-to-back pairs, base vs `JS2WASM_FNCTOR_PAD_SLOTS=36`
(+36 externref slots = +144 B and +58% pointer slots per Node ≈ +4.7 MB/parse
retained; binary +1,587 B):

| pair | base wasmUs | pad36 wasmUs | Δ |
| --- | ---: | ---: | ---: |
| 1 | 180,261 | 235,051 | **+30.4%** |
| 2 | 180,822 | 233,991 | **+29.4%** |
| 3 | 169,134 | 216,346 | **+27.9%** |

3/3 pairs, far outside the ±2.5% noise band. Checksum 422 in every run.
(Contamination note: `nodeUs` in the same padded processes also rose ~13% —
the native baseline shares the V8 heap with the padded Wasm GC heap; the
wasm-side delta is 2x larger and directionally robust, but treat +29% as
including some shared-process amplification.)

**GC-bucket profile delta** (300-parse profile, padded): gc-engine
**20.66% → 24.87%**. In absolute per-parse terms (bucket share × A/B wall):
GC ≈37 ms → ≈58 ms (**+57%**), while every mutator bucket also grew ~15-20%
in absolute time — a locality/cache tax from the +50% AST working set, on top
of the GC scan cost. `__fnctor_Node_new` self 1.14 → 1.57% (init cost of 36
extra `ref.null` operands: minor).

### 6. Interpretation — what this does to the issue's pricing

- The #4157 demotion ("payoff routes through the GC bucket only, capped at
  ~19% of allocation") priced the lever by allocated **bytes**. The probe
  shows the union's cost is dominated by **retained pointer-slot count**
  (GC marking/scavenge scans every ref slot of every live node, every cycle)
  plus **mutator locality**, and the measured addition-direction slope is
  ~0.2%/B — an order of magnitude above the allocation-share estimate.
- **Asymmetry caveat, stated plainly**: the only removal-direction datum is
  #3780 round 4, where −244 B/instance of **i32** presence words (plus
  boolean interning) bought −7.4% median wall. i32 slots are not scanned as
  pointers, so that undersells ref-slot removal; still, do NOT read +29% as
  a promised −29%. Honest bracket for removing ~37 of the 62 ref slots:
  **−5% (round-4-style floor) to −25% (mirror ceiling)** — even the floor
  beats every other single Workstream-2 lever except #3926.
- The pad18 linearity point (see addendum below) tests whether the slope is
  linear or threshold-driven.

### 7. The slice this prices IN, for the next pass: shape-AGNOSTIC hot/cold split

The one design that survives facts 1-3 (no shape-at-allocation needed, immune
to `toAssignable`): keep the top-K≈24 union fields inline (97.3% of nodes
fully covered), move the cold ~38 to a lazily-allocated tail struct behind one
`(ref null $__fnctor_Node__cold)` slot. Per-instance: 292 → ~148 B avg
(−37 ref slots on every node; 2.7% of nodes pay a ~160 B tail). Presence bits
stay in the main struct (word count unchanged); reference identity is
untouched (the tail is owned, never escapes).

**The risk is dispatcher completeness — the 9th-dogfood-wall class** (silent
`undefined` on any consumer that misses the tail hop). Chokepoints that must
ALL learn the hop, enumerated now so the next pass doesn't rediscover them:
`member-get-dispatch.ts` / `member-set-dispatch.ts` (finalize fills — the set
side must lazy-alloc the tail), `property-access.ts` inline primaries +
`findAlternateStructsForField`, `fnctor-presence-bits.ts` helpers, typed-this
twins + `fnctor-typed-reads.ts` (decline cold fields or learn the hop),
compound updates (`expressions/assignment.ts`, `unary-updates.ts`),
enumeration/`in`/`hasOwnProperty` (object-runtime consumers of
`exposedClosedStructFieldName`), delete/tombstones, host marshalling
(gc/host lane), destructuring/spread reads. Static field ranking must be
corpus-independent (static write-site count per name); ties broken
deterministically. Do it as its own flag-gated slice with this probe as the
paired control, and A/B against the bracket above.

**Flag decision for this PR**: `JS2WASM_FNCTOR_PAD_SLOTS` ships **default
OFF** — it is a measurement diagnostic (deliberately a pessimization when on),
not an optimization; the evidence rule's "wash ships OFF" applies a fortiori.

**Gates**: typecheck 0, lint 0, oracle-ratchet 0, loc-budget 0 (probe moved
into fnctor-identity-fields.ts rather than growing the fnctor-escape-gate.ts
god-file), func-budget 0, dead-exports 0, coercion-sites 0, stack-balance 0,
check:ir-fallbacks 0, format 0. Suites: #2660 fnctor suites 58/58,
#4155 Phase 0 + Phase 2 + provenance 25/25, s3b typed bindings (in the 58),
targeted equivalence object/struct/shape 75/75, probe test 3/3. Dogfood
canaries 2/3/4/5, `functionImports: []`, exactly the 3 pre-existing
IR-FALLBACKs (typeIdx parity on parse/parseExpressionAt/tokenizer).
