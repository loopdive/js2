---
id: 6457
title: "standalone: `K.prototype` on a class OBJECT held in an `any` binding answers `undefined` — the whole `ZonedDateTime/prototype/*/{branding,prop-desc}` family dies on `Object.getOwnPropertyDescriptor(<class>.prototype, k)`, and `x instanceof K` through a dynamic RHS answers `false` for the same reason"
status: done
assignee: ttraenkler/dev-5383-s11
sprint: current
priority: high
horizon: m
goal: standalone
parent: 5383
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
completed: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6457) — the mechanism itself lives in the NEW module
  #   `src/codegen/standalone-class-prototype-read.ts`, deliberately not in the
  #   god-file. What grows here are the two call sites it cannot avoid:
  #   index.ts        +8  the fill call in BOTH finalize pipelines plus the note
  #     that pins its POSITION. The position is the whole correctness argument
  #     and it is not derivable from the call: it must sit AFTER
  #     `fillClassProtoLookupArm` (whose class-object arm routes `prototype` to
  #     the static sidecar and would otherwise answer first, missing) and BEFORE
  #     `fillDynamicProtoHelpers` (#802's dynamic-proto arm must keep the front
  #     slot, or a prototype link mutated at runtime is answered from a
  #     compile-time singleton instead). A reader who "tidies" the call to the
  #     end of the block reintroduces a wrong answer that no byte A/B shows,
  #     because both orders compile.
  #   property-access.ts  +6  the demand registration, AT the one dot-read site
  #     that has both the receiver's wasm kind and the property name. It cannot
  #     move to the new module without separating the decision from the code
  #     that makes it. The note records why it is scoped to the single name
  #     `prototype` rather than every dot read on an `any` receiver: the wider
  #     form raises the per-class prototype and sidecar builders in most
  #     standalone modules, for arms that already answer.
  - src/codegen/index.ts
  - src/codegen/property-access.ts
func-budget-allow:
  # 2026-09-13 (#6457) — same two call sites, inside the two finalize drivers.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

## Problem

Under `--target standalone`, a RUNTIME-key read of `prototype` on a compiled
class OBJECT answers `undefined`:

```js
class C { get day() { return 1; } }
function f(K) { return K.prototype; }   // K is an `any` parameter
f(C);                                    // undefined   (C.prototype -> object)
```

The read is not exotic — it is what `Object.getOwnPropertyDescriptor(
Temporal.ZonedDateTime.prototype, "day")` does the moment the class value is
not statically known, which is every test262 row in the
`ZonedDateTime/prototype/*/{branding,prop-desc}.js` family, and it is what the
`instanceof` operator does with its right-hand side.

**This is module-local codegen, NOT the link boundary** — the census below
reproduces it in a single standalone module with no provider, no link and no
`Temporal`. (The S10 hand-off attributed the bucket to a missing link-boundary
*descriptor* terminal. That attribution is wrong for the same reason S9's was:
the boundary already answers, the module-local ladder does not.)

### Census (2026-09-13) — reduction and attribution

Single module, `--target standalone`, `hostBridge: "off"`, no link
(`.tmp/s11/c2.mjs`). `C` is a class with a getter, a method and a static;
`K` is the same class reached through a function parameter:

| probe | static receiver (`C`) | dynamic receiver (`K`) |
| --- | --- | --- |
| `typeof recv.prototype` | `object` | **`undefined`** |
| `Object.getOwnPropertyDescriptor(recv.prototype, "day")` | descriptor object | **throws `Cannot convert undefined or null to object`** |
| `new recv(1) instanceof recv` | `true` | **`false`** |
| `typeof recv` | `function` | `function` (ok) |
| `typeof new recv(1)` | `object` | `object` (ok) |

Linked, against the real compiled Temporal provider (`.tmp/s11/c1.mjs`,
provider `js2wasm:npm:@js-temporal/polyfill:c97cf3351a9120b1`, `cacheHit=true`):

| probe | answer |
| --- | --- |
| `typeof Temporal.PlainDate.prototype` | **`undefined`** |
| `Object.getOwnPropertyDescriptor(Temporal.ZonedDateTime.prototype, "day")` | **throws** |
| `"day" in Temporal.ZonedDateTime.prototype` | **`false`** |
| `Object.keys(Temporal.ZonedDateTime.prototype).length` | **0** |
| `Object.getPrototypeOf(new Temporal.PlainDate(…)) === Temporal.PlainDate.prototype` | **`false`** |
| `Object.getOwnPropertyDescriptor({a:1}, "a")` (control) | object |
| `new Temporal.ZonedDateTime(0n,"UTC").timeZoneId` (control) | string |

The same defect, same two sides. Every `Temporal.X` read is a dynamic receiver
by construction (the namespace is a boundary value), so the standalone Temporal
lane hits the dynamic column always.

### Root cause

`__extern_get(recv, key)` reaches a compiled class OBJECT through
`__class_proto_lookup`'s class-object arm (#5195 F2 / #5383 S2i). That arm
answers the class's **static sidecar `$Object`** — the carrier for static
methods and static accessors — and `prototype` is not on it. Nothing else in
the dynamic ladder knows a class value has a prototype singleton at all, so the
read falls to `__extern_get`'s miss and answers `undefined`.

The prototype object itself exists and is correct: `ctx.protoGlobals` holds it,
`emitStandaloneClassProtoObject` (#3976) builds it as a real `$Object` with the
methods and accessors installed at §15.7.14 attributes, and the STATIC read
`C.prototype` already returns it. The dynamic read simply has no route to it.

## Implementation Plan

New module `src/codegen/standalone-class-prototype-read.ts`, one exported fill
`fillClassPrototypeReadArm(ctx)`, called from both finalize pipelines in
`src/codegen/index.ts` immediately after `fillClassProtoLookupArm(ctx)` and
before `fillDynamicProtoHelpers(ctx)`.

**Why an arm rather than a sidecar property.** Installing `prototype` as an own
property of the static sidecar `$Object` is the more spec-shaped answer (it
would also serve `gOPD(K, "prototype")` and `"prototype" in K`), but it is not
reachable in one slice: the sidecar body is built inside
`mintStandaloneClassStaticBuilders`, which runs *before*
`mintStandaloneClassProtoBuilders`, so the prototype builder it would have to
call does not exist in `funcMap` yet. Closing that needs a resolve-or-reserve
handle (the S2n pattern) plus a widened sidecar admission for classes with no
static at all — two order-sensitive changes to a path that is currently
byte-stable. The arm below needs neither: it is emitted at FILL time, where both
builders are already resolvable by name, and it changes no existing emission.

**Shape** — prepended into `__extern_get`, so it sits in front of the
class-proto-lookup delegation and behind #802's dynamic-proto arm (which must
keep the front slot, because a runtime-mutated prototype link has to win):

```
if key is a string and __str_equals(flatten(key), "prototype"):
   for each admitted class C, most-derived first:
     if ref.test $C(recv) and recv.__tag == tag(C) and recv === global.get __class_C:
        if global.get __proto_C is null: call __class_proto_build_C   (when one exists)
        return global.get __proto_C
```

- The `ref.eq` against the class-object singleton is what keeps an INSTANCE out:
  `d.prototype` must stay `undefined`, and an instance and its class object are
  the same wasm struct type (#3976), so the identity test is the only
  discriminator. `__tag` is tested for the #5195 F1 reason — WasmGC canonicalises
  struct types structurally, so `ref.test` alone cannot tell two same-shaped
  classes apart.
- Most-derived-first ordering, same argument as `collectEntries`.
- A null class-object global makes `ref.eq` false, which is the right answer.

**Admission** (all must hold, else no arm for that class):
`ctx.standalone` · the class is in `ctx.standaloneRuntimeKeyClassProtos` (the
dynamic-read demand set, which a wasm-consumed provider seeds with every class)
· `standaloneClassProtoObjectApplies(ctx, C)` and `ctx.protoGlobals.get(C)` is
set · `ctx.classObjectGlobals.get(C)` is set · the class has a `__tag` field and
a tag value. A module with no dynamic class-member read compiles to identical
bytes, and the gc lane is excluded outright.

**Order preservation**: the fill only PREPENDS to `__extern_get` and appends one
local; it never renumbers. Byte A/B must show every `gc` artifact identical and
only standalone shapes that actually make a dynamic class read moving.

## Result (measured 2026-09-13)

**+31 rows across the three linked Temporal families, 0 `pass→fail`.** The
`Cannot convert undefined or null to object` bucket is **18 → 0**.

| family (120 rows, `--target standalone`, linked) | S10 pass | **S11 pass** | fail | CE | pass→fail |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 62 | **62** | 57 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 38 | **43** | 74 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 39 | **65** | 53 | 2 | **0** |
| **total** | **139** | **170** | 184 | 6 | **0** |

31 rows flipped `fail→pass`: 26 in ZonedDateTime (the whole
`prototype/*/{branding,prop-desc,length,name,not-a-constructor}` surface) and 5
in Duration (`prototype/abs/*`, the same surface). PlainDate is flat — its top
bucket is field EXTRACTION, not the prototype read (see the residuals).

**Read the CE column with the solo re-run.** The sampled run showed 5 extra
`compile_error` rows against base; re-run SOLO at a 60 s compile budget
(`.tmp/s11/rerun.mts`) **all five answer `fail`**, at 13.0–17.5 s against the
sample's 15 s budget. They are load-induced compilation timeouts from the
concurrent lanes this session ran, not this change. With them restored the CE
counts are identical to base in every family.

### Must-not-move samples, base by file-copy revert on the same tree

| sample (first 120, standalone) | base | S11 | flips |
| --- | --- | --- | --- |
| `built-ins/Object/**` (descriptors — `gOPD` is this arm's consumer) | 106 pass / 14 fail | 106 / 14 | **0** |
| `language/expressions/class/**` (class identity) | 70 pass / 38 fail / 12 CE | 70 / 38 / 12 | **0** |

### Order preservation

21 module shapes × {gc, standalone}, base captured by file copy before the first
edit (`.tmp/s11/ab-{base,new}.out`): **all 21 `gc` artifacts sha256-identical,
and on standalone exactly ONE moved** — `dynProtoGopd`, the
`Object.getOwnPropertyDescriptor(K.prototype, …)` shape this slice exists for.
Every control is byte-identical, including `classesNoDynProto` (a class module
with no dynamic prototype read) and `dynOtherName` (a dynamic read of a
different name).

## Acceptance criteria

1. `f(C)` returning `K.prototype` answers the prototype object in a single
   standalone module; `Object.getOwnPropertyDescriptor(K.prototype, "day")`
   answers a descriptor rather than throwing.
2. ~~`new K(1) instanceof K` with a dynamic `K` answers `true`.~~ **NOT met —
   deliberately deferred.** That read takes a different route
   (`__closure_proto_of`), see the residuals; the outcome is PINNED by an
   executable expectation in the test file rather than left as a note.
3. An INSTANCE receiver still answers `undefined` for `prototype`.
4. Linked: `typeof Temporal.PlainDate.prototype` is `"object"`.
5. No `pass→fail` in the three Temporal families, and none in a must-not-move
   `built-ins/Object/**` standalone sample.
6. Every `gc` artifact byte-identical in the fixed-corpus A/B.

## Residuals measured but NOT fixed here (with reductions)

- **`new K(1) instanceof K` with a dynamic `K` still answers `false`** —
  single-module, no link (`.tmp/s11/c2.mjs`); the static `new C(1) instanceof C`
  answers `true`. §13.10.2 reads `RHS.prototype`, but NOT through
  `__extern_get`: `native-dynamic-instanceof.ts` consults `__closure_proto_of`
  (`closure-prototype-edge.ts`), whose CLASS arm deliberately does not vivify and
  reads `__proto_<C>` raw — so a class whose prototype ClassDefinitionEvaluation
  left lazy answers `null`, and the conservative `false` follows. The fix is the
  same build-if-null that this slice's arm carries, applied to that arm; it was
  left out because a WRONG `instanceof` is worse than a missing one and the
  helper is on a far hotter path than a `prototype` read. PINNED by an
  executable expectation in
  `tests/issue-6457-standalone-dynamic-class-prototype.test.ts`.
- **`gOPD(K, "prototype")` and `"prototype" in K` are still misses.** The arm
  serves the READ only. The own-property surface needs `prototype` installed on
  the static sidecar `$Object` — see "Why an ARM" above for the finalize-order
  work that costs.

- **`new Temporal.Duration(...args)` — SPREAD arguments into a linked
  constructor lose their values.** `new Temporal.Duration(1,1,1).months` is `1`;
  `const a=[1,1,1]; new Temporal.Duration(...a).months` is not a number
  (`.tmp/s11/c3.mjs`). This is the whole Duration `Cannot access property on
  null or undefined at 164:22` bucket (9 rows) — `temporalHelpers.js` line 164 is
  `assertDuration`'s `duration.months`, and every row in the bucket constructs
  with `...args`. Linked-only; the single-module control is not yet taken.
- **`typeof <provider-owned instance>` answers `"function"`, not `"object"`**
  (`.tmp/s11/c1.mjs`: `typeof new Temporal.PlainDate(…)` → function; the
  single-module control answers `object`). A boundary defect — the
  `__js2wasm_link_callable_kind` terminal classifies every provider value as
  callable. Not attributed to a bucket yet.
- **`Temporal.PlainDate.from(bag)` returns an object whose `year`/`month`/`day`
  are `NaN`**, and `from(string)` returns one with `undefined` fields
  (`.tmp/s11/c1.mjs`). This is #5408's residual and the likely driver of the
  21-row `canonicalizeCalendarEra` bucket; the harness-shape reductions in
  `.tmp/s11/c3.mjs` (object-literal method forwarding `date.calendarId` into a
  second method) all answer a correct string, so the bucket is NOT a
  member-read-shape defect.
- **`Temporal.Duration.from("P1Y")` TRAPS** (`dereferencing a null pointer`),
  where `from(bag)` and `from(duration)` answer correctly.

## Trap found this slice (carry forward)

**The standalone Temporal provider cache is NOT keyed on the compiler.**
`temporalProviderCacheKey` fingerprints the polyfill source, the `Intl` shim and
the compile OPTIONS — and nothing about the compiler build. So after a codegen
change `buildTemporalProvider` reports `cacheHit=true` and serves the artifact
built by the PREVIOUS tree, and every linked probe answers the old way. It cost
this slice one full round of linked measurements that showed a perfect zero
delta while the single-module probes had already flipped. (S10's note that "the
artifact re-keys because the compiler changed" is not what the key does; those
two runs differed because the shim text differed.) **Point
`JS2WASM_TEMPORAL_CACHE` / the probe cache dir at a FRESH directory after every
codegen edit**, and check the `cacheHit=` and namespace-hash line in the run log
before believing a linked number.
