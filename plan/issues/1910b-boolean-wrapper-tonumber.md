---
id: 1910b
slug: boolean-wrapper-tonumber
title: "standalone Boolean-wrapper ToNumber/valueOf — Number(new Boolean(true)) returned NaN"
status: done
sprint: Backlog
parent: 1910
assignee: sdev-boxrep
feasibility: medium
completed: 2026-06-19
---

## Problem

In `--target standalone` (pure-Wasm, no JS host), coercing a `new Boolean(x)`
wrapper object to a number gave the wrong answer:

- `Number(new Boolean(true))` returned **NaN** (spec: `1`)
- `Number(new Boolean(false))` returned **NaN** (spec: `0`)
- `new Boolean(true).valueOf()` returned a non-boolean garbage value

This broke `Boolean/prototype/valueOf/*` conformance and every numeric-context
coercion of a Boolean wrapper.

## Root cause (measure-first; the substrate had moved)

The original spec hypothesis (arch-dynshape / #1472 refresh) was that
`__new_Boolean` stored a **boxed f64** in the wrapper's internal slot. That is
**no longer true on current main** — `__new_Boolean`
(`src/codegen/object-runtime.ts:1090`) already boxes the truthy i32 via
`__box_boolean` and stores a real boxed-boolean (`__box_boolean_struct`) in the
`WRAPPER_PRIMITIVE_KEY` FLAG_INTERNAL slot. `__to_primitive` recovers that
boxed-boolean externref correctly.

The real, current bug was one layer downstream — in the **standalone native
`__unbox_number`** body (`src/codegen/index.ts`,
`addUnionImportsAsNativeFuncs`). Its arms were: `null → 0`,
`$box_number_struct → value`, `native string → __str_to_number`, and
**everything else → NaN**. A `$box_boolean_struct` fell into the NaN fallback.
So `Number(new Boolean(true))` → `__to_primitive` returns boxed-bool →
`__unbox_number(boxed_bool)` → **NaN**.

`new Boolean(x).valueOf()` was a second, independent gap: the standalone
wrapper-accessor block in `src/codegen/expressions/calls.ts` only handled
`String`/`Number` wrapper `valueOf`; the Boolean arm fell through to a legacy
`compileExpression(..., {kind:"i32"})` of the `$Object` receiver, yielding
garbage.

## Fix

1. `src/codegen/index.ts` — add a `$box_boolean_struct` arm to the standalone
   native `__unbox_number`: `ref.test` the boxed-boolean struct, read field 0
   (the i32), `f64.convert_i32_s` → 1.0/0.0 (§7.1.4 ToNumber(true)=1,
   ToNumber(false)=0). Inserted before the native-string arm; standalone/WASI
   only (host mode uses the JS `__unbox_number` import — untouched).

2. `src/codegen/expressions/calls.ts` — extend the standalone
   wrapper-value-accessor path to cover `Boolean.prototype.valueOf`: route
   through `__to_primitive` (slot read) then `__unbox_boolean` → i32 primitive
   (§20.3.3.3).

Both changes are additive and standalone-gated; no host-mode path changes.

## Acceptance (all passing)

- `Number(new Boolean(true)) === 1`, `Number(new Boolean(false)) === 0`
- `new Boolean(true) + 0 === 1`, `new Boolean(false) + 0 === 0`
- `new Boolean(true).valueOf()` truthy, `new Boolean(false).valueOf()` falsy

Regression: `tests/issue-1910-boolean-wrapper-tonumber.test.ts` (6 cases).
50 related wrapper/coercion tests still green.
