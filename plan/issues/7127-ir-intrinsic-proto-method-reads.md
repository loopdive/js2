---
id: 7127
title: "IR: admit `<Builtin>.prototype.<method>` value reads off ambient intrinsics when the brand companion is seeded"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/lead-c-remote"
---

## Problem

[#7123](7123-ir-ambient-intrinsic-member-read-refusal.md) refuses every ambient
intrinsic that is a member-read receiver, because the IR's dynamic
`__extern_get` read answered differently from legacy's static lowering.
rc-8 asked which of those shapes can be made exact and returned to the IR.

## Measured (refusal disabled, standalone and gc, against legacy-only and node)

| Shape | companion not seeded | companion seeded |
| --- | --- | --- |
| `<B>.prototype.<method>` value (typeof, identity vs `Object.prototype.<m>`) | wrong | exact (208 pairs: 8 receivers × 26 methods) |
| `Error.prototype.message` / `.name`, `Array.prototype.length` | wrong | exact |
| `TypeError.prototype.constructor === TypeError` | wrong | wrong |
| `Object.getPrototypeOf(TypeError.prototype) === Error.prototype` | wrong | wrong |
| `typeof Function.prototype` | wrong | wrong (`"object"`) |
| `TypeError.call` / `.apply` / `.bind` | wrong | wrong |
| `Function.prototype.length` / `.name`, `String.prototype.length`, `Symbol.prototype.description`, `RangeError.prototype.toString === Error.prototype.toString` | — | legacy itself wrong |

"Seeded" = legacy's pre-scan armed `protoMemberDirty` for another reason
(e.g. an `Object.getPrototypeOf` call anywhere in the module). Arming it costs
~870 KB on a minimal module (37 KB → 908 KB), so arming it on behalf of the
IR would grow every module that reads a builtin prototype member; and the
IR's module-init claim is planned after body compilation (post-direct
overlay), too late to arm the flag without the read/store desync the pre-scan
exists to prevent.

## Change

- `isMemberReadReceiver(node, protoCompanionSeeded)`
  (`src/ir/values/ambient-intrinsics.ts`) admits
  `<Receiver>.prototype.<method>` when the companion is already seeded,
  `Receiver` ∈ {Object, Array, Function, Error, String, Number, Boolean,
  Symbol}, the method is in the measured list, and the read is a plain value:
  not called, not read further (keeps the S1c
  `Object.prototype.toString.call` arm and legacy's `.call` paths), not a
  write/`delete`/update target. Everything else stays refused.
- New selection option `builtinProtoCompanionSeeded` (`src/ir/select.ts`),
  fed from `ctx.protoMemberDirty` (`src/codegen/index.ts`). Never arms the
  flag, so no module grows.

## Validation

- `tests/issue-7118-ambient-intrinsic-values.test.ts`: seeded reads claim and
  run on standalone and gc; seeded `constructor` / `TypeError.call` /
  `Function.prototype` / data members stay legacy.
- Probe: 48 chunked modules (8 receivers × 26 methods), seeded: node ok,
  legacy ok, IR claims and ok on both lanes; size IR − legacy ≈ −17 bytes.
  Unseeded: unchanged legacy path.
- Census (standalone, 159 test262 files, every 300th of built-ins+language,
  and 40 files that read builtin prototypes): byte-identical before/after,
  legacy units 916 → 916 and 198 → 198. No row moves on this base: the
  harness functions and `<module-init>` around these reads are refused for
  other reasons (owned by the stacked PRs). Conformance A/B therefore has no
  changed file to run.

## Left

- Not exact even seeded (stays refused): `.constructor` identity,
  inherited `Function.prototype` members off intrinsic constructors
  (`TypeError.call`), `Function.prototype` as a value, prototype chain
  identity between NativeError and Error prototypes.
- Unseeded modules keep the refusal; making them exact needs the
  companion armed before body compilation for an IR claim that is decided
  after it.
- Related gap #7123 noted, now measured: `function f(C) { typeof C.call }`
  with `f(TypeError)` is IR-claimed and wrong — but legacy is wrong
  identically (both throw where node passes; standalone and gc). It is a
  shared runtime gap in inherited `Function.prototype` reads off native
  constructor values, not an IR divergence. `C.prototype.toString` off a
  parameter is right on both.
