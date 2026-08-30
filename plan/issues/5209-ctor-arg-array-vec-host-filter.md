---
id: 5209
title: An array-literal constructor argument reaches the host extern-method dispatcher as a compiled vec — `.filter` throws "filter is not a function"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5209 — `.filter` on a constructor argument dispatches against a compiled vec

## Problem

Tenth Temporal module-init blocker (#4628). With the full fix stack plus the
#5207 fix (PR #5279), the polyfill advances past "Invalid era data" and stops
at:

```
TypeError: filter is not a function
    at src/runtime.ts:14131          (extern-method dispatcher "no arm matched" throw)
    at invokeReusable                 src/runtime/fixed-extern-method-call.ts:27
    at GregorianBaseHelper_init ← OrthodoxBaseHelper_init ← EthiopicHelper_init ← __module_init
```

Source: the polyfill's `n.filter((e => null != e.reverseOf)).length > 1`
guard. `moduleInitRuns` stays false.

## Reduced repro (dev-5207, verified pre-existing on pristine origin/main; no IIFE involved)

```js
class HelperBase { constructor() {} }
class G extends HelperBase {
  constructor(e, t) { super(); this.eras = t.filter((x) => x.code); }
}
class Sub extends G { constructor(e, t) { super(e, t); } }
new Sub("c", [{ code: "a" }, { code: "b" }]);
// js2wasm: TypeError: filter is not a function · native: works
```

An array literal passed through a derived-class constructor chain arrives at
the `.filter` call site as a compiled vec struct, and the host extern-method
dispatch path (`fixed-extern-method-call.ts`) has no arm for it. Likely fix
direction: either keep the value on the compiled path (compiled `.filter` on
vecs exists) — the dispatch decision is wrongly routing to the host — or
marshal the vec before host dispatch. Decide with evidence; prefer the
compiled path (order-preservation, no host round-trip).

## Acceptance criteria

1. Reduced repro passes host AND standalone; also the polyfill's exact
   `.filter(cb).length` shape and a plain non-class control
   (`function f(t){ return t.filter(x=>x.code); }`). New
   tests/issue-5209-*.test.ts failing on base.
2. Temporal harness measured before/after on the full stack (#5252 → #5258 →
   #5262 → #5264 → #5266 → #5271 → #5279 → this). Advances past
   `filter is not a function`; new later blocker → report precisely for
   filing (coordinator allocates ids); `moduleInitRuns` true → say so LOUDLY.
3. No regressions in issue-5207 tests, array-method scoped runs, equivalence
   shards touching arrays (name them). Gates green.

## Notes

- Found by dev-5207 while validating PR #5279; pre-existing on origin/main
  (unmasked by the #5207 fix, not caused by it).
- Sibling #5210 covers the separate wasm-validation defect found at the same
  time.
- Id #5209 reserved with a degraded PR scan; manually verified against open
  PR head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.
