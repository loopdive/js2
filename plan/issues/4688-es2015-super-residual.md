---
id: 4688
title: "ES2015 standalone object-literal super property value reads"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
es_edition: es2015
language_feature: super
goal: standalone
related: [2671, 3594, 4444]
files:
  - src/codegen/expressions/new-super.ts
  - src/codegen/dynamic-proto.ts
  - src/codegen/closures.ts
  - src/codegen/literals.ts
  - src/codegen/object-literal-method-receiver.ts
  - src/codegen/expressions/call-receiver-method.ts
  - tests/issue-4688.test.ts
loc-budget-allow:
  # The helper is the only new lowering body; its 70 lines are the measured
  # object-literal read implementation and remain in the super subsystem.
  - src/codegen/expressions/new-super.ts
  # Existing god-files receive only the wiring needed to carry [[HomeObject]]
  # and select the receiver-aware call path.
  - src/codegen/closures.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/literals.ts
  - src/codegen/dynamic-proto.ts
  - src/codegen/object-literal-method-receiver.ts
func-budget-allow:
  # Exact measured growth on the current upstream/main merge-base.
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
trap-growth-allow:
  count: 1
  reason: "#4688 promotes dynamic-prototype object literals and exposes their super-read path. test/language/computed-property-names/object/method/super.js was already baseline fail and is explicitly outside this issue's static-key scope; its computed method names now reach the pre-existing missing computed-home-object path and null-deref instead of failing an assertion. This is a bounded fail-to-trap flavour change, not a baseline-pass regression."
  tests:
    - test/language/computed-property-names/object/method/super.js
---

# #4688 — ES2015 standalone object-literal `super` value reads

## Scope and exact rows

The authoritative snapshot
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
contains 532 rows whose path contains `super`; 159 are non-pass (136 `fail`, 5
`compile_error`, and 18 proposal `skip`). This issue deliberately owns only the
two same-root-cause plain object-literal value-read rows below:

```
test/language/expressions/super/prop-dot-obj-val.js
test/language/expressions/super/prop-expr-obj-val.js
```

Both rows construct `A` and `B`, set `B`'s prototype to `A`, install a method on
an object literal, then set the method object's prototype to `B`. The method
reads `super.fromA` / `super["fromA"]` and expects the inherited value `'a'`
(`fromB` similarly expects `'b'`). The snapshot records both as standalone
`fail` with `assertion_fail` and `Actual null` versus the expected string.

The other `super` failures are intentionally non-goals here: class prototype
metadata/property dispatch, object-literal accessors and writes, `super(...)`
constructor argument/spread handling, eval/home-object behavior, arrows,
generators, private elements, builtin parents, and host-import/unsupported
proposal rows each require separate substrate or ordering work.

## Baseline reproduction

On upstream/main `e7ee76a3b46f2dd626a4af09a7bb0d341317f29b` (fetched
2026-08-25), the real in-process runner was invoked as
`runTest262File(path, "issue-4688-baseline", 120000, "standalone")`:

| Row | Baseline |
| --- | --- |
| `prop-dot-obj-val.js` | fail — `Expected SameValue(«null», «"a"»)` |
| `prop-expr-obj-val.js` | fail — `Expected SameValue(«null», «"a"»)` |

The adjacent `test/language/expressions/super/call-poisoned-underscore-proto.js`
control passed on the same baseline, confirming this is not a blanket
`super`/module-instantiation failure.

## Root-cause hypothesis

`compileSuperPropertyAccess` and `compileSuperElementAccess` only know how to
resolve a statically named class getter/field. When `resolveEnclosingClassName`
returns no class (the object-literal method case), they emit a type-shaped
default (`ref.null.extern` for these string-valued reads) instead of applying
ECMAScript §13.3.7.1/§13.3.7.3 `MakeSuperPropertyReference` to the method's
runtime home object's prototype. The runtime representation has a second
particular gap in these rows: the receiver is a `var` binding, while
`scanForDynamicProto` only promotes `const` object-literal bindings, so the
method's home object remains a closed struct and `Object.setPrototypeOf` cannot
store its prototype. The coherent missing substrate is therefore (a) promote
identifier-bound object-literal receivers used by `Object.setPrototypeOf` to
the standalone `$Object` representation, (b) capture that actual object local
as the lifted method's `[[HomeObject]]`, and (c) use the captured home only for
`__getPrototypeOf`, followed by receiver-aware
`__reflect_get_receiver(base, key, actualThis)` for
`Get(base, key, actualThis)`. A borrowed method therefore retains its home
prototype while an inherited getter still observes the borrowed call-time
receiver.

This is a hypothesis to validate with emitted instructions and focused
post-change measurements; it does not claim the whole 159-row set shares this
mechanism.

## Implementation plan

1. In `src/codegen/dynamic-proto.ts`, extend the standalone receiver prescan
   to mark an identifier's object-literal initializer regardless of `var` vs
   `const`, keeping the existing lockstep `$Object` promotion and local typing.
2. In `src/codegen/closures.ts` and `src/codegen/literals.ts`, carry the actual
   object-literal allocation as a synthetic `[[HomeObject]]` capture, but only
   for a method body that owns `super`; ordinary methods remain byte-stable
   unless the literal is promoted to the open dynamic-prototype representation
   and that method reads its own `this`.
3. In `src/codegen/expressions/new-super.ts`, add a narrow object-literal
   property-read helper for statically known string keys. Use the captured home
   local for native `__getPrototypeOf`, materialize the key with the existing
   native string-value path, and pass the established `__current_this` global
   to `__reflect_get_receiver(base, key, actualThis)`. Preserve the
   checker-derived Wasm result type and return it through existing dispatch.
4. Use the same helper for dot and statically resolved element access, leaving
   dynamic keys and every class/builtin path unchanged. Route shorthand
   object-literal methods owning `super`, plus own-`this` shorthand methods in
   the same promoted dynamic-prototype literal, through the receiver-install
   path. This keeps mixed literals' ordinary method semantics intact while
   leaving closed-literal shorthand methods on the static direct path.
5. Extend the dynamic-proto receiver prescan from `const` to general `var`/`let`
   initializers for this same object-literal receiver shape. Keep the
   receiver-aware call routing in the existing object-literal receiver module;
   no direct-method ABI module changes are needed. The existing closure ABI
   plumbing is required because the static `__anon_*_method` stub carries no
   call-time receiver; routing these marked methods through
   `compileCallablePropertyCall` is the smallest path that installs and restores
   `__current_this` without changing the direct-method ABI.
6. Add exact `runTest262File(..., "standalone")` pins for the two rows, a
   passing `super` control, and a focused borrowed-method/inherited-getter
   control; record baseline and after results and a zero-loss check in this
   issue.

## Risks and non-goals

- This helper must not be used for class methods: class `super` resolves the
  statically known parent prototype, while object-literal `super` resolves the
  runtime home-object prototype.
- Borrowed object methods are a required zero-loss/spec control: their base is
  `GetPrototypeOf([[HomeObject]])`, while an inherited getter receives the
  borrowed call-time `this`. The helper must not substitute `this` for the
  captured home object. The receiver-install gate is limited to shorthand
  methods whose own body contains `super`, or own-`this` methods in the promoted
  dynamic-prototype literal that needs the same call-time receiver path.
- Promoting additional identifier-bound object literals changes their
  standalone representation only when a dynamic-prototype write is present;
  ordinary object literals and host/WASI lanes remain untouched.
- Accessor invocation, `super` writes/compound updates, dynamic keys, eval,
  arrows, async/generator lowering, and `super(...)` are explicitly deferred.
- `Reflect.apply(borrowedMethod, receiver, [])` remains a known standalone
  refusal/trap in the existing Reflect.apply lane (the same
  `[object WebAssembly.Exception]` occurred on clean upstream and this branch;
  see #2046). The focused semantic control therefore uses the already-supported
  `borrowedMethod.call(receiver)` path; this issue does not widen Reflect.apply.
- The native helper must remain host-free in standalone and must not add
  `env::__extern_get`/`env::__reflect_get` imports.

## Acceptance criteria

- Both exact rows pass through `runTest262File(..., "standalone")`.
- The passing control remains passing, and no focused baseline-pass control
  regresses.
- The emitted module for the touched shape has no host object-property import;
  the native `__getPrototypeOf`/`__reflect_get_receiver` helpers are used.
- TypeScript, formatting, coercion, function/LOC budget, and normal pre-push
  gates pass on the committed branch.

## Test Results

The authoritative `super` snapshot is 373 pass / 136 fail / 5 compile-error /
18 skip across 532 rows before this slice. The two exact rows below are the
only claimed flips in this issue, so the slice projection is 375 pass / 134
fail / 5 compile-error / 18 skip; no broader `super` sweep is claimed.

| Check | Result |
| --- | --- |
| `prop-dot-obj-val.js` via `runTest262File(..., "standalone")` | pass (was fail) |
| `prop-expr-obj-val.js` via `runTest262File(..., "standalone")` | pass (was fail) |
| `call-poisoned-underscore-proto.js` baseline-pass control | pass |
| Borrowed method + inherited getter (`borrowedHome`, `directHome`) | `1`, `1` (clean baseline: `0`, `0`; intended semantic flip) |
| Mixed literal ordinary shorthand (`directOrdinary`) | `1` (clean baseline: `1`; zero-loss control) |
| Borrowed focused module host property imports | none (`env::__extern_get` / `env::__reflect_get` absent) |
| `Reflect.apply` borrowed probe (out-of-scope control) | same WebAssembly trap on clean upstream and branch |
| `tests/issue-4688.test.ts` | 4 passed (including mixed ordinary-method control) |

The borrowed control is the semantic guard: the captured home object supplies
the prototype used by `super`, while the call-time receiver is supplied to the
inherited getter. The focused module also confirms the standalone lowering is
native-runtime-only for this shape.

## Intended files

- `src/codegen/expressions/new-super.ts`
- `src/codegen/dynamic-proto.ts`
- `src/codegen/closures.ts`
- `src/codegen/literals.ts`
- `src/codegen/object-literal-method-receiver.ts`
- `src/codegen/expressions/call-receiver-method.ts`
- `tests/issue-4688.test.ts`
- this issue file
