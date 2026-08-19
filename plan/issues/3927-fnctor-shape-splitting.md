---
id: 3927
title: "perf: a widened fnctor struct is the union of every shape its constructor ever takes — acorn's `Node` is 292 B for a 3-6 property object"
status: done
completed: 2026-08-08
pr: 4230
assignee: "ttraenkler/fable-3927-emission"
sprint: 78
created: 2026-07-31
updated: 2026-08-18
loc-budget-allow:
  # The split's own code (≈500 LOC) lives in the NEW `fnctor-cold-tail.ts`.
  # These five are the unavoidable in-place seams: the three reflective
  # `fillClosedStruct*Arms` passes must gain their cold arms where they are
  # (object-runtime), the split hook must sit inside `deriveFnctorFields`
  # (that is the single source of truth for the field set), the two ctx maps
  # must be declared on the context type, index.ts gains one call, and
  # property-access.ts gains one `continue`.
  - src/codegen/object-runtime.ts
  # (2026-08-07 per-type-layouts slice) The analysis hook must sit in the gate:
  # `analyzeFnctorEscapeGate` is the single place that already owns the
  # whole-program walk, the proto index and `ctorDeclByName`, which the label
  # fixpoint keys off. The analysis itself (≈450 LOC) lives in the NEW
  # `fnctor-alloc-labels.ts`; only the ~12-line call + result field are here.
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
  # (2026-08-07) The §4 `generator` defect lives INSIDE the Phase-3 (#1269)
  # consumer-side narrowing in `compilePropertyAccess`. The veto has to be
  # where the narrowing decision is made; there is no seam to move it to.
  - src/codegen/property-access-dispatch.ts
  # (2026-08-08 emission slice) The layout-hint global must be published at
  # the allocation-label SITE (a factory call / direct new), i.e. at the top
  # of the two expression compilers — there is no narrower seam that sees the
  # ts.Node the plan keyed the label on. The ctor's layout-selecting
  # struct.new replaces the single struct.new in compileNewFunctionDeclaration
  # (new-super.ts). ~10 lines each; the emission itself (~700 LOC) lives in
  # the NEW fnctor-layout-emit.ts.
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
  # (2026-08-07) Same seam as the loc-budget grant above — the Phase-3
  # narrowing decision lives inside this function.
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  # (2026-08-08 emission slice) The hint publication sits at the top of the
  # two expression compilers (see the loc grant above) — +9/+6 lines.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
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

- [x] Whole-program shape-set analysis: per constructor, the set of reachable
      property sets, with an explicit "unknown / too many" verdict.
      **Landed 2026-08-07** — `src/codegen/fnctor-alloc-labels.ts`; see the
      results section below.
- [x] Emit per-shape structs sharing a common prefix where the set is small and
      separable; keep the union struct otherwise. **Landed 2026-08-08,
      flag-gated `JS2WASM_FNCTOR_LAYOUT_EMIT`, DEFAULT OFF** —
      `src/codegen/fnctor-layout-emit.ts`; see the emission results section
      below. Non-`split` verdicts keep the union struct + cold tail.
- [x] Fold in the `objectIrTypeFromTsType` ↔ `tsTypeToFieldIr` seen-set, with
      the repro that proves it. **Already on main** — #4019 added the
      path-scoped `onPath` set to both functions (`src/codegen/index.ts`
      :1176/:1216) with exactly this rationale. Nothing to add; re-verified
      2026-08-07.

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
headline: **measured under controlled conditions the derivative is small —
~+3-4% wall for +36 ref slots (profile-verified through the GC bucket), which
CONFIRMS the #4157 demotion** — and §5 documents how an uncontrolled first
block read +29% and would have flipped that verdict if the order-reversal
control hadn't caught the contamination.

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

### 5. The sensitivity A/B — including the contaminated block that almost flipped the verdict

Four blocks, all `standaloneDynamic` back-to-back pairs, base vs
`JS2WASM_FNCTOR_PAD_SLOTS` (pad36 = +36 externref slots = +144 B and +58%
pointer slots per Node ≈ +4.7 MB/parse retained; binary +1,587 B; checksum
422 in every run):

| block (UTC) | order | pairs | base wasmUs | pad wasmUs | pad cost within pair |
| --- | --- | --- | ---: | ---: | ---: |
| A 17:26-17:40 | base→pad36, **this agent running suites concurrently** | 3 | 180,261 / 180,822 / 169,134 | 235,051 / 233,991 / 216,346 | **+30.4 / +29.4 / +27.9%** |
| B 17:47-17:57 | base→pad18, agent idle | 2 | 198,154 / 194,839 | 184,045 / 186,755 | **−7.1 / −4.1%** |
| C 17:58-18:08 | **pad36→base** (order control), agent idle | 2 | 187,420 / 196,217 | 185,255 / 205,009 | **−1.2 / +4.5%** |
| D 18:09-18:19 | base→pad36, agent idle | 2 | 166,930 / 174,358 | 190,020 / 216,187 | **+13.8 / +24.0%** |

**What the four blocks establish, in order of confidence:**

1. **This box cannot resolve the effect by A/B alone.** Quiet pad36 samples
   scatter −1.2 / +4.5 / +13.8 / +24.0%; quiet pad18 samples −7.1 / −4.1%
   (expected ≈ +2% if linear). Base runs alone moved 167-198 kµs (±9%)
   across blocks; other agent lanes were active on the box throughout and
   cannot be quiesced. Ambient variance is the same order as the effect.
2. **Block A's tight +29% (3/3) is NOT trustworthy despite its consistency** —
   it was measured while this agent ran multi-core vitest suites/gates
   concurrently, and its `nodeUs` rose ~13% in every pad run (shared-process
   load signature). A 3/3-consistent far-outside-noise A/B can still be an
   artifact; the order-reversal control (block C) and the quiet re-runs are
   what exposed it. The pooled quiet evidence is compatible with a real
   positive cost well below +29%.
3. **The profile is the reliable instrument, because bucket SHARES are robust
   to uniform ambient load.** 300-parse profiles, base vs pad36: gc-engine
   **20.66% → 24.87%**, every other bucket diluted roughly proportionally,
   `__fnctor_Node_new` 1.14 → 1.57% (the 36 extra `ref.null` operands:
   minor). That share shift is **≈ +25-30% GC self-time ≈ +3-4% of wall** as
   the mechanism-consistent point estimate, sitting inside the quiet-A/B
   scatter, and consistent with #3780 round 4 (−24.8% allocation bought
   −7.4% wall).

### 6. Interpretation — the demotion stands, now with a measured coefficient

- **Point estimate d(wall)/d(ref-slot) ≈ 0.1%/slot** at the current operating
  point (profile mechanism: +36 slots → ~+3-4% wall via GC), with the quiet
  A/B bracketing the +36-slot cost at **[0, +25%]** — the box cannot narrow
  it further. Linear extrapolation for the best affordable removal (−37 of
  the 62 union ref slots): **≈ −3-4% wall point estimate**, optimistic tail
  ~−10%, corroborated by round 4 (−24.8% alloc → −7.4%).
- Even the optimistic tail does not outrank #3926 (16.1% dynamic-lookup
  bucket, one helper, no dispatcher-surface risk) or #4173 (7.1%
  dynamic-eq) on expected value once the silent-undefined risk surface of
  splitting is priced. **The #4157 demotion of this issue was correct**; it
  now rests on a measured coefficient instead of an allocation-share guess.
- **Measurement lesson, recorded because block A nearly shipped a false 10x
  repricing:** a 3/3-consistent, far-outside-noise A/B was still an artifact
  of concurrent load. On a shared box: keep the measuring agent idle, run an
  **order-reversal control block**, and trust bucket-share deltas over wall
  deltas. This is the manual form of the interleaved-pairs contamination
  flagging #4173's plan calls for; the harness does not do it automatically
  today.

### 7. The slice this prices, for whenever the GC bucket is the last one standing: shape-AGNOSTIC hot/cold split

The one design that survives facts 1-3 (no shape-at-allocation needed, immune
to `toAssignable`): keep the top-K≈24 union fields inline (97.3% of nodes
fully covered), move the cold ~38 to a lazily-allocated tail struct behind one
`(ref null $__fnctor_Node__cold)` slot. Per-instance: 292 → ~148 B avg
(−37 ref slots on every node; 2.7% of nodes pay a ~160 B tail). Presence bits
stay in the main struct (word count unchanged); reference identity is
untouched (the tail is owned, never escapes). **Measured expected payoff:
≈ −3-4% wall (§6) — do NOT schedule it ahead of #3926/#4173/#743.**

**The risk is dispatcher completeness — the 9th-dogfood-wall class** (silent
`undefined` on any consumer that misses the tail hop). Chokepoints that must
ALL learn the hop, enumerated now so a future pass doesn't rediscover them:
`member-get-dispatch.ts` / `member-set-dispatch.ts` (finalize fills — the set
side must lazy-alloc the tail), `property-access.ts` inline primaries +
`findAlternateStructsForField`, `fnctor-presence-bits.ts` helpers, typed-this
twins + `fnctor-typed-reads.ts` (decline cold fields or learn the hop),
compound updates (`expressions/assignment.ts`, `unary-updates.ts`),
enumeration/`in`/`hasOwnProperty` (object-runtime consumers of
`exposedClosedStructFieldName`), delete/tombstones, host marshalling
(gc/host lane), destructuring/spread reads. Static field ranking must be
corpus-independent (static write-site count per name); ties broken
deterministically. If ever built: its own flag-gated slice with this probe as
the paired control, measured with order-reversal blocks per §6.

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

## Results — 2026-08-07 slice: §7's hot/cold split BUILT and MEASURED (ships flag-OFF)

**What landed**: `src/codegen/fnctor-cold-tail.ts` + wiring, behind
`JS2WASM_FNCTOR_HOT_FIELDS=<K>` (unset ⇒ OFF ⇒ byte-identical). This is §7's
shape-AGNOSTIC design, built as specified: the top-K flow-grown fields stay
inline, the rest move to a lazily-allocated `$__fnctor_<Name>__cold` tail
reached through one `$cold` slot.

**Headline, on the only quotable lane (`standalone-dynamic`, acorn self-parse,
226 KB), all numbers deterministic:**

| | OFF | K=24 |
| --- | ---: | ---: |
| `__fnctor_Node` fields | 69 (62 externref) | **33** (26 externref) |
| `__fnctor_Node` bytes/instance | 292 B | **148 B** |
| `__fnctor_Node` bytes/parse | 9.48 MB | 4.81 MB |
| cold tails allocated/parse | — | 11,895 × 160 B = 1.90 MB |
| **Node stream, net** | **9.48 MB** | **6.71 MB (−29.2 %)** |
| **ALL struct bytes/parse** | **12.23 MB** | **9.59 MB (−21.6 %)** |
| allocation COUNT/parse | 270,062 | 281,957 (+4.4 %) |

§7 predicted 292 → ~148 B. It is **exactly 148 B**. The −37-ref-slot figure
§6 priced at ≈ −3-4 % wall is realised as **−36 ref slots**.

### 1. The census total is 12.23 MB, not 43.6 MB — and `Node` is 77.5 % of it

`JS2WASM_ALLOC_CENSUS=1` on current main measures **270,062 allocations and
12,827,613 struct BYTES per parse**, of which `__fnctor_Node` alone is
**9,480,656 B — 77.5 %**. (The older 43.6 MB figure came from `--trace-gc`,
which also counts array PAYLOAD bytes; the census's per-instance sizes cover
structs only. Both are right about different quantities — quote the census
when ranking struct-shape levers.) That reframes this issue: it is not "9.5 of
43.6 MB", it is **three quarters of every struct byte the parse allocates**.

### 2. The overflow rate is 37 %, not 2.7 % — §4's top-K coverage does NOT transfer

§4 measured 97.3 % of nodes fully covered by the top-24 fields **by instance
count**. The shipped ranking is by **static write-site count** (corpus-
independent, as §7 requires), and the two orders disagree sharply: `left`,
`right`, `callee`, `object`, `properties`, `elements` are runtime-hot but are
each written at few syntactic sites, so they rank cold. Measured directly (the
census counts tail allocations): **11,895 of 32,468 nodes — 36.6 % — allocate
a tail at K=24.** That is why the net is −29 % rather than −49 %: a third of
the saving is handed back as tails.

**This is the actionable finding for whoever takes the next slice.** A better
hotness proxy — static *read*-site count, or write-sites weighted by the
enclosing method's call-graph reachability — should move `left`/`right`/
`callee` back inline and cut the overflow rate, without giving up
corpus-independence. Nothing else in this design has that much headroom left.

### 3. Correctness: the reflective surfaces were the whole risk, exactly as §7 said

Validated with a purpose-built standalone differential (`.tmp/cold-probe.mjs`
idiom): compile the acorn self-parse, walk the resulting AST **inside wasm**,
and accumulate **one rolling hash per ESTree property name** (64 of them),
comparing against the OFF build. `JSON.stringify` is useless here — a closed
fnctor struct serialises as `null` in the standalone lane — and the existing
`tests/dogfood/acorn-corpus.mjs` differential cannot see this split at all,
because it runs in JS-HOST mode where flow-grown fields are never reserved as
native slots.

| K | fields moved | 64 per-field hashes vs OFF |
| ---: | ---: | --- |
| 55 | 5 | identical |
| 52 | 9 | **DIVERGED** (before the reflective wiring) |
| 24 | 36 | **identical** |
| 8 | 52 | 63 identical, `generator` differs |
| 0 | 60 | 63 identical, `generator` differs |

The first cut wired only the member get/set dispatchers and diverged at K=52.
The mechanism was **acorn's `copyNode`** (dist :3911) —
`for (var prop in node) { newNode[prop] = node[prop] }` — i.e. enumeration plus
a COMPUTED read, neither of which routes through `__get_member_<name>`. Wiring
the three standalone reflective passes (`fillClosedStructHasOwnArms`,
`fillClosedStructOwnPropertyNamesArms`, `fillClosedStructExternGetArms`) made
K=52 and K=24 bit-identical. §7's chokepoint list was right; the ones that
actually bit were the reflective ones, not the dispatchers.

**Two design decisions carried the rest of the risk:**

1. A cold field is **removed** from the main struct's field list, so every
   consumer that resolves by name (`fields.findIndex`) answers `-1` and takes
   its existing not-a-slot path — the dynamic dispatcher, which IS wired. The
   un-taught consumer degrades to a slower CORRECT path instead of reading a
   wrong slot. (Verified in `fnctor-typed-reads.ts`, which declines on
   `fieldIdx < 0`, and in `compilePropertyAssignmentExternSet`, whose
   `fieldIdx === -1` branch already routes through `emitAlternateStructSetDispatch`.)
2. The tail is hidden from `isSyntheticStructName` and from
   `findAlternateStructsForField`. It is a private payload, never a receiver:
   an arm keyed on `ref.test $…__cold` is dead at best and, under WasmGC's
   structural canonicalization of same-shaped structs, wrongly live at worst.

### 4. Known defect, reproducible: `generator` at K < 13

At K=8 and K=0 exactly **one** of 64 field hashes differs, and it is the same
one at both settings: `generator`. Every other field, including every
structural one, is exact. It is a boolean-valued field, which points at a
boolean-brand or typed-twin read path not yet taught the hop (the typed
`__get_member_<name>__f64` twin is the leading suspect — it is the one
dispatcher this slice did not wire). **Do not raise the split past K≈13 until
that is found.** K=24, the setting these numbers are quoted at, is unaffected.

### 5. Profile bucket share — the mechanism check, and it holds

`scripts/profile-buckets.mjs`, 300 parses, `standalone-dynamic`,
`--preserve-debug-names` + `JS2WASM_CLOSURE_NAME_MAP=1`, OFF vs K=24:

| bucket | OFF | K=24 | |
| --- | ---: | ---: | --- |
| **gc-engine** | **15.71 %** | **11.79 %** | **−3.92 pp (−25 % of its own share)** |
| compiled | 18.12 | 19.89 | diluted up |
| scanner | 16.31 | 17.16 | diluted up |
| dynamic-lookup | 16.38 | 16.78 | diluted up |
| call-dispatch | 9.46 | 10.33 | diluted up |
| regexp | 7.41 | 7.55 | diluted up |
| dynamic-eq | 5.65 | 5.70 | diluted up |
| cast-convert | 4.89 | 5.09 | diluted up |
| string-runtime | 4.46 | 4.27 | ~flat |
| alloc-helpers | 1.37 | 1.21 | fewer `struct.new` operands |

**One bucket shrinks and every other one dilutes proportionally upward — the
exact signature of a single absolute reduction with the rest unchanged.** The
top frame `(garbage collector)` falls 15.70 → (out of the top-25 head) and the
bucket loses a quarter of itself, against a measured **−21.6 % of allocated
struct bytes**. Cause and effect line up: the GC bucket on this workload is
close to proportional to allocated bytes.

Translating with §6's own arithmetic: GC self-time ≈ 25 % smaller × a
15.7 %-of-wall bucket ⇒ **≈ −3.9 % of wall**, landing on §6's −3-4 % point
estimate from the pad probe. Two independent instruments (the pad probe's
d(wall)/d(slot), and this byte→bucket measurement) now agree.

Wall for the two profiled runs was 42,981 ms → 41,038 ms (−4.5 %). **That is a
single unreplicated pair with no order-reversal control and is BELOW this
box's resolvability bar (§6) — it is quoted only because it is consistent with
the bucket shift, and it is not evidence on its own.** The bucket shares are;
per §6.3 they are robust to uniform ambient load in a way wall deltas are not.

### 5b. What is NOT measured

- **No replicated / order-reversed wall A/B.** Deliberate: §5 of the
  2026-08-06 slice records a 3/3-consistent +29 % reading that was pure load
  contamination. The bucket share is the instrument here.
- **Standalone lane only.** The split is gated on `ctx.standalone` by
  construction (flow-grown fields are the host-free replacement for the host
  sidecar), so host mode is untouched.
- **No test262 run.** Flag-OFF ⇒ byte-identical, so the merge-queue gates cover
  it; a conformance run of the flag-ON build is the next slice's job, after §4
  closes.

### 6. Flag decision: ships **default OFF**

Two reasons, and note that "the payoff is unproven" is **no longer** one of
them — §5's bucket shift is a real, mechanism-level positive result:

1. **A defect is open** (§4). Shipping ON with a known one-field divergence
   over part of the range is not defensible even though the recommended setting
   sits outside it. This is the blocking reason.
2. **The overflow rate says the design is not at its best point** (§2). A
   better hotness proxy is cheap and improves the bytes AND the risk (fewer
   fields cold ⇒ smaller reflective surface). Landing ON now would freeze the
   worse variant, and the ranking change would then have to be re-validated
   against a shipped default rather than against OFF.

So this is a **deferred ON, not a wash**: −21.6 % of allocated struct bytes and
−3.92 pp of the largest profile bucket, for ≈ −3.9 % of wall by the
byte→bucket translation. The switch is one line once §4 closes and §2's
ranking lands; the mechanism, the harness idiom, and the corrected arithmetic
are this slice's deliverable.

### 7. Gates

typecheck 0, lint 0, format 0, oracle-ratchet 0 (no checker-usage growth across
10 changed codegen files), dead-exports 0, coercion-sites 0, stack-balance 0,
check:ir-fallbacks 0. loc-budget / func-budget: allowances granted in this
file's frontmatter — the split's own ≈500 LOC live in the new
`fnctor-cold-tail.ts`; the granted files are the unavoidable in-place seams.
Dogfood canaries **2/3/4/5** at K=24, `functionImports: []`, exactly the 3
pre-existing IR-FALLBACKs (typeIdx parity on
parse/parseExpressionAt/tokenizer). Census checksum **1266** identical OFF and
at K=24. `tests/issue-3927-fnctor-cold-tail.test.ts` pins the OFF byte-identity
(including that a malformed flag value cannot half-enable the split — a bare
`Number("")` is `0`, which would have moved EVERY eligible field) and the
total-order property of the ranking.

## Results — 2026-08-07 slice: the PER-TYPE LAYOUT analysis, built and validated (emission designed, not built)

**What landed**: `src/codegen/fnctor-alloc-labels.ts` +
`tests/issue-3927-fnctor-alloc-labels.test.ts`, behind
`JS2WASM_FNCTOR_LAYOUTS` (`JS2WASM_FNCTOR_LAYOUT_DIAG=1` prints the plan).
This is the first scope item — the whole-program shape-set analysis with an
explicit "unknown / too many" verdict. Nothing consumes the plan yet;
standalone acorn is **byte-identical with the flag ON** (937,273 B, canaries
2/3/4/5, `functionImports []`).

**Headline: the shapes ARE separable, by a lot, and the plan is empirically
sound on the motivating corpus.**

| | union struct | #4211 K=24 (flag-OFF) | slice C K=20 (default-ON) | per-type layouts (this plan) |
| --- | ---: | ---: | ---: | ---: |
| `__fnctor_Node` B/instance | 292 | 206.6 | ~181 | **98.0** |
| Node stream, MB/parse | 9.48 | 6.71 | 5.89 | **3.10** |
| vs the union struct | — | −31.1 % | −37.9 % | **−67.3 %** |

**⚠ Baseline correction (2026-08-07, after slice C).** The first draft of this
section quoted "−53.6 % of ALL struct bytes", measured against the UNION-struct
baseline. That baseline is gone: slice C
(`claude/issue-3927-ranking-and-generator`) makes the hot/cold split
**default-ON in the standalone lane at K=20** and measures 12.69 → 9.10 MB of
struct bytes per parse (−28.3 %). Against that new default the marginal figure
is smaller, and it is the one that should be quoted:

| comparison | struct bytes/parse | |
| --- | ---: | ---: |
| slice C default (the new baseline) | 9.10 MB | — |
| + per-type layouts | **6.31 MB** | **−30.7 %** |
| both, vs the pre-split union struct | 6.31 MB | −50.3 % |

Read on the Node stream alone, per-type layouts remove a further **−47.4 %** of
what slice C leaves. The two techniques **overlap rather than compose** for this
fnctor: §4 measures a 0 % residual rate for per-type layouts, so where a layout
is proved the cold tail has nothing left to move (slice C's tail rate is 28.1 %).
The cold tail stays valuable exactly where the layout analysis returns a
non-`split` verdict.

### 1. Why §3's "the shape is not knowable at the `struct.new`" was right but not fatal

§3 established that a `new`-site partition is trivial here: three `new Node`
sites, all inside shape-agnostic factories, tag applied later at `finishNode`.
That remains true. What it missed is that **one level of call-site context
(k=1) moves the label off the `new` and onto the factory CALL SITE**, and that
population is small: acorn has 2 allocation-transparent factories
(`startNode` :3881, `startNodeAt` :3885 — every `return` is a direct
`new Node(…)`) and 59 static call sites, 25 of which execute on the corpus.

### 2. The identity summary is the whole ballgame — without it the analysis is worthless

Parser combinators are `pp.finishNode = function (node, type) { …; return node }`
with every builder written as
`parseX(node, …) { … return this.finishNode(node, "X") }`. A plain return-value
join therefore makes **every `parseX()` call evaluate to "any node ever
allocated"**, and any one shared write blurs its property onto every label.
Summarising pass-through functions as *identity in parameter i* (so a call
yields ITS OWN argument, not the join of every caller's) removes the join:

| | mean fields per label | universal fields |
| --- | ---: | --- |
| return-value join | 14.5 | 13 (`async body elements end expression expressions generator id params raw regex type value`) |
| identity summaries | **6.3** | 2 — `type`/`end`, both constructor-assigned |

The de-blurred layouts read like ESTree node kinds, which is the sanity check
that the analysis is finding real structure: `{end,expressions,name,type}` at
:3677 is `parseIdent` (32.5 % of all allocations);
`{computed,end,object,optional,property,…}` at :2928 is MemberExpression;
`{end,left,operator,right,…}` at :2802/:2717 is the binary/assignment family.

### 3. In-compiler verdicts, current main + this branch

`JS2WASM_FNCTOR_LAYOUTS=1 JS2WASM_FNCTOR_LAYOUT_DIAG=1`, standalone acorn:

| fnctor | verdict | labels | layouts | union | mean label / union |
| --- | --- | ---: | ---: | ---: | ---: |
| **Node** | **split** | 59 | 40 | 62 | **0.102** |
| RegExpValidationState | single-site | 1 | 1 | 9 | 1.000 |
| DestructuringErrors | not-separable | 4 | 1 | 5 | 1.000 |
| Token / TokenType / Position | no-sites | 4 / 1 / 1 | — | 0 | — |

Every non-`split` verdict is a real path back to today's union struct, and all
of them are exercised (three by acorn, `too-many-shapes` by the unit test).

### 4. Ground-truth soundness check — 0 of 32,468 nodes overflow

The projection above assumes each label's planned set covers every property an
instance from that site actually ends up with. The analysis is a may-flow
over-approximation of where an object *goes*, so it can be too WIDE (a wasted
slot) but it can also MISS flow, and a missed flow is a property with no inline
slot. That residual rate is what decides whether the saving survives — it is
the exact analogue of the 36.6 % tail rate that halved #4211's win, and #4211
did not have this check.

Method (`.tmp/validate-plan.mjs` idiom): patch native acorn's
`startNode`/`startNodeAt`/`copyNode` to tag every node with its allocating call
site, parse the same 226 KB corpus, walk the resulting AST and compare each
node's OWN properties against its label's planned set.

- **32,468 tagged nodes walked — exactly the census's allocation count, so no
  allocation escaped the walk.**
- **0 nodes (0.00 %) carry a property outside their label's planned set.** No
  residual carrier would be allocated on this corpus.
- Slot occupancy 64,008 / 340,713 = **18.8 %** — the plan is ~5× wider than
  strictly necessary. That is the over-approximation, in the safe direction,
  and it is the headroom a more precise analysis would recover: a perfect
  analysis (≈2.0 populated slots/node) projects ≈64 B/instance instead of 98.

This also validates the retype claim empirically: the corpus produces real
ObjectPattern / ArrayPattern / RestElement / AssignmentPattern nodes via the
four in-place `toAssignable` conversions, and none of them has a property
outside its allocation label's set.

**Why this check is not the vacuous kind.** Slice C nearly shipped an
enumeration-based differential that passed by comparing `undefined` to
`undefined`, and warns that on this receiver class *any* enumeration-based
check passes for free. This one is a different instrument and carries its own
non-vacuity witnesses: it runs against **native acorn in Node**, not in wasm, so
`Object.keys` is the language's; the denominator is non-trivial (32,468 nodes,
matching the census exactly); and the occupancy numerator is non-trivial
(64,008 populated slots). A degenerate plan would fail loudly rather than
silently — empty planned sets would make *every* property overflow, i.e. ~100 %
rather than 0 %.

**What this check does NOT cover, stated plainly: `copyNode` never fires on
this corpus** (0 of the 25 executing sites). It is
`for (var prop in node) { newNode[prop] = node[prop] }` — enumeration plus a
COMPUTED write. The emission slice must route it through the residual carrier
and must validate on a corpus that triggers it.

⚠ **Correction (2026-08-07, after slice C): do not build on the recorded
`copyNode` story.** An earlier draft of this section, and the 2026-08-07
hot/cold slice's §3 above, attribute the pre-wiring K=52 divergence to
`copyNode`. Slice C measured, in-wasm on this same self-parse, that **`for…in`
over a standalone closed fnctor struct enumerates ZERO own properties** (keys on
15 of 32,506 walked objects, none of them AST nodes; the reference
implementation yields keys on all 32,487). It is identical with the split
disabled, so it is pre-existing and belongs to neither slice. A routine that
enumerates nothing cannot copy anything — and this slice independently measured
`copyNode` executing zero times. Two independent lines of evidence against the
named cause. Wiring the three reflective passes *did* resolve the divergence, so
something in it mattered; **the mechanism is unknown.** Anything derived from
"copyNode did it" — including the risk ordering in §6 — is derived from an
unsupported story and should be re-derived.

**The enumeration matrix, SETTLED — the discriminator is the RECEIVER'S STATIC
TYPE, not the operation** (`.tmp/enum-settle.mjs`, `--target standalone`,
`optimize: 0`, no host imports; want = keys 3, in 1, for…in 3, hasOwn 1):

| receiver | `Object.keys` | `in` | `for…in` | `hasOwnProperty` |
| --- | ---: | ---: | ---: | ---: |
| `const o = new C()` (statically typed) | 3 ✓ | 1 ✓ | 3 ✓ | 1 ✓ |
| `const o: any = new C()` | **0 ✗** | **0 ✗** | **0 ✗** | 1 ✓ |
| laundered through `id(x): any` | **0 ✗** | **0 ✗** | **0 ✗** | 1 ✓ |

Identical for both class spellings (field initialisers and constructor
assignment), so the class shape is not a factor.

This **resolves a disagreement between the two lanes, in slice C's favour, and
the error was on this side.** An earlier draft of this section reported
`Object.keys(classInstance)` and `"a" in classInstance` *passing* and treated
slice C's failing column as unreproduced. The cause was a fixture confound
here: those two probes used a **statically typed** receiver (`var o = new C()`)
while the `for…in` probe laundered through `id(x)`. Slice C's fixture used
`const o: any = new C()` throughout — i.e. it measured the dynamic path
consistently, and this lane did not. Its grouping conclusion stands:

> `hasOwnProperty` reaches a working predicate on a receiver where `in`,
> `for…in` and `Object.keys` all answer nothing.

The cross product adds the axis that unifies both columns and is the actionable
statement for #3920: **every one of the four works on a statically-typed
closed-struct receiver; three of the four break the moment the receiver is
`any`.** So the defect lives on the DYNAMIC path, and `hasOwnProperty` is the
one dynamic operation that still reaches a correct answer — that asymmetry, not
"the presence read is broken", is where a fix should start.

**The mechanism under the axis, and why "make the broken three match the working
ones" is a trap.** Six dynamic helpers back these surfaces; three were given
closed-struct arms at finalize (`src/codegen/index.ts` :4450-4452) and three were
not, and the split is 3-for-3: `hasOwnProperty`, `Object.getOwnPropertyNames`
and computed `obj[k]` have arms; `Object.keys`, `for…in` and `in` do not. So the
dynamic path is not uniformly broken — half the helpers were taught closed
structs and half were not.

**But the working half is not a template to copy, because it is the same bug
already live.** Those arms enumerate `ctx.structFields`, which includes BUILTIN
carriers whose internal fields carry no `$`/`__` prefix. Sharing them with
`__object_keys` was implemented, measured and **reverted** (#4071). Verified
independently here (`.tmp/gopn-leak.mjs`, `--target standalone`, `optimize: 0`,
no host imports; "host" = the reference answer):

| probe | standalone | host | |
| --- | ---: | ---: | --- |
| `Object.getOwnPropertyNames(classInst as any).length` | 3 | 3 | ✓ the 4th working surface |
| `Object.getOwnPropertyNames(/ab/).length` | **7** | 1 | ✗ leaks 6 internal RegExp fields |
| `Object.getOwnPropertyNames(/ab/)[0][0]` | `'f'` | `'l'` | ✗ not even `lastIndex` first |
| `Object.getOwnPropertyNames(new Date(0)).length` | **1** | 0 | ✗ leaks — *not previously reported* |
| `Object.keys(new Date(0)).length` | 0 | 0 | ✓ — **accidentally**, see below |

The last row is the point. `Object.keys` is correct on a builtin *precisely
because* it is broken on user classes: having no closed-struct arms, it
enumerates nothing, and nothing is the right answer for `Date`. Copying the
working arms onto it would fix the user-class case and simultaneously break the
builtin case — which is exactly what #4071 measured
(`Object.keys(new Date(0))` → `["timestamp"]`) and why it was reverted. **The
fix is "build the user-declared-vs-builtin predicate, then share", not "share
the arms".** A helper that reads as passing is where that gets missed.

**This is the strongest available corroboration of §6's name-list-source
constraint, and it upgrades it from a design preference to an observed failure
mode**: the surfaces that source their names from the receiver's struct field
list are leaking internals in production today. Per-type layouts would multiply
that field list per label, so the constraint tightens rather than relaxes.

Two further notes for whoever takes it:

- slice C separately eliminated 24 configurations (structural canonicalization
  of an identically-shaped sibling struct, `optimize` 0/3/unset, class-shape
  spelling, and — by swapping its three changed files for their `origin/main`
  blobs — its own branch), so none of those is the cause either;
- seen in passing and **not** an enumeration bug: laundering a
  field-initialiser class through `id(x): any` and calling `hasOwnProperty`
  fails the COMPILE with `IR-FALLBACK … arg 0 of call to id is class<C>,
  expected dynamic`. Distinct signature, IR admission rather than reflection;
  the constructor-assignment spelling of the same program compiles and answers
  correctly.

### 5. Retyping needs no special case, and here is the argument

`toAssignable` mutates in place through a reference the code cannot replace
(`toAssignableList` does `var elt = exprList[i]; this.toAssignable(elt, …)` and
never writes back), so copy-on-retype is unavailable and the layout must be
chosen at allocation. The analysis is **flow-INSENSITIVE**: a label's field set
is the union of every write reachable from it, whenever it happens. A retype is
just more writes to the same object, so it cannot introduce a name outside the
set. The analysis therefore needs no retype-specific rule; what it does is
**report** the retypes so the property is auditable rather than assumed
(`retypeSites` / `mergedByRetype`).

On acorn it finds 9 retype sites, including exactly the four the design hinged
on — dist :2109 / :2136 / :2142 / :2150 — each writing only `type`, a
constructor-assigned base field. So the 32-label merge they force costs **zero**
widening. Consistent with the pre-existing table (all four conversions ≤1 slot
apart), and confirmed by §4's zero overflow.

**Be honest about the payoff of the proving component: on acorn it buys
approximately nothing.** Its value is soundness in general. The win is in the
per-type layouts themselves.

### 6. Where the emission has to be careful — the design, with the keystone resolved

The blocker every previous pass hit is: `startNode` is ONE function containing
ONE `struct.new`, so per-label layouts need per-label allocation, and
`this.startNode()` lowers to a trampoline (`__dc_<F>_<m>_<n>`, #3683 S3) keyed
by (class, method, arity) — **not** by call site. The three candidate
mechanisms, priced:

1. **Clone the factory per layout** and route calls — needs per-call-site
   trampoline reservation on top of #3683's twin machinery. Most invasive.
2. **Inline the transparent factory at the call site** — needs the callee's
   `new` arguments compiled in the caller's frame with parameter substitution.
   Independently worth ~32 k calls/parse, but couples to `this`-lowering.
3. **A layout-hint module global (recommended).** Emit
   `<args>; i32.const <layoutId>; global.set $__fnctor_layout_hint; call` at a
   qualifying call site; `__fnctor_<F>_new` branches on the hint and
   `struct.new`s the corresponding subtype. No cloning, no trampoline change,
   no inlining. It is safe **because the factory is allocation-transparent**:
   between the `global.set` and the `struct.new` only the factory body runs,
   and that body cannot allocate another instance of the same fnctor.
   **The fail direction is the safe one**: hint `0` = the widest layout, and
   the ctor resets the hint to `0` after reading it, so a lost or stale hint
   degrades to today's union struct — fat, never narrow.

Structure the layouts as **declared WasmGC subtypes of the existing
`$__fnctor_<Name>`** (`superTypeIdx`, already used for class inheritance; give
the base `superTypeIdx: -1` so it emits as a non-final `(sub (struct …))`):

```
base   = [ctor-assigned fields][internal identity][presence words sized for
          the FULL union][$resid]
layout = base ++ [that label's flow-grown fields]
```

Three properties fall out, and each removes a class of #4211's risk:

- `ref.test $__fnctor_Node` still matches every layout, so every existing
  consumer of base fields is untouched;
- **presence bits live in the BASE at fixed indices**, so `hasOwnProperty`,
  `in`, `Object.keys`, for-in and the delete/tombstone path *can* stay
  layout-INDEPENDENT — only the value's storage location varies. **Read this as
  a CONSTRAINT on the enumeration fix (#3920), not as a property already held.**
  `for…in` over these structs yields zero own properties today (§4's
  correction), so the claim is untestable as things stand, and whatever repairs
  that bug decides whether it holds: an enumeration that derives its name list
  from the receiver's **struct field list** becomes layout-DEPENDENT and
  re-inherits #4211's per-carrier-arm problem, whereas one that derives it from
  the base presence words does not. Say which, in the fix. **§4 now shows the
  struct-field-list route is not merely layout-fragile but already leaking
  internals in production** (`getOwnPropertyNames(/ab/)` answers 7 where the
  host answers 1), so the constraint has a measured failure mode behind it and
  needs a user-declared-vs-builtin predicate either way;

  **And the constraint binds wider than this issue.** Independently replicated
  on this branch (§4's settled matrix): a **class** instance reaching the site
  as `any` answers 0 for `Object.keys` / `in` / `for…in`, exactly like a fnctor
  instance, while the same instance statically typed answers correctly on all
  four, and an object literal enumerates 3. So the boundary is not "fnctor" — it
  is **the dynamic path over any closed struct**, and the name-list-source rule
  above therefore applies to every closed-struct receiver kind, not only the
  ones per-type layouts touches. That matters here specifically because a
  per-type layout receiver is *usually* dynamic: the analysis publishes a
  single-label pin only where one label is provable, and every unpinned
  receiver takes exactly the path that is broken today;
- layouts are **siblings, not nested**, so arm order in the dispatchers cannot
  matter. (A prefix-CHAIN design was evaluated and rejected for this reason
  plus worse bytes: −60.9 % vs −67.3 %, because a label needing one
  late-ranked field must carry everything before it.)

Dispatcher cost, measured over the 20 live layouts: 24 property names need 1
arm, 16 need 2, 9 need 3, one needs 4, `body` needs 6 and `expressions` needs
11 (the one remaining blur). `type`/`end` are base fields ⇒ 1 arm. So the
arm-count blow-up that kills the naive per-shape version does not materialise.

**The chokepoint that will bite, named in advance — the consumer-side narrowing
VOTE, not the `ref.test` arms.** Slice C traced the §4 `generator` defect to
`finalizeStructAndDynamicMemberGet` (the #1269 Phase-3 narrowing in
`property-access-dispatch.ts`, around the `fieldKinds` set): to decide whether an
`any`-receiver read can drop its boxing, it asks whether *every candidate struct*
carries the field with the same scalar kind — and its candidate set is
`findAlternateStructsForField`, which hides `$…__cold`. Hiding a carrier from
that **vote** is wrong even though hiding it from the `ref.test` **arms** is
right; the vote narrowed to `i32` and pushed a correct boxed value through
`__unbox_number`.

Per-type layouts hit the same seam twice over, and worse:

1. the residual `$resid` carrier must be hidden from the arms (it is a private
   payload, never a receiver) but MUST be visible to the vote — the identical
   bug;
2. the vote's candidate set grows from 1 struct to N layouts, so a field whose
   inferred scalar kind differs across layouts now makes the vote *unanimous by
   accident* only when it happens to agree. A layout that simply lacks the field
   must not be read as "agrees".

Treat "which set answers the narrowing vote" as a distinct question from "which
set gets a `ref.test` arm" at every consumer, and enumerate both before writing
any emission code.

### 7. Honest translation to wall clock, and why it is an extrapolation

#4211 measured the mechanism: **−21.6 % of allocated struct bytes ⇒ −3.92 pp of
the 15.71 % gc-engine bucket** (−25 % of the bucket itself), every other bucket
diluting proportionally upward — the signature of a single absolute reduction.
Slice C then measured a second point on the same axis — −28.3 % of struct bytes
for **−4.51 pp** of the gc-engine bucket in an order-reversed ON/OFF/OFF/ON
block — consistent with #4211's slope. Two caveats it supplied about its own
number, which matter to anyone leaning on the pair:

- the ON-side scatter is **3.15 pp** against an OFF-side replication of 0.35 pp,
  so −4.51 pp is a **bracket of roughly −3 to −6 pp**, not a point;
- its absolute bucket shares are **not** comparable with #4211's table (no
  closure name map attached, so `scanner` folds into `compiled`). Only the
  **delta** is cross-session sound.

This plan's **marginal** figure over slice C's new default is −30.7 % of
allocated struct bytes, i.e. roughly one more step of the size both measured
points already cover, projecting to about **−4 to −5 pp of wall on top of slice
C** — and given the endpoint bracket above, **−3 to −7 pp** is the honest range.
(Against the pre-split union baseline the combined figure is −50.3 % of struct
bytes; the earlier draft of this section quoted the combined number as if it
were marginal, which overstated what this slice adds.)

**That is still an extrapolation, not a measurement**, and this box cannot
resolve anything under ~10 % by wall A/B
(§6 of the 2026-08-06 slice — an uncontrolled block there read +29 % and was
pure load contamination). Treat −9 % as an upper-ish estimate whose mechanism
is sound and whose magnitude is unverified. What IS measured here: the bytes
(deterministic census model, 100 % of runtime allocations attributed to a plan
label) and the 0 % overflow rate.

### 8. What is NOT done

1. **The emission.** §6 is a design with the keystone resolved, not code.
2. **The whole enumeration surface is unvalidated, by anyone.** `copyNode` is
   unexercised on this corpus (§4), and slice C's in-wasm enumeration
   differential is vacuous today because `for…in` over these structs yields
   nothing. So the risk §7 of the 2026-08-06 slice named as this design's
   principal one — a consumer silently reading `undefined` through a reflective
   path — is currently covered by **no** evidence in either lane. Repairing the
   pre-existing `for…in` bug is a **prerequisite** for the emission slice, not a
   parallel nicety: until enumeration works, no differential can distinguish a
   correct split from a broken one.

   **That bug is already filed as #3920** (`status: ready`, `priority: high`,
   `sprint: current`, unclaimed as of 2026-08-07) — whose Problem section
   already names the wider hole. It needs an OWNER, not a new file. Neither this
   lane nor slice C may allocate ids in this container, which is a second reason
   not to re-file it.
3. **No test262 / no host-lane work.** Flag-OFF is byte-identical and the
   analysis is standalone-oriented; the emission slice owns conformance.
4. **The 18.8 % slot occupancy is left on the table** (§4). A
   context-sensitive refinement (k=2, or a per-callee summary for the widest
   remaining blur — `parseStatement`'s 32-field label at :959, and the 11-arm
   `expressions`) projects ≈64 B/instance instead of 98.

### 9. Gates

typecheck 0, lint 0, format 0, oracle-ratchet 0 (`getTypeAtLocation +0`,
`ctx.checker +0` — the analysis uses only `getSymbolAtLocation` via a `checker`
parameter, which the ratchet deliberately does not count), loc-budget 0
(allowance for the ~12-line hook in `fnctor-escape-gate.ts` granted in this
file's frontmatter; the ~490-LOC analysis lives in the new module), func-budget
0 (the worker was split into `indexSourceFile` / `findTransparentFactories` /
`buildPlan` / `writeLayoutDiag` rather than granted an allowance).
`tests/issue-3927-fnctor-alloc-labels.test.ts` 8/8; the #2660/#2674/#3486/#4155
fnctor suites 46/47 — the one failure,
`issue-3486-fnctor-constructor-identity.test.ts > own fields and enumeration
are untouched`, reproduces on `origin/main` with this branch's
`fnctor-escape-gate.ts` swapped back to the base blob, so it is pre-existing.
Standalone acorn with the flag ON: 937,273 B — byte-identical to the flag-OFF
baseline — canaries 2/3/4/5, `functionImports []`, exactly the 3 pre-existing
IR-FALLBACKs.

**Interaction with slice C's flag change.** Slice C makes the hot/cold split
default-ON in standalone and moves the disable token to
`JS2WASM_FNCTOR_HOT_FIELDS=off` (a bare unset now means ON). Every byte-identity
assertion in this slice is **relative** — `JS2WASM_FNCTOR_LAYOUTS` set vs unset,
with the cold-tail state held equal on both sides — so none of them assumes
"unset ⇒ no split" and none needs the new token. The one figure that is
*absolute*, the 937,273 B, is a cold-tail-OFF measurement and will move when
slice C lands; it is quoted only as the two sides of an equality, not as a
tracked artifact size.

## Results — 2026-08-07 slice C: §4 closed, §2 ranking replaced, ships default **ON**

Both blockers closed. **The split is now ON by default in the standalone lane
at K=20**, and the measured saving is **larger** than the one the previous
slice deferred: **−28.3 % of every struct byte the acorn self-parse allocates**
(was −21.6 %), for a **tail rate of 28.1 %** (was 36.6 %).

| | OFF | old ranking, K=24 (#4211) | **new default: call-weighted, K=20** |
| --- | ---: | ---: | ---: |
| `__fnctor_Node` inline bytes | 292 B | 148 B | **132 B** |
| cold tails per parse | — | 11,895 × 160 B | **9,125 × 176 B** |
| **tail rate** | — | **36.64 %** | **28.10 %** |
| effective bytes / node | 292 B | 206.6 B | **181.5 B** |
| Node stream / parse | 9.48 MB | 6.71 MB (−29.2 %) | **5.89 MB (−37.9 %)** |
| ALL struct bytes / parse | 12.69 MB | 9.92 MB (−21.6 %) | **9.10 MB (−28.3 %)** |

All deterministic (`tests/dogfood/cold-tail-census.mjs`, checksum 422 in every
run). The OFF column reproduces #4211's baseline to the byte
(32,468 × 292 = 9,480,656 B), which is what validates the harness.

### 1. The `generator` defect: root-caused, and it was NOT the recorded suspect

§4's leading suspect was the typed numeric-read twin
`__get_member_<name>__f64`. **It is not.** That twin resolves its candidates
through `findAlternateStructsForField`, finds none for a cold field, and falls
through to `__get_member_<name>` + `__to_primitive` + `__unbox_number` — which
is exactly what an un-rewritten read site would emit. It declines correctly.

The actual culprit is one level up, in `compilePropertyAccess`'s **Phase-3
consumer-side specialization (#1269)** (`property-access-dispatch.ts`,
`finalizeStructAndDynamicMemberGet`). For an `any`-typed receiver it narrows
the read's result type to a scalar **when every struct candidate carries the
property with the same scalar wasm kind** — and its candidate set is
`findAlternateStructsForField`, which deliberately hides `$…__cold` tails.

So moving a field into a tail *removes a carrier from that vote*. In acorn,
`generator` lives on two fnctors: `Node` (flow-grown `externref`) and
`TokContext` (`this.generator = !!generator` ⇒ boolean-branded `i32`). With
`Node.generator` cold, the only visible carrier is the `i32`, the kind set
becomes a singleton, the narrowing fires — and the terminal
`__get_member_generator` call, **which does know the `$cold` hop and returns
the right boxed value**, is then dragged through `__unbox_number` +
`i32.trunc_sat_f64_s` + `__box_boolean`. A boxed `true` unboxes to NaN,
truncates to 0, re-boxes as `false`.

That is why it was exactly one field of 64: `generator` is the only ESTree
property name in acorn that is *also* a scalar slot on another constructor.
And it is why nothing structural ever diverged — the wrong answer was a
constant `false`, which acorn's own scope logic treats as "not a generator".

**Fix** (`property-access-dispatch.ts`): fold `findColdStructsForField` into
the candidate kind set before deciding to narrow. Cold slots are `externref`
by the split's own eligibility rule, so any cold carrier makes the set
non-singleton and the read stays boxed. Disabled builds are unaffected —
`findColdStructsForField` returns `[]` when nothing was split.

**Verification.** Per-field differential, all 64 ESTree names, both read paths:

| | before the fix | after |
| --- | --- | --- |
| K=8, computed reads | identical | identical |
| K=8, named reads | **`generator` diverged**, presence 354 → 32,506 | identical |
| K=0 (all 60 eligible fields cold), named | `generator` diverged | **identical** |

K=0 is the strong statement: with *every* cold-eligible field in the tail, all
64 per-field hashes, all 64 presence counts, the node count and `body.length`
match the unsplit build. The whole K range is clean, not just K ≥ 13.

**Two method notes, because both cost real time:**

- The defect is **invisible to a computed (`node[key]`) read** and uniform in a
  named (`node.generator`) one. A differential that exercises only the
  reflective path reports all-clear. The committed harness runs both.
- The #4211 probe was a `.tmp/` file and was gone. Rebuilding it consumed a
  large share of this slice, and the first rebuild was itself wrong — it
  accumulated per-field hashes into a module-level ARRAY and changed its
  answers when unrelated exports were added, i.e. the instrument was less
  reliable than the thing it measured. Both harnesses are now committed under
  `tests/dogfood/` with those traps documented in their headers.

### 2. The ranking: what a corpus-independent proxy can and cannot do

§2 said the static write-site ranking was "badly wrong for hotness". Confirmed,
with the mechanism. The diagnostic (`JS2WASM_FNCTOR_COLD_DIAG=1` now prints the
weights) at K=24 under the old ranking:

- the whole spread is **1..25 over 60 fields**, so the top-K cut lands *inside*
  a tie group and is settled by the **name** tie-break — `attributes` (5) hot,
  `specifiers` (5) cold, alphabetically;
- the fields it pushed out are `left` (4), `right` (4), `consequent` (4),
  `arguments` (3), `init` (3), `callee` (2), `object` (2), `optional` (2),
  `alternate` (2), `prefix` (2) — i.e. most of the expression grammar;
- the fields it kept in include `declaration` (7), `source` (7), `exported`
  (6), `label` (6), `attributes` (5) — import/export/label machinery that acorn
  touches at many syntactic sites and that appears on a handful of nodes.

**Replacement, and the claim it rests on.** Each access site is now weighted by
`1 + <static call sites of its enclosing routine>`
(`flowFieldHotnessWeights`). The claim is about programs, not about acorn: *a
property assigned inside a routine the rest of the program calls from many
places is assigned to many more objects at run time than one assigned inside a
routine called from one place.* Nothing about any measured input enters, so a
different program is ranked from its own call structure. It also spreads the
1..25 range by an order of magnitude, which is what stops the alphabet from
deciding the cut.

Measured, census, tail rate (and effective bytes/node):

| K | old: site count | **new: call-weighted** |
| ---: | ---: | ---: |
| 16 | 49.6 % (211.1 B) | 62.3 % (235.7 B) |
| **20** | 48.3 % (217.0 B) | **28.1 % (181.5 B)** |
| 24 | **36.6 % (206.6 B)** | 25.8 % (189.3 B) |
| 28 | — | 24.4 % (198.2 B) |
| 32 | 27.3 % (217.9 B) | 23.9 % (213.7 B) |
| 40 | 22.2 % (236.4 B) | — |

Two things this table settles:

1. **K must be chosen by measurement.** The curve is not smooth — the
   call-weighted ranking is *worse* at K=16 than the old one and much better at
   K=20, because a few high-weight fields enter together. Interpolating would
   have picked wrong. K=20 is the measured optimum; past it the tail rate keeps
   falling but 4 B × 32,468 nodes per extra inline slot stops being repaid.
2. **The old ranking's own optimum was K=24**, so the default moves from
   (site-count, 24) to (call-weighted, 20): 206.6 → 181.5 B/node, −12.2 %.

**The honest ceiling, and why "−49 % available" is not reachable statically.**
Ranking by *observed instance counts* from an acorn run gives a 2.7 % tail rate
at K=24 — but that is precisely the corpus dependence §7 rules out; it bakes
one program's node-kind mix into every other program's layout. Scoring several
corpus-independent proxies against that ground truth (write sites, read sites,
all accesses, distinct-writing-function count, transitive call-graph
reachability, and greedy packing of per-routine co-written field *groups*),
**none reached better than ~25 % tail rate**; call-weighting is the best of
them. The residual gap is not a missing heuristic: the quantity being predicted
is how often each node KIND occurs in the input, which is a property of the
corpus and not of the program being compiled. So ~−38 % on the node stream is
close to the static ceiling, and the remaining headroom needs a different
design (a real per-shape partition, #4074-style declared partitions), not a
better score function.

### 3. Flag decision: ships **default ON**, standalone lane, K=20

`JS2WASM_FNCTOR_HOT_FIELDS` now overrides the limit;
`JS2WASM_FNCTOR_HOT_FIELDS=off` disables the split and restores a
byte-identical binary. A malformed value falls back to the DEFAULT, never to a
bare `Number(raw)` (`Number("")` is `0`, which would move every eligible
field). Pinned by test.

**The standalone gate is now explicit.** Previously it rested on an argument
about a different pass ("flow-grown fields only happen in standalone"), true
but checked nowhere. Both the cold-type RESERVATION and the split itself go
through `coldTailHotFieldLimitFor(ctx)`, and a test asserts a JS-host build is
byte-identical for every flag value.

### 4. Profile bucket share — four blocks, ORDER-REVERSED

`scripts/profile-buckets.mjs`, 300 parses each, `standalone-dynamic`, run as
**ON → OFF → OFF → ON** so the sign cannot be an order artifact:

| block | order | gc-engine | dynamic-lookup | alloc-helpers | wall |
| --- | --- | ---: | ---: | ---: | ---: |
| onA | 1 (default ON) | **13.65 %** | 15.29 % | 1.26 % | 36,974 ms |
| offA | 2 (`off`) | **16.76 %** | 14.88 % | 1.67 % | 36,788 ms |
| offB | 3 (`off`) | **16.41 %** | 14.72 % | 1.57 % | 36,349 ms |
| onB | 4 (default ON) | **10.50 %** | 16.00 % | 1.30 % | 34,281 ms |

**Both ON samples sit below both OFF samples**, in an order-reversed sequence:
mean 12.08 % vs 16.59 %, **−4.51 pp — about a quarter of the bucket's own
share** — against a measured −28.3 % of allocated struct bytes. `alloc-helpers`
also drops (1.62 → 1.28 %, fewer `struct.new` operands) and every other bucket
dilutes upward, which is the signature of a single absolute reduction.

Translating with the same arithmetic the previous slice used: GC self-time
≈ 27 % smaller × a 16.6 %-of-wall bucket ⇒ **≈ −4.5 % of wall**. That is
larger than the −3.9 % the K=24/site-count variant estimated, in the ratio the
byte numbers predict.

**Two caveats on this table.** (a) The OFF blocks replicate tightly (16.76 /
16.41, 0.35 pp apart) while the ON blocks scatter (13.65 / 10.50, 3.15 pp) —
the effect's SIGN is solid, its magnitude is bracketed at roughly −3 to −6 pp.
(b) The absolute shares are **not** comparable to the previous slice's table:
this run did not attach the closure name map, so `scanner` is folded into
`compiled` and every other share is inflated accordingly. Only the
within-session OFF-vs-ON comparison is meaningful.

Wall was 35,628 ms (ON) vs 36,569 ms (OFF), −2.6 % — **below this box's
resolvability (§6) and quoted only for consistency of sign. It is not
evidence.**

### 5. What is still NOT measured

- **Wall clock, properly.** Unchanged position from §6 of the 2026-08-06 slice:
  this box cannot resolve anything under ~10 %, and an uncontrolled A/B here
  once read a 3/3-consistent +29 % that was pure ambient-load contamination.
  The byte→bucket translation is the estimate; it is not a timing claim.
- **test262.** The merge-queue re-validation covers it. Note this is the first
  slice where that matters — the flag is ON, so the standalone lane's emitted
  code genuinely changes.
- **Non-acorn standalone programs.** The ranking is corpus-independent by
  construction and the differential is corpus-independent in method, but K=20
  was tuned against one program's field population. A second dogfood package
  with a widened fnctor would be the natural next check.

- **The ENUMERATION arms — and the reason is worse than "untested".** A third
  differential mode was added (`PROBE_READ=reflect`: reach the value only
  through `for…in` + `hasOwnProperty`) and it reports **identical** for
  disabled-vs-default across all 64 names. **That result is VACUOUS and must
  not be read as coverage.** Measured directly: `for…in` over a standalone
  closed fnctor struct enumerates **zero** own properties — keys came back on
  only **15 of 32,506** walked objects, and those 15 are the plain RegExp-ish
  objects, not AST nodes. The reference implementation yields keys on all
  32,487. So the mode compared `undefined` against `undefined`.

  The harness now always reports `enumeratingNodes` and prints a loud VACUOUS
  warning when it is near zero, so the next reader cannot mistake this for a
  pass. The gap is **pre-existing and independent of the split** (identical
  with it disabled), but it means the reflective surface §7 named as the
  design's main risk is, on this corpus, **not exercised by anything** — not by
  this differential, not by the dogfood canaries.

  **This already has an issue — it is #3920, and it is wider than stated here.**
  Do not file a new one. Scoped afterwards with small standalone programs: a
  **class** instance and a shape-inferred object literal enumerate 0 exactly
  like a fnctor instance once the receiver reaches the consumer as `externref`;
  a statically-typed receiver at the loop is fine. Replicated in all three
  lanes.

  **SETTLED** (a third lane found the seam in the source; an earlier revision of
  this note recorded the grouping as contested — that is stale, ignore it). The
  axis is receiver **spelling**, not fixture shape: a receiver whose type is
  statically known at the point of use never enters the dynamic runtime, so it
  passes on every surface. Measuring that row and generalising from it is what
  produced the disagreement — which is also why nothing on this side moved the
  result across 24 configurations (prelude / optimize level / class-shape
  spelling / **branch**, the last ruling out this slice's default-ON split by
  re-running on `origin/main`'s own source blobs). The variable was never on an
  axis this lane controlled.

  Six dynamic helpers back these surfaces; three got closed-struct arms at
  finalize and three never did, and that split matches the matrix 3-for-3:
  `hasOwnProperty`, `getOwnPropertyNames` and `obj[k]` have arms; `Object.keys`,
  `for…in` and `in` do not. `src/codegen/object-runtime.ts`
  (`fillClosedStructOwnPropertyNamesArms`, #4071) records why sharing them was
  implemented, measured and **reverted**: `ctx.structFields` includes builtin
  carriers whose internal fields carry no `$`/`__` prefix, so sharing made
  `Object.keys(new Date(0))` answer `["timestamp"]`. The missing piece is a
  user-declared-vs-builtin struct predicate that does not exist yet.

  **One caveat worth carrying, and it is bigger than the source comment says.**
  `getOwnPropertyNames` "works" only on the user-declared receivers in the
  matrix — it is *already* wrong on builtins. Verified independently in two
  lanes (`--target standalone`, `optimize: 0`, zero host imports):

  | probe | standalone | host |
  | --- | ---: | ---: |
  | `gOPN(classInstance).length` | 3 | 3 ✓ |
  | `gOPN(/ab/).length` | **7** | 1 ✗ |
  | `gOPN(/ab/)[0]` | starts `'f'` | starts `'l'` ✗ |
  | **`gOPN(new Date(0)).length`** | **1** (a `t…` name) | **0** ✗ |
  | `Object.keys(new Date(0)).length` | 0 | 0 ✓ |
  | `Object.keys(/ab/).length` | 0 | 0 ✓ |

  The **Date** row is not in the source comment, which records only RegExp for
  `gOPN` and mentions Date only as what *would* break if `Object.keys` shared
  the arms. It leaks today.

  **The structural point, which is the version that survives skim-reading the
  3-for-3 table** (per-type-layouts lane's framing, confirmed here):
  `Object.keys` is correct on a builtin **precisely because** it is broken on
  user classes — it has no arms, so it enumerates nothing, and nothing is the
  right answer for `Date`. Sharing the arms fixes the user-class case and
  breaks the builtin case *in the same move*. So #4071's revert was not a
  tuning failure, and "build the user-declared-vs-builtin predicate, **then**
  share" is the only ordering that works. Anyone who reads the split as "copy
  the working three onto the failing three" ships the Date/RegExp leak.

  **It also contradicts a record in the 2026-08-06 slice.** That slice
  attributes the pre-wiring K=52 divergence to acorn's `copyNode`
  (`for (var prop in node) { newNode[prop] = node[prop] }`). `copyNode` cannot
  copy anything if `for…in` yields nothing — and the per-type-layouts slice
  separately measured `copyNode` executing **zero times** on this corpus. Two
  independent lines of evidence against that attribution. The fix (wiring the
  three reflective passes) demonstrably resolved the divergence, so something
  in it mattered; the named mechanism is unsupported. **Do not build on it** —
  re-derive it if it matters, and get a corpus that actually triggers
  enumeration before trusting any result about these arms.

### 6. Gates

typecheck 0, lint 0, format 0, oracle-ratchet 0 (3 changed codegen files),
loc-budget / func-budget allowed by this file's frontmatter (the Phase-3 veto
has to sit where the narrowing decision is made).

Suites, all with the flag at its new default:

- `tests/issue-3927-fnctor-cold-tail.test.ts` 6/6, now including the
  standalone-only gate and the `off` escape hatch;
- targeted object / struct / shape equivalence **107/107** across 20 files
  (`object-keys`, `object-create`, `object-define-property*`,
  `shape-inference`, `struct-*`, `self-referencing-struct`,
  `issue-799-prototype-chain`, `issue-4123-param-receiver-proto-method`,
  `wrapper-constructors`, class/private-member files);
- fnctor suites (#2586/#2660/#2674/#3486/#3927/#4155) **118/123**. The 5
  failures — 4 in `issue-2608-new-this-fnctor-static.test.ts`, 1 in
  `issue-3486-fnctor-constructor-identity.test.ts` — **reproduce identically
  with `JS2WASM_FNCTOR_HOT_FIELDS=off` AND with this branch's three changed
  source files replaced by their `origin/main` blobs**, so they are
  pre-existing on the merge base, not caused by the default flip;
- reflective surface (for-in / hasOwnProperty / own-property) 30/33; the 3
  failures in `issue-3420-standalone-array-own-property.test.ts` are the
  container's missing prebuilt runtime-eval refusal provider
  (`[test262-in-process] runtime-eval tier: NONE`) and reproduce with the
  split disabled.

**Baselining method, since it is the rule that this slice leaned on hardest:**
every failure above was re-run under `off` before being attributed, and the
fnctor ones were additionally re-run against `origin/main`'s own sources via
file copies (never `git stash` — it is one shared stack across every worktree).

## Results — 2026-08-08 slice: the EMISSION, built and validated (ships flag-OFF)

**What landed**: `src/codegen/fnctor-layout-emit.ts` (+ wiring) behind
`JS2WASM_FNCTOR_LAYOUT_EMIT` (boolean; unset/`""`/`"0"` ⇒ OFF ⇒
byte-identical, pinned by `tests/issue-3927-fnctor-layout-emit.test.ts`).
This is the second scope item — codegen now CONSUMES the validated per-type
plan. Standalone-only by its own gate (`fnctorLayoutEmitFor`); a JS-host build
is byte-identical for every flag value (pinned).

### 1. The mechanism, in the §6 design with two deviations worth recording

As designed: layouts are **siblings** (`$__fnctor_<Name>__lay<k>`, declared
`sub final $base`; the base becomes a non-final root, the `$__vec_base`
idiom); `ref.test $__fnctor_<Name>` matches every layout so base-field
consumers are untouched; presence bits stay in the BASE words at fixed
indices for the FULL union; allocation is routed by the layout-hint module
global (mechanism 3), read-and-RESET in `__fnctor_<Name>_new`, hint 0 ⇒ the
full-union sibling (ordinal 0) — every failure direction degrades to
fat-never-narrow. The residual carrier `$__fnctor_<Name>__resid` hangs off a
base `$resid` slot, lazily allocated by `__resid_ensure_<Struct>` (the
`__cold_ensure` idiom), and holds every flow-grown union field so an
analysis MISS degrades to a tail allocation, never a dropped property.

The deviations:

1. **Dispatch is by STAMP, not by `ref.test` (the design's "siblings ⇒ arm
   order cannot matter" was WRONG as stated).** WasmGC canonicalizes
   structurally identical types, and sibling layouts with the same field-kind
   vector — acorn has many (`{left,right}` vs two other 2×externref layouts,
   etc.) — share ONE canonical heap type, so `ref.test $__lay2` matches
   `__lay3` instances and a bare arm reads another field's slot: the
   silent-wrong-answer class. Every instance therefore carries an immutable
   `$shape` i32 in the base (written at `struct.new`), globally unique per
   layout and CONTIGUOUS per family. Value arms guard on stamp EQUALITY;
   family-level arms (resid, presence, enumeration) guard on the stamp RANGE
   (`(s − lo) u< count`, 2 instructions) — which also defends the base arms
   against a whole-base canonical twin from ANOTHER split fnctor of identical
   shape, a case the cold tail never had to face. The unit fixture's
   `{alpha}`/`{beta}` layouts are deliberate canonical twins so this machinery
   is exercised, not just present.
2. **Layouts and the resid are `isSyntheticStructName`-hidden and get
   EXPLICIT arms** (the cold-tail idiom), rather than flowing through the
   generic `ctx.structFields` walks — a generic walk would emit exactly the
   unguarded `ref.test` arms deviation 1 forbids. Consumers wired:
   `fillMemberGetDispatch` / `fillMemberSetDispatch` (layout chains, then
   resid chains, after the cold chains, before the host fallback),
   `fillClosedStructExternGetArms` (computed reads; layout entries reuse the
   existing `shapeFieldIdx`/`shapeId` guard machinery, resid entries add a
   `shapeRange` guard), `fillClosedStructHasOwnArms` + the shared #3920
   enumeration entries (presence-ONLY base arms from the side table — one
   range-guarded arm answers for the whole family, layout-independently,
   which IS the §6 constraint discharged).

### 2. Vote-seam audit (the #4217 `generator` class) — every candidate-set consumer, disposition

`findAlternateStructsForField` hides layouts + resid (like `__cold`); all 8
consumers audited:

| consumer | disposition |
| --- | --- |
| `property-access-dispatch.ts:3773` Phase-3 narrowing VOTE | **layout + resid kinds ADDED to `fieldKinds`** — a family carrying the name anywhere de-narrows; "this layout lacks the field" can never read as agreement |
| `property-access-dispatch.ts:4026` `exactStructField` | safe — matches by exact `structTypeIdx` of a widened defineProperty struct; layouts can't match, base lacks flow-grown names |
| `member-get-dispatch.ts:410` fill candidates | layout/resid arm chains appended (stamp/range-guarded) |
| `member-get-dispatch.ts:843` typed f64 twin | declines correctly: flow-grown names have no scalar candidates ⇒ falls back to the generic dispatcher, which knows the hop |
| `member-set-dispatch.ts:156` fill candidates | layout/resid write chains appended; resid writes lazy-allocate via `__resid_ensure_*` |
| `member-set-dispatch.ts:341` vec-materializer scan | no-op — layout extras are `externref`, never vec-typed |
| `property-access.ts:1327/1814` inline alternates | layouts hidden ⇒ no unguarded inline arm; the chains' terminal (`__extern_get` / `__get_member_*`) carries the layout arms |
| enumeration/hasOwn/`in` (object-runtime) | presence-only base arms; never consult a layout field list |

The vote-seam unit pin: `voteSeam()` in the test fixture reproduces the
`generator` shape exactly (a flow-grown boxed `true` whose only VISIBLE
carrier of the same name is another constructor's scalar slot) and asserts
the boxed value survives — under the old vote it would have been dragged
through `__unbox_number` to a constant `false`.

**The §6 risk ordering, RE-DERIVED (the ⚠ correction requires it — the old
ordering leaned on the retracted `copyNode` story).** The old implicit
ordering was "the reflective passes are the principal risk, the dispatchers
secondary", derived from attributing the K=52 divergence to
`for (var prop in node)` — a routine since shown to execute zero times over
an enumeration that yielded nothing. Re-derived from what this slice
actually hit, in descending order of measured danger:

1. **Canonical-twin misdispatch** — §6's own "layouts are siblings, so arm
   order in the dispatchers cannot matter" is WRONG as stated: sibling
   layouts of identical field kinds share one canonical type, `ref.test`
   cannot separate them, and an unguarded arm silently reads another field's
   slot. This is a class §6 did not list at all, it applies to every value
   surface at once, and it is why dispatch is by stamp (deviation 1).
2. **The narrowing vote** (carried over from slice C, unchanged — the one
   part of the old ordering that was independently grounded).
3. **Family-level base arms under cross-family base twins** — the resid and
   presence arms' `ref.test $base` admits another split family's instances;
   range guards close it. Also unlisted in §6.
4. **The reflective passes** — DEMOTED from first place: with presence
   pinned in the base words they are layout-independent by construction, and
   post-#4219 they are actually exercisable (the differential's `reflect`
   mode is no longer vacuous), so this risk is now both structurally smaller
   and better measured than when it was ranked first on the unsupported
   story.

Delete/tombstones need no wiring: the #4098 tombstone registry is
name-keyed per instance, layout-independent by construction, and the
enumeration arms' tombstone screen is applied uniformly to the appended
entries. Computed WRITES (`n[k] = v`) on closed structs remain unrouted in
BOTH lanes (pre-existing #3537/#3920-residue class; measured: the unit
fixture's computed write is dropped identically flag-ON and flag-OFF) — a
resid write only happens through the named write dispatcher today.

### 3. Bytes, deterministic census (`JS2WASM_ALLOC_CENSUS=1`, optimize 0, checksum 422 every run)

Against the CURRENT default (hot/cold split ON at K=20 — slice C's baseline,
reproduced to the byte before measuring):

| | current default | + `JS2WASM_FNCTOR_LAYOUT_EMIT=1` | |
| --- | ---: | ---: | ---: |
| `Node` family bytes/parse | 5,891,776 (181.5 B/node eff.) | **3,051,188 (94.0 B/node)** | **−48.2 %** |
| ALL struct bytes/parse | 9,036,640 | **6,196,052** | **−31.4 %** |
| allocations/parse | 242,423 | 233,298 | −9,125 (= the cold tails, gone) |
| `__fnctor_Node__resid` allocated | — | **0** | the analysis's 0 % overflow, confirmed at runtime |
| Node instances attributed | 32,468 | 32,468 (Σ over 41 layout counters) | none escaped |

The plan projected 98.0 B/instance and a −30.7 % marginal; the emission
lands at **94.0 B** and **−31.4 %** (some plan-layout fields are not
flow-grown-eligible, so a few layouts are narrower than planned). 41 layouts
(union + 40), 59 hinted labels, stamps 1..41. Vs the pre-split union struct
(292 B, 12.69 MB) the combined figure is −67.8 % on the node stream.

Size: standalone dogfood acorn binary 961,576 → 1,007,131 B (**+4.7 %**,
41 sibling type definitions + stamp-guarded arms; both measured with the
same harness on this branch). Reported as size, not speed.

### 4. Correctness on acorn — all three read paths, non-vacuously

`tests/dogfood/cold-tail-differential.mjs` (committed harness), current
default vs flag-ON, 64 per-field rolling hashes + presence counts, 32,506
walked objects, body 422, all three `PROBE_READ` modes:

| mode | hash diverged | presence diverged |
| --- | --- | --- |
| `named` (`__get_member_*` + twins) | 0 of 64 | none |
| `computed` (`__extern_get`) | 0 of 64 | none |
| `reflect` (`for…in` + `hasOwnProperty`) | 0 of 64 | none |

**The `reflect` row is no longer the vacuous pass recorded in slice C** — 
post-#4219 enumeration is live and the harness's own denominator shows
**32,502 of 32,506 objects enumerating ≥1 key in BOTH lanes** (the
positive-control requirement; no `VACUOUS` warning fired). What it still
does not cover: acorn's `copyNode` executes 0 times on this corpus (§4 of
the analysis slice), so enumeration+computed-WRITE composition is validated
only by the unit fixture's resid round-trip, not at acorn scale.

Dogfood canaries **2/3/4/5** with the flag ON, `functionImports: []`,
exactly the 3 pre-existing IR-FALLBACKs (typeIdx parity on
parse/parseExpressionAt/tokenizer). The resid path itself is exercised by
the unit fixture (a property-round-trip flow the may-flow analysis provably
cannot see lands the write in `$resid`, reads back, and answers
`hasOwnProperty`/`in` from the base presence bit), since acorn never needs
it.

### 5. Wall clock — order-reversed A/B (recorded with its load caveat)

One order-reversed block (ON → OFF → OFF → ON), `standalone-dynamic` lane,
same-process pairs, 1-min load recorded at each run's start; **other agent
lanes were active on the box throughout** (load 4.9–7.7 on 8 cores):

| run | wasm µs/op | node µs/op (same code every run) | load |
| --- | ---: | ---: | ---: |
| ON-1 | 105,337 | 25,678 | 5.9 |
| OFF-1 | 136,143 | 20,986 | 6.7 |
| OFF-2 | 187,740 | 37,190 | 4.9→spike |
| ON-2 | 95,537 | 15,608 | 7.7 |

Both ON samples sit below both OFF samples in an order-reversed sequence —
the sign is order-robust. **The magnitude is NOT usable**: the same-code
Node baseline swung 2.4× (15.6 → 37.2 ms) across the four runs, and the
apparent −22 %…−49 % wall delta is far outside what −31.4 % of struct bytes
can buy through the measured byte→GC-bucket coefficient (≈ −4 to −5 pp).
Per the §6 measurement rule this block is quoted for sign-consistency only;
the deterministic census above is the instrument, exactly as in the two
predecessor slices. (A quiet-box profile-bucket A/B is the right follow-up
when the box is idle; not run here.)

### 6. Flag decision: ships **default OFF**, and what gates default-ON

1. **#3920's second half is in flight** (the compile-time
   `structFieldNames.includes(key)` fold answering a constant YES for
   conditionally-assigned fields, branch `issue-3920-closed-struct-reflection`).
   Until it lands, hasOwnProperty/in-based validation on STATICALLY-typed
   receivers can be wrong in both directions on conditionally-assigned
   fields — which is most of what this split touches. The dynamic path (all
   differentials above) is post-#4219 and real, but a default-ON claim needs
   the full reflective surface re-validated after that fix, plus a probe
   corpus that actually triggers enumeration+computed-write (acorn's does
   not).
2. **No test262 run on the flag-ON build yet.** Flag-OFF is byte-identical,
   so the merge-queue gates cover this PR; a conformance run of the ON build
   is the default-ON slice's job.
2b. **The compile-time `in`/`hasOwnProperty` FOLD on struct-typed receivers
   is presence-blind to the split (flag-ON only, flagged 2026-08-08 while
   PR #4229 was in flight).** The static fold sources its name list from the
   BASE struct's field list; the split removes the flow-grown value slots
   from that list, so `"left" in typedNode` folds to a constant FALSE for a
   name the instance may carry (inline in its layout, or in resid). PR
   #4229 replaces only the folded-1 side with base-presence-word reads —
   which this emission's fixed-index constraint deliberately keeps working —
   but the folded-0 side keeps its constant, and under the split folded-0 is
   no longer sound. **The same class is not hypothetical: it is LIVE ON MAIN
   for the cold tail (default-ON at K=20), reproduced flag-free and filed as
   #4225** (`plan/issues/4225-static-in-hasown-fold-blind-to-cold-tail.md`
   — native 111 vs wasm 001; fix shape and acceptance criteria live there).
   The per-type-layout flavor is the same fix at the same two fold sites,
   consulting `fnctorLayoutOwnFieldsFor` alongside
   `findColdStructsForField`; it gates default-ON here and is tracked by
   #4225's cross-check criterion. Related: the `for…in`
   static unroll on struct-typed receivers enumerates nothing — #4219
   (`plan/issues/4219-forin-static-unroll-ignores-presence.md`, landed with
   PR #4229). That gap is receiver-spelling-specific and does NOT block
   this slice's validation (every differential here runs the dynamic path,
   non-vacuously), but a flag-ON conformance run will surface both.
3. The wall-clock claim is an extrapolation either way (§7 of the analysis
   slice): −31.4 % of struct bytes projects, via the two measured
   byte→GC-bucket points, to roughly −4 to −5 pp of wall on top of the
   current default — unresolvable by A/B on this box.
4. **Split-retirement decision input (run WITH the default-ON flip, not
   after it).** Once layouts are default-ON, run the allocation census
   grouped by PROOF VERDICT — `split` vs `single-site` / `not-separable` /
   `no-sites` / `too-many-shapes` — across the FULL npm-compat corpus, not
   only acorn. The struct bytes remaining in the bail-verdict families are
   the ENTIRE residual value of the #4211/#4217 hot/cold split: on a
   `split`-verdict fnctor the tail has nothing left to move (this slice
   measures the cold-tail stream at exactly 0 with layouts ON — the −9,125
   tail allocations line in §3), so the cold split earns its dispatcher
   surface only on what the analysis bails on. On acorn that residue is ~0
   (`Node` is the only widened fnctor and it splits), but acorn is one
   corpus and the stakeholder question — "does #4217 become redundant once
   layouts land?" — must be answered by that grouped census, not by
   extrapolating from the motivating package. If the bail-family byte share
   is negligible corpus-wide, retire the cold split (and its per-consumer
   arm surface) in a follow-up; if not, the two verdicts partition cleanly
   and both stay.

The switch is one line (default the flag ON in `fnctorLayoutEmitEnabled`)
once those close.

## Results — 2026-08-08: the default-ON flip (all §6 gates closed)

`JS2WASM_FNCTOR_LAYOUT_EMIT` now defaults **ON** (`0`/`off`/empty disable;
standalone lane only, by the flag's own `fnctorLayoutEmitFor` gate). How each
gate item closed, same-day:

1. **#3920's second half** — landed as PR #4229 (+ the #4225 folded-0
   follow-up, PR #4231, `closed-struct-presence.ts`/`findPresenceStorage`).
2. **Flag-ON conformance** — measured on CI with a same-instrument,
   same-branch dispatch PAIR (the committed-baseline diff proved config-
   contaminated: the flag-OFF control reproduced the flag-ON run's gate
   failures nearly line-for-line, so only artifact-vs-artifact counts):
   - ON run 31261617785 vs OFF control 31262874434, 48,619 rows each,
     proposals on, env witnessed in shard logs both ways.
   - **Standalone lane (flag active): pass 28,707 → 28,704 (net −3), 36
     flips, every one in the compile_timeout band, ZERO non-timeout flips,
     ZERO same-status error-category churn.**
   - GC lane (flag-inert = the instrument's noise floor): net +27, 284
     flips, likewise all timeout-band, zero semantic. The active lane sits
     well inside the inert lane's noise.
   - Scope caveat, stated plainly: test262 barely contains transparent-
     factory fnctors, so few files can take a split verdict — this measures
     "the flip does not regress test262", while the acorn-scale
     differentials (3 read modes + the copy mode, all bit-exact) remain the
     evidence the split itself is correct.
   - Prerequisite en route: computed-WRITE routing (#4194, PR #4232) — the
     copyNode composition went 0 → full copy, killing the last measured
     zero-effect.
3. **Item 2b (the static in/hasOwnProperty fold), layout flavor — found
   STILL OPEN by this flip's gate probe and fixed here.** #4231 closed the
   cold flavor only; under flag-ON the same struct-typed-receiver probe
   answered native 111 / flag-OFF 111 / **flag-ON 1** (value lands, both
   reflective folds constant-false). The `closed-struct-presence.ts` record
   that layouts were "already answered correctly" was the #3920
   receiver-spelling confound — its evidence was a DYNAMIC-receiver fixture,
   and the fold only fires struct-typed. Fix shipped with the flip (it is a
   flip prerequisite, not a nicety): `findPresenceStorage` resolves a split
   family's union names through the side table — the presence bit IS a base-
   word slot at fixed indices (the §6 constraint held for exactly this), so
   no third storage variant was needed — and `emitHasOwnPresence`'s folded-0
   escape now keys on LIST-BLINDNESS (`!structFieldNames.includes(key)`)
   rather than on cold storage specifically, keeping propertyIsEnumerable's
   semantic zeros folded. Pinned by `structTypedFold()` in the layout-emit
   test (third receiver-spelling-confound occurrence; the fixture comment
   says why the dynamic-receiver test can never catch it).

Also in the flip: the alloc-labels ANALYSIS gate is now standalone-aware
(`analyzeFnctorEscapeGate` takes the target) — with the emit flag defaulting
ON, the flag-only gate would have run the second whole-program fixpoint on
every HOST compile for zero benefit.

**The split-retirement decision input (§6 item 4) is now actionable**: with
layouts default-ON, the next full npm-compat census pass should group struct
bytes by proof verdict (`split` vs bail verdicts) corpus-wide — bail-family
bytes are the cold split's entire residual value (#4211/#4217; on acorn the
cold-tail stream measures exactly 0 with layouts on).

**Preliminary answer (2026-08-08, second-corpus static census — full table
in #4235's file): KEEP the split.** Acorn is the best case by a wide margin
(its `Node` union is 62 fields; every other measured package's proved
families are 5–17, and three.js's 33 families yield ZERO `split` verdicts).
Bail-verdict families dominate every package measured, so the split's
residual value is broad while the layouts' payoff is (so far) narrow. Two
caveats keep this preliminary: it is a static site-count census (no runtime
byte shares — only acorn compiles standalone of that set), and it measured
the single-file path only, because the multi-file path runs NO fnctor
analysis at all (#4235) — fixing that is the precondition for the real
corpus-wide, runtime-weighted verdict this gate item calls for.

### 7. Gates (emission slice)

typecheck 0, lint 0, format 0. loc-budget / func-budget: allowances for the
two new seams (`expressions/calls.ts`, `expressions/new-super.ts`) granted in
this file's frontmatter; the emission itself (~900 LOC incl. docs) is the new
`fnctor-layout-emit.ts`. Suites: `tests/issue-3927-fnctor-layout-emit.test.ts`
5/5 (OFF byte-identity across `unset`/`""`/`"0"`, ON differs — the
anti-vacuity pin; ON≡OFF on every surface incl. canonical-twin layouts;
absolute spec answers; resid round-trip; vote seam; host byte-identity);
`issue-3927-cold-tail` 6/6, `issue-3927-alloc-labels` 8/8, `issue-3927-pad`
3/3, `issue-2660` suite green; the one red is
`issue-3486 > own fields and enumeration are untouched` — the documented
pre-existing known-red on main (verified against base blobs in slice C).
