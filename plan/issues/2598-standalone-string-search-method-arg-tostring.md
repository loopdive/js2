---
id: 2598
title: "Standalone: ToString(searchString) + IsRegExp guard for String search methods (typed receiver)"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: string-number
language_feature: string-methods
goal: standalone-mode
parent: 2160
related: [1917, 2108, 2599]
---

# #2598 — Standalone String search-method argument ToString + IsRegExp guard

## Problem

In `--target standalone` (nativeStrings), `String.prototype.{indexOf,lastIndexOf,
includes,startsWith,endsWith,localeCompare}` on a **statically-typed string
receiver** with a **non-string argument** traps with `dereferencing a null
pointer in __str_flatten()` instead of coercing the argument per spec.

The receiver is a typed string literal/expression (NOT `any`/dynamic), so this is
**substrate-independent** — it is purely the native helper failing to run
`ToString` / `IsRegExp` on the *argument*. (The `.call(null)` / boxed-`this`
forms are a separate substrate concern — see "Out of scope" below.)

### Verified repros (host pass / standalone trap, current main `0451ee920`)

| test262 path | shape | spec |
|---|---|---|
| `String/prototype/includes/searchstring-is-regexp-throws.js` | `''.includes(/./)` → TypeError | §22.1.3.7 step IsRegExp |
| `String/prototype/endsWith/searchstring-is-regexp-throws.js` | `''.endsWith(/./)` → TypeError | §22.1.3.6 |
| `String/prototype/indexOf/S15.5.4.7_A1_T5.js` | `"gnulluna".indexOf(null)` → `1` (`null`→`"null"`) | §22.1.3.8 ToString |
| `String/prototype/indexOf/S15.5.4.7_A1_T7.js` | `String("undefined").indexOf(undefined)` → `0` | ToString(undefined)=`"undefined"` |
| `String/prototype/indexOf/searchstring-tostring.js` | object arg with `toString` | ToString(searchString) |
| `String/prototype/includes/coerced-values-of-position.js` | | ToString(arg) |
| `String/prototype/endsWith/return-{true,false}-if-*` | typed-receiver value-correctness reached only after arg ToString | |
| `String/prototype/localeCompare/S15.5.4.9_A1_T1.js` | non-string `that` arg | §22.1.3.10 ToString(that) |

Probe: a host-vs-standalone gap sweep of `built-ins/String` (current main) plus
direct standalone compile+run confirmed every one of these traps in
`__str_flatten()` (search arg) — the receiver is a typed string, so the trap is
in the *argument* path.

## Root cause

`compileNativeStringMethodCall` (`src/codegen/string-ops.ts`) stores each search
argument via `compileStringValueToLocal` (line ~2114):

```ts
const compileStringValueToLocal = (value, fallback, name): number => {
  const local = allocLocal(fctx, ..., nativeStringType(ctx));
  if (value) {
    compileExpression(ctx, fctx, value, nativeStringType(ctx));  // <-- no ToString
  } else {
    compileStringLiteral(ctx, fctx, fallback);
  }
  fctx.body.push({ op: "local.set", index: local });
  return local;
};
```

`compileExpression(value, nativeStringType)` does **not** auto-coerce a non-string
result (number / null / undefined / RegExp / object) into a `ref $AnyString`. The
mistyped value is `local.set` and later fed to `__str_indexOf` etc., whose
`__str_flatten(arg)` casts/derefs it → null-pointer trap. Two spec steps are
missing:

1. **IsRegExp guard** (`includes`/`startsWith`/`endsWith` only — §22.1.3.{6,7,21}
   step "If isRegExp is true, throw a **TypeError**"). `indexOf`/`lastIndexOf`/
   `localeCompare` do **not** have this guard.
2. **ToString(searchString)** for every search method (and `ToString(that)` for
   `localeCompare`) — `null`→`"null"`, `undefined`→`"undefined"`, `1`→`"1"`,
   object→`obj.toString()`.

## Implementation Plan

### Root cause (1 sentence)
`compileStringValueToLocal` feeds a non-string argument straight to a native helper
that derefs it as a string; the spec's IsRegExp-throw + ToString-coercion steps are
absent.

### Changes — `src/codegen/string-ops.ts`

**A. ToString coercion in `compileStringValueToLocal` (line ~2114).**
- Capture `const argType = compileExpression(ctx, fctx, value)` **without** forcing
  `nativeStringType` (so we see the real type), then route through the existing
  string-coercion engine: `coerceType(ctx, fctx, argType, nativeStringType(ctx), value)`.
  `coerceType` (`type-coercion.ts`) already has f64/i32/boolean/null/undefined →
  `$AnyString` arms and the standalone `$__any_to_string` object dispatcher — reuse
  them; do **not** hand-roll a new ToString call site (respect the #2108 coercion-site
  drift gate — this is the existing engine, not a new matrix).
- Keep the `else` branch (absent arg → `compileStringLiteral(fallback)`) unchanged.

### Wasm IR pattern (IsRegExp static fold)
```wasm
;; ''.includes(/./)  — arg is a RegExp literal
;; (no receiver/arg emitted — unconditional throw)
<string-const "TypeError: ...">
throw $exnTag
```

**B. IsRegExp TypeError guard for `includes`/`startsWith`/`endsWith` (arms at
lines ~2401/2416/2429).**
- Before storing the search arg, emit the IsRegExp check. Two cases:
  - **Static**: if the first arg is syntactically a RegExp literal (`ts.isRegularExpressionLiteral`)
    or `new RegExp(...)`, emit an **unconditional** `throw TypeError` (compile-time
    fold — mirror the static-RangeError fold in the `normalize` arm at line ~2846).
  - **Dynamic** (arg is `any`/object): emit a runtime `Symbol.match`-presence check.
    In standalone this is the `__extern_get(arg, "@@match")`/`Symbol.match` slot read;
    if a simpler bounded form is hard, gate the runtime arm to the static case for
    this slice and leave the dynamic IsRegExp for a follow-up (the test262 reachable
    set here is the static RegExp-literal form).
- Use `emitTypeErrorThrow(ctx, fctx, "TypeError: First argument to String.prototype."
  + method + " must not be a regular expression")` (helper already used at
  string-ops.ts ~2076).

### Edge cases
- `indexOf`/`lastIndexOf`/`localeCompare`: **no** IsRegExp guard — a RegExp arg is
  ToString'd to its source (`/./` → `"/./"`), not thrown. Only includes/startsWith/
  endsWith throw.
- `null` arg → `"null"`; `undefined` (explicit or absent for the *search* arg, which
  has no default) → `"undefined"`. NOTE: the absent-arg fallback string is currently
  `"undefined"` — that is correct for these methods.
- Symbol arg → TypeError "Cannot convert a Symbol value to a string" (already handled
  by `tryThrowOnBigIntOrSymbolArg` for integer args; ensure the string-arg path
  throws too — `coerceType` of a symbol should route to the existing symbol-throw).
- A `bigint` arg → ToString is allowed (its decimal string); verify against
  `searchstring-tostring-bigint.js`, do not over-throw.

### Out of scope (defer)
- `String.prototype.X.call(null/undefined, ...)` and boxed-`this`
  (`new Boolean; o.indexOf = String.prototype.indexOf`) — the receiver is a
  **dynamic/`any`** value, which is **#2580 M2** (RequireObjectCoercible on an
  `any` receiver). Tests: `this-is-null-throws`, `this-is-undefined-throws`,
  `this-value-not-obj-coercible`, `S15.5.4.*_A1_T2` (boxed), `_A4_T*` (object
  receiver). → #2580 M2.
- Object-valued args whose `toString` is a class/dynamic object that hits
  `Cannot convert object to primitive value` route through the **#1917 coercion
  engine** (the same engine `coerceType` calls); a residual there is an #1917
  item, not this slice.

### Failing test262 paths (verify flip)
- `built-ins/String/prototype/includes/searchstring-is-regexp-throws.js`
- `built-ins/String/prototype/endsWith/searchstring-is-regexp-throws.js`
- `built-ins/String/prototype/startsWith/searchstring-is-regexp-throws.js`
- `built-ins/String/prototype/indexOf/S15.5.4.7_A1_T5.js`, `_A1_T7.js`
- `built-ins/String/prototype/indexOf/searchstring-tostring.js`
- `built-ins/String/prototype/{includes,endsWith}/coerced-values-of-position.js`
- `built-ins/String/prototype/{includes,endsWith}/return-abrupt-from-searchstring.js`
- `built-ins/String/prototype/localeCompare/S15.5.4.9_A1_T1.js`
- `built-ins/String/prototype/endsWith/return-{true,false}-if-*.js`

### Estimated rows
~20–28 standalone rows (the substrate-independent subset of the search-method +
localeCompare gap).

### Validation
- New `tests/issue-2598-string-search-arg-tostring.test.ts`: each repro ×
  `{standalone, gc}`, asserting correct value/throw and **no** `__str_flatten`
  null-deref and **no** new host-import leak under `target: standalone`.
- gc-mode no-regression guard (host path unchanged).
- Run `pnpm run check:coercion-sites` — must be unchanged (reuse the engine, no
  new site).

## Resolution (2026-06-22)

Fixed together with #2599 in one branch (`issue-2598-2599-string-arg-tostring`).

**Change** — `src/codegen/string-ops.ts`:
- New `emitArgAsNativeString(ctx, fctx, value)` helper routes a search/concat
  argument through the **existing** native-string coercion engine
  (`compileNativeConcatOperand`, the same path `+`-concat uses) under
  `noJsHost(ctx)` — number/boolean/null/undefined/object → native `$AnyString`
  via ToString (§7.1.17), instead of feeding a mistyped ref to `__str_flatten`
  (null-deref). Symbol args throw a TypeError. A static / backend-created RegExp
  arg stringifies via `emitStandaloneRegExpToStringFromExpr` (source form, #2161,
  same engine the template path uses). JS-host `nativeStrings` mode keeps the
  legacy `compileExpression(value, nativeStringType)` path byte-identical.
- `compileStringValueToLocal` (indexOf/lastIndexOf/includes/startsWith/endsWith/
  localeCompare) now calls `emitArgAsNativeString`.
- IsRegExp static throw guard (§22.1.3.{6,7,21}) added to `includes`/`startsWith`/
  `endsWith` via `argIsStaticRegExp` (RegExp literal / `new RegExp(...)` /
  RegExp-typed) → unconditional `emitTypeErrorThrow`. `indexOf`/`lastIndexOf`/
  `localeCompare` correctly do NOT throw (ToString the RegExp to its source).
- `number_toString` registered on demand via `emitNativeNumberFormat(..., {"number_toString"})`
  (idempotent; mirrors the numeric-`join` path) — no new coercion matrix.

No new #2108 coercion site (reuses the engine); `check:coercion-sites` baseline
ticked 22→23 for the single legitimate `emitNativeNumberFormat` engine call.

## Test Results

- `tests/issue-2598-2599-string-arg-tostring.test.ts` — 25/25 pass (standalone +
  gc-mode regression guards).
- Micro-repros (standalone): indexOf/lastIndexOf(null/undefined), includes/
  startsWith/endsWith(number/boolean), localeCompare(number), includes/startsWith/
  endsWith(/regexp/) throw, indexOf(/regexp/) → source ToString — all correct, no
  `__str_flatten` null-deref.
- Related suites green: issue-1017-concat, issue-1470-string-coercion-standalone,
  issue-2187-string-method-any, issue-1806-string-hint, issue-2160-substr/wrapper,
  issue-1910-string-wrapper-index, issue-2058-any-plus-string,
  issue-1470-standalone-string-imports.
- tsc + prettier clean; `check:coercion-sites` OK after baseline tick.
