---
id: 4387
title: "ES5: retain Array-valued live fnctor prototypes across `$Object` reconstruction"
status: ready
pr: 4423
assignee: ttraenkler/codex-es5-array-cluster
sprint: current
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, ir
language_feature: arrays, prototype-chain
goal: es5-conformance
related: [3772, 4163]
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
---

# #4387 — Array-valued fnctor prototypes must survive reconstruction

## Problem

Seven current standalone <=ES5 Test262 files fail with `called value is not a
function`:

- `built-ins/Array/prototype/filter/15.4.4.20-6-2.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-3.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-4.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-5.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-6.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-7.js`
- `built-ins/Array/prototype/filter/15.4.4.20-6-8.js`

They share one shape:

```js
F.prototype = new Array(1, 2, 3);
function F() {}
var value = new F();
value.length = false;
var result = value.filter(function () {});
```

This family originally landed under #3772. #4163 later widened fnctor
reconstruction to module-global externref bindings. The reconstructed `$Object`
can retain only an open `$Object` in its typed `$proto` slot; an Array carrier is
therefore replaced with null by `__object_create`. The existing shared
closed-method dispatcher still knows how to recognize a raw fnctor whose live
prototype is an Array, but reconstruction removes that evidence first.

## Direction

Extend the frozen whole-program fnctor verdict with a conservative positive
proof for exactly one unconditional top-level `F.prototype = <Array>` write.
Those sites retain the raw fnctor representation; all aliases, conditional or
multiple assignments, and shadowed `Array` bindings remain "unknown" and keep
the existing reconstruction decision.

The runtime semantics remain shared with IR: an IR-owned exported function must
call `filter` through the existing symbolic dynamic-method provider against the
same retained carrier, with no legacy-only duplicate implementation.

## Acceptance

- [x] All seven focused standalone Test262 files pass (`0/7 -> 7/7` against
      exact `origin/main` `8c9f8896807300`).
- [x] No focused pass-to-fail transition.
- [x] The four standalone #3772 regression assertions are green again. The
      pre-existing host-only inherited-filter assertion remains outside this
      standalone slice.
- [x] An exported function that performs the inherited `filter` call is
      genuinely emitted through IR (`irCompiledFuncs`) with no post-claim error.
- [x] Shadowed `Array`, aliases, computed writes, and multiple prototype
      assignments do not receive the
      positive proof.
- [x] Typecheck, issue, IR fallback, LOC/function budget, and focused tests pass.

## Verification

- Exact detached `origin/main` (`8c9f8896807300`) standalone Test262 control:
  `0/7` pass.
- Candidate standalone Test262 result on the same seven files: `7/7` pass.
- `pnpm run typecheck`
- `pnpm run check:ir-fallbacks`
- `pnpm run check:loc-budget`
- `pnpm run check:func-budget`
- `pnpm run check:issues`
- Focused Vitest: 26 passed, 1 host-only assertion intentionally skipped.
- The two already-red standalone #3014 local-function assertions remain red on
  both exact base and candidate; this slice introduces no transition there.
