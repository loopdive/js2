---
id: 5117
title: "ES2015 standalone DataView byteOffset Symbol conversion"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: ES2015
language_feature: dataview-byteoffset-toindex-symbol
goal: standalone-mode
assignee: "ttraenkler/codex/es2015-next-lane-h"
loc-budget-allow:
  - src/codegen/dataview-native.ts
files:
  - src/codegen/dataview-native.ts
  - tests/issue-5117-dataview-byteoffset-symbol.test.ts
  - plan/issues/5117-es2015-dataview-byteoffset-symbol.md
---

# Local plan 5117 — ES2015 standalone DataView byteOffset Symbol conversion

## Exact cohort and baseline evidence

The exact 16-row ES2015 cohort is:

```text
built-ins/DataView/prototype/getFloat32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getInt16/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getInt32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getInt8/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getUint16/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getUint32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/getUint8/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-byteoffset-symbol.js
built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-byteoffset-symbol.js
```

All 16 paths map to ES2015 (`editions[2] == "ES2015"`) in
`website/public/benchmarks/results/test262-file-editions.json`. The supplied
authoritative snapshots are dated 2026-08-28, oracle version 13, honest lane,
standard scope, both strictness modes. Every host row is `pass` with
`reached_test: true`; every standalone row reaches the test but is `fail` with
`error_category: assertion_fail` and
`error_signature: Expected a TypeError but got a RangeError`.

| direction | rows | status | reached test | diagnostic |
| --- | ---: | --- | --- | --- |
| JS-host | 16 | pass | true | — |
| standalone | 16 | fail | true | `Expected a TypeError but got a RangeError` |

The authoritative raw rows are read from:

```text
/private/tmp/js2-baseline-host-current-20260828.jsonl
/private/tmp/js2-baseline-standalone-current-20260828.jsonl
```

Before code, the same paths were run through the assembled local harness from
the initial `upstream/main` at
`7dd9f3b5b996a94f254a50ed0cafedd821d8bfa7`. Host was `16/16 pass`; standalone
was `16/16 fail` with the diagnostic above. After the required refresh, the
delivery branch is rebased onto final `upstream/main`
`796d8c2cd28648d21de2ada5a0b662e758f7dda3`; the refreshed A/B and focused
results below are from that final base. The local pre-refresh baseline
artifacts are:

```text
.tmp/issue-5117/baseline-host.jsonl
  sha256 2e15df276233e0d7ccf00111a420b1d3c0eac7a8d4c2da091f93726683d6f595
.tmp/issue-5117/baseline-standalone.jsonl
  sha256 acbab9499e4b1cb3a0fe20b60df9a8cf88fbd33322195ecad4dfca03910efe05
```

Both local runs observed the required structural controls in both directions:
`control-must-pass -> pass` and `control-must-fail -> fail`. The local A/B
diff below compares clean final-base artifacts with final post-fix artifacts;
the supplied authoritative snapshots are independent evidence, not a diff arm.

## Post-fix local A/B and determinism evidence

After the static-Symbol guard and argument-expression controls were added, the
same assembled harness completed `16/16 pass` in both host and standalone
modes. The structural controls remained `control-must-pass -> pass` and
`control-must-fail -> fail` in each run.

```text
.tmp/issue-5117/final-baseline-host.jsonl
  sha256 2e15df276233e0d7ccf00111a420b1d3c0eac7a8d4c2da091f93726683d6f595
.tmp/issue-5117/final-baseline-standalone.jsonl
  sha256 acbab9499e4b1cb3a0fe20b60df9a8cf88fbd33322195ecad4dfca03910efe05
.tmp/issue-5117/final-post-host.jsonl
  sha256 2e15df276233e0d7ccf00111a420b1d3c0eac7a8d4c2da091f93726683d6f595
.tmp/issue-5117/final-post-standalone.jsonl
  sha256 62b12dc40f9aa8f3440bf8bfb98672a6344dc7888fca17b9ac4e3d178bfe397a
.tmp/issue-5117/final-post-standalone-repeat.jsonl
  sha256 62b12dc40f9aa8f3440bf8bfb98672a6344dc7888fca17b9ac4e3d178bfe397a
```

The final-base row-level comparison is `16` standalone fail-to-pass flips,
`0` losses, `0` status churn, and `0` host losses. The repeated standalone
output is byte-identical (`16/16` rows; nondeterminism `0`). The focused lane test
passed all `13` tests (five mandatory no-corpus controls and eight chunked
host/standalone corpus checks) without an unhandled Vitest worker timeout.
The related `#2199b` and `#2199` suites passed `19` tests. The optional `#1654`
WASI suite reproduced three `RuntimeError: illegal cast` failures in its
existing runtime exercise; its other `21` tests passed, and the failure uses
numeric/WASI paths outside this static-Symbol change.

## Root cause

The direct native path `emitDataViewAccessor` handles every DataView get/set
member through one shared byteOffset conversion. It currently compiles an
explicit `args[0]` with an `{ kind: "f64" }` hint before applying the shared
NaN-to-zero, truncation, and RangeError checks. In standalone code generation,
a statically known `Symbol` is represented physically as an i32 symbol handle,
so this path treats the handle as a numeric offset. The operation then reaches
the bounds check and reports a RangeError instead of the required TypeError
from `ToNumber(Symbol)`/`ToIndex`.

The same module already uses `ctx.oracle.staticJsTypeOf` plus
`emitThrowTypeError` for setter values, and `emitToIndexI32` has the required
static-Symbol guard for typed-array construction. The missing guard is this
shared direct DataView byteOffset conversion. A correct guard must still
compile and drop every supplied argument expression in source order, preserving
their side effects, then throw without applying later ToNumber/ToBoolean
coercions. An abrupt later argument expression must win over the method's
static-Symbol TypeError, while an object's `valueOf` must remain untouched.

## Implementation plan

1. In `emitDataViewAccessor`, gate a static-Symbol byteOffset guard to
   `noJsHost(ctx)`, evaluate and drop every supplied argument expression in
   source order, emit the existing in-module TypeError machinery, and leave a
   typed unreachable f64 sentinel for the shared downstream locals. This
   preserves argument-expression effects and abrupt later arguments but does
   not invoke later value/littleEndian coercion hooks.
2. Keep the current dynamic ToIndex conversion, NaN/truncation/range checks,
   native DataView read/write paths, setter value and littleEndian order, and
   JS-host lowering unchanged.
3. Add mandatory no-corpus compiler controls that always compile/validate and
   instantiate standalone modules with zero `env` imports. They will cover
   static Symbol getter/setter throws, offset-expression side effects, the
   setter throw-priority over value/littleEndian expressions, and a dynamic
   numeric offset round trip.
4. Add the exact host and standalone corpus checks behind a worktree-independent
   `test262` availability guard, with explicit Vitest timeouts above the
   120-second per-row runner budget.
5. Run exact local host/standalone A/B, repeat standalone determinism,
   structural controls, focused/related tests, no-corpus shape controls,
   type/lint/format, budgets/ratchets, and the full pre-push gate with at most
   two workers. Record all results and hashes below.

## Acceptance criteria

- All 16 exact rows pass in standalone and remain pass in JS-host mode.
- Static Symbol byteOffset conversion throws a catchable TypeError after
  evaluating all argument expressions; later coercions are not invoked, and an
  abrupt later expression wins.
- Dynamic numeric byteOffsets still read/write correctly, and omitted/default
  littleEndian behavior remains unchanged.
- Mandatory no-corpus standalone controls validate, instantiate with an empty
  import object, and report zero host imports.
- The local A/B has exactly 16 standalone fail-to-pass flips, zero losses or
  status churn, and the repeat reports no nondeterminism.
- The checked-in plan, focused regression, metadata, normal gates, and
  pre-push checks are clean. No GitHub issue is created or updated.

## Handoff

Implementation is limited to the two owned code/test files plus this plan:
`src/codegen/dataview-native.ts`,
`tests/issue-5117-dataview-byteoffset-symbol.test.ts`, and this document.
The delivery branch is `codex/5117-es2015-dataview-byteoffset-symbol`, based
directly on freshly fetched `upstream/main` at
`796d8c2cd28648d21de2ada5a0b662e758f7dda3`. After validation, the clean head
and full evidence will be handed to the root agent
for one upstream PR; no external issue will be created.
