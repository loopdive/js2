---
id: 7098
title: "Runtime-marshal gap: a void event listener marshalled through `_wrapWasmClosureUnknownArity` returns a null-prototype object instead of `undefined`"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [7091, 7095, 6979]
---

# #7098 — return value of a marshalled void closure

Found by #7091 (2026-10-19) when making `tests/issue-3214-void-host-callback.test.ts`
green on the default profile. On the native regime in a JavaScript
environment, a closure passed to a platform extern (`el.addEventListener("click",
() => { … })`) is marshalled by the runtime's generic closure wrapper
(`_wrapWasmClosureUnknownArity` in `src/runtime/*`), which does not convert
the Wasm result: a `void` closure comes back as an empty null-prototype
object where the host-assisted lane's callback wrapper returned `undefined`.
Legacy and IR producers both reach the same wrapper. The affected
`issue-3214` row ("keeps multiple certified callback sites distinct in source
order") is pinned to `host-assisted` until this is fixed; S7 (#6979)
retires that pin, so this issue is an entry condition for it.

## Plan

1. Measure: a `.tmp` probe under native-first (JS environment via
   `wrapCompiledExports` with a stub `document`) for closures returning
   nothing, a number, a string, a boolean, an object, and a closure, as seen
   by the host; against `host-assisted` and Node.
2. Fix in the runtime wrapper: convert the closure's result through the same
   value adapter the exports use (undefined sentinel → `undefined`, boxed
   primitives → primitives, native strings → JS strings when the bridge is
   exported, cf. #7095), keyed on the closure's declared result kind when the
   manifest records it and on the value otherwise. Wasm bytes must not
   change (runtime-only).
3. Tests: a focused test; un-pin the `issue-3214` row and quote it green.
4. Acceptance: equivalence gate "No new equivalence regressions";
   `check:host-import-policy` unchanged.
