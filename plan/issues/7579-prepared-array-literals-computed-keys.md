---
id: 7579
title: "Prepared path: array literals and computed member keys (array PR B)"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7352]
related: [7352, 7561, 7574, 7354]
---

# #7579 — Prepared path: array literals and computed member keys

## Problem

Array PR A (#7352, branch `claude/7352-arrays-a`) made `Array` a realm value on the Prepared whole-program path
(`Array(…)`, `Array.isArray`, `length`, constant index keys). Two shapes that almost every test262 body and the
harness (`propertyHelper.js`, `compareArray.js`) use still stop the path:

- an array literal: `var a = [1, 2]` refuses at module level ("mixed-type array literal"), and aborts inside a
  function (its function's abort body);
- a computed member key: `a[i]`, `o[k] = v` refuse on every receiver ("dyn.member_get with a computed key").

Specification: #7352's "Re-build on #7561", the part on PR B, and the requirements carried from A1a's reviews r1/r2
(`origin/claude/7354-a1`, #7354's file).

## Implementation Plan

### Target structure

- **The literal** (`src/ir/prepared-array-literal.ts`, new, mined from A1a): the front end evaluates the elements
  left to right and emits ONE helper call, `__ir_array_literal`, typed dynamic. Its operands are the literal's length
  (an f64: holes and a trailing elision counted, a trailing comma not) and then each present element's index key and
  value. No length or index in the symbol text, no parser. A spread element refuses by name.
- **from-ast** keeps one arm: `lowerArrayLiteral` hands a literal the Prepared resolver owns
  (`preparedRealmLiteral`, the renamed `preparedOrdinaryObjectLiteral`, one predicate for both literal kinds) to the
  new module; the empty-literal vec inference is skipped for it. `from-ast.ts` does not grow.
- **The legalization** (`dynamic-array-constructors.ts`): the helper call is written with PR A's `arrayOf`, now taking
  key/value pairs, so `Array(…)` and the literal share the one ArrayCreate-then-CreateDataProperty helper
  (CreateDataProperty, never [[Set]]: no setter on `Array.prototype` runs, no user `Array` is called).
  `isArrayLiteralCall` sits beside `realmConstructorOf` in `dynamic-realm-calls.ts`; `carrierKindOf` and
  `knownKinds` read the call as an object.
- **Holding**: `source-plain-objects.ts` adds the array family for a literal (one line, what `constructorRead`
  does for `Array`).
- **Computed keys** (`dynamic-member-access.ts`): `computedAccess`, an `Access` of the same shape as the constant
  read and write, written over the key's kinds. A string key is the key; a number, boolean, `undefined` or `null` key
  is the program's ToString (`stringOf`, the same Number::toString a constant number key's `constantKey` uses — one
  canonicalisation); an object or function key is the run-time abort (its ToPrimitive is observable). A primitive
  receiver is the run-time abort. The constant write's `putValue` becomes a shared function both writes use.
- **Partial objects under a computed key**: settled by measurement in the result section. Plan: keep #7561's pin
  rule for constant keys; for a computed key no member is pinned, and a [[Get]] miss on a key that may name a member
  the realm did not materialise is the run-time abort (`is-partial`'s question, answered without a call where the
  answer is the same for every chain).

### Reuses / removes

- Reuses `arrayOf`, `constantKey`'s canonical string, `memberAccess`, `typeErrorThen`, `stringOf`, `toNumber`,
  `OBJECT_PROTOTYPE_ACCESSOR_KEYS` / `FUNCTION_PROTOTYPE_ACCESSOR_KEYS`, `dynamicStoreOperand`.
- Removes: from-ast's `191` (`FULL_DATA_DESCRIPTOR`); the two `putValue` closures become one; PR A review findings
  folded (refusal-text assertions in `tests/issue-7352-arrays.test.ts`, `HeldFamily.throws` single user, the `A1b`
  history comment in `ordinary-to-primitive.ts`, `CARRIER` / `BOOLEAN` imported from two modules in
  `dynamic-prototype-methods.ts`).

### Acceptance

1. Literals and computed keys agree with node (fresh realm, each agreement with a wrong twin) at module level and in
   functions; 0 wrong, 0 invalid Wasm, 0 exceptions out of `compile()`.
2. Out of scope keeps refusing or aborting: for-in / for-of over arrays, spread, destructuring, `Array.prototype`
   method bodies, `Array.from` / `of`, `Object.getOwnPropertyNames` / `keys` on arrays, `JSON`, `arguments`,
   `Function` / `call` / `bind`; ToPrimitive of an array aborts before reading `toString` / `valueOf`.
3. Code quality: one literal helper symbol carried by operands; one `arrayOf`; one key canonicalisation; computed
   access an `Access` like its constant siblings; no new IR→runtime import edge (10); `from-ast.ts` ≤ 17,395 lines.
4. Ordinary pipeline byte-identical; a Prepared program with no literal and no computed key byte-identical.
5. test262 (own runner): the 91 ES5 `built-ins/Array` no-include files and `mw-00` (87 rows), base vs head, no pass
   lost.
