---
id: 1529
sprint: backlog
title: "codegen: 'illegal cast' umbrella at closure & destructuring parameter boundaries"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion, destructuring, closures, wasm-gc
es_edition: n/a
test262_category: multiple (class, async-generator, eval-code, super, for-await-of)
test262_count: 241
related: [1257, 1451, 1452]
---

# #1529 — Runtime `illegal cast` failures cluster at closure/destructuring boundaries

## Problem

241 test262 tests fail with runtime traps of the form:

```
L41:3 illegal cast [in __closure_N() ← assert_throws ← test]
L65:3 illegal cast [in __closure_0() ← test]
L8:5 illegal cast [in C_method() ← test]
```

This is the `ref.cast`/`ref.cast null` instruction failing at runtime
because the dynamic value's actual heap type doesn't match the
codegen's static expectation. Distribution by call-site shape:

| Shape | Count | Likely path |
|-------|-------|-------------|
| `__closure_N()` inside `assert_throws` | ~90 | default-param closure with extern-typed binding |
| `C_method() / C___priv_method()` | ~70 | class method body cast after destructuring |
| `fn() ← test` (for-await/for-of) | ~50 | iterator value cast at binding init |
| top-level `test()` | ~30 | other paths |

These are **runtime** casts (the Wasm validates fine), distinct from
#1522. They typically appear after destructuring with a default
initialiser or when a closure inherits an extern-typed captured
binding.

## Failing test examples

- `test/language/eval-code/direct/async-func-expr-named-fn-body-cntns-arguments-func-decl-declare-arguments.js`
- `test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-elem-id-init-unresolvable.js`
- `test/language/statements/class/dstr/meth-static-obj-ptrn-list-err.js`
- `test/language/statements/for-await-of/async-func-decl-dstr-array-elem-init-in.js`
- `test/built-ins/Array/prototype/map/15.4.4.19-9-1.js`

## Approach

1. Pick the largest sub-cluster (default-param closure cast).
   Use `.tmp/` to reduce one test to ~10 lines.
2. Inspect emitted Wasm — likely the closure body assumes a narrower
   ref type than the caller can supply.
3. Either widen the param type to `anyref`/`externref` with a guarded
   cast that throws spec `TypeError`, or do upfront coercion at the
   call site.

## Acceptance criteria

- At least 100 of the 241 cluster tests flip from runtime trap →
  pass / assertion-fail.
- No new compile errors.
- Targeted regression test under `tests/`.

## Estimated impact

**~241 test262 tests** — high spread, so realised gain depends on
which sub-cluster is fixed first.
