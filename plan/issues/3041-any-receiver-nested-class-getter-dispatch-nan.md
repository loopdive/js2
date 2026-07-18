---
id: 3041
title: "get-accessor via an any-typed receiver on a class declared inside a function returns NaN/undefined (dynamic accessor dispatch gap)"
status: done
assignee: ttraenkler/dev-conform
sprint: current
created: 2026-07-05
updated: 2026-07-17
completed: 2026-07-17
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
language_feature: classes, accessors, dynamic-dispatch
goal: spec-completeness
related: [3039, 634, 1395]
# (#3102) The dynamic-read accessor routing lives in the any-receiver terminal
# of this god-file; the condition + minimal comment grow it a few LOC.
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
---

# #3041 — get-accessor via `any` receiver on a nested class returns NaN (dynamic accessor dispatch gap)

Split out from #3039 (the accessor boxed-capture fix) as an explicitly-separate,
pre-existing bug. It is **orthogonal to captures** — a getter returning a
**constant** hits it too.

## Symptom

A `get` accessor invoked through an **`any`-typed receiver**, where the class is
**declared inside a function** and the instance is returned out, reads NaN /
undefined instead of running the getter:

```ts
// all return NaN via the any-receiver + nested-class shape:
function make() { class K { get v(): number { return 42; } } return new K(); }
const o: any = make();
o.v;                       // NaN — getter body never runs (constant! no capture)

function make2() { class K { x: number = 7; get v() { return this.x; } } return new K(); }
(make2() as any).v;        // NaN — own-field getter, also NaN
```

Contrast (these WORK, proving it is the dynamic *getter dispatch*, not the class
or the value):
- **Static** dispatch (typed receiver / top-level class): `class K { get v(){...} }`
  read via `o: K` or a top-level `new K()` → correct.
- A **method** (not a getter) via the same `any` receiver + nested class:
  `class K { v(){ return 42; } }; (make() as any).v()` → correct (42).

So the gap is specifically: **dynamic property GET that must resolve to a
get-accessor** on a WasmGC struct instance reached via an `any` receiver, for a
class compiled inside a function. The dynamic-get path returns the field/default
(NaN) instead of dispatching to the accessor's `__cb`/getter function.

## Why filed separately (not folded into #3039)

Confirmed pre-existing and capture-independent (the constant-getter case above
has no capture). #3039's additive `capturedBoxGlobals` branches are no-ops for
non-boxed names, so #3039's codegen for these cases is byte-identical to main —
#3039 does NOT introduce or fix this. #3039's boxed-capture getter READ fix is
proven via the **static-dispatch** getter (→ correct) and the
method-read-via-any (→ correct); only the `any`-receiver *accessor dispatch*
remains.

## Acceptance

- `(make() as any).v` invokes the getter (constant, own-field, and captured
  variants) for a class declared inside a function.
- No regression in `getters-setters` / `accessor-side-effects` / dynamic
  property-access suites.

## Notes

- Look at the dynamic property-GET dispatch for local-class struct instances
  reached via `any` (the `__get_member_<name>` / `__cb` accessor path vs the
  plain struct-field/default read). Compare against the working **method**
  dispatch on the same receiver shape — methods resolve, accessors don't.

## Resolution

Root cause: the dynamic property-GET path had struct-field arms
(`findAlternateStructsForField`) and #2963 class-method arms, but NO arm for a
get-accessor — whose value is COMPUTED by the `${Class}_get_<prop>` getter
function, not stored in a struct slot. So a getter reached via an `any` receiver
fell straight through the `__get_member_<name>` dispatcher's `__extern_get`
terminal → `undefined` (→ NaN in an f64 context).

Fix (mirrors the #2963 method-arm shape and the static
`compilePropertyAccess`/`finalizeStructAndDynamicMemberGet` accessor branch):

- `src/codegen/member-get-dispatch.ts` — new `classAccessorCandidatesForProp`
  enumerates every non-static class get-accessor for a prop (struct type idx,
  getter funcIdx, boxed return type, inheritance depth for children-first
  ordering). `fillMemberGetDispatch` prepends accessor ARMS to the dispatcher:
  `ref.test $Struct` → `ref.cast $Struct` → `call getter` → box the return up to
  the dispatcher's uniform externref (boolean-branded i32 via `__box_boolean`,
  everything else via the coercion engine — funcMap-read-only, box helpers
  registered at reserve). Enumerated at FILL time (no reserve-time minting — a
  getter is a plain `(ref $Struct) -> ret` already registered at class codegen).
- `src/codegen/property-access-dispatch.ts` — the `isExternObj` any-read
  terminal only routed through the dispatcher when a class METHOD of that name
  existed; extended the condition to ALSO route when a class GET-ACCESSOR of that
  name exists (else it emitted a bare `__extern_get`, bypassing the dispatcher
  entirely for accessor-only props).

## Test Results

`tests/issue-3041.test.ts` — 9/9 pass: constant getter, own-field getter,
captured-variable getter, string-returning getter, boolean-brand-preserving
getter, override-getter (subclass wins), inherited getter (via subclass
instance), plus the two working-baseline regression guards (static dispatch,
method-via-any).

No regressions in the accessor-critical suites (all pass isolated):
`accessor-side-effects`, `issue-3039`, `issue-2963-method-value-identity`,
`issue-2992-accessor-merge`, `issue-2580-...-defineproperty-accessor`,
`object-literal-getters-setters`. `npx tsc --noEmit` clean; prettier clean.
(Pre-existing `string_constants` instantiate failures in `getters-setters`,
`class-expression(s)` are a stale test-harness issue on the clean tree — not
introduced by this change.)
