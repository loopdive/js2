---
id: 3395
title: "standalone: object/closure GC ref not boxed (or double-boxed) at externref boundaries — any.convert_extern / extern.convert_any invalid Wasm (~34 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, type-coercion
language_feature: classes, private-methods, weakcollections, abstract-equality
goal: standalone-mode
umbrella: 2039
related: [2039, 1888]
test262_bucket: standalone-invalid-wasm
test262_count: 34
es_edition: multi
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/weak-collections-runtime.ts
  - src/codegen/binary-ops.ts
---

> **SLICE 1 (fable-dev-1, 2026-07-18) — SHAPE 2 fixed (Weak-collection typed
> null, ~6 rows).** Shapes 1 (missing box in class/private-method init) and 3
> (== double-convert with a wrapper Object) remain — see the "Progress" section
> at the bottom for grounded findings + resume anchors. Issue stays `ready`.

# #3395 — object/closure ref ↔ externref boxing at boundaries (child of #2039)

## Bucket

- **Records:** 34
- **Validator signatures (three related shapes, same "extern boxing direction"
  root):**
  1. `call[N] expected type externref, found struct.new of type (ref M)` — a
     freshly-constructed GC object passed to an externref parameter WITHOUT
     `any.convert_extern` (12 rows).
  2. `any.convert_extern[0] expected type externref, found ref.null of type
(ref null M)` — a **typed** `ref.null $Struct` fed to `any.convert_extern`
     (which wants externref) (6 rows, all Weak collections).
  3. `extern.convert_any[0] expected type anyref, found call of type externref`
     — **double convert**: a helper call already returns externref, then
     `extern.convert_any` (wants an internal anyref) is applied again (11 rows,
     `==` abstract-equality).
  4. Plus `call expected externref, found local.get/local.tee of type (ref M)`
     stragglers (5 rows).
- **Area distribution:** expressions (== / class):14, statements:5,
  WeakSet:3, Set:3, WeakMap:2, Array:2, Promise:2, built-ins:3.
- **3 sample tests (one per shape):**
  - `test/language/expressions/class/elements/private-methods/prod-private-generator.js`
    (`call[1] expected externref, found struct.new of type (ref 7)` in `C_init`)
  - `test/built-ins/WeakSet/prototype/has/returns-false-when-value-cannot-be-held-weakly.js`
    (`any.convert_extern … found ref.null of type (ref null 120)`)
  - `test/language/expressions/equals/S11.9.1_A7.3.js`
    (`extern.convert_any … found call of type externref` — double convert)

## Reproduced on current main

```
INVALID [prod-private-generator.js]:
  Compiling function #78:"C_init" failed:
  call[1] expected type externref, found struct.new of type (ref 7) @+33097
INVALID [WeakSet…returns-false…]:
  Compiling function #54:"test" failed:
  any.convert_extern[0] expected type externref, found ref.null of type (ref null 120) @+29376
INVALID [equals/S11.9.1_A7.3.js]:
  Compiling function #56:"test" failed:
  extern.convert_any[0] expected type anyref, found call of type externref @+30610
```

## Root cause

Three sites emit the wrong boundary conversion for a GC-object value:

1. **Missing box (shapes 1 & 4).** A concrete GC struct (from `struct.new` /
   `local.get`) is pushed as an argument to an externref-typed callee slot
   without the ref→externref boxing (`extern.convert_any`, or
   `any.convert_extern` when the value is already anyref). The argument-coercion
   path is not calling `coerceType(refType, externref)` (the arm at
   `src/codegen/type-coercion.ts:2035`) for these callee slots — likely the
   private-method init (`C_init`) and Weak-collection key argument lowering
   push the raw struct.

2. **Typed `ref.null` (shape 2).** The null literal for a "not held weakly"
   value is emitted as a **typed** `ref.null $Struct` and then handed to
   `any.convert_extern`, whose operand must be `externref`, not a concrete ref.
   The null-in-externref-context helper should emit `ref.null extern` (or box
   through the extern path) — see the CLAUDE.md pattern "null/undefined in f64
   context: emit directly (avoids externref roundtrip)"; the analogous
   externref-context null should be `ref.null extern`, never a typed struct null
   fed to `any.convert_extern`.

3. **Double convert (shape 3, the `==` path).** The abstract-equality helper
   (`S11.9.1` = `==`) already produces an externref operand, and the surrounding
   coercion re-applies `extern.convert_any` (which expects an internal anyref,
   not externref). The `==` operand-preparation code path double-boxes: it
   should detect the operand is already externref and skip the convert, or use
   `any.convert_extern` to go externref→anyref if an anyref is genuinely needed.

## Implementation Plan

### Investigation anchors

- **Shape 1/4 (missing box):** grep the class-init / private-method emit
  (`C_init`, `registerNative` for private methods) in `src/codegen/index.ts`
  and the generic call-argument coercion in `src/codegen/expressions.ts`
  (`compileCallExpression` argument loop). Confirm the callee slot ValType is
  `externref` and that arg coercion routes through `coerceType(..., externref)`.
- **Shape 2 (typed null):** grep `ref.null` emission for Weak-collection
  key/value args in `src/codegen/object-ops.ts` / the collection builtins. The
  null path must emit `ref.null extern` when the target is externref.
- **Shape 3 (double convert):** grep the `==` / abstract-equality lowering
  (`compileBinaryExpression` `==`/`!=` case in `src/codegen/expressions.ts`) and
  the operand-boxing helper. Add an "already externref → no extern.convert_any"
  guard.

### Fix pattern

- Route ALL these through `coerceType(from, to)` rather than hand-emitting
  convert opcodes, so the from-kind dispatch (`ref/ref_null`→externref at
  :2035, `externref`→anyref via `any.convert_extern`, and the identity
  short-circuit) is applied uniformly. Where a site hand-emits
  `extern.convert_any`/`any.convert_extern`, replace with a `coerceType` call
  keyed on the real operand ValType.

### Wasm IR pattern (targets)

```wasm
;; shape 1: GC struct → externref arg
struct.new $Obj
extern.convert_any            ;; box (was: raw struct passed)
;; shape 2: null in externref position
ref.null extern               ;; was: ref.null $Struct then any.convert_extern
;; shape 3: operand already externref → no re-convert
call $eq_operand              ;; result already externref; do NOT extern.convert_any
```

### Edge cases

- Identity preservation: a GC object boxed to externref and later unboxed must
  round-trip to the SAME reference (WeakSet/WeakMap identity semantics). Prefer
  `extern.convert_any`/`any.convert_extern` (identity) over `__box_*`.
- `==` with mixed operand types (one externref, one f64): only skip the convert
  on the operand that is already externref; the numeric operand still needs its
  own coercion.
- Do not regress host mode — host `==`/collection paths may already be correct;
  gate changes on the standalone/native-ref regime where the invalid opcode is
  emitted.

### Test files to verify

- `test/language/expressions/class/elements/private-methods/prod-private-generator.js`
- `test/built-ins/WeakSet/prototype/has/returns-false-when-value-cannot-be-held-weakly.js`
- `test/language/expressions/equals/S11.9.1_A7.3.js`
- Regression test `tests/issue-3395-extern-boxing.test.ts` (standalone + wasi +
  host-guard) covering all three shapes.

## Acceptance criteria

- All 34 rows compile to valid Wasm (or refuse loudly).
- WeakSet/WeakMap identity semantics preserved (round-trip test).
- No host-mode regression; equivalence tests green.

---

## Progress (fable-dev-1, 2026-07-18)

Branch `issue-3395-extern-boxing`, worktree
`/workspace/.claude/worktrees/agent-aeb10fb7d183a166f`.

### SHAPE 2 — DONE (Weak-collection typed null → invalid Wasm; ~6 rows)

Root: `WeakSet`/`WeakMap` `get`/`has`/`delete`/`set`/`add` compiled the key/value
arg RAW (`compileExpression` + `coerceMapKeyToAnyref`) in
`src/codegen/weak-collections-runtime.ts`, so a null/undefined key literal
(incl. `null as any` — the §CanBeHeldWeakly "value cannot be held weakly" rows)
emitted a TYPED `ref.null $Struct` that `coerceArgToAnyref`'s externref arm fed
to `any.convert_extern` ("expected externref, found ref.null of type (ref null
N)"). Unlike the Map/Set native path, the weak path did NOT use the
`compileCollectionElementArg` null-literal guard.

Fix: route weak-collection args through `compileCollectionElementArg` (canonical
`ref.null NONE_HEAP` null-guard + the #3394 i64 arm), and add an
`as`/paren/`!`/`satisfies` unwrap (`unwrapExprWrappers`) to that guard so a
WRAPPED null literal is still recognized. Verified: WeakSet.has(null)→false,
object identity round-trips (add/has, set/get), WeakMap unregressed.
`tests/issue-3395-extern-boxing.test.ts` (5 tests, green).

### SHAPE 1 — NOT reproduced standalone-of-raw-body (missing box; ~17 rows)

`prod-private-generator.js` (`call[1] expected externref, found struct.new of
type (ref 7)` in `C_init`). RESUME ANCHOR: the raw test body compiles VALID on
BOTH main and this branch (`--target standalone`) — the failing `C_init`
boxing is only reached with the test262 harness (`assert`/`verifyProperty`)
injected, which the standalone probe lacks. To reproduce: run the file through
the actual test262 runner (`pnpm run test:262` filtered) or replicate the
harness's private-method registration path. The fix is per the plan's Shape-1
investigation anchors (class-init / private-method emit in `index.ts`; the
call-arg coercion must route through `coerceType(refType, externref)` for the
externref private-method slot).

### SHAPE 3 — FIXED (invalid-Wasm eliminated; == mixed string ToNumber convert)

Root FOUND + fixed: the mixed string⇄number/boolean `==` path
(`binary-ops.ts` `emitToNumber`, the noJsHost `__str_to_number` arm) emitted an
UNCONDITIONAL `extern.convert_any` before `__str_to_number`, assuming a native
`$AnyString` REF operand. A string-classified operand that ALREADY compiles to
externref (a `new String(x)` wrapper object) was thus double-converted —
`extern.convert_any` on an externref is invalid Wasm (`expected anyref, found
call of type externref`, the `true == new String("+1")` residual). Fix: gate the
`extern.convert_any` on the compiled operand's real ValType — emit it only for a
ref operand, skip it when already externref. Native-string ToNumber cases
(`"1"==1`, `""==0`, `"abc"==1`, `true=="1"`) verified still correct.

RESIDUAL (runtime, NOT invalid-Wasm — separate bucket): `true == new
String("+1")` now COMPILES valid but TRAPS at runtime (`illegal cast`) because
`__str_to_number` `ref.cast`s its operand to `$AnyString`, and a `new String`
WRAPPER object externref is not a bare `$AnyString`. Monotonic for the #2039
invalid-Wasm bucket (the row was a compile-fail before, is no longer invalid
Wasm, and eliminating the module-level invalid Wasm lets the file's OTHER
assertions run). The wrapper-String ToNumber value semantics (ToPrimitive the
wrapper before `__str_to_number`, or make `__str_to_number` wrapper-tolerant) is
a follow-up. The former-investigation notes below are retained for context.

### SHAPE 3 (original investigation notes) — == double-convert; ~11 rows

Minimal repro: `true == new String("x")` (also `1 == new String`,
`new String == 1`) → `extern.convert_any[0] expected anyref, found call of type
externref`. `new Boolean`/`new Number` inline are VALID — only the STRING
wrapper. `const s = new String("x"); true == s` (via local) is VALID — only the
INLINE `new String` operand double-converts. WAT shows `call $__new_String`
(returns externref) immediately followed by a second `extern.convert_any`. The
`new String` producer itself correctly returns `{kind:"externref"}`
(`new-builtin-globals.ts:159-174`); the second convert is emitted in the `==`
wrapper-equality dispatch (`binary-ops-typed-dispatch.ts`, the
`isEqOp`/`wrapperEquality` operand-coercion cascade). RESUME ANCHOR: trace which
branch fires for `boolean == <String-wrapper externref>` (the
`isStringType(rightTsType)` gate is FALSE for a `String` OBJECT, so it falls to
the `else if (isNumericOp || isEqOp || isNeqOp)` valueOf-coercion arm ~:370);
add an "operand already externref → skip the convert / use any.convert_extern"
guard there per the plan's Shape-3 fix.

### Regression status

Weak/Map/Set suites green (issue-2162-standalone-weak, issue-3242-weakref,
issue-2378, issue-2861, issue-3309, issue-2162-map-foreach — 50 tests). The
shape-2 change is scoped to the standalone/native weak-collection arg path;
host mode unchanged.
