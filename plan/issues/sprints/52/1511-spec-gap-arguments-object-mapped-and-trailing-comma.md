---
id: 1511
sprint: 52
title: "spec gap: arguments object — mapped semantics, descriptors, trailing-comma length"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
related: [1364, 1432]
---
# #1511 — arguments object fidelity

## Problem

`language/arguments-object/` contributes **181 failing test262 cases**.
Three sub-clusters:

| Sub-cluster | Count | Symptom |
|-------------|------:|---------|
| Trailing-comma `arguments.length` on class methods | ~120 | `assert.sameValue(arguments.length, 2)` fails |
| Mapped `arguments[i]` non-configurable / non-writable defineProperty | ~30 | redefining slot fails to throw or silently drops link |
| `S10.6_A*` legacy reflection | ~20 | arrow-function `arguments` lookup wrong; `arguments.callee` wrong descriptor |

### Trailing-comma pattern

```js
class C {
  m(a, b,) { return arguments.length; }
}
new C().m(1, 2);  // expected 2 — we return 0 / formal-count
```

The same pattern recurs across every class-method variant:
`cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`,
`cls-expr-private-meth-args-trailing-comma-spread-operator.js`,
`func-expr-args-trailing-comma-spread-operator.js`, etc.

### Mapped slot pattern

```js
function f(a) {
  Object.defineProperty(arguments, "0", { writable: false });
  a = 1;
  return arguments[0];  // expected: original argument; not 1
}
```

Per ECMA-262 §10.4.4 (Arguments Exotic Objects), in sloppy mode the
arguments object's indexed slots are *linked* to the parameter
bindings. `defineProperty` with `writable:false` removes the link
without breaking the property; subsequent parameter writes must not
update `arguments[i]`.

## Failure count

**181 fails** in `language/arguments-object/`. Realistic target:
**~120 flips** (the legacy `S10.6_A*` cluster overlaps with `with`
statement / annex B and is left for #1387 / #1518).

## Root cause

1. **Class method trampolines** (`src/codegen/class-bodies.ts:1080–1242`)
   pre-fill omitted formals with `__get_undefined()` before calling
   the user method. The trampoline then constructs `arguments` from
   the *resolved* formal slots, not the call-site list. Result:
   `arguments.length` always equals the formal count.

2. **Mapped binding** is built at function entry by
   `src/codegen/arguments-object.ts` (or equivalent) as a unidirectional
   copy of parameter values into a struct field. There is no
   "delete link" flag, so a subsequent `defineProperty` cannot break
   the link.

3. **Arrow-function `arguments`** is correctly inherited from the
   enclosing function in most cases, but `arrow-fn-body-cntns-arguments-lex-bind-arrow-func-declare-arguments-assign.js`
   fails because a sloppy-mode shadow `let arguments = 'local'`
   inside an arrow body is not honoured.

## Files to touch

- `src/codegen/class-bodies.ts` — method trampoline must pass the
  *call-site* argv length (separate from formal-slot count).
- `src/codegen/arguments-object.ts` — add a "linked" bitset to the
  arguments struct; clear the bit on any `defineProperty` /
  `delete arguments[i]`.
- `src/codegen/expressions/calls.ts` — direct invocation path
  (non-method) also needs the call-site length.
- `src/codegen/scope-analysis.ts` (if present) — arrow-body
  `let arguments` should bind locally, not inherit.

## Acceptance criteria

1. ≥ 120 of 181 in `language/arguments-object/` flip to `pass`.
2. `nonconfigurable-nonwritable-descriptors-basic.js` passes
   (defineProperty fidelity test on arguments).
3. No regression in `tests/equivalence.test.ts`.

## Reference tests

- `language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`
- `language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-basic.js`
- `language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js`
- `language/arguments-object/func-expr-args-trailing-comma-spread-operator.js`
