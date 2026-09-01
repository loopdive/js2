---
id: 5222
title: "Temporal.Now.* methods are lost across the provider boundary — \"function\" single-module, undefined through the linked provider"
status: done
completed: 2026-08-30
assignee: ttraenkler/dev-5222
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
# The module-aware un-marshal: two registries, the mint-time owner record at
# each of the six host-mirror sites, and the guard in `_unwrapForHost`. The
# comment block carries the cross-module rule this issue exists to state.
loc-budget-allow:
  - src/runtime.ts
  - src/runtime/wasm-struct-host-semantics.ts
func-budget-allow:
  - src/runtime.ts::_unwrapForHost
  - src/runtime.ts::wrapLinkedProviderValue
  - src/runtime.ts::_wrapForHost
---

# #5222 — `Temporal.Now.*` lost across the provider boundary

## Problem

`typeof Temporal.Now.instant` is `"function"` when the polyfill is compiled
as a single module, but `undefined` when reached through the #4628
compile-once linked provider (PR #5318). Linking-specific: `Now`'s methods
do not survive the cross-module value crossing. dev-temporal-wire called
this the strongest next follow-up — `Now` is a plain namespace object of
functions, so whatever drops its members likely affects other
object-of-functions exports crossing module boundaries.

## Acceptance criteria

1. `Temporal.Now.instant()` / `Temporal.Now.plainDateISO()` callable through
   the provider; new tests failing on base (provider lane) with the
   single-module control passing on base.
2. Identify and state the general rule (which value shapes lose members at
   the link boundary) — if broader than Now, file it, don't widen the fix
   silently.
3. No regressions in issue-4628 + package-linker (#2527-family) tests.
   Gates green.

## Notes

- Found by dev-temporal-wire validating PR #5318. Siblings #5221/#5223.
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.

## Root cause — the general rule

**Not Temporal-specific, and not an object-literal gap. It is the #4611
exit-boundary un-marshal firing across a module it does not own.**

Reduced with a throwaway npm package (`.tmp/probe-ns.mts`, no Temporal
anywhere) that exports `NS = { f(){…}, … }` and `OUTER = { Inner: { i(){…},
j: 8 }, top(){…} }`. Measured through `compileProject` with
`linkPlan.mode === "separate"`, against the same source compiled as one
module:

| probe                                       | linked (base) | single-module (base) |
| ------------------------------------------- | ------------- | -------------------- |
| `typeof NS.f`                               | `"object"`    | `"function"`         |
| `Object.getOwnPropertyNames(OUTER)`         | `Inner,top`   | `Inner,top`          |
| `Object.getOwnPropertyNames(OUTER.Inner)`   | `""`          | `i,j`                |
| `typeof OUTER.Inner.i`                      | `"undefined"` | `"function"`         |
| `OUTER.Inner.j`                             | `undefined`   | `8`                  |
| `OUTER.Inner.i()`                           | threw `i is not a function` | `7`    |

The chain:

1. `instantiateLinkedProviders` hands the consumer each provider export
   through `wrapLinkedProviderValue` → `_wrapForHost(value, providerExports)`.
   The result is a host **mirror** (a Proxy) whose every read is served by the
   **provider's** `__sget_*` / `__struct_field_names` / `__call_fn_*` exports.
   The raw WasmGC struct alone carries no decoder — those helpers are exports
   of one specific module.
2. Inside the consumer, `OUTER.Inner` is a property read on an externref, so
   it goes through the **consumer's** `__extern_get`.
3. `__extern_get` ends its host-object arm with
   `wsh.normalizeSandboxValue(…, _unwrapForHost)`, whose #4611 job is to strip
   a mirror back to the raw struct so private-field `ref.cast` dispatch keeps
   working when a value re-enters the module that owns it.
4. Here the value does **not** re-enter its owner. The consumer receives the
   provider's raw struct and has no decoder for it, so it reads as an opaque
   object with zero members.

Hence the two observable shapes, both above: **depth 1 survives** (the value
never passes through `__extern_get`) except that a function-valued member
answers `typeof "object"`, because it too was un-marshalled to its raw closure
struct; **depth ≥ 2 is erased outright**. `Temporal.Now` is exactly the depth-2
namespace-object-of-functions case.

Stated as a rule: *any* compiled value read out of a linked provider loses its
members, because the un-marshal is module-blind. It is not about object
literals, classes or functions specifically — those just differ in how visibly
they break.

## Fix

`src/runtime.ts` + `src/runtime/wasm-struct-host-semantics.ts`. Make the
un-marshal **module-aware** rather than suppressing it:

- `_hostMirrorOwnerExports` records, at mint time, which module's exports each
  host mirror was built against (`_wrapForHost`, the class-ctor mirror,
  `_wrapVecForHost`, `_wrapCallableForHost`, both closure bridges).
- `wrapLinkedProviderValue` registers the provider's exports object in
  `_linkedProviderExportSets` **before** wrapping, so the mirrors the proxy's
  get-trap mints lazily one level down are recognisable as foreign too.
- `_unwrapForHost(v, reader)` declines to un-marshal when the mirror's owner
  differs from the reader's exports **and** one of the two is a registered
  linked provider. `normalizeSandboxValue` passes the reader's callback state
  through.

Deliberately narrow: with no provider linked the registry is empty and a
`_anyLinkedProviderRegistered` flag short-circuits the check, so the
single-module lane keeps #4611's behaviour byte-for-byte. The reader's exports
are resolved only after a mirror is known to have a recorded owner, so
`__extern_get` (10k calls per `run()` on `mixed/csv-parse`, #3903) never pays
`getExports()` on the common path.

**Rejected alternative:** dropping the un-marshal for provider values
wholesale. That would re-break #4611's private-field dispatch inside the
provider's *own* module, where the round-trip is correct and required.

## Result

`Temporal.Now`'s key list is complete
(`@@toStringTag,instant,plainDateISO,plainDateTimeISO,plainTimeISO,timeZoneId,zonedDateTimeISO`),
`typeof Temporal.Now.instant` is `"function"`, and `Temporal.Now.instant()`
returns an object. Two further improvements fell out at depth 1:
`typeof Temporal.PlainDate` through the provider is now `"function"`, not
`"object"` (the #4628 harness assertions were updated accordingly).

**Not fixed here, with the control run that says why:**

- `Temporal.Now.plainDateISO()` is reachable and callable but the CALL throws
  `RuntimeError: dereferencing a null pointer` — **identically in the
  single-module shape** (`.tmp/probe-now-single.mts`, 2026-08-30). Same
  pre-existing intrinsic/`Object.create` gap as `Temporal.PlainDate.from`;
  that is **#5221**'s lane, deliberately untouched.
- `Temporal.Now.timeZoneId()` answers `"string"` single-module but throws the
  same null deref through the provider — a NEW, still linking-specific defect
  that survives this fix. The residual is in what `timeZoneId` *reaches* (the
  host `Intl.DateTimeFormat().resolvedOptions()` path, cf. #5206), not in the
  value crossing. Reported, not widened into this fix; both are recorded as
  `knownGaps` in `tests/dogfood/temporal-global-harness.mjs`.

## Tests

- `tests/issue-5222-linked-namespace-members.test.ts` — the non-Temporal
  reduction. The provider lane fails on base with exactly the table above; the
  single-module control passes on base. Verified by reverting only
  `src/runtime.ts` + `src/runtime/wasm-struct-host-semantics.ts`.
- `tests/issue-4628-temporal-global.test.ts` — adds `Temporal.Now` key list,
  `typeof …instant` / `…plainDateISO`, and `typeof Temporal.Now.instant()`.
- Regression: the #2527 linker family
  (`package-linking`, `provider-manifest`, `linker`, `issue-3520`, `issue-3521`,
  `issue-3765`, `issue-3782`, `issue-2928-*`, `issue-4260`, `issue-3451`,
  `issue-4628-class-value-prototype`). `issue-3451` (3) and `issue-4260` (2)
  fail **identically on base** — pre-existing, not caused here.
