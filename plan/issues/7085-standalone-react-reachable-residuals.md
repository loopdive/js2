---
id: 7085
title: "standalone: the 5 host-free React upstream failures left after #7025 — a React element's `.constructor` reads `undefined` (3), an `@@iterator` child object is rejected (1), the regex-child error message reads `found: null` (1)"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: object-literals, iterators, regexp
goal: standalone-gap
related: [7025, 7013]
---

# Host-free React upstream failures left after #7025

After [#7025](./7025-standalone-react-upstream-harness-host-infra.md) the
standalone React upstream lane scores 77/180; 82 of the 180 scored tests are
reachable without a host carrier (jsdom, the host renderers / test utils).
Five of those 82 still fail, and all five are compiler defects (each passes in
the native oracle and in the JS-host lane):

| tests | failure | upstream test |
| --- | --- | --- |
| 3 | `expected undefined toBe [object Object]` | `ReactCreateElement` / `ReactJSXRuntime` / `ReactJSXTransformIntegration` › is indistinguishable from a plain object — `React.createElement('div', …).constructor` is `undefined` while `({}).constructor` is `Object` |
| 1 | `Objects are not valid as a React child (found: object with keys {@@iterator})` | `ReactChildren` › should be called for each child in an iterable with keys — React's `getIteratorFn` returns null for `{'@@iterator': function () {…}}` |
| 1 | `thrown error did not match: … (found: null)` | `ReactChildren` › should throw on regex — the message should name the regex, the compiled one says `null` |

Measured 2026-10-18, report `tests/dogfood/report/react-upstream-suite.standalone.json`
(`JS2WASM_UPSTREAM_TARGET=standalone node --import tsx tests/dogfood/react-upstream-suite.mjs`).

None reproduces in a small standalone snippet: a plain `{ $$typeof, type, key, props }`
literal answers `.constructor === Object`, and `getIteratorFn`'s exact shape
returns the `@@iterator` function. The element literals in React's
`ReactElement` are struct-typed, and `Object.getPrototypeOf(element) ===
Object.prototype` is `false` for such a literal in a probe — so the first row
is likely the struct-typed literal's missing `Object.prototype` link.

## Implementation Plan

1. Reproduce each row on one React batch with
   `DOGFOOD_REACT_FILTER='<test name>'` (standalone lane) and reduce React's
   `ReactElement` / `getIteratorFn` / `throwOnInvalidObjectType` to the
   smallest module that still fails.
2. Fix in the object-literal / property-read lowering for the standalone
   target; keep JS-host bytes identical.
3. Acceptance: the 5 rows pass; the lane reads 82/82 reachable.
