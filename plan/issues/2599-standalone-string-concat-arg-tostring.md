---
id: 2599
title: "Standalone: String.prototype.concat variadic + non-string-argument ToString (typed receiver)"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
priority: high
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: string-number
language_feature: string-methods
goal: standalone-mode
parent: 2160
related: [1917, 2108, 2598]
---

# #2599 — Standalone String.prototype.concat ToString(args)

## Problem

In `--target standalone`, `String.prototype.concat` on a **typed string receiver**
mishandles its arguments:

| call (typed string receiver) | host | standalone (current main) |
|---|---|---|
| `'a'.concat('b','c','d')` | `"abcd"` | **`undefined`** (variadic broken) |
| `'a'.concat(1)` | `"a1"` | **null-deref trap** in `__str_concat()` |
| `'a'.concat(true)` | `"atrue"` | trap |
| `'a'.concat(null)` | `"anull"` | trap |

Direct standalone compile+run (current main `0451ee920`) confirms: variadic
string args return `undefined`, and any non-string primitive arg traps with
`dereferencing a null pointer in __str_concat()`.

Receiver is a typed string → **substrate-independent**.

## Root cause

`compileNativeStringMethodCall`, the `method === "concat"` arm (`src/codegen/
string-ops.ts`, the `if (method === "concat")` block):

```ts
if (method === "concat") {
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
  emitReceiver();                                  // accumulator on stack
  if (expr.arguments.length === 0) return nativeStringType(ctx);
  for (const arg of expr.arguments) {
    compileExpression(ctx, fctx, arg, nativeStringType(ctx));  // <-- no ToString
    fctx.body.push({ op: "call", funcIdx: concatIdx });
  }
  return nativeStringType(ctx);
}
```

`compileExpression(arg, nativeStringType)` does not coerce a number/boolean/null
arg to a `ref $AnyString`, so `__str_concat(acc, arg)` derefs a non-string ref →
trap. (The reported "variadic returns undefined" is the same failure surfacing as a
dropped/poisoned accumulator on the first bad arg; once every arg is properly
ToString'd, the fold is correct.)

## Implementation Plan

### Root cause (1 sentence)
The concat arm feeds each argument to `__str_concat` without ToString, so a
non-string argument null-derefs and a multi-arg fold poisons the accumulator.

### Changes — `src/codegen/string-ops.ts` (concat arm)
- For each argument, capture its real type and route through the existing string
  coercion engine before the `__str_concat` call:
  ```ts
  const argType = compileExpression(ctx, fctx, arg);            // no forced target
  coerceType(ctx, fctx, argType, nativeStringType(ctx), arg);   // existing engine
  fctx.body.push({ op: "call", funcIdx: concatIdx });
  ```
  `coerceType` (`type-coercion.ts`) already has the f64/i32/boolean/null/undefined →
  `$AnyString` arms + standalone `$__any_to_string` dispatcher. Reuse it — **no new
  coercion site** (respect the #2108 drift gate).
- This SHARES the exact fix shape with #2598's `compileStringValueToLocal`. If #2598
  lands first, factor a small `emitArgAsNativeString(ctx, fctx, arg)` helper and call
  it here too; if this lands first, #2598 reuses it. Either order is fine — keep the
  two slices independently landable (whoever is second rebases on the helper).

### Edge cases
- `'a'.concat()` (no args) → receiver unchanged (already handled, keep).
- `null`→`"null"`, `undefined`→`"undefined"`, `true`→`"true"`, `1`→`"1"`,
  `1.5`→`"1.5"`, `NaN`→`"NaN"`, `Infinity`→`"Infinity"`.
- Multi-arg left-to-right fold order must be preserved (eval each arg in order;
  §22.1.3.4 step "Repeat, while items is not empty").
- Symbol arg → TypeError; bigint arg → its decimal string (allowed).

### Out of scope (defer)
- `new Boolean; o.concat = String.prototype.concat; o.concat(...)` and other
  boxed/dynamic **receiver** forms (`S15.5.4.6_A1_T2`, `_A2`) → the receiver is a
  boxed primitive / `any` and hits `Cannot convert object to primitive value` →
  **#2580 M2** (dynamic receiver) / **#1917** (object→primitive). Not this slice.

### Failing test262 paths (verify flip)
- `built-ins/String/prototype/concat/S15.5.4.6_A1_T5.js` (null/undefined args)
- `built-ins/String/prototype/concat/S15.5.4.6_A1_T7.js`
- `built-ins/String/prototype/concat/15.5.4.6-*` variadic forms
- (`_A1_T2`, `_A2` stay failing — boxed receiver, deferred to M2/#1917)

### Estimated rows
~6–10 standalone rows (the typed-receiver concat subset).

### Validation
- New `tests/issue-2599-string-concat-arg-tostring.test.ts`: variadic strings,
  number/boolean/null/undefined args, fold order, × `{standalone, gc}`; assert
  no `__str_concat` null-deref and no host-import leak under `target: standalone`.
- `pnpm run check:coercion-sites` unchanged.

## Resolution (2026-06-22)

Fixed together with #2598 in one branch (`issue-2598-2599-string-arg-tostring`).
The `method === "concat"` arm now ToString-coerces each argument via the shared
`emitArgAsNativeString` helper (see #2598 resolution — reuses
`compileNativeConcatOperand`, the existing native-string engine) before each
`__str_concat` call. Left-to-right fold order preserved; a non-string arg no
longer null-derefs. No new #2108 coercion site.

## Test Results

- `tests/issue-2598-2599-string-arg-tostring.test.ts` — 25/25 pass.
- Standalone micro-repros: `"a".concat("b","c","d")` → "abcd"; `"a".concat(1)` →
  "a1"; `"a".concat(true)` → "atrue"; `"a".concat(null)` → "anull";
  `"a".concat(undefined)` → "aundefined"; mixed variadic fold-order; `"abc".concat()`
  → receiver — all correct, no `__str_concat` null-deref.
- gc-mode concat unchanged; tsc + prettier clean.
