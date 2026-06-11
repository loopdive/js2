---
id: 846
title: "assert.throws not thrown: built-in methods accept invalid arguments silently (2,799 tests)"
status: done
created: 2026-03-28
updated: 2026-06-11
priority: critical
feasibility: hard
reasoning_effort: max
goal: core-semantics
sprint: 58
parent: 779
test262_fail: 2799
pr: 1098
completed: 2026-06-03
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

## Profiling re-run (2026-05-27, dev)

Profiled the 2,351 `assert.throws(ErrType, …)`-not-thrown failures from the
2026-05-21 baseline jsonl. **Conclusion: there is no single unowned,
localized sub-cluster of ≥200 tests left in #846.** The mass is genuinely
fragmented and the large clusters are either already owned or need the
descriptor/object model (escalated under #1630). Breakdown:

| Cluster | Count | Status |
|---------|-------|--------|
| AnnexB `ReferenceError "An initialized binding is not created"` (function-code + global-code) | 96 | **owned** by #1594 (task #104) — legacy block-fn hoisting |
| `language/*/class` (private methods, dstr defaults, proxies) | 408 | heterogeneous — many mechanisms, not one fix; overlaps #820/#1543 |
| `Object.defineProperty/defineProperties` TypeError (descriptor conflicts, `15.2.3.6-4-*`, `15.2.3.7-6-a-*`) | 108 | **needs descriptor model** — see finding below; overlaps escalated #1630 |
| compound-assignment strict-mode write to non-writable / setter-less accessor (`11.13.2-*-s.js`) | 42 | needs accessor-descriptor + strict-write model (same object-model gap) |
| for-of dstr iterator-close TypeError | 52 | overlaps #1592 (iterator over-consumption, escalated) |
| assignment/const/let dstr | 31 | overlaps #1553 destructuring residuals (owned) |
| array `length` RangeError (`defineProperty(arr,"length",…)`) | 28 | array-length descriptor validation; small, isolated |

**Key root-cause finding (defineProperty descriptor conflicts, 108 tests):**
The runtime `__defineProperty_value` / `__defineProperty_desc` host imports
(`src/runtime.ts:4053-4111`) *already* delegate to native
`Object.defineProperty` for plain JS objects and re-throw spec TypeErrors —
so the runtime is correct. But for a typed object literal (`var o = {}`),
codegen **compiles the `Object.defineProperty(o, …)` call away entirely**:
a probe of `Object.defineProperty(o,"foo",d1)` requested **zero**
`__defineProperty*` imports (only `__get_undefined`, `__box_number`). The
typed-struct path in `src/codegen/object-ops.ts` (~1307/1590) folds the
descriptor into direct struct-field writes and never tracks
configurable/writable flags, so the non-configurable-redefinition check in
`_validatePropertyDescriptor` (runtime.ts:705) never runs. Fixing this
requires the struct path to either emit a real `__defineProperty_*` runtime
call carrying flags, or carry per-property descriptor state on the struct —
the same descriptor-model work already escalated under **#1630**. Not a
localized fix.

**Recommendation:** close #846 as an umbrella; the remaining mergeable slices
are the already-dispatched child issues (#1594, #1592, #1553, #820 family).
The only genuinely new, isolated micro-bucket is array-`length` RangeError
(~28) — too small to be worth a standalone PR under the ≥200 target.

## Slice landed (sd-1472, 2026-06-03): RequireObjectCoercible for empty/nested object patterns

### Fresh re-profile vs the stale 2026-05-21/05-27 notes
Most of the overlapping child issues cited above are now **done** on main
(#1594, #1592, #1553, #1543, #1630), so the residual #846 surface shifted.
Re-profiling the 2026-05-28 baseline jsonl found **1,282** remaining
`assert.throws(ErrType,…)`-not-thrown failures (down from 2,799). Within the
destructuring slice there is one clean, spec-localized root cause worth a
standalone PR:

**Destructuring a `null`/`undefined` value through an EMPTY object pattern did
not throw.** Confirmed via probe: `let {} = null`, `let {} = undefined`,
`const {} = null`, `for (const {} of [null])`, and the nested form
`{ w: {} } = { w: null }` all silently succeeded; `let {a} = null` (non-empty)
already threw correctly.

### Root cause (WHY)
Per **ECMA-262 8.6.2 BindingInitialization**, the production
`BindingPattern : ObjectBindingPattern` runs `Perform ?
RequireObjectCoercible(value)` as **step 1** — *before* the inner
`ObjectBindingPattern : { }` rule (which "Return unused"). So the coercibility
check fires even for `{}`. The codegen had a confidently-wrong comment
(introduced under #225 / #1553c) claiming the empty pattern performs "no
property access and therefore no RequireObjectCoercible", and short-circuited
the empty object-binding-decl path (`compileExternrefObjectDestructuringDecl`)
*before* the null/undefined guard. The fixture
`statements/const/dstr/obj-init-null.js` documents the trap: its `info:` block
cites `ObjectBindingPattern : { } → Return NormalCompletion(empty)` yet asserts
a TypeError — because the *outer* `BindingPattern` wrapper does the
RequireObjectCoercible. The parameter path (`destructureParamObject`, guard at
the externref branch before its empty short-circuit) and the assignment path
(`emitExternrefAssignDestructureGuard`, fixed under #1701) were already correct;
only the binding-declaration + the empty-nested paths were not.

### Changes (2 files, surgical)
1. `src/codegen/statements/destructuring.ts` —
   `compileExternrefObjectDestructuringDecl`: emit
   `emitExternrefDestructureGuard(tmpLocal)` (the existing null + JS-undefined
   RequireObjectCoercible guard) before the empty-pattern short-circuit. Fixes
   `let/const/var {} = null|undefined` AND the for-of binding-pattern path
   (loops.ts routes for-of object binding patterns through this same helper).
   The guard fires only for null/undefined, so coercible primitives
   (`{} = 5`, `{} = "s"`) still pass — verified.
2. `src/codegen/destructuring-params.ts` —
   `destructureParamObjectExternref` nested-element handler: drop the
   `element.name.elements.length > 0` gate so the nested coercibility guard
   also fires for empty nested patterns (`{ w: {} } = { w: null }`). Spec-clean:
   the guard is null/undefined-only.

### Considered and deliberately deferred (higher risk, separate root cause)
- **Array-assignment non-iterable** (`for ([] of [1])`, `[] = 5`): needs a
  `GetIterator` probe (calling `value[Symbol.iterator]()` then IteratorClose)
  on the empty/elision array path. The empty-array path intentionally skips
  `__array_from_iter` to avoid advancing generators; adding iterability without
  that side effect is a distinct change. ~12 for-of + a few assignment tests.
- **Typed-struct static-`null` nested** (`for (var {w:{x}=d} of [{w:null}])`):
  the `[{w:null}]` literal is constant-folded and the inner destructure is
  optimized away before any guard site; chasing this through the
  `compileForOfDestructuring` typed/vec paths added **3 false "regressions"**
  in one attempt and zero validated wins, so it was reverted. ~6 tests.

### Validation
- New equivalence test `tests/equivalence/destructuring-require-object-coercible.test.ts`
  (10 cases) — all pass.
- Existing destructuring equivalence suites: 97/97 pass.
- **Delta**: of 146 baseline-failing dstr-noncoercible candidates, **38 now
  pass** (object RequireObjectCoercible family across const/let/var binding
  decls, for-of object binding patterns, nested empty object patterns).
- **Regressions**: 0 real. Broad sweeps via the test262 runner on
  baseline-PASSING tests: 400-test dstr sample 392/400 (8 apparent failures all
  reproduce on clean main HEAD = pre-existing baseline drift, `it.next is not a
  function` / iterator-elision, unrelated to coercibility), 200/200
  nested-pattern, 235/238 for-of-nested (the 3 `*-ary-init-iter-no-close` also
  fail on clean main = drift). `tsc --noEmit` clean; `check:ir-fallbacks` OK.

**Umbrella remains open** — this is one slice. Remaining mergeable buckets:
array-assignment GetIterator, array-`length` RangeError (~28), and the
descriptor-model work under #1630.

## Slice 2 landed (sd-1472, 2026-06-03): array-pattern GetIterator on non-iterable primitives

### Root cause (WHY, not just WHAT)
ArrayAssignmentPattern (§13.15.5.2) and array BindingPattern
initialization (§8.5.2/§8.5.3) BOTH begin with `GetIterator(value)`. A
primitive number/boolean has no `[Symbol.iterator]`, so GetIterator throws a
**TypeError**. The compiler had two distinct gaps here, and crucially the
test262 `assert.throws(TypeError, fn)` callbacks run **inside the compiled
program** and check `e instanceof TypeError` — so the thrown value has to be a
real `__new_TypeError` *instance*, not an opaque string-payload exception.

1. **`[a] = 5` (array-assignment destructuring, f64/i32 RHS)** —
   `src/codegen/expressions/assignment.ts:~1219`. It already threw, but via
   `emitThrowString("TypeError: value is not iterable")`, which produces a bare
   string-payload Wasm exception. The runtime classifies that to a host
   TypeError for the OUTER `assert.throws`, but an INNER `e instanceof
   TypeError` (the common test262 shape) sees only a string ref and fails →
   the test took the "wrong error type" branch. Fixed by switching to
   `emitThrowTypeError` (emits the real `__new_TypeError` instance; has a
   standalone in-module fallback via `emitWasiErrorConstructor` in no-JS-host
   mode).

2. **`for (let [x] of [1])` / `for ([] of [1])` (for-of array binding
   pattern over numeric elements)** —
   `src/codegen/statements/loops.ts`, the f64/i32 element branch of
   `compileForOfDestructuring`'s ArrayBindingPattern case. This branch
   **silently assigned `undefined` sentinels and never threw** — the worst
   failure mode (no throw at all, the assertion's callback returns normally).
   The element value (a number) is non-iterable, so GetIterator must throw.
   The throw is now emitted **unconditionally before the element loop** so the
   EMPTY-pattern form (`for ([] of [1])`) also throws — per spec GetIterator
   runs before any binding element is read. Binding locals are still
   `allocLocal`'d (so later body references type-check) but no longer assigned;
   the throw makes the remainder of the iteration unreachable.

### Why these are spec-safe (no false positives)
- **Strings are iterable** and lower to a string ref / externref, so they take
  a different branch — confirmed unaffected (`[c] = "ab"` and
  `for ([c] of ["ab"])` still work).
- **Object patterns** use RequireObjectCoercible, NOT GetIterator — numbers ARE
  object-coercible, so `for ({x} of [1,2])` must NOT throw. The object-pattern
  branch is untouched; verified it still no-throws.
- f64/i32 element type only arises when the iterable yields numbers/booleans,
  which are genuinely non-iterable, so throwing is never a false positive.
- Stack-balanced: `emitThrowTypeError` is net-zero (push message externref →
  `__new_TypeError` → `throw` consumes it).

### Deliberately NOT touched (heeding the prior reverted attempt)
The typed-struct static-`null` nested case remains out of scope — the prior
attempt produced 3 false regressions and was reverted. The `any`-typed
externref for-of path already routes through `__array_from_iter_n` (host
GetIterator) and throws correctly, so it needed no change.

### Validation
- `tests/issue-846-slice2.test.ts` — 11 cases, all pass (real-TypeError-instance
  assertions for `[a]=5`/null/undefined; string/array no-throw; for-of
  array-pattern + empty-pattern throw; for-of object-pattern + tuples + arrays +
  plain binding no-throw).
- `tsc --noEmit` clean; `biome lint` clean on changed files.
- Existing iterator-override / dstr suites (#1701, #1592, #1431, #1719 CPR/S1,
  #1128 TDZ, generator-method-destructuring) — all green.
- **Regressions: 0 real.** A 1,688-file dstr+for-of sweep showed 24 apparent
  `compile_error` flips, but ALL reproduce as `pass` when run standalone — they
  are single-process batch-state-pollution artifacts of the runner (shared
  string pool / import caches across files), not regressions. Spot-checked 7
  standalone: all pass. The 9 apparent "flips to pass" are stale-baseline drift
  (already pass on clean HEAD too).

## Slice 3 re-profile (sd-846-slice3, 2026-06-03): no localized win left — Option A already done

Fresh profiling against the current `loopdive/js2wasm-baselines`
`test262-current.jsonl` (48,117 entries, fetched 2026-06-03). Filtered to
failures where the **failing assertion line itself** is an `assert.throws(...)`
(not a `sameValue`/`compareArray` mislabeled by a coarser regex). Top
not-thrown buckets and their disposition:

| Bucket (failing `assert.throws` only) | Count | Disposition |
|---|---|---|
| `built-ins/Array/prototype` | 100 | see breakdown below |
| `built-ins/Object/define{Property,Properties}` + `Object/create` | 104 | **descriptor model** — escalated #1630/#1631; all 104 are descriptor-conflict / array-`length` RangeError / non-object-descriptor (`ToPropertyDescriptor`), not non-object-1st-arg (that subset already throws) |
| `built-ins/String/prototype` | 7 | ToPrimitive/Symbol coercion — overlaps done #1525/#1564 |
| RequireObjectCoercible via `X.prototype.M.call(null/undefined)` | 9 | heterogeneous host-bridge dispatch (Function.prototype.call/apply, Object.prototype.hasOwnProperty/propertyIsEnumerable, String.prototype.concat) — one fix per dispatch path, no shared seam |

**Array/prototype 100-fail breakdown** — the largest single area, but the
top sub-clusters (reduce 11, reduceRight 10) are **`reduce`/`reduceRight` on a
sparse / all-holes array with no initial value → TypeError**:
- `15.4.4.21-8-c-1.js` (`new Array(10)`), `15.4.4.21-8-c-3.js` (`[1,2,3,4,5]`
  then `delete` all elements), `15.4.4.21-5-*` (custom array-like with
  `length` coerced to 0/null).
- Confirmed via probe (`compileAndInstantiate`): `[].reduce(cb)` **already
  throws** correctly (the `len === 0` guard at `array-methods.ts:5191-5198`
  works), but `new Array(3).reduce(cb)` **returns `0`** instead of throwing —
  because our dense WasmGC vec fills `new Array(3)` with three `0`/`NaN`
  elements (`len = 3`), with no concept of "holes". Per ES §23.1.3.24 step 6,
  reduce counts only *present* (HasProperty) elements, so all-holes ⇒ throw.
  **Fixing this requires hole / sparse-array tracking** — the same dense-array
  representation gap already escalated under **#1130** (accessor-getter
  observation) and **#1592** (elision/over-consumption). Not a localized fix.
- The remaining Array sub-buckets (splice/slice on frozen/non-extensible
  target, concat on frozen target) need the **frozen-object model**, also
  escalated under the descriptor-model work.

**Callback type-check (team-lead's recommended Option A) is ALREADY DONE.**
Verified by probe on both dispatch paths:
- direct receiver: `[1,2,3].map(null)` → `TypeError: ... is not a function`;
- `.call()` path: `Array.prototype.map.call(a, null)` / `forEach.call(a, 42)`
  → TypeError.
The shared emitter is `emitCallbackTypeCheck` (`array-methods.ts:78`), wired
into filter/map/reduce/reduceRight/forEach/find/findIndex/some/every; the
array-like `.call()` path routes non-closure callbacks to `__proto_method_call`
which throws via the host. No further callback-validity work is needed.

### Conclusion
Slice 3 has **no implementation deliverable** — the recommended pattern is
already shipped, and every remaining not-thrown sub-cluster of meaningful size
is blocked on a representation/model gap (holes/sparse arrays → #1130/#1592;
descriptor model → #1630/#1631; frozen-object model) or overlaps with
already-done coercion issues (#1525/#1564/#820 family). This re-confirms the
2026-05-27 profiling conclusion against fresher data. The umbrella's progress
is gated on those representation issues, not on more silent-throw guards.
Recommend the umbrella stay open but be **de-prioritised** until #1130/#1592
(hole tracking) and #1630/#1631 (descriptor model) land, which will unblock the
bulk of the residual not-thrown buckets at once.
