---
id: 1558
sprint: 53
title: "ESLint linter.js direct compile: Linter_verifyAndFix f64.eq missing i32→f64 coercion on call result"
status: done
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: equality, numeric-coercion, async
goal: npm-library-support
related: [1400, 1289, 1287, 1282]
blocks: [eslint-tier-1d]
---

## Resolution

Root cause: `compileBinaryExpression` in `src/codegen/binary-ops.ts` had a
legacy AST branch (around line 1363) that handles operators against
TS-typed `number` operands. It coerced the RIGHT operand from `i32` to
`f64` if needed but assumed the LEFT operand was already `f64`. When the
left operand was actually `i32` (e.g. `string.length` returned via the
`wasm:js-string`/`length` import returns `i32`, not `f64`), the emitted
`f64.eq` had one `i32` and one `f64` operand → validation error
`f64.eq[0] expected type f64, found call of type i32`.

The `a.length === b.length` form took the IR path (#1169 slice) which
already coerces both sides to the `f64` hint, masking the bug. The
`(b as string).length`, `b!.length`, `b.length` after a temp-assign, and
similar `as`/non-null wrappers all dropped off the IR fast-path into
this legacy branch and tripped the validator.

Fix: in the legacy branch, coerce BOTH `i32` operands to `f64` (using a
temp local to bridge the stack swap when both sides need conversion).
See diff in `src/codegen/binary-ops.ts:1363-1397`.

Test coverage: `tests/issue-1558.test.ts` — 11 cases covering the
synthetic minimum repro, all `as` / `!` / temp-local variants, runtime
correctness of widened equality (both equal & unequal lengths, `===`
and `!==`), and a smoke test against `node_modules/eslint/lib/linter/
linter.js` confirming `Linter_verifyAndFix` no longer raises the
`f64.eq` validation error. (Other unrelated validation errors in
downstream functions of `linter.js` remain — tracked separately under
#1559 and #1560.)

# #1558 — ESLint linter.js verifyAndFix f64.eq i32 operand coercion missing

## Problem

Pointing `compileProject` at `node_modules/eslint/lib/linter/linter.js`
directly fails Wasm validation with:

```
Linter_verifyAndFix:
  f64.eq[0] expected type f64, found call of type i32 @+...
```

The compiled function emits an `f64.eq` instruction where one operand
is the result of a call returning `i32`, but no `f64.convert_i32_s` (or
`_u`) coercion is inserted before the comparison.

This was uncovered by the #1400 partial PR (`Config_new`
`extern.convert_any` fix). Once `Config_new` validated, `linter.js`
advanced past `FileReport_addRuleMessage` (#1289) and now stops here.

## Reproducer

```ts
import { compileProject } from "./src/index.js";

const r = compileProject(
  "/workspace/node_modules/eslint/lib/linter/linter.js",
  { allowJs: true },
);
expect(r.success).toBe(true);              // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true); // currently fails
```

`r.binary` validation rejects `Linter_verifyAndFix` at the
`f64.eq[0]` operand position.

Look at function `Linter_verifyAndFix` in
`/workspace/node_modules/eslint/lib/linter/linter.js` — it has the
shape (real source):

```js
verifyAndFix(text, config, options) {
  let messages = [],
      fixedResult,
      fixed = false,
      passNumber = 0,
      currentText = text;
  // ...
  do {
    passNumber++;
    // ...
    if (messages.length === fixedResult.messages.length &&
        messages.every((m, i) => m.message === fixedResult.messages[i].message)) {
      // ...
    }
  } while (...);
}
```

The likely trigger is a comparison against an i32-returning helper
(e.g. `.length`, a custom getter coerced via the i32 fast path, or a
typed integer field) that should be auto-promoted to f64 when compared
against an f64 operand.

## Hypothesis

In `src/codegen/type-coercion.ts`, the binary-equality path
(`compileBinary` for `==` / `===` in expressions.ts) inserts coercions
when both operands' compile-time types are known, but the call-result
typing for some untyped JS host calls is left at i32 (from an inlined
return-type-narrowing optimization) while the other operand is still
f64. The `coerceToCommonNumeric` (or equivalent) helper is being
bypassed.

This may share root cause with #1303 (`f64.trunc emitted on externref
operand`) — another type-coercion misorder caught in lodash. But the
operand type here is i32, not externref, so the path is distinct.

## Suggested investigation

1. `wasm-dis` the `linter.js` binary and locate
   `Linter_verifyAndFix`. Find the `f64.eq` instruction; trace which
   `call` produced the i32 result (likely a helper method on a typed
   class field).
2. In `src/codegen/expressions.ts`, find the `BinaryExpression` /
   `===` codegen path. Confirm whether it consults the operand
   ValType returned from the left/right `compileExpression` calls
   and inserts `f64.convert_i32_s` when one is i32 and the other f64.
3. The fix likely lives in `src/codegen/type-coercion.ts` —
   `coerceType(ctx, fctx, "i32", "f64")` already exists and emits
   `f64.convert_i32_s`. The bug is probably a missed call to it in
   the equality path under a specific operand-typing combination.

## Acceptance criteria

1. `WebAssembly.validate(r.binary) === true` for
   `compileProject("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true })`.
2. A regression test under `tests/` pins the minimal reduced repro:
   `x === fn()` where `fn()` returns i32 and `x` is f64 (typed local
   from a default-typed JS number). Covers both `==` and `===`.
3. ESLint Tier 1c remains green; Tier 1d unskips and either passes or
   moves to its next-blocker error.
4. No regression in existing lodash/Hono Tier 1+2 stress tests.

## Notes

- This is one of two known-next-blockers identified in the #1400
  partial PR resolution notes.
- Pairs with #1557 (`config.js` trampoline arity). Both must land
  before Tier 1d (`linter.js` binary instantiates) goes green.
- Out of scope: the bare-package resolver path (#1559) and CJS
  class re-export linkage (#1560).
