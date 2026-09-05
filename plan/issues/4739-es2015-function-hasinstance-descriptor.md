---
id: 4739
title: "ES2015 standalone Function.prototype @@hasInstance descriptor"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: function-prototype, symbol-hasInstance, descriptors
goal: standalone-gap
assignee: ttraenkler/es6_next_residual_wave19
related: [4676, 2175, 4265]
origin: "Current ES2015 residual snapshot and exact host/standalone verification on upstream/main 3809cc76e3."
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/native-proto-own-props.ts
---

# #4739 — standalone `Function.prototype[Symbol.hasInstance]` descriptor

## Scope

Own the smallest current ES2015 residual candidate:
`test/built-ins/Function/prototype/Symbol.hasInstance/prop-desc.js`.
The host lane passes on current upstream/main, while standalone currently
reports `typeof Function.prototype[Symbol.hasInstance] === "undefined"`.
The test then verifies the non-writable, non-enumerable, non-configurable
descriptor. Related `@@hasInstance` value/dispatch rows are controls and are
not part of this issue unless the narrow fix requires them.

## Plan

1. Reproduce the exact host and standalone result on current upstream/main,
   using the interpreter refusal provider only for this non-eval test.
2. Trace the direct symbol read and descriptor lookup, then add the narrowest
   standalone lowering that exposes the existing native method singleton and
   exact descriptor without widening generic symbol/property behavior.
3. Add a focused issue test plus sibling value and descriptor controls.
4. Run the exact test262 row, focused controls, TypeScript 5/7 checks, scoped
   lint/format, and repository hooks. Record all commands and results here.

## Baseline (upstream/main `3809cc76e3`, 2026-08-25)

The baseline JSONL snapshot is `/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`,
timestamped `25.8.2026, 04:31:12`. The selected ES2015 row is current in the
snapshot and is not in the excluded #4680–#4738/open-PR scopes.

| lane | result | observation |
| --- | --- | --- |
| host | pass | `runTest262File` completes with wasm SHA `5c089a71ca7a` |
| standalone | fail | `Test262Error` at L13: expected `typeof Function.prototype[Symbol.hasInstance]` to be `"function"`, got `"undefined"`; wasm SHA `bf988f8f318b` |
| standalone controls | pass | `value-positive.js`, `value-negative.js`, `value-non-obj.js`, and `this-val-bound-target.js` |

The standalone run used `JS2WASM_EVAL_ENGINE=interpreter` with the refusal-only
provider, which is permitted for this non-eval diagnostic and keeps the
compiler/runtime result deterministic.

## Test Results

All runs below used the isolated worktree at upstream/main `3809cc76e3`.

| check | result |
| --- | --- |
| exact host `prop-desc.js` | pass |
| exact standalone `prop-desc.js` (`JS2WASM_EVAL_ENGINE=interpreter`, refusal-only provider) | pass |
| standalone controls: `value-positive.js`, `value-negative.js`, `value-non-obj.js`, `this-val-bound-target.js` | pass, pass, pass, pass |
| focused `tests/issue-4739-function-hasinstance-descriptor.test.ts` | 2/2 pass |
| existing `tests/issue-4676-function-prototype-hasinstance.test.ts` controls | 3/3 pass |
| TypeScript 5 `node node_modules/typescript/lib/tsc.js --noEmit` | pass |
| TypeScript 7 `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json` | pass |
| Biome scoped lint | pass |
| Prettier scoped check | pass |

The nearby `this-val-not-callable.js` control remains a pre-existing
`Function.prototype.call` standalone refusal and is outside this descriptor
slice. Production changes are 180 net lines across the two allowed codegen
files, within the 180-line budget; the issue test and this record are separate.
