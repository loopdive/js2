---
id: 6617
title: "`Object.getPrototypeOf(<instance of a compiled class>)` answered null through every dynamic path, and had no hop across the standalone link"
status: done
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-15
assignee: ttraenkler/senior-dev-s30
loc-budget-allow:
  # 2026-09-15 — inherited from #6612–#6616 (the S25–S29 stack this branch is
  # based on), restated here because the LOC gate reads the allowance from a
  # file the PR touches and those issue files are not in this slice's diff.
  # `src/runtime.ts` sits at 19,822 against a 19,601 ceiling on the stack tip;
  # this slice adds nothing to it.
  - src/runtime.ts
func-budget-allow:
  # 2026-09-15 — same inheritance: `buildImports` is 308 against a 300 ceiling
  # on the stack tip. Untouched by this slice.
  - buildImports
---

# #6617 — the prototype of a compiled class instance, dynamically and across the link

## Problem

Under `--target standalone`, `Object.getPrototypeOf(x)` answered the right
object only when the CHECKER could name `x`'s class. Every other path answered
`null` (measured 2026-09-15, `.tmp/s30/cases-a.mjs`, ONE module, no link):

```js
class C { constructor(y) { this.y = y; } }
const NS = { C };
Object.getPrototypeOf(new C(1)) === C.prototype;   // true  — the static fold
Object.getPrototypeOf(NS.C ? new C(1) : null);     // null  ← the gap
```

and across the #2527 linked-provider seam, where by construction no value has a
checker type (`.tmp/s30/cases-j.mjs`, the S29 reduction, reproduced here):

| probe | base |
| --- | --- |
| `typeof NS.PD.prototype` | `"object"` — the class object's `.prototype` IS there |
| `Object.getPrototypeOf(new NS.PD(1))` | **`null`** |
| `… === NS.PD.prototype` | **`false`** |

The generic native `__getPrototypeOf` walks `$Object.$proto`. A compiled class
instance is a closed `$ClassName` struct with no such field, so every arm
missed: `ref.test $Object` fails, the #4643 fnctor ladder answers null, and the
boundary import is absent. The JS-host lane has answered this since #5347
(`__class_instance_proto`), which explicitly declines this lane — true only for
the classes #802 marks as dynamically re-prototyped.

Behind it: test262's 45 `built-ins/Temporal/**/subclassing-ignored.js` files,
whose helper asserts
`assert.sameValue(Object.getPrototypeOf(result), construct.prototype)`.

## Fix

1. **`src/codegen/standalone-class-instance-proto.ts` (new)** —
   `__std_class_instance_proto`, a `ref.test` + `__tag` + `ref.eq` cascade over
   the module's own classes, most-derived first, declining the class-OBJECT
   singleton and materialising the prototype through `__class_proto_build_<C>`.
   Prepended as an arm of `__getPrototypeOf`; disjoint from #802's marked-root
   arm both by exclusion and by fill order.
2. **`standalone-link-boundary.ts`** — a new terminal
   `__js2wasm_link_get_prototype_of`, reserved with the "not mine" body and
   filled at finalize, wrapping that dispatcher. Deliberately NOT
   `__getPrototypeOf`: the consumer reaches this only after its own answer was
   null, so anything returned REPLACES a null, and the wider wrapper would
   publish the provider's `%Object.prototype%` — a foreign intrinsic the
   consumer can never name or compare equal to its own.
3. **`object-runtime.ts`** — the consumer's `__getPrototypeOf` miss arm calls
   the peer terminal through `boundaryObjectGetPrototypeIdx ?? peerGetPrototypeOfIdx`,
   the same one-arm-serves-both-lanes shape `__extern_has` already uses (the two
   are mutually exclusive: a JS-host module never has a wasm peer).
4. **`expressions/call-builtin-static.ts`** — the generic
   `Object.getPrototypeOf` site raises the per-class prototype demand, the
   arming twin of #6457's. A linked PROVIDER already seeds every class (#5383
   S2h), which is why the provider half needs no site of its own.

### Why the class-object decline is safe rather than lossy

The dispatcher declines a value only when `__class_<C>` is materialised and
`ref.eq` matches. If that global is still null the arm answers the prototype —
and that is not a hole: to hold a class OBJECT as a value at all, the program
must have evaluated `C`, which goes through `emitLazyClassObjectGet` and
materialises the global. The null-global window therefore contains no class
objects. Same argument #6457's arm rests on.

## Result

**Four families, 120 files each, `--target standalone`, provider linked,
sequential, fresh cache, 60 s per row.** Base measured HERE by file-copy revert
of the four touched files to `HEAD~1`, not inherited.

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 109 | 109 | 0 | 0 | 0 |
| `Duration/**` | 100 | 100 | 0 | 0 | 0 |
| `PlainDateTime/**` | 111 | 111 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **423** | **423** | **0** | **0** | **0** |

No `compile_error`, no `timeout`, no `__temporal_*` leak in any of the 960 rows.
The 57 residual rows are **not merely equal in count — the 34-bucket message
table is identical count for count** (`diff` of the two bucket tables is empty).

**The 45-file headline family does not move**: `subclassing-ignored.js`,
corpus-wide, per file, both labels — **0 pass → 0 pass, and all 45 failure
messages byte-identical**. §"Where the family still stops" explains why, and it
is not this fix failing.

**Witness**: `tests/issue-6617-class-instance-prototype.test.ts`, 13 `it`s. Run
against the reverted base: **8 fail, 5 pass**.

## Controls

**Must-not-move — 270 rows, four groups, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 60 | 58 | 58 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 60 | 47 | 47 | 0 |
| **C1: `Object/{getPrototypeOf,setPrototypeOf}` + `Object/prototype/isPrototypeOf`** | 47 | 44 | 44 | 0 |
| **C2: `expressions/instanceof` + `statements/class/subclass`** | 103 | 70 | 70 | 0 |

C1 and C2 are the groups this change needs and were chosen for it: the whole
prototype-MOP corpus plus the two consumers of prototype identity.

**Targeted byte A/B — ONE artifact moves, and the gc lane does not move at all:**

| source | lane | base | branch | |
| --- | --- | --- | --- | --- |
| dynamic `getPrototypeOf`, module HAS a class | standalone | `c922c20b` 200,869 B | `dee9a486` 201,067 B | **moved** |
| the same source | gc | `14cccdf5` 5,375 B | identical | |
| the STATICALLY folded query | both | `3c98b33d` / `64fc27fb` | identical | |
| dynamic `getPrototypeOf`, NO class in the module | both | `0d923a99` / `c6ca197f` | identical | |
| a class module that never asks | both | `2f9ce04a` / `c9cf7efa` | identical | |
| a dynamic MEMBER read on a class instance (#6457's neighbour) | both | `258a3419` / `465e24f3` | identical | |
| `Object.setPrototypeOf` on the same receiver | both | `321b61aa` / `542ebc34` | identical | |

The gc lane is byte-identical by design here — a deliberate return to the
S24–S28 posture and away from S29's lane-independent fix. The host lane already
answers this question correctly through `__class_instance_proto`, so a shared
fix would be a second mechanism for a solved problem, not a wider one.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**.
A NULL control, and honestly so: no module in that corpus asks
`Object.getPrototypeOf` about a value it cannot narrow. The targeted table above
is what shows the change does anything.

**Provider artifact**: `a7bd3c5f…` 3,308,117 B → `1e0c47f8…` 3,311,079 B
(+2,962 B), `cacheHit=false` on both prewarms. Per the S28/S29 reading of this
stamp, a MOVED provider says the fix reached the provider SIDE — which is where
it has to live, because the instance's owner is the only module that can answer.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures on both
trees — baseline exactly.

## Where the family still stops — the successor cause, reduced

The fix is correct and demonstrable against the REAL polyfill, not only
synthetically (`.tmp/s30/t/p1.js`, one consumer module + the linked Temporal
provider):

```
typeofD=function DProto=object gpoInst=object match=true paramProto=object
typeofR=function gpoR=object matchR=true
```

`Object.getPrototypeOf(new Temporal.Duration(1)) === Temporal.Duration.prototype`
is **true** on this branch. The 45 rows nonetheless fail identically, because
they die EARLIER, in the harness:

```js
checkSubclassConstructorNotObject(construct, constructArgs, method, methodArgs) {
  const instance = new construct(...constructArgs);   // ← null
  …
  assert.sameValue(Object.getPrototypeOf(result), construct.prototype);
  //                                              ↑ undefined
}
```

Measured in one module with the real provider (`.tmp/s30/t/p2.js`):
`c=function cProto=undef cArgs=object m=string:abs mArgs=object instT=null
resT=null gpoRes=null match=false`. The argument BINDING is correct (S29's fix
holds); what fails is `construct.prototype` on that parameter, and the
construction through it.

That read is **content-sensitive**, which is the finding:

| module (real Temporal provider, one consumer module each) | `c.prototype` |
| --- | --- |
| only `function readOnly(c) { return tag(c.prototype); }` (`p4`) | **`undef`** |
| the same + a STATIC `Temporal.Duration.prototype` anywhere (`p5`) | `object` |
| the same + a static read of a DIFFERENT class (`p6`) | `object` |
| the same + any other static two-level member read (`p8`) | `object` |
| the same + a dynamic read of another member of `c` first (`p9`) | `object` |
| two identical `c.prototype` reads in the function (`p10`) | `object` |

So the answer depends on unrelated module content, in both a compile-time and a
first-read-materialisation-looking way, and the synthetic linked pair does NOT
reproduce it (`proto_param` answers `val` with none of the above). It is the
S29-R3 "module CONTENT changes answers" hazard, this time deciding a real row.
Filed as R1 below rather than chased here: it is a different mechanism from this
issue's, and one probe generation was already spent reading its instability as
signal.

## Residuals — reduced and sized here, NOT given their own ids

`claim-issue.mjs --allocate` still cannot reserve against a complete universe on
this box (GitHub is 403 for every lane this session), and an id reserved then
abandoned leaves a permanent hole (#3890/#3891). Each residual below carries its
reduction so the next slice can open it under a real id.

### R1 — `<provider class>.prototype` through a parameter answers `undefined`, depending on unrelated module content (45 files)

The table above. **This is now the whole remaining distance for the 45
`subclassing-ignored.js` files**, together with its consequence
`new construct(...constructArgs) === null`. Reductions: `.tmp/s30/t/p2.js`
(the helper shape, end to end), `p4`/`p5`/`p6`/`p8`/`p9`/`p10` (the content
sensitivity, one variable at a time).

### R2 — `instanceof` across the link still answers "no" for a provider-minted instance

`(new NS.PD(1)) instanceof NS.PD` is `"no"` on BOTH trees
(`.tmp/s30/cases-e.mjs` L6), despite #5354 and despite both halves of
OrdinaryHasInstance now being reachable: `NS.PD.prototype` is a value and
`getPrototypeOf(instance)` now answers it. So `__instanceof_dynamic` does **not**
compose its chain walk out of `__getPrototypeOf` — it walks `$Object.$proto`
through `__isPrototypeOf`, which a closed class struct is not. A future slice
should seed that walk from `__getPrototypeOf` rather than add a third prototype
mechanism. Corpus footprint unmeasured.

### R3 — `C.prototype.isPrototypeOf(<instance>)` is false, in one module and across the link

`"no"` on both trees, for a STATIC receiver as well as a dynamic one
(`.tmp/s30/cases-a.mjs` `s_isProtoOf`/`d_isProtoOf`, `cases-e.mjs` L7). Same
root cause as R2 — the §20.1.3.3 walk is `$Object`-only — and the same fix
shape. `object-runtime-prototype.ts` already carries the precedent: the #4643
fnctor arm seeds `cur` from the fnctor ladder when the `$Object` cast misses.

### R4 — a dynamic instance's `.constructor` back-link is `diff` in ONE module

`dynv(1).constructor === C` answers `"diff"` on both trees while the
statically typed `(new C(1)).constructor === C` answers `"same"`, and the
LINKED case answers `"same"` (`.tmp/s30/cases-d.mjs` w9 vs `cases-e.mjs` L4).
A module-local dynamic read is the only one of the three that is wrong, which
makes this a narrow ladder gap rather than an identity one.

### R5 — `Object.getPrototypeOf(<plain object through a union>)` answers null

`const o = cond ? { a: 1 } : null; Object.getPrototypeOf(o)` answers `null`
where §20.1.2.12 says `%Object.prototype%` (`.tmp/s30/cases-c.mjs`
`dyn_plain_object`, both trees). The object-literal fold is syntactic, so a
union-typed binding escapes it; the `$Object` arm's implicit-terminal answer
(#5270 step 2) should be reached but is not. Unmeasured corpus footprint,
likely wider than Temporal.
