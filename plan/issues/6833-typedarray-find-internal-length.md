---
id: 6833
title: "ES2015 standalone: direct TypedArray find/findIndex use internal length"
status: in-review
sprint: current
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
model: gpt-6.1-sol
task_type: bugfix
area: codegen
language_feature: typed-array
es_edition: ES2015
goal: standalone-mode
parent: 6651
assignee: "ttraenkler/typedarray_find_sol"
related: [6832, 6835, 6651, 5194, 2872, 4394]
---

# #6833 — direct TypedArray find/findIndex use internal length

## Problem and grounding

Direct dynamic `sample.find(predicate)` and `sample.findIndex(predicate)`
currently reach generic native HOF helpers whose prologue observes `.length`.
The TypedArray algorithms must instead snapshot their internal array length;
an own or inherited length getter must not run. Borrowed
`Array.prototype.find.call(sample, predicate)` and `findIndex.call` must keep
their observable LengthOfArrayLike behavior.

Source inspected at `56680e7feb87a090ee8846c8ecb7718933cd3781`, the assigned
upstream-main base. This is a source-grounded plan, not a fresh runtime result.
The predecessor, #6832 "ES2015 standalone: direct TypedArray HOFs read internal
array length", landed the required clone machinery. The next-slice section in
#6651 "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20
census" identifies this bounded extension.

- `src/codegen/hof-native.ts:87`: `TA_INTERNAL_LENGTH_HOF_METHODS` contains
  `forEach`, `every`, `some`, `reduce`, and `reduceRight`; it still omits both
  methods owned here.
- `ensureNativeArrayHof` already admits `find` and `findIndex`, with parameters
  `(recv, cb, thisArg)`, f64 loop length local 3, and exactly one
  `local.get 0 → call __extern_length → local.set 3` prologue. Neither method
  belongs to `PRESENCE_SENSITIVE`, including when prototype indices are dirty.
- `fillHofTaDynViewPresenceBypass` already supports length-only clones with
  zero HasProperty sites. Its shape guard requires exactly one matching length
  prologue before minting or rerouting a helper.
- The direct dynamic-view route in `closed-method-dispatch.ts:1729` reaches
  these generic helpers through the vec-base arm. The producer exclusions
  cover `map`, `filter`, `slice`, and `sort`, not this pair.
- `array-object-proto.ts:962` sends borrowed Array HOF closures directly to
  `ensureNativeArrayHof`'s original generic helper. Those closures are outside
  the clone finalizer's matching direct-dispatcher rewrite.

The two targeted original files are
`test/built-ins/TypedArray/prototype/find/get-length-ignores-length-prop.js`
and the corresponding `findIndex/get-length-ignores-length-prop.js`. They
install throwing getters on the shared TypedArray prototype, concrete
constructor prototype, and instance, then expect the direct method to succeed.

## Ownership and reader map

The implementation production scope is **`src/codegen/hof-native.ts` only**:
add two names to the internal-length set and update the nearby comment that
currently says "five direct TypedArray HOFs". The associated new fixture is
`tests/issue-6833-typedarray-find-internal-length.test.ts`; only inventory
metadata required for that fixture and this issue record may accompany it.

`TA_INTERNAL_LENGTH_HOF_METHODS` has one reader: the `needsInternalLength`
decision in `fillHofTaDynViewPresenceBypass`. That finalizer is called by
`fillTaDynViewMopArms` after `fillClosedMethodDispatch` in both compiler finalize
pipelines. It reads `ctx.taDynViewTypeIdx`, `ctx.funcMap`, registered function
records through `definedFuncAt`, and `ctx.mod.functions`. It deep-copies the
helper body and copies its local records, creates a fresh parameter/local map,
appends dynamic-view scratch locals, registers the clone immediately through
`mintDefinedFunc`/`pushDefinedFunc`, and rewrites call operands only in matching
`__call_m_<method>_*` bodies. Generic Array closures continue reading the
original helper index; final layout/remapping owns the new calls normally.

The clone's runtime receiver test confines its internal-length read to
`$__ta_dyn_view`. The other branch retains `__extern_length`. Its existing
`pushElemSizeForKind` and `pushTaDynViewInBoundsLen` calls use the view's runtime
element size, offset, fixed/tracking length, and current backing-buffer bounds.
The loop snapshots that length once; subsequent element reads stay live.
No shared context field, helper ABI, import, or registration policy changes.

Root allocated this issue and confirmed transfer of the upstream assignment
record to `ttraenkler/typedarray_find_sol` before implementation handoff.
Requested routing is Astra planning followed by GPT-6.1 Sol implementation;
`reasoning_effort: high` is the recommended implementation setting, not a
claim about this planning session's undisclosed configured effort.

## Implementation Plan

1. Recheck the assigned branch/base and issue ownership. Before source edits,
   capture a fresh authoritative original measurement on the identity set
   below, including passing instrument controls. Preserve the original source
   fingerprint and receipt; do not substitute the older full census.
2. Add exactly `find` and `findIndex` to `TA_INTERNAL_LENGTH_HOF_METHODS`.
   Correct the nearby five-method comment. Reuse the current guarded clone
   without refactoring the finalizer or changing its fallback behavior.
3. Verify emitted direct dynamic calls use `__hof_ta_find` and
   `__hof_ta_findIndex` even in modules with no HasProperty sites. Verify
   borrowed Array calls still use the generic helpers and the non-view branch
   is intact. Retain the direct-dispatch detached guard ahead of the call.
4. Add the focused host-free regression fixture described below. Use a
   function receiving a constructor parameter, then `new TA(...)`, so the
   tests reach the dynamic carrier rather than only a statically typed path.
   Assert successful compilation, no compiler imports, no Wasm imports, and
   actual exported results. Reuse the standalone execution pattern in the
   #6832 fixture without changing that predecessor's tests.
5. Run the exact matched candidate measurement, audit row identities and
   transitions, and record measured gains and unchanged residual failures.
   Run the focused fixture, adjacent #6832 / #2872 findLast / #4394 borrowed-HOF
   fixtures, and applicable maintained source/format/issue/inventory gates.
   Coordinate heavy runs with root's test lease; do not start a full census.
6. Update this issue with actual receipts and acceptance results before the
   normal implementation publication workflow. The implementer's fresh
   measurements outrank this plan. Unexpected helper shape, a new regression,
   or a needed edit outside this seam requires a scoped handoff to root.

## Acceptance fixtures

- For both methods, an own getter and a constructor-prototype getter returning
  a misleading length are ignored: zero getter calls, correct found value or
  index, and correct callback count. Include a throwing getter and the shared
  TypedArray-prototype case exercised by the originals.
- Borrowed Array calls observe own and prototype getters exactly once and use
  their reported length. Test getter abrupt completion with a valid callback.
  Do not accidentally test a reflective TypedArray-prototype `.call` instead.
- Dynamic dense Arrays and sparse Arrays retain their find semantics. A hole
  is visited with `undefined`; these methods do not acquire a HasProperty
  skip gate. Check both a plain module and one with a dirty prototype index.
- Verify `(value, index, receiver)`, receiver identity, explicit callback
  `thisArg`, ascending order, first-match short circuit, empty/miss results
  (`undefined` / `-1`), predicate abrupt completion, and non-callable rejection.
- Mutating a later element in the callback affects its subsequent read. If a
  predicate changes the current slot before returning true, `find` returns
  the value already read for that visit. `findIndex` returns the visited index.
- Preserve detached-on-entry behavior on the existing guarded route. Detach
  inside the callback, continue through the original snapshotted count, and
  observe `undefined` at subsequent visits rather than skipped callbacks.
- Cover different element widths and a nonzero byte offset; exercise fixed
  and length-tracking resizable views. Growth before entry affects a tracking
  view's initial length; growth during iteration does not extend the snapshot.
  Shrink during iteration can make the view out of bounds, but remaining
  callback visits still occur with live element reads yielding `undefined`.
  Record baseline/candidate behavior for an already-out-of-bounds entry.

## Validation population and evidence

Use `scripts/test262-es2015-11778-manifest.txt`, SHA-256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
Its exact intersection with `test/built-ins/TypedArray/prototype/find/` and
`findIndex/` contains **40 originals: 20 per method**, verified during planning.
Do not select entire current directories: later-edition files such as resize
and BigInt tests exist outside this frozen intersection.

Add these three instrument controls, attributing them separately from gains:

- `test/built-ins/Math/sign/length.js`
- `test/intl402/DisplayNames/ctor-custom-get-prototype-poison-throws.js`
- `test/intl402/Segmenter/ctor-custom-get-prototype-poison-throws.js`

The matched receipt therefore has **43 identities = 40 owned originals + 3
controls** on each side. Use the maintained standalone Vitest Test262 runner,
QuickJS eval engine, semantic providers `auto`, honest oracle version 14,
fresh isolated compiler/runtime bundles, and executable provider canaries.
Require zero host imports and no exclusions/skips. State both source SHAs and
candidate diff fingerprint, lane, harness, source/bundle/adapter hashes,
manifest hash, exact JSONL paths/hashes, and completion receipt paths.
Require complete registered/started/settled/recorded identity equality and
exactly one completion manifest per wrapper for the selected shard setup.
An exit-zero wrapper or all-green Vitest container does not prove conformance.

Both internal-length originals must change from measured failure to pass;
every originally passing owned row and instrument control must remain passing.
Diff all rows and error text, including unchanged failures, before attributing
gains. If the original already passes on a newer base, report that evidence
and reassess rather than claiming this change fixed it. A reversible removal
of the two set additions should reproduce the targeted fixture failures when
needed for attribution; restore only this lane's own edits without shared stash.

The previous completed full-scope receipt is **11,443 pass / 311 fail / 24
compile errors / 11,778**, run `20261002-184918` on `cd123eca`. It is historical
goal context, not a measurement of the newer `56680e7` base or this candidate.
No scoped result establishes 100%, and control passes are never extra gains.

## Risks, boundaries, and completion

The existing entry guard is narrower than complete ValidateTypedArray:
`taDynDetachedGuardInstrs` skips any receiver with a non-null own-expando field,
requires the existing native TypeError helper, and checks detachment rather
than resizable-buffer entry bounds. Source preservation alone is therefore
not proof of detached/entry-OOB conformance. Measure detached views with an
own property and already-OOB entries separately; record any unchanged defect
for root's follow-up, and stop on a newly introduced regression. Do not encode
an incorrect normal-return expectation as a conformance test to hide it.

The exactly-one-prologue guard can decline changed emitted shapes. A valid
Wasm module or a mintable clone alone does not show the direct call uses it;
the original getter assertions and callback counts are the acceptance signal.

No edits to IR or migration areas, runtime, dispatcher, generic
`__extern_length`, reflective TypedArray-prototype `.call`, `findLast`,
`findLastIndex`, `join`, `toLocaleString`, corpus, runners, oracle/host guards,
exclusions, or baselines belong to this issue. Do not add Test262 originals
or borrow the predecessor's source-growth allowance. The intended production
change requires no extraction or new helper.

- [x] Two-name source extension and comment only, with generic behavior intact.
- [x] Retained owned-fix standalone fixtures execute and pass; the deferred
  controls below remain open under #6835.
- [x] Matched 43-identity receipts prove targeted gains and no pass regressions.
- [x] Guard/bounds residuals are separately recorded with honest scope.
- [x] Required scoped gates pass and actual results are filed here; open
  architecture inventory limitations are explicitly preserved below.

## Implementation and validation record

The implementation extends only `TA_INTERNAL_LENGTH_HOF_METHODS` with `find`
and `findIndex`, and removes the outdated five-method count from the nearby
comment. No generic helper, dispatcher, runtime, or IR source is changed.

Fresh original run `20261002-221457` used source commit
`56680e7feb87a090ee8846c8ecb7718933cd3781`, the maintained
`scripts/run-test262-vitest.sh`, standalone target, semantic providers `auto`,
QuickJS, and honest oracle 14. It measured **41 pass / 2 fail / 0 compile
error / 0 skip over 43 identities**. Both internal-length originals fail with
`Test262Error:  (Testing with Float64Array and makeArray.)`; the other 38 owned
originals and all three separately attributed instrument controls pass.

The immutable QuickJS artifact was supplied from the canonical artifact cache,
with SHA-256 `073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
The original adapter was freshly compiled and executable-canary verified in
this worktree. An initial missing-artifact preflight terminated before any
verdict; its log is preserved separately and is not measurement evidence.

Original evidence (all paths relative to this isolated worktree):

- Exact manifest SHA-256:
  `ba1b31d52b26b2cd5eabcac31e612cbe032042403b09487ca376e634cee25dc2`.
- Source-tree SHA-256 (sorted source paths and bytes):
  `41d1605d24eccc4452e6169c6a86fa91835437f5515f59c9cdbd21c7a69ff66a`.
- Compiler bundle SHA-256:
  `f4e72b29ff30cafcd43455cf8d50f532c385b8ba79fa3be4722a0c3138f109a6`.
- Runtime bundle SHA-256:
  `ac00fdb2f376ddc28ed25d67517f637cf63b853b030aa35f5c91d420e9642c51`.
- Adapter SHA-256:
  `fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`.
- JSONL: `benchmarks/results/test262-standalone-results-20261002-221457.jsonl`,
  SHA-256 `8513a571fe5b5471a3a958004bc8b4b03e3de658049fa6b1ce19122d1b54e429`.
- Completion:
  `benchmarks/results/test262-standalone-results-20261002-221457.shard-1-of-1.complete.json`.
  Exactly one v2 receipt records 43 registered, started, settled and recorded
  identities, all callbacks settled, zero proposal/official exclusions.
- Durable runner log: `.tmp/6833/baseline.log`; full fingerprint record:
  `.tmp/6833/baseline-receipt.json`.

Candidate run `20261002-222335`, on that same commit plus the bounded patch,
measured **43 pass / 0 fail / 0 compile error / 0 skip** over the same exact
43 identities. All 41 original passes remain passing, and exactly the two
internal-length originals change from failure to pass. The three instrument
controls are preserved passes, not gains. The one v2 completion receipt again
records 43 registered, started, settled and recorded identities, all callbacks
settled, and zero proposal/official exclusions. Both candidate bundles were
freshly built; the QuickJS adapter was freshly compiled and executable-canary
verified against the same pinned artifact.

Candidate evidence:

- Source-tree SHA-256:
  `d9920cdea66318098c434802726a30dbcc838a808a20994935d0751e8e40009c`.
- Production diff SHA-256:
  `d80196564f9a4f11e05fc2d9b1a448254f307d8b3df1e16569ee5a44d38df5ac`.
- Compiler bundle SHA-256:
  `7d6dc9f0d85588ea25d0ce11e2e0f98d5ea515e4592cf771b95029dd9338698d`.
- Runtime bundle SHA-256:
  `3473107e5271fde317411d1f0411b2bb53fb940d03021e99a41f9681e99a7a0b`.
- Adapter key `36c6b3908924cf97`, SHA-256
  `fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`.
- JSONL: `benchmarks/results/test262-standalone-results-20261002-222335.jsonl`,
  SHA-256 `dd2f54490ebf7f7fd03b48279a8b15d92283fe0f220c189f2ec6aca24c783978`.
- Completion:
  `benchmarks/results/test262-standalone-results-20261002-222335.shard-1-of-1.complete.json`.
- Durable runner log: `.tmp/6833/candidate.log`; fingerprint record:
  `.tmp/6833/candidate-receipt.json`; maintained row diff: `.tmp/6833/diff.log`.

## Explicit deferred acceptance — tracked under #6835

[Standalone find controls: borrowed length, undefined values, and view entry
validation](6835-find-control-residuals.md) preserves the correct requirements,
exact standalone repro sources, source/receipt hashes and source-owner plan.
Those broader controls are not completed by this narrow internal-length fix.

The unmodified 32-test correct-expectation fixture measured **23 pass / 9 fail
on original → 27 pass / 5 fail on candidate**. Exactly four own-getter/throwing
getter cases are fixed; the other five failed controls remain byte-for-byte
unchanged in the matched diagnostics. The entire original fixture is archived
in `.tmp/6833/correct-expectations-original.test.ts` and in the follow-up's
reproduction record; no wrong expected values or skipped tests replace it.
Normal detached entry, callback detachment, callback identity/order, mutation
and both resized offset/element-width controls pass on both arms.

The specifically deferred requirements are:

- Borrowed `find` must return `undefined` on a miss after observing an own
  length getter; observed diagnostic is 110 rather than required 111.
- Borrowed `find`/`findIndex` must observe the constructor-prototype length
  getter once and use its length; observed diagnostic is 30 rather than 111.
- Plain dynamic dense Arrays containing `undefined`, and sparse Arrays, must
  pass `undefined` to the predicate at the hole/undefined slot. Plain probes
  return 301 (`find`) or 300 (`findIndex`) rather than 211; the dirty-prototype
  paths return the correct 211 and remain retained passing controls.
- Detached entry with an own expando, and later-edition already-OOB resizable
  view entry, must throw TypeError. Both methods return normally with zero
  callbacks (0) rather than the required caught-TypeError signal (-10).

`.tmp/6833/control-diagnostics-{baseline,candidate}.json` and the corresponding
`residuals-*.json` are each byte-identical between arms. Their scripts pin the
original compiler hash before baseline execution and assert zero Wasm imports.
These are preserved failures, not #6833 regressions or passing acceptance tests.
The publication fixture retains correct positive borrowed own-getter behavior,
getter abrupt completion, plain numeric dense Array controls and the dirty
prototype sparse/undefined controls, alongside the owned TypedArray cases.

## Final retained fixture and handoff gates

The final retained 30-test fixture was executed on both source versions with
unchanged correct expectations and identical test identities. Only this lane's
two set entries and nearby comment were temporarily reversed with `apply_patch`;
the original production-file SHA-256
`6108ee834a5a0e81a84cad0d79a69a58f904024864db5a321753fd3191ab76a5`
was verified before baseline execution. The exact candidate SHA-256
`0caedf442fad886cc96140c0f174d4a524007b022af32fa28363ddc7233d6e9f`
was restored and verified before all final candidate checks. Neither canonical
43-row receipt nor its compiler/runtime bundles was replaced by these checks.

Both arms imported the compiler from current source under the normal compiler
configuration. Fixture SHA-256 was
`8b607f3a908cb4e28370afb7f5130b2bea9a8aca63587b3f1220aae8a6ff3196`
on both arms. Baseline measured **26 pass / 4 fail**; candidate measured
**30 pass / 0 fail**. The four gains are each method's own accessor and throwing
own getter cases. Every retained borrowed, generic, callback, mutation,
detachment and resizable-view positive control passes on both arms. Logs are
`.tmp/6833/fixtures-final30-baseline.log` and
`.tmp/6833/fixtures-final-candidate-cohort.log`; source and fixture fingerprints
are in `final30-{baseline,candidate}-fingerprints.log` in the same directory.

The combined candidate regression run passed **63 tests across four files**:
this issue's 30, #6832's 19, #2872's 10 and #4394's 4. All owned fixture
executions assert successful compilation, zero compiler imports, zero Wasm
imports and actual exported results. The retained cohort does not claim the
broader original acceptance controls tracked under #6835 are fixed.

An additional inspection-only compile with `JS2WASM_IR_INLINE=0` retained
named call boundaries. For both methods, emitted direct dispatchers call the
TypedArray clone, that clone has zero HasProperty calls and retains the generic
length fallback, and first-class borrowed Array methods call the generic
helper. Its zero-import executable probe returns 1. This is structural evidence
only; it is not the normal-configuration canonical conformance measurement.
Artifacts: `.tmp/6833/structure.{wat,json}` and `structure-final.log`.

Maintained gates passed: TS7 typecheck, host-import policy, codegen-fallback
ratchet (zero corpus files with hits), import cycles, flat-directory budget,
LOC/function budgets (production net +2 lines), coercion-site and oracle
ratchets, speculative rollback, issue-ID uniqueness and issue consistency,
targeted Prettier/Biome and whitespace checks. Compile-gate exit records are
`.tmp/6833/heavy-gate-status.log`; individual logs are retained separately.

Compiler-boundary inventory reports `inventory-valid-architecture-incomplete`
with no inventory errors; this is not architecture completion. The maintained
dead-export check exits zero and reports core-node 12/12, core-type 10/10 and
preservation 6/6 passes, but its moved-runtime production-rooted evidence gate
and strict graph closure remain open. The non-literal imports in
`src/optimize.ts` and the platform capability adapter are unchanged. No
retirement or architecture-closure claim is made by this bounded fix.

This issue is handed off for review, not marked merged/done. #6835 remains
open investigation work. Publication and merge are owned by the root agent.
