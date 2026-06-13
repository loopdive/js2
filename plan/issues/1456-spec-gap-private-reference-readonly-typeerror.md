---
id: 1456
title: "spec gap: private-reference assignment to readonly accessor / method throws TypeError"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, private-fields, compound-assignment
goal: spec-completeness
sprint: 52
related: [1431, 1434]
---
# #1456 — Private accessor/method LHS in compound assignment must throw TypeError

## Problem

Per ECMA-262 §13.15 (AssignmentExpression) and §7.3.18
(PrivateElementSet / PrivateElementGet), assigning to a **private
reference** whose `PrivateElement` is:

- a **method** (`#m`), or
- an **accessor** with only a getter and no setter,

must throw `TypeError`. Compound assignment operators (`|=`, `&=`,
`+=`, `*=`, `%=`, `**=`, `??=`, etc.) read-then-write the LHS, so
they also must throw on the *write* step even when the read step
succeeded.

Example (`left-hand-side-private-reference-method-mod.js`):

```js
class C {
  #m() {}
  compoundAssignment() { this.#m %= 1; }   // must throw TypeError
}
assert.throws(TypeError, () => new C().compoundAssignment(),
              "Putter throws TypeError ...");
```

Today we silently allow the write — sometimes overwriting the private
brand entry, sometimes producing wasm-validation errors when the
brand entry has a struct-method shape.

## Failure count

**~50 fails** in
`language/expressions/compound-assignment/left-hand-side-private-reference-*`,
covering each compound operator × {readonly-accessor, method,
no-setter, brand-check}.

Symptom: `assertion_fail` on
`assert.throws(TypeError, () => o.compoundAssignment(), "Putter throws TypeError…")`.

## Root cause

`src/codegen/expressions/assignment.ts` (or the private-field
emission helpers) treats every private LHS as if it were a writable
field. The brand table contains entries tagged `method`, `accessor-get`,
`accessor-set`, `field`; the assignment path likely:

1. Looks up the brand entry only to grab its slot index, ignoring the
   `kind` tag.
2. Writes regardless of `kind`.

For compound assignments we additionally need:

- Read step: PrivateElementGet — for accessor with only a getter, the
  read works; for an accessor with only a setter, the read must
  throw TypeError. For a method, the read returns the method value.
- Write step: PrivateElementSet — for a method or getter-only
  accessor, throw TypeError. For a setter-only accessor, call the
  setter.

## Implementation strategy

1. Audit the private-reference emission in
   `src/codegen/expressions/assignment.ts` and `class-bodies.ts`
   (search for `PrivateIdentifier`, `__priv_`, `#`).
2. For each private LHS in an `AssignmentExpression` (simple or
   compound), branch on the brand entry's `kind`:
   - `field`: read and write the slot as today.
   - `accessor`: call getter for read; call setter for write; throw
     TypeError if the matching half is absent.
   - `method`: throw TypeError on any write (simple `=` or
     compound).
3. Emit the TypeError via the existing `__throw_typeerror` /
   `__throw_typeerror_msg` helper.
4. For compound operators, the spec evaluates the LHS once (the
   `Reference` is created with the bracketed-name semantics for
   PrivateIdentifier); ensure we don't double-evaluate the receiver
   expression in `this.#m %= 1`.

## Acceptance criteria

1. `test/language/expressions/compound-assignment/left-hand-side-private-reference-method-mod.js`
   passes.
2. `test/language/expressions/compound-assignment/left-hand-side-private-reference-readonly-accessor-property-bitor.js`
   passes.
3. Plain-assignment counterparts in
   `language/expressions/assignment/` continue to pass (no
   regression on simple `=`).
4. All `left-hand-side-private-reference-*` failures in
   `compound-assignment/` reduce to ≤ 5.
5. Single-receiver evaluation is preserved (e.g.
   `(sideEffect()).#m += 1` calls `sideEffect()` exactly once even
   in the throw path).

## Files to inspect

- `src/codegen/expressions/assignment.ts` — compound-assignment
  emission.
- `src/codegen/class-bodies.ts` — private brand table, accessor
  emission.
- `src/codegen/expressions/identifiers.ts` — `PrivateIdentifier`
  resolution.
- `src/runtime.ts` — `__throw_typeerror_msg` (or equivalent) for
  generating the spec'd error.
- `tests/issue-1456.test.ts` — one repro per operator/private-kind
  combination.

## Out of scope

- Non-private accessor TypeError on readonly data property (separate
  set of `11.13.2-*-s.js` failures — strict-mode behaviour).
- `Object.defineProperty called on non-object` — separate fault
  path (compound-assignment to coerced primitive receiver).
