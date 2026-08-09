---
id: 3996
title: "codegen: keep local indexes stable across package-entry emission"
status: in-progress
sprint: Backlog
created: 2026-07-30
updated: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: dogfood
related: []
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/call-identifier.ts
---

# codegen: keep local indexes stable across package-entry emission

## Problem

Packages:
- lodash 4.18.1 lodash.js: __cb_6
- redux 5.0.1 redux.mjs: observable
- moment 2.30.1 moment.mjs: normalizeObjectUnits

Failure: Binary emit error: RangeError: Codegen error: local index out of range — 19 (valid: [0, 15))

Derive local indexes from the final function layout after deferred imports, types, and import insertion.

Reproduce: pnpm run dogfood:lodash, pnpm run dogfood:redux, pnpm run dogfood:moment.

## 2026-08-09 measured Redux decomposition

On `origin/main` at `ed4ebd253f14aa`, the pinned Redux 5.0.1 entry failed before
binary emission in `observeState`: the lifted descendant called the ancestor's
capturing sibling `getState`, but the call used local indexes from the original
`createStore` frame. After forwarding the already-threaded captures through
the immediate `subscribe` frame, the next independent failure was Redux's
JSDoc-less `bindActionCreator(actionCreator, dispatch)`. Its returned function
resolved the local `dispatch` parameter to an unrelated bare-name nested
declaration and prepended that declaration's captures.

Fixing those two frame-selection defects exposed an invalid binary in
`combineReducers`' returned `combination` function:

```text
local.tee expected (ref null ...), found local.get of type i32
```

The name-only free-variable scan excluded function-scoped `var` but
intentionally did not exclude block-scoped declarations. Because the enclosing
function also had locals named `i` and `key`, `combination` spuriously captured
and boxed those outer slots even though every use resolved to its own
`for (let i ...)` / `const key`. The inner numeric `i` was then consumed through
the outer ref-cell type. The narrow correction uses checker declaration
identity only for same-name collision candidates and removes a capture only
when every real reference resolves inside the closure.

Measured result with all three corrections applied:

- Redux entry compile: success in 3.758 s
- binary: 38,710 bytes, `WebAssembly.validate` succeeds
- runtime differential: still unimplemented, so correctness remains
  **unverified** and this issue remains open
- focused regressions: 10/10 pass across `#1301`, `#4134`, and the new exact
  block-local-shadow case

Lodash and Moment remain separate residuals under the same package-frontier
umbrella; a Redux compile/validation win is not evidence that either is fixed.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
