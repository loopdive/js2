---
id: 1567
title: Builtin subclass prototype splice leaks side effects (TypedArray length descriptor + RegExp brand)
status: ready
feasibility: hard
owner: senior-developer
type: fix
created: 2026-05-21
source: plan/issues/sprints/53/post-wave-regression-investigation.md
blocks: []
depends_on: []
labels: [test262, regression, builtin-subclass]
---

# #1567 — Builtin subclass proto splice leaks side effects

## Background

PR #459 (commit `ca3e37094`, merge `7f38872e8`) added `__set_subclass_proto(instance, subName, parentName)` to make `instance instanceof Sub` work for class-extends-builtin. Net win on test262: ~60/64 `class/subclass-builtins/` tests, but three regressions slipped in.

## Failing tests (post-wave 2026-05-21)

1. `test/built-ins/TypedArray/prototype/length/length.js`
   - Asserts `Object.getOwnPropertyDescriptor(TypedArray.prototype, "length").get.length === 0`.
   - Now fails at `verifyProperty(desc.get, "length", { value: 0, ... })` — the getter's own Function `.length` is wrong (or the descriptor flags are wrong).
2. `test/built-ins/TypedArray/prototype/findLastIndex/BigInt/get-length-ignores-length-prop.js`
   - Does `Object.defineProperty(sample, "length", { get, configurable: true })` on a BigInt TypedArray instance returned by `new TA([42n])`.
   - Now throws `Cannot redefine property: length` at L43:3 — the instance's `length` slot is not configurable after the prototype splice.
3. `test/built-ins/RegExp/prototype/test/S15.10.6.3_A2_T8.js`
   - Stamps `RegExp.prototype.test` onto `Object.prototype`, calls it as `".".test("...")`, expects TypeError.
   - Now reaches `e instanceof TypeError !== true` — either no error was thrown or a non-TypeError leaked through. The brand check for "this is a RegExp" is regressed.

## Root cause hypothesis

`__set_subclass_proto` rewires `instance.__proto__` to the synthetic `Sub.prototype` whose `__proto__` is the parent's prototype. Side effects:

- (#1, #2) The parent's `length` descriptor may now be **re-projected onto each instance** as an own slot (when bumping through the proto chain rewrite), with `configurable: false` carried from the parent class. The original `length` on the host TypedArray instance was a per-instance non-configurable accessor; redefining required `configurable: true` which is no longer in effect after our intervention.
- (#3) The `__instanceof` host import now consults the synthetic-class registry first. When the LHS is the string `"."` rebound to call `RegExp.prototype.test`, the brand check inside `RegExp.prototype.test` (host-side) may resolve `this` through the new registry and find a fallback that doesn't throw.

## Implementation plan

Each of the three failures will need its own micro-fix; not a single root cause:

### Fix 1 — TypedArray.prototype.length getter `.length`

In `src/runtime.ts`, when registering the TypedArray prototype accessor descriptor, ensure the getter `Function.length` is set to 0 (built-in default). This is a `Object.defineProperty(getter, "length", { value: 0, configurable: true })` on the synthetic accessor we expose. Cite: spec §17 ("Every built-in Function object ... has a length property ... value equal to the largest number of named arguments").

### Fix 2 — Configurability of instance `length` after splice

In `__set_subclass_proto` (`src/runtime.ts`), do not project the parent's `length` slot onto the instance. Either:
- (a) After the prototype splice, walk the instance's own keys and ensure any keys that originated from the parent's prototype (not own slots) are removed from the instance's own keys.
- (b) Or: use `Object.setPrototypeOf(instance, syntheticProto)` directly, which does NOT copy parent keys; the failure must be in extra `Object.defineProperty` calls we make inside the helper for TypedArray. Audit those calls and gate them by `parentName === "TypedArray"` to skip when the slot is already accessible via the prototype chain.

### Fix 3 — RegExp brand check via Object.prototype call

In `src/runtime.ts`, the host import that backs `RegExp.prototype.test` (likely `__regexp_test` or routed through host call dispatcher) must verify `this` is a RegExp instance and throw TypeError otherwise. If the call site was already throwing pre-#459, find where #459's `__instanceof` host import or the `classExprNameMap` fallback in `compileHostInstanceOf` (`src/codegen/expressions.ts`) intercepts the brand check and short-circuits it. Solution: brand check is a separate `[[Class]]` check, not an `instanceof` walk — keep them separate.

## Acceptance criteria

- All three test262 tests above pass.
- `tests/issue-1455.test.ts` continues to pass (no regression of the original #1455 fix).
- `language/{statements,expressions}/class/subclass-builtins/` test262 sweep still > 55/64.

## References

- PR #459 / commit `ca3e37094` "fix(#1455): make `instance instanceof Sub` work for builtin subclasses"
- Investigation: `plan/issues/sprints/53/post-wave-regression-investigation.md`
- Failing tests sampled locally on `main` (Wasm-side, not JS host) and still fail.
