---
id: 2181
title: "unify implicit-derived-ctor BODY emission across the three representation lanes (struct-fill / externref-alloc / standalone-zeroed)"
status: ready
sprint: 63
created: 2026-06-16
updated: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: classes
goal: core-semantics
related: [2086, 1833, 2082, 2078]
origin: "2026-06-16 follow-up carved out of #2086 (param-prefix consolidation landed; body-emit unification deferred)"
---

# #2181 — one body-emission rule for the implicit derived constructor

## Problem

#2086 consolidated the **parameter-prefix** half of implicit-derived-ctor
synthesis onto a single helper (`computeImplicitDerivedCtorPrefix`), used by
both the func-type-registration and `FunctionContext`-build phases. The
**body-emission** half is still realized three times, one per representation
lane:

- **WasmGC-struct** (`class-bodies.ts` ~1340–1400): pushes per-field default
  values then `struct.new`, replays parent field initializers + ctor-body
  `this.x = …` assignments, calls the parent `_init` (#2082).
- **externref-backed** (~1347–1352, ~1500–1520): `__self` is a null externref
  set by the host-import `super(...)`; no `struct.new`; forwards `__arg{i}`
  externrefs to the built-in parent (#1833).
- **standalone** (the #2078 lane): zeroed base fields + replayed base ctor body
  with no `env::` host imports.

These are the same drift surface that bred #1833/#2082/#2078 — a forwarding or
field-replay fix in one lane can still miss the others, even though the
param-prefix can no longer diverge.

## Fix direction

Extract a single `synthesizeImplicitDerivedCtorBody(ctx, fctx, repr, …)`
parameterized by representation (`struct` | `externref` | `standalone`), so
the three current inline blocks become thin wrappers selecting `repr`. The
cross-lane regression guard from #2086 (`tests/issue-2086.test.ts`) already
exercises all three lanes with the same forwarding scenario and is proven to
fail every lane on an injected bug — use it as the safety net for the
extraction.

## Why deferred from #2086

This is a **high-blast-radius refactor of the most fragile class-construction
code** (struct allocation, `_init` splitting #1965, externref host-alloc,
standalone field zeroing). #2086 is a `medium` issue and all three lanes
already pass; doing the body-emit extraction inside it risked a >10-test
class-ctor regression mid-sprint. The param-prefix consolidation + the
cross-lane guard landed in #2086; this issue carries the remaining body-emit
unification with the guard already in place to protect it.

## Acceptance criteria

- The three representation lanes emit the implicit-derived-ctor body from ONE
  `synthesizeImplicitDerivedCtorBody` (or equivalent single source).
- `tests/issue-2086.test.ts` + #1833/#2082/#2078 suites stay green; a
  deliberately-injected body-emit bug fails all three lanes via the #2086 guard.
- No test262 regression (CI gate).

## Notes

Route to **senior-developer** — same architectural-consolidation flavor as the
class-object-model work (#2101/#2158). `tsc --noEmit` + the #2086 guard are the
local checks; CI validates conformance.
