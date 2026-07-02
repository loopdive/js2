---
id: 2989
title: "Standalone defineProperty missing spec TypeErrors (~32: array length, non-extensible, non-configurable redefine)"
status: done
completed: 2026-07-02
sprint: current
priority: medium
horizon: s
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2965, 2962]
origin: "#2965 descriptor-cluster triage — follow-up class 6 (assert.throws(TypeError) missing)"
---

# #2989 — standalone defineProperty missing spec TypeErrors

## Problem

Follow-up from #2965. ~32 tests assert that `defineProperty` (or an operation
gated by it) throws a `TypeError` in a spec-mandated case, but the standalone
lane does not throw:

- defining/growing an array `length` past a non-writable barrier,
- defining a new property on a non-extensible object,
- redefining a non-configurable property with an incompatible descriptor.

These are missing-throw failures (the operation silently succeeds or no-ops
instead of throwing). Note the payload opacity itself is #2962's scope; here the
issue is the _absence_ of the throw, not its stringifiability.

## Acceptance

- The three spec-mandated TypeError sites throw on the standalone lane; measured
  flip count on the standalone defineProperty throw-assertion subset with zero
  regressions; gc/host byte-inert.
