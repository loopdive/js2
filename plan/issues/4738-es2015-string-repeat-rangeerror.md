---
id: 4738
title: "ES2015 standalone String.prototype.repeat throws a bare string for invalid counts"
status: done
assignee: codex/4738-es2015-string-repeat-rangeerror
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: codegen
es_edition: 2015
language_feature: string-prototype-repeat
goal: standalone-mode
related: [733, 3922]
loc-budget-allow:
  - src/codegen/string-ops.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
origin: "Fresh ES2015 standalone residual from oracle-v13 JSONL snapshot; no open PR or existing owner"
---

# #4738 — ES2015 standalone `String.prototype.repeat` RangeError identity

## Scope

The two invalid-count tests in the ES2015 `String.prototype.repeat` directory
fail only in the standalone target:

```
test/built-ins/String/prototype/repeat/count-less-than-zero-throws.js
test/built-ins/String/prototype/repeat/count-is-infinity-throws.js
```

The native string method already validates the count and enters its RangeError
branch. That branch currently emits the message string directly through the
Wasm exception tag. `assert.throws(RangeError, ...)` therefore receives a string
and reports `Thrown value was not an object`, while the host lane constructs a
real RangeError through its host error path.

## Plan

1. Keep the existing ToIntegerOrInfinity and finite/non-negative validation.
2. Route the standalone validation branch through the canonical RangeError
   instance builder, preserving the existing host behavior and late-import
   index discipline.
3. Add focused regression coverage for both invalid counts, plus zero/count-
   coercion and ordinary repeat controls, in host and standalone lanes.

The intended production change is a narrow replacement of the hand-built throw
sequence in `compileNativeStringMethodCall`; the production delta must remain
within the default 180-net-LOC ceiling.

## Reproduction (upstream/main)

Branch base: `upstream/main` at `3809cc76e3ece099b77ec67ea5927c6950c09033`.
The supplied oracle-v13 snapshot is
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
(`25.8.2026 04:31:12` rows). The project unified runner, with the
interpreter/refusal provider for standalone, reports:

| Test | Host | Standalone |
| --- | --- | --- |
| `count-less-than-zero-throws.js` | pass | fail — `Thrown value was not an object!` |
| `count-is-infinity-throws.js` | pass | fail — same bare-string throw |

The standalone result reaches the test body; this is not a link/import refusal.

## Test Results

The implementation replaces only the hand-built bare-string throw with
`buildThrowJsErrorInstrs(ctx, "RangeError", ...)`, using the existing flush
path for host late imports. Production delta: 9 insertions, 4 deletions in
`src/codegen/string-ops.ts` (5 net lines; within the 180-net-LOC budget).

Focused project-runner command:

```text
JS2WASM_EVAL_ENGINE=interpreter node node_modules/vitest/dist/cli.js run \
  tests/issue-4738.test.ts --pool=forks \
  --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose --testTimeout=120000
```

Result: 6/6 tests passed in both host and standalone lanes:

| Coverage | Result |
| --- | --- |
| `count-less-than-zero-throws.js` | host pass; standalone pass |
| `count-is-infinity-throws.js` | host pass; standalone pass |
| `count-coerced-to-zero-returns-empty-string.js` | host pass; standalone pass |
| `count-is-zero-returns-empty-string.js` | host pass; standalone pass |
| `repeat-string-n-times.js` | host pass; standalone pass |
| `return-abrupt-from-count-as-symbol.js` | host pass; standalone pass |

Additional gates: TypeScript 5 `tsc --noEmit` passed; TypeScript 7
`tsc --noEmit -p tsconfig.ts7.json` passed; scoped Biome lint passed;
scoped Prettier check passed. The pre-commit fast hook (lint-staged plus LOC
and function budgets) passed; its slow checks remain CI-owned per project hook
policy.
