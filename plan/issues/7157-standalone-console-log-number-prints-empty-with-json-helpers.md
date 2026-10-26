---
id: 7157
title: "Standalone: console.log of a number prints an empty line once the JSON helpers are linked into the module"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7149, 7147, 2788]
---

# #7157 — standalone `console.log(1)` prints `""` when `JSON.stringify` is also used

Found while implementing #7149 (PR #6912); #7147's and #7148's tests worked
around the same symptom by logging strings only. Pre-existing on `origin/main`,
standalone target (`target: "standalone", hostBridge: "always"` in the test
harness; verify with and without `hostBridge`):

```js
console.log(1);                 // prints an empty line   (node: "1")
console.log("a", 1);            // prints "a "            (node: "a 1")
console.log(JSON.stringify({}));// "{}" — fine; its presence triggers the bug
```

Without the `JSON.stringify` call the same `console.log(1)` prints `1`.

## Cause (as diagnosed; verify before fixing)

Linking the JSON helpers changes which `console.log` lowering the number
argument takes (`compileConsoleCall` in `src/codegen/expressions/builtins.ts`,
the `console_${method}_number` f64 path vs. the generic externref path that
`__extern_toString`s its argument). On standalone with the JSON helpers present
the generic path appears to receive a boxed number whose standalone
`toString` arm yields the empty string, or the f64 import is shadowed by a
late-added helper (function-index shift, cf. `addUnionImports`). Diff the WAT
of the two programs (with / without the `JSON.stringify` call) around the
`console.log(1)` call to find which.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs above with `--standalone`, and with
   `hostBridge: "always"` / `"off"`; dump WAT for `console.log(1)` with and
   without the `JSON.stringify` call and name the differing instructions.
2. Fix at the lowering site so a number argument prints via the same
   number-to-string conversion `String(n)` uses on standalone, regardless of
   which other helpers are linked; multi-argument calls join with a single
   space. No new host imports.
3. Tests: `tests/issue-7157-standalone-console-number.test.ts` with the three
   programs plus `console.log(1.5, -0, NaN, Infinity)` and a number inside a
   template, on standalone (both `hostBridge` values) and gc native-first vs
   node; then drop the `String(n)` workaround in
   `tests/issue-7149-json-stringify-private-fields-only-instance.test.ts`.

Acceptance: the three programs print node's output on standalone; host-assisted
gc bytes unchanged; equivalence gate reports no new regressions.
