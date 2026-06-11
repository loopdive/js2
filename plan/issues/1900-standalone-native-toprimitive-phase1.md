---
id: 1900
title: "standalone native ToPrimitive (Phase 1): Wasm-native OrdinaryToPrimitive over $Object (~2,136 ceiling)"
status: done
created: 2026-06-05
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, type-coercion, standalone
language_feature: to-primitive, symbol-toprimitive, abstract-operations
goal: standalone-mode
sprint: 61
parent: 1806
related: [1806, 1525b, 1472, 850, 1253, 1716]
needs_arch_spec: true
claimed_by: codex-developer
claimed_at: 2026-06-06T09:46:21.649Z
pr: 1251
completed: 2026-06-06
---
# #1900 — Standalone native ToPrimitive (Phase 1)

> **Sprint 60 centerpiece.** This is the single largest standalone-lane lever
> in the tree. **Needs an architect spec before dev dispatch** (see
> *## Needs Architect Spec* below) — route to architect first.

## Problem

#1806 (done) landed **Phase 0**: a clean standalone *refusal* for the
`__toPrimitive` host import. All **2,136** standalone test262 records that hit
object→primitive coercion now compile-fail with a `#1806`-citing message
instead of an opaque `Cannot convert object to primitive value`. The refusal
made the failures trackable but did **not** make any of them pass.

**Phase 1 (this issue)** implements a **Wasm-native ToPrimitive** over the
`$Object` WasmGC struct so these tests run without any JS host. This is the
ceiling that unblocks the bulk of the standalone object-coercion surface:
arithmetic/relational/equality operators, template literals, `String(obj)`,
property-key coercion, and `JSON.stringify` all funnel through ToPrimitive.

**Baseline**: standalone 12,002 / 43,125 (27.8%), sha `8a0d940d`, 2026-06-04.

## Spec

- [§7.1.1 ToPrimitive](https://tc39.es/ecma262/#sec-toprimitive) — the
  `Symbol.toPrimitive` exotic-method short-circuit + hint plumbing
  (`"default"` / `"number"` / `"string"`).
- [§7.1.1.1 OrdinaryToPrimitive](https://tc39.es/ecma262/#sec-ordinarytoprimitive)
  — the `valueOf`/`toString` method-name ordering by hint, each called via
  `Call`, first primitive result wins, else throw **TypeError**.
- Implement from fetched spec text, not memory; cite the section in the commit
  (per `feedback_spec_first_fixes`).

## Fix approach (from #1806 Option B, to be refined by architect)

Implement `__toPrimitive_number` / `__toPrimitive_string` (and the `"default"`
hint, which routes to the number ordering except for `Date`) as pure-Wasm
functions operating on the `$Object` struct:

1. **`Symbol.toPrimitive` lookup** — if the object carries a
   `[[Symbol.toPrimitive]]` entry, call it with the hint string and require a
   primitive result (else TypeError). Requires Symbol-keyed property lookup on
   `$Object` — **Phase B of #1472**; confirm its current state before relying
   on it (this is the main cross-issue dependency the spec must resolve).
2. **OrdinaryToPrimitive** — for the number hint try `valueOf()` then
   `toString()`; for the string hint reverse the order. Each is a `$PropMap`
   method dispatch returning a value that must be tested for primitive-ness
   (`__is_primitive`), first primitive wins.
3. **TypeError** on no-primitive — emit a real `__new_TypeError` instance
   (standalone in-module constructor via `emitWasiErrorConstructor`), matching
   the instance-shape requirement that `assert.throws`/`instanceof` checks rely
   on (see #846 slice-2 note on real-instance exceptions).

## Entry points (chokepoint already identified by #1806)

- `src/codegen/type-coercion.ts` — `toPrimitiveHostCallInstrs` /
  `emitToPrimitiveHostCall`: the ~6 sites that currently funnel to the host
  import. In standalone mode these must emit a `call $__toPrimitive_{number,string}`
  to the new Wasm functions instead of refusing.
- `src/codegen/expressions/late-imports.ts` —
  `refuseStandaloneToPrimitive` (the Phase-0 guard). Phase 1 replaces this
  refusal with the native call when the native path can handle the object;
  keep a narrowed refusal only for genuinely unsupported shapes
  (e.g. Symbol-keyed exotic where #1472 Phase B is absent).
- `src/runtime.ts` / standalone helper emit — where `__new_TypeError` /
  `emitWasiErrorConstructor` live for the no-primitive throw.

## Decomposition (architect to confirm slice boundaries)

- **Slice 1 — OrdinaryToPrimitive (valueOf/toString), no Symbol.toPrimitive.**
  Number + string hint over `$Object` with `valueOf`/`toString` method
  dispatch + primitive test + TypeError. This is the bulk of the 2,136 (most
  tests use plain `valueOf`/`toString`, not `Symbol.toPrimitive`). Largest,
  load-bearing slice.
- **Slice 2 — `Symbol.toPrimitive` short-circuit.** Gated on #1472 Phase B
  (Symbol-keyed lookup). Smaller test volume; can land after Slice 1.
- **Slice 3 — hint = `"default"` + `Date` exception** and the
  template-literal / property-key / JSON call sites that pass a non-number,
  non-string hint.

## Acceptance criteria

- Standalone OrdinaryToPrimitive over `$Object` structs runs with **zero**
  `__toPrimitive`/`__to_primitive` host imports (verify via the
  host-import-allowlist gate).
- The no-primitive path throws a real `TypeError` *instance* (passes both the
  outer `assert.throws(TypeError, …)` and an inner `e instanceof TypeError`).
- **Slice 1 target: ≥ 800 of the 2,136 standalone records pass.**
- JS-host (GC) lane unchanged — no regression in the default lane.
- New `tests/issue-1900*.test.ts` covering: numeric-hint `obj - 0`,
  string-hint `` `${obj}` ``, `valueOf` returning object then `toString`
  fallback, both returning objects → TypeError, and a `Symbol.toPrimitive`
  object (Slice 2).

## Needs Architect Spec

This is `feasibility: hard` and touches the standalone object/property model.
Before dev dispatch the architect must pin down:

1. **#1472 Phase B status** — is Symbol-keyed lookup on `$Object` available? If
   not, Slice 2 is deferred and Slice 1 must narrow its refusal precisely.
2. **`$PropMap` method-dispatch reentry** — calling `valueOf`/`toString` from
   inside a codegen helper (the trampoline concern that #1525b hit: invalid
   Wasm when the dispatched method is itself a late/trampolined function).
   Coordinate with **#1525b** — they share the method-dispatch substrate and
   may want a single shared `__call_method_by_name` helper.
3. **Primitive-test predicate** — the exact `$Object` discriminants for
   "is primitive" in standalone (number/string/boolean/bigint/symbol/undefined
   /null) without a host roundtrip.

## Implementation Notes

- Implemented Slice 1 as native `__to_primitive(externref, hint)` over the
  standalone `$Object` runtime, following fetched ECMA-262 §7.1.1 and
  §7.1.1.1 text: non-objects return unchanged, `"string"` hint tries
  `toString` then `valueOf`, and `"number"`/`"default"` try `valueOf` then
  `toString`.
- Method dispatch reuses the existing zero-arg accessor/closure driver after a
  `__typeof_function` guard, so non-callable properties are skipped instead of
  being treated as successful undefined returns.
- Primitive results are accepted for null/undefined sentinel, boxed number,
  boxed boolean, and native strings. Unknown non-null refs are treated as
  objects for this slice.
- The no-primitive path constructs and throws native `TypeError`, so
  `e instanceof TypeError` works in standalone catches.
- Added native `__extern_toString` routing for `String(obj)` and native-string
  template substitutions over dynamic `$Object` values.
- Extended standalone `__unbox_number` to parse native string primitives through
  the existing `__str_to_number` scanner, so `valueOf` object then `toString`
  string fallback feeds ToNumber correctly.
- Slice 2 remains deferred: dynamic `Symbol.toPrimitive` still hits the
  existing `#1472` `__get_builtin` standalone refusal because symbol-keyed
  lookup in the `$Object` property map is not available yet.

## Validation

- `pnpm exec vitest run tests/issue-1900.test.ts`
- `pnpm exec vitest run tests/issue-1900.test.ts tests/issue-1806.test.ts tests/issue-1806-string-hint.test.ts`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm exec vitest run tests/issue-1472.test.ts --testNamePattern "Phase B: dynamic property add/read|Phase B: property update"`
- `pnpm exec prettier --check src/codegen/binary-ops.ts src/codegen/expressions/calls.ts src/codegen/index.ts src/codegen/object-runtime.ts src/codegen/string-ops.ts src/codegen/type-coercion.ts tests/issue-1806.test.ts tests/issue-1900.test.ts`
