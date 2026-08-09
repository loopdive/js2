---
id: 3479
title: "Host reflection: Object.prototype.hasOwnProperty.call(C, staticMember) misses class static members (verifyProperty own-property cluster, ~547 host fails)"
status: done
completed: 2026-07-20
assignee: ttraenkler/senior-dev
created: 2026-07-20
priority: high
feasibility: medium
task_type: bugfix
area: runtime
goal: test262-conformance
model: opus
sprint: 73
horizon: m
related: [3417, 1395, 1047, 1364]
loc-budget-allow:
  # +28 lines in the host runtime's _wrapForHost has/getOwnPropertyDescriptor
  # traps to consult _staticMethodNames (Slice A). This IS the correct
  # subsystem — the host proxy that materializes class objects lives here,
  # alongside _wasmStructHasOwn / _readOwnDescriptor which it mirrors.
  - src/runtime.ts
---

# #3479 — static class members invisible to `hasOwnProperty` via the host proxy

## Problem
Under the oracle-v8 honest host harness, the `verifyProperty` corpus fails ~547
host tests in the class-elements family with:
- `obj should have an own property m` (312) — static **method** `m` on class `C`
- `foo doesn't appear as an own property on the C constructor` (156) — static
  **field** `foo` on `C`

`propertyHelper.js` line 63 does
`assert(__hasOwnProperty(obj, name), "obj should have an own property " + name)`
where `__hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)`.
That is the **`.call.bind` uncurried form**, and it is the exact shape that fails.

## Root cause (verified on origin/main)
Measured on a `class C { static m() {…} static foo = 7 }`:

| reflective op | static method `m` | static field `foo` |
| --- | --- | --- |
| `"m" in C` (`__extern_has`) | ✓ | — |
| `Object.getOwnPropertyDescriptor(C, k)` (value → `__getOwnPropertyDescriptor`) | ✓ | ✗ |
| `Object.getOwnPropertyNames(C)` | ✓ | ✗ |
| `Object.prototype.hasOwnProperty.call(C, k)` | **✗** | ✗ |
| `C.hasOwnProperty(k)` (direct method call) | ✓ | ✗ |

Two independent gaps:

1. **`hasOwnProperty.call` misses static METHODS (312).** `Object.prototype.
   hasOwnProperty.call(obj, key)` invokes `[[GetOwnProperty]]` — i.e. the
   receiver's `getOwnPropertyDescriptor` trap. When `C` is marshalled to the
   host it becomes a `_wrapForHost` **proxy**, but that proxy's
   `getOwnPropertyDescriptor` trap (`src/runtime.ts` ~5627) and `has` trap
   (~5590) do **not** consult `_staticMethodNames` / `_prototypeMethodNames`.
   The canonical direct-import paths DO: `_readOwnDescriptor`
   (`runtime.ts:4381`, used by `__getOwnPropertyDescriptor`) and
   `_wasmStructHasOwn` (`runtime.ts:2748`, used by `__extern_has`) both handle
   the static-method allowlist — which is why `in` / `Object.getOwnProperty*`
   succeed while `hasOwnProperty.call` (routed through the proxy trap) fails.
   NB: plain-object fields and prototype-method names DO work through the proxy
   (they are struct fields / sidecar), so this is specific to the class
   constructor's virtual static members — confirming ~547, not broader.

2. **Static FIELDS have no reflection at all (156).** Static fields compile to
   **module globals** (`class-bodies.ts:800` "Skip static properties — they
   become module globals, not struct fields") and are registered nowhere the
   reflective ops look. Only static *methods* get an allowlist
   (`_staticMethodNames`, #1395); static *fields* have no analog, so `in` /
   gOPD / getOwnPropertyNames / hasOwnProperty all miss them.

This is a **host-runtime reflective-dispatch gap, not a class-codegen
residual** — #1051/#1144/#1364 (static/private method fidelity) are all `done`;
this is the untouched reflection surface behind them.

## Implementation Plan
**Slice A (static methods, ~312) — proxy-trap parity, contained:**
- `src/runtime.ts` `_wrapForHost` **`has` trap** (~5594): after the deleted-prop
  guard, additively return `true` for a `key` in `_prototypeMethodNames` or
  `_staticMethodNames` (not tombstoned) — mirroring `_wasmStructHasOwn:2748`.
- `_wrapForHost` **`getOwnPropertyDescriptor` trap** (~5627): near the top (after
  the tombstone guard), for a `key` in `_staticMethodNames`/`_prototypeMethodNames`
  delegate to `_readOwnDescriptor(obj, key, exports)` (returns the spec descriptor
  `{writable:true, enumerable:false, configurable:true}` with the method bridge
  value), mirror onto `target` for the Proxy invariant, and return it.
- Purely additive (only answers for allowlisted class-method names previously
  missed); preserves the #1047 instance-field-leak exclusion.

**Slice B (static fields, ~156) — new registry:**
- Register static-field names at class-object registration (analog of
  `_staticMethodNames`; populate from `class-bodies.ts` static-field members +
  the `__register_class_object` host import) into a `_staticFieldNames` WeakMap,
  with the field VALUE resolvable (read the module global) for the descriptor
  `value`. Consult it in `_readOwnDescriptor`, `_wasmStructHasOwn`, the proxy
  traps, and the getOwnPropertyNames enumeration. Descriptor per spec: static
  data field → `{writable:true, enumerable:true, configurable:true}`.

## What this PR ships — Slice A (static methods, ~312)
`src/runtime.ts` `_wrapForHost` proxy: the **`has`** trap (class-object branch)
and **`getOwnPropertyDescriptor`** trap now consult `_staticMethodNames` and
delegate to `_readOwnDescriptor`, so `Object.prototype.hasOwnProperty.call(C, "m")`
(and the `.call.bind` form propertyHelper uses) answer for a class's static
methods the same way `in` / `Object.getOwnPropertyDescriptor` already do.
Purely additive (only answers for the static-method allowlist previously
missed); proto-method and plain-object paths untouched. Regression test:
`tests/issue-3479.test.ts`.

Validated: `after-same-line-static-method-private-method-usage.js`,
`regular-definitions-rs-static-method-privatename-identifier.js`,
`new-sc-line-method-rs-static-method-privatename-identifier.js`,
`after-same-line-static-method-private-names.js` now PASS; control
verifyProperty tests on plain objects/builtins unchanged.

## Remaining follow-ups (separate issues — NOT in this PR)
- **Slice C (instance-field leak, ~156 "foo doesn't appear on the C
  constructor")**: a class's INSTANCE field name (`foo = "x"`) wrongly reports
  `true` from `hasOwnProperty(C, "foo")` — the constructor object exposes the
  instance struct fields. #1047-family (marked done, residual on the
  constructor object). The `*-rs-static-*` templates that combine a static
  method + instance field fail here first. Fix: restrict the class-OBJECT proxy
  traps to the static allowlist + sidecar, not instance struct fields.
- **Slice B (static-field reflection)**: `static foo = 7` compiles to a module
  global (`class-bodies.ts:800`) with no reflection registry; `in`/gOPD/names/
  hasOwnProperty all miss it. Needs a `_staticFieldNames` registry analog to
  `_staticMethodNames`.

## Verification
- Scoped: static-method class-elements templates pass; `hasOwnProperty.call(C, "m")`
  returns true. Zero-regression on the passing verifyProperty corpus (plain
  objects, prototype methods) — full CI validates the shared host proxy.

## Notes
Filed from the #3417 host-fail triage (`plan/log/host-fail-triage-2026-07-20.md`,
cluster #5). Prize bounded to ~547 by breadth probe (plain-object/prototype
`hasOwnProperty.call` already works). This PR is Slice A (~312 static-method
sub-cluster); Slices B/C above cover the rest.
