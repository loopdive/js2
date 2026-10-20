---
id: 7099
title: "Regime gap: `p.then === undefined` (and `p.constructor === undefined`) compares true on a native promise receiver — the undefined-comparison path bypasses the `$Promise` dynamic read"
status: ready
created: 2026-10-20
updated: 2026-10-20
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [7092, 7090, 6979]
---

# #7099 — `=== undefined` on a native promise member

Found by #7092 (2026-10-20). After that fix a dynamic read of `p.then`,
`p.constructor` or `p[Symbol.toStringTag]` on a native promise receiver
answers the right value on native-first and standalone, but the comparison
form `p.then === undefined` still evaluates to `true` (so does
`p.constructor === undefined`). The equality-with-`undefined` lowering takes
a different path from the plain member read: it tests the receiver's own
property table (or a specialised "missing member" probe) and never reaches
the `$Promise` arm of `__extern_get` that the read uses. The same path
answers `typeof p.then === "undefined"` wrongly where the comparison is
folded.

## Plan

1. Measure: a `.tmp` probe on native-first (JS environment via
   `wrapCompiledExports`) and standalone against Node — `p.then ===
   undefined`, `p.then == null`, `p.then !== undefined`, `typeof p.then`,
   `p.then ? 1 : 0`, `!!p.then`, the same for `constructor` and
   `Symbol.toStringTag`, for `p = new Promise(...)`, `Promise.resolve(1)` and
   `Promise.withResolvers().promise`; also a plain user object and a Map to
   confirm the comparison path is promise-specific. Record which forms are
   wrong and which lowering they take (`src/codegen/expressions/` equality /
   `undefined`-comparison helpers vs. `promise-dynamic-member-read.ts`).
2. Fix: the undefined-comparison and truthiness lowerings route a member
   read whose receiver may be a `$Promise` through the same dynamic read the
   plain form uses (provider code, or a routing-only edit in the comparison
   helper, which the direct-AST freeze allows); keep every binary that never
   compares a promise member byte-identical.
3. Tests: a focused test under native-first and standalone vs Node; extend
   `tests/issue-7092-promise-constructor-member-read.test.ts`.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; `check:host-import-policy` unchanged.
