---
id: 4061
title: "Descriptor-ARGUMENT validation in Object.create/defineProperties (§8.10.5) + §8.12.9 step 1 redefine-over-inherited — 31 files"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
---
# Descriptor-ARGUMENT validation in Object.create/defineProperties (§8.10.5) + §8.12.9 step 1 redefine-over-inherited — 31 files

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Split out of the "117-file family" by g-enforce (2026-08-01) after classifying all 117 by what each test body actually does. Deliberately NOT folded into #3983 — genuinely different defect.

POPULATION: 31 files, standalone lane, ≤ES5 goal scope.

MECHANISM (two related arms):
  (a) §8.10.5 ToPropertyDescriptor argument validation — steps 1 / 7.b / 8.b / 9.a.
      Shapes: `{prop: null}` (descriptor not an Object), `get:` bound to a primitive
      (non-callable accessor), and `get` + `value` present together (mutually
      exclusive fields). Each must throw TypeError; standalone does not.
  (b) §8.12.9 step 1 — redefine over an INHERITED property.
  Entry points: Object.create and Object.defineProperties.

WHY IT IS SEPARATE from the fixed/claimed work:
  - #3983 (g-enforce, fixed) = the assignment / compound-assignment WRITE path,
    37 files. Root cause was `ctx.funcMap.set("__extern_set_strict", externSetIdx)`
    aliasing strict [[Set]] onto the sloppy helper. Nothing to do with argument
    validation.
  - g-arraylen = Array-receiver DEFINE path, 35 files (maybeEmitVecLengthDefine
    routing gap; compileObjectDefineProperties never reaches it).
  This bucket is the NON-Array define path and is about rejecting malformed
  DESCRIPTOR ARGUMENTS before any define happens — a validation gap, not a
  routing or enforcement gap.

⚠ SIZING DISCIPLINE — read before quoting any number:
  The "117-file family" was a SIGNATURE census (all files sharing the error string
  "Expected a TypeError to be thrown but no exception was thrown"), NOT one
  mechanism. It decomposes 37 / 35 / 31 / 11 (Function.prototype.caller poisoning)
  / 2 (Object.getOwnPropertyNames arg validation) / 1 (arguments.callee).
  Quoting 117 for any single fix overstates it by ~3x. Do not size off the
  signature; read the bodies.

⚠ ALSO RETRACTED: the earlier claim that a sloppy write to a writable:false property
  traps with an uncatchable raw WebAssembly.Exception is FALSE. It is a catchable
  TypeError in-module; the observation came from a probe with no try/catch, where any
  standalone throw surfaces as an opaque WebAssembly.Exception by construction.

⚠ MEASUREMENT: scoped standalone arms on this box see compile_timeout contention
  flakes. g-enforce's 220-file control showed 5 apparent flips that were all flakes
  (re-run solo: 5/5 pass). Counting them would have inflated +24 to +29. Re-run any
  apparent flip solo before crediting it.

Context: /workspace/plan/log/analysis-2026-08-01-descriptor-dedup-map.md
Allocate a fresh issue id via `node scripts/claim-issue.mjs --allocate --by ttraenkler/&lt;agent&gt;`.
