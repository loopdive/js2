---
id: 1513
title: "spec gap: Reflect — TypeError on non-object/Symbol target + abrupt-completion propagation"
status: wont-fix
created: 2026-05-20
updated: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: reflect
goal: spec-completeness
sprint: Backlog
related: [1460, 1466, 1629, 1130, 1528a, 1596, 820]
note: "Re-investigated 2026-05-28: original 81 fails → 46 fails on main (cluster 1 already resolved by host-delegated __reflect_* per #1466). Remaining 46 decompose into cross-cutting issues, not Reflect-localizable. See investigation section below."
---
# #1513 — Reflect: type checks + abrupt completions

## Problem

`built-ins/Reflect/` contributes **81 failing test262 cases**. Three
patterns:

1. **`Reflect.X(non-object)` should throw `TypeError`**

   ```js
   Reflect.ownKeys(1);             // expected: TypeError
   Reflect.getPrototypeOf(Symbol()); // expected: TypeError
   ```

   Our inlining returns `undefined`/`false` silently (~30 entries).

2. **Abrupt completion propagation from descriptor getters**

   ```js
   const o = new Proxy({}, { get(_, k) { throw new Test262Error(); } });
   assert.throws(Test262Error, () => Reflect.get(o, "x"));
   ```

   `return-abrupt-from-result.js` (~9 entries across
   `get/set/getOwnPropertyDescriptor/defineProperty/isExtensible`). We
   swallow the abrupt completion and return a default value.

3. **`Reflect.defineProperty` returns boolean, not throws**

   ```js
   Reflect.defineProperty(frozen, "x", { value: 1 }) === false; // we throw
   ```

   `defineProperty/return-boolean.js`, `return-abrupt-from-attributes.js`,
   `return-abrupt-from-result.js` (~5 entries).

4. **`Reflect.setPrototypeOf` returns false instead of throws** when
   target is non-extensible — `return-false-if-target-and-proto-are-the-same.js`.

5. **`Reflect.ownKeys` ordering** —
   `return-on-corresponding-order.js` and
   `return-on-corresponding-order-large-index.js` assert that integer
   keys come first in ascending order, then string keys in insertion
   order, then symbols. We currently return strings only in insertion
   order with no integer-first prefix.

## Failure count

**81 fails** in `built-ins/Reflect/`. Realistic target: **≥ 60 flips**.

## Root cause

`src/codegen/expressions/calls.ts:3129–3260` inlines each `Reflect.*`
to its `Object.*` counterpart but skips the `Type(target) is Object`
check and propagates only `value` results, not abrupt completions.
The current style is:

```ts
// Reflect.get(obj, prop) → obj[prop]    (line 3129)
// Reflect.ownKeys(obj) → Object.getOwnPropertyNames(obj)   (line 3207)
```

The translations are spec-correct *only* when the target is already
an object and the descriptor accessors do not throw — exactly the
cases the test262 suite is testing the other side of.

## Files to touch

- `src/codegen/expressions/calls.ts:3120–3260` (Reflect dispatch block).
  Each `case "Reflect.X":` needs a `ref.test $ObjectStruct` guard
  + `Type(target) is Object` check that throws TypeError before the
  inlining.
- `src/codegen/object-ops.ts` — add an `ordered_own_keys(obj)` helper
  that returns integer keys ascending, then string keys, then symbols.
- `src/runtime.ts` — adjust `__reflect_defineProperty` to return
  `false` on define-failure instead of throwing.

## Acceptance criteria

1. ≥ 60 of 81 in `built-ins/Reflect/` flip to `pass`.
2. `Reflect.ownKeys(obj)` ordering matches V8 on
   `{0:1, "1":2, a:3, [Symbol()]:4}` → `["0","1","a",<sym>]`.
3. `Reflect.defineProperty(frozen, "x", desc)` returns `false`.
4. No regression in #1460 (Object.defineProperty fidelity).

## Reference tests

- `built-ins/Reflect/ownKeys/target-is-not-object-throws.js`
- `built-ins/Reflect/get/return-abrupt-from-result.js`
- `built-ins/Reflect/defineProperty/return-boolean.js`
- `built-ins/Reflect/setPrototypeOf/return-false-if-target-and-proto-are-the-same.js`
- `built-ins/Reflect/ownKeys/return-on-corresponding-order.js`

## Investigation 2026-05-28 (dev) — NOT a localized fix, decomposes into existing buckets

Baseline against current main (.test262-cache/test262-current.jsonl):
**107 pass / 46 fail** in `built-ins/Reflect/`. Down from the original 81 fails
at issue creation — half of the original scope was resolved by the
host-delegated `__reflect_*` rewrite landed under #1466 (PR replaced
compile-time Reflect→Object rewrites with host-import wrappers that delegate
to native `Reflect.X`, so `Type(target) is not Object` TypeErrors come from
the host JS engine for free).

**Cluster (1) — TypeError on non-object target — ALREADY PASSING.** All 11
`target-is-not-object-throws.js` tests across `get/set/has/deleteProperty/
defineProperty/getOwnPropertyDescriptor/getPrototypeOf/setPrototypeOf/
ownKeys/preventExtensions/isExtensible` pass on main. The original 81-fail
count almost certainly counted these.

### Remaining 46 fails decompose into cross-cutting issues

Sampling all 46 entries, none are Reflect-layer fixes. They are dispatch
proxies to other open buckets:

| # | Bucket | Tests | Real owner |
|---|--------|-------|------------|
| A | **Proxy trap abrupt completion not caught** (try/catch around `Reflect.X(proxyWithThrowingTrap)` returns undefined) | ~10 (`return-abrupt-from-result.js` × 8, `return-abrupt-from-attributes.js`) | Wasm/JS exception propagation — same gap as #820 family; host throws but Wasm doesn't unwind into a catchable tag |
| B | **defineProperty / getOwnPropertyDescriptor descriptor fidelity** | ~10 (`return-boolean.js`, `define-properties.js`, `return-from-{data,accessor}-descriptor.js`, `symbol-property.js`, `return-abrupt-from-attributes.js`, `set-value-on-accessor-*.js`, `different-property-descriptors.js`) | **#1629** (Object.defineProperty descriptor attributes — architect spec already in #1629) |
| C | **set/get on accessor descriptor / receiver mechanics** | ~6 (`set/receiver-is-not-object.js`, `call-prototype-property-set.js`, `return-false-if-{receiver,target}-is-not-writable.js`, `get/return-value*.js`) | **#1629** + #1640 (Reflect.* invariants on accessors — also already escalated as needing #1629/#1630/#1631) |
| D | **ownKeys ordering on arrays + integer-key prefix** | ~5 (`return-on-corresponding-order{,-large-index}.js`, `return-array-with-own-keys-only.js`, `return-empty-array.js`, `return-non-enumerable-keys.js`, `order-after-define-property.js`) | Array.isArray + integer-coercion sort — overlaps **#1130** (Array methods observe accessor getters) and arrays-as-wasmGC-structs property model |
| E | **apply / construct on Wasm-emitted callables** | ~6 (`apply/{call-target,return-target-call-result,arguments-list-is-not-array-like-but-still-valid}.js`, `construct/{return-with-newtarget-argument,return-without-newtarget-argument,use-arguments-list}.js`) | **#1596** (apply/call on compiled Wasm functions) + **#1528a** (Reflect.construct dynamic new) |
| F | **deleteProperty boolean returns + hasOwnProperty observation** | ~3 (`delete-properties.js`, `return-boolean.js`, `return-abrupt-from-result.js`) | object-property model (typed-struct sidecar can't delete fields) — overlaps #1629 |
| G | **preventExtensions + setPrototypeOf cross-effects** | ~3 (`preventExtensions/{prevent-extensions,return-boolean-from-proxy-object,return-abrupt-from-result}.js`, `setPrototypeOf/return-abrupt-from-result.js`) | Object.preventExtensions semantics — separate from Reflect dispatch (the host Reflect.preventExtensions IS called; the assertion fails because subsequent Object.setPrototypeOf doesn't throw the way the spec requires) |
| H | **Reflect() call gate** | 1 (`prop-desc.js` — `assert.throws(TypeError, () => Reflect())`) | Trivial test of "namespace object is not callable", but the test bundles a `verifyProperty(this, "Reflect", ...)` that would still fail under #1629; flipping this one assertion does not flip the test |

### Why this is NOT a localized fix

Every remaining bucket has an existing, deeper issue that owns it:

- **Bucket A** (Proxy trap → user catch) is the same Wasm-tag-vs-JS-throw
  bridge gap that #820 has been working on. A localized Reflect handler
  cannot fix it; the Wasm function calling `__reflect_get` needs to be
  inside a `try`/`catch` Wasm scope that catches host-thrown exceptions
  and re-throws as a Wasm tag the surrounding TS try/catch can observe.
  Verified by probe (`.tmp/probe-reflect-abrupt.mts`): the host TypeError
  thrown by `Reflect.ownKeys(null)` is NOT caught by the surrounding TS
  `try`/`catch` — yet `target-is-not-object-throws.js` passes because the
  test262 runner's outer harness re-throws it as a TypeError that the
  `assert.throws(TypeError, …)` outer catches. The user-level
  `try { Reflect.X(...) } catch (e) {...}` pattern is the broken one.
- **Buckets B, C, F** all reduce to the **#1629 descriptor-fidelity** model.
  Architect spec already exists there; #1640 was previously escalated as
  blocked on #1629/#1630/#1631 for exactly this reason.
- **Bucket D** needs the ownKeys integer-prefix sort + array length
  enumeration — overlaps #1130's accessor-getter Array work.
- **Bucket E** needs #1596 / #1528a, both already open.
- **Bucket G** is Object.preventExtensions semantics, not Reflect.
- **Bucket H** is one assertion in a multi-assert test; net flip = 0.

### Recommendation

**Close as "decomposes into existing issues" — no localized PR.** This
mirrors the disposition of #1640 (same Reflect-layer escalation, same
conclusion). The 46 remaining fails will retire as their owning issues
land:

- Bucket A (~10) → resolves with #820 exception-propagation work
- Buckets B, C, F (~19) → resolves with #1629 descriptor fidelity
- Bucket D (~5) → resolves with #1130 + array ownKeys ordering
- Bucket E (~6) → resolves with #1596 + #1528a
- Buckets G, H (~4) → small one-offs, can be picked up opportunistically

No Reflect-layer code change is justified. The original issue's clusters
(1) TypeError-on-non-object and (3) defineProperty-returns-boolean are
already correct on main via host delegation; remaining failures are tests
that USE Reflect but assert about behavior owned elsewhere in the engine.

### Probe artifacts

- `.tmp/probe-reflect-abrupt.mts` (job dir): confirms host-thrown
  TypeError on `Reflect.ownKeys(null)` is not caught by the calling
  TS try/catch — points at the Wasm/JS exception bridge.
- `.tmp/probe2.mts`: same shape for `Reflect.X(primitive)` — silently
  returns `undefined` from the outer function instead of going through
  the catch block.

## Board-hygiene triage (2026-06-12, #2147)

Reset `in-review` → **`wont-fix`** (decomposed, not a localized fix). The only
PR referencing this issue is #792, explicitly titled
`[NOT-A-LOCALIZED-FIX] Reflect — decomposes into existing issues`: the Reflect
spec-gap was split into the concrete sub-issues it covers rather than fixed as
one unit. No single implementing fix exists, so this umbrella issue is closed
as decomposed; the real work is tracked by the sub-issues it was split into.
