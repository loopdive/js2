---
id: 846
title: "assert.throws not thrown: built-in methods accept invalid arguments silently (2,799 tests)"
status: ready
created: 2026-03-28
updated: 2026-04-28
priority: critical
feasibility: hard
reasoning_effort: max
goal: core-semantics
parent: 779
test262_fail: 2799
---
# #846 -- assert.throws not thrown: built-in methods accept invalid arguments silently (2,799 tests)

## Problem

2,799 tests within the assertion_fail category (returned 2) fail because an expected exception is not thrown. These tests use `assert.throws(TypeError, ...)` or `assert.throws(RangeError, ...)` to verify that built-in methods reject invalid inputs. Instead, the compiler's built-in method implementations silently accept invalid arguments and return a wrong value.

### Breakdown by area

| Area | Count | Description |
|------|-------|-------------|
| Object.defineProperty / defineProperties | ~426 | Should throw TypeError for non-object first arg, non-configurable redefinition |
| Class static restrictions | ~403 | Static 'prototype' property, duplicate computed properties |
| Strict mode / eval | ~212 | arguments assignment, eval reassignment in strict mode |
| for-of / const reassignment | ~141 | Reassigning const bindings should throw TypeError |
| Object.freeze / seal / preventExtensions | ~73 | Should throw TypeError when modifying frozen/sealed objects |
| Type validation on receivers | ~117 | Array/String/etc methods called on wrong type should throw |
| Property descriptor constraints | ~86 | defineProperty with conflicting attributes |
| Other | ~1,341 | Various TypeError/RangeError/SyntaxError validations |

### Sample files with exact errors and source

**1. Object.defineProperty on undefined -- should throw TypeError (L9)**
File: `test/built-ins/Object/defineProperty/15.2.3.6-1-1.js`
Error: `returned 2 -- assert #1 at L9: assert.throws(TypeError, function() { Object.defineProperty(undefined, "foo", {}); });`
```js
assert.throws(TypeError, function() {
  Object.defineProperty(undefined, "foo", {});
});
```
Root cause: `Object.defineProperty` does not check if first argument is an object. ES spec 19.1.2.4 step 1 requires TypeError for non-objects.

**2. Object.defineProperties on null -- should throw TypeError (L9)**
File: `test/built-ins/Object/defineProperties/15.2.3.7-1-2.js`
Error: `returned 2 -- assert #1 at L9: assert.throws(TypeError, function() { Object.defineProperties(null, {}); });`
```js
assert.throws(TypeError, function() {
  Object.defineProperties(null, {});
});
```

**3. Object.defineProperties on boolean -- should throw TypeError (L9)**
File: `test/built-ins/Object/defineProperties/15.2.3.7-1-3.js`
Error: `returned 2 -- assert #1 at L9: assert.throws(TypeError, function() { Object.defineProperties(true, {}); });`

**4. Class static generator named 'prototype' -- should throw TypeError (L9)**
File: `test/language/computed-property-names/class/static/generator-prototype.js`
Error: `returned 2 -- assert #1 at L9: assert.throws(TypeError, function() { class C { static *['prototype']() {} } });`
```js
assert.throws(TypeError, function() {
  class C { static *['prototype']() {} }
});
```
Root cause: ES2015 14.5.14 step 21 -- static methods cannot be named 'prototype'.

**5. const reassignment in for-of body -- should throw TypeError (L9)**
File: `test/language/statements/const/syntax/const-invalid-assignment-statement-body-for-of.js`
Error: `returned 2 -- assert #1 at L9: assert.throws(TypeError, function() { for (const x of [1, 2, 3]) { x++ } });`
```js
assert.throws(TypeError, function() {
  for (const x of [1, 2, 3]) { x++ }
});
```
Root cause: Assignment to const variable in for-of body does not throw TypeError at runtime.

**6. Strict mode arguments assignment -- should throw SyntaxError (L10)**
File: `test/language/arguments-object/10.5-1-s.js`
Error: `returned 2 -- assert #1 at L10: assert.throws(SyntaxError, function() { (function fun() { eval("arguments = 10"); }()); });`
```js
assert.throws(SyntaxError, function() {
  (function fun() { eval("arguments = 10"); }());
});
```
Root cause: Direct eval in strict mode should reject `arguments = 10` with SyntaxError.

**7. Strict mode delete of nonconfigurable -- should throw TypeError (L17)**
File: `test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js`
Error: `returned 2 -- assert #1 at L17: assert.throws(TypeError, function() { "use strict"; delete args[0]; });`

## ECMAScript spec reference

- Built-in methods that require a specific `this` type must throw **TypeError** per their respective specs — e.g., [§23.1.3.22 Array.prototype.push](https://tc39.es/ecma262/#sec-array.prototype.push) step 1: ToObject(this), [§22.1.3.1 String.prototype.at](https://tc39.es/ecma262/#sec-string.prototype.at) step 1: RequireObjectCoercible(this)
- [§7.2.1 RequireObjectCoercible](https://tc39.es/ecma262/#sec-requireobjectcoercible) — throws TypeError for null/undefined


## Root cause in compiler

Built-in method implementations lack ES spec input validation. When the spec says "if Type(O) is not Object, throw TypeError", our implementation skips this check.

Primary files:
- `src/codegen/expressions.ts`: Built-in method implementations (Object.defineProperty, Object.defineProperties, Object.freeze, etc.)
- `src/codegen/statements.ts`: for-of const assignment, strict mode checks
- `src/codegen/index.ts`: Class compilation (static prototype restriction)

## Suggested fix

1. **Object.defineProperty/defineProperties**: Add type check -- if first arg is not object, emit `throw TypeError`
2. **Object.freeze/seal/preventExtensions**: Add type check and enforce immutability
3. **Class static methods**: Check computed property name against "prototype" and throw TypeError
4. **const assignment in loops**: Emit TypeError at runtime for const reassignment
5. **eval strict mode**: Propagate strict mode flag and reject invalid patterns
6. **General pattern**: Add spec-mandated validation guards to all built-in method handlers

## Acceptance criteria

- Object.defineProperty/defineProperties throw TypeError for non-object first argument
- Class static 'prototype' restriction enforced
- const reassignment in for-of throws TypeError
- >=1,500 of 2,799 tests fixed

## Implementation (dev-3, 2026-03-29)

### Changes

**1. Object.defineProperty/defineProperties type validation (runtime.ts, object-ops.ts)**
- `__defineProperty_value` runtime: replaced `if (obj == null) return obj` with proper TypeError throw for non-object args (null, undefined, booleans, numbers, strings)
- `__defineProperties` runtime: same fix
- Both: re-throw TypeErrors from native `Object.defineProperty`/`Object.defineProperties` instead of swallowing them in try/catch
- `emitExternDefinePropertyValue`: added `emitObjectArgNullGuard` for standalone/Wasm-native null check
- `emitExternDefinePropertyNoValue`: added null guard for externref/ref_null objects

**2. const reassignment detection (statements.ts, expressions.ts, index.ts)**
- Added `constBindings?: Set<string>` to `FunctionContext` interface
- Track const bindings in: variable declarations, for-of array path, for-of string path, for-of iterator path, for-of Wasm method dispatch path
- Emit `throw TypeError("Assignment to constant variable.")` for:
  - Simple assignment (`x = ...`) in `compileAssignment`
  - Compound assignment (`x += ...`) in `compileCompoundAssignment`
  - Prefix increment/decrement (`++x`, `--x`) in `compilePrefixUnary`
  - Postfix increment/decrement (`x++`, `x--`) in `compilePostfixUnary`
- Added `collectBindingNames` helper for extracting names from destructuring patterns

### Test results
- Object.defineProperty 15.2.3.6-1-*: 5/5 pass
- Object.defineProperties 15.2.3.7-1-*: 5/5 pass
- const-invalid-assignment-statement-body-for-of: PASS
- Regression tests (let mutation, defineProperty on object, basic const): all PASS

## Implementation Plan (added 2026-05-21)

### Strategic recommendation
This issue covers 2,799 tests across 7+ orthogonal subareas. **Do not implement as one PR.** Decompose into per-subarea sibling issues so each is independently mergeable. The remaining work after dev-3's 2026-03-29 partial fix:

| Subarea | Est. tests | Already partially done? | Suggested child issue |
|---------|------------|--------------------------|------------------------|
| Object.defineProperty/defineProperties type validation | ~426 | yes (dev-3) — verify and close | #846a — close out validation gaps |
| Class static 'prototype' restriction (computed) | ~403 | no | #846b — static prototype TypeError |
| Object.freeze/seal/preventExtensions | ~73 | no | #846c — freeze/seal type guards |
| Type validation on receivers (RequireObjectCoercible) | ~117 | partial | #846d — `this` coercion checks on prototype methods |
| Property descriptor constraints (defineProperty edge cases) | ~86 | partial | #846e — descriptor attribute conflicts |
| Strict mode `arguments = ...` / `eval = ...` (parse-time) | ~212 | no | covered by #1264/#1265 (eval tiers) |
| const reassignment in misc contexts | ~141 | partial (dev-3) | #846f — sweep remaining contexts |
| Other (mixed) | ~1,341 | no | #846g — bucket triage; spec by spec |

### Entry points per subarea

**#846b — class static prototype restriction**
- `src/codegen/index.ts` — class compilation around `compileClassDeclaration` / `compileClassExpression`
- Find the static-member loop; for each `MethodDeclaration` with `static` modifier:
  - Resolve member name via existing `compileComputedPropertyName` / literal-name path
  - If it resolves to `"prototype"` (string) at compile time → emit a synthesised `throw new TypeError(...)` at the class body's entry, OR reject at compile time as a SyntaxError-equivalent
  - For runtime-computed names (rare): emit a runtime guard around the class binding initialiser
- Spec: ES2015 §14.5.14 step 21
- Test cases: `test/language/computed-property-names/class/static/*-prototype.js`

**#846c — Object.freeze/seal/preventExtensions**
- `src/codegen/object-ops.ts` — `emitObjectFreeze` / `emitObjectSeal` / `emitObjectPreventExtensions`
- Add: if input is primitive (string, number, boolean, symbol, bigint) → in strict mode throw TypeError; in sloppy mode return the primitive unchanged. ES2020 changed this — primitives are now silently accepted by `Object.freeze`. **Verify which version the failing tests target** before adding the guard.
- Real failure surface: attempting to mutate a frozen object's property (`obj.foo = 1` on `Object.freeze({foo: 0})`) must throw in strict mode. This is the property-write path in `property-access.ts`, not the freeze call itself.

**#846d — RequireObjectCoercible on prototype methods**
- `src/codegen/expressions/calls.ts` — every Array/String prototype method dispatch
- For methods that call `RequireObjectCoercible(this)`: emit a guard before the body
  ```wasm
  local.get $this
  ref.is_null
  if
    ;; throw TypeError("Cannot read properties of <null|undefined>")
  end
  ```
- Spec: §7.2.1 RequireObjectCoercible
- This overlaps with #820 (nullish TypeError); coordinate before starting.

**#846e — defineProperty descriptor conflicts**
- `src/runtime.ts` — `__defineProperty_value` and friends
- Spec §6.2.5.6 ValidateAndApplyPropertyDescriptor — non-configurable redefinition rules
- Native `Object.defineProperty` already enforces these in host mode — the bug is likely in the standalone path. Trace through `emitExternDefinePropertyValue` for compile-time descriptor patterns.

**#846f — const reassignment in remaining contexts**
- `src/codegen/expressions/assignment.ts` and `compoundAssignment` — verify dev-3's `constBindings` set is checked in all assignment paths
- Specifically: destructuring assignment to const (`[x] = arr` where `x` was declared `const`)
- Update target: `src/codegen/expressions/assignment.ts` destructuring branch

### Cross-cutting infrastructure (do this first)
1. Audit `FunctionContext.constBindings: Set<string>` coverage. Add a debug assertion: any binding declaration that sets `const` must also call `markConst(fctx, name)`.
2. Create a shared helper `emitTypeErrorThrow(ctx, fctx, message)` (probably already exists; confirm in `runtime.ts`). All subarea fixes should use this single emitter.
3. Create a shared helper `emitRequireObjectCoercible(ctx, fctx, sourceLocal, opNameForError)`.

### Wasm output pattern (RequireObjectCoercible)
```wasm
local.get $arg0
ref.is_null
if
  ;; throw new TypeError("<opName> called on null or undefined")
  call $__make_type_error
  throw $__exception_tag
end
```

### Edge cases
- Sloppy mode vs strict mode — most TypeError throws are spec-required in both modes; verify per spec section before adding any guards.
- BigInt / Symbol receivers — RequireObjectCoercible accepts these (returns them); ToObject boxes them. Don't guard against valid primitive receivers for methods like `String.prototype.length` (which is `this.length` on the boxed wrapper).
- Frozen prototypes in the chain — `Object.freeze(Array.prototype)` then `arr.push(1)` must throw. This is the property-assignment-on-frozen path; defer to a tracked separate issue if scope creeps.

### Test plan
- Each child issue ships with its own targeted equivalence test file.
- Per-subarea test262 buckets (use `pnpm run test:262 -- --filter <pattern>`).

### Dependencies
- #820 (nullish TypeError) — overlaps with #846d; land #820 first.
- #1264/#1265 (eval strict mode) — covers the 212 eval-related tests in this bucket; don't duplicate.

### Files touched (across all child issues)
- `src/codegen/index.ts` (class compile)
- `src/codegen/object-ops.ts` (freeze/seal/defineProperty)
- `src/codegen/expressions/assignment.ts` (const re-assign)
- `src/codegen/expressions/calls.ts` (this-coercion guards)
- `src/runtime.ts` (host fallbacks)
- `src/codegen/property-access.ts` (write-to-frozen guard)
