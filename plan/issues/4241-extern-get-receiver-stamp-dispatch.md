---
id: 4241
title: "perf: collapse __extern_get/__extern_set's receiver ref.test ladder into one stamp br_table — the dynamic-lookup residual after #3926's key dispatch"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
goal: performance
related: [4157, 3926, 3927, 4230]
loc-budget-allow:
  # (#4241 step 1) The `$bag` closure-header slot adds ONE `struct.new` operand
  # and ONE named-constant import to each of these god-files. The code cannot
  # move to a subsystem module: it is a header operand pushed inline at an
  # existing allocation site (async-scheduler's promise settle-cap, ir's closure
  # subtype resolver) and a field-index constant swapped for a bare literal
  # (object-runtime's builtin-fn meta arms). Net +13 lines across the three.
  - src/codegen/async-scheduler.ts
  - src/ir/integration.ts
  - src/codegen/object-runtime.ts
  # +1 line: the second `struct.new $__bound_fn` operand, at the `.bind`
  # allocation site. Found by Wasm validation ("need 4, got 3"), not by audit.
  - src/codegen/expressions/calls.ts
origin: "stakeholder-ordered 2026-08-08 — #4157 bucket 1's residual (the '< 3% __extern_get self-time' acceptance line is still open after #3926). RENUMBERED 2026-08-08: this issue was filed as #4237 and moved to #4241 because another session merged a DIFFERENT plan/issues/4237-*.md to main the same day (the `check:issue-ids:against-main` gate would have rejected the PR). Commits made before the renumber say #4237 in their subject; history stands. Two further collisions to keep straight, both harmless: PR #4237 (loopdive) is an unrelated merged PR, and PR #4241 is the fnctor-layout default-ON flip this issue's baseline measures against — issue ids and PR ids share one sequence, which is exactly why `git log --grep` is useless here (#3571 lesson)."
---

# #4241 — receiver identification by stamp, not by ref.test ladder

## Problem

#3926 collapsed `__extern_get`'s KEY dispatch (baked-hash + `br_table`,
+4.1 % standalone-dynamic, self-time 7.91 → 6.33 %) and left its residual
named: **receiver identification** — the linear `ref.test` arm ladder every
dynamic lookup walks before the key dispatch runs (measured then: 463
`ref.test` / 457 `ref.cast` in one ~14k-line function) — **plus the
per-lookup flatten**. The dynamic-lookup bucket was still 13.5 % of the
2026-08-07 profile; `__extern_get` self-time still ~5.9 %; #4157's
acceptance line "< 3 %" is open.

The #4241 default-ON flip changes the standalone receiver population by
construction (split families now dispatch by `$shape` stamp; sibling layout
types exist wherever a split fnctor does), so **every 08-07 number above is
stale — the first deliverable is a fresh profile + WAT census on
post-#4241 main, not inherited numbers.**

## Fix shape (the #4230 machinery, generalized)

#4230 already stamps split-family instances: an immutable `$shape` i32 at a
fixed base slot, globally unique per layout, CONTIGUOUS per family, tested
with 2 instructions (`(s − lo) u< count`). The receiver ladder collapses the
same way the key ladder did:

- stamp EVERY closed-struct receiver shape (fnctor bases/layouts, class
  instances, anon shapes — the candidates that today each cost a `ref.test`
  arm) with a shape id at a fixed slot;
- `__extern_get` / `__extern_set` (and the per-key `__get/set_member_*`
  fills, same ladder shape) dispatch the receiver with ONE guarded stamp
  load + `br_table` — the AOT analog of an inline cache's shape check;
- one fallback arm keeps the ladder (or a short rump of it) for UNSTAMPED
  receivers: host externrefs, builtins, vecs, `$Object`. What that arm costs
  and how receivers reach it cheaply (a single `ref.test $stampable-root`?)
  is the main design question — a stamp read needs a safe cast first, and
  the stamp slot must be at a COMMON field index across every stamped type
  (a shared supertype à la `$__vec_base`, or a fixed-position convention +
  canonicalization-safe guards like #4230's).

Design constraints carried from the family work:

- Canonicalized same-shape structs share one wasm type — a stamp read is
  only sound after a test that guarantees SOME stamped type, and the stamp
  value (not the type) selects the arm (#4230's rule).
- Stamps must stay globally unique and contiguity-partitioned so family
  RANGE guards (resid/presence arms) keep working; extend the existing
  `ctx.fnctorLayoutNextStamp` space rather than minting a second id space.
- The #4225/#3920 presence machinery reads base words through
  `findPresenceStorage` — untouched by receiver dispatch, but any change to
  stamp SLOT position must keep `$shape` findable by the existing
  `fields.findIndex((f) => f.name === "$shape")` consumers.

**Speculative second step, explicitly deferred until the br_table alone is
measured**: a per-call-site last-shape cache (site-keyed mutable global
caching stamp→arm). Adds mutable-global traffic; measure the br_table first
— it may be enough.

## Measurement discipline (unchanged)

- First step: fresh `scripts/profile-buckets.mjs` 300-parse profile +
  `wasm-dis` WAT census of `__extern_get` / `__get_member_*` arm counts on
  CURRENT main, flag-state = shipped defaults. Numbers land in this file
  before any code.
- Primary metrics: `__extern_get` self-time and the dynamic-lookup bucket
  share (profile shares are load-robust); allocation census unchanged
  (this is not an allocation lever); wall-clock sign as corroboration via
  paired A/B with order-reversal on `standalone-dynamic` only.
- Flag-gate if structural; default-ON needs the #4241 evidence bar (CI
  conformance pair or merge-group revalidation + acorn differentials).

## Lane boundary

Parallel #743 fixpoint lane owns `src/ir/propagate.ts` and the
provenance/census machinery — do not touch. This issue's surface is the
object-runtime dispatch fills and the stamp plumbing in
`fnctor-layout-emit.ts` / `struct-field-exports.ts` territory.

## Baseline — 2026-08-08, post-#4241 main (9a993e32e + flip fb7915197), MEASURED

All numbers standalone acorn self-parse unless said otherwise; census rows
are deterministic (checksum 422), profile is 300 parses / 11,632 samples
(box load ~3.4 at start — the quietest window this box has had).

### 1. The profile has changed shape since 08-07 — the ladder is no longer the headline

| bucket | 08-07 | NOW | |
| --- | ---: | ---: | --- |
| gc-engine | 23.1 % | **2.11 %** | the allocation program (#4211/#4217/#4230/#4241/#4208/#4221) landed |
| dynamic-lookup | 13.5 % | 12.04 % | `__extern_get` self 6.83 % |
| compiled | 32.1 (w/ scanner) | 36.31 % | **inflated: contains the new #1 frame, misbucketed** |

**Top frame overall: `__closure_bag_lookup` at 12.25 % self** — a 696-char
LEAF that linearly scans a global linked-list registry (`ref.eq` per node)
— bigger than `__extern_get` itself. It was in nobody's top-25 on 08-07.

### 2. Three instruments disagreed on WHO calls it; the census is the one that's right

- Profiler nearest-caller said `__extern_get` (12.04 of 12.25) — **wrong at
  the frame level**: the emitted `__extern_get` body contains ZERO calls to
  it (verified in WAT); wasm-opt inlined the true intermediate frames.
- WAT site census said `__extern_set` (325 call sites — the #4194
  untombstone arms) — **right about sites, wrong about traffic**: those
  sites execute ~0×/parse (writes are rare; the site count is not a
  frequency).
- **Call census (deterministic): 39,451 calls/parse — `__closure_prop_get`
  20,850 + `__instance_prop_get` 18,601, nothing else.** These are the
  dynamic READ-miss arms: a lookup that misses the struct/`$Object` arms
  consults the carrier/expando bag before answering undefined, and each
  consult is a full linear registry scan.

### 3. Receiver-ladder census (the original brief), for when its turn comes

`wasm-dis` on the optimize-4 standalone binary (1,851,442 B), per-function:

| helper | lines | ref.test | ref.cast | br_table | __str_equals |
| --- | ---: | ---: | ---: | ---: | ---: |
| `__extern_set` | 30,004 | **748** | 2,220 | 0 | 288 |
| `__extern_get` | 30,822 | **672** | 1,996 | **1** (#3926's key table) | 304 |
| `__extern_has` | 10,775 | 409 | 726 | 0 | 297 |
| 645 `__get/set_member_*` | ~40k | ~975 | ~2,260 | 0 | 0 |
| **aggregate (648 helpers)** | 111,894 | **2,804** | 7,202 | 1 | 889 |

The per-key member helpers average only ~1.5 ref.tests each (small candidate
sets); the big three carry the ladders. `__extern_set` grew past
`__extern_get` (#4194's write arms + #4241's layout arms — correctness
first, now a dispatch-shape cost to collapse).

### 3b. The reusable lesson: three instruments, three different answers, one right

Worth keeping beyond this issue, because each instrument failed for a
DIFFERENT structural reason and any one of them alone would have shipped a
wrong fix:

- **The profiler's nearest-caller attribution named `__extern_get`** (12.04
  of 12.25 %). Wrong at the frame level: the emitted `__extern_get` body
  contains zero calls to the leaf. `wasm-opt` had inlined the true
  intermediate frames (`__closure_prop_get` / `__instance_prop_get`) into
  their callers, so the profiler's stack collapses the middle and blames the
  survivor. Nearest-caller over an optimized binary attributes to the
  nearest NON-INLINED frame, not the nearest call site.
- **The WAT site census named `__extern_set`** (325 call sites — the #4194
  untombstone arms). Right about sites, wrong about traffic: those arms
  execute ~0×/parse. A static site count is not a frequency — the same trap
  as ranking cold fields by write-site count (#3927 §2).
- **The deterministic call census is the authority**: 39,451 calls/parse,
  20,850 via `__closure_prop_get` + 18,601 via `__instance_prop_get`,
  nothing else — the dynamic read-MISS arms consulting the expando bag
  before answering undefined.

Rule of thumb this yields: *attribute hot leaves with the call census;
use the profiler only to find the leaf, and the WAT census only to find the
mechanism.*

### 3c. The registry is not just linear — it is a cross-parse LEAK, so the scan is quadratic over a session

`__closure_bag_ensure` measures **75 calls/parse, all via
`__instance_prop_set`** (expando writes on closure/builtin-instance
carriers; plain fnctor expandos still drop — #4010/#4098). Each ensure
PREPENDS a registry entry keyed by the receiver, and nothing ever removes
one: the global list holds a strong ref to every carrier that ever grew a
bag, so (a) dead instances are GC-PINNED for the module's lifetime — a
genuine memory leak in any long-lived embedding — and (b) the 39,451
lookups/parse scan a list that GROWS ~75/parse, making the aggregate scan
cost QUADRATIC across a session. The 300-parse profile ends scanning a
~22K-entry list, which is how a 696-char leaf became 12.25 % of wall. The
carrier-intrinsic slot fixes all three at once: O(1) lookup, no global
strong refs (the bag dies with its instance), and a null-slot fast path —
one `struct.get` + `br_on_null` — makes the common carrier-has-no-expandos
consult ~free, in the same query-never-allocates spirit as the
`carrier-bag-hasown.ts` rule.

### 3d. Pre-registered measurement caveats for the A/B

- **The profile-share DENOMINATOR shrank across the #4241 flip** (gc-engine
  23.1 → 2.11 % ⇒ every surviving bucket's share inflated ~1.27× by
  arithmetic alone). Quote share deltas against THIS baseline only; never
  compare shares across the flip.
- The flip's committed CI measurement — the program's current standing
  number: **wasm 104.9 → 91.8 ms/op (−12.5 % wall), ratio 0.142 (7.0×) on
  CI hardware.**
- The bag-scan fix's wall payoff is SESSION-LENGTH-DEPENDENT (quadratic
  term): a 300-parse profile overstates what a single parse gains. Quote
  the call census (39,451 consults → expected ~39,451 null-slot fast-paths)
  and the profile share at fixed iteration count; note the leak fix
  separately as correctness/memory, not speed.

### 4. Consequence for this issue's plan — REORDERED by the measurement

1. **FIRST: kill the bag-lookup linearity (12.25 %, the largest single
   frame in the whole profile).** Two candidate shapes, in order of
   preference: (a) a carrier-INTRINSIC nullable `$bag` slot on closure
   structs and fnctor bases (lookup = one `struct.get`; the registry list
   stays only for carriers that cannot grow a slot), or (b) demote the
   consult — the read-miss path only needs the bag when the receiver ever
   HAD one; a per-carrier "has-bag" bit or a receiver-class screen before
   the scan. (a) subsumes (b). Must keep the `carrier-bag-hasown.ts` rule: a
   QUERY never allocates a bag.
2. THEN the receiver stamp `br_table` (the original brief, §Fix shape) — its
   payoff target is `__extern_get`'s 6.83 % self and the write helper's
   grown ladder.
3. The per-site last-shape cache stays speculative third.

## Implementation plan for step 1 (the `$bag` slot) — feasibility AUDITED, ready to build

The dangerous-looking part (a new field on the closure wrapper ROOT shifts
every capturing subtype's field indices) is in fact the ESTABLISHED idiom:
the closure layout is constant-driven — `CLOSURE_ARITY_FIELD_IDX = 1`,
`CLOSURE_CAPTURE_FIELD_BASE = 2` in
`src/codegen/closures/funcref-wrapper-types.ts`, whose own doc says *"every
capture read/write and TDZ-slot index derives from these constants, never a
bare literal"* — and the #3673 `$arity` field was itself inserted at index 1
exactly this way. So:

1. Add `CLOSURE_BAG_FIELD_IDX = 2` + a shared `closureBagField()`
   (`$bag`, externref, mutable) in funcref-wrapper-types.ts; bump
   `CLOSURE_CAPTURE_FIELD_BASE` 2 → 3. Add the field at every mint site that
   uses `closureArityField()` today (grep gives the exact list — closures.ts
   subtype mints + trampoline wrappers + this registry). Consumers of
   capture indices need NO edits by the constants rule; audit
   `fnctor-twin-captures.ts` (the third CLOSURE_CAPTURE_FIELD_BASE user)
   compiles clean.
2. Builtin instance carriers (`builtinInstanceCarrierTypeIdxs`): append
   `$bag` at each carrier's own mint site (they are independent final
   structs — no subtype shift risk; `$`-prefix keeps them
   reflection-hidden).
3. Swap the BODIES of `__closure_bag_lookup` / `__closure_bag_ensure`
   (closure-props.ts fill): per carrier root, `ref.test` →
   `struct.get $bag` (+ null fast path — the coordinator-requested
   `br_on_null` shape, which makes the 39,451 no-expando consults ~free);
   ensure does `struct.set` on first use. **Every consumer inherits the fix
   through the helper names** (instance-props, carrier-bag-{hasown,define,
   delete,visibility}, instance-tombstones, object-integrity-carrier) — no
   call-site edits.
4. The `$__bound_fn` + runtime-eval AOT carriers: either same-idiom fields
   at their mint sites or keep a RUMP registry for exactly those two; prefer
   the fields (kills the registry, the entry type, the head global, and the
   leak wholesale).
5. Semantic deltas to pin in tests: bag identity/lifetime becomes
   per-instance (the leak fix — dead carriers now collectable); integrity
   bags (`Object.freeze` on carriers) ride the same slot, so re-verify the
   frozen matrix; `carrier-bag-hasown.ts`'s query-never-allocates rule is
   naturally preserved (lookup never writes the slot).
6. Validation: the #4194/#4225/#3920/#3927 suites + frozen/tombstone
   probes; call census re-run (39,451 lookups should survive but each
   becomes ~3 instrs); profile share of `__closure_bag_lookup` (expect the
   frame to vanish — it will likely be INLINED once tiny, so measure the
   BUCKET, not the frame, per §3b's lesson); paired order-reversed A/B with
   §3d's caveats.

## Step 1 RESULT — 2026-08-08, MEASURED (the `$bag` slot, closure family)

Built and measured on this branch. Every number below is from a PAIRED run in
one session on one box: base = `2aad478b3` (this branch's docs-only tip),
slot = the same tree plus the `$bag` commit. Nothing is inherited.

### R1. Profile — paired, 300 parses each, same session

| | base | slot | |
| --- | ---: | ---: | --- |
| `__closure_bag_lookup` self | **12.98 %** | **0.22 %** | the #1 frame is gone |
| wall (300 parses) | 25,579 ms | 21,508 ms | **−15.9 %** |
| samples | 11,894 | 9,910 | −16.7 % |
| `compiled` bucket | 57.91 % | 49.81 % | the frame was misbucketed here |
| `dynamic-lookup` bucket | 12.06 % | 13.34 % | **share inflation, not a regression** |
| `__extern_get` self | 7.15 % | 7.24 % | flat — this change does not touch it |

The `dynamic-lookup` RISE is the §3d denominator caveat firing exactly as
pre-registered: removing ~13 % of total self-time inflates every surviving
bucket by ~1.16×. `__extern_get`'s own self-time is flat to within noise,
which is the correct reading — step 2 is what moves that number.

**The 300-parse wall figure OVERSTATES the single-parse gain**, also as
pre-registered: the removed cost had a quadratic term (a growing list scanned
per lookup), so a longer run gains more. Quote −15.9 % as "at 300 parses",
never as a per-parse number.

### R2. Deterministic call census — unchanged by construction, and that is the point

`JS2WASM_ALLOC_CENSUS_CALLS`, 5 parses, checksum 2110 both sides:

| caller → `__closure_bag_lookup` | base | slot |
| --- | ---: | ---: |
| `__closure_prop_get` | 20,850/parse | 20,850/parse |
| `__instance_prop_get` | 18,588/parse | 18,588/parse |
| `__carrier_bag_of` | 17/parse | 17/parse |
| **total** | **39,455/parse** | **39,455/parse** |
| `__closure_bag_ensure` (all via `__instance_prop_set`) | 75/parse | 75/parse |

The call COUNT is identical — the helper is still called 39,455×/parse. What
changed is what each call COSTS: a closure receiver now takes `ref.test` +
`ref.cast` + `struct.get` + `return` instead of walking the registry. This is
why the call census alone cannot show the win and the profile is the instrument
that can — the §3b lesson in reverse.

### R3. The leak — HALVED IN REACH, NOT CLOSED. The plan was wrong about where it lives

The plan (step 4) expected the slot to kill "the registry, the entry type, the
head global, and the leak wholesale". **It does not, and the census says why:
all 75 ensures/parse come from `__instance_prop_set` — i.e. from USER CLASS /
`__fnctor_*` / `__anon_*` instance carriers, which are NOT in the closure
family and did not get a slot.** So:

- Registry POPULATION is unchanged at 75 entries/parse (375 after 5 parses,
  never pruned). The leak is intact.
- Registry TRAFFIC is down 53 %: the 20,850 closure-side consults no longer
  scan it at all. That is where the 12.98 % went — closure carriers never had
  bags, so every one of those consults was a FULL-LENGTH miss, while the
  instance-side consults mostly hit near the head (entries are prepended, so
  the current parse's carriers are at the front). The expensive half was the
  closure half.

**What step 1b needs** (the honest carry-over): the instance-carrier slot is a
strictly bigger job than the closure one, because those structs are not a
single-root family. A class with `extends` is a WasmGC subtype
(`class-bodies.ts` sets `superTypeIdx`), so appending `$bag` to a base INSERTS
it in every subclass and shifts that subclass's own fields — the same shift
this slice absorbed for closures, but across user-declared shapes whose field
indices are baked into already-emitted bodies at finalize. The two viable
seams: (a) append `$bag` at struct REGISTRATION time, before any body is
emitted, so every name→index map picks it up naturally; or (b) reuse the
#2009/#4230 retro-stamp (`patchStructNewWithShapeId`), which only works for
final, subtype-free carriers. `fnctor-layout-emit.ts` is a ready-made precedent
for (a): it already appends `$shape` + `$resid` to the base and rebuilds the
layout subtypes as `[...base, ...moved]` in one place.

### R4. Semantics — pinned

- `tests/issue-4241-carrier-bag-slot.test.ts` (new, 15 cases): write/read
  round-trip, capture-shift pins (single and multi-capture), bag identity
  across aliases, distinct bags for distinct carriers, overwrite, the three
  reflective surfaces (`in` / `hasOwnProperty` / `Object.keys`) agreeing,
  the null-slot fast path, query-never-allocates, `.length` after the insert,
  the `bfnstate`/`bfnid` shift pin, bound-fn expando, `.call` dispatch.
- **Cold-tail differential, build-vs-build: BIT-IDENTICAL.** base vs slot agree
  on every one of 64 per-field rolling hashes and every presence count across
  32,506 AST nodes, in BOTH `computed` and `copy` read modes (exit 0 both).
- Cold-tail copy-vs-computed: 5 diverged fields (`type`/`start`/`end` presence
  32,487→32,506, `source` 5→1, `flags` 19→15) — **the same 5, with the same
  counts, on base and on slot**. No new residual.
- Equivalence gate: 8/8 shards, 0 regressions.
- `#3468` / `#4194` (both files) / `#4225` / `#3920` / `#3201` / `#4010` /
  `#3673` / `#2864` / `#4122` suites: 206 tests, all pass.
- Two pre-existing failures confirmed IDENTICAL on base (probed both builds,
  not assumed): `#2984`'s own `KNOWN GAP (pre-existing)` case, and — found
  while writing the new tests — `add.bind(null,1)` INVOCATION traps
  ("dereferencing a null pointer") and `g.apply(null,[…])` answers 0 on this
  lane. The bind/apply pair are unrelated standalone gaps; the new test file
  pins the halves that work and says so in comments rather than pinning a
  failure someone else owns.

### R5. Wall A/B — sign positive in both orderings, magnitude NOT claimable tonight

`--only acorn --perf-only --lane standalone-dynamic`, order-reversed pairs.
The box was heavily loaded by parallel lanes (native Node's own time swung
9.6→16.1 ms/op across runs, a 67 % spread), so absolute `wasmUs` is
uninterpretable; the load-robust `ratio` (node/wasm, higher is better):

| order | base ratio | slot ratio |
| --- | ---: | ---: |
| base → slot | 0.1468 | 0.1567 |
| slot → base | 0.1336 | 0.1789 |

Slot > base in BOTH orderings. Mean 0.1402 → 0.1678. **Report the sign, not
the +20 %** — with that much load noise the magnitude is not defensible, and
the paired profile in R1 is the controlled number.

### R6. Scope actually shipped

Slotted: the whole closure root-wrapper hierarchy (per-signature wrappers,
constructible wrappers, capturing subtypes, named-func-expr subtypes, IR
closure subtypes, method-trampoline singletons, builtin-fn meta subtypes, the
promise settle-cap) plus `$__bound_fn`.

Still on the registry, deliberately: user class / `__fnctor_` / `__anon_`
instance carriers (see R3), `__StandaloneRegExp`, `__Date`, and the
runtime-eval AOT callable carrier. The split is resolved by FIELD NAME at
fill time, so an unslotted root routes to the registry automatically rather
than being mis-read at a wrong index — adding a slot to any of them later is
a mint-site change with no edit to the helpers.

### R7. What the "loud failure" net actually caught

Inserting a field at index 2 makes a missed `struct.new` operand a hard Wasm
validation error, and that is how both misses were found rather than by
audit: `$__bound_fn`'s second allocation site in `calls.ts` ("need 4, got 3")
and the object-literal / member-dispatch method-closure singletons in
`member-get-dispatch.ts` + `method-trampolines.ts` ("need 3, got 2", surfaced
by the `equality-mixed-types` equivalence shard, 9 failures from one site).
Worth recording: the equivalence shards found a real defect the targeted
probes did not, because `{ valueOf() {…} }` is a closure-allocation shape the
issue-level tests never build.

## Acceptance criteria

- [x] Fresh baseline recorded here (profile buckets + receiver-arm WAT
      census, post-flip main).
- [x] **Step 1** — the bag-lookup linearity is killed for closure carriers:
      `__closure_bag_lookup` 12.98 % → 0.22 % self, paired, with the leak
      finding re-attributed to the instance-carrier side (R3).
- [ ] `__extern_get` receiver dispatch is a single stamp `br_table` for
      stamped receivers; unstamped receivers keep a correct fallback.
- [ ] `__extern_get` self-time and dynamic-lookup bucket share move, with
      the paired order-reversed A/B reported (or the null result recorded
      with the profile that explains it).
- [ ] No standalone or gc-lane conformance regression (merge-group gates).
- [ ] The #4157 "< 3 %" line either closes or its residual is re-attributed
      with data.
