---
id: 6499
title: "SCRIPT_FUNCTION_BINDING_FLAGS = 0x03 carries no presence bits — the seed creates a frozen `undefined`, not a binding"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
related: [6492, 4491]
---

# #6499 — a script-goal binding seed that defines nothing

`src/codegen/global-function-bindings.ts` seeds script-goal top-level bindings
onto the realm object through `__defineProperty_value`, passing
`SCRIPT_FUNCTION_BINDING_FLAGS = 0x03`.

That constant does not mean what the call site reads as. `__defineProperty_value`
(`src/runtime.ts`, ~L14200) splits its flag word into **presence** bits and
**value** bits:

```ts
if (flags & (1 << 7)) desc.value = _maybeWrapCallableUnknownArity(value, callbackState);
if (flags & (1 << 3)) desc.writable    = !!(flags & 1);
if (flags & (1 << 4)) desc.enumerable  = !!(flags & (1 << 1));
if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
```

`0x03` sets bits 0 and 1 — both **value** bits — and no presence bit at all. So
the descriptor handed to `Object.defineProperty` is `{}`: the property is
created with `value: undefined, writable: false, enumerable: false,
configurable: false`.

The seed therefore does the opposite of its purpose. Instead of publishing the
binding it creates a **frozen `undefined`** under that name, which then:

- answers `true` to a `has` check while holding no usable value, and
- makes the body's own later write throw `Cannot redefine property: <name>`.

Both were observed during #6492 round 8 (`Cannot redefine property: test` /
`testcase` on the linked lane), where the symptom was misread as a second
seeder. Round 9 traced it to this encoding.

## Fix

`0xbb` — `1<<7` value present, `1<<3 | 1<<0` writable specified true,
`1<<4 | 1<<1` enumerable specified true, `1<<5` configurable specified with
bit 2 clear (false), matching §10.2.11 CreateGlobalFunctionBinding for a
non-configurable script-goal function binding.

## Why it is not folded into #6492

The constant is on the **standalone** path too, and #6492's shipped round-9
mechanism (a provider-side read-time lookup) does not need it. Correcting it
moves standalone verdicts and so needs its own standalone A/B rather than
riding along inside a host-lane linked-parity change.

## Acceptance criteria

- The seeded property is writable + enumerable + non-configurable and holds the
  function, verified by a unit test that reads the descriptor back.
- Standalone test262 A/B: net ≥ 0, with any per-row flips named.
- A test asserts the `__defineProperty_value` flag word round-trips to the
  intended descriptor, so the next constant cannot be written value-bits-only
  again.
