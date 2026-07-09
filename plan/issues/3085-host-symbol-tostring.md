---
id: 3085
title: "Host mode: Symbol.prototype.toString / String(symbol) drop the symbol id"
status: done
sprint: current
priority: medium
assignee: ttraenkler/dev-B2
created: 2026-07-07
completed: 2026-07-07
feasibility: medium
reasoning_effort: low
task_type: bug
area: codegen
language_feature: symbol
goal: es-conformance
related: [2163, 1467]
horizon: s
---

# #3085 — Host mode: `Symbol.prototype.toString` / `String(symbol)` drop the symbol id

## Problem

In **host mode** (the default, `nativeStrings` off — which is how the test262
conformance baseline runs):

- `Symbol('66').toString()` returned `"[object Object]"` (generic
  `Object.prototype.toString` fallback), not `"Symbol(66)"`.
- `String(Symbol('66'))` returned `"101"` — it fell through to the i32→number
  coercion path and stringified the raw internal symbol **id**.

Both should produce the SymbolDescriptiveString `"Symbol(" + (desc ?? "") + ")"`
(§20.4.3.3.1). The native-strings / standalone path already handled this via
`emitSymbolToString` (#2163), but that branch was gated on `ctx.nativeStrings`,
so host mode had no path at all.

## Root cause

The two call sites in `src/codegen/expressions/calls.ts` only implemented the
descriptive-string lowering under `if (... && ctx.nativeStrings)`:

- `Symbol.prototype.toString` on a symbol-typed receiver (`isSymbolType`).
- `String(sym)` when `staticJsTypeOf(arg) === "symbol"`.

With `nativeStrings` false there was no `else`, so `.toString()` fell to the
generic object fallback and `String(sym)` fell to the numeric-argument path.

The host machinery to fix this already existed: symbols are boxed to real JS
`Symbol`s via `__box_symbol(id)`, and their descriptions are registered via
`__symbol_register_desc` (#1467) — this is why `Symbol('66').description`
already returned `"66"` in host mode.

## Fix

- **`src/runtime.ts`** — add a `__symbol_to_string` host import:
  `(externref) → externref`, returning `Symbol.prototype.toString.call(sym)`
  (transparently unwraps Symbol-wrapper objects via ToObject). Sits next to the
  existing `__symbol_description` accessor.
- **`src/codegen/expressions/calls.ts`** — add host-mode (`!ctx.nativeStrings`)
  branches at both sites that box the symbol to `externref` (via the existing
  `compileExpression(..., { kind: "externref" })` → `__box_symbol` path) and
  call `__symbol_to_string`. Mirrors the `.description` host lowering in
  `property-access.ts`. The native-strings `emitSymbolToString` branch stays as
  the standalone fallback (dual-mode preserved — no new host import without a
  standalone path).

## Acceptance criteria

- [x] `Symbol('66').toString() === "Symbol(66)"`, `Symbol().toString() ===
    "Symbol()"` in host mode.
- [x] `String(Symbol('66')) === "Symbol(66)"`, `String(Symbol()) ===
    "Symbol()"` in host mode.
- [x] `Symbol.prototype.valueOf` unchanged (returns the primitive).
- [x] No regressions in the symbol/string equivalence suites.
- [x] Regression test: `tests/equivalence/issue-3085-symbol-tostring.test.ts`.

Flips the test262 `Symbol/prototype/toString/*` and `String(symbol)` cluster
(e.g. `Symbol/prototype/toString/{toString,undefined,toString-default-attributes-non-strict}.js`).

## Note (out of scope)

Two pre-existing `symbol-basic.test.ts` failures ("Symbol.iterator is a
constant", "well-known symbols are consistent") reproduce on clean `main` and
are unrelated to this change (a well-known symbol flows into `Number()`
coercion). Left for a separate issue.
