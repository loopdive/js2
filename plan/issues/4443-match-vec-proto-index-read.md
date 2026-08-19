---
id: 4443
title: "__extern_get_idx answers undefined for a $__regexp_match_vec receiver in builtin-prototype-writing modules (R1 of #4439)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp-string-methods
goal: standalone-gap
related: [4439, 4160, 3673, 4434]
origin: "2026-08-15 wave 9 — #4439's R1 residual, pre-existing, with its repro and narrowing."
# The fix's LOGIC lives in `registry/types.ts` (`isVecBaseSubtype`, a query
# about vec types, next to `getOrRegisterVecBaseType` — not a god-file). What
# remains in `object-runtime.ts` is 3 lines of wiring plus a 12-line note at
# the call site recording WHY the name-based filter was wrong and what the
# mis-minted arm cost. That note is the load-bearing part: the defect is
# invisible without a proto-index store, so a future reader has no way to
# rediscover it from the code. +16 lines against a 9928 baseline.
loc-budget-allow:
  - src/codegen/object-runtime.ts
# Same 12-line note, counted again by the function gate: the call site is
# inside `fillExternArrayLikeStructArms`, which was ALREADY 310 lines before
# this change. Splitting a 310-line function is real work with a real
# regression surface and is not something an S-horizon bug fix should do
# opportunistically — flagged as a residual for the consolidation lane (#3399)
# rather than half-done here. +15.
func-budget-allow:
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
---

# #4443 — match-vec indexed read vs the builtin-prototype consult arm

## Problem & prior narrowing (READ #4439's issue file R1 FIRST)

Pre-existing, blocks the 3 remaining borrowed-match files
(`match/S15.5.4.10_A2_T17/T18`, `A1_T3`). Repro uses only the DIRECT path:

```js
Number.prototype.foo = 1;                    // any builtin-prototype write
var m = "10203040506070809000".match(/0./);
box.v = m; box.v[0]                          // → undefined; must be "02"
```

while `.length`, `.index`, and `m["0"]` are all correct, and a plain array
receiver is unaffected. #4439 narrowed it to a spliced arm AHEAD of the
base-vec arm in `__extern_get_idx` returning the Array-prototype consult
(`consultArray=1`) for the `$__regexp_match_vec` receiver.

## Implementation Plan

1. Reproduce with the one-define-per-module discipline (#4434's confound
   warning applies). Read the `__extern_get_idx` arm ordering
   (vec-overlay.ts / dyn-read.ts fills) and find why the match-vec receiver
   takes the proto-consult arm instead of its own indexed read.
2. Fix by ordering/gating the match-vec arm correctly; the match-vec struct
   is `$__regexp_match_vec` (native-regex.ts, REGEXP_MATCH_VEC_STRUCT) — a
   subtype of `$__vec_base`, so a base-vec-typed arm placed first should
   already serve it; find why it doesn't.
3. Verify: the repro; the 3 borrowed-match files; #4439's 18-test pin and
   the match/search collateral scope (119 files) with zero regressions;
   gc/host byte-identity.

## Acceptance criteria

- The repro reads "02"; ≥2 of the 3 blocked files flip; zero regressions in
  the #4439 collateral scope.

## Root cause

Not the vec-overlay fills and not an ordering accident — a **candidate-set**
defect in `fillExternArrayLikeStructArms` (`src/codegen/object-runtime.ts`).

That fill mints closed-struct array-like arms into `__extern_length` /
`__extern_get_idx` / `__extern_has_idx` for every struct in
`ctx.structFields` that carries a numeric-able `length` field, minus a
**name-based** skip list: `Wrapper*`, `$AnyValue`, `__vec_*`, `__arr_*`,
`__subview_*`, `$*`. Its own comment states the intent correctly — typed-array
view carriers "carry a `length` field but are NOT generic array-likes" — but
spells it as names.

`$__regexp_match_vec` is exactly such a carrier (a `$__vec_base` subtype whose
elements live in `data`), and its name matches none of the six patterns. So it
was admitted as a "closed struct". It declares `length`, `index`, `input`,
`groups`, `indices` — and **no canonical integer-named fields** — so
`numericFields` is empty and its `__extern_get_idx` arm degenerates to:

```
local.get 2 ; ref.test $__regexp_match_vec
if → <prototype-index consult> ; return
```

i.e. **every index is answered as a chain miss, unconditionally**.

Two conditions hide this in the ordinary module and expose it in the reported
one:

- **Why only under a builtin-prototype write.** The arm is guarded by
  `if (fieldChecks.length === 0 && protoGlobalIdx === undefined &&
  protoGetMiss() === undefined) continue;`. With no proto-index store
  `protoGetMiss()` is `undefined`, all three clauses hold, and the arm is
  never minted. Any builtin-prototype write creates the store, so
  `protoGetMiss()` is defined, the guard falls through, and the fieldless arm
  is emitted.
- **Why it wins over the real element read.** Both fills splice at body index
  3, and `fillExternArrayLikeStructArms` runs *after* `fillExternGetIdxVecArms`
  (index.ts finalize order) — so the later splice lands **ahead** of the vec
  element arms. Control returns before reaching `vec.data[i]`. This is the
  `[58]`-then-`[2, 4, 42]` ladder #4439 saw in the WAT.

Measured candidate set for the repro module (instrumented finalize, both
lanes): `__regexp_match_vec#126[n=0]` — the sole candidate, zero numeric
fields. In the clean module it is the same sole candidate and no arm is minted.

Consistent with every symptom in #4439's narrowing: `.length` is right (the
array-like `__extern_length` arm reads the real `length` field, and the
`$__vec_base` arm answers it once the candidate is dropped); `m["0"]` is right
(string keys route through `__extern_get`, a different helper, whose overlay
prologue is untouched); a plain array is right (`__vec_*` is name-excluded);
and the direct `m[0]` on a statically-typed match-vec is right (it lowers to
`array.get`, never consulting the helper at all).

## Fix

`isVecBaseSubtype(ctx, typeIdx)` — new, in `src/codegen/registry/types.ts`
next to `getOrRegisterVecBaseType`, a bounded walk over
`ctx.mod.types[].superTypeIdx` so a malformed or cyclic chain cannot hang
finalize. `fillExternArrayLikeStructArms` keeps the existing name filter and
adds the **structural** form of the same rule: skip any candidate whose
supertype chain reaches `$__vec_base`.

A `$__vec_base` subtype is an indexable carrier, never a closed-struct
array-like, whatever it is called. All three helpers already serve it through
their own arms — `__extern_length`'s #2186 base-vec arm, `__extern_get_idx`'s
#2190/#3183 vec arms, `__extern_has_idx`'s vec generalisation — which is
precisely what the name-based exclusions for `__vec_*`/`__subview_*` were
already relying on.

The structural rule also covers the carriers minted since the name list was
written and never matched by it: `__template_vec_externref`, `__ta_view_<K>`,
`__ta_dyn_view`. Those were **not** observed to misbehave here — none entered
the candidate set in any module measured for this issue — so they are stated
as scope the rule now closes, not as bugs fixed.

## Test Results

All figures below are base runs executed in this worktree via the file-copy
A/B (`.tmp/base-object-runtime.ts` captured at the first edit), same box, same
file lists, `--target standalone` through `tests/test262-runner.ts`.

**The 3 blocked files — 3/3 flip:**

| file | base | after |
| --- | --- | --- |
| `String/prototype/match/S15.5.4.10_A2_T17.js` | FAIL `[0]=== "02". Actual: undefined` | **PASS** |
| `String/prototype/match/S15.5.4.10_A2_T18.js` | FAIL (same) | **PASS** |
| `String/prototype/match/S15.5.4.10_A1_T3.js` | FAIL (same, via `bind` + `eval`) | **PASS** |

**Collateral sweeps (both arms run by me, file-copy A/B):**

| scope | files | base pass/fail/CE | after pass/fail/CE | delta |
| --- | --- | --- | --- | --- |
| `String/prototype/{match,search,matchAll}` | 119 | 78 / 29 / 12 | **85** / 22 / 12 | `gained=7 lost=0` |
| `RegExp/prototype/{exec,test,Symbol.match}` | 177 | 117 / 54 / 6 | 117 / 54 / 6 | `gained=0 lost=0` |
| `Array/prototype/{reduce,indexOf,includes,every}` array-like receivers | 275 | 176 / 99 / 0 | 176 / 99 / 0 | `gained=0 lost=0` |

**Net across 571 files: +7 pass, 0 regressions.**

The four gains beyond the three targeted files are the
`match/cstm-matcher-on-{bigint,boolean,number,string}-primitive` family — the
same borrowed-`match`-then-index shape. The `exec`/`test` scope is the
collateral check for the carrier itself; the Array-prototype scope is the
collateral check for the population `fillExternArrayLikeStructArms` exists to
serve (a closed `{0:…, length:n}` struct is not a vec subtype, so the filter
must not touch it — and does not).

**gc/host byte-identity: sha256-IDENTICAL on all 17 corpus programs** compiled
with no `target` (the default gc/host lane) — the 13 `website/playground/
examples` sources plus four written for this issue that exercise a dirty
builtin prototype with match-vec indexed reads, a closed-struct array-like, a
typed array and a template literal. Expected: the whole fill is gated on
`ctx.externGetIdxReserved` (standalone-only), and this is the measurement that
confirms it.

**Unit suites:** `tests/issue-4443.test.ts` (new, 12 cases) passes and **fails
2/12 on base** — the externref-round-trip and borrowed-match cases, the two
that actually reach `__extern_get_idx`. Also green: `issue-4439` (18),
`es5-standalone-regexp`, `regexp`, `issue-1539-standalone-regex{,-replace}`,
`issue-1539-standalone-array-coercion`, `issue-2161-matchall`, `issue-3169`,
`issue-1461-standalone-{reduce,search}-arraylike`,
`issue-3643-array-from-arraylike`, `issue-4159-4160-prescan-flags`,
`issue-4160-{proto-index-store,filter-live-prototype-index}`,
`issue-4434-vec-index-domain-sparse-tail` — 0 new failures.

**Equivalence gate** (`node scripts/equivalence-gate.mjs`, full suite): 24
failing / 1645 passing / 36 known-failures — **no new regressions**, exit 0.
It also reports 12 baseline failures now passing; those arrive with the
merged #4439 work, not with this change, and the baseline is deliberately not
ratcheted here.

**Two-stage measurement note.** The sweeps above were run against the first
cut, which inlined the predicate in `object-runtime.ts`; it was then moved to
`registry/types.ts` to keep the god-file growth to the wiring plus its
call-site note. The 119-file scope and the 17-program sha corpus were **re-run
on the moved version** and are verdict-identical to the inlined one
(`gained=0 lost=0` diffing the two after-states, sha256 unchanged), so the
figures describe the code that is committed.

**Pre-existing failures, A/B'd identical on base, NOT mine:**
`issue-2773-arraylike-call-thisarg` (9/9), `issue-2640-arraylike-call-
receiver-arg` (6/9), `issue-2580-m22b-map-arraylike` (1/5),
`issue-3673-standalone-gaps` (1/20, "single-call-site fnctor prototype method
still loses to the string sentinel").

## Residuals

### R1 — `0 in m` is false for an externref-held match-vec, in BOTH lanes

`var box = {}; box.v = "1020".match(/0./); 0 in box.v` answers `false` while
`box.v[0]` answers `"02"`. Measured identical on base and after, and identical
in the clean and dirty module, so it is neither caused nor repaired here: the
`__extern_has_idx` vec coverage does not reach `$__regexp_match_vec`. Get and
HasProperty therefore disagree on the same index. `tests/issue-4443.test.ts`
pins the honest invariant (dirty === clean) rather than asserting the correct
answer, deliberately — asserting `1` there would be asserting someone else's
fix. Owner: the vec-overlay presence lane (`vec-overlay-presence.ts`, #4222).

### R2 — `fillExternArrayLikeStructArms` is 325 lines

It was 310 before this change and is now over the function budget by the size
of the call-site note, granted as an allowance above. The function is genuinely
too big and wants splitting (the three helper arms — `__extern_length`,
`__extern_get_idx`, `__extern_has_idx` — are three independent loops over one
shared candidate list, so the seam is obvious). Not done here: that is a
refactor with its own regression surface, and doing it inside a bug fix would
make the fix unreviewable. Owner: the consolidation lane (#3399).

### R3 / R4 — inherited from #4439, untouched

`s.match(null)` treated as an absent argument, and `@@match`/`@@search`
protocol objects `ToString`'d rather than dispatched. Both are in #4439's
issue file with owners; neither is in this issue's surface.
