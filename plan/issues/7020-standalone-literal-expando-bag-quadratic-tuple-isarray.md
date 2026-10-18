---
id: 7020
title: "standalone: cookie's 63,528-test stringify file times out — expando writes on closed object literals (`positive.not = {…}` in every expect()) land in the slotless `$ClosurePropEntry` registry, a never-pruned list walked by `ref.eq` (≈60% of runtime, quadratic); and once it runs, `Array.isArray` is false for tuple-typed rows read through `any`, so `it.each(Array<[string,string,string]>)` passes the whole tuple as `%s`"
status: in-progress
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: expando-properties, performance, tuples, Array.isArray
goal: standalone-gap
related: [4241, 7013]
# 2026-10-18 (#7020): one import + one call per file; the mechanism lives in the
# new modules anon-expando-bag-slot.ts / tuple-array-carrier.ts. The four hooks
# must sit at their existing seams (literal lowering, dynamic member write,
# finalize branding order, the `__extern_is_array` fill).
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/object-runtime.ts
# 2026-10-18 (#7020): +1 line each — the literal->struct record call and the
# slotted-roots spread entry; both are the single seam the helper NAME routes
# through (#4241), so splitting would move one line, not shrink anything.
func-budget-allow:
  - src/codegen/closure-props.ts::fillClosurePropHelpers
  - src/codegen/literals.ts::compileObjectLiteralForStruct
---

# cookie stringify: quadratic expando registry + tuple `Array.isArray`

Found by the [#7013](./7013-standalone-upstream-unit-lane.md) standalone
upstream unit lane. cookie passes 63,740/63,740 in the JS-host lane; standalone
the `src/stringify-cookie.spec.ts` file (63,528 of those tests) hits the
worker's 300 s execution deadline and produces no result.

## Finding 1 — quadratic expando registry (perf)

Profile of the first 20,000 tests (`node --cpu-prof`, 2026-10-16):

```
29.8% __closure_bag_lookup   ← __extern_set < __reflect_set < __upstreamExpect
29.4% __closure_bag_ensure   ← __extern_set < __reflect_set < __upstreamExpect
```

Per-test time grows linearly (500 tests: 0.07 s at the start, ≈10 s per 500
at test 38,000). `__upstreamExpect` builds `const positive = { toBe() {…}, … }`
and then writes `positive.not = {…}`, `positive.rejects = {…}`,
`positive.resolves = {…}`. `positive` is a closed literal struct without a
`$bag` slot, so each write goes to the SLOTLESS branch of
`fillCarrierBagHelpers` (`src/codegen/closure-props.ts`, #4241): a global
`$ClosurePropEntry` linked list, searched by `ref.eq` and never pruned. Every
`expect()` call appends an entry, so lookup cost is O(number of expect calls
so far) — the exact leak #4241 removed for closures, still open for literal
structs.

## Finding 2 — `Array.isArray` on a tuple carrier read through `any`

```ts
const cases: Array<[string, string, string]> = [];
cases.push(["a", "b", "c"]);
function isArr(x: any): number { return Array.isArray(x) ? 1 : 0; }
export function t1(): number { return isArr(cases[0]); }   // standalone 0, node 1
```

The shim's `it.each` checks `Array.isArray(row)` to decide whether to spread
the row into the callback; with a tuple carrier it wraps the row instead, the
test name prints `[object Object]` for `%s`, and `stringifyCookie({ key:
value })` receives `undefined` → `toEqual` mismatch (measured on the first
2,000 rows: 8 pass).

## Implementation Plan

1. **Registry.** Extend #4241's slotted-carrier set to closed literal structs
   that receive expando writes: either give `__anon_` literal struct roots the
   intrinsic `$bag` field (`INSTANCE_BAG_FIELD`, resolved by name in
   `slottedCarrierRoots`), or — cheaper and covering this shape — fold
   same-function expando writes (`o.k = v` immediately after `const o = {…}`,
   no escape in between) into the literal's declared fields at type inference.
   Prefer the slot: it fixes every literal, not just this idiom.
2. Prune or remove the slotless registry for any carrier that now has a slot;
   assert in a debug build that no `__anon_` struct reaches the slotless walk.
3. **Tuples.** Make `Array.isArray` (`ref.test` chain for the any-receiver
   path) recognise tuple carriers (`isTupleStruct` / the tuple registry), and
   check `Array.prototype` methods the shim uses on the same rows (`length`,
   index reads) behave as arrays.
4. Tests: a 50,000-iteration `expect()`-shaped loop must run in linear time
   (assert the second half takes < 3× the first half); the tuple repro; an
   `it.each` over tuple rows through the upstream shim.
5. Re-measure cookie with the #7013 lane.

### Plan revision (2026-10-18, implementation)

Measured before choosing between "slot every literal" and "fold same-function
writes": slotting EVERY `__anon_` struct changes the layout of every standalone
object literal (dozens of allocation sites, reflection, spread, record rebuilds)
for a defect that only literals receiving expando writes have. Taken instead:

1. **Record** (codegen): `compileObjectLiteralForStruct` maps each literal to
   its struct type; `compilePropertyAssignmentExternSet` (the dynamic write a
   non-field `o.k = v` reaches) marks the type when `o` is a binding initialised
   by such a literal (`ctx.oracle.variableDeclarationOf`, no raw checker).
2. **Commit** (`fillClosurePropHelpers`): eligible marked types join the #4241
   SLOTTED arm list with a future field index = current field count.
   Eligibility = `collectAnonymousExpandoDeleteCandidates`' screen (bare,
   not a supertype, single alias, above the brand anchor, not `noBrand`, not
   linked).
3. **Append** (first thing in `resolveAndRecordShapeBranding`, i.e. after ALL
   emission, before branding): append `$bag` to a CLONED field array (the
   `$shapeBrand` idiom — `ctx.structFields` never sees it, so no reflective
   surface can list it) and insert `ref.null extern` before every `struct.new`
   of the type (functions + global inits). Branding then sees the slotted
   layout and separates any new collision.
4. **Tuples**: `fillExternIsArray` (standalone only — the host carrier list is
   untouched) also tests `__tuple_N` types whose shallow layout collides with
   no non-tuple struct (a `[boolean]` tuple is canonically the boolean box).
5. gc byte-identity by construction (all three hooks are host-free gated),
   verified by hashing.

## Acceptance

cookie stringify-cookie.spec.ts produces a standalone result inside the
deadline and its BMP rows pass; gc binaries byte-identical.
