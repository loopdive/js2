---
id: 4633
title: "Standalone: %Array% intrinsic identity across the runtime-eval boundary (wellKnownIntrinsicObjects)"
status: ready
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: low
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/runtime-eval-boundary.ts
  - src/codegen/builtin-value-read.ts
---

# #4633 — Intrinsic identity across the runtime-eval boundary

## Problem

`test/harness/wellKnownIntrinsicObjects.js` fails standalone at
`assert(Object.is(Array, intrinsicArray))`. The harness populates each
intrinsic with `new Function("return " + source)()` — i.e. the value comes
back from the RUNTIME-EVAL engine (quickjs tier, #4242) — and compares it
with `Object.is` against the compiled module's own `Array` value read.

Two representations meet: the compiled lane's native builtin-ctor value
(a `$NativeProto`/singleton carrier from builtin-value-read.ts) and
whatever the eval boundary returns for `Array`. They are not the same
reference, so `Object.is` answers false.

## Implementation Plan

1. **Measure first**: instrument what `new Function("return Array")()`
   returns standalone (carrier kind, null?) and what the bare `Array`
   value read returns in the same module. Record both here before design.
   Probe files go in your worktree's `.tmp/`; run via
   `npx tsx` + `runTest262File(path, "harness", 30000, "standalone")`
   (see tests/test262-runner.ts). The quickjs runtime-eval tier is the
   default engine (#4242).
2. **Design decision** (pick after step 1):
   - (a) **Boundary canonicalization**: when the runtime-eval boundary
     hands back a value that names a global builtin (the eval engine can
     tag "this is the global `Array`"), substitute the compiled lane's own
     singleton for it, so identity holds by construction; or
   - (b) **Identity map in Object.is/===**: teach the sameValue native an
     arm equating the eval-side proxy for a builtin with the native
     singleton — narrower but leaks into every comparison site.
   Prefer (a): single chokepoint, no comparison-site sprawl.
3. **Scope guard**: only globals reachable by bare name need this
   (`Array`, `Object`, …); accessor-path intrinsics
   (`Object.getPrototypeOf([][Symbol.iterator]())`) are follow-ups — the
   harness self-test only asserts `%Array%` plus two throwing cases, which
   already throw correctly.
4. **Acceptance**: `harness/wellKnownIntrinsicObjects.js` passes
   standalone; runtime-eval canary suite unchanged; no js-host byte change.
