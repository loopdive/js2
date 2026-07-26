---
id: 3666
title: "Standalone RegExp `d`-flag match-indices result fidelity"
status: done
assignee: ttraenkler/codex-regexp-completion
created: 2026-07-26
updated: 2026-07-26
completed: 2026-07-26
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: regexp
language_feature: regexp-match-indices
goal: standalone-mode
parent: 2161
related: [2588, 2589, 1914, 3251]
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
---

# #3666 — standalone RegExp `d`-flag match-indices result fidelity

## Measured problem

The Unicode string-set work closes the remaining `v`-flag pattern failures, but
the authoritative standalone baseline still has **13/13 non-pass** rows in
`built-ins/RegExp/match-indices/`. This family is not a regex-matching defect:
the engine already records the correct start/end capture slots. The residual is
the object/array shape exposed by `m.indices`.

The baseline was re-run from fresh `origin/main` `1861a5e517a110`, one isolated
`runTest262File(..., "standalone")` process per row, under the pinned FYI runtime
contract (Node 25.9.0 / Unicode 17.0):

- **0 pass / 13 fail**
- `Object.getPrototypeOf(indices)` and the same check on each pair return `null`
  instead of `Array.prototype`;
- `indices.length` is observed as `NaN`;
- `getOwnPropertyDescriptor` cannot see dense numeric elements or the
  `indices`/`groups` properties;
- `indices.groups` is absent even though the parser already records the named
  capture-to-slot map;
- unmatched captures use a null externref where the current standalone value
  regime requires the real `undefined` singleton.

## Root cause

#2589 materialises `m.indices` as an opaque externref `$ObjVec`, but the static
match-result reader erases the carrier type at the property boundary. The generic
reader then cannot prove array `.length`, array identity, or implicit dense-index
descriptors. The builder also drops the group-name map after creating the outer
vector and writes `ref.null.extern` for unmatched captures.

This is a representation contract, not five independent assertion patches:

1. preserve a typed native array carrier for `indices` and every `[start,end]`
   pair;
2. attach the spec's own enumerable `groups` property, containing a
   null-prototype object whose values alias the exact pair objects stored in the
   numeric slots;
3. use the standalone `undefined` singleton for unmatched captures and the
   no-groups value;
4. make dense numeric slots and `groups`/`indices` visible to descriptor
   reflection with writable/enumerable/configurable data-property attributes;
5. route `Object.getPrototypeOf`/`Array.isArray` to the shared native Array
   prototype identity, without a host import or a parallel array runtime.

## Acceptance

- All 13 exact authoritative rows pass under Node 25.9.0 / Unicode 17.0.
- Existing #2588/#2589 focused tests remain green.
- Pure standalone binaries validate and instantiate with zero imports.
- No host fallback, special Test262 shim, step-budget increase, or duplicated
  regex engine.

## Implementation notes

The fix keeps the existing regex engine and `$ObjVec` storage rather than
introducing a second match-result representation:

- `$ObjVec` is now an exact `$__vec_base` subtype with the common `length`
  prefix. The vec reflection overlay explicitly admits `$ObjVec` and the
  extended RegExp match vec, so dense numeric elements and the match
  companion properties use the same descriptor machinery as native arrays.
  The dynamic prototype arm is exact-`$ObjVec` gated; typed arrays and other
  vec-shaped exotics retain their own prototype semantics.
- The exec builder materialises `index`, `input`, `groups`, and (only with
  `d`) `indices` as own writable/enumerable/configurable data properties.
  `indices.groups` is always own: it contains the exact undefined singleton
  without named captures, and a null-prototype object otherwise. Named values
  are read back from the completed outer vector, which preserves the required
  identity invariant:
  `indices.groups.<name> === indices[captureIndex]`.
- Unmatched captures and absent optional result values use the standalone
  undefined singleton, never a null externref. Group-name escapes are decoded
  during both the pre-scan and main parse, so `\uXXXX`/`\u{...}` spellings map
  to the actual JavaScript property name and to the same named backreference.
- `Object.hasOwn` and `Object.prototype.hasOwnProperty` now consult the vec
  descriptor overlay for vec-base receivers. That composes the implicit dense
  indices and explicit companion-property descriptors instead of teaching the
  Test262 harness a special case.

The last two authoritative failures persisted after the RegExp values and
descriptors were correct. A/B instrumentation showed that they were exposing
three general callback/runtime gaps in Test262's real `assert.deepEqual`
machinery:

1. an earlier-compiled higher-order helper froze its inline closure candidates
   before a later captured callback was registered;
2. top-level collection retained `F.p = value` but dropped the checker-proven
   callable chain `F.p.q = value`;
3. uniform closure exports boxed boolean-branded `i32` returns as Number(0/1).

The dynamic-call default now delegates native closure classification to the
finalize-time `__apply_closure` bridge, after all closure types are known. The
module-init retention gate was widened only for a callable nested receiver
rooted at a top-level function, keeping ordinary object chains and
`F.prototype.*` excluded. Closure and method dispatchers preserve the
structural boolean brand with `__box_boolean`, while ordinary `i32` callbacks
continue to box as numbers. These are runtime contract repairs; none depend on
RegExp, Test262 filenames, or harness function names.

## Test results

- Authoritative Node 25.9.0 / Unicode 17.0 baseline:
  **0 pass / 13 fail**.
- Final exact `built-ins/RegExp/match-indices/` residual set:
  **13 pass / 0 fail**.
- Focused issue suite: all 15 tests pass (13 maintained Test262 rows plus
  identity/no-`d` and systemic late-callback/value-brand controls).
- Existing #2588/#2589 named-groups and indices suite: 13/13 pass.
- Parser bytecode suite and targeted closure, array overlay, Array prototype,
  typed-array prototype/MOP, and boolean-brand regressions pass except for two
  independently reproduced pre-existing failures:
  #1712 arity-0 host callback capture and #3177 typed-array delete.
- Every focused standalone artifact validates, instantiates with `{}`, and
  reports an empty import list.
