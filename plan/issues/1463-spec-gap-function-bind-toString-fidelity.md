---
id: 1463
title: "spec gap: Function.prototype.bind / toString / Symbol.hasInstance fidelity"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: function-prototype
goal: spec-completeness
sprint: 52
related: [1382]
---
# #1463 - spec gap: Function.prototype.bind / toString / Symbol.hasInstance fidelity

## Problem

The `Function.prototype` family contributes **309 test262 failures**:

```
100 bind     80 toString    49 call     48 apply
11 Symbol.hasInstance    21 misc (S15.3.x_*)
```

### 1. bind (100 failures)

`src/codegen/expressions/calls.ts:1233` notes the current compiler treats
`fn.bind(thisArg, …)` as an **identity bind** — bind arguments are
evaluated for side effects then dropped, and the receiver is returned
verbatim. This makes the common idiom `fn.bind(thisArg)(args)` work but
breaks:

| Pattern | Test | Symptom |
| --- | --- | --- |
| `Array.bind(null)(42)` | `15.3.4.5-2-8.js` | bound function is not constructable; returns wrong `length`/array |
| `bf = foo.bind(o); Object.isExtensible(bf)` | `15.3.4.5-16-1.js` | bound function `[[Extensible]]` defaults missing |
| `bf.name === "bound foo"` | `name.js` | name is original, not prefixed |
| `bf.length` after partial application | various | length not adjusted for pre-bound args |
| `new (Array.bind(null, 3))` | various | construct-bound semantics missing |
| `bf.hasOwnProperty("prototype") === false` | `15.3.4.5-6-7.js` | bound functions must lack own `prototype` |
| `null` dereference inside `bf` body | `15.3.4.5-2-8.js` | `this` rebinding lost |

### 2. toString (80 failures)

Most tests pin specific output from `Function.prototype.toString` —
notably:

- `async-method-class-expression-static.js` triggers a Wasm compile error
  (`invalid Wasm binary … call[0] expected type externref`).
- `generator-function-expression.js` and `arrow-function*.js` assert that
  `toString` reproduces the original source.
- `S15.3.4.2_A14.js` asserts callable invariants (`Function.prototype.toString.call(non-function)` → TypeError).

The compiler stores no source text per function, so
`Function.prototype.toString` returns a synthesised placeholder
(`function () { [native code] }`) which fails every source-equality test.

### 3. call / apply (49 + 48 = 97 failures)

Spec violations:

- `Function.prototype.apply` with a `null`/`undefined` second arg should
  call with no args; non-null array-like (custom `length`) must use
  generic indexed read. Currently the externref bridge expects a real
  array. (`S15.3.4.3_A5_T5.js`, `S15.3.4.3_A8_T5.js`.)
- `Function.prototype.call.call(fn, thisArg, …)` (call chaining) drops
  receiver. (`S15.3.4.4_A5_T8.js` — `Cannot read properties of null`.)
- `name.js` / `length.js` on `call` and `apply` assert built-in fn
  property descriptors (downstream of #1462).

### 4. Symbol.hasInstance (11)

`function F() {}; F[Symbol.hasInstance] = …; obj instanceof F` — the
custom `[Symbol.hasInstance]` is ignored; `instanceof` always falls
back to the default prototype-chain walk.

## Failure count

309 across `Function/prototype/`. Tractable: **~220** (toString-source
fidelity beyond the trivial cases is intentionally deferred — see notes).

## Root cause

`src/codegen/expressions/calls.ts:1233–1310` (`bind` identity dispatch),
lines 7070–7250 (immediate bind+call optimisation),
`src/runtime.ts` for `__functionCall` / `__functionApply` bridges, and
the absence of a `__bind` host that produces a real bound function
exotic object (§10.4.1).

Concretely:

1. **No `BoundFunctionExoticObject` is materialised.** The compiler
   substitutes the original closure, so `[[BoundTargetFunction]]`,
   `[[BoundThis]]`, `[[BoundArguments]]` aren't observable. Spec
   requires a distinct callable that, when invoked, prepends the bound
   args and replaces `this`.

2. **`new BoundFn(args)` construct path missing.** Spec §10.4.1.2:
   `[[Construct]]` forwards to target's `[[Construct]]` with combined
   args and **`newTarget`** = the bound function. Currently `new`
   on a bind result produces an empty object (or errors).

3. **Length / name adjustment missing.** Bound function's `length` =
   `max(0, target.length − boundArgs.length)`; `name` =
   `"bound " + target.name`.

4. **Function source isn't captured.** `Function.prototype.toString`
   has nothing to return. The fix is either (a) preserve source text
   in the function table during parse, or (b) emit a synthetic
   re-stringification that round-trips to a parse-equivalent form
   (sufficient for many tests).

5. **`apply(thisArg, arrayLike)`** path goes through a fixed `argv:
   externref[]` import that does not generic-index when the second
   arg is a plain object with `length`. Spec §22.2.3.3 step 6 says
   `CreateListFromArrayLike(argArray)`.

6. **`Symbol.hasInstance` lookup is not consulted by
   `instanceof`.** See `src/codegen/binary-ops.ts` instanceof path —
   no `Get(C, @@hasInstance)` precheck.

## Acceptance criteria

1. `fn.bind(thisArg, …pre)` produces an externref host-wrapped
   bound function with:
   - `[[Call]]`: invokes `fn` with `thisArg` and `[…pre, …call]`;
   - `[[Construct]]`: invokes `new fn(…pre, …call)` with bound
     args prepended and `newTarget` set;
   - `length` = `max(0, fn.length - pre.length)`;
   - `name` = `"bound " + (fn.name || "")`;
   - no own `prototype` property;
   - extensible by default.
2. `Function.prototype.apply(thisArg, argArray)` accepts any
   array-like via `CreateListFromArrayLike`; throws TypeError if
   `argArray` is non-null, non-undefined, non-object.
3. `Function.prototype.call.call(…)` / `apply.call(…)` chains work
   (receiver passed through, not lost).
4. `obj instanceof C` calls `Get(C, @@hasInstance)` first; if
   callable, uses its result instead of the prototype-chain walk.
5. `Function.prototype.toString` returns a source string that
   matches the original token stream for declarations, expressions,
   arrows, methods, generators, and async forms — enough to pass
   the literal-equality tests that currently fail with placeholder
   output.
6. No Wasm compile crash on `async-method-class-expression-static.js`.
7. ≥180 of the 309 failures resolved.
8. Tests: `tests/issue-1463.test.ts` covers bind call/construct, name/
   length, apply array-like, and Symbol.hasInstance.

## Files to inspect

- `src/codegen/expressions/calls.ts` (bind identity at 1233, bind+call
  at 7070, instanceof handling)
- `src/codegen/binary-ops.ts` (instanceof — Symbol.hasInstance)
- `src/codegen/expressions/new-super.ts` (`new BoundFn(…)`)
- `src/runtime.ts` — add `__bind`, `__functionApply` array-like fix
- `src/codegen/declarations.ts` — capture source text per function
- `tests/issue-1463.test.ts`

## Notes

- Most `Function/prototype/toString/` tests that pin exact whitespace
  are out of scope; the goal is to pass the **structural** tests
  (e.g. that `toString` of a generator includes `function*`).
- #1382 covered the inverse problem (Wasm closure → JS-callable);
  bound functions need a similar but more elaborate bridge.
