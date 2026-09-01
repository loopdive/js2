---
id: 5255
title: "Standalone: native generator method result bridge loses state and deferred dynamic this"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
task_type: conformance
area: codegen, generators, calls
es_edition: ES2015
goal: standalone-gap
created: 2026-09-01
origin: "#3591 diagnostic Test262 cohort"
related: [3591, 5254]
---

# #5255 — generator method invocation loses native state and `this`

## Problem

`built-ins/GeneratorPrototype/next/context-method-invocation.js` requires a
generator declaration invoked through `{ g: g }.g()` to observe that object as
its `this` when resumed by `iter.next()`. In standalone it fails at line 23:
`assert.sameValue(context, obj)`.

The immediate transport failure is before the #3591 opaque resume dispatcher:
the callable-property result bridge declares `Generator` as `externref`, so a
known native generator-state `ref` from `obj.g()` is dropped through the root
funcref result path. Even after a narrow native-state-to-externref bridge, the
native state does not retain deferred dynamic `this` across creation and
resume; the object-literal receiver recognizer currently excludes this
generator declaration form.

## Direction

Reduce the method shape independently. First preserve only known native
generator-state refs through the standalone callable-property result bridge,
without generalizing unrelated ref-to-extern conversions. Then model the
receiver at generator creation and make it available on resume with the
correct lazy timing. Keep ordinary property-call return handling and #3591's
late-filled opaque resume ladder unchanged unless the reduced trace proves a
shared boundary.

## Acceptance criteria

- A focused standalone regression proves `{ g: g }.g().next()` observes the
  object receiver, including a timing-sensitive `this` probe.
- The exact Test262 context-method-invocation row passes through the isolated
  standalone runner.
- Native generator direct calls, #3591's forced pass-2 opaque resume fixture,
  and host-lane property-call behavior remain unchanged.

## Handoff evidence

On #3591's final diagnostic rerun, this was the third of three residuals in an
otherwise **4/7 pass** list. It is tracked separately because repairing the
state transport alone cannot satisfy the deferred dynamic-`this` semantics.
