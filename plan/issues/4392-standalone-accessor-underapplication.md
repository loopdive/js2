---
id: 4392
title: "Standalone: property accessors with unused trailing parameters never run"
status: ready
assignee: ttraenkler/codex-es5-defineproperty
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen-standalone
language_feature: property-descriptors
goal: es5
es_edition: 5
sprint: current
related: [1888, 2668, 3592]
---

# #4392 — accessors must tolerate omitted arguments

## Problem

The standalone property runtime invokes a getter through
`__call_accessor_get -> __call_fn_method_0` and a setter through
`__call_accessor_set -> __call_fn_method_1`. Those dispatchers contain only
closures whose declared arity is no greater than the dispatcher arity. As a
result, a getter that declares an unused parameter, or a setter that declares a
second unused parameter, does not match any dispatch arm and silently returns
the fallback value instead of executing.

JavaScript calls are allowed to supply fewer arguments than a function declares;
the omitted formals receive `undefined`. The generic dynamic-call bridge already
implements that rule by widening to the closure's declared arity (#3592), but
the accessor-specific drivers bypass it.

## Confirmed ES5 impact

Fresh standalone `runTest262File` results on `origin/main`
`a28c6bfcb3df2e61dcfd63a7baddfb0d5d33c711`, using the assembled upstream
Test262 harness and passing must-pass/must-fail controls:

- `Object/defineProperty/15.2.3.6-4-567.js` — one-parameter getter is not called.
- `Object/defineProperty/15.2.3.6-4-568.js` — two-parameter getter is not called.
- `Object/defineProperty/15.2.3.6-4-574.js` — two-parameter setter is not called;
  after fixing dispatch, its first assignment becomes correct and the test moves
  to a separate module-global value-widening failure for the omitted second
  parameter.

The exact ES5 non-pass census contains three files with this source shape. The
two getter files are wholly explained by this root. The setter file also has
this root, but fixing it exposes an independent `undefined`-to-f64 storage bug;
this issue claims the accessor-dispatch behavior and does not overstate that
second root as fixed.

## Implementation

Make both accessor drivers use the existing `__closure_arity` authority. Seed
`__argc` with the actual accessor argument count (zero for get, one for set),
select `__call_fn_method_N` at `max(actual, declared)`, and fill omitted
arguments with the canonical standalone `undefined` carrier. This keeps
`arguments.length` at the real call-site count while using the same runtime
closure dispatch reached by IR `dyn.member_get` / `dyn.member_set`.

## Acceptance

- Both confirmed getter files flip fail -> pass in standalone mode.
- The confirmed setter file executes its body, observes the assigned first
  argument, and advances to the separately documented module-global
  representation failure without being counted as a pass here.
- Getter/setter calls with exact or lower declared arity remain green.
- Omitted accessor formals receive `undefined`; `arguments.length` remains 0/1.
- A tracked compile proves a dynamic member-read consumer is genuinely emitted
  through IR and reaches the shared native accessor runtime; the same runtime
  driver also serves legacy member reads and writes.
- Relevant focused tests, typecheck, format, issue checks, and IR fallback gates
  pass with no control regression.
