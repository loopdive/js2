---
id: 6832
title: "ES2015 standalone: direct TypedArray HOFs read internal array length"
status: done
sprint: current
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: typed-array
es_edition: ES2015
goal: standalone-mode
assignee: "ttraenkler/typedarray_some_internal_length_terra"
related: [6651, 6771, 6769, 5194]
---

# #6832 — direct TypedArray HOFs must use `[[ArrayLength]]`, not `.length`

## Problem

`test/built-ins/TypedArray/prototype/some/get-length-uses-internal-arraylength.js`
fails for the standalone dynamic TypedArray carrier. A direct `sample.some(cb)`
is routed through `__call_m_some_*` to `__hof_some`, whose prologue calls
`__extern_length`. The same shared HOF route serves direct `forEach`, `every`,
`reduce`, and `reduceRight`: their `__call_m_<method>_*` dynamic-view arms call
`__hof_<method>`, whose common length prologue is also generic. That helper
intentionally observes an own or inherited `"length"` property for borrowed
Array methods. It is therefore the right implementation for
`Array.prototype.<method>.call(sample, cb)`, but the wrong one for the direct
`%TypedArray%.prototype` methods, which snapshot the internal `[[ArrayLength]]`
after ValidateTypedArray.

The dynamic-view `__extern_length` arm correctly preserves generic
LengthOfArrayLike semantics, including the expando-backed own-length override
in `taDynViewOwnLengthArm`. This issue must not weaken or bypass that arm.

## Grounding

- Base: `3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8` (`upstream/main`).
- Failing original shape: `TA` is the constructor parameter and `sample` is a
  function-local dynamic view; setup installs a length getter without invoking
  it. The direct `.some` call currently returns the getter-controlled answer.
- `fillHofTaDynViewPresenceBypass` already makes a TypedArray-only clone for a
  presence-gated HOF, but only when an `__extern_has_idx` call exists. Dense
  modules therefore retain their generic `__hof_<method>`, and every existing
  clone still uses generic `__extern_length`.
- Source attribution: fixed-arity direct calls use the native HOF arm in
  `closed-method-dispatch.ts`; `$__ta_dyn_view` is a `$__vec_base` subtype and
  is not excluded for `forEach`, `every`, `some`, `reduce`, or `reduceRight`.
  `map`/`filter` are distinct producer routes, while `find*`, `join`, and
  `toLocaleString` have separate owners and are out of scope.
- `array-object-proto.ts` sends first-class/borrowed non-reduce Array HOF
  values directly to generic `__hof_<method>`; `array-reduce-proto-value.ts`
  does the same for borrowed reducers. Neither route may be repointed.
- `pushTaDynViewInBoundsLen` is the correct live internal-length emitter. It
  covers fixed, length-tracking, out-of-bounds, resized, and detached dynamic
  views. `pushTaDynViewEffectiveLen` is not interchangeable: its fixed-view
  contract does not apply the all-or-nothing out-of-bounds rule.

## Reader and mutation map

`fillHofTaDynViewPresenceBypass` runs after `fillClosedMethodDispatch` in the
finalize sequence, when `ctx.taDynViewTypeIdx`, the five source helpers, and
their direct dispatcher bodies exist. It reads `ctx.funcMap`, the registered
helper records through `definedFuncAt`, and the dispatcher bodies in
`ctx.mod.functions`; it writes only newly minted, pushed helper records, their
`funcMap` entries, and call operands in matching direct HOF dispatchers. The
new instruction arrays are fresh and each clone is registered with
`pushDefinedFunc` immediately, so the final layout/remapping pass owns all
calls; no body is rebuilt and no generic runtime native is patched.

## Implementation Plan

1. In `src/codegen/hof-native.ts`, retain the existing TypedArray
   HasProperty-bypass cloning for all HOFs, but relax the global `hasIdx`
   early-return so a length-only TypedArray clone can be made for dense modules.
   Keep `bypass()` a no-op when `hasIdx` is absent.
2. For exactly `forEach`, `every`, `some`, `reduce`, and `reduceRight`, clone
   even with no presence gate and verify exactly one
   `local.get 0 → __extern_length → local.set L.len` prologue sequence before
   modifying it. If the expected shape is absent or ambiguous, do not mint or
   reroute a clone.
3. In each verified `__hof_ta_<method>` clone, replace that one prologue read
   with a runtime `$__ta_dyn_view` branch. The branch casts the receiver,
   obtains its runtime element size, emits `pushTaDynViewInBoundsLen`, and
   converts the resulting i32 to the clone's f64 loop length. Its non-view
   branch preserves the original generic `__extern_length` call unchanged.
4. Repoint only calls to the original `__hof_<method>` inside matching direct
   `__call_m_<method>_*` dispatchers. Do not alter Array-prototype value
   closures or borrowed calls, which continue to invoke generic HOF helpers
   and observe `LengthOfArrayLike`/`HasProperty`.
5. Keep the existing direct-dispatch detached-view guard ahead of the HOF call;
   preserve callback receiver identity, `some`/`every` short-circuiting,
   reducer initial-value behavior, mutation visibility, and the no-HasProperty
   TypedArray iteration behavior.
6. Add a focused standalone, host-free regression fixture covering dynamic
   Float64Array direct calls with own/prototype length getters for all five
   methods; borrowed-call controls per method; dense/sparse Array controls;
   callback receiver identity; short-circuiting; reduction direction/initial
   value; and detach/live-length behavior. No Test262 corpus, baseline, runner,
   IR, or global `__extern_length` changes belong here.

## Validation Plan

Before any production mutation, record two fresh standalone original receipts:
the eight-row instrument set (the five internal-length rows plus `Math.sign`
and two Intl constructor-poison canaries), then the frozen-11778 intersection
of all five owned HOF family directories plus those same canaries. The family
receipt also carries five separately attributed root-owned current-main audit
rows for already-landed Proxy/Reflect/Array-length fixes; they are controls,
not #6832 gains. Rerun both exact identity sets after the change, with a fresh
compiler/runtime bundle, QuickJS provider canary, zero host imports, complete
JSONL, and exactly one completion manifest per wrapper. Require no skips or
exclusions. The focused fixture then establishes unchanged generic Array and
borrowed-call behavior, callback identity, short-circuit/order, reducer
direction/initial value, and detach/live-bounds behavior. Follow with the
repository's required source and regression gates; no result from the frozen
census itself is treated as validation for this change.

## Scope

Owned production seam: `src/codegen/hof-native.ts` only, with an optional tiny
TypedArray instruction leaf under `src/codegen/array/` if extraction is needed
to stay within source-ratchet limits. The only permitted accompanying files
are this issue record and the dedicated regression fixture/its required
inventory metadata.

## Validation Results

All corpus runs used the maintained Vitest Test262 runner with
`JS2WASM_EVAL_ENGINE=quickjs`, `TEST262_TARGET=standalone`,
`TEST262_SEMANTIC_PROVIDERS=auto`, oracle version 14, the pinned QuickJS
artifact, an isolated worktree compiler bundle, and zero explicit exclusions.
The linked Test262 corpus content was verified against donor commit
`b363f29d3c43c626dc852744ad64a0b48a003693` before the original runs.

- Original eight-row instrument receipt `20261002-173012` recorded 3 pass / 5
  fail / 0 compile error / 0 skip. The five failures are the one internal-length
  assertion per owned direct HOF; `Math.sign` and both Intl constructor-poison
  canaries pass. Its exact manifest SHA-256 is
  `808173bb640c717f3ccf6c69092d47ceadbf98d9a7365626cef478f3d43832da`
  and JSONL SHA-256 is
  `19822a98115b9faa8b16dbcabda65e36f76fdd85dcbe3be12298c02611e4a0f7`.
- Candidate eight-row receipt `20261002-174748` recorded 8 pass / 0 fail / 0
  compile error / 0 skip on the same identity set and manifest. Its JSONL
  SHA-256 is
  `d22d62915f3bdf89b87e3331328bfca5aafb9ed187e2d8666c959db2e8a21293`.
  The fresh candidate source/compiler/adapter SHA-256 values are,
  respectively, `6108ee834a5a0e81a84cad0d79a69a58f904024864db5a321753fd3191ab76a5`,
  `09f24694ab0492755aeb12d8ea201c3457a306f9de0282c13222575de2b8c8f0`,
  and `89819371db428c4b757d55eaad1815f79a1e51eeae894806289581a656d33c1f`.
- Original frozen-family receipt `20261002-173315` recorded 121 pass / 7 fail
  / 0 compile error / 0 skip over the exact 128-row identity set: the frozen
  120-row five-HOF family intersection, three positive canaries, and five
  separately attributed current-main audit controls. Its manifest SHA-256 is
  `068d33154affd2d050b8bd4909da25f62587699e16646991a137e82ed1b1bcaf`
  and JSONL SHA-256 is
  `6bf19df3db63a80d6dd7597d8fb56ce48a93634cc5f4d24f2237ed962af8c3ad`.
- Candidate frozen-family receipt `20261002-174850` recorded 126 pass / 2
  fail / 0 compile error / 0 skip over the same 128 identities. Its JSONL
  SHA-256 is
  `ca32fff58d10cb7b6e124963bd535c9ea33d0852097953ae760d20bf91970509`
  and durable runner-log SHA-256 is
  `4a6328857d0d419e8785532d6a272bd7c29fce91d3a89fbbc2fb5bc7ef3f91c8`.
  The row-wise audit found the five intended failures changed to pass, all 121
  original passes stayed passing, and no pass changed to fail.

Each completion manifest has exactly one shard, all callbacks settled, 128
registered paths for the family receipts, and zero proposal or official
exclusions. The two residual failures are deliberately unchanged, separately
attributed Proxy controls:

- `test/built-ins/Proxy/ownKeys/return-not-list-object-throws-realm.js`:
  `Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`.
- `test/built-ins/Proxy/ownKeys/call-parameters-object-getownpropertysymbols.js`:
  `TypeError: Proxy ownKeys trap result must be an object`.

Their error strings are byte-identical in the original and candidate JSONL;
they are not a #6832 regression or a claimed #6832 gain.

The dedicated standalone fixture and its adjacent typed-array regression
fixtures passed with a durable `pipefail` log: 4 files / 39 tests
(`#6832` 19, `#6651-e6` 7, `#2872` 9, and `#4394` 4). This covers own and
prototype accessors, borrowed generic calls, clone shapes with and without a
presence gate, dense and sparse Arrays, callback identity and order, reducers,
mutation visibility, detachment, live tracking length, and host-free imports.

Maintained direct source gates passed with their durable log:
`check-import-cycles`, compiler-boundaries inventory, flat-directory budget,
LOC budget (+116 LOC permitted), function budget, host-import policy,
codegen-fallbacks, oracle ratchet, coercion-sites, and speculative-rollback.
The value import did not grow the import-cycle ratchet and inventory reported no
errors. The package runner's install check was intentionally not used because
the provisioned `node_modules` is a read-only link to the primary checkout;
the same maintained scripts ran directly with the pinned Node runtime and made
no dependency change.

These receipts are scoped evidence only. They do not project, claim, or imply a
full Test262-suite result.

## Acceptance and Handoff

- Direct dynamic `%TypedArray%.prototype` `forEach`, `every`, `some`, `reduce`,
  and `reduceRight` now use the live internal in-bounds length through a
  typed-only clone; the detached-view guard remains in the direct dispatcher.
- `Array.prototype.<method>.call(view, ...)` stays on the generic helper and
  retains observable `LengthOfArrayLike` and `HasProperty` behavior.
- No global `__extern_length` behavior, Array-method source, IR, runner,
  corpus, baseline, or audit-control source was changed.
- Ephemeral wrappers, manifests, logs, reports, and JSONL receipts stay
  untracked; the reviewable change set is limited to the HOF source, this issue
  record, and the focused fixture.
- Model provenance is truthful: `Model: Codex Unreported Unreported`.

### Landed completion — 2026-10-02

The completed scoped fix was published non-draft in
[PR #6447](https://github.com/loopdive/js2/pull/6447) at
`94d8361a6b2ab0a2ea769ce8c3971367048c9b03`, passed normal publication gates,
and landed on upstream main through
`cd123eca318c12a8480e8a69383ddfd50d6e4db4`. The measured acceptance above
supports closing this five-method slice, not the parent 11,778-path goal.
Separate find/findIndex/join/toLocaleString failures remain out of scope and
were remeasured as four failures alongside three passing original controls.
