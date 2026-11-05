---
id: 7194
title: "Carrier loose ==/!= skips ToPrimitive on object operands (standalone and WASI IR, standalone legacy)"
status: ready
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
related: [7193, 7178, 7113]
---

# Carrier loose `==` / `!=` skips ToPrimitive on object operands

## Problem

IsLooselyEqual (§7.2.14) ToPrimitives an object operand compared against a
primitive. The boxed-any carrier's loose equality does not do this on any no-host
lane. This is pre-existing on base `95648287`; it was found while reviewing
[#7193](./7193-standalone-prepared-dynamic-helper-abi.md) (PR #6973).

- **Standalone IR:** `__extern_loose_eq` (`src/codegen/any-helpers.ts`,
  `ensureExternLooseEqHelper`) is `__any_from_extern` ×2 + `__any_eq`. Its
  results:
  - `({ valueOf() { return 2 } }) == 2` traps on an illegal cast;
  - `[2] == 2` traps;
  - `[2] != "2"` and `{ toString() { return "2" } } != "2"` answer `true`
    (node: `false`).

  An ordinary top-level function reproduces it:
  ```ts
  export function g(m: any): number { return m == 2 ? 1 : 0; }
  export function run(): number { return g({ valueOf: function () { return 2; } }); }
  // standalone, IR claims g → RuntimeError: illegal cast; experimentalIR:false → 1
  ```
  Legacy standalone is correct in this top-level shape: its inline arm calls
  `__to_primitive` before `__any_eq`.
- **Standalone legacy, planned member closure in `<module-init>`:** the #7193
  reviewer measured `{ valueOf(){return 2} } == 2` trapping. A
  parameter-operand probe (`if (m == 2)`) answered correctly in legacy, so the
  legacy trap is shape-dependent; pin it before fixing.
- **WASI IR (claimed in planned member closures today):** the #7193 reviewer
  measured the following, where legacy answers correctly:
  - `{ valueOf(){return 2} } == 2` traps;
  - `[2] != "2"` differs from node;
  - `m != 2` over mixed inputs traps.

  Shape:
  `subject.f = function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r == 2) throw "e"; throw r; };`

## Current containment

`native-dynamic-loose-equality` (`src/ir/backend/legality.ts`) is WASI-only. It
admits carrier loose equality in planned closures on WASI only to keep main's
output. Standalone refuses it at select (`closure-carrier-helper-operator`).

## Acceptance

- The carrier loose-equality helper ToPrimitives an object / array operand
  (hint "default") before the primitive comparison, on standalone and WASI.
- IR = legacy = node on objects with `valueOf` / `toString`, arrays, and
  primitives across types.
- Once that holds, admit standalone and drop the string-only rule in
  `carrierLooseEqualityAdmissible`, with tests.
