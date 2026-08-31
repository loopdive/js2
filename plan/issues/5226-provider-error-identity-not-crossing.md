---
id: 5226
title: "Errors thrown inside a linked provider lose identity at the seam — e.pass through as generic objects, instanceof RangeError is false in the consumer"
status: ready
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5226 — provider seam: error identity does not cross

## Problem

An error thrown inside the #4628 linked Temporal provider (e.g. the
polyfill's `RangeError: year is required`) reaches the consumer as a value
for which `e instanceof RangeError === false` (and `instanceof Error` is
unreliable). The message survives; the identity does not. test262 Temporal
rows assert error TYPES (`assert.throws(RangeError, …)`), so every
negative-case row fails at the seam even when the polyfill throws correctly —
this gates wiring the test262 runner to the provider as much as #5223 does.

## Direction

Reduce non-Temporal: provider function that `throw new RangeError("x")`,
consumer catches and checks `instanceof`. Decide the crossing rule: re-mint
the error host-side from name+message when a provider throw crosses the seam
(cheap, loses custom subclass state), or mirror it module-aware like #5222's
value path. Host-lane `Error` objects are host-native, so re-minting at the
linker trampoline (`instantiateLinkedProviders` call wrapper) is likely
sufficient and narrow.

## Acceptance criteria

1. Non-Temporal reduction: `instanceof RangeError` true in the consumer for a
   provider throw; new `tests/issue-5226-*.test.ts` failing on base (linked
   lane), single-module control passing.
2. `assert.throws(RangeError, () => Temporal.PlainDate.from({}))`-shaped
   probe passes through the provider.
3. No regressions in issue-5222/4628 + linker family. Gates green.

## Notes

- Found by dev-5221 validating PR #5334. Blocks (with #5223) the test262
  runner wiring for #4628 acceptance criterion 2.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.
