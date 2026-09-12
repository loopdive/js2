---
id: 5199
title: "ES2015 standalone generators — r2 residual pass"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
# 2026-09-07: generic delegation is implemented in a focused new runtime module;
# these existing producer/consumer sites carry the required wiring and frame ABI.
# Checkpoint bridge wiring: canonical GP seed, static generator prototype reads,
# the reserved nested factory ER ABI adapter, and the one-line closure hook.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/closures.ts
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/iterator-native.ts
  - src/codegen/context/types.ts
# These existing dispatchers own the required object/prototype/ABI boundaries.
func-budget-allow:
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
---

# #5199 — generators r2: cluster and fix the residual generator-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5141, part of PR #5179 — includes
the root-cause fix of the #5060 standalone generator-resume trap: V8 12.4 runs
a result-typed `try_table` as `unreachable`; the resume wrapper now trampolines
in a `block (result R)` under an empty-typed `buildTargetTaggedTry`) plus a
second pass (+25, PR #5213). Residual count on current main not re-measured;
the wave-8 planning pass was stopped.

Adjacent recorded defect: yield-star throw delegation has its own held draft
(PR #5063, pre-session) — check its state before clustering that area.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the generators residual list
  (`language/statements/generators/**`, `language/expressions/generators/**`,
  `built-ins/GeneratorPrototype/**`) on current main via the standalone probe
  (see #5194 step 0 for probe shape and the `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5141 (wave-1 plan), PRs #5179, #5213; #5060 (resume-trap root cause).

## 2026-09-07 implementation plan (Codex)

Base: `95186a4835a1fe`; isolated `codex/5199-generic-yield-star`. The immutable
20-row standalone baseline is `/tmp/js2-es2015-base-95186a/.tmp/generator-baseline.log`: 8 pass, 12 compile_error, zero skips. This is a targeted cohort, not the ES2015 denominator.

Read-only review of PR #5063 at `d070b5583e66be23903031e4bed0556559026d34` found
a useful throw-delegation checkpoint with an explicit closeout handoff in issue
#1691. Patches are retained in `.tmp/pr5063/`. Its recorded 9/13 standalone
result is historical, and its two-value iterator ABI cannot preserve raw result
identity or full return delegation. The original PR remains untouched.

1. Add a separate native delegation record/runtime preserving the acquired
iterator and captured next method. Implement next/return/throw dispatch, nullish
GetMethod, callability and result-object checks, original abrupt exceptions, and
missing-throw cleanup. Ordinary iterator operations retain their ABI/behavior.
2. Integrate only planner-supported generic yield-star positions. Preserve initial
next(undefined) (one argument), later sent values, return(done:false), and actual
delegation completion values. Keep unsupported placements as explicit refusals.
3. Preserve non-done result identity through a marked internal externref result
carrier and unwrap only at the public generator-method boundary. Internal
iteration unwraps and re-reads raw done through Get+ToBoolean before reading value;
the second done getter can change truthiness or throw. Force
generic-delegating frames to the externref payload carrier.
4. Test the full star-rhs-iter-* cohort, star-iterable, nullish throw/return cases,
raw result/getter/next-capture probes, and passing array/string/iteration and
GeneratorPrototype controls. No claims of corpus-wide completion from these rows.
5. Run scoped ratchets/typecheck and report current evidence. No commits, pushes,
or original-PR mutations in this task; declarations.ts/class-bodies.ts are owned
by the concurrent capture lane.


### In-progress measured evidence, 2026-09-08

The first protocol candidate passed all 44 exact paths in
`.tmp/protocol-paths.txt` (`.tmp/protocol-run.log`), including every
`star-rhs-iter-*`, `star-iterable`, nullish throw/return, and eight original
passing controls. Original 20-row subset: 8/20 baseline to 20/20 candidate,
12 exact pass flips, no losses or skips. These results predate additional
boundary fixes and must be rerun before completion. Root protocol fixtures
also measured 22/22 (11 originals plus 11 explicitly labelled equivalent
function-expression forms); `.tmp/consumer-protocol-results.json`.

Independent boundary probes exposed finally routing, numeric conversion,
native nested generator lookup, and running-state validation gaps. Fixes are
in progress. The original object-payload identity probes remain non-passing:
a minimal ordinary call with no generator also returns 0 on both immutable
base and candidate (Node returns 1):

```js
function test() {
  var payload = { valueOf: function () { return 7; } };
  var iterator = { next: function (v) { return v === payload ? 1 : 0; } };
  return iterator.next(payload);
}
```

Artifacts: `.tmp/payload-identity-control.mjs`,
`.tmp/payload-identity-control-base.mjs`, `.tmp/review-protocol-results.json`.
The canonicalization substrate issues #3037 and #3243 are related context,
not confirmed causes. This increment does not modify that separately owned
substrate. Numeric-conversion diagnostics show zero valueOf calls after the
consumer fix, and the delegated method receives undefined then an object;
this isolates payload delivery but does not relabel the original identity
probe as passing.

The original reentrancy probe is blocked by `env.__gen_next` leakage. A
reordered source-equivalent diagnostic registers the generator before its
iterator callback, emits no imports, and confirms missing TypeError before
the running flag fix and result 1 afterward (`.tmp/reentry-diagnostic.mjs`).
It is a diagnostic control, not a Test262 pass flip.


### Bridge follow-up implementation plan

Original nine native-generator bridge fixtures measured 1/9 on both immutable
base and first bridge candidate; the five nested numeric factory ABI failures
are confirmed baseline failures, not ignored. Preserve the Phase-0 reserved
externref return ABI when Phase-2 admits a native no-capture generator: factory
construction still creates the nominal state but crosses the reserved function
boundary through extern.convert_any. Keep all parameter/result ABI checks;
only the known native-state-to-reserved-externref adaptation is permitted.
Consumers use the canonical method getter/runtime state ladder for externref
receivers. Direct numeric yield-star construction calls the state constructor
itself and continues receiving the concrete state type.

Native generator instances also need the factory's actual prototype at creation.
Use the function-expression factory's leading __self parameter as function
identity; declaration factories use the existing materialized function-value
binding. A per-factory runtime prototype helper creates a distinct object whose
parent is shared GeneratorPrototype only when the own property is absent, and
respects later reassignment, including a primitive value (instance creation then
uses the spec default). Replace the two static g.prototype singleton folds and
initialize each new state before exposure. Validate direct/extracted/delegated
methods and own/inherited accessor/undefined/null overrides.

The 653-path list `.tmp/es2015-generator-core-paths.txt` is a bounded four-directory
cohort, not the full generator population. Root derived a 2486-path exact-feature
ES2015 generator cohort including method/class/arguments/destructuring rows;
that is the broader regression scope, within the full 11704-row ES2015 goal.


## User-requested checkpoint handoff — 2026-09-08

Scope frozen at the user's request to land current work, write a handoff and open
PR. This issue remains unfinished. Full handoff:
[generator checkpoint](../log/2026-09-08-es2015-generator-checkpoint-handoff.md).
Final source: configured TS7, compiler bundle, standalone smoke12 and focused27/27
pass. Original bridge9 reports4/9 (baseline1/9), including one weak invalid-only
control; five documented runtime failures remain. LOC/function/coercion/oracle
gates pass with the exact grants above. QuickJS provider is stale; final44 and
prototype11 are pending. Earlier44/44 protocol evidence predates the final bridge
and factory expansion. Numeric payload ABI and closed-object identity failures
remain explicit follow-ups. No claim of completed generic semantics or full
ES2015 conformance is made by this checkpoint.
