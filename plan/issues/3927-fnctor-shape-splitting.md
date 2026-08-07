---
id: 3927
title: "perf: a widened fnctor struct is the union of every shape its constructor ever takes — acorn's `Node` is 292 B for a 3-6 property object"
status: in-progress
assignee: "ttraenkler/opus-shape-split"
sprint: current
created: 2026-07-31
updated: 2026-08-07
loc-budget-allow:
  # The split's own code (≈500 LOC) lives in the NEW `fnctor-cold-tail.ts`.
  # These five are the unavoidable in-place seams: the three reflective
  # `fillClosedStruct*Arms` passes must gain their cold arms where they are
  # (object-runtime), the split hook must sit inside `deriveFnctorFields`
  # (that is the single source of truth for the field set), the two ctx maps
  # must be declared on the context type, index.ts gains one call, and
  # property-access.ts gains one `continue`.
  - src/codegen/object-runtime.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
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

### 5. What is NOT measured, and why

- **No wall-clock A/B.** §6 established this box cannot resolve anything under
  ~10 %, and the predicted effect is −3-4 %. A number would have been noise
  dressed as evidence; block A of §5 is the cautionary case.
- **No profile bucket share.** Worth running as the mechanism check (does the
  gc-engine bucket shrink by roughly the byte fraction?) but not run here.
  Recommended as the first measurement of the next slice, with §6's
  order-reversal control.
- **Standalone lane only.** The split is gated on `ctx.standalone` by
  construction (flow-grown fields are the host-free replacement for the host
  sidecar), so host mode is untouched.

### 6. Flag decision: ships **default OFF**

Three reasons, in order:

1. **A defect is open** (§4). Shipping ON with a known one-field divergence at
   part of the range is not defensible, even though the recommended setting is
   outside it.
2. **The payoff is not yet demonstrated in time**, only in bytes. −21.6 % of
   struct bytes is a large, deterministic, real number, but §6's coefficient
   translates it to ≈ −3-4 % wall — under this box's resolution. The
   evidence rule's "wash ships OFF" applies until a profile or a quieter box
   converts bytes into a measured bucket shift.
3. **The overflow rate says the design is not yet at its best point** (§2). A
   better ranking is cheap and would improve both the bytes and the risk (fewer
   fields cold ⇒ smaller reflective surface). Landing ON now would freeze the
   worse variant.

The mechanism, the measurement harness idiom, and the corrected arithmetic are
the deliverable; the switch is one line when §4 closes and §2's ranking lands.

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
