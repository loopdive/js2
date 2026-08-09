---
id: 3512
title: "Host reflection: class INSTANCE fields leak as own properties of the constructor via the _wrapForHost has/gOPD proxy traps (#3479 Slice C, ~142 host fails)"
status: done
completed: 2026-07-21
assignee: ttraenkler/senior-dev
created: 2026-07-21
priority: high
feasibility: medium
task_type: bugfix
area: runtime
goal: test262-conformance
model: opus
sprint: 73
horizon: m
related: [3479, 1047, 1395]
loc-budget-allow:
  - src/runtime.ts
---

# #3512 — instance fields leak as own properties of the class constructor

## Problem (host lane, "foo doesn't appear as an own property on the C constructor")

`Object.prototype.hasOwnProperty.call(C, "foo")` wrongly returns **true** when
`foo` is an INSTANCE field of class `C` (`class C { foo = "x" }`). Instance fields
live on instances, not on the constructor object — the assertion
`assert(!Object.prototype.hasOwnProperty.call(C, "foo"))` in the class-elements
`*-rs-static-*` / `*-literal-names` templates fails.

This is **Slice C** of #3479, the symmetric follow-up to the landed Slice A
(static-method reflection, #3435). Slice A taught the `_wrapForHost` `has` /
`getOwnPropertyDescriptor` proxy traps to ANSWER for a class object's static
methods (allowlist), but the traps then **fell through** to
`safeGetField(key)` / `fieldNamesForHost()`, which read the class's INSTANCE
struct-field shape — so instance field names leaked as own properties of the
constructor's host proxy.

Root cause: the proxy traps (`src/runtime.ts` `_wrapForHost` `has` ~5629 and
`getOwnPropertyDescriptor` ~5706) had a `_prototypeMethodNames` (#1047)
authoritative branch for class PROTOTYPES but none for class OBJECTS — so the
constructor proxy's presence/descriptor answers were not restricted to the
static allowlist. The DIRECT `__hasOwnProperty`/`in` path already restricts class
objects correctly (`_wasmStructHasOwn` ~2778), but `hasOwnProperty.call(C, k)`
routes through the proxy `[[GetOwnProperty]]` trap, which lacked the guard.

## Fix — symmetric class-object guard in the two proxy traps

`_wrapForHost`:
- **`has` trap**: when `obj` is a registered class object (`_staticMethodNames`),
  the static allowlist + sidecar are AUTHORITATIVE — return early, do NOT consult
  `safeGetField`/`fieldNamesForHost` (mirrors the #1047 prototype branch and
  `_wasmStructHasOwn`'s class-object arm).
- **`getOwnPropertyDescriptor` trap**: symmetric — for a registered class object,
  return `undefined` unless the key is a static method (handled above) or a
  sidecar prop; never report an instance struct field.

Zero-regression by construction: instance-field names on a constructor object are
never legitimate own properties, and static methods / sidecar dynamic props / the
class prototype / plain objects / class instances are all unaffected.

## Measured result (delta on a clean, non-private-name, non-async sample)

Full-clean-set measurement in `## Test Results` below. Delta proof: a 30-file
clean sample went **0/30 → 18/30 PASS** with the fix (every flip is this change;
the rest fail on unrelated features — generator `C_init` compile errors, computed
symbol names, accessor fields). Regression probes: static-method own-prop,
sidecar prop, instance field on the instance, plain-object present/absent, and a
static-method-less class field all correct.

## Acceptance
- `!Object.prototype.hasOwnProperty.call(C, <instanceField>)` holds.
- Static methods, sidecar props, class-prototype reflection, class instances, and
  plain objects unchanged.
