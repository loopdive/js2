---
id: 4098
title: "standalone: class instance fields are invisible to getOwnPropertyDescriptor/Object.keys and survive delete — the unanimous blocker of #3976's residual (population 124, blocked on #4010)"
status: blocked
blocked_by: [4010]
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES6
language_feature: class-elements
goal: standalone
horizon: l
parent: 2860
related: [3976, 2860, 3571]
origin: "measured as the sole residual bucket of #3976 slice 1 (senior-dev-3976-class-elements, 2026-08-02)"
---

# standalone: class instance fields are not own properties of the instance

#3976 slice 1 made `C.prototype` a real `$Object` and flipped **479 of the 539**
`C.prototype`-receiver files. **All 60 residuals are ONE bucket, unanimous:**

```
Test262Error: foo descriptor value should be foobar; foo descriptor should be enumerable; …
```

i.e. a class *instance field*

```js
class C { foo = "foobar"; m() { return 42; } }
verifyProperty(new C(), "foo", { value: "foobar", enumerable: true, writable: true, configurable: true });
```

is not an own property of the **instance**. Per §15.7.14 / DefineField, a public
instance field is installed on the instance with
`{writable: true, enumerable: TRUE, configurable: true}` — note `enumerable:
true`, the opposite of a method, so this needs `Object.keys` / for-in to *include*
it.

## Population — measured, with denominators

- **60** = the entire residual of #3976's full 539-file `C.prototype` run
  (`479/539` pass after slice 1; 60 fail, 100 % in this bucket).
- **276** = the census's `receiver = c` bucket in #3976 (instance fields on an
  instance), from the 1,136-file `should have an own property` family.

These overlap: a file can verify both a prototype method and an instance field.
**Do not add 60 + 276.** Re-derive the union before sizing — the #3976 census
harness (`plan/probes/3976/census.mjs`) plus `.tmp/classify.mjs`-style static
classification is the instrument, and `census.mjs` refuses to be trusted unless
it reproduces the published standalone baseline.

## Why this is NOT a repeat of #3976's shape

#3976's receiver was a **singleton** (`__proto_<C>`, one per class, lazily
materialized in a module global), which is what made "build it as an `$Object`
once" viable. An **instance** is not a singleton: it is a `$ClassName` WasmGC
struct allocated per `new C()`, with the fields as real typed struct fields. You
cannot replace instances with `$Object` without giving up the typed-field
representation that the whole class lowering depends on.

So the mechanism must be different. Two candidate shapes, neither yet measured:

1. **Closed-struct reflective arms.** `fillClosedStructHasOwnArms`
   (`object-runtime.ts` ~6247), `fillClosedStructFieldArms` (~6558) and
   `fillClosedStructOwnPropertyNamesArms` (~6432) ALREADY answer
   `hasOwnProperty` / dynamic get / `getOwnPropertyNames` for class structs by
   `ref.test $ClassName` + `struct.get`. What is missing is
   `getOwnPropertyDescriptor` (with `enumerable: true` for fields), the
   `Object.keys`/for-in enumerable half, and — the hard part, exactly as in
   #3976 — **write-through and delete**, which `verifyProperty` probes by
   mutating. A struct field can be written; `delete` cannot remove it.
2. **A per-instance overlay bag**, like the closure carrier bag
   (`carrier-bag-hasown.ts`, `__closure_bag_lookup`), recording deletions as
   tombstones and shadowing writes.

**Read #3976's measurement before scoping this**: 100 % of that population
asserted `writable` AND `configurable`, so a presence-and-descriptor-only fix
flipped zero. Verify the same ratio here **before** committing to a slice — it is
the step that decides whether the delete path is optional.

## Acceptance criteria

- `Object.getOwnPropertyDescriptor(new C(), "foo")` returns
  `{value, writable: true, enumerable: true, configurable: true}` for a public
  instance field.
- `Object.keys(new C())` and `for…in` **include** `foo` (fields are enumerable —
  unlike methods).
- Private fields (`#f`) stay absent from the own-property surface, including the
  `__priv_` mangled spelling.
- Report measured fail→pass **and** pass→fail with denominators, plus a
  regression control drawn from the standalone-passing class population, with any
  apparent regression re-run **solo** before it is believed.

## Blocker to check first

`for…in` / `Object.keys` correctness here is entangled with **#4099**:
`__object_keys` and `__object_keys_forin` currently ignore `FLAG_ENUMERABLE`
entirely. Since fields are the enumerable case, this issue may need #4099 landed
first to be verifiable at all.

---

# Re-measurement + mechanism map, 2026-08-02 (dev-lever3)

Measured before designing, per the issue's own instruction. **The population and
the unanimity claim hold. The title's framing does not, and the deciding
measurement came back the expensive way — so this is ESCALATED, not built.**

## Provenance

standalone + host baselines `baseline_sha 6660c1158`, generated
2026-08-02T19:39:50Z, `oracle_version 12` — 43,505 / 43,484 official rows,
**0 corpus files unopenable** (floored). The baseline **includes #3976 slice 1**
(`be6cceef6`, merged 14:19Z, verified by ancestry), so the residual is directly
measurable rather than inferred.

The #3976 harness's pinned calibration (43,106 / 25,460) **no longer matches** —
by design, the baseline moved. Current standalone official is 43,505 / 26,719
(61.4 %). Anyone re-running `plan/probes/3976/census.mjs` must re-pin it, and
must point `CACHE` at a *fresh* cache: its hard-coded `/workspace/.test262-cache`
was 19 h stale at the time of writing.

## Funnel, with denominators at every stage

Reproducing #3976's filter chain exactly (its stage figures in brackets):

| stage | files |
| --- | ---: |
| standalone official rows | 43,505 |
| fail standalone **AND** pass host | 5,503 |
| …include `propertyHelper.js` | **1,285** [#3976: 1,810] |
| …own-property + descriptor error buckets | **170** [#3976: 1,136 pre-slice-1] |
| …class area | **124** [#3976: 826] |

The large shrink from #3976's figures is expected and healthy: slice 1 landed and
the own-property bucket drained. Bucket split of the 1,285: 965 other, 170
descriptor-mismatch, 144 host-import-leak, 6 receiver-nullish/crash.

## The two claims in the filing — both confirmed

**Unanimity: CONFIRMED, exactly.** The `C.prototype` residual is **60**, and all
**60/60** carry the one signature
`Test262Error: foo descriptor value should be foobar; foo descriptor should be
enumerable; …`. No second bucket.

**"Do not add 60 + 276": stronger than stated.** They do not merely overlap —
**the 60 is a strict SUBSET of the instance population.**

| | files |
| --- | ---: |
| instance-receiver population (today) | **124** |
| `C.prototype` residual (the 60) | 60 |
| **union** | **124** |
| overlap | **60** |

So the number to size this work by is **124**, not 60, not 276, not 336 — and
fixing instance fields **subsumes #3976's entire residual**. (The filing's 276
was the pre-slice-1 census figure; today's equivalent is 124.)

## THE DECIDING MEASUREMENT — it came back the expensive way

The filing said to check the writable/configurable ratio **before** committing to
a slice, because #3976 found 100 % and a presence-only fix therefore flipped
zero. Re-derived on this population, descriptor literal readable in **124/124**
(floored):

| asserted attribute | files | share |
| --- | ---: | ---: |
| `writable` | 124 | **100.0 %** |
| `configurable` | 124 | **100.0 %** |
| `enumerable` | 124 | **100.0 %** |
| `writable` **AND** `configurable` | 124 | **100.0 %** |

**Identical to #3976. A presence-and-descriptor-only fix flips ZERO of 124.**
The delete path is **not optional**.

Why `configurable` is the load-bearing one, read from the harness rather than
assumed — `propertyHelper.js:138` `isConfigurable` does:

```js
try { delete obj[name]; } catch (e) { … }
return !__hasOwnProperty(obj, name);
```

a **real `delete`**, and then requires `hasOwnProperty` to become **false**.

## Mechanism map — measured, and it corrects the title

⚠ **First probe was WRONG and the way it was wrong is the point.** A hand-written
probe using a **literal** property name reported that everything already works
except `delete`. That measured the **static fast path**. `verifyProperty` receives
the name as an **argument**, so the corpus takes the **dynamic-name** path. Two
variables (instance scope, literal-vs-variable name) were isolated 2×2; **only the
name matters**:

| | name = LITERAL | name = VARIABLE |
| --- | --- | --- |
| instance in-function | gOPD **present** | gOPD **undefined** |
| instance module-level | gOPD **present** | gOPD **undefined** |

Dynamic-name behaviour for a public instance field, standalone, **host-free (0
imports)**:

| operation | standalone | spec |
| --- | :---: | :---: |
| `hasOwnProperty(o, name)` | **✓** | ✓ |
| dynamic read `o[name]` | **✓** | ✓ |
| `getOwnPropertyDescriptor(o, name)` | **✗ undefined** | ✓ |
| `Object.keys(o)` includes it | **✗** | ✓ |
| `delete o[name]` removes it | **✗** | ✓ |

**So the title is imprecise: instance fields ARE already own properties for
`hasOwnProperty` and for dynamic reads.** The closed-struct arms the filing
names (`fillClosedStructHasOwnArms`, `fillClosedStructFieldArms`) are working.
Three specific things are missing, which is the filing's candidate 1 confirmed
and pinned:

1. **no `getOwnPropertyDescriptor` arm** — this is why the error reports *all
   four* attributes wrong: the descriptor is `undefined`, not wrong-valued;
2. **`Object.keys` does not include the field** — note this is the **opposite
   direction** from #4099 (which fails to *exclude* non-enumerables), so
   **#4099's fix alone does not fix this**; the two are adjacent, not the same;
3. **`delete` is a no-op** on a struct field.

## Why this is escalated rather than built

(1) and (2) are tractable additions alongside the existing arms. **(3) is not**:
a WasmGC struct field cannot be removed, so satisfying `configurable: true` —
which **100 % of the 124 assert** — requires a **per-instance own-property store
with tombstones**. That is the filing's candidate 2, and it is precisely the
substrate of **#4010** ("own properties on a non-`$Object` receiver live in TWO
DISJOINT side tables … unify them"), interacting with **#4086**'s closed-struct
arm screening.

Building (1)+(2) alone would be the worst available outcome: **zero flips**, plus
a newly-correct-looking `getOwnPropertyDescriptor` whose `configurable: true` is
a **lie** the very next `delete` disproves. That converts a clean absence into a
confident wrong answer — the same trade this project has already refused twice
this session.

**Recommended sequencing** — `blocked_by: [4010]`. Land the unified per-receiver
own-property side table first; then (1)+(2)+(3) here become one coherent slice
against a store that can actually represent a tombstone. Re-run the 124 then;
expect the discount #3976 measured (populations are not flip ceilings).

## Reproducing

`.tmp/m4098b.mjs` (funnel + unanimity + the deciding ratio) and
`.tmp/probe4098{c,e,f}.mts` (static-vs-dynamic 2×2 and the operation map) in the
authoring worktree. The 2×2 is the load-bearing one: **any probe of this area
using a literal property name is measuring the wrong path.**
