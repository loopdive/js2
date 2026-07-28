---
id: 3736
title: "%TypedArray%.prototype.set(array, offset) traps out-of-bounds in standalone mode when offset is a non-primitive (array/object) that ToInteger-coerces to a small in-range integer"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: typed-arrays
goal: crash-free
depends_on: []
related: [3707, 3735]
---
# #3736 — TypedArray.prototype.set offset ToInteger(array/object) traps oob in standalone

## Context

Discovered while diagnosing why `#3707`'s fix (wiring
`fillArrayToPrimitive`/`fillClassToPrimitive` into `generateMultiModule`)
caused `test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js`
to flip from a `null_deref` trap to an `oob` trap (tracked as an intentional
reclassification in #3735, not a regression). This issue tracks the actual
underlying bug now newly reachable.

## Repro

Standalone target (`compileFiles(..., { target: "standalone" })`):

```ts
export function run(): number {
  const sample = new Int32Array([1, 2]);
  sample.set([42], [1] as any);   // offset arg is an array -> ToInteger -> 1
  return sample[0] * 100 + sample[1];
}
```

Traps `unreachable` at runtime. Per spec (`22.2.3.23.1`), `ToInteger([1])`
is `1` (via `ToPrimitive` → `"1"` → `ToNumber` → `1`), so this should write
`42` at index 1 and return `1*100+42 = 142` — exactly like the equivalent
`sample.set([42], 1)` (a bare numeric literal), which DOES work correctly
(confirmed via `.tmp/repro-set-isolate.mjs` in this session).

Also reproduces for offset `[0]`, `[]`, and (inconsistently depending on
whether the argument has an explicit `as any` cast, suggesting the bug may
also involve call-site dispatch/overload selection, not only the coercion
itself) `{}`.

## Suspected root cause (unconfirmed — needs investigation)

Two candidate layers, not yet isolated:

1. **`ToInteger`/`ToPrimitive` coercion of the offset itself** — isolated
   testing showed `Number([])` alone (no `.set()` involved) also traps
   `unreachable` in standalone mode, while `Number([0])`/`Number([1])`
   evaluate correctly (`0`/`1`). So there may be a narrower, separate bug:
   **empty-array-to-primitive-string traps in standalone** (likely in
   `src/codegen/array-to-primitive.ts`'s `fillArrayToPrimitive`, possibly an
   out-of-bounds access when joining zero elements).
2. **The offset write path after coercion succeeds** — `sample.set([42],
   [1] as any)` traps even though `Number([1])` alone does NOT trap,
   meaning a distinct bug exists specifically in
   `%TypedArray%.prototype.set`'s standalone offset-handling code once it
   has a real (non-array) coerced offset value in hand.

**Also notable** (found via JS-host mode testing, may be a related but
distinct existing bug, needs separate confirmation): `sample.set([42], [1])`
in **JS-host mode** (not standalone) returns a result consistent with
offset `0` instead of the correct offset `1` — i.e. this may not be
standalone-only. Verify against a real spec-compliant JS engine before
assuming this is also a compiler bug vs. a flaw in the repro harness.

## Suggested approach

1. First isolate the empty-array-to-primitive-string standalone trap in
   full isolation (no `.set()` involved) — smallest possible repro, likely
   a one-line fix in `array-to-primitive.ts`.
2. Re-test `.set()` with a working non-empty-array offset after (1) is
   fixed, to see if the oob trap persists — it may or may not be the same
   root cause.
3. If it persists, trace the offset-write path in
   `src/codegen/array-methods.ts` (or wherever `%TypedArray%.prototype.set`'s
   array-offset overload is implemented) for standalone-mode-specific
   assumptions about the offset's representation (e.g. assuming it's
   already i32/f64 when it may still be externref-boxed after a non-numeric
   ToPrimitive path).
4. Confirm/refute the JS-host-mode wrong-value finding above with a minimal
   equivalence test before folding it into this issue's scope — it may need
   its own issue if it's a genuinely separate bug.

## Acceptance criteria

- [ ] `test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js`
      no longer traps in standalone mode.
- [ ] New regression test(s) covering array/object offset arguments to
      `.set()` in both standalone and JS-host targets.
- [ ] If the JS-host wrong-value finding is confirmed as a real bug, either
      fix it here or split it into its own issue — do not leave it silently
      unaddressed.
