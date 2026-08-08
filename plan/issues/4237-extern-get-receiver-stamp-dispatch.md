---
id: 4237
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
origin: "stakeholder-ordered 2026-08-08 — #4157 bucket 1's residual (the '< 3% __extern_get self-time' acceptance line is still open after #3926). NOTE: PR #4237 (loopdive) is an unrelated merged PR; the shared number sequence makes `git log --grep` useless here, as usual (#3571 lesson)."
---

# #4237 — receiver identification by stamp, not by ref.test ladder

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

## Acceptance criteria

- [ ] Fresh baseline recorded here (profile buckets + receiver-arm WAT
      census, post-#4241 main).
- [ ] `__extern_get` receiver dispatch is a single stamp `br_table` for
      stamped receivers; unstamped receivers keep a correct fallback.
- [ ] `__extern_get` self-time and dynamic-lookup bucket share move, with
      the paired order-reversed A/B reported (or the null result recorded
      with the profile that explains it).
- [ ] No standalone or gc-lane conformance regression (merge-group gates).
- [ ] The #4157 "< 3 %" line either closes or its residual is re-attributed
      with data.
