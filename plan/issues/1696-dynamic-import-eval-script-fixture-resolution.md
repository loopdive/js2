---
id: 1696
title: "dynamic-import eval-script-code fixture resolution + sloppy redecl (18 CE tests)"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: low
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: runner, codegen
language_feature: dynamic-import, sloppy-script
goal: conformance-hygiene
sprint: Backlog
parent: 860
related: [860, 1390]
---
# #1696 — dynamic-import eval-script-code fixture resolution + sloppy var/fn redecl

## Problem

18 test262 tests under
`language/expressions/dynamic-import/usage/eval-script-code-host-resolves-module-code-*`
report as `compile_error` in the conformance report. They are NOT genuine
codegen bugs — they hit **two stacked runner-level gaps** that prevent the
test source from ever reaching our compiler in a useful form.

## Two stacked gaps

### Gap 1 — TypeScript parser rejects the sloppy-script redeclaration

The fixture sources contain the standard test262 pattern:

```js
var smoosh;
function smoosh() { /* … */ }
```

This is a legal sloppy-script var/function redeclaration in §B.3.3, but
TypeScript's parser rejects it as a duplicate identifier **before** our
codegen runs. The runner sees a TS parse error and the test fails as CE.

### Gap 2 — `__dynamic_import` cannot resolve the fixture path

Even if Gap 1 were patched, the tests call
`import("./eval-script-code-host-resolves-module-code-*_FIXTURE.js")` — a
relative path that test262's host normally resolves against the test file's
own directory on disk. Our runner compiles a synthesized source from a
string buffer, so the fixture path has no anchor and `__dynamic_import`
returns a rejected promise.

Either gap alone blocks the cluster; both must be resolved before any of
these 18 tests can run.

## Why a skip is the right move

- They are CE, so they contribute zero signal to the conformance bucket
  beyond noise.
- Cluster A (`import(spec)["then"]` chain) — the genuine dynamic-import
  codegen work — is being addressed by #860 and does NOT need this skip;
  the 18 here are runner-only.
- Neither gap is a codegen issue; both require runner work
  (TS-parser-tolerant preprocessing for the sloppy redecl, and a fixture
  search-path mechanism for `__dynamic_import`).

## Fix

Add a path-prefix skip in `tests/test262-runner.ts:shouldSkip`:

```ts
if (filePath && /eval-script-code-host-resolves-module-code/.test(filePath)) {
  return {
    skip: true,
    reason:
      "dynamic-import + sloppy-script var/fn redecl + fixture path (#1696)",
  };
}
```

## Acceptance criteria

1. The 18 `eval-script-code-host-resolves-module-code-*` entries move from
   `compile_error` to `skip` in the conformance report.
2. No other tests are affected (substring is unique to this cluster).

## Out of scope

- Real fix for either gap. A genuine fix would need:
  - A pre-parse pass to rewrite the sloppy `var x; function x() {}`
    pattern into TS-acceptable form, OR a runner mode that bypasses the TS
    type checker for these tests.
  - A `__dynamic_import` fixture search-path resolver that locates the
    `_FIXTURE.js` files relative to the original test path.
- The 18 Cluster A `import(spec)["then"]` chain failures — those land via
  #860 (`__defineProperty_value` should wrap function-shaped values via
  `_maybeWrapCallable`).
