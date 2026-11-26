---
id: 7529
title: "f64 `undefined` leftovers: JSON writes null, parameter properties, omitted constructor args, captured vars, template literals"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7464, 7215]
---

# #7529 — f64 `undefined` leftovers after #7464

## Problem

Five defects that #7464 left open. Items 1-4 were measured on its branch (head 50bce1ba04), item 5 on b9fa72a84f
merged with main (all 2026-11-26); each also fails on main. gc and standalone behave the same.

1. **JSON writes `null` for an `undefined` property.** `JSON.stringify({ a: undefined })` gives `{"a":null}`; node
   gives `{}`. The native codec's `$AnyValue` arm maps tag 1 (undefined) to `"null"` (`json-codec-native.ts`
   ~L411). This is a codec defect, not a sentinel one, and it blocks item 2.
2. **`number | undefined` parameter properties.** `constructor(public a: number | undefined)` has no struct field
   (#7215), so `.a` is a dynamic read. `=== undefined` works, but `new C(undefined).a ?? 5` gives NaN (node 5), and
   `String`/`typeof` give `"NaN"`/`"number"`. Giving it a branded field (as #7464 does for declared fields) fixes
   those, but makes `JSON.stringify(new C(undefined))` print `{"a":null}` until item 1 is fixed. That breaks the
   equivalence test `issue-7215-ctor-parameter-properties` › "number default undefined".
3. **Omitted f64 constructor arguments are padded with `0`**, not the sentinel (`new-super.ts` ~L7051). So
   `constructor(public a?: number)` reads 0 for `new C()`. Padding with the sentinel breaks
   `function-arity-mismatch` › "class constructor with no args", which pins the 0; that pin is wrong against node.
4. **A closure reading a captured, never-assigned `number | undefined` binding sees NaN**, not `undefined`, for both
   `var` and `let`. This is pinned with `it.fails` in `tests/issue-7464-f64-sentinel-residuals.test.ts`.
5. **A template literal over a `number | undefined` value does not compile.** `` `${g}` `` with
   `let g: number | undefined;` fails with "Template literal numeric substitution requires number_toString"
   (`string-ops.ts` ~L907) on gc and standalone; node gives `"undefined"`. A parameter does the same:
   `` (x: number | undefined) => `${x}` ``. Once the checker narrows the value to `number`
   (`` g = 3; `v${g}` ``) it compiles and answers right. The f64 span arm finds no `number_toString` function, so
   the formatter is apparently not registered for a span whose declared type is `number | undefined`.

## Order

Fix 1 first; it unblocks 2. Item 3 needs the arity test corrected against node in the same change. Item 4 is
independent: the capture cell presumably stores an unbranded f64. Item 5 is independent too: register the
formatter for an undefined-capable f64 span; its sentinel-aware arm (`emitNumberToStringSentinelAware`) already
prints `undefined`.

## Acceptance criteria

- Each item answers like node on gc and standalone, pinned by tests that fail on main. Item 4's `it.fails` becomes
  `it`. Item 5 compiles, and `` `${g}` `` gives `"undefined"` before `g` is assigned and its number after.
- Output for programs without `number | undefined` slots is byte-identical (check a test262 sample on gc and
  standalone, and a typed corpus).
- No budget grants; extend the existing sentinel helpers (`undefinedCapableSlotType`, `emitToNumber`) rather than
  adding parallel ones.
