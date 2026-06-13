---
id: 1451
title: "spec gap: class/object-literal method parameter destructuring with non-trivial defaults"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, methods, destructuring, parameters
goal: spec-completeness
sprint: 52
related: [1432, 1372, 1158, 1364]
---
# #1451 — Class / object-literal method param destructuring with defaults

## Problem

Method parameter destructuring in **class bodies** and **object literal
method definitions** (regular methods, generator methods, async methods,
async-generator methods, private methods, static methods) does not implement
the §13.3.3 `IteratorBindingInitialization` flow correctly when:

- the parameter has a default initializer (e.g.
  `method([, , ...x] = [1, 2])`),
- the default is a non-trivial expression that yields an array/object
  (not just a literal `null`/`undefined`), and / or
- the binding pattern contains rest elements, elisions, nested
  patterns, or computed property keys.

Symptoms in test262:

- `Cannot destructure 'null' or 'undefined' [in C_method()]` — the
  parameter's default value didn't fire, so `null` is destructured.
- `dereferencing a null pointer` inside the method — a nested binding
  element observed `undefined` and skipped the default branch.
- `illegal cast` — the call-site/argument coercion sends an unexpected
  shape to the externref destructure helper.
- `invalid Wasm binary` (wasm_compile) — the generated wasm fails
  validation when the param has `obj-ptrn-list-err` shape (probably an
  uninitialised local on one branch of an `if`).

#1432 fixed analogous behaviour for **function declarations** by
narrowing `isPatternEmptyOnly` and routing non-trivial patterns
through the externref iterator path. Class methods and object-literal
methods have a parallel codepath in `class-bodies.ts` that did not
receive the same fix, plus an additional twist: class methods always
go through a method trampoline (`__obj_meth_tramp_*`) that may pass
`ref.null.extern` for omitted args rather than `__get_undefined()`.

## Failure count

- `language/expressions/class/dstr/`: **~660** fails
- `language/statements/class/dstr/`: **~458** fails
- `language/expressions/object/dstr/`: **~198** fails

Combined: **≈ 1316 failing test262 cases**, by far the largest cluster
in §15 (Functions and Classes).

Top sub-buckets:
- `gen-meth*` (generator methods): ~770
- `meth*` (regular methods): ~370
- `async-gen-meth*` and `async-meth*` partially covered by #1373
  (async lowering); still hit the same destructure shape errors.

## Root cause

The class-body method emitter at `src/codegen/class-bodies.ts:1080-1242`
duplicates and lightly diverges from the function-declaration path:

1. Param-default check (lines 1152-1231) emits an
   `__extern_is_undefined` branch then `local.set` of the compiled
   initializer. But it **does not always coerce** the initializer's
   inner array/object struct to externref before storing into the
   externref slot — when the initializer is `[1, 2]` (array literal),
   the produced value may be a struct ref, and later
   `destructureParamArray` re-reads it as externref expecting it to be
   iterable.
2. The destructuring loop at lines 1233-1242 only handles top-level
   `BindingPattern`s — but a deeper nested pattern (e.g.
   `method([[x = 1] = []] = [])`) requires nested default checks at
   each level. `destructureParamArray`/`destructureParamObject` do
   handle most of this, but tests with `*list-err*` shapes consistently
   trip wasm-validation, suggesting a missing branch on the externref
   path.
3. The trampoline used for `new C().method()` likely passes
   `ref.null.extern` for missing args; combined with the default check
   using `__extern_is_undefined` (which returns 0 for `null`), the
   default never fires. Function declarations padded missing args with
   `__get_undefined()`, so this only manifests in the method path. (See
   the comment at `class-bodies.ts:880` that already notes this issue
   for *constructor* params.)
4. Object-literal methods (`{ method([x] = []) {} }`) share the
   method-emitter codepath via `compileObjectExpression` →
   `emitMethodAsClosure`; the destructuring helper invocation is in
   `src/codegen/closures.ts:839-935` and may have the same gap.

## Implementation strategy

1. **Audit the missing-arg padding** for class methods and
   object-literal method calls. Where the trampoline (or direct call)
   passes `ref.null.extern`, switch to `__get_undefined()` — matching
   the function-decl convention and making `__extern_is_undefined`
   correct.
2. **Reuse the function-decl flow.** Extract the function-decl
   destructure-init helper into a shared function (probably in
   `destructuring-params.ts`) that handles (a) default firing, (b)
   nested pattern descent, (c) coercion to externref, and (d) per-spec
   iterator behaviour. Call it from class-body method emission and
   object-literal method emission.
3. **Coerce array-literal defaults to externref** before
   storing into the param local. The current path drops the type info
   when the param type was widened to externref by `bindingPatternNeedsWiden`.
4. Validate every fix with a minimal repro per pattern (`meth-dflt-`,
   `meth-ary-ptrn-rest-`, `meth-obj-ptrn-list-err`).

## Acceptance criteria

1. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-id-exhausted.js`
   passes (`method([, , ...x] = [1, 2])` → `x.length === 0`).
2. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js`
   passes (nested default + elision).
3. `test/language/expressions/object/dstr/meth-dflt-obj-ptrn-id-init-skipped.js`
   passes.
4. `test/language/expressions/class/dstr/gen-meth-static-obj-ptrn-list-err.js`
   compiles and passes (no wasm-compile error).
5. Combined test262 fail count for
   `expressions/class/dstr/`, `statements/class/dstr/`,
   `expressions/object/dstr/` reduces by **≥ 700**.

## Files to inspect

- `src/codegen/class-bodies.ts` — method emitter, lines 1080-1242 (and
  855-922 for the constructor parallel).
- `src/codegen/closures.ts` — object-literal method trampoline path
  (~line 839-935, 3019, 3085).
- `src/codegen/destructuring-params.ts` — `destructureParamArray`,
  `destructureParamObject`, externref helpers.
- `src/runtime.ts` — `__get_undefined`, `__extern_is_undefined` and
  the method-tramp glue.
- `tests/issue-1451.test.ts` — regression cases for method dstr
  variants.

## Out of scope

- Async-generator method body lowering — tracked by #1373.
- Function `length` property when params have defaults — tracked by
  #1364 / verifyProperty cluster.
