---
id: 4498
title: "Uncatchable trap: defining a huge-but-legal array index grows the backing to ~2B elements (array element access out of bounds)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: unassigned
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
es_edition: es5
goal: standalone-mode
related: [4491, 4222, 4247, 4434, 3189]
---

# #4498 — huge-index define blows up the backing allocation

**Do not implement from this file without an A/B plan** — the fix is an
ALLOCATION POLICY change whose blast radius is every array growth path, which is
exactly why it was split out of #4491's key-routing slice rather than bundled
with it.

## Measured (standalone, 2026-08-15, split out of #4491 D-a)

```js
var a = [];
Object.defineProperty(a, "2147483647", { value: 7, writable: true, enumerable: true, configurable: true });
```

→ **`array element access out of bounds` — an uncatchable Wasm abort**, not a
throwable error. `2147483647` (2^31-1) is a perfectly legal array index
(§6.1.7: a uint32 `< 2^32-1`), so the define is required to succeed; the runtime
instead tries to grow the vec backing to ~2.1 billion elements.

Neighbours, from the same sweep — the trap is specific to a legal-but-huge
index, which is what makes it easy to miss:

| key | outcome |
| --- | ------- |
| `"99"` (small index) | stores (read-path bug aside) |
| `"2147483647"` (2^31-1, legal index) | **TRAP** |
| `"2147483648"` (2^31, outside the #4434 approximation window) | ordinary named key, no trap |
| `"4294967295"` (2^32-1, not an index) | ordinary named key, no trap |

## Why this is priority: high

An uncatchable trap is #3189-ratchet material: it aborts the module instead of
throwing something a program (or the test harness) can observe and recover from.
It is strictly worse than a wrong answer, and it is reachable from ordinary
`Object.defineProperty` on an ordinary array literal.

**It is not confined to `defineProperty`.** The same backing-grow path is
reached by element assignment and by the dynamic metaobject chokepoints;
`vec-index-domain.ts` §2 (#4434) already documents the sibling case where
`vec.length` exceeds `array.len(vec.data)` and the dynamic lane traps on
`a.length = 3; a[1]`. Any fix must be validated against those too, which is
precisely why it wants its own A/B and its own reviewer attention rather than
riding along with a key-routing commit.

## Fix direction (not implemented)

A **sparsity threshold in the backing-grow path**: when the requested index is
far beyond the current physical length (some bounded factor, or an absolute
element cap), do not densify. Route the property to the expando/named bag —
the #3537 bag the non-index keys already use — and keep `length` updated per
§10.4.2.1 without materialising the elements in between.

Open questions the design must answer, all of which have consumers today:

- **Where does the threshold live** so that element WRITE, `defineProperty` and
  the dynamic chokepoints all agree? A disagreement here is the #4247 failure
  mode (write and read agreeing on the same wrong slot).
- **Reads of an index in the sparse tail** must find the bag, and
  `hasOwnProperty` / `Object.keys` / OrdinaryOwnPropertyKeys ordering must see
  those keys as INTEGER-INDEX keys, not string keys — which runs straight into
  #4497's is-index-vs-value representation question for the upper range.
- **`length` semantics**: `a.length` must still report `index+1` even though no
  element was materialised (§10.4.2.1 step 3.f.i), i.e. the existing
  "`vec.length` may exceed the backing" invariant of `vec-index-domain.ts` §2
  becomes the normal case rather than the exception.

## Validation

`TEST262_TARGET=standalone` over `built-ins/Object/defineProperty`,
`built-ins/Array` and `built-ins/Object/keys` — plus an explicit no-trap
assertion, since a trap is not a test failure the harness can attribute.
