---
id: 4527
title: "axios: __class_call_concat_vararg dispatch bridge emits invalid Wasm — 7 modules fail validation, ~101 tests blocked"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, rest-parameters
goal: npm-library-support
related: [3995, 4302]
files:
  - src/codegen/index.ts
  - tests/dogfood/axios-upstream-suite.mjs
---

# axios: the vararg class-method dispatch bridge for `concat` is mistyped

## Problem

7 of axios's 25 generated upstream test modules **emit but fail
`WebAssembly.compile()` validation** in the same synthetic function:

```text
Compiling function #1781:"__class_call_concat_vararg" failed:
local.set[0] expected type (ref null 40), found ref.cast null of type (ref null 2)
```

(`settle.test.js` shows the `call[0]`-position variant of the same mismatch.)
Affected: `isCancel` (2 tests), `mergeConfig` (57), `settle` (12),
`transformData` (4), `buildURL` (20), `isAxiosError` (4), `validator` (2) —
**~101 of the 154 failing axios tests**, all blocked before execution.
Measured 2026-08-16 on `a9b20d4c`; matches the npm-compat card (16/170).

## Mechanism

`__class_call_concat_vararg` is the host dispatch bridge emitted per method
key for classes whose method has rest params — src/codegen/index.ts:6624
(`emitMethodDispatch(key, exportName, true, -1)`). axios defines `concat` on
**more than one class** (`AxiosHeaders.concat(...targets)` and the internal
config/header merge helpers), so the bridge's per-struct `ref.test` cascade
covers several receiver struct types. The validation error says the cascade
stores a `ref.cast null <structA>` result into a local declared as
`<structB>`: one shared receiver local typed for the *first* struct arm is
reused across arms of different types. Any package with a same-named
rest-param method on two classes should reproduce.

## Reproduction

```bash
node --import tsx tests/dogfood/axios-upstream-suite.mjs --json
# compile.details[*].validationError on the 7 files above
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: two classes, each with `concat(...xs: any[])` of different
   field shapes, both dynamically called through the host bridge (export the
   instances). Compile with the same options the harness uses; expect the
   identical `local.set` type error. Commit the reduction as
   `tests/issue-4527.test.ts` asserting `WebAssembly.validate` on the binary.
2. **Fix in `emitMethodDispatch`** (src/codegen/index.ts, vararg arm,
   `arity === -1`): the receiver local that holds the `ref.cast` result must
   be per-arm (declare one local per struct type in the cascade) or the cast
   result must stay on the stack for the immediate `call` instead of a
   `local.set`. Follow whichever pattern the fixed-arity arm already uses —
   the error appearing only in the `_vararg` bridge says the fixed-arity
   cascade handles this correctly; mirror it.
3. **Check the `settle` variant** (`call[0] expected (ref null 35)`): same
   cascade, mismatch surfaces at the call instead of the local store — one
   fix should cover both; assert both files validate.
4. **Validation gates**: (a) new reduction test; (b) axios harness:
   `compile.validated` 16 → 23 and pass count re-measured (record here —
   the 101 blocked tests will surface their true runtime state, do not
   assume they pass); (c) equivalence + `npm test -- tests/issue-4373`
   (host bridge arity family) stay green.

## Acceptance criteria

- [ ] All 25 axios test modules validate.
- [ ] Reduction test committed; general fix, no axios-specific casing.
- [ ] Fresh axios pass/total recorded in this file after the fix.
