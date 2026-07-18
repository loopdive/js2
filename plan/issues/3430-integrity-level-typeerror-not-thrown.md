---
id: 3430
title: "Host conformance: integrity-level operations do not throw expected TypeError (1,316 records, newly honest under oracle v8)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen, builtins
language_feature: object-integrity, property-descriptors
es_edition: multi
goal: test262-conformance
related: [3370, 1629]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host `other` sub-bucket @ oracle 8; likely newly honest (v7 wrapper's stripUndefinedThrowGuards hid these)."
---

# #3430 — Integrity-level operations do not throw expected TypeError

## Problem

1,316 host tests expect a `TypeError` on an integrity-violating operation but no
exception is thrown:

```
Expected a TypeError to be thrown but no exception was thrown at all
```

Samples (non-Temporal):
```
test/built-ins/Array/prototype/map/target-array-non-extensible.js
test/built-ins/Array/prototype/map/target-array-with-non-configurable-property.js
test/built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-3.js
test/built-ins/Array/prototype/map/create-ctor-non-object.js
test/built-ins/Function/15.3.5.4_2-55gs.js
test/built-ins/Function/15.3.5.4_2-37gs.js
```

## Root cause (hypothesis)

Likely **newly honest** under oracle v8 (#3370): the pre-v8 synthetic wrapper's
`stripUndefinedThrowGuards()` removed many throw-expectation checks, so these
passed spuriously. The class is a real conformance gap — we do not throw
`TypeError` for integrity-level violations, spanning several root causes that
should be triaged into sub-buckets before implementation:

- writing to a **non-extensible** / frozen array target (species-created result
  array `[[DefineOwnProperty]]` must throw in strict paths);
- writing over a **non-configurable** property;
- calling a species constructor that returns a **non-object**;
- strict-mode assignment to read-only globals (`*gs.js` Function tests).

Because it is a mix of causes, this issue is a **triage umbrella**: split by the
underlying integrity operation and file/route focused fixes. Related to #1629
(Object.defineProperty descriptor attributes).

## Acceptance criteria

- Sub-bucket the 1,316 records by underlying integrity operation with counts.
- The dominant sub-bucket (non-extensible array define) throws `TypeError` per
  spec; its sample tests pass.
- The `Expected a TypeError to be thrown but no exception` class drops materially
  from 1,316 as sub-fixes land.

## Cross-reference

Newly honest under #3370. Related: #1629 (defineProperty descriptor attributes).
