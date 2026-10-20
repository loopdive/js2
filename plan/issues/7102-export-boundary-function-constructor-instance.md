---
id: 7102
title: "Regime gap: an instance of a plain function constructor returned across the export boundary reads as `{}` through `wrapExports` (`ast.type` is `undefined`)"
status: ready
created: 2026-10-20
updated: 2026-10-20
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [6979, 7095, 7098, 1712]
---

# #7102 — function-constructor instances across the export boundary

Found by the S7-a landing (2026-10-20) while re-pinning
`tests/issue-1712-capture-closure-dispatch.test.ts` on the default profile.
On the native regime in a JavaScript environment, an object created by
`new F()` where `F` is a plain function constructor (the acorn AST-node
shape: `function Node(type) { this.type = type; }`) and returned from an
exported function arrives on the host as an empty object: `wrapExports`'
value adapter converts class instances and plain object literals but has no
arm for the function-constructor instance representation, so property reads
such as `ast.type` answer `undefined`. Under the retired `host-assisted`
profile the host object crossed by identity. This is the receiver-side twin
of the argument marshal gaps #7095/#7098.

## Plan

1. Measure: a `.tmp` probe on native-first (via `wrapCompiledExports`)
   against Node — return a `new F()` instance, a class instance, an object
   literal, and an array of `new F()` from an export; read a data property,
   a prototype method, `instanceof`-free identity (returning the same object
   twice must give the same host object); the same objects passed back into
   another export (round trip). Record which representations lose their
   properties.
2. Fix in the runtime value adapter (`src/runtime/*`, the export wrapper):
   give function-constructor instances the same host view the class-instance
   arm uses (property table + prototype chain), keyed on the object's shape
   tag; round-tripping must preserve identity. Wasm bytes must not change
   (runtime-only; hash the equivalence sources before/after).
3. Tests: a focused test under native-first vs Node; the dispatcher row of
   `tests/issue-1712-capture-closure-dispatch.test.ts` can then read the
   instance directly again.
4. Acceptance: equivalence gate "No new equivalence regressions";
   `check:host-import-policy` unchanged.
