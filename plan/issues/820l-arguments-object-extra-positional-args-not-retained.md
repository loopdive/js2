---
id: 820l
title: "arguments object: extra positional args beyond declared formals not retained (~61 fails)"
status: ready
created: 2026-05-28
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
sprint: Backlog
parent: 820
test262_fail: 61
related: [849, 779e, 1053, 1511]
---
# #820l — arguments object: extra positional args beyond declared formals not retained

Carved from the #820 nullish/TypeError umbrella (triage 2026-05-28, dev-1655-2).

## Problem

When a function is called with **more positional arguments than declared
formals**, the `arguments` object inside the body sees only the declared-formal
slice. Both `arguments.length` and `arguments[i]` for `i >= formal-count` are
wrong — `arguments.length` reflects the declared formal-parameter count rather
than the actual argument count, and `arguments[i]` returns `undefined` for the
extra-positional slots.

ECMAScript §10.4.4.6 (CreateUnmappedArgumentsObject) / §10.4.4.7
(CreateMappedArgumentsObject) step 5: `len` is set to "the number of arguments
**actually passed**", not the parameter count. We construct the argv slice
from the formal-parameter count, dropping every actual positional beyond it.

This is **distinct from** the already-completed siblings:
- **#1053** (done) — `arguments.length` wrong with *trailing-comma* call sites
  (call-site argv plumbing for the trailing-comma case).
- **#849** (done) — mapped-vs-unmapped sync between `arguments[i]` and named
  params *inside* the formal range.
- **#779e** (done) — `arguments` mapped/trailing-comma/sloppy-strict residuals,
  + `eval("arguments = …")` SyntaxError.

None of those cover the **extra-positional-retention** case where the caller
passes more positionals than the callee declared. This is the §10.4.4
step-5/step-21 "length = ArgumentsList length, set each index" path.

## Sample failing tests (verified failing on current main 2026-05-28 via runTest262File)

All 61 known fails fall in three sub-shapes:

### 1. `Array.prototype.*` callbacks (~41 fails)

The spec for `Array.prototype.reduce / reduceRight / map / filter / forEach /
some / every / find / findIndex / indexOf / lastIndexOf` requires the
callback to be invoked with **3 or 4** positional args (prevVal/curVal/idx, plus
the array itself, and for `reduce*` the accumulator). Callbacks in these
tests are written to read `arguments[2]` or `arguments[3]` — they declare
fewer formals than the spec passes. We drop the extras, so `arguments[2]`
is `undefined`, and assertions like `arguments[2][arguments[1]] === arguments[0]`
fail with `TypeError: Cannot access property on null or undefined`.

```
test/built-ins/Array/prototype/filter/15.4.4.20-9-c-ii-13.js   ← arguments[2] undef
test/built-ins/Array/prototype/reduceRight/15.4.4.22-9-c-ii-12.js
test/built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-12.js
test/built-ins/Array/prototype/forEach/15.4.4.18-7-c-ii-11.js
test/built-ins/Array/prototype/map/15.4.4.19-8-c-ii-11.js
test/built-ins/Array/prototype/some/15.4.4.17-7-c-ii-11.js
test/built-ins/Array/prototype/every/15.4.4.16-7-c-ii-11.js
... (full list in baseline, 41 entries)
```

Repro shape:
```js
function callbackfn() {
  return arguments[2][arguments[1]] === arguments[0];   // 0/1/2 should all be set
}
[11].filter(callbackfn);   // spec passes (val, idx, array)
```
Current behavior: `arguments.length === 0`, `arguments[0..2]` all undefined.
Expected: `arguments.length === 3`, `arguments[0]==11, [1]==0, [2]===[11]`.

### 2. `params-dflt-ref-arguments` family — default-init reading extra positionals (~14 fails)

When a parameter default initializer references `arguments[N]` for an N
beyond the declared formal count, the default evaluates against the wrong
arguments slice.

```
test/language/statements/function/params-dflt-ref-arguments.js
test/language/expressions/function/params-dflt-ref-arguments.js
test/language/statements/class/params-dflt-meth-ref-arguments.js
test/language/statements/class/params-dflt-meth-static-ref-arguments.js
test/language/statements/class/params-dflt-gen-meth-ref-arguments.js
test/language/statements/class/params-dflt-gen-meth-static-ref-arguments.js
test/language/expressions/class/params-dflt-meth-ref-arguments.js
test/language/expressions/class/params-dflt-meth-static-ref-arguments.js
test/language/expressions/class/params-dflt-gen-meth-ref-arguments.js
test/language/expressions/class/params-dflt-gen-meth-static-ref-arguments.js
test/language/expressions/object/method-definition/params-dflt-meth-ref-arguments.js
test/language/expressions/object/method-definition/params-dflt-gen-meth-ref-arguments.js
test/language/statements/generators/params-dflt-ref-arguments.js
test/language/expressions/generators/params-dflt-ref-arguments.js
```

Repro shape:
```js
function f(x = arguments[2], y = arguments[3], z) {
  return [x, y, z];
}
f(undefined, undefined, 'third', 'fourth');
// expected: x='third', y='fourth', z='third'
// actual:   x=undefined, y=undefined, z='third'
```

Note that **§10.2.11 FunctionDeclarationInstantiation** (steps 22-26) requires
the `arguments` object to be created against the *full* argumentsList **before**
parameter binding initialisation runs, so default initialisers see the
complete positional list.

### 3. `Function.prototype.bind` user-function body reading `arguments` (~8 fails)

The user function's body, when invoked through a bound wrapper, observes the
post-`__bind_function`-trampoline `arguments` that drops args beyond the
bound function's `.length`. Strongly overlaps the #1632a `__bind_function`
work in flight (PR #796) — these may auto-resolve when #1632a lands.

```
test/built-ins/Function/prototype/bind/15.3.4.5-2-3.js
test/built-ins/Function/prototype/bind/15.3.4.5-2-4.js
test/built-ins/Function/prototype/bind/15.3.4.5-2-5.js
test/built-ins/Function/prototype/bind/15.3.4.5-2-6.js
test/built-ins/Function/prototype/bind/15.3.4.5-2-8.js
test/built-ins/Function/prototype/bind/15.3.4.5-2-9.js
test/built-ins/Function/prototype/bind/15.3.4.5-3-1.js
test/built-ins/Function/prototype/bind/S15.3.4.5_A4.js
```

Recommend coordinating with #1632a — if #1632a's bound-function representation
lands first, these may need a second pass to plumb the bound-call's full
argv into the bound function's `arguments` object.

## Root-cause hypothesis

The `arguments` object is built from a slice of the call-frame argv that is
sized to the formal-parameter count, not the actual ArgumentsList length. The
trailing-comma fix in #1053 introduced `__extras_argv` for the trailing-comma
case but did not generalise it to **all** call-sites where actual-arg-count
> formal-count.

Candidate files (verify before editing):

- `src/codegen/index.ts` — `FunctionContext.arguments` construction, the
  module-level `__extras_argv` plumbing from #1053
- `src/codegen/function-body.ts` — function prologue: arguments-object
  creation
- `src/codegen/expressions/calls.ts` — call-site argv length plumbing
  (the `len` value passed to the callee's arguments object construction)
- `src/runtime.ts` — `__make_arguments` / mapped-vs-unmapped helpers (search
  for the arguments-object factory used by emitted prologues)

## Acceptance criteria

1. `Array.prototype.{reduce,reduceRight,map,filter,forEach,some,every,
   find,findIndex,indexOf,lastIndexOf}` callbacks see all spec-passed
   positionals via `arguments[0..N-1]` and `arguments.length === N`.
2. `function f(x = arguments[2], …)` default-initialiser observes positionals
   beyond the formal count.
3. No regression on the existing `arguments.length` + trailing-comma + mapped
   tests (#1053 / #849 / #779e cluster — those still pass).
4. Pass-rate move: at least 40 of the 61 tests listed above flip to PASS.

## Test plan

- `tests/issue-820l.test.ts` covering the three shapes above.
- Run a scoped subset of the listed test262 files via `runTest262File`.

## Out of scope

- `Function.prototype.bind` sub-bucket may be deferred to the #1632a follow-up
  if that lands first; this issue covers the *direct-call* path.
- The mapped/unmapped attribute writeback (#849) and trailing-comma elision
  (#1053) — already done; this issue must NOT regress them.
