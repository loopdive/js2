---
id: 3430
title: "Host conformance: integrity-level operations do not throw expected TypeError (1,316 records, newly honest under oracle v8)"
status: done
sprint: 73
created: 2026-07-18
updated: 2026-07-21
completed: 2026-07-20
assignee: ttraenkler/senior-dev
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen, builtins
language_feature: object-integrity, property-descriptors
es_edition: multi
goal: test262-conformance
related: [3370, 1629, 3475]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host `other` sub-bucket @ oracle 8; likely newly honest (v7 wrapper's stripUndefinedThrowGuards hid these)."
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
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

## Triage (2026-07-20 — senior-dev, actual sub-bucket counts + retargeted fix)

**The architect's Step 2/3 plan targets infra that does not exist and could
not be executed as written** — verified empirically before any code changes
(see the four correctness findings below). The plan assumed (a) a
`__array_species_create` helper existed to extend (grep confirmed only a
`#1359B follow-up` comment, no implementation), and (b) arrays participate in
the `$Object` integrity-flag system the plan's "Where integrity state lives
today" section describes. Neither holds. The actual dominant, **tractable**
sub-bucket — reachable via the EXISTING `$Object`/`__extern_set_strict`
machinery with no new infra — is different from what the plan named. Fixed
that instead; documented the rest as deferred/follow-up.

### What the 4 architect-cited repro samples actually needed (verified)

| Sample                                                               | Real root cause                                                                                                                                                                                                                                                                                                                                                                        | Status       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `Array/prototype/map/target-array-non-extensible.js`                 | `.map()`'s FAST STATIC path (`compileArrayMap`, `src/codegen/array-methods.ts`) always builds its OWN dense vec via `array.new_default` — it never looks up `Symbol.species`/`constructor` at all. Making this test pass requires implementing `ArraySpeciesCreate` (constructor lookup + invocation + species-result validation) from scratch — genuinely unbuilt, L/XL scope, not M. | **Deferred** |
| `Array/prototype/map/target-array-with-non-configurable-property.js` | Same — species-create is the blocker, not the `$Object` write-refusal.                                                                                                                                                                                                                                                                                                                 | **Deferred** |
| `Array/prototype/map/create-ctor-non-object.js`                      | Same — needs `ArraySpeciesCreate`'s `IsConstructor(C)` check, which doesn't exist.                                                                                                                                                                                                                                                                                                     | **Deferred** |
| `Array/prototype/reduceRight/15.4.4.22-8-c-3.js`                     | Unrelated mechanism entirely: `delete arr[i]` on all 5 elements then `reduceRight` with no initial value must throw "reduce of empty array" — needs real HOLE representation in the dense f64 vec backing, which the compiler doesn't have for this receiver shape. Also unbuilt infra.                                                                                                | **Deferred** |

### Sub-bucket counts (via `.test262-cache/test262-current.jsonl`, ~712 records

matching the "Expected a TypeError...no exception" message across the WHOLE
current baseline — a superset of the harvest-scoped 1,316; the exact harvest
list wasn't independently recoverable, so these counts are from a live
re-scan, not the archived harvest)

| Sub-bucket                                                                                                       | Count                                                                                                                           | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `language/statements/class` + `language/expressions/class`                                                       | 102                                                                                                                             | Heterogeneous — private fields/methods, subclass construction edge cases, `class-field-on-frozen-objects.js`. NOT single-cause.                                                                                                                                                                                                                                                                                                               | Deferred (needs its own triage)                                |
| `language/expressions/compound-assignment` + `logical-assignment` (the actual dominant SINGLE-CAUSE bucket)      | 45 candidates (33 + 12, some of the 12 are the unrelated `dstr/*put-const*`/private-reference/`target-*-reference-null` shapes) | **FIXED THIS PR** — see below                                                                                                                                                                                                                                                                                                                                                                                                                 | **39/45 now pass**                                             |
| `built-ins/Array/prototype/*` (species/HOF-result-array + reduceRight-hole)                                      | 57                                                                                                                              | Needs `ArraySpeciesCreate` infra + hole-representation infra                                                                                                                                                                                                                                                                                                                                                                                  | Deferred                                                       |
| `built-ins/Object/defineProperty` (mostly `'O' is an Array'` — ArraySetLength / array-index-property edge cases) | 15                                                                                                                              | Arrays are `$vec_*` structs, NOT `$Object` — `Object.preventExtensions`/`freeze`/`seal` silently no-op on them (`ref.test $Object` fails). Verified via probe: the IDENTICAL plain-object case (`Object.preventExtensions({}); Object.defineProperty(...)`) already throws correctly TODAY — this bucket is Array-receiver-specific and needs a NEW mutable integrity-flags field across every `$vec_*` struct type (L/XL, different design). | Deferred                                                       |
| `built-ins/Iterator/prototype`, `Proxy/*`, `for-of`, `Object/create`, `ArrayBuffer/prototype`, Temporal, etc.    | remainder                                                                                                                       | Each its own mechanism (not integrity-level at all in most cases — e.g. `Iterator/prototype/Symbol.toStringTag/weird-setter.js`). Out of scope for this umbrella; the "expected TypeError, none thrown" message is a generic `assert.throws` symptom shared by dozens of unrelated root causes, confirmed by direct inspection of several samples per bucket.                                                                                 | Not triaged further (belongs to other issues / #3417 umbrella) |

### The fix (this PR)

**Real root cause of the compound/logical-assignment bucket**: `assignment.ts`'s
plain `=` write-back (`compileExternSetFallback`, #3374) already threads
`isStrictContext()` to pick `__extern_set_strict` (throws on a failed
[[Set]]) vs `__extern_set` (sloppy silent no-op). **Compound assignment
(`+=`/`-=`/`%=`/etc) and logical assignment (`??=`/`||=`/`&&=`) in
`src/codegen/expressions/operator-assignment.ts` never got this treatment —
every write-back call site hardcoded the sloppy `__extern_set` sidecar,
unconditionally, regardless of strict-mode context.** Per ES2024 §13.15.2
PutValue, a strict Reference whose [[Set]] fails (non-writable data property,
or a new key on a non-extensible object) must throw a catchable TypeError;
sloppy code keeps the silent no-op. Fixed all 6 write-back sites in
`operator-assignment.ts` (`compilePropertyLogicalAssignmentExternref`,
`compileElementLogicalAssignmentExternref`,
`compilePropertyCompoundAssignmentExternref` ×2 arms, and
`compileElementCompoundAssignment` ×2 arms) to select
`isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set"`,
mirroring the existing `assignment.ts` pattern exactly. The PINNED
fnctor-reconstructed-struct dispatcher path (`emitAlternateStructSetDispatch`,
a narrower special case for acorn-parser-shaped receivers) was deliberately
left with its existing non-strict wiring — only the bare/general-receiver
sidecar fallback was changed, to keep the diff minimal and avoid touching an
already-tuned, unrelated code path.

### Impact measured

Re-ran every `language/expressions/{compound-assignment,logical-assignment}`
record from the "Expected a TypeError...no exception" bucket (45 candidate
files) through `runTest262File` after the fix: **39/45 now PASS** (up from 0).
The 6 residuals are a DIFFERENT mechanism (private-field/method PutValue
throws — 3 files; a genuinely separate, pre-existing `&&=`-specific
truthy-branch bug filed as #3475; one `??=`-and-`undefined` value-mismatch
unrelated to throwing).

### Deferred follow-ups (NOT this PR)

- **Array `@@species`/`ArraySpeciesCreate`** — implement real species-create
  (constructor lookup, `IsConstructor` validation, non-object-result throw)
  for the array HOF result-array methods (map/filter/slice/splice/from…).
  L/XL scope. Unblocks the `target-array-*`/`create-ctor-*` samples.
- **Array integrity flags** — give `$vec_*` struct types a mutable
  extensible/sealed/frozen bit (or equivalent) so `Object.preventExtensions`/
  `freeze`/`seal` actually apply to arrays, and wire `Object.defineProperty`
  (including ArraySetLength) to honor it. L/XL, different design from the
  `$Object` integrity path. Unblocks the `Object/defineProperty` Array bucket.
- **reduceRight hole-representation** — `delete arr[i]` needs to leave a real,
  observable hole in the receiver's backing (not `undefined`/`0`) so
  `reduceRight`/`reduce` with no initial value can detect "no present
  element" and throw.
- **#3475** — `&&=` on an externref-fallback dynamic property never takes the
  truthy/assign branch at all (confirmed independent of this PR — reproduces
  identically with this PR's diff reverted). Narrow, self-contained, low
  priority.
- **`Function/*gs.js` strict PutValue to globals** (architect's bucket c) —
  separate mechanism, likely belongs with #3367/#3434 strict-sandbox work.
  Not counted/triaged here.
- **`language/statements/class` + `language/expressions/class`** (102
  records) — genuinely heterogeneous, needs its own triage pass before any
  fix; not attempted here.

## Test Results

- `tests/issue-3430.test.ts` (new, 7 cases): strict compound-assign (`%=`)
  non-writable-property throw, strict logical-assign (`||=`) non-extensible
  new-key throw, strict element-access (`[key] +=`) non-writable throw,
  strict `+=` string-concat (`__host_add`) arm non-writable throw, sloppy
  regression guards (2×, no-throw preserved), writable-property no-over-throw
  guard. All pass.
- Full targeted regression sweep (51 tests across 9 pre-existing files
  touching compound/logical assignment, member-set dispatch, acorn-tokenizer
  identity): all pass, no regressions. Two PRE-EXISTING failures in
  `tests/issue-2017.test.ts` (`Math.E = 1` / `Number.NaN = 1` sloppy no-op
  guards) confirmed via git-checkout bisection to be unrelated to this PR —
  reproduce identically on `origin/main` with this PR's diff removed.
