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

## Implementation Plan (architect, 2026-07-19 — samples reproduced; triage protocol + dominant-bucket fix)

### Repro (confirmed via runTest262File, host lane)

- `built-ins/Array/prototype/map/target-array-non-extensible.js` → fail:
  `Expected a TypeError to be thrown but no exception was thrown at all`
- `built-ins/Function/15.3.5.4_2-55gs.js` → same
- `built-ins/Array/prototype/map/create-ctor-non-object.js` → same (message
  prefixed `null value` — note for sub-bucketing: the species-ctor result
  check is returning null instead of throwing)

### Where integrity state lives today (read first)

The native object runtime ALREADY tracks integrity: the `$Object` struct has a
`preventExtensions` field (field 9, `src/codegen/object-runtime.ts:762-763`,
#1355 Slice D), and the property-write path **silently refuses** new keys on a
sealed/frozen/non-extensible object (`object-runtime.ts:~1669`). That refusal
is the core bug for the strict/throw contexts: per ES2024 §7.3.4
CreateDataPropertyOrThrow and §10.4.2.1 ArraySetLength, a refused define must
THROW TypeError, not no-op. #3403 (per-declaration integrity-map keying) is
adjacent — coordinate if both are in flight.

### Step 1 — sub-bucket the 1,316 (REQUIRED before fixes; acceptance criterion)

Pull the record list from the harvest jsonl and split by path/mechanism:
  a. `Array/prototype/<hof>/target-array-*` — species/`Symbol.species` result
     array is non-extensible / has non-configurable props; the HOF's
     per-element `CreateDataPropertyOrThrow(target, k, v)` must throw.
  b. `Array/prototype/<hof>/create-ctor-*` — ArraySpeciesCreate: ctor
     non-object / `Symbol.species` poisoned → TypeError BEFORE iteration.
  c. `Function/*gs.js` — strict-mode assignment to read-only/global
     accessor-less properties (§13.15.2 PutValue throw-on-failure).
  d. Everything else (defineProperty over non-configurable, frozen writes) —
     route to #1629 or file narrowly.
Record counts per bucket in this issue file.

### Step 2 — fix the dominant bucket (a): refusal → throw

**File: `src/codegen/object-runtime.ts`** (the ~1669 refusal site and its
sibling define/set arms)
- Split the write entry points into `set` (may refuse per receiver-strictness)
  and `defineOrThrow` (CreateDataPropertyOrThrow semantics: refusal → throw
  TypeError). Emit the throw with the existing native TypeError machinery
  (`emitThrowTypeError`, `src/codegen/expressions/helpers.ts` — same pattern as
  the instanceof guards).
**File: `src/codegen/array-methods.ts` / `array-like-hof-arms.ts`**
- Route the HOF result-array element writes (map/filter/slice/splice/from…)
  through `defineOrThrow` when the target came from ArraySpeciesCreate with a
  custom/species constructor (the fast path for the compiler's OWN dense vec
  result can stay — a fresh internal vec is never non-extensible).

### Step 3 — bucket (b): ArraySpeciesCreate validation
In the species-create helper (grep `SpeciesCreate` / `Symbol.species` in
`src/codegen/array-methods.ts`), add the §23.1.3.x checks: species ctor not an
object → TypeError; ctor call result non-object → TypeError (this also
converts the `null value …` message shape into the expected throw).

### Step 4 — bucket (c): strict PutValue
Separate mechanism (strict-mode assignment failure, mostly `*gs.js` global
scripts): likely belongs with the #3367/#3434 strict-sandbox work — file a
focused sub-issue with the count rather than fixing here.

### Edge cases
- Sloppy-mode writes still silently refuse (only throw where the spec's
  Throw flag is true) — don't blanket-throw from `set`.
- `Object.freeze(a); a.push(x)` → TypeError (ArraySetLength) — check the vec
  path honors the integrity field for LENGTH mutation, not just keyed writes.
- Host-boundary objects: a frozen host object crossing into `__extern_set`
  already throws natively — don't double-wrap.

### How to test
- The 3 repro files above via `runTest262File` → pass.
- Scoped: `built-ins/Array/prototype/map/target-array-*`,
  `create-ctor-*`, `reduceRight/15.4.4.22-8-c-3.js`.
- Equivalence guard: existing freeze/seal tests (`Object.freeze` suite) stay
  green; sloppy-mode silent-refusal tests unchanged.
- Standalone: the native `$Object` path is lane-shared — verify one sample with
  `--target standalone` too (no host imports added).
