---
id: 4384
title: "Moment runtime import resolves to adjacent declaration instead of JavaScript implementation"
status: in-progress
sprint: current
created: 2026-08-12
updated: 2026-08-13
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
  - src/resolve.ts
  - src/codegen/index.ts
  - src/codegen/async-frame.ts
  - src/codegen/closures.ts
  - src/codegen/closures/capture-source-slot.ts
  - src/codegen/closures/declaration-write-analysis.ts
  - src/codegen/closures/lifted-declaration-hoisting.ts
  - src/codegen/context/types.ts
  - src/codegen/function-declaration-observation.ts
  - src/codegen/property-nullish-read.ts
  - src/codegen/statements/nested-declarations.ts
  - src/runtime.ts
  - tests/dogfood/moment-upstream-suite.mjs
  - tests/issue-4384-merge-group-regressions.test.ts
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

- [x] An explicit import of `./implementation.js` with adjacent
      `implementation.d.ts` executes the JavaScript function body.
- [x] The declaration continues to provide its public type information.
- [x] Imported callable aliases remain live inside registered function-expression
      callbacks; no pre-initialization null is captured.
- [x] The unchanged Moment slice improves from 0/10 to 10/10 in Wasm while
      remaining 10/10 in Node.
- [x] Existing ambient-declaration-only behavior in `tests/issue-1282-*` remains
      unchanged.

## Reproduction

```bash
node --import tsx tests/dogfood/moment-upstream-suite.mjs --json
```

## Implementation status

The exact pinned slice now passes **10/10 in Wasm and 10/10 in Node**. All six
generated modules compile and validate. The implementation keeps the `.d.ts`
file as the type source while resolving the explicit `.js` entry to its runtime
body.

Reaching the real Moment bodies exposed generic runtime/codegen gaps rather
than Moment-specific substitutions. This slice also fixes:

- callable declaration hoisting and stable identity in lifted callbacks;
- forwarding a callee's outer capture when a caller has a same-named local;
- stable capture parameter slots after a body-local shadows that name;
- native Date values stored through dynamic/open-object paths;
- fixed host method dispatch through four arguments;
- dynamic call/apply, property, object-prototype, and fnctor identity paths
  exercised by the selected upstream tests.

The `days_in_year` test was the final failure. Its parser callback looked up a
token handler with a computed key and called it with four arguments, while a
same-named body-local `tokens` array hid the parser's outer token table. The
compiler now preserves the outer capture in its own leading slot and the host
method bridge admits arity four, so `YYYYDDD` correctly rejects `DDD=000`.

Validation:

- `node --import tsx tests/dogfood/moment-upstream-suite.mjs --json` — 10/10
  admitted original tests pass in Wasm; 10/10 pass in Node.
- focused compiler/runtime regressions cover explicit `.js` resolution,
  lifted-function capture shadowing, Date behavior, and host method arity four.

## Merge-queue regression remediation

The first merge-group attempts exposed broad function-value, callback receiver,
and borrowed-array regressions that the pull-request stub does not execute. The
follow-up keeps local/named self calls on their direct path, excludes declaration
syntax from function-value observation, preserves dynamic `valueOf` and custom
constructor dispatch, and passes hoisted callbacks as real closures.

The JS-host vector prototype bridge is deliberately limited to reflective
`slice.call(arguments, ...)`. Exposing the whole native `Array.prototype`
bypassed compiled sidecar properties; the exact Test262
`copyWithin/return-abrupt-from-this-length-as-symbol.js` canary now throws as
required while Moment's original `min`/`max` callbacks remain green.

Validation after the remediation:

- Moment pinned upstream slice: 10/10 Node, 10/10 Wasm; six of six modules
  compile and validate.
- Focused compiler/runtime suite: 49/49 before the final bridge narrowing; the
  expanded Moment file is 23/23 afterward.
- Exact Test262 canaries: JS-host `S13_A3_T1`, array `filter` callback routing,
  and symbolic-length `copyWithin`; standalone tail-call and array `every`
  receiver routing all pass.

The subsequent merge-group run found four JS-host pass regressions and six
ordinary-failure-to-Wasm-trap transitions. Async resume frames had rebuilt
source locals at new slots while nested declaration captures still read the
declaring frame's numeric slot. Host `arguments.callee.caller` also entered a
new nullish property route even though the host lane intentionally exposes the
unsupported extension as `undefined`.

The final remediation opts async resume frames into name-remapped capture
sources and keeps that routing narrower than the legacy capture rule. Stable
FunctionDeclaration values are now admitted in lifted frames only for acyclic,
scalar capture ABIs; reference/vector captures remain on statement-position
lowering. Captures written after a declaration use a live cell, preventing a
later callable alias from remaining null inside the closure.

Final focused validation:

- Exact Test262 pass regressions: `10.6-13-a-{2,3}` and
  `Array/fromAsync/async-iterable-input.js` pass; the await-using completion
  case passes through the same remapped async-frame route.
- Exact trap canaries: Array.fromAsync returns to its baseline assertion,
  three AsyncDisposableStack cases return to their baseline missing-builtin
  failures, and both TCO cases are ordinary `RangeError`s rather than Wasm
  null dereferences.
- Focused #4384 suites: 28/28 pass.
- Moment pinned upstream slice remains 10/10 Node and 10/10 Wasm, with all six
  generated modules compiling and validating.
