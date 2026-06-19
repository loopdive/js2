---
id: 2202
title: "arguments.length wrong for trailing-comma + spread call args in generator / class-method bodies (~30 test262 fails)"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
related: [1726]
test262_bucket: arguments-trailing-comma-spread
test262_count: 30
es_edition: es2017
origin: "2026-06-19 sprint-64 standalone failure mining: language/arguments-object/*gen-meth*-args-trailing-comma-spread* fail `arguments.length`. Distinct from #1726 (mapped-arguments representation) — this is arg-count miscounting for spread+trailing-comma specifically in generator/class-method call sites."
---

# #2202 — `arguments.length` wrong for trailing-comma + spread in generator / class-method bodies

## Problem

A call argument list with **spread + a trailing comma** — `f(...args,)` — must
produce the same `arguments.length` as `f(...args)` (the trailing comma is pure
grammar; §13.3.8 ArgumentListEvaluation ignores it). The compiler computes the
wrong `arguments.length` for this form **specifically inside generator methods /
class generator methods** (the call site is a `gen-meth` / `cls-*-gen-meth`
body), where the arguments object and the spread-expansion counting interact
with the generator-body lowering.

`#1726` already fixed the plain trailing-comma and `arguments.length` clusters
and owns the **mapped-arguments exotic-object representation** (§10.4.4
descriptors). This issue is a **distinct, narrower bug**: the spread +
trailing-comma argument *count* in generator/method contexts, not the
descriptor/mapped representation. Confirm against #1726 to avoid overlap; if the
fix turns out to live in the shared arguments-materialization path, coordinate.

## Spec

- §13.3.8 ArgumentListEvaluation (trailing comma / spread):
  https://tc39.es/ecma262/#sec-argument-lists-runtime-semantics-argumentlistevaluation
- §10.4.4 Arguments Exotic Objects:
  https://tc39.es/ecma262/#sec-arguments-exotic-objects

## Minimal repro

```js
// A generator method whose body reads arguments.length, called with
// spread + trailing comma. Expected arguments.length === args.length.
var log;
var obj = {
  *m() {
    log = arguments.length;   // must equal 3 for the call below
    yield;
  }
};
var args = [1, 2, 3];
obj.m(...args,).next();        // spread of 3 + trailing comma ⇒ length 3
// assert log === 3
```

Compare against the non-generator form (which passes today):

```js
var obj2 = { m() { return arguments.length; } };
obj2.m(...[1,2,3],);   // === 3  (works)
```

## Failing test262 cluster

`test/language/arguments-object/*` where the body is a generator/class generator
method and the call uses trailing-comma + spread — **~30** fails. Assertion:
`assert.sameValue(arguments.length, N)`. Representative files:

- `language/arguments-object/gen-meth-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-expr-gen-meth-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-decl-gen-meth-static-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-spread-operator.js`
  (async-gen variants are deferred if they need the async-gen state machine —
  scope to sync generators first; carry async-gen variants as a follow-on note.)

## Approach (sketch — dev to confirm against codegen)

Trace how `arguments.length` is materialized for a generator-method body and how
a spread call argument with a trailing comma is counted at the call site. The
trailing comma should add **zero** to the count; the suspicion is an off-by-one
(trailing comma counted as an extra slot) or a spread-length-vs-fixed-arg
miscount that only surfaces in the generator-body arguments path. Fix the count;
do not touch the mapped-arguments descriptor representation (that is #1726).

## Acceptance criteria

- [ ] Repro: generator method reads `arguments.length === 3` for
      `obj.m(...[1,2,3],).next()`.
- [ ] Sync-generator + sync class-generator-method trailing-comma+spread tests
      flip to pass (`>= 20` of the ~30 sync variants).
- [ ] No regression in non-generator `arguments.length` / spread-call counting,
      and no regression in #1726's mapped-arguments tests.
- [ ] A focused `tests/issue-2202-*.test.ts` covering object-literal generator
      method, class generator method, and static class generator method.
