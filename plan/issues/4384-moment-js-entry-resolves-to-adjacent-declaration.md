---
id: 4384
title: "Moment runtime import resolves to adjacent declaration instead of JavaScript implementation"
status: ready
sprint: current
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: resolver, codegen
language_feature: module-resolution, declarations
goal: npm-library-support
assignee: ttraenkler/codex
related: [1282, 2930, 3747, 3995]
files:
  - src/codegen/index.ts
  - src/codegen/module-bindings.ts
  - tests/dogfood/moment-upstream-suite.mjs
---

# Moment runtime import resolves to adjacent declaration instead of JavaScript implementation

## Problem

The pinned Moment adapter imports the published `moment.js` implementation by
an explicit relative `.js` path. TypeScript correctly consults the adjacent
`moment.d.ts` for types, but the compiler also uses that declaration as the
runtime callable target. The generated closure therefore reads an uninitialized
function/module slot instead of the JavaScript implementation.

Observable result: all six selected generated modules compile and validate,
all ten unchanged callbacks pass in Node, and **0/10** pass in Wasm. The errors
are consistent with one null implementation: `moment.isDate`,
`moment.isMoment`, `clone`, `year`, and `normalizeUnits` are read from null; the
direct call case null-dereferences inside the first assertion.

Dynamic `hooks -> hookCallback.apply(null, arguments)` forwarding has already
been implemented and regression-tested. It does not change this result because
the wrong runtime value is installed before that forwarding path runs.

## Required behavior

Declaration pairing may supply types, but it must not replace a reachable
`.js` module's runtime value or source-qualified callable identity. Imported
bindings captured by callbacks must remain live views of that implementation.

## Acceptance criteria

- [ ] An explicit import of `./implementation.js` with adjacent
      `implementation.d.ts` executes the JavaScript function body.
- [ ] The declaration continues to provide its public type information.
- [ ] Imported callable aliases remain live inside registered function-expression
      callbacks; no pre-initialization null is captured.
- [ ] The unchanged Moment slice improves from 0/10 to 10/10 in Wasm while
      remaining 10/10 in Node.
- [ ] Existing ambient-declaration-only behavior in `tests/issue-1282-*` remains
      unchanged.

## Reproduction

```bash
node --import tsx tests/dogfood/moment-upstream-suite.mjs --json
```
