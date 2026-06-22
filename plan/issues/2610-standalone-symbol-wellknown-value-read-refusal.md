---
id: 2610
title: "standalone: `Symbol.<wellKnown>` read as a VALUE refuses instead of folding to its i32 sentinel"
status: done
completed: 2026-06-22
assignee: ttraenkler/dev-symbol-2610
sprint: 65
created: 2026-06-22
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: class
parent: 2158
goal: standalone-mode
language_feature: well-known-symbols, computed-property-keys
---

# #2610 — standalone `Symbol.<wellKnown>` value-read refuses instead of folding to its i32 sentinel

Slice of umbrella **#2158**. This is the single dominant clean root cause in the
re-measured #2158 host-vs-standalone gap (sprint-65 architect re-measurement,
2026-06-22): ~76 % of the `language/{statements,expressions}/class/dstr` gap and
the top bucket across the whole #2158 scope.

## Problem

In `--target standalone`, reading a well-known symbol **as a value** —
`Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.hasInstance`,
`Symbol.toPrimitive`, `Symbol.toStringTag`, … — hard-refuses at compile time
with:

```
Codegen error: Symbol.iterator built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

even though the compiler **already has** a pure-Wasm constant emitter for exactly
these reads (it folds `Symbol.<wellKnown>` to its small i32 sentinel id). The
refusal pre-empts that emitter.

### Verified minimal repro

```ts
// standalone: ERR (refusal). gc/host: OK.
const o: any = {};
o[Symbol.iterator] = function () {
  return {
    next() {
      return { done: true, value: undefined };
    },
  };
};
```

The trigger is reading `Symbol.iterator` **as a value** (a bare property read /
computed-key value), NOT calling it. `arr[Symbol.iterator]()` (read-then-call)
and `class C { [Symbol.iterator]() {} }` (computed method _name_) already work —
those reach the constant fold by other paths. The failing forms are array-/
iterator-protocol setup and error-path tests under `class/.../dstr/` (the
generated `*-iter-*-err`, `*-iter-no-close`, `*-iter-get-err` variants assign or
read `Symbol.iterator` on a plain object to drive the abrupt-completion path).

## Root cause (verified)

`src/codegen/property-access.ts`:

- The standalone builtin-static-value-read block (line ~3013, inside
  `if (ctx.standalone && BUILTIN_CTOR_NAMES.has(builtinName) && !isShadowed && !deferToNativeConstant)`)
  is reached for `builtinName === "Symbol"`, `propName === "iterator"` (etc.)
  because `Symbol ∈ BUILTIN_CTOR_NAMES`. No static-method closure exists for the
  pair, so it falls through to `reportUnsupportedStandaloneBuiltinValueRead`
  (line ~3032) → emits `ref.null.extern` + records the hard error.
- The escape hatch is `deferToNativeConstant = ctx.standalone &&
hasNativeBuiltinConstantHandler(builtinName, propName)` (line ~3012). When
  true, the whole block is skipped and control reaches the **existing**
  constant emitter at line ~4030:

  ```ts
  // Handle Symbol.iterator, Symbol.hasInstance, etc. → constant i32
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Symbol") {
    const symId = getWellKnownSymbolId(propName);
    if (symId !== undefined) {
      fctx.body.push({ op: "i32.const", value: symId });
      return { kind: "i32" };
    }
  }
  ```

- **`hasNativeBuiltinConstantHandler` (line ~364) does NOT cover `Symbol`.** It
  returns true only for `Math` (MATH_CONSTANT_PROPS), `Number`
  (NUMBER_CONSTANT_PROPS), and `<TypedArray>.BYTES_PER_ELEMENT`. So
  `deferToNativeConstant` is false for `Symbol.iterator`, the refusal fires, and
  the downstream constant emitter is never reached.

This is **substrate-independent** — the value is a compile-time i32 constant
(the well-known-symbol sentinel id, already used by `getWellKnownSymbolId` /
`WELL_KNOWN_SYMBOLS` at property-access.ts:164/297). It needs **no** builtin-
prototype object representation, so it is **NOT gated on #2175** and **NOT gated
on #2580**.

## Implementation Plan

### Change (one function, ~3 lines)

**File: `src/codegen/property-access.ts`**, function `hasNativeBuiltinConstantHandler`
(line ~364). Add a `Symbol` arm that defers to the existing well-known-symbol
constant fold:

```ts
function hasNativeBuiltinConstantHandler(builtinName: string, propName: string): boolean {
  if (builtinName === "Math") return MATH_CONSTANT_PROPS.has(propName);
  if (builtinName === "Number") return NUMBER_CONSTANT_PROPS.has(propName);
  // (#2610) Symbol.<wellKnown> as a VALUE folds to its i32 sentinel id at the
  // downstream constant emitter (~line 4030, `getWellKnownSymbolId`). Defer the
  // standalone builtin-static-value-read refusal to it — host-free, no prototype
  // object needed (NOT #2175-gated). Mirrors the Math/Number constant defers.
  if (builtinName === "Symbol") return getWellKnownSymbolId(propName) !== undefined;
  // (#2595) <TypedArrayName>.BYTES_PER_ELEMENT static read → constant emitter.
  if (propName === "BYTES_PER_ELEMENT") return builtinName in TYPED_ARRAY_BYTES_PER_ELEMENT;
  return false;
}
```

`getWellKnownSymbolId` is already defined in this file (line ~297); no new
import. The gate is exact: it only defers for prop names that the downstream
emitter actually folds (`iterator`, `asyncIterator`, `hasInstance`,
`isConcatSpreadable`, `match`, `matchAll`, `replace`, `search`, `species`,
`split`, `toPrimitive`, `toStringTag`, `unscopables` — whatever is in
`WELL_KNOWN_SYMBOLS`). A non-well-known `Symbol.foo` still refuses (correct —
there is no constant for it).

### Why this is safe

- gc/host mode is unaffected: `deferToNativeConstant` is gated on `ctx.standalone`
  (the `&&` at line 3012), so host still takes the `__get_builtin` import path,
  which is observationally identical to the constant for these reads.
- Shadowing is already handled by the existing `isShadowed` check upstream
  (`fctx.localMap.has("Symbol")` / boxedCaptures) — a local named `Symbol` never
  reaches `hasNativeBuiltinConstantHandler`.
- The result type is `{ kind: "i32" }` (the symbol sentinel), matching every
  other consumer of `getWellKnownSymbolId` (e.g. computed-key dispatch,
  `Symbol.iterator !== undefined` comparisons) — no ValType mismatch.

### Edge cases to verify

- `o[Symbol.iterator] = fn` (computed-key WRITE) — the LHS key must fold to the
  i32 sentinel so the dynamic `__extern_set` keys on it. Confirm the write path
  reaches the same constant emitter (it routes the computed-key expression
  through this `compilePropertyAccess`/key-eval path).
- `Symbol.iterator` passed as a call argument / stored in a `const` — bare value
  read, must fold.
- `Symbol.asyncIterator`, `Symbol.toPrimitive`, `Symbol.toStringTag` — same fold.
- `Symbol.for("x")` / `Symbol("x")` — NOT well-known; unaffected (those are
  call expressions, different path).
- Non-well-known `Symbol.foo` — still refuses loud (no regression to silent
  wrong-codegen).

### Failing test262 paths (sample — host passes, standalone refuses)

- `test/language/statements/class/dstr/async-gen-meth-dflt-ary-init-iter-get-err.js`
- `test/language/statements/class/dstr/gen-meth-static-ary-ptrn-elem-id-iter-step-err.js`
- `test/language/expressions/class/dstr/gen-meth-static-ary-init-iter-get-err.js`
- `test/language/expressions/class/dstr/async-gen-meth-static-ary-ptrn-elem-id-iter-step-err.js`
- `test/language/statements/class/dstr/async-gen-meth-static-ary-ptrn-elem-id-iter-val-err.js`
- (the full `*-ary-*-iter-*` / `*-iter-no-close` generated families under both
  `class/dstr` trees)

### Estimated rows

Re-measured: ~76 % of the `class/dstr` host-vs-standalone gap. Stratified
samples → **~250–320 rows** across `language/{statements,expressions}/class/dstr`
once execution passes (the compile refusal currently blocks every one). Some of
these are iterator-error-path tests that also need #2611 (the `__extern_length`
shift bug) to fully pass at runtime; this slice removes the compile refusal
(necessary, not always sufficient). Conservative standalone-pass uplift from this
slice alone: **~150–250 rows**.

### Test to add

`tests/issue-2610-symbol-wellknown-value-read-standalone.test.ts` — assert
standalone COMPILES (and runs) for: `o[Symbol.iterator] = fn`, a bare
`const k = Symbol.iterator` value read, `Symbol.asyncIterator` / `toPrimitive` /
`toStringTag` reads, and a computed-key write keyed by `Symbol.iterator`. Mirror
`tests/issue-2158-class-identity-standalone.test.ts`.
