---
id: 4098
title: "standalone: class instance fields are invisible to getOwnPropertyDescriptor/Object.keys and survive delete — the unanimous blocker of #3976's residual (population 124, blocked on #4010)"
status: in-progress
assignee: ttraenkler/dev-4098-g1
blocked_by: []
sprint: current
created: 2026-08-02
updated: 2026-08-12
# (#4098 G1 stage 1) The three screen call sites live in `object-runtime.ts`
# because that is where the closed-struct ladders they screen are BUILT — a
# screen has to be emitted ahead of the arms it narrows, and those arms return
# unconditionally on a name match. Everything with a choice of home was moved
# OUT: the natives, both screen builders and the delete arm are all in the new
# `src/codegen/instance-tombstones.ts`, and the `__delete_property` tail is
# sourced inside `carrier-bag-delete.ts` rather than passed through the
# god-file. That restructuring took the growth from +34/+9 to +17/+3; the
# residual is 3 ladder call sites + 1 import + 1 reserve, and 2 fill calls +
# 1 import in the finalize driver.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
# (#4098 G1 stage 1) Sibling grant to the above: each function grew by exactly
# ONE line — the irreducible wiring call into instance-tombstones.ts (fill in
# the two finalize drivers, reserve in ensureObjectRuntime). The subsystem
# extraction the R-FUNC gate prescribes was already done (see comment above);
# the +1 IS the call to it.
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/object-runtime.ts::ensureObjectRuntime
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

## UNBLOCKED 2026-08-03 — #4010 is done, but read what it does and does NOT give you

All three #4010 slices landed (S1′ #4058, S2 #4063, S3). Own-property truth for
**array** and **function** receivers now has ONE owner — the per-receiver bag —
that `hasOwnProperty` / `in` / gOPD / `Object.keys` / for-in /
`getOwnPropertyNames` / `propertyIsEnumerable` all read, with real tombstones
behind `delete`.

**A class instance still has NO bag.** It is row 7 of #4010's matrix and
`__carrier_bag_of` answers null for it, so nothing on this issue's 124-file
population moved. What #4010 gives you is not the store — it is the **shape**:

- `src/codegen/carrier-bag-visibility.ts` + `carrier-bag-delete.ts` are the
  worked example of a per-receiver own-property store wired into every
  reflective surface additively, including the tri-state "not handled" answer
  that keeps a bag-blind receiver bit-for-bit unchanged.
- The wiring points are already enumerated and additive, so a per-instance
  store only has to teach `__carrier_bag_of` about instances (plus a `keys`
  ordering decision) rather than re-open seven natives.
- **Take the -684 lesson with you**: it was NOT the query widening. It was a
  *dormant* bag pollution — `__extern_set` accepting a write the read path
  refused — that only became visible once something queried the store. Before
  widening any surface over a NEW store, ask what writes reach it that the read
  path shadows.

Also relevant: `Object.defineProperty` on a non-`$Object` receiver still lands
nowhere for functions, and `verifyProperty` restores via `defineProperty` — so a
per-instance store needs the define arm as well as the delete arm, or the
harness's round trip is one-way.

**Original recommended sequencing** — `blocked_by: [4010]`. Land the unified per-receiver
own-property side table first; then (1)+(2)+(3) here become one coherent slice
against a store that can actually represent a tombstone. Re-run the 124 then;
expect the discount #3976 measured (populations are not flip ceilings).

## Reproducing

`.tmp/m4098b.mjs` (funnel + unanimity + the deciding ratio) and
`.tmp/probe4098{c,e,f}.mts` (static-vs-dynamic 2×2 and the operation map) in the
authoring worktree. The 2×2 is the load-bearing one: **any probe of this area
using a literal property name is measuring the wrong path.**
---

# G1 BASELINE RE-MEASURE, 2026-08-03 (dev-4098-instance-fields)

Re-measured on a base containing `upstream/main` + S3 (`#4091`), **before**
designing. Instrument: host-free standalone probe (`.tmp/m4098.mts` over
`.tmp/probe.mts`), every module asserted **0 imports**, `$Object` control green.
Every key is a **runtime-built variable** (`["f","o","o"].join("")`) — the #4098
2×2 lesson is load-bearing: a literal key measures the STATIC fast path and
reports that everything already works.

## The map has FIVE gaps, not three — two are new

| operation (declared instance field, dynamic name) | today | filing said |
| --- | :---: | --- |
| `hasOwnProperty` | ✓ | ✓ |
| dynamic read `o[k]` | ✓ | ✓ |
| `getOwnPropertyNames` | **✓** | *not stated* |
| `propertyIsEnumerable` | **✓** | *not stated* |
| `getOwnPropertyDescriptor` | ✗ undefined | ✗ |
| `Object.keys` / for-in | ✗ | ✗ |
| `delete` | ✗ no-op | ✗ |
| **dynamic write `o[k] = v`** | **✗ DOES NOT LAND** | *not stated* |
| **`defineProperty` over a declared field** | **✗ silent no-op** | *not stated* |

Two findings the next reader must not have to re-derive:

1. **`getOwnPropertyNames` already includes the field, `Object.keys` does not.**
   The enumeration surface is **not** uniformly missing — `fillClosedStructOwnPropertyNamesArms`
   wires `__getOwnPropertyNames` only, and #4071 *deliberately* refused to share
   those arms with `__object_keys`. So this issue's keys half is a **separate
   arm behind a screen**, not an extension of an existing one.
2. **The dynamic WRITE does not land.** `__extern_set` has no closed-struct
   field arm, so `o[k] = v` on a declared field is silently dropped.
   `propertyHelper.js`'s `isWritable` therefore fails on its own, independently
   of gOPD/keys/delete. This was invisible to the original mechanism map because
   that map only probed read-side operations.

**`delete` is non-vacuous here** (the #4010 vacuity trap): after `delete o[k]`
BOTH derivations still say present — `hasOwnProperty` is `true` *and* the value
reads back. The failure is real, not an artifact of an absent predicate.

⚠ **One probe in the matrix is VACUOUSLY GREEN and must not be trusted alone**:
"delete THEN `defineProperty` restore" reports success only because the `delete`
never happened, so nothing needed restoring. It is gated on the `delete` cells
being fixed first; read it only together with them.

## Why the slice cannot be narrowed by SURFACE — only by RECEIVER

`verifyProperty` is **all-or-nothing**: it checks the descriptor, then
enumerability, then writability, then configurability, and 100 % of the 124
assert `writable` AND `configurable`. Any subset of the five gaps therefore
flips **zero** files. And #4010's ordering law forbids the tempting partial —
gOPD + keys without a real `delete` is exactly the −684 shape, reproduced on
this issue's own stratum.

So the slice boundary is the **receiver**, not the surface: user-declared class
instances only, with all five gaps closed for them.

## Unlock — the user-declared-vs-builtin struct predicate DOES exist

#4071 reverted a −5 (letting closed-struct fields into `Object.keys` made
`Object.keys(new Date(0))` answer `["timestamp"]` and `Object.keys(/ab/)` answer
7 internal RegExp fields) and recorded that fixing it "needs a principled
user-declared-vs-builtin struct predicate, which does not exist yet".

**It exists: `ctx.classDeclarationMap`** (`context/types.ts`), written *only* by
`collectClassDeclaration` (`class-bodies.ts:609`) and keyed by class name — the
same key space as `ctx.structFields`. A struct name in that map came from a
user-source `class` declaration or class expression; builtin carriers (Date,
RegExp, Error) are never in it. That is a **structural** screen, not a name-shape
heuristic — which is the exact property #4086 records `startsWith("__")` as
failing to have.

Available as substrate to **#4071** (its deferred `Object.keys` re-share) and
**#4086** (builtin-carrier screening). Pointer only — neither arm is built here.

## Build order — each prefix independently shippable and non-negative

1. per-instance tombstone store + real `delete` — substrate, ~0 flips, NOT negative
2. `__extern_set` closed-struct field write arm
3. `getOwnPropertyDescriptor` arm ⎫ only on top of (1), per the ordering law
4. `Object.keys` / for-in via `classDeclarationMap` ⎭

Stages 3–4 must never ship without 1. A completed prefix ships with a handoff
rather than stretching across a budget freeze (the S1′/S2 precedent: substrate
with 0 flips and 0 regressions is a success, not a failure).

## Reproducing

`.tmp/m4098.mts` (+ `.tmp/probe.mts`, copied from the S3 author's worktree).
Re-run the **whole** matrix at every stage boundary: it doubles as the control
set that catches a stage silently breaking an arm an earlier stage fixed.

---

# G1 HANDOFF — substrate map, design, and the budget call (2026-08-03, dev-4098-instance-fields)

**Nothing was built.** The window hit 14 % remaining with a 2 % per-agent share
(`budget-status`: "pull a task ≤ horizon S") against an issue that the
re-measure above proves is an **L**. Per the stage-boundary rule, a stage is not
started that cannot finish, so this hands over a *measured* design rather than a
half-built one. The measurement above and the substrate map below are the
deliverable; the successor should not need to re-derive either.

**Branch**: `issue-4098-g1` (pushed to `fork`), stacked on the durable
`fork/issue-4010-s3-visibility` because S3 had not landed. If S3 is on `main`
when you read this, branch fresh from `upstream/main` instead and ignore the
stack.

## THE SUBSTRATE IS ALREADY GENERIC — this is the main finding

The #3468 carrier-bag side table is **keyed by `eqref` identity, not by closure
type**. In `fillClosurePropHelpers` (`closure-props.ts`):

- the store is a linked list in one global of
  `$ClosurePropEntry { next, key: eqref, bag: externref }`;
- `narrowRecvToEq` is `local.get 0; any.convert_extern; ref.cast eqref`;
- the walk matches with `ref.eq`.

A class instance is a WasmGC struct, therefore an `eqref`. **`__closure_bag_lookup`
/ `__closure_bag_ensure` would work on an instance today, unchanged.** The only
thing keeping instances out is the *predicate* `__is_closure_prop_carrier` (a
`ref.test` chain over closure base-wrapper types) and the fact that nothing ever
calls `ensure` for an instance.

So this issue does **not** need a new side table. It needs a new *predicate* and
the arms that consult it.

### Why widening `__carrier_bag_of` is INERT on its own — and when it stops being

`__carrier_bag_of` (`carrier-bag-visibility.ts`) is two arms, closure and vec.
Adding a third instance arm changes **nothing** today, because no write path
deposits anything in an instance's bag (`__closure_prop_set` is itself gated on
`__is_closure_prop_carrier`). That inertness is exactly what makes it safe to add
*first* — and exactly why it must **not** be shipped alone: #4055 and #4010 both
record "written, measured unreachable, removed rather than shipped as
decoration" as the standing discipline here.

It stops being inert the moment stage 2 lands. **That is the point at which the
−684 question must be re-asked** — S3's handoff phrases it correctly: *before
widening any surface over a new store, ask what writes reach it that the read
path shadows.* For instances the specific question is whether an `__extern_set`
arm can deposit a key that the closed-struct read arm then shadows.

## The four stages, with their exact sites

| # | stage | site | safe alone? |
| --- | --- | --- | --- |
| 1 | per-instance tombstone + real `delete` | `__carrier_bag_delete` (S2) + a tombstone screen **ahead of** the closed-struct hasOwn prologue | yes — substrate, ~0 flips |
| 2 | write-through | `__extern_set` closed-struct field arm | yes, with 1 |
| 3 | `getOwnPropertyDescriptor` | new closed-struct gOPD arm, synthesising `{value, w:t, e:t, c:t}` | **only on top of 1** |
| 4 | `Object.keys` / for-in | `__object_keys` / `__object_keys_forin`, screened by `classDeclarationMap` | **only on top of 1** |

Stages 3–4 without 1 reproduce the −684 shape on this issue's own stratum. That
is the #4010 ordering law and it is a receipt, not a preference.

### Stage 1's non-obvious hazard — ordering inside `__hasOwnProperty`

`fillClosedStructHasOwnArms` (`object-runtime.ts:6387`) unshifts a prologue that,
on a field-name match, **returns unconditionally**. A tombstone written by
`delete` is therefore invisible to it: `hasOwnProperty` would keep answering
`true` after a successful delete, and `propertyHelper`'s `isConfigurable`
(`delete` then require `hasOwnProperty` false) would still fail. **The tombstone
screen must run BEFORE that prologue**, not after it. This is the same
short-circuit shape #4010 documented for `fillVecHasOwnHelpers` making the array
`hasOwn` cell read ABSENT.

Note the direction: stage 1 makes `hasOwn` answer **false** where it said
**true** — a narrowing, and only after an explicit `delete` that is a broken
no-op today. It is not the −684 widening.

### Stage 4's screen — the predicate exists, use it

`ctx.classDeclarationMap` (see the re-measure section above) is the
user-declared-class predicate. `Object.keys` must **not** reuse
`fillClosedStructOwnPropertyNamesArms`'s entry set: that set is every
non-synthetic `ctx.structFields` entry, which includes builtin carriers, and is
what made #4071 measure −5 (`Object.keys(new Date(0))` → `["timestamp"]`).
Screen on `classDeclarationMap.has(structName)` and the builtin carriers drop out
structurally.

`getOwnPropertyNames` already includes the fields, so **stage 4 is `Object.keys`
and for-in only** — do not touch the gOPN arms.

### Private fields already behave

`#p` is stored as a `__priv_`-prefixed struct field and both existing arms skip
`field.name.startsWith("__")`, so the acceptance criterion ("private fields stay
absent, including the `__priv_` mangled spelling") is **already satisfied** and
is covered by probe V3. Any new arm must copy that filter rather than assume it.

## Known divergence the design accepts (state it in the PR)

Values live in the struct field; the bag carries tombstones and non-declared
keys. A **statically typed** read (`o.foo` where `o: C`) compiles to `struct.get`
and cannot consult a tombstone without a cost on every field read. So after
`delete o.foo` a static read still sees the old value while the dynamic path
correctly says `undefined`.

This is reachable only through `any` (TypeScript rejects `delete o.foo` on a
non-optional declared field), and the test262 population is entirely dynamic. It
is a deliberate, bounded trade — but it is a *new* two-derivation disagreement in
a codebase where #4065/#4010 record that class of bug, so it belongs in the PR
description, not just here.

## Measurement lane — what works locally, and what does not

`runTest262File` links no `js2wasm:runtime-eval` provider, so standalone
test262 files die at instantiate locally. **The workaround that does work** is
the S3 author's harness, copied to `.tmp/probe.mts`: compile a small module with
`target: "standalone"`, assert `WebAssembly.Module.imports(mod).length === 0`
(host-free), instantiate with `{}`, call an exported `test()` returning a
discriminating integer. Every cell is its own module so one failure cannot mask
another. `.tmp/m4098.mts` is the full 20-cell matrix for this issue.

Two instrument rules that already bit this issue:

- **Never use a literal property name.** A literal measures the static fast path
  and reports that everything works. Build the key at runtime.
- **Read the `delete` cells together, never alone.** The "delete then restore"
  cell is vacuously green while `delete` is a no-op.

## Before it goes near the queue

Run the whole `built-ins/**/{name,length}.js` stratum (~700 files) explicitly.
That is the population every earlier sample was disjoint from and the one that
produced the −684; #4010 makes it a mandatory pre-merge control and S3's own
record shows it passing 729/729. It does not get to be a surprise twice.

## Adjacent, deliberately not chased

- **#4136** — `defineProperty` writing null values / wrong `writable`.
- **#4061** — descriptor argument validation. Its owner supplied a reduced repro
  (defineProperty over an *inherited* property on a carrier-less receiver is a
  silent no-op, 14 goal-scope files, plus 42 `SITE-PROPS-BAG-NOT-AUTHORITATIVE` +
  10 `SITE-O-NO-CARRIER` rows). That is the write-path half of stage 2 and those
  files are plausibly free flips **if** stage 2's define arm falls out naturally;
  if it does not, leave them to the split-out issue rather than widening stage 2.
  ⚠ Probe VI1 in `.tmp/m4098.mts` attempts that repro and reports it **already
  correct** — but it uses `function Ctor(){}` + `Ctor.prototype = proto`, which
  very likely yields an `$Object` receiver rather than a closed struct, so the
  probe is **not** measuring a carrier-less receiver. Treat VI1 as an unvalidated
  instrument, not as evidence the repro is fixed.

---

# G1 STAGE 1 — LANDED: per-instance deletability (2026-08-04, dev-4098-g1)

**Shipped prefix, not the whole issue.** Stage 1 of the four in the handoff
above. Budget went 12 % → 9 % with a 1 %-of-window per-agent share against an
**L**; per the stage-boundary rule a stage that cannot finish is not started, so
stages 2–4 are handed on. `status` stays `in-progress`.

## What landed

New module `src/codegen/instance-tombstones.ts` (natives, both screen builders,
the delete arm) + four wiring points. `delete o[k]` on a user-declared class
instance is now **real**: it was a silent no-op, and `propertyHelper.js`'s
`isConfigurable` is `delete obj[name]` then `return !__hasOwnProperty(obj,
name)`, which 100 % of the 124 assert.

**The tombstone is a SELF-REFERENTIAL bag entry — `bag[k] === bag`.** The
handoff's substrate finding held exactly: the #3468 carrier bag is keyed by
`eqref` **identity**, so `__closure_bag_lookup`/`_ensure` work on an instance
unchanged; this is a predicate plus arms, not a new side table. The marker is
*not* a real `FLAG_TOMBSTONE`, and that is deliberate:

- **a real tombstone is undetectable.** `__obj_find`, `__obj_ordered` **and**
  `__obj_ordered_all` all skip `FLAG_TOMBSTONE`, so "deleted" would be
  indistinguishable from "never present" — the screens could not read it without
  a new tombstone-piercing native inside `object-runtime.ts` (its
  `emitClassifyKey`/`emitKeyMatch` are function-local closures, so the native
  cannot live anywhere else);
- **identity is unforgeable** — the bag is unreachable from user source, so no
  program can synthesise a value `ref.eq` to it;
- it costs **no allocation and no global**.

⚠ **Stage 3/4 MUST filter `bag[k] === bag` when they add the instance arm to
`__carrier_bag_of`,** or the marker enumerates as a real own property. It is
unobservable today only because no instance arm exists yet.

## Probe matrix — before → after (`.tmp/m4098.mts`, host-free, 0 imports)

Every key runtime-built; a literal key measures the static fast path.

| cell | before | after |
| --- | :---: | :---: |
| II1 delete then `hasOwn === false` | 2 | **1** |
| II2 delete then value also gone | 2 | **1** |
| II3 delete then every surface absent | 2 | **1** |
| II6 delete on one instance only | 2 | **1** |
| V12 subclass declared-field delete | 2 | **1** |
| III3 delete → `defineProperty` restore | 1 | **2** |
| I3 gOPD · I4 keys · I5 for-in | 2 | 2 (stages 3–4) |
| III1 write · III2 define · II7 resurrect · IV1 | 2 | 2 (stage 2) |

**III3's 1 → 2 is the vacuous cell unmasking, not a regression.** The handoff
flagged it: it was green only because the `delete` never happened, so nothing
needed restoring. It is now honestly red and gated on stage 2/3.

Controls all hold: `$Object` (V5), `$Object` delete (V6), array delete + length
(V7), closure carrier bag (V8), `Object.keys(new Date(0))` and `Object.keys(/ab/)`
still `[]` (V1/V2 — the #4071 −5 guard), private `#f` absent in both spellings
(V3), methods not own properties (V4), subclass reads (V11).

## ⛔ THE MANDATORY STRATUM CONTROL WAS **NOT** RUN — the instrument is blind

Stating this plainly because the handoff makes it a pre-queue gate and it is
**not satisfied**.

Built the at-risk set exactly as #4010 M2 specifies — `built-ins/**/{name,length}.js`
is **1,240** files, **728** of them `pass` in the standalone baseline
(`/workspace/.test262-cache/test262-standalone-current.jsonl`, mtime
2026-08-03T19:46Z, **4.6 h old**; a `--force` refetch printed a path it did not
create and emitted **zero** freshness output, so it is not claimed as fresh).

Then ran the **positive control first**: 36 of those 728 baseline-`pass` files
through `.tmp/sweep-one.mts` (`runTest262File`, per-file process).

**Result: 0/36 agreement — all 36 read `compile_error`.** That is #4147
reproduced with a measurement rather than asserted: `runTest262File` links no
`js2wasm:runtime-eval` provider. The S3 lane's repair (neutralising
`$262.evalScript`'s `eval` in a local `scripts/test262-fyi-runtime.js`) is **not
recoverable** — that worktree's copy is now byte-identical to `main`'s. At 391 s
per 36 files the full 728 is ~2.2 h, which neither fits the budget nor is worth
spending on a blind instrument.

**So no number is reported for that stratum.** What exists instead is an
*argument*, labelled as one:

- no visibility widening (`__carrier_bag_of` gets **no** instance arm), and no
  write path — the two ingredients of the −684;
- the delete arm runs strictly **after** `__builtinfn_delete` and
  `__carrier_bag_delete`, and both it and the screens are gated on
  `__is_class_instance_carrier`, which `ref.test`s user-class struct types only.
  A builtin function receiver answers 0, so the fall-through is the historical
  `return 1`, unchanged;
- when a module declares no class at all, `fillInstanceTombstones` returns early
  and every native stays at its `i32.const 0` placeholder.

An argument is not a measurement. **The `merge_group` re-validation is the
backstop that actually arbitrates this**, and this is exactly the class of
failure `auto-park` exists for. Escalated to the tech lead rather than quietly
skipped.

## Two gaps found that the handoff's five-gap map does not list

Both pre-existing on `main` (present in the before-arm), neither touched here:

- **`k in o` is FALSE for a declared instance field with a dynamic key**, while
  `hasOwnProperty(o, k)` is true (cell V10). A sixth gap, and an
  internal inconsistency between two surfaces that must agree.
- **`C[k]` with a dynamic key does not read a `static` field** (cell V9).

Worth their own issue ids; not filed here to avoid burning a reservation on a
lane that is standing down.

---

## Native Error `$props` slice, 2026-08-12

The residual Object/property census exposed a separate, bounded #4098-shaped
carrier gap: native Error-family instances already had a nullable
`$Error_struct.$props` field, but assignment, define, reflection, enumeration
and delete did not agree that it was the Error instance's ordinary-own-property
store.

The fix makes that existing field authoritative across the shared standalone
runtime MOP:

- assignment and reads route through Error-specific get/set helpers;
- `Object.defineProperty` and `Object.defineProperties` substitute the same bag
  into the existing `$Object` descriptor engine;
- `hasOwnProperty`, `Object.hasOwn`, `in`, gOPD, keys, names and for-in see the
  bag through `__carrier_bag_of`;
- delete delegates to the existing ordinary `$Object` delete implementation;
- accessors are invoked with the original Error receiver, not the hidden bag,
  so `this === err` remains true;
- object-integrity operations resolve the same bag, so
  `Object.preventExtensions(err)` blocks later named and indexed expandos;
- the multi-source finalizer fills both the shared helpers and the Error read
  splice, keeping `compileMulti` write/read behavior aligned with `compile`;
- only bag entries are visible. Native struct fields such as `tag`,
  `userClassId` and `props` are not fabricated as JavaScript keys.

### Exact same-SHA A/B

Both runs used standalone, official scope, and base SHA
`803ab26e36c2dea1ae617614ff60ecdec714acf3`.

| slice | before | after | delta |
| --- | ---: | ---: | ---: |
| ES5 `Object/{create,defineProperty,defineProperties}` failures containing a native Error-family instance | 0 / 23 | **23 / 23** | **+23, -0** |
| broader Error-family control population in those directories | — | **43 / 43** | no observed regression |
| Error `Object.preventExtensions` controls (`15.2.3.10-3-{10,20}`) | 2 / 2 | **2 / 2** | **0, preserved** |

The focused regression suite also proves stored-null presence, coherent
define/read/descriptor/enumerate/delete behavior, Error-as-descriptor and
Error-as-`Properties` operation, receiver-correct getters/setters, and absence
of leaked native internals.

### IR boundary

This is shared runtime ABI, not a second AST-only property model. A prepared
dynamic member read emits IR (`irBodyEmitted: true`, `stage: patch`) and reaches
`__dyn_member_get -> __extern_get ->` the Error bag MOP. Some surrounding
dynamic assignment/reflection source shapes remain selector-rejected and retain
the existing legacy compile-twice fallback; this slice does not claim those
frontend selectors are complete.

### Bounded scope

This slice covers native Error-family instances only. Date, RegExp, Arguments
and other closed carriers have distinct representations and remain separate
work. It does not claim the broader class-instance population in #4098 is
complete.

Two Error-adjacent residuals remain explicit and are not claimed here:

- `propertyIsEnumerable` still has a separate non-`$Object` dispatch path that
  does not consult the Error bag;
- strict-mode assignment to a non-writable Error property is refused, but the
  current non-`$Object` strict-set path cannot surface the required throw.
