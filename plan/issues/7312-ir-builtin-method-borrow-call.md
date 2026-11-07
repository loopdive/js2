---
id: 7312
title: "IR: builtin method borrow `<B>.prototype.<m>.call(r, …)` / `<B>.<static>.call(r, …)` in test module-init"
status: blocked
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7294, 7275, 7106, 7287, 7310]
depends_on: [7294]
assignee: "ttraenkler/c-lead"
---

# #7312: builtin method borrow through `.call` in a test's `<module-init>`

## Problem

R11's census (`plan/log/ir-module-init-single-lever-census.md`) lists 5
single-lever stride-40 files whose only refusal is a borrow of a builtin
method through `.call` on a non-Array builtin. The #7106 borrow wrapper covers
`Array.prototype.*` only.

## Measurement (2026-11-07, main `dc52abf7`, standalone)

**Candidates.** There are 17 stride-40 files with a non-Array builtin borrow
whose only legacy unit is `<module-init>`. 13 pass on standalone; 4 fail on
base:

- `Date/prototype/toString/non-date-receiver`;
- `Iterator/prototype/join/closes-on-contents-coercion-exception`;
- `SharedArrayBuffer/prototype/grow/this-is-not-object`;
- `String/prototype/trimStart/this-value-object-valueof-meth-priority`.

**Is the borrow the only blocker?** Each borrow was replaced by a neutral
stand-in and `<module-init>` was recompiled through the wrapped harness
(`JS2WASM_IR_SHAPE_DIAG=1`). For files where the stand-in itself was refused,
the receivers were probed separately.

| File (passing on base) | Other blocker once the borrow is gone | Flips with a borrow arm? |
|---|---|---|
| `String/prototype/trim/15.5.4.20-2-1.js` | none | yes |
| `Function/prototype/bind/15.3.4.5-2-12.js` | none | yes |
| `Promise/all/ctx-non-object.js` | none found (the receivers 86, `'string'`, null, … and the `[]` argument are carriers) | probably |
| `Array/from/source-object-constructor.js` | none (reading `Object` as a value is IR) | probably, but see the exactness note |
| `Map/prototype/delete/context-is-weakmap-object-throws.js` | `new WeakMap()`: `host-surface-unavailable` | no |
| `Map/prototype/get/does-not-have-mapdata-internal-slot.js` | `vardecl-module-storage-unrepresentable` («m = new Map()») | no |
| `Function/prototype/bind/15.3.4.5.1-4-15.js` | `vardecl-module-storage-unrepresentable` | no |
| `Promise/try/ctx-ctor-throws.js` | `vardecl-let-closure` | no |
| `Promise/prototype/finally/invokes-then-with-non-function.js` | `host-surface-unavailable` | no |
| `String/prototype/trim/15.5.4.20-2-46.js` | `arguments` in a closure | no |
| `Set/prototype/{has,delete}/…`, `WeakMap/prototype/delete/…` | also an instance-member borrow (`s.has.call(0, 1)`), outside this shape | no |

**Yield: 2 certain, up to 4.** These are the census's 5 files minus Map
`delete`.

## Why it is not one arm today

The brief's design is "singleton value + `.call` with an explicit receiver,
through the legacy helper, one arm keyed by brand". Measured:

1. **Legacy has no single helper.** Each of the four flipping files reaches a
   different legacy lowering:
   - `String.prototype.trim.call` and `Function.prototype.bind.call` reach
     `emitReflectiveNativeProtoClosureCall` (calls.ts) through per-family
     member allowlists;
   - `Array.from.call(C, …)` reaches the #5268 `__array_from_native` arm with
     `C` as the constructor (call-builtin-static.ts);
   - `Promise.all.call` reaches the promise combinator receiver arm.

   All of them emit inline instruction sequences. The IR has no channel for
   those (#7294's finding: `raw.wasm` has no SSA result). Each would have to
   become a named support function, as #7294 does for the descriptor.
2. **The generic route is not exact for every API.** Reading the singleton
   and applying it with `this` = receiver through `__apply_closure` drops
   `Array.from`'s constructor receiver. Legacy's own value-erased form shows
   this: `var f = Array.from; f.call(Object, []).constructor !== Object`
   throws on standalone base. It answers correctly for `trim` and for
   `Promise.all` with a non-object receiver (probes: `.tmp/bp/{af,pa,tr}.js`).
3. **The IR cannot read the singleton yet.** A read of
   `<B>.prototype.<m>` as a value is #7275 shape 1. #7294 (R8, branch
   `issue-7294-ir-builtin-proto-gopd-provider`, head `c876e075`) adds the
   codegen support functions but no IR row. Static members (`Promise.all`,
   `Array.from`) are outside that provider.

## Implementation Plan (once #7294's value row lands)

- **Module.** `src/ir/ambient-global-function-call.ts`, a "borrow" row family
  next to #7294's value row. The callee is #7294's (brand, member) value
  getter, called through the existing Stage-4 dynamic apply
  (`lowerDynamicValueCall` with the explicit receiver), as #7287 does. This is
  one parameterised arm keyed by brand.
- **Scope: prototype members whose value-erased legacy form is exact.** That
  means `trim` and `bind`, the 2 certain files. Statics (`Promise.all`,
  `Array.from`) need their own singleton provider, and `Array.from` also needs
  the constructor-receiver arm, so they are a follow-up only if a support
  function can expose legacy's arm.
- **Gate.** The callee must be a `<B>.prototype.<m>` whose brand has native
  glue and an own `method`-kind member, the same gate as legacy's
  `emitReflectiveNativeProtoClosureCall`. `.apply` and `.bind` chains are
  refused.
- **Acceptance.**
  - The 2 files flip.
  - TypeError text is identical to legacy for a non-object `this`.
  - gc bytes are identical (the glue is standalone-only).
  - The head never traps where the base does not.

**Decision for the lead.** The certain yield (2) is below the bar of 3. With
`Promise.all` it is 3, but that needs a static-member provider #7294 does not
have. Recommendation: keep #7312 blocked on #7294's value row, and revisit with
the static provider in the same lane.
