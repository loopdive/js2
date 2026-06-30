---
id: 2888
title: "Standalone: relational `<`/`<=`/`>`/`>=` with a String wrapper operand emits invalid Wasm"
status: done
created: 2026-06-30
completed: 2026-06-30
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: s
related: [2873, 2870, 2862]
umbrella: 2873
assignee: ttraenkler/agent-abb00
---

# Standalone: relational with a String wrapper operand emits invalid Wasm

Sub-slice of the #2873 `language/expressions` standalone cluster.

## Problem

Under `--target standalone`, a relational comparison (`<`, `<=`, `>`, `>=`)
where one operand is a `String` **wrapper object** (`new String("1")`) produced
an **invalid Wasm module** (compiled `success: true`, failed at
`WebAssembly.instantiate`):

```
new String("1") < "1"   → call[0] expected type (ref null 6), found local.tee of type externref
"1" < new String("1")   → any.convert_extern[0] expected externref, found ref.cast null of type (ref null 6)
```

This de-masked (post-#2870) the test262 cluster
`language/expressions/{less-than,greater-than,less-than-or-equal,greater-than-or-equal}/S11.8.x_A3.2_T1.x`
(`Type(Primitive(x))` varies between primitive string and `String` object),
all reported as `compile_error` standalone while passing host-mode.

## Root cause

`compileStringBinaryOp`'s relational arm (`src/codegen/string-ops.ts` ~1677)
pushed both operands **raw** via `compileExpression`, then called the native
`__str_compare` helper, whose signature is `(ref $AnyString, ref $AnyString)`.
A `String` wrapper object lowers to an `externref` (boxed), not a native
`ref $AnyString`, so the call tripped the helper's parameter type → the module
failed Wasm validation. The `+` concat case already lowered each operand to a
native `ref $AnyString` via `compileNativeConcatOperand` (ToString); relational
did not.

## Fix

In the relational arm, under `noJsHost` (standalone / WASI), lower each operand
to a native `ref $AnyString` via `compileNativeConcatOperand` (String wrapper →
`tryStructToString`/`$__any_to_string`, dynamic externref → `__extern_toString`,
number → `number_toString`) before calling `__str_compare` — mirroring the `+`
path. The legacy JS-host `nativeStrings` path keeps its original raw push (host
(gc) mode is byte-unaffected).

## Result

- `S11.8.x_A3.2_T1.x` String-wrapper relational tests: standalone
  `compile_error` → `pass`, host-free (`result.imports` empty).
- Relational dirs scan (host-pass tests): 160 standalone pass / 8 fail; the 8
  residual fails are the `_A1`/`_A2.2` object-`valueOf` relational tests
  ("Cannot convert object to primitive value"), a separate pre-existing #2862
  ToPrimitive cluster (verified identical on unedited main, untouched by this
  change).
- Zero host (gc) regression.

Regression test: `tests/issue-2888.test.ts`.
