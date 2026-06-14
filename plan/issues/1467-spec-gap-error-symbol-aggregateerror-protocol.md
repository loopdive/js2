---
id: 1467
title: "spec gap: Error / AggregateError / Symbol prototype protocol"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: error-symbol-protocol
goal: spec-completeness
sprint: 52
related: [844, 1460]
---
# #1467 - spec gap: Error / AggregateError / Symbol prototype protocol

## Problem

Three related smaller clusters share root causes:

```
35 Symbol/prototype/      (Symbol.prototype.description, .toString, .valueOf, wrappers)
30 Error/prototype/       (toString, [[Class]], invalid-receiver behaviour)
25 AggregateError/        (constructor without new, message cast, errors iterable)
12 Error/isError/         (ES2025 — Error.isError(x))
```

Total: **102 test262 failures** with a clean specification surface.

### 1. Symbol.prototype.description (35)

`Symbol/prototype/description/get.js` and friends test:
- `Symbol('x').description === 'x'`;
- `Symbol().description === undefined`;
- `Symbol.prototype.description` is an accessor (descriptor surface);
- ToObject on receiver: `Symbol.prototype.description.call(wrapperObj)` must unwrap.

Our compiler's Symbol representation does not expose a `.description`
accessor on the prototype — `sym.description` either errors or returns
the wrong thing.

### 2. Error.prototype.toString receiver checks (30)

`Error/prototype/S15.11.4_A2.js` swaps in `Object.prototype.toString` —
`Error.prototype.toString = Object.prototype.toString;
Error.prototype.toString() === "[object Object]"`. Our implementation
hard-codes the format string. The fix: `Error.prototype.toString` must
read `this.name` / `this.message` via normal property access (so
replacing it with `Object.prototype.toString` flips behaviour) — i.e.
implement it as a normal JS function on the prototype instead of an
inline lowering.

Also `Error.prototype.toString.call(non-error-object)` must accept any
object (TypeError only on non-object receivers) — currently throws on
plain objects.

### 3. AggregateError (25)

- `AggregateError([], '')` (called without `new`) should construct
  normally per §20.5.7.1.1; we throw or produce a non-AggregateError.
- `new AggregateError(errors, message)` must `CreateMethodProperty` on
  `message` (writable, non-enumerable, configurable). Currently set
  as plain assignment → enumerable: true.
- `errors` argument must be coerced via `IterableToList(errors)` and
  stored as a non-enumerable own property `errors`. Currently:
  `L8:5 undefined is not iterable` when `errors` is undefined (spec:
  `undefined` arg → TypeError; we throw the wrong shape).
- `message` argument coerced via ToString: `new AggregateError([], 42)`
  → message === '42'. Currently passed through verbatim (number).
- `Object.getPrototypeOf(AggregateError())` must equal
  `AggregateError.prototype` (not `Error.prototype`).

### 4. Error.isError (12)

ES2025 static method `Error.isError(value)` returns true for any error
object including subclasses across realms. Currently **not implemented**
— all 12 tests fail.

## Failure count

102. Realistic target: **~85** (the descriptor-shape assertions on
`message`/`name`/`description` accessors depend on #1460/#1462; most
pass once the constructors are fixed and the helper is added).

## Root cause

In `src/codegen/expressions/new-super.ts:1469–1530`, `new
AggregateError(...)`:
- doesn't permit being called without `new` (no fallback path);
- passes `errors`/`message` to `__new_AggregateError` host import
  without ToString / IterableToList coercion;
- sets `message`/`errors` as plain externref properties (default
  attributes), not via CreateMethodProperty (writable, non-enumerable,
  configurable).

In `src/runtime.ts`:
- `__new_AggregateError` is a thin host wrapper around `new
  AggregateError(...)`. It works for plain calls but doesn't apply
  ToString to message before construction in older Node versions; needs
  pre-coercion on the Wasm side.

In `src/codegen/builtin-tags.ts:55` AggregateError gets tag `-17`. The
error-types registry (`registry/error-types.ts:63`) includes it. But
there is no `Error.isError` dispatch anywhere in `expressions/calls.ts`.

Symbol description handling: search for `.description` reveals no
support — symbols are externrefs, and the description is only
inspectable via the host's `Symbol.prototype.description` getter,
which our compiler doesn't invoke for `sym.description` access.

`Error.prototype.toString` is implemented inline in the codegen rather
than as a real prototype method that can be replaced.

## Acceptance criteria

1. `Symbol(x).description` reads the host's
   `Symbol.prototype.description` getter (via externref bridge) and
   returns the string or `undefined`.
2. `Symbol.prototype.description.call(symObj)` unwraps Symbol-wrapper
   objects (ToObject on receiver).
3. `Error.prototype.toString` implemented as a real prototype-resident
   method that reads `this.name` and `this.message` (so replacement
   via `Object.prototype.toString` flips behaviour).
4. `AggregateError(errors, message)` (without `new`) constructs.
5. `AggregateError` coerces `message` via ToString and `errors` via
   IterableToList; undefined `errors` → TypeError per spec §20.5.7.1.1.
6. `message` / `errors` installed as non-enumerable, writable,
   configurable own data properties (CreateMethodProperty).
7. `Error.isError(value)` static method returns `true` for any value
   whose `[[ErrorData]]` slot is set (host check via `instanceof
   Error` is the practical approximation in JS-host mode).
8. ≥75 of the 102 failures resolved.
9. Tests: `tests/issue-1467.test.ts` covers each acceptance bullet.

## Files to inspect

- `src/codegen/expressions/new-super.ts` 1469–1530 (AggregateError)
- `src/codegen/expressions/calls.ts` — add Error.isError dispatch
- `src/codegen/property-access.ts` — Symbol.description path
- `src/codegen/builtin-tags.ts`, `registry/error-types.ts`
- `src/runtime.ts` — `__new_AggregateError`, add `Error.isError`
- `tests/issue-1467.test.ts`

## Notes

- #844 introduced the AggregateError host bridge; this issue closes
  spec gaps.
- Descriptor-shape failures (`verifyProperty(...)`) depend on #1460
  and #1462. Count those as "indirect" wins.
