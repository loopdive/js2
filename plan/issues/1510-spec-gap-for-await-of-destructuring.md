---
id: 1510
title: "spec gap: for-await-of destructuring — await on IteratorStep + binding initialization"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: async-iteration, destructuring
goal: spec-completeness
sprint: 52
related: [1373, 1373b, 1451, 1454]
---
# #1510 — for-await-of destructuring shape/await errors

## Problem

`language/statements/for-await-of/async-{func,gen}-{decl,dstr}-*` accounts
for **~400 failing test262 cases** with patterns like:

```js
async function f(iter) {
  for await (const [x = y, ...rest] of iter) { … }
}
```

Symptoms in test262:

- `illegal cast [in fn() ← test]` on rest patterns (~25 entries).
- `dereferencing a null pointer` on nested array elem init (~30 entries).
- `assert.sameValue(initCount, 0)` — defaults fire on the wrong branch
  (~80 entries).
- `',' expected.` on one outlier (`async-func-decl-dstr-array-elem-init-in.js`)
  — parser confusion when the `in` keyword appears inside the
  initializer of an array element inside for-await-of head.

## Failure count

**~400 fails** across `language/statements/for-await-of/`. Realistic
target after #1450/#1451 land: **250+ flips**.

## Root cause

Per ECMA-262 §14.7.5.13 (`ForIn/OfBodyEvaluation` with
`iteratorKind=async`), each `IteratorStep` call must:

1. Call `iterator.next()` returning a thenable.
2. `Await` the thenable → IteratorResult.
3. If `IteratorResult.done` is true, finalize.
4. Else extract `value`, run `BindingInitialization` on the
   pattern with `value`.

Our compiler in `src/codegen/statements.ts` re-uses the synchronous
for-of destructuring path even when `isAwait=true` is set on the
`ForOfStatement`. The await is inserted only around the *next() call
result*, not around the *binding-pattern step's individual element
reads* — so when the iterator yields an array-like that itself needs
destructuring, the inner iterator step is not awaited.

Concretely: `compileForOfStatement` (around line 1500–1700 in
`src/codegen/statements.ts`) emits `__iter_next_async(record) →
externref Promise`, awaits it once, then passes the resolved value
into a synchronous `compileBindingPattern` helper. Rest patterns
inside the binding then re-call `__iter_step` synchronously on a value
that is *itself* an async iterable — producing the illegal-cast crash.

The parser-side `'\,' expected.` failure
(`async-func-decl-dstr-array-elem-init-in.js`) is a separate fix:
inside the head of `for await`, the `in` keyword in an initializer
must be disambiguated by parenthesis depth, not by the surrounding
statement kind.

## Files to touch

- `src/codegen/statements.ts` — `compileForOfStatement` /
  `compileForAwaitOfStatement`: route binding-pattern step calls
  through an async-aware emitter that inserts an `await` on each
  `IteratorStep`.
- `src/codegen/destructuring.ts` — add an `isAwait` parameter to
  the array-pattern emitter; when set, emit `await` between
  `__iter_next` and `IteratorComplete`.
- `src/compiler/parser.ts` — disambiguate `in` inside for-await-of
  array-element initializers.

## Acceptance criteria

1. ≥ 250 tests in `language/statements/for-await-of/` flip from
   `fail` to `pass`.
2. No new regressions in synchronous `for-of` (count must not drop in
   `language/statements/for-of/`).
3. The illegal_cast bucket in `error_categories` drops by ≥ 30.

## Reference tests

- `language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-rest-ary-elision.js`
- `language/statements/for-await-of/async-gen-decl-dstr-array-elem-init-assignment.js`
- `language/statements/for-await-of/async-gen-dstr-let-async-ary-ptrn-elem-ary-rest-iter.js`
- `language/statements/for-await-of/async-func-decl-dstr-array-elem-init-in.js` (parser-side)
