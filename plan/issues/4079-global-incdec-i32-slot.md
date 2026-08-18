---
id: 4079
title: "`++`/`--` on an i32-slot module global emits `f64.add` on an i32 operand — module fails validation"
status: done
sprint: 78
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/H-crashes
created: 2026-08-02
completed: 2026-08-02
---

## Problem

`var x = false; x++;` emits a module that **fails Wasm validation**:

```
__module_init failed: f64.add[0] expected type f64,
                      found global.get of type i32
```

The module never instantiates, so the whole file's assertions are lost.

Measured on the standalone lane (baseline row timestamp `2.8.2026, 03:32`;
ES5+untagged goal scope 8,545 run / 6,298 pass / 0 unopenable): **8** of the
53 goal-scope `invalid Wasm binary` files are this mechanism — the
`S11.3.1` / `S11.3.2` / `S11.4.4` / `S11.4.5` `_A3_T1` / `_A4_T1` family
(postfix/prefix increment/decrement with a boolean or Boolean-object operand).

This is **not** the externref `ref.null` family of #4077; it must not be
folded into it.

## Root cause

`var x = false` gives the module global an **i32** (boolean-branded) slot.

The *read* path already knew this: the `x !== 0 + 1` comparison emits
`f64.convert_i32_s` on the same global. The *update* path did not.

`src/codegen/expressions/unary-updates.ts` carried **eight** hand-rolled
copies of "read the global / compute ±1 / store it back" —
prefix `++`, prefix `--`, postfix `++`, postfix `--`, each duplicated for
`ctx.moduleGlobals` and `ctx.capturedGlobals`. Every copy branched on the
global's declared type, and every copy handled `externref` and
`ref`/`ref_null` and **forgot `i32`**, so an i32 slot fell through to the f64
arm:

```wat
global.get 7      ;; i32 (boolean slot)
global.get 7      ;; i32
f64.const 1
f64.add           ;; <-- operand is i32
global.set 7      ;; and this would store f64 into an i32 global
```

A correct implementation already existed a few hundred lines above, in the
same file: `compileStaticPropIncDec` (#2019) converts `i32`→`f64` on read and
`f64`→`i32` on store. It was only ever wired to static-property globals.

So the eight copies and the one correct version were the same "two halves
living apart and drifting" shape as #3989 and #4077 — except here the correct
half was already in the file and simply not reused.

## Fix

Generalise `compileStaticPropIncDec` into **`compileGlobalIncDec`** and route
all eight fallback arms through it. One type-case list instead of eight; the
`i32` case cannot be forgotten again because there is only one place to
forget it.

The `externref` and `ref`/`ref_null` early-returns in each arm are left
untouched — this change only replaces the final f64-assuming fallback.

## Measurements

Row timestamp `2.8.2026, 03:32` · corpus `test262-standalone-current.jsonl`
(loopdive/js2wasm-baselines) · official 43,505 run / 25,995 pass (59.75%) ·
goal scope 8,545 run / 6,298 pass (73.70%) / **0 unopenable**.

| stage      | count | note                                                      |
| ---------- | ----: | --------------------------------------------------------- |
| population |    53 | goal-scope `invalid Wasm binary`                          |
| mechanism  |     8 | `f64.add/sub ... found global.get of type i32`            |
| reachable  |     8 | all compile; the crash is at instantiate                  |
| **flips**  |     4 | `runTest262File`, `--target standalone`, run **serially** |

**Kill-switch control** — same 8 files, same runner, `unary-updates.ts`
reverted to its `HEAD` version: **8 fail / 0 pass**. With the fix:
**4 pass / 4 fail**.

The 4 residuals are the `CHECK#2` halves of those same files, which use
`new Boolean(true)` — an **externref** global that takes the separate
`externref` arm and fails on Boolean-object `ToNumeric` semantics, not on
validation. That is a different mechanism and is out of scope here.

## Residual

Still open in the goal-scope `invalid Wasm binary` population after #4077 and
this issue:

- 12 `local.set[0] expected externref, found call_ref of type i32` in
  `__call_fn_method_N` (11 × `RegExp/prototype/test/S15.10.6.3_*`)
- 2 `local.set expected (ref null 6), found struct.get of type i32`
- 2 `type error in fallthru`
- 1 `any.convert_extern expected externref, found if`
