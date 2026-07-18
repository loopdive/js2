---
id: 2706
title: "for-in enumeration order: integer-index keys ascending, insertion-order strings, prototype-chain dedup"
status: blocked
assignee: ttraenkler/Esch
sprint: Backlog
goal: test262-conformance
feasibility: medium
depends_on: [2739]
priority: medium
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2706 — for-in enumeration order: numeric-first, insertion-order strings, prototype chain

## Problem

The `for-in` statement does not enumerate object keys in the order required by ECMAScript §13.7.5.15 EnumerateObjectProperties:

**(a) Integer-indexed keys must come first in ascending numeric order, then remaining string keys in property-creation (insertion) order.** `order-simple-object.js` creates an object with properties `b`, `a`, `1`, `2` and expects the for-in output to be `["1", "2", "b", "a"]` — integer indices ascending, then strings in insertion order. We currently emit them in a different order.

**(b) Prototype chain keys: inherited enumerable properties must appear after all own properties, with shadowed/already-visited keys skipped.** `order-property-on-prototype.js` and `S12.6.4_A6.js` / `S12.6.4_A6.1.js` check that properties from the prototype appear after own properties and that shadowed ones are not repeated.

**(c) Properties added via `Object.defineProperty` after object creation must appear in the right position.** `order-after-define-property.js` checks that a property added with `defineProperty` (non-numeric, non-creation-order) still follows the integer-index-first rule.

Spec: ECMAScript §13.7.5.15 EnumerateObjectProperties abstract operation — note the spec deliberately leaves ordering partially unspecified for non-integer-index string keys, but test262 validates the most common conforming ordering (integer indices first, then insertion order, then prototype chain).

## Failing tests (test262 baseline 2026-06-26)

```
test/language/statements/for-in/order-simple-object.js
test/language/statements/for-in/order-property-on-prototype.js
test/language/statements/for-in/order-after-define-property.js
test/language/statements/for-in/S12.6.4_A6.js
test/language/statements/for-in/S12.6.4_A6.1.js
```

## Root cause (suspected)

The for-in enumeration in the runtime (likely a host import or the `__for_in_keys` helper) returns property keys in an arbitrary iteration order (probably whatever JS engine order the host's `Object.keys`/`for...in` gives). It may not:
1. Sort integer-indexed own properties numerically before string own properties.
2. Walk and deduplicate the prototype chain.
3. Preserve insertion order for string keys after the numeric sort.

The fix likely requires either:
- Implementing EnumerateObjectProperties in the Wasm runtime helper (sort integers, preserve insertion, walk proto chain, track seen set), or
- If using a JS host import, ensuring the host-side `__for_in_keys` helper returns keys in the correct canonical order.

Standalone mode must also implement this without relying on JS engine for-in ordering.

## Acceptance criteria

All 5 listed tests flip from fail to pass. No regression in `statements/for-in/` currently-passing tests. Full CI green.

## Split status (esch, 2026-06-27) — three independent halves, two landed

This issue's scope decomposed into three independent bug classes; two are landed
and the remaining blocker is now #2739:

| Half | Tests | Status |
|------|-------|--------|
| Integer-index keys ascending (#1830) | (integer-key mis-routing) | **landed** — PR #2160 |
| Insertion-order + delete/re-add (#2731) | `order-simple-object` | **landed** — PR #2170 |
| Prototype-chain (`setPrototypeOf`/constructor) + `defineProperty` ordering (**#2739**) | `order-property-on-prototype`, `S12.6.4_A6`, `S12.6.4_A6.1`, `order-after-define-property` | **open** — `depends_on: [2739]` |

So this issue is now blocked solely on **#2739** (prototype/defineProperty for-in
enumeration). Re-point the acceptance to those 4 prototype/defineProperty tests
once #2739 lands.

## Notes

- Keep separate from #2705 (for-in lexical scoping — different code path: enumeration key generation vs head/body scoping).
- The ordering requirement is "implementation-defined for string keys" per strict spec reading, but test262 validates the de-facto standard: integer-index ascending, then insertion order, then prototype chain without duplicates. Conforming implementations all follow this pattern.
- If the `__for_in_keys` helper is shared between `for-in` and `for-of` on objects, changes here must not regress `for-of` enumeration.

## Findings (esch, 2026-06-26) — TWO distinct root causes, only one is a runtime.ts fix

Verify-first against current `origin/main` shows the 5 failing tests are gated by
**two independent bugs**, not one:

### Bug 1 — #1830 well-known-symbol-id ↔ integer-index collision (FIXED here)

`src/runtime.ts` `_safeGet` / `_safeSet` remapped a numeric key `1..15` on a
WasmGC struct to a well-known-symbol slot via `_symbolIdToKeys`
(`5 → @@species`, `7 → @@match`, …). So `o[5]=55` on a typed struct stored under
`Symbol.species` + a `"@@species"` sidecar string: `o[5]` round-tripped `55` but
`5 in o` was `false`, `Object.keys` dropped `"5"`, and for-in **leaked
`"@@species"`**. **Verified premise:** in host mode (the only mode `runtime.ts`
runs in — standalone uses `object-runtime.ts`) the compiler boxes every
well-known-symbol access into a **real JS Symbol** via `__box_symbol`
(instrumented: `o[Symbol.species]=9` arrives at `_safeSet` as
`typeof key === "symbol"`, never a number). So a numeric key reaching these
host functions is **always** a genuine integer index — the remap was pure cruft.

**Fix applied:** drop the numeric `1..15 → _symbolIdToKeys` remap in `_safeGet`
and `_safeSet`; numeric keys fall through to the sidecar (stored under `"5"`),
so `in`/for-in/`_orderOwnKeysSpec` see `"5"`. Real-symbol keys keep their
`typeof key === "symbol"` routing. **Regression: for-in suite 94→94 PASS, zero
deltas; `o[5]/o[7]` now enumerate correctly + ordered.**

### Bug 2 — delete-then-re-add never re-appears (PRE-EXISTING, NOT a runtime.ts fix, blocks all 5)

A property that is **deleted then re-assigned** does not re-appear in for-in:
`{a,b,c}; delete o.a; delete o.c; o.a=9` enumerates `b` only (expected `b,a`).
- **Pre-existing** — reproduces identically on `origin/main` WITHOUT the Bug-1 fix.
- **Independent of #1830** — occurs with pure string keys (no symbol collision).
- **Root cause (instrumented):** for a native `$Object` (`const o: any = {…}`),
  property **writes and for-in enumeration are Wasm-native** (`object-runtime.ts`),
  but `delete` routes through the **host `__delete_property` import**, which records
  a host-side tombstone in `_wasmStructDeletedKeys` (disconnected from the native
  `$Object`'s own key storage). A re-add is a native Wasm write that never clears
  the host tombstone, so the key stays suppressed. (The only host import the repro
  requests is `__delete_property`; assignments emit no `__extern_set`/`_safeSet`.)

**Consequence:** the Bug-1 fix alone closes **0 of the 5** listed tests — every
one is gated by Bug 2 (e.g. `order-simple-object` improves from fully-wrong to
`0,1,2,p2,p4` missing only the re-added `p1`). Bug 2 is a host/wasm-boundary
representation issue (`$Object` delete-tombstone vs native storage), far larger
and riskier than the runtime.ts symbol-remap fix, and warrants its own issue +
architect spec. **This contradicts the original "all 5 hinge on #1830 / it's a
runtime.ts fix" framing** — #1830 is necessary but not sufficient.
