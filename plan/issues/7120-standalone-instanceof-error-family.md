---
id: 7120
title: "Standalone generic instanceof misses Error-family membership (a native error is not `instanceof Error` through a dynamic target)"
status: in-progress
assignee: ttraenkler/session-d
created: 2026-10-22
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
goal: error-model
task_type: implementation
area: codegen
related: [7106, 2916, 1473, 7118]
---

# Standalone generic `instanceof` misses Error-family membership

## Problem (legacy wrong answer)

Legacy's generic runtime `instanceof` on the host-free lanes,
`__instanceof_dynamic(value, target)` (#2916 Slice B,
`src/codegen/native-dynamic-instanceof.ts`), answers **false** where the spec
(and node) answer **true** whenever the target is an Error-family constructor
and the value is an instance of a SUBTYPE:

| value | target (reached dynamically) | before | node |
| --- | --- | --- | --- |
| `new TypeError()`, `new RangeError()`, `new SyntaxError()`, a caught runtime TypeError | `Error` | false | true |
| `new (class extends TypeError {})()` | `TypeError` | false | true |
| `new (class extends TypeError {})()` | `Error` | false | true |

"Dynamically" means the target is not a literal constructor name at the
site: a parameter, an `any` local, a property read, or any other shape that
falls to `emitDynamicInstanceOf`. Legacy compiles a literal
`x instanceof Error` through the name-based tag test (#1473,
`collectErrorInstanceOfTags`), which answers correctly. So the same program
answers differently depending on how the constructor reached the site.

Measured on standalone and default gc (same answers). The IR's
`dyn.instanceof` (#7106) lowers to this operator at exact legacy parity, so
it inherits the bug. Fixing it here unblocks admitting an intrinsic right
operand (`e instanceof TypeError` in propertyHelper, via #7118's
`dyn.global_object`) without changing any answer relative to legacy's static
path.

## Root cause

The helper decides membership with the §7.3.20 chain walk. In standalone the
native error prototypes do not chain: `Object.getPrototypeOf(TypeError.prototype)
=== Error.prototype` is false, and `TypeError.prototype.isPrototypeOf(new
TypeError())` is false. So the walk from a TypeError instance never reaches
`Error.prototype`. A user subclass of a builtin error is a `$Error_struct`
carrying the parent's `$tag`, with no `$Object` prototype link to walk.

## Fix

A second arm on the existing builtin-constructor identity probe,
`__instanceof_builtin_ctor_identity(value, target)`. That probe is reserved
when `__instanceof_dynamic` is built, consulted before the chain walk, and
filled at finalize once the carriers exist. It already answers the `Object`
carrier.
- **New arm (`errorCarrierTagArm`).** When `target` is `ref.eq` to the
  bare-value carrier of an Error-family constructor `N`
  (`ctx.builtinObjectGlobals`, `__builtin_<N>`), and `value` is an
  `$Error_struct` whose `$tag` is in `collectErrorInstanceOfTags(N)`, it
  answers **1**. Every other case still answers UNKNOWN, so the helper
  continues unchanged.
- **Where it lives.** The fill moves into `fillBuiltinCtorIdentityHelper`,
  composed from the `Object` arm (unchanged) and the new Error arm.
  `ensureNativeDynamicInstanceOf` does not grow: it was 300 lines, and a
  separate probe would have taken it to 309.
- **Shared tag sets.** `collectErrorInstanceOfTags` and the Error-family name
  list move from `expressions/identifiers.ts` to `builtin-tags.ts`. The
  name-based path and the probe now share one definition of the tag sets.

The result is the tag set OR'ed with the existing chain walk. It can only turn
a `false` into a `true`, and only for exactly the value and target pairs
legacy's static name path already answers `true`. `Object.create(
TypeError.prototype) instanceof TypeError` (chain walk true, tag test false)
stays true.

Out of scope (unchanged): a runtime non-callable target still answers
`false` instead of throwing (#2916 "no wrong throws").

## Acceptance criteria

- The rows above answer as node on standalone and default gc. Every other
  row of the #7106 `dyn.instanceof` fixture is unchanged.
- A standalone test262 sample, before and after measured on the same base:
  every file of the error-related directories plus a random sample. No
  regression.
- Node-compared tests.
