---
id: 7095
title: "Regime gap: a user `declare function` import receives the raw native string carrier — `marshalPlatformArgs` only wraps `extern_class` imports"
status: ready
created: 2026-10-19
updated: 2026-10-19
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
related: [7091, 5385, 6979]
---

# #7095 — platform-arg marshal for declared host functions

Found by #7091 (2026-10-19). Under the native regime in a JavaScript
environment, string arguments to a host extern cross the boundary as the
native i16-array carrier and `src/runtime/platform-arg-marshal.ts`
(`marshalPlatformArgs`, from #6708) converts them to JS strings before the
host function runs. That marshal is applied only to `extern_class` imports
(DOM capabilities such as `document.createElement`). A user-declared host
function

```ts
declare function log(s: string): void;
log("hi");   // host receives an opaque Wasm struct, not "hi"
```

receives the raw carrier on both the legacy and the IR path. #7091 made the
IR claim such calls (the `string` parameter crosses as externref, as legacy
does), so the defect is now reachable from both producers and is a runtime
gap, not a lowering one.

## Plan

1. Measure: a `.tmp` probe with `declare function` imports taking `string`,
   `string[]`, a closure and a plain object, under native-first (JS
   environment, `wrapCompiledExports`) against `host-assisted`; record which
   argument kinds arrive converted and which arrive as carriers. Count the
   `tests/issue-2856-*` / `issue-3214-*` rows that exercise declared
   functions and fail today on the default profile.
2. Implement in the runtime: the import wrapper applies `marshalPlatformArgs`
   to every host import classified `platform-capability`, keyed on the
   module's declared signature (the WIT/extern-declaration metadata already
   records parameter kinds), not on the `extern_class` registration alone.
   Results that are `string` come back through the value adapter the IR
   already uses for DOM reads. Keep `extern_class` behaviour byte-identical.
3. Tests: a focused test under native-first comparing the host's received
   values with Node; re-point the affected `issue-2856`/`issue-3214` rows to
   the default profile once green.
4. Acceptance: equivalence gate "No new equivalence regressions"; no new host
   import; `check:host-import-policy` unchanged.
