---
id: 5363
title: "`assert.throws(RangeError, …)` fails on errors thrown through the linked Temporal provider — `instanceof` on a THROWN error across the seam (22 of 123 rows)"
status: ready
sprint: current
priority: high
horizon: m
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5363 — thrown-error identity across the linked seam

## Problem

Measured by dev-5208 (PR #5666) on the 123-row #5249 Temporal calendar list,
provider linked, after #5208 unblocked the calendar path: **22 rows** fail on
"cross-seam `instanceof` on thrown errors" — the test262 harness's
`assert.throws(RangeError, fn)` runs `e instanceof RangeError` on an error the
polyfill threw INSIDE the provider, and it answers false.

This is adjacent to, but not the same as, #5226 (PR #5369) and #5247
(PR #5651):
- #5226 made a provider throw reach the CONSUMER's compiled `catch` by identity
  (shared host-owned `__exn` tag);
- #5247 made an uncaught compiled throw reach the HOST as the real `Error`
  (export-boundary wrapper) — and deliberately EXCLUDED linked-provider
  exports from wrapping so #5226's route survives.
The gap is the composition: the harness (host) calls a CONSUMER export, the
consumer calls into the PROVIDER, the provider throws, nothing catches it in
wasm, and what reaches the host `catch` is not a `RangeError` instance — or is
a `RangeError` from a different realm/constructor identity than the harness's
`RangeError` (test262 compares against the global of the realm it runs in).

## Implementation Plan (Fable, 2026-09-06)

1. **Probe, both routes, before touching anything**: (a) consumer export →
   provider function that throws `new RangeError("x")`, uncaught, host `catch`:
   report `Object.prototype.toString.call(e)`, `e instanceof RangeError`,
   `e.constructor === RangeError`, `e.name`; (b) the same with the provider's
   throw caught and re-thrown by the consumer; (c) control: single-module
   export throwing the same. Also check whether the `RangeError` constructor
   the POLYFILL sees (`globalThis.RangeError` inside the provider module) is
   the host's — if the provider mints errors through a compiled `Error`
   subclass or a per-module intrinsic, `instanceof` against the host global
   is false by construction.
2. Likely roots, in order: (i) the #5247 wrapper is skipped for the CONSUMER
   export when the throw ORIGINATES in the provider (the wrapper catches
   `$__exn` — the shared tag in a linked graph — so this should work; verify
   the consumer export is actually wrapped in the linked build); (ii) the
   payload is a compiled-object error (the polyfill constructs errors via
   `new RangeError(...)` → if `RangeError` is bridged as a compiled class
   value, the instance is a struct marshalled to a proxy, not a host Error);
   (iii) realm mismatch — the harness's `RangeError` vs the import object's.
3. Fix at the identified layer; do NOT re-wrap provider exports (would undo
   #5226). Base-failing test in the linked lane, control green single-module.
4. Measure `family-123.txt` provider-linked stacked on the #5208 PR
   (`issue-5208-compiled-date-host-bridge`) + #5661; report the 22 and the
   next layer.

## Acceptance criteria

1. Probe evidence for (a)/(b)/(c); the layer named with file:line.
2. `assert.throws(RangeError, …)` passes for a provider-originated throw;
   #5226 and #5247 suites stay green; equivalence at baseline.
3. 123-row re-measurement with counts.

## Notes

- Filed from dev-5208's next-layer table (PR #5666), 2026-09-06.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
