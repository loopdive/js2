---
id: 4638
title: "ES5 standalone: array element/descriptor substrate — defineProperty on array indexes & length, holes vs undefined, concat/filter/toString element semantics, arguments length descriptor (~56 rows)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-descriptors
goal: standalone-gap
related: [3251, 4479, 4622, 4620]
origin: "2026-08-23 wave-3 residual map (196 true failures, .tmp/sweep-204-all.jsonl). Lanes B (.tmp/lane-B-descriptor.txt) + Array leftovers (.tmp/lane-leftover.txt). The single biggest coherent block left."
---

# #4638 — array element/descriptor substrate

## Problem (measured 2026-08-23 on branch tree)

The #3251-class wall, now the largest remaining block (~56 rows):

- **B1 — `Object.defineProperty` on ARRAY receivers (~17)**: index
  descriptors (`Expected obj[1] to equal 3, actually 0` — a defined
  accessor/data index not served by reads), `length` interplay
  (`15.2.3.6-4-183`: defining an index must grow length per §10.4.2.1;
  writable:false length), 3 null-deref CRASHES (`15.2.3.6-3-123` family —
  crash class, FIRST), the `"a === 10, actually 0"` mapped-arguments
  signature (#3251 proper — decline with owner if representation-walled,
  but MEASURE first: the vec-bag-seed descriptor store from #4479 may now
  serve part).
- **B2 — `defineProperties`/`freeze`/`seal` on arrays (~9)**: same
  substrate through the batch paths; `freeze` must make indexes
  non-writable/non-configurable and reads still serve values
  (`15.2.3.9-2-a-11/12/14`); one illegal-cast CRASH
  (`15.2.3.7-6-a-113`).
- **B3 — gOPD residual (3)**: `Cannot access property on null or
  undefined at 258:18/259:18` (the #4619-F triage rows) + 1 null-deref.
- **B4 — arguments `length` descriptor (4)**: `10.6-6-2`/`10.6-7-1`
  configurable:true (needs #4622-R2's runtime discrimination — an
  args-vec brand or a syntactic gOPD arm mirroring #4622's delete arm),
  `10.6-13-a-1` (escaped `callee` typeof), `S10.6_A5_T4`
  (`arguments.length = <string>` write-through — i32 length wall,
  measure and decline honestly if so).
- **B5 — element HOLES vs undefined (~12, from the leftover list)**:
  `concat` treats a hole as 0 (`b[1] expected undefined, got 0`) and
  explicit `undefined` elements as NaN; `toString` renders
  `[undefined,1,null,3]` as ",1,0,3" not ",1,,3"; `toLocaleString` must
  CALL each element's toLocaleString (n++ counting rows); `filter`
  callbackfn descriptor rows (`15.4.4.20-9-b-*`: elements
  defined/deleted DURING iteration). The vec representation's
  hole/undefined discrimination — reuse the #4489 tag-1 undefined
  singleton where the vec stores anyref, or the sparse-tail machinery
  from #4434.
- **B6 — `Array.prototype.concat` as a VALUE (3)**: explicit refusal
  "not yet callable as a value" — same class #4619-D/E solved for
  wrapper protos; wire concat through the callable-value dispatch.
- **B7 — `Array.isArray(arguments)` false (1)**: needs the args-vec
  brand from B4 — same discrimination, two consumers.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   live; crashes (B1 null-derefs, B2 illegal cast) FIRST.
2. Read `vec-bag-seed.ts` (`buildVecDeletePrologue`, `__vec_gopd`),
   `arguments-object-mop.ts` (#4622's arm), and #4479's descriptor store
   — the substrate exists; the question per family is which read/write
   path doesn't consult it. Instrument one failing row per family with
   WAT decode before designing.
3. B4+B7 want ONE discriminator: give the arguments-object vec a brand
   (a distinct struct subtype or a sidecar bit) that `__vec_gopd`,
   `Array.isArray`, and #4622's delete arm can all ask. That converts
   #4622's syntactic declines into runtime answers — coordinate with its
   issue file's R2/R3 residual notes.
4. B5: decide the hole encoding once (tag-1 undefined singleton vs
   sparse-tail), then fix concat/toString/toLocaleString/filter against
   it. A/B every step — this touches hot paths; the #1888 floor and
   byte-identity on non-hole shapes are the guardrails.
5. B6: callable-value arm for concat mirroring #4619's mechanism.
6. Verify: scoped sweeps (defineProperty/defineProperties/freeze +
   Array/prototype/{concat,filter,toString,toLocaleString} + 
   arguments-object) before/after, own runs; equivalence array suites
   green; pins tests/issue-4638.test.ts; zero regressions. A corpus-style
   stratified sample (≥500 rows) is REQUIRED if you touch the vec
   read/write hot path (the #4489/#4519 precedent).
