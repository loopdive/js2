---
id: 3976
title: "standalone: class elements are not installed as own properties on the prototype/constructor — invisible to getOwnPropertyDescriptor/hasOwnProperty"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
assignee: ttraenkler/sendev-p3-uncurry
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
related: [3571, 3603, 2742, 3642]
origin: "measured while REFUTING #3571's P3 uncurryThis seam (sendev-p3-uncurry, 2026-08-01)"
---

# standalone: class elements are not installed as own properties

Under `--target standalone`, a class method/accessor is **callable** but is not
an **own property** of the object it belongs to. `C.prototype` and `C` exist and
are inspectable, but

```js
Object.getOwnPropertyDescriptor(C.prototype, "m")   // -> undefined  (should be a descriptor)
Object.prototype.hasOwnProperty.call(C.prototype, "m")  // -> false  (should be true)
```

Per §15.7.14 (ClassElementEvaluation → `MethodDefinitionEvaluation` →
`DefinePropertyOrThrow`) every non-private class element is installed with
`{writable: true, enumerable: false, configurable: true}`. We install something
that dispatches on call but is not reachable through the ordinary
own-property/descriptor surface.

## Why this issue exists — it is the residual of a REFUTED framing

This was found while measuring **#3571's "P3 uncurryThis/propertyHelper seam"**,
which was scheduled as an XL target on the figure *"1,810 standalone-only
failures route through `harness/propertyHelper.js`"*. That figure is a **routing**
bound. Measured causally, the uncurryThis idiom is worth **1.7 %** of it; this
issue is worth roughly **28×** more. Full refutation in #3571. **Do not re-derive
either result by reading — both were measured with controls.**

## Measured population (full census, not a sample)

Source: `.test262-cache/test262-standalone-current.jsonl` and
`test262-current.jsonl`, same baseline run `20260801-010858`.
**Instrument calibrated first**: standalone official rows **43,106 / 25,460 pass
(59.1 %)** — exact match to the published baseline.

Of the **1,810** files that include `propertyHelper.js`, fail standalone and
pass on host:

| n         | bucket                                                  |
| --------- | ------------------------------------------------------- |
| **1,136** | `Test262Error: obj should have an own property X` (63 %) |
| 217       | receiver nullish / non-reified builtin (12 %)           |
| 114       | standalone host-import leak                             |
| 25        | invalid Wasm (`__bindfn_*` — see #3571, separate)       |

Of those 1,136, **826 (73 %) are `language/{statements,expressions}/class`**.
Class areas are **998 of the whole 1,810 (55 %)**.

`verifyProperty` receiver across the class cluster:

| n   | receiver      | meaning                            |
| --- | ------------- | ---------------------------------- |
| 690 | `C.prototype` | instance methods / accessors       |
| 276 | `c`           | instance fields on an instance     |
| 204 | `C`           | static methods / static fields     |
| 192 | `rest`        | object-rest destructuring (adjacent) |

## Root cause, measured — not inferred

Instrument: `runTest262File(abs, cat, 60000, "standalone")` (**status only** is
trustworthy; its error category and source location are artifacts — see
`reference_runtest262file_not_ci_path_status_only`). A **probe arm** patches the
real `test262/harness/propertyHelper.js` to distinguish *where* the failure
originates. This matters because propertyHelper reaches line 48
`__getOwnPropertyDescriptor(obj, name)` **before** line 64's uncurried
`__hasOwnProperty(obj, name)`, and line 27 captures gOPD **directly**, not via
uncurryThis.

Stratified sample, 40 of the 826, seeded; **6 embedded positive controls green
(6/6)**, so the reading is load-bearing:

| n         | origin                                                     |
| --------- | ---------------------------------------------------------- |
| **40/40** | `obj` EXISTS, property genuinely ABSENT (gOPD → `undefined`) |
| 0         | `obj` already nullish at entry                              |

**Unanimous.** The receiver is fine; the property is not installed.

## Ceiling — and read the caveat before quoting it

A second arm makes `verifyProperty` an immediate `return true`, i.e. simulates
*"class elements are installed perfectly with the expected descriptor"*.

- **40/40 of the class sample pass** ⇒ the own-property gap is the **sole**
  blocker in every sampled file (95 % lower bound ≈ 91 %).
- **Discriminator control**: the same arm on the 40-file receiver-nullish sample
  gives **32/40**, not 40/40 — so this arm is **not** trivially green and the
  40/40 above is informative.

⚠️ **This arm is VACUOUS BY CONSTRUCTION and is an UPPER BOUND only.** It also
skips *descriptor correctness* (`writable`/`enumerable`/`configurable`), so an
implementation that installs the property with the **wrong** attributes will
score below this ceiling. Never quote 40/40 as a flip prediction.

## Acceptance criteria

- `Object.getOwnPropertyDescriptor(C.prototype, "m")` returns a descriptor with
  `{writable: true, enumerable: false, configurable: true}` for a non-private
  instance method; likewise on `C` for a static method.
- `Object.prototype.hasOwnProperty.call(C.prototype, "m")` is `true`;
  `Object.keys(C.prototype)` does **not** include `m` (non-enumerable).
- Private elements (`#m`) remain **absent** from the own-property surface —
  several tests in this cluster assert exactly that
  (`!hasOwnProperty.call(C.prototype, "m")` for the private name).
- **Report measured fail→pass / pass→fail on a standalone run with the sample
  above**, plus the ceiling shortfall (how far below 40/40 the real fix lands and
  why). Do not report the ceiling as the result.
- Sizing discipline: **826 is the population GATED, not a forecast.** Measure the
  attributable ratio on a seeded sample with controls before committing to a size
  — that is exactly the step that refuted #3571.

## Reproduction

```js
class C { m() { return 42; } static s() { return 1; } }
// standalone: both are `undefined`; host: both are descriptors
Object.getOwnPropertyDescriptor(C.prototype, "m");
Object.getOwnPropertyDescriptor(C, "s");
```

## Notes

- The **192 `rest`** files (object-rest destructuring skipping non-enumerable
  properties) are in the same census bucket but are a **different** mechanism —
  they need enumerability to be observable, which this issue supplies, but they
  should be verified separately rather than counted as this issue's yield.
- The 217 receiver-nullish files are a **separate** root cause (builtin objects
  such as `Number`/`Date` not reified as values). Tracked in #3571; do not
  double-attribute.

## Fix shape — measured, with the two dead ends that cost the most

Probes: `plan/probes/3976/synt.mts` (syntactic vs dynamic) and `synt2.mts`
(value reachability). Both carry controls that pass on **both** lanes, so the
readings are load-bearing.

### It is NOT a syntactic-reach problem — which is good news

The natural fear (and the exact trap that stopped #3571's P1 shape-matrix wins
from converting) is that a fix in the compile-time path can't see through
`propertyHelper`'s function boundary, where `obj`/`name` are **parameters**. Not
the case here — **even the fully syntactic form already fails**:

| probe                                                | host | standalone |
| ---------------------------------------------------- | ---- | ---------- |
| `gOPD(C.prototype, "m")` — literal receiver + key    | pass | **fail**   |
| `gOPD(o, n)` — via parameters                        | pass | **fail**   |
| `gOPD(C, "s")` — static, literal                     | pass | **fail**   |
| `hasOwnProperty.call(o, n)` — via parameters         | pass | **fail**   |

Both spellings fail, so one representation-level fix serves both. There is no
syntactic/dynamic split to design around.

### Where the host/standalone asymmetry actually lives

`C.prototype` is a **`$ClassName` WasmGC struct** with all fields defaulted,
converted to externref and cached in a lazy global `__proto_<Class>`
(`src/codegen/expressions/extern.ts::emitLazyProtoGet`, registered in
`src/codegen/class-bodies.ts` ~922). The method names ARE collected —
`ctx.classMethodNames` / `ctx.classStaticMethodNames` (`class-bodies.ts`
~1375-1420) — but they are handed to the **host** as a CSV via the
`__register_prototype` **host import**, which populates `_methodNames` /
`_staticMethodNames` in `src/runtime.ts` (~5060). That is what makes the host
lane's descriptor surface correct.

**Standalone has no counterpart.** The native `__getOwnPropertyDescriptor` /
`__hasOwnProperty` / `__propertyIsEnumerable` understand only `$Object` hash-map
receivers (`src/codegen/object-runtime.ts` ~8342), and a class prototype is not
one — so every own-property query answers "absent". The compile-time data needed
is **already computed**; only the standalone consumer is missing.

### The method IS reachable as a value — the gap is the own-property surface

| probe                                     | host     | standalone |
| ----------------------------------------- | -------- | ---------- |
| `typeof C.prototype.m === "function"`     | pass     | **pass**   |
| `typeof c.m` / `typeof C.s`               | pass     | **pass**   |
| `c.m === C.prototype.m` (§15.7 identity)  | pass     | **pass**   |
| `new C().m()` / `C.s()`                   | pass     | **pass**   |

So the function object exists, is shared, and dispatches. Only its presence in
the descriptor/own-property surface is missing. That bounds the change: it does
**not** require materializing new function objects.

### Adjacent defect found while probing — do NOT fold it in

`o[n]` where both are parameters (`function read(o,n){return o[n];}`) fails on
**BOTH** lanes for a class method, while the direct `C.prototype.m` read passes
on both. That is #3642's family, not this issue, and it is a **cross-lane**
defect. It matters here only because it **invalidated an instrument** (arm S,
see `plan/probes/3976/NOTES.txt`), not because it blocks this fix.

### Consequence for slicing — read before sizing

`verifyProperty` does not stop at presence. After
`assert(__hasOwnProperty(obj,name))` it **mutates**: it writes an unlikely value
to probe `writable`, and deletes to probe `configurable`. So a
presence-and-descriptor-only fix will **not** flip a file that reaches those
probes. The 40/40 ceiling (arm U) skips all of it and is an upper bound only.

**Attempting to measure the realised yield of a presence-only fix produced two
INVALID instruments** (a silent no-op, then a confounded one) — both recorded in
`plan/probes/3976/NOTES.txt`. **The realised yield of slice 1 is therefore NOT
yet measured.** Measure it against a real implementation before quoting a size;
do not inherit the 826 or the 40/40.

## Implementation plan (slice 1) — three in-tree precedents, not a new mechanism

The shape this needs already exists three times over in the standalone lane:
**reserve a native at emit time, fill it at finalize time once all metadata is
registered, then prepend an early arm into the reflective natives.** See
`fillBuiltinFnMeta` (#2896), `fillExternGetErrorProps` (#3130) and
`fillObjVecReflectionHelpers` in `src/codegen/index.ts` (~4215-4245).

`__hasOwnProperty` (`src/codegen/object-runtime.ts` ~3035) **already opens with
exactly this kind of arm** — the `bfnGetMetaIdx` builtin-fn-metadata check that
returns 1 early before the `$Object` cast. A class-proto arm goes in that same
slot, ahead of the `ref.test $Object` bail-out that currently answers 0.

Steps:

1. **New native `__class_meta_find(obj, key) -> i32`** (standalone only),
   reserved at emit time and filled by a new `fillClassProtoMeta(ctx)` after all
   classes are registered. Body, per class with methods:
   - identity-compare `obj` against the `__proto_<Class>` global ⇒ consult
     `ctx.classMethodNames`;
   - identity-compare against the `__class_<Class>` global ⇒ consult
     `ctx.classStaticMethodNames`.

   The identity compare is what keeps **instances** correct: `c` and
   `C.prototype` are both `$ClassName` structs with the same `__tag`, but
   `hasOwnProperty(c, "m")` must be **false** — only the prototype singleton
   carries the method. Do **not** key this on `__tag`.

2. **Prepend arms** into `__hasOwnProperty`/`__object_hasOwn` (return 1),
   `__propertyIsEnumerable` (return **0** — class methods are non-enumerable),
   and `__getOwnPropertyDescriptor` (synthesize
   `{value, writable: true, enumerable: false, configurable: true}`; `value`
   comes from the existing member read, which already works — see the value
   table above).

3. **Own-key enumeration** (`__getOwnPropertyNames`) should list the same names
   so `Object.getOwnPropertyNames(C.prototype)` matches host. `Object.keys` must
   NOT list them (non-enumerable).

**Out of slice 1, deliberately**: `writable`/`configurable` are *behavioural* —
`verifyProperty` probes them by writing and deleting. Making the synthesized
descriptor claim `writable: true` without making the write actually take effect
would trade a missing property for a **wrong** one, which is worse. Either
implement the mutation path in the same slice or have `verifyProperty`'s probes
fail honestly; do not fake the flags.

**Private elements** (`#m`) must stay absent from all of the above — several
tests in this cluster assert exactly that.
