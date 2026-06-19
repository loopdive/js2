---
id: 2201
title: "Logical-assignment NamedEvaluation — `x ??=/||=/&&= fn` must set fn.name to \"x\" (~9 test262 fails)"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: logical-assignment
goal: spec-completeness
related: []
test262_bucket: logical-assignment-namedeval
test262_count: 9
es_edition: es2021
origin: "2026-06-19 sprint-64 standalone failure mining: language/expressions/logical-assignment/*namedevaluation* fail value.name assertion. Anonymous fn/arrow RHS of ??=/||=/&&= does not inherit the LHS identifier name."
---

# #2201 — Logical-assignment NamedEvaluation (function name inference)

## Problem

ECMA-262 §13.15.2 (Assignment Operators / Logical Assignment runtime semantics)
specifies **NamedEvaluation** for the logical-assignment operators `&&=`, `||=`,
`??=`: when the LHS is a plain `IdentifierReference` and the RHS is an
*anonymous* function/arrow/class definition, the resulting function inherits the
LHS identifier as its `.name`.

```
LeftHandSideExpression &&= AssignmentExpression
  5. If IsAnonymousFunctionDefinition(AssignmentExpression) and
     IsIdentifierRef of LeftHandSideExpression are both true, then
       a. Let rval be NamedEvaluation of AssignmentExpression with argument
          GetReferencedName(lref).
```

The compiler does not apply NamedEvaluation on the logical-assignment path, so
the anonymous RHS function keeps the empty name (`""`) instead of the LHS name.
This mirrors the same rule the compiler already applies to ordinary `=`
assignment (`const f = () => {}` ⇒ `f.name === "f"`) and to `+=`-style operators
that don't apply it (those correctly do NOT name) — only the **logical**
assignment trio is missing it.

## Spec

- §13.15.2 ApplyStringOrNumericBinaryOperator / Logical Assignment Operators:
  https://tc39.es/ecma262/#sec-assignment-operators-runtime-semantics-evaluation
- NamedEvaluation: https://tc39.es/ecma262/#sec-runtime-semantics-namedevaluation

## Minimal repro

```js
// &&=  (LHS truthy → RHS evaluated, gets named)
var a = 1;
a &&= function () {};
// assert a.name === "a"     (compiler: a.name === "")

// ||=  (LHS falsy → RHS evaluated, gets named)
var b = 0;
b ||= () => {};
// assert b.name === "b"

// ??=  (LHS nullish → RHS evaluated, gets named)
var c = null;
c ??= function () {};
// assert c.name === "c"
```

## Failing test262 cluster

`test/language/expressions/logical-assignment/*namedevaluation*` — **9** fails.
Assertion form: `assert.sameValue(value.name, "value", "value")`. Files:

- `lgcl-and-assignment-operator-namedevaluation-function.js`
- `lgcl-and-assignment-operator-namedevaluation-arrow-function.js`
- `lgcl-nullish-assignment-operator-namedevaluation-function.js`
- `lgcl-nullish-assignment-operator-namedevaluation-arrow-function.js`
- (plus the `lgcl-or-*` variants and class-RHS variants)

## Approach (sketch)

In the codegen path for logical-assignment (`&&= / ||= / ??=`), when:
- the LHS is a bare identifier reference, **and**
- the RHS is an anonymous function/arrow/class expression (no own name),

propagate the LHS identifier name into the function's `name` metadata — the same
NamedEvaluation hook the plain-`=` assignment path already uses. Only the
short-circuit "RHS is evaluated" arm needs it (when the operator short-circuits
and the RHS is not evaluated, there is nothing to name).

Reuse the existing assignment NamedEvaluation machinery — do not invent a new
naming path. This is an XS change.

## Acceptance criteria

- [ ] All three repro snippets: `a.name === "a"`, `b.name === "b"`, `c.name === "c"`.
- [ ] A named RHS is **not** renamed: `a ||= function g(){}` ⇒ `a.name === "g"`.
- [ ] `>= 8` of the 9 `logical-assignment/*namedevaluation*` tests flip to pass.
- [ ] No regression in plain-`=` NamedEvaluation or in `+=`/arithmetic-assignment
      (which must NOT name).
- [ ] A focused `tests/issue-2201-*.test.ts`.
