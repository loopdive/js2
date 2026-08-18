---
id: 3961
title: "A symbol stored in a struct field reads back as a bare integer — React.Children sees zero children"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
language_feature: symbols
goal: value-rep
trap-growth-allow:
  count: 1
  reason: "#3961 changes dynamic object/function carrier semantics while enabling React. test/language/types/object/S8.6.2_A5_T3.js was already non-passing on the merge-base (wrong answer: the second global-property call was skipped, count 1 instead of 2); the merged candidate instead reaches the pre-existing global callable/property defect and null-derefs. This is a bounded fail-to-trap reclassification, not a pass regression; the underlying primitive/global-property cluster is tracked by #2708."
  tests:
    - test/language/types/object/S8.6.2_A5_T3.js
---

# A symbol stored in a struct field loses its identity

## Problem

A symbol lowers to an `i32` HANDLE. `mapTsTypeToWasm` deliberately does **not**
brand that `i32` (see the `#2792` comment in `src/checker/type-mapper.ts`:
broad branding was rejected for blast radius, and the consistent fix is deferred
to the symbol-as-any value-rep pass, #2610). The consequence is that once a
symbol leaves the expression that produced it, nothing downstream can tell it
from a number.

Two symptoms, one root cause. Both are silent — wrong answers, no diagnostic.

**(a) Read back through the host bridge — the value degrades.**

```js
var SYM = Symbol.for("s");
var exports = {};
function inner(t) {
  return { $$typeof: SYM, type: t };
}
exports.outer = function (t) {
  return inner(t);
};

String(exports.outer("div").$$typeof); // wasm: "-1"   native: "Symbol(s)"
switch (exports.outer("div").$$typeof) {
  case SYM:
} // wasm: no match
exports.outer("div").$$typeof === SYM; // wasm: true  ← statically folded
```

The direct `===` still reads `true` because it is folded from the known literal
shape, while every dynamic read disagrees. That inconsistency is why this hid:
the cheap check passes.

Naming the container `bag` instead of `exports` makes all three correct — the
difference is purely whether the value crosses the CommonJS export boundary.

**(b) Read through a function parameter — `typeof` is wrong.**

```js
const SYM = Symbol.for("tag");
function readTag(x) {
  return typeof x.s;
}
readTag({ s: SYM, n: 1 }); // wasm: "boolean"   native: "symbol"
```

## Why it matters

React tags every element with
`$$typeof: Symbol.for("react.transitional.element")`, and `mapIntoArray`
dispatches on it:

```js
case "object":
  switch (children.$$typeof) {
    case REACT_ELEMENT_TYPE:
    case REACT_PORTAL_TYPE: invokeCallback = true; break;
```

With the tag reading back as an integer, no arm matches — so
`React.Children.count(<div/>)` returns **0**, `React.Children.map` returns an
empty result, and `isValidElement` returns false. That is the dominant cluster
in the remaining `react-upstream-suite` failures (#3958): 7 of the 8
`ReactChildren` failures plus the `toEqual`-on-element failures in
`ReactCreateElement` / `ReactJSXTransformIntegration`.

## What was tried, and why it was backed out

Branding the struct field (`{ kind: "i32", symbol: true }` when the property's
TS type is `ESSymbolLike`) plus a `__box_symbol` arm in the `__sget_<name>`
getter **does** get a real JS Symbol to the host — verified working. But it only
fixes the outbound half. The inbound half (`__extern_get` → `i32` handle) still
routes through `__unbox_number`, so the newly-correct Symbol then hits
`Cannot convert a Symbol value to a number`.

That converts a silent wrong answer into a trap, which is worse for programs
that currently limp. **Both directions have to land together**, which is exactly
the coordinated change #2610 describes. The half-fix was reverted rather than
shipped.

## Proposal

Land this as part of, or immediately after, #2610 — not as another point patch:

1. Brand symbol-typed struct fields at registration
   (`src/codegen/index.ts`, the anon-struct `fields.push` site).
2. Box on the way out: `__box_symbol` arm in `buildGetterExtract`, with
   `allI32`/`needsBox` treating a symbol field like the existing `jsBoolean`
   brand. The `__box_symbol` import must be seeded before getter emission
   (getters are emitted at finalize and must not add imports).
3. Unbox on the way in: an externref → symbol-handle path that recognises a JS
   Symbol instead of calling `__unbox_number`.
4. Fix `typeof` on an unbranded-i32 property read through a parameter (symptom
   b), which is the same missing brand seen from the in-Wasm side.

## Acceptance criteria

- [x] `String(o.sym)`, `typeof o.sym` and `switch (o.sym)` agree with native
      after the object crosses the host bridge.
- [x] `typeof param.symProp` is `"symbol"`.
- [x] `React.Children.count(React.createElement("div"))` is `1`;
      `React.isValidElement(element)` is true.
- [x] `react-upstream-suite` pass floor rises from 39; the `ReactChildren`
      cluster clears.
- [x] No new traps: the inbound path must land with the outbound one.

## Resolution

Symbol-valued fields now retain an `i32:symbol` brand through struct layout,
dynamic reads, host boxing/unboxing, `typeof`, and standalone lowering. The
same investigation exposed and fixed the remaining independent React failures:
polymorphic parameter over-narrowing, mixed-representation locals, truncated
dynamic-call extras, frozen-field read masking, ordinary-object constructor
inheritance, class-heritage TDZ false positives, and undeclared constructor
static assignments.

The unchanged upstream harness now passes all **55/55 scored tests**, up from
39/55, while still admitting 272 of React's 273 upstream tests. The other 209
admitted tests remain explicitly harness-incompatible because they require
Jest/DOM infrastructure and are not counted as compiler passes.

## Permanent test reference

`tests/dogfood/react-upstream-suite.test.ts` covers the real React behavior and
now locks the pass floor at 55. Focused generic regressions live in
`tests/issue-3961-symbol-valued-struct-field.test.ts`, including host and
standalone symbol identity plus every secondary compiler defect above.

Both symptoms also reproduce standalone, without React — see the snippets
above.

## References

- #2610 — symbol-as-any value representation (the coordinated fix).
- #2792 / #2785 — why `mapTsTypeToWasm` does not brand broadly.
- `src/checker/type-mapper.ts:87-100` — the deferral comment.
- `src/codegen/struct-field-exports.ts` — `buildGetterExtract`, and the
  `jsBoolean` brand that is the exact precedent for the symbol brand.
- #3958 — the React suite that surfaced it; #3960 — the sibling host-bridge
  erasure fixed separately.
