---
id: 2037
title: "standalone: NamedEvaluation `.name` wrong for functions/classes bound via destructuring defaults (683 tests)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-13
completed: 2026-06-13
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: destructuring, function-name
goal: standalone-mode
related: [1049, 1119, 1888]
test262_bucket: standalone-fn-name
test262_count: 683
es_edition: es2015
origin: "2026-06-10 standalone-vs-host baseline diff: 683 host-pass tests fail the `<binding>.name` assertion in standalone (fn-name-{fn,arrow,gen,cover,class} dstr families)."
---

# #2037 — standalone: `.name` of destructuring-default-bound functions

## Problem

683 gap tests (pass in JS-host mode, `fail` in standalone) assert
NamedEvaluation results for anonymous functions/arrows/generators/classes used
as destructuring default values
([§8.4.5 RS: NamedEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-namedevaluation),
[KeyedBindingInitialization §8.6.3](https://tc39.es/ecma262/#sec-runtime-semantics-keyedbindinginitialization)):

```js
var { fn = function () {}, arrow = () => {}, gen = function* () {},
      cover = (function () {}), xCover = (0, function () {}) } = {};
assert.sameValue(fn.name, 'fn');       // FAILS standalone (returned 2)
assert.sameValue(cover.name, 'cover'); // FAILS standalone
```

The bucket is the `dstr/*-id-init-fn-name-{fn,arrow,gen,cover,class}` family
across `for`, `try`, `let`/`const`/`var`, class methods, generator methods,
async-generator methods (~170 each for `fn`/`arrow`/`cover`/`gen`).

Confirmed on main @ 936d1ac51:
`test/language/statements/for/dstr/var-obj-ptrn-id-init-fn-name-cover.js`
compiled standalone returns `2` (first assert fails: `cover.name`).

**Notable:** the truly minimal form
`const { fn = function () {} } = {}; fn.name === 'fn'` **passes** standalone.
The failure needs the real test262 pattern (multiple bindings in one pattern /
`for(var {...} = {};;)` head / cover-parenthesized initializers), so it is a
contextual codegen path, not a wholesale missing feature. #1049 fixed
NamedEvaluation for the host path; the standalone `.name` read or the name
assignment on one of these binding-initialization paths diverges.

## Root cause in compiler (to confirm)

Two candidate layers — bisect with the repro:

1. The name is never attached: the standalone closure struct's `name` field
   (or the registry used by the `.name` property read arm) is only populated
   on some destructuring-binding paths.
2. The name is attached but the standalone `.name` property-read arm (#1888
   built-in property dispatch) returns `""`/wrong value for closures created
   in these positions.

Since the single-binding minimal passes, suspect the multi-binding /
for-statement-head binding-initialization codegen path skipping the
`SetFunctionName` step that the simple path performs.

## Suggested fix

Find where the simple path attaches the inferred name during standalone
lowering of `BindingElement` defaults, and route all binding-initialization
shapes (object/array patterns in `for`/`try`/method params/var-let-const,
cover-parenthesized initializers) through the same SetFunctionName logic.

## Acceptance criteria

- `var-obj-ptrn-id-init-fn-name-{fn,arrow,gen,cover}.js` pass standalone.
- The 683-row `fn-name` assertion bucket in the standalone baseline drops to
  ~0; host mode unchanged.
- Equivalence test covering ≥3 binding contexts (for-head var pattern, try-catch
  param, generator-method param) × {function, arrow, generator, cover} names.

## Resolution (2026-06-13) — already fixed on main, locked with a guard

Smoke-tested on current main (≈100 commits past the `936d1ac51` verification
point): the bug **no longer reproduces** for the path the real (untyped)
test262 `.js` files take. A faithful standalone repro — `target: "wasi"` (pure
WasmGC, no JS host), real string runtime, instantiated with a correct
`__extern_is_undefined` so the default initializer genuinely fires — returns
the correct `.name` for every pattern family:

- for-head `cover.name === "cover"` ✓
- for-head cover-comma `xCover` correctly anonymous (`""`) ✓
- `var { fn, arrow, gen } = {}` all named ✓
- `let { fn, arrow } = {}` named ✓
- `let { C = class {} } = {}` → `C.name === "C"` ✓

The likely fixing commit is **#1970 (`4c14a0256`, "reset destructure conversion
buffer per execution")** — the same per-iteration destructuring-state class of
bug as #2037's for-head binding-initialization path.

Landed `tests/issue-2037.test.ts` (5 standalone guards across for-head /
var-multi / let-multi / let-class shapes) to lock the behaviour. The guards
deliberately use **untyped** sources (no `as any`), exactly mirroring the
test262 `.js` shape, since `{}` infers as a typed empty-object struct and takes
the (now-correct) typed destructuring path.

### Separate bug found (NOT #2037 — filing separately)
While probing, the **`{} as any` / externref** destructuring-default path was
found to **TRAP** (`WebAssembly.Exception`) in standalone for the same
`{ cover = (function(){}) } = {} as any` shape — distinct from the `.name`
issue #2037 tracks (wrong name vs. a trap). The real `.js` test262 files do not
hit this (their `{}` is typed), so it does not block #2037, but it is a genuine
standalone defect on the externref destructuring-default path worth its own
issue.
