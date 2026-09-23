---
id: 6496
title: "Linked lane: two `private-field-*` rows emit an INVALID Wasm binary (`C_init` / `__cb_0` type mismatch)"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: private-fields
goal: test262-conformance
related: [6492, 3451]
---

# #6496 — a body-only compile of `#x in obj` emits an invalid module

Split out of #6492 round 6, where it was two rows of the long-tail residual and
plainly a different defect from everything around it: the module does not
merely behave wrongly, it **fails `WebAssembly.instantiate` validation**. That
is a compiler bug worth its own issue, not a lane-parity bucket.

## Rows

| row | linked-lane error |
| --- | --- |
| `test/language/expressions/in/private-field-in-nested.js` | `L26:5 invalid Wasm binary (WebAssembly.instantiate(): Compiling function #14:"C_init" failed: local.tee[0] expected type anyref, found i32.const of type i32)` |
| `test/language/expressions/in/private-field-rhs-await-present.js` | `L36:5 invalid Wasm binary (WebAssembly.instantiate(): Compiling function #26:"__cb_0" failed: call[0] expected type i32, found call of type externref)` |

Both are honest-pass / linked-fail, so the honest whole-assembly compile of the
same source is valid. The distinguishing input is the compile UNIT: the linked
lane compiles the test body alone (`compileHarnessLinkedBody`, multi-file graph,
`entryScriptGoal`), the honest lane compiles the body with the whole harness
prefix in front of it.

Two different functions and two different mismatches, so this is likely two
defects with one trigger rather than one:

- `C_init` — a class field initializer storing an `i32` where the slot is
  `anyref`.
- `__cb_0` — the host-callback bridge passing an `externref` where an `i32` is
  expected.

## Repro

```
RUN_TIMESTAMP=x TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 \
TEST262_ORACLE_MODE=linked TEST262_RESULT_PREFIX=test262-linked \
TEST262_INCLUDE_PROPOSALS=1 \
TEST262_PATH_FILTER="language/expressions/in/private-field-in-nested.js|language/expressions/in/private-field-rhs-await-present.js" \
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/test262-chunk-dynamic.test.ts
```

Faster loop: compile the body through `compileHarnessLinkedBody` with
`emitWat: true` and read the two functions directly — the mismatch is a
validation error, so it is visible in the emitted module without running
anything.

## Acceptance

- [ ] Both rows compile to a VALID module in the linked lane.
- [ ] The honest lane is unchanged (it already passes; measure, do not assume).
- [ ] A test asserting `WebAssembly.validate` on the body-only compile of both
      shapes, failing on the pre-fix tree.
