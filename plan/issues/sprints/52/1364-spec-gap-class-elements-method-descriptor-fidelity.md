---
id: 1364
sprint: 52
title: "spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails)"
status: done
worktree: /workspace/.claude/worktrees/issue-1364-class-element-descriptors
created: 2026-05-08
updated: 2026-05-20
completed: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: spec-completeness
parent: 1334
---
# #1364 — Class element descriptors (verifyProperty fails)

## Problem

`language/{expressions,statements}/class/elements/*` — **700 fails**, dominated by
`assertion_fail`. The standard test pattern is:

```js
class C { static m() {} }
verifyProperty(C, "m", {
  enumerable: false,
  configurable: true,
  writable: true,
});
```

`verifyProperty` (test262 helper) reads
`Object.getOwnPropertyDescriptor(C, "m")` and asserts each attribute. Today our
class methods land on the constructor / prototype as plain key=value, but with
default attribute flags (`{value, writable: true, enumerable: true, configurable: true}`).
Spec §15.7.1.1 says class methods MUST have `enumerable: false`.

Same issue applies to:
- Static methods (`class C { static m() {} }`) — `enumerable: false`.
- Instance methods (`class C { m() {} }`) on prototype — `enumerable: false`.
- Generators / async / async-generators — `enumerable: false`.
- Getters / setters (accessor properties) — separate `[[Get]]/[[Set]]` slot, not data descriptor.
- Static fields — `enumerable: true, configurable: true, writable: true` (different
  from methods!).
- Private fields — not on `[[OwnPropertyKeys]]`; distinct from public.

This is closely tied to #1334 (Object.defineProperty descriptors). #1334 fixes the
storage layer; this issue makes class declaration emit the *correct* attributes
through that storage layer.

Top failing test name patterns: `multiple-` (144), `private-` (97), `after-` (88),
`new-` (66), `same-` (44), `static-` (39), `nested-` (28), `regular-` (22),
`wrapped-` (22), `arrow-` (18) — all in `class/elements/`.

## Acceptance criteria

1. `language/expressions/class/elements/after-same-line-gen-literal-names.js` passes
   (verifyProperty on generator method on prototype, `enumerable: false`).
2. `language/expressions/class/elements/after-same-line-static-gen-literal-names.js`
   passes (static gen).
3. `language/statements/class/elements/regular-definitions-string-property-names.js` passes.
4. `language/statements/class/elements/wrapped-in-sc-array-private-method-call.js` passes.
5. `language/expressions/class/elements/private-static-method-name.js` passes.
6. Pass-rate for `class/elements/` rises from ~30% to ≥75%; **+450 net passes**.

## Files to modify

- `src/codegen/class-bodies.ts` — class method/field/accessor emission.
- `src/runtime.ts` — helpers for class-time descriptor application.
- (Depends on #1334 landing first for the descriptor storage; can co-develop.)

## Implementation Plan

### Root cause

The class-body emitter writes methods/fields onto the constructor or prototype with
direct field-set patterns:

```ts
// Pseudo:
ctorObj["m"] = methodFn;       // sets enumerable=true (default for assignment)
```

instead of:

```ts
Object.defineProperty(ctorObj, "m", {
  value: methodFn,
  writable: true,
  enumerable: false,
  configurable: true,
});
```

For the typed-struct fast path, we don't even have a descriptor table (#1334 work).

### Approach

#### A. Method emission must use defineProperty semantics

In `src/codegen/class-bodies.ts`, for each method declaration (regular, static,
generator, async, async-generator):

- Emit a `__class_define_method(target, name, fn, isStatic)` runtime call.
- Implementation: `Object.defineProperty(target, name, {value: fn, writable: true, enumerable: false, configurable: true})`.
- For accessor methods (get/set), emit `__class_define_accessor(target, name, getter, setter, ...)` which calls `Object.defineProperty` with `{get, set, configurable: true, enumerable: false}`.

#### B. Field emission must use defineProperty semantics

For class fields (instance and static, public — not private):
- Emit `Object.defineProperty(instance, name, {value: initValue, writable: true, enumerable: true, configurable: true})`.
- Note: writable/enumerable/configurable all `true` here (different from methods!).
- Crucially the spec requires `[[DefineOwnProperty]]`, NOT `[[Set]]` — so the field
  is set even if a setter exists on the prototype chain. This is **#1239 territory**;
  cross-link.

#### C. Private field/method handling

Private fields are NOT on `[[OwnPropertyKeys]]` and don't appear in
`Object.getOwnPropertyDescriptors`. They must be stored on a parallel "brand" struct.

Tests for private:
- `Object.prototype.hasOwnProperty.call(c, "#y") === false` (the # is part of the test
  name, not a real property).
- Brand checks (`#x in obj`).

For now: ensure private symbols are stored on a parallel typed struct accessed via
ref-cast on a brand check; this should NOT add public-descriptor entries.

Read `src/codegen/class-bodies.ts` for current private-field emission and verify
no public descriptor table entry is added.

#### D. Static blocks / static initializer

Static initializers (`class C { static { ... } }`) run during class evaluation; they
can call `Object.defineProperty(C, "x", {...})` directly — that should already work
once #1334 lands.

### Edge cases

- Class method with computed name (`class C { [name]() {} }`) — name is evaluated at
  class-declaration time; emit defineProperty with that runtime key.
- Method named `"prototype"` on a static (`static prototype() {}`) — illegal per spec;
  syntax error.
- Method with a getter and a setter in the same class — combined accessor descriptor.
- Static method overriding a name from the parent class — descriptor on subclass C
  shadows.

### Test262 sample

- `test262/test/language/expressions/class/elements/after-same-line-gen-literal-names.js`
- `test262/test/language/expressions/class/elements/after-same-line-static-gen-literal-names.js`
- `test262/test/language/statements/class/elements/regular-definitions-string-property-names.js`
- `test262/test/language/expressions/class/elements/private-static-method-name.js`
- `test262/test/language/statements/class/elements/wrapped-in-sc-array-private-method-call.js`

### Dependencies

- Depends on #1334 (descriptor storage). Can be developed in parallel with mocked
  out runtime, validated against test262 once both land.

### Estimated impact

+450 net passes. §15.7 climbs from 67% to ~74%.

## Investigation update (senior-dev, 2026-05-08)

Probed the actual current behaviour against the architect's plan. **The
issue has multiple broken layers**, and the +450 net estimate won't come
from `class-bodies.ts` alone — the runtime side needs equal work.

### Layer 1 — Method discoverability (BROKEN today)

```ts
class C { static m(): void {} n(): void {} }
Object.getOwnPropertyDescriptor(C, "m");           // → undefined
Object.getOwnPropertyDescriptor(C.prototype, "n");  // → undefined
```

Empirically verified via `.tmp/probe-descriptor.mts`. `runtime.ts:1154-1187`
(`getOwnPropertyDescriptor` in the wasm-struct proxy) doesn't find class
methods at all. For prototype objects, the `_prototypeMethodNames`
short-circuit at line 1168-1171 returns `undefined` when the key isn't
in `fieldNames` (only data fields, not methods). For static methods on
the constructor C itself, the lookup also fails.

### Layer 2 — Descriptor flags (HARDCODED today)

Even when methods become discoverable, `runtime.ts:1174-1179` returns
`{writable: true, enumerable: true, configurable: true}` for every
property. Spec says methods need `enumerable: false`. Fields need
`enumerable: true`.

### Layer 3 — Compile-time flag table (PARTIAL today)

`buildShapePropFlagsTable` (`class-bodies.ts:604`) emits
`PROP_FLAGS_DEFAULT = 0x07` (writable + enumerable + configurable) for
every user field uniformly. No distinction between methods (need 0x05,
no enumerable bit) and fields. Methods aren't even in `structFields` —
they're on the prototype and tracked via `_prototypeMethodNames`. So
the table needs a parallel method-descriptor structure.

### Realistic scope (revised)

| Slice | Scope | LoC | Yield without #1334 |
|-------|-------|-----|---------------------|
| 1A | Make class methods discoverable via `getOwnPropertyDescriptor` | ~80 | partial — wrong flags but exists |
| 1B | Wire method-descriptor flags through runtime | ~150 | requires #1334 storage |
| 1C | Field descriptor flags (instance + static fields) | ~50 | requires #1334 |
| 1D | Private field/method invariants (NOT in `[[OwnPropertyKeys]]`) | ~80 | independent |

Total ~360 LoC. **Without #1334 landing first, only Slice 1A delivers
visible test wins**, and even those are limited to tests that check
method *existence* (`Object.getOwnPropertyDescriptor !== undefined`)
rather than reading flags.

### Recommendation to tech-lead

The architect's "Can be developed in parallel with mocked out runtime"
underestimates how much of the runtime IS the hard problem. Realistic
options:

(a) **Defer #1364 entirely until #1334 lands.** No work in this issue
until #1334 unblocks.

(b) **Scope to Slice 1A only** (~80 LoC method-discoverability fix in
`runtime.ts`'s wasm-struct proxy `getOwnPropertyDescriptor`). Partial
yield — tests that only check existence pass; tests that check flags
still fail. Stages 1B-1D follow once #1334 lands.

(c) **Block on #1334** and route this back to the architect for an
updated plan once #1334 is closer to ready.

Senior-dev assessment: this is genuinely in #1334's slipstream. The
+450 net estimate is unattainable without #1334.

Awaiting tech-lead decision before any code changes.

## Slice A — instance methods on C.prototype (this PR)

Per tech-lead's scoping (option 3), implementing only **instance methods on
the prototype** in this slice. Static methods, fields, accessors, generators,
and private members are deferred to subsequent slices (1364b/c/d).

### Implementation

- **`src/runtime.ts`** — added `_prototypeMethodBridges` WeakMap and
  `_getProtoMethodBridge(proto, name)` helper that lazily creates and caches
  a JS function per (proto, methodName). Cached so repeated reads return
  the same reference for `assert.sameValue(c.m, C.prototype.m)`.
- **`src/runtime.ts:__getOwnPropertyDescriptor` host import** — when the
  WasmGC struct receiver is a registered class prototype AND the property
  name is in its `_prototypeMethodNames` allowlist, return a descriptor with
  `value: <bridge>, writable: true, enumerable: false, configurable: true`
  (spec §15.7.1.1).
- **`src/codegen/expressions/calls.ts:Object.getOwnPropertyDescriptor` fast
  path** — when the static struct shape is known and the property name is in
  `ctx.classMethodNames`, fall through to the dynamic host-import path
  instead of returning `ref.null.extern` (the previous "field not found"
  default). This lets the runtime helper handle the proto-method case.

### Out of scope (deferred to follow-up slices)

- Static methods on the constructor `C` (need `__static_method_<C>_<name>`
  exports + post-class defineProperty emission).
- Public field descriptors (different default flags from methods —
  `enumerable: true`).
- Private fields (must NOT add public descriptor entries).
- Getter/setter accessors (separate `__defineProperty_accessor` path).
- Generator/async/async-gen methods (each has different wrapping today).
- Bridge function actually invoking the method via JS-side
  `C.prototype.m.call(c)` — currently the bridge throws TypeError if called.

### Test results

`tests/issue-1364a-class-method-descriptors.test.ts` — 12 cases pass:

- Descriptor object exists (not undefined) for `C.prototype.m`
- `enumerable: false`, `configurable: true`, `writable: true`
- `value` is a function
- Repeated reads return the same function reference (sameValue)
- `hasOwnProperty.call(C.prototype, "m")` === true
- `Object.keys(C.prototype)` is empty (methods non-enumerable)
- Multiple methods each get correct descriptors
- Regression: instance method invocation (`c.m()`) still works
- Regression: instance field descriptor unchanged
- Regression: unknown method returns falsy (pre-existing null/undefined gap)

## Slice B — delete C.m / delete C.prototype.m (this PR)

### Problem

`verifyProperty` (test262 harness) reads the descriptor of `C.m` / `C.prototype.m`,
confirms `configurable: true`, then does a second-pass invariant check:
deletes the property and asserts the descriptor lookup now returns
`undefined`. Slice A made the initial descriptor lookup correct, but
`delete C.m` still reported success while leaving the entry in
`_prototypeMethodNames` / `_staticMethodNames`. The second-pass lookup
therefore re-returned the same method descriptor and verifyProperty
failed.

### Implementation

- **`src/runtime.ts:_deletedClassPropNames`** — per-receiver `Set<string>`
  of method/static names that have been deleted. `_isDeletedClassProp`
  unifies this with the existing `_wasmStructDeletedKeys` tombstone (set
  by `__delete_property`) so both the codegen path
  (`delete C.m` → `__delete_property(C, "m")`) and the proxy trap path
  (native JS `delete proxy.m`) hide the entry from subsequent lookups.
- **`__getOwnPropertyDescriptor` host import** — both the proto-method
  arm (#1364a) and the static-method arm (#1395) gate on
  `!_isDeletedClassProp(obj, propStr)`.
- **`__getOwnPropertyNames` host import** — `_prototypeMethodNames` /
  `_staticMethodNames` lists are filtered through the deletion set so
  enumeration stops returning deleted names.
- **`_wrapForHost` proxy traps** — `fieldNamesForHost` filters its
  allowlist, `has` consults the deletion set, and `deleteProperty` calls
  `_markDeletedClassProp` for native-JS-side deletes.

### Test results

`tests/issue-1364b-class-method-delete.test.ts` — 8 cases pass:

- `delete C.m` removes the static method descriptor
- `delete C.prototype.m` removes the instance method descriptor
- `hasOwnProperty.call(C.prototype, "m")` is `false` after delete
- Sibling methods (instance + static) survive a targeted delete
- verifyProperty-style invariant: read → delete → read returns undefined
- Regression: deleting an unknown name still reports `true`
  (ECMA-262 §13.5.1 — vacuously true)
- Regression: instance method invocation through preserved siblings still works
