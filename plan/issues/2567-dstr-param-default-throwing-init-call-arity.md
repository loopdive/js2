---
id: 2567
title: "destructuring-param default whose initializer calls a function emits C_method one operand short for the call — invalid Wasm (4 test262)"
status: ready
sprint: Backlog
created: 2026-06-21
priority: low
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [2565, 2564, 1224]
test262_bucket: dstr-param-default-throwing-init
test262_count: 4
origin: "2026-06-21 sd3, spun out of #2565: pre-existing, distinct from the $shape bucket #2565 closed"
---

# #2567 — destructuring-param default with a function-call initializer is one call-arg short

## Problem

```ts
var initCount = 0;
function thrower() { throw new Test262Error(); }

class C {
  method({ a, b = thrower(), c = ++initCount } = {}) {}
}
new C().method();   // wasm: invalid binary — C_method call arity
```

The validator error (NOT the #2565 `struct.new` shape-id symptom):

```
invalid Wasm binary: Compiling function #N:"C_method" failed:
not enough arguments on the stack for call (need 1, got 0)
```

## Affected files (4 test262, verified INVALID on origin/main 2026-06-21)

- `language/statements/class/dstr/meth-dflt-obj-ptrn-list-err.js`
- `language/statements/class/dstr/meth-static-dflt-obj-ptrn-list-err.js`
- `language/expressions/class/dstr/meth-dflt-obj-ptrn-list-err.js`
- `language/expressions/class/dstr/meth-static-dflt-obj-ptrn-list-err.js`

These are negative-behaviour tests (`assert.throws(Test262Error, () => c.method())`)
of left-to-right param-default evaluation: the **first** binding default (`b =
thrower()`) must throw before the later default (`c = ++initCount`) runs, so
`initCount` stays 0.

## Root cause (distinct from #2565)

Spun out of #2565, which was closed as fixed-by-#2564 (the `$shape`-arity
symptom was a face of the shared-`blockType` DCE bug). This bug is **different**:
it is NOT a nested object pattern (`obj-ptrn-prop-obj`) and NOT a `struct.new`
shape-id arity mismatch. The shape is a **destructuring param whose binding
default is a function CALL** (`b = thrower()`), and the emitted `call` to the
default-initializer function lands one operand short (`need 1, got 0`) — the
materialization of the default-value call in the param-destructuring prologue
fails to push the callee's argument (or pushes the call before its receiver/arg
is staged). Was INVALID on main BEFORE #2564 too — pre-existing, unrelated to
the `$shape` collision-resolution pass.

## Fix direction

Inspect the destructuring-param default-initializer lowering (the
`__ext_dparam` / class-method param-default prologue) for the case where the
default value is a `CallExpression`: ensure the call's argument(s)/receiver are
staged on the stack before the `call`. Likely the default-slot guard
(`if arg === undefined → evaluate default`) emits the call body without first
materializing its operands, or drops them when the default expression itself
has side effects / throws.

## Acceptance criteria

- The 4 `*-list-err` files compile to valid Wasm and pass (the throwing default
  throws `Test262Error`, `initCount` stays 0).
- No regression in existing destructuring-param-default / class-method suites.
