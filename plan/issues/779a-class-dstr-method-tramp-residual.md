---
id: 779a
title: "class/dstr method-tramp residual (gen / async-gen / private / static) (~727 fails)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class-destructuring-methods
goal: property-model
sprint: 56
parent: 779
es_edition: ES2017
test262_fail: 727
---
# #779a — class/dstr method-tramp residual

## Problem

~727 test262 `assertion_fail` failures under
`language/{statements,expressions}/class/dstr/*` whose filename prefix is one of:

- `gen-meth-*` (~120) — generator instance methods with destructuring params
- `gen-meth-static-*` (~81) — generator static methods with destructuring params
- `gen-meth-dflt-*` (~39) — generator instance methods with default-init dstr
- `async-gen-meth-*` (~125) — async-gen methods with destructuring params
  (the `dflt-*-init-unresolvable` subset is already routed to #820d)
- `private-meth-*` and `private-gen-meth-*` (~86 + 86) — private (gen) methods
- `async-private-gen-meth-*` (~86) — private async-gen methods
- `meth-static-*`, `meth-dflt-*`, `meth-ary-*`, `meth-obj-*` (~109) —
  plain class-method dstr residuals after #1543/#1544 landed

All produce `returned 2 — assert #1` (first assertion fails) without
crashing. The class method runs, but the destructuring of parameters does
not bind the expected values.

This is the residual umbrella covering class-method dstr cases that are
neither the parsing bug routed to #779b nor the `unresolvable` illegal-cast
routed to #820d, nor the null-deref subset routed to #820c/#820e.

## Sample failing tests
- `test/language/expressions/class/dstr/gen-meth-dflt-ary-ptrn-empty.js`
- `test/language/statements/class/dstr/private-gen-meth-static-ary-ptrn-elem-ary-rest-init.js`
- `test/language/expressions/class/dstr/meth-static-dflt-ary-ptrn-rest-id.js`
- `test/language/statements/class/dstr/async-private-gen-meth-dflt-ary-ptrn-rest-id-elision.js`

## Suspected source

Class-method body emission shares a destructuring path through the
object-method trampoline builder. The candidates are:

- `src/codegen/closures.ts` — `__obj_meth_tramp_*` builder (around L3019/L3085
  per #820c/#820d notes) — does not propagate the binding-pattern
  parameter resolution for generator/async-gen wrapped shells.
- `src/codegen/destructuring-params.ts` — binding-element default-init
  closure typing; routing in decl-mode (referenced by #1553d).
- `src/codegen/literals.ts` — binding-element pattern emission inside
  class-method method-definition.

Likely root cause: the binding-element lowering used for class-method
formal parameters takes a different path than the function-decl path that
#1543/#1544 fixed. The class-method path needs the same destructuring
helper applied through the (async-)generator shell.

## Spec reference

- ECMAScript §15.7 ClassDefinitions (ClassElementEvaluation,
  DefineMethod, DefineMethodProperty)
- §14.1.18 IteratorBindingInitialization (binding-element default)
- §27.6 AsyncGenerator Abstract Operations (wrapper shell)

## Acceptance criteria

- [ ] At least 600 of the ~727 listed tests flip to `pass`.
- [ ] No regression in already-passing `class/dstr` tests.
- [ ] Implementation routes class-method binding-pattern params through the
      same path as `destructureParamArray` / `destructureParamObject`.
- [ ] Fix covers all four shell variants: plain method, generator method,
      async method, async-gen method, both instance and static, both public
      and private.

## Reproduction (verified on main, 2026-05-27)

All three class-method dstr-param shapes emit **invalid Wasm** (compile
succeeds, `WebAssembly.instantiate` rejects the binary):

- `static method([...x] = values)` → `immutable global #6 cannot be assigned`
- `method([a, b])` (instance) → `global.set[0] expected type externref, found local.get of type f64`
- `*gen([a, b])` (generator) → same `global.set` f64→externref type mismatch

So the residual is NOT (only) a binding-init logic gap — the class-method
destructuring-param path is emitting a `global.set` against a global that is
(a) immutable and (b) the wrong type (f64 local stored into an externref
global). The trampoline/binding-pattern lowering for class-method formals
diverges from the function-decl path. Start with the plain instance/static
`meth-*` shape (simplest, ~109 bucket); the gen/async-gen variants reproduce
the identical `global.set` type error, suggesting a shared root in the
class-method param-binding emission rather than per-shell divergence.

## Root cause + fix (2026-05-27, dev-1607)

The documented invalid-Wasm repro is a **global-index drift** bug, NOT a
trampoline divergence. For a class declared **inside a function**,
`compileNestedClassDeclaration` calls `promoteAccessorCapturesToGlobals` on the
enclosing function (emitting `global.set`/`global.get` for captured locals like
`ok`), then `compileClassBodies` overwrites `ctx.currentFunc` with each
constructor/method **without** registering the enclosing function on the
global-index shift-tracking stacks (`funcStack`/`parentBodiesStack`). When a
binding-pattern destructure adds the `"Cannot destructure 'null' or
'undefined'"` `string_constants` import, `fixupModuleGlobalIndices` shifts the
captured-global maps (and the method body) but **not** the enclosing function's
already-emitted global refs — so its captured-variable `global.set`/`get`
indices land on the wrong (and wrongly typed) globals, producing the
`global.set externref ← f64` / immutable-global errors.

**Fix** (`src/codegen/class-bodies.ts`): at the top of `compileClassBodies`,
push the enclosing `ctx.currentFunc` onto `funcStack` + `parentBodiesStack`
(and restore in `finally`), mirroring the object-literal method path in
`literals.ts`. All three documented repro shapes now compile to valid Wasm and
return 1. Unit tests in `tests/issue-779a.test.ts` (5 cases) pass.

## SCOPE FINDING — the ~727 test262 figure is a DIFFERENT bug

The fix above resolves the issue's *documented invalid-Wasm repro*, but it does
**not** move the ~727 test262 `assert_fail` failures. The real test262 corpus
uses **top-level** (module-scope) classes with **untyped** binding patterns —
e.g. `class C { static method([...x] = values) {...} }` — which do NOT hit the
nested-class global-drift path. Verified: the issue's 4 named sample files
(`meth-static-dflt-ary-ptrn-rest-id.js`, `gen-meth-dflt-ary-ptrn-empty.js`,
etc.) fail **identically** (`ret=2`, first assertion) on both pre-fix main and
post-fix branch. The first failing assertion is `assert(Array.isArray(x))` — the
rest binding produces a value the harness's `Array.isArray` rejects. (In
isolation `Array.isArray(x)` on a rest binding returns true, but
`Array.isArray` on a plain array param returns false — pointing at an
`Array.isArray` / iterator-protocol interaction, family of #820 / #1130 /
#1633, NOT class-method param lowering.) **Recommend: re-scope the residual
~727 to an Array.isArray / harness-array-identity investigation; the invalid-Wasm
sub-bug is fixed by this PR.**

### Sharper root cause of the residual (isolated 2026-05-27)

Minimised the real failure to the **`any`-typed default value** of an
array/rest binding param. The default value's static type — not the binding
shape — decides it:

```
// FAILS (ret=2): default value typed `any` (externref)
let values: any; values = [1,2,3];
class C { static method([...x] = values) { /* Array.isArray(x) === false */ } }

// PASSES (ret=1): default value typed number[] (vec struct)
var values = [1,2,3];   // inferred number[]
class C { static method([...x] = values) { /* Array.isArray(x) === true */ } }
```

So when the rest/array binding's default value is externref-typed, the bound
result is an externref that `Array.isArray` rejects (it is not wrapped as a
native vec/array). The test262 harness declares `let values: any;` then assigns
`values = [1,2,3]`, so every `*-dflt-*` test takes the failing branch — which is
why the `meth-dflt-*` / `gen-meth-dflt-*` / `*-dflt-*` buckets dominate the
~727. The fix belongs in the array/rest binding-default lowering: when the
default value is externref, materialise/convert it to a native array (vec
struct) so `Array.isArray` and `.length`/index access behave. This is
independent of (and larger than) the nested-class global-drift fix in this PR.
**Split out to #1678** (externref-typed default-value array/rest
materialisation) — the dominant share of the residual ~727.

## Resolution (2026-05-27)

The invalid-Wasm sub-bug (nested-class global-index drift) is **fixed and merged
via PR #678**. The behavioural residual (~727 `*-dflt-*` `assert_fail`) is
re-scoped to **#1678** — externref-typed default values of array/rest binding
params are not materialised to native arrays, so `Array.isArray` rejects them.
This issue is closed as `done`; #1678 carries the remaining work.

## Notes

- This is a parent-of-parents for several already-filed narrower issues:
  #1543 (closed), #1544 (closed), #1553x (in flight), #820d. The remaining
  727 are the tests that none of those cover.
- Coordinate dispatch with #1553x to avoid duplicate diagnosis.
- High-volume; consider splitting further if dev finds the gen / async-gen /
  private paths diverge significantly during implementation.
