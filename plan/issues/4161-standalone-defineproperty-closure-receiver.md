---
id: 4161
title: "standalone: Object.defineProperty/defineProperties on a FUNCTION receiver define into the #3468 own-property bag (harvest of fork PR #4124's #3979 slice)"
status: done
sprint: 78
created: 2026-08-05
completed: 2026-08-05
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: fix
area: codegen, runtime, standalone
language_feature: objects, property-descriptors
goal: es5
related: [3977, 1906, 2992, 3251, 3468, 3537, 4010, 4047, 4055, 4120]
assignee: ttraenkler/fable-harvest
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
origin: "Harvest of loopdive/js2 PR #4124 (fork branch ttraenkler:claude/pull-from-upstream-zgdo0m, head 9bf9158), whose base was ~767 commits behind main. The fork numbered this work 3979, which on main is a DIFFERENT issue; re-derived against current main under a fresh id."
---

# #4161 — standalone: define appliers accept a closure receiver / closure `Properties` map

## Provenance and id allocation

This is the surviving slice of fork PR #4124's "#3979 reflective MOP over the
own-property bags". The id was allocated via
`claim-issue.mjs --allocate --by ttraenkler/fable-harvest`; the open-PR scan
DEGRADED (`gh` unavailable in the harvest container, api.github.com blocked by
org egress policy), so the in-flight-PR check was done by hand before passing
`--allow-unscanned`: `git ls-remote origin 'refs/pull/*/head'` (works over git
protocol), then every existing pull head from #4060..#4126 was fetched and its
`plan/issues/` tree diffed against main's id set. The only off-main ids in any
recent PR head were 4144/4145/4149/4154 (PRs #4088/#4106), all below main's
highest id (4160) — so nothing an allocation of ≥4161 could collide with.
Reservation + claim both verified on `origin/issue-assignments`.

## What of #4124's slice was already superseded on main (kept main's version)

Re-derived file by file against current `origin/main` (2026-08-05). Most of the
fork's #3979 has since been solved on main by a different, measured
composition — those parts were **dropped**, per "keep main's version":

| Fork #3979 piece | Superseded by (on main) |
| --- | --- |
| `own-prop-bag.ts` lookup builders + hasOwn / `in` / gOPD / keys wiring | #4010 S3 `carrier-bag-visibility.ts` (`bagHasIfAbsent`, `bagGopdBetween`, `bagKeysTail`, …) |
| `__delete_property` bag arm | #4010 S2 `carrier-bag-delete.ts` (tri-state `__carrier_bag_delete`) |
| ToPropertyDescriptor field probes seeing closure descriptors | #4055 `__desc_has_own` (deliberately scoped to that one caller after the v1 general widening cost −684) |
| `__closure_prop_set` writable-gate on `__builtinfn_get_meta` (the fork's −684-mechanism fix) | #4010 S3 `buildBuiltinFnSetRefusalArm`, installed at `__extern_set`'s miss arm — which heads `__closure_prop_set`'s only call path, so the same writes are refused at their source |
| `tests/issue-3979-bfn-name-writable-gate.test.ts` | behavior covered by main's S3 guards; the builtin `name`/`length` cycle is re-pinned here anyway (see tests) |
| fork's `hasField` HasProperty investigation note | main uses `__desc_has_own` at both `hasField` sites already |

Notable: the fork independently isolated the −684 mechanism (probe writes from
`propertyHelper.isWritable` depositing a stale bag shadow for builtin
`name`/`length`) that #4055's header records as "never isolated"; main's S3
later isolated and fixed the same mechanism at the same conceptual site. Two
lanes, same root cause, compatible fixes — main's landed first.

## The genuinely-new remainder (this PR)

Main's own comments request exactly this piece:

- `carrier-bag-visibility.ts`: "**`Object.defineProperty(fn, k, d)` still lands
  nowhere.**"
- `object-runtime-descriptors.ts` `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`: "the
  arm becomes sound the moment ONE store is authoritative for a carrier's own
  properties. A narrower prerequisite for the Function half alone: give
  `__defineProperty_value` / `_accessor` a closure arm that recurses on
  `__closure_bag_ensure`, mirroring `vecOverlayArm`."

### 1. New module `src/codegen/carrier-bag-define.ts`

Write-side counterpart of the (read-only, LOOKUP-never-ENSURE)
`carrier-bag-*` trio: `closureBagEnsureInstrs` / `closureBagSubstitutionArm`
(ENSURE — a define is a write, allocating the bag on demand is what
`__extern_set` does for an assignment) plus `isClosureCarrierInstrs` and the
closure-only, lookup-only `closurePropertiesBagArm`. Every builder returns
`undefined` when the #3468 substrate is absent; call sites then keep their
pre-existing body AND local vector byte-identical (gc/host unchanged). Bag
locals are APPENDED, so no existing local index shifts.

### 2. `__defineProperty_value` / `__defineProperty_accessor` closure arm

In the non-`$Object` arm, AFTER the #3251 `vecOverlayArm`: ensure the closure
bag and substitute it for the receiver (re-point the cached `any` local),
falling through into the unchanged `$Object` path — so defines land in exactly
the table `__extern_get`/gOPD/hasOwn read from, and the #2042-S4
ValidateAndApplyPropertyDescriptor preflight (previously skipped entirely via
the lenient no-op) now runs for closure receivers. Bag locals: 13 (value
applier), 16 (accessor applier).

### 3. The two #1906 `__defineProperties` gates, widened for the closure halves

- **`O` is a closure carrier** → admitted alongside the vec carrier (pass 2
  hands the raw receiver to the appliers, which now carry the closure arm).
  Carrier-less objects keep the loud `[SITE-O-NO-CARRIER]` refusal — the
  appliers' terminal arm for those is still a lenient no-op, and admitting one
  would trade a loud refusal for a silent wrong answer.
- **`Properties` is a closure with a bag** → enumerate the BAG (lookup, never
  ensure), falling through into the unchanged `$Object` key walk. Sound now,
  and only now: the #4047-era measurement that reverted bag-enumeration was
  unsound precisely because `Object.defineProperty(props,"p",…)` on a Function
  landed nowhere; with arm 2 above, assignments AND defines both land in the
  bag, so the closure bag is the complete own-NAMED-property store (builtin
  `name`/`length` metadata is non-enumerable and correctly excluded from the
  walk). A closure with NO bag has no own enumerable named properties →
  "define nothing, return O" is the complete spec answer.
- **The ARRAY halves deliberately did NOT move.** A vec's defines land in the
  #3251 overlay companion, not its #3537 bag, so enumerating a vec
  `Properties` bag would silently drop overlay-defined properties (the exact
  silent no-op #3957 forbade). `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` stays for
  every non-closure object.

## Validation

Probes (`.tmp/probe-4161.mts`, standalone lane, host-free asserted) — A/B
against base `object-runtime-descriptors.ts`:

| probe | base | with #4161 |
| --- | --- | --- |
| defineProperty(fn, k, data desc) → read/hasOwn/gOPD | fail | pass |
| defineProperty(fn, k, accessor) → getter fires | fail | pass |
| defineProperties(o, fnPropsMap) | throw #1906 | pass |
| defineProperties(fn, {…}) | fail | pass |
| defineProperties(o, bagless fn) → spec no-op | throw #1906 | pass |
| non-configurable redefine on fn throws (preflight) | fail | pass |
| builtin `name` descriptor untouched (−684 family guard) | pass | pass |
| define → delete → hasOwn cycle coherent | fail | pass |
| array `Properties` still refuses loudly | pass | pass |

Unit tests: `tests/issue-4161.test.ts`.

## MEASURED — standalone lane, six descriptor directories (2026-08-05)

Same corpus as the fork's measurement, but on CURRENT main's runner:
`runTest262File(path, category, undefined, "standalone")` — the lane is the
4th POSITIONAL argument (the fork's first measurement was lane-mislabelled by
passing an options object into `timeoutMs`; here the lane is passed
positionally, and standalone verdicts enforce host-freedom via
`standaloneHostImportError` — visibly so: modules that demand a host import
fail instantiation in this lane, see `15.2.3.6-4-594` below). 2,471 files
across
`built-ins/Object/{defineProperty,defineProperties,create,getOwnPropertyDescriptor,isExtensible,preventExtensions}`,
BEFORE = this branch with `object-runtime-descriptors.ts` reverted to the
merge base (`3f7f19e8a`), AFTER = this branch. Identical harness, 6 workers.

| | standalone |
| --- | --- |
| BEFORE | 1,268 / 2,471 |
| AFTER | **1,272 / 2,471** |
| fixed | **+4** |
| regressed (pass→fail transitions) | **0** |

The four flips, individually:

| test | BEFORE failure |
| --- | --- |
| `defineProperties/15.2.3.7-5-a-7.js` | `#1906 [SITE-PROPS-BAG-NOT-AUTHORITATIVE]` (function `Properties` map) |
| `defineProperties/15.2.3.7-5-b-239.js` | same |
| `create/15.2.3.5-4-28.js` | same, via `Object.create` |
| `defineProperty/15.2.3.6-4-33.js` | "Expected a TypeError… no exception" — the #2042-S4 preflight a closure receiver used to skip |

**Zero pass→fail transitions.** The fork's sole accepted regression,
`15.2.3.6-4-594`, is NOT a transition here: it fails identically on BOTH
sides of this A/B with a pre-existing, unrelated failure on current main
(`WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval"` — the
compiled module demands a host import, so the host-free lane refuses to
instantiate it).

**Why +4 and not the fork's +29/−1:** the fork's number was measured against
a months-old base. Between that base and current main, #4055 and #4010 S2/S3
landed the READ side of the same cluster (function-as-descriptor resolution,
hasOwn/`in`/gOPD/keys, real delete) — i.e. most of the fork's win was
independently banked already. The fork's +29/−1 is reported here as ITS
claim, not as something this A/B reproduced. This PR's own contribution on
current main is the residual define-side: +4 / −0, plus the unit-test
coverage and the two gate admissions.

## Remaining / blocked (updated from the fork's analysis)

| Sub-bucket | Blocked behind |
| --- | --- |
| `15.2.3.6-4-594` — now fails for a DIFFERENT reason on main (module pulls `js2wasm:runtime-eval`); once that import demand is gone, the fork's original analysis applies: inherited `Function.prototype` accessor must dispatch the SETTER on assignment (OrdinarySet fidelity, #2992/#3251) | runtime-eval import demand, then #2992/#3251 |
| Date / RegExp / Error / Arguments expando storage (writes are LOST — no carrier) | a third side-table carrier (#4098's greenfield rows) |
| vec `Properties` maps / vec bag-vs-overlay unification | #4010's "ONE authoritative store" for arrays |
| closed-struct receivers / `Properties` | #2992 S6 shape widening |
