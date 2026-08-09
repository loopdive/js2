---
id: 3875
title: "Standalone: reflection routes disagree on built-in prototype properties — hasOwnProperty false and getOwnPropertyNames short while getOwnPropertyDescriptor is spec-exact"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
task_type: bugfix
area: codegen-standalone
goal: standalone-mode
es_edition: 5
sprint: current
horizon: m
related: [3254, 2908, 1781, 3647]
---

# #3875 — three reflection routes, three different answers for the same property

## ✅ SETTLED — three independent apparatuses agree

Four revisions and a three-way disagreement resolved. **The disagreement was the
instrument, not the compiler**, and every disputed cell has now been re-measured
with passing controls through `runTest262File`, bare `compile()`, and a third
independent probe.

| finding | status |
|---|---|
| `Array.prototype.hasOwnProperty('push')` → **true** in standalone; RegExp / String / Object → **false** | **settled, 3 apparatuses** |
| `getOwnPropertyDescriptor` returns a **real, spec-exact descriptor** in standalone for all of them | **settled** |
| `getOwnPropertyNames().length` → constant **6** in standalone vs host **40/15/52/12** — broken **everywhere including Array** | **settled** |
| **The two routes contradict each other**: for `RegExp.prototype.exec` in standalone, `hasOwnProperty` says *not own* while `gOPD` returns a *full own descriptor* | **settled — this is the precise defect** |

**That last line is the result.** Not "reflection is missing" — **one route consults
a registry the other does not**, and `Array.prototype` is the one built-in wired
into both.

Withdrawn along the way: "gOPD returns `undefined`" (it does not), "there is no
working reference to copy" (Array is real), and "bare `compile()` is not a valid
instrument" (it agrees case-for-case on `hasOwnProperty`; one earlier probe was
simply broken).

### Routing

- **Lookup (`hasOwnProperty`) — ROUTABLE NOW.** `Array.prototype` is a genuine
  working in-repo reference; replicating its registration for RegExp / String /
  Object / Number / Boolean prototypes is a bounded fix.
- **Enumeration (`getOwnPropertyNames`) — NOT routable as "copy Array".** Broken for
  Array too, so no reference exists. Separate, harder, needs its own issue.
- **Still hold the 25-row hand-off**: it must be re-cut **by route**, because `gOPD`
  rows already work in standalone and will not move.

## 🆕 THIRD DEFECT — aliasing a built-in prototype destroys its reflection identity

Measured in bare `compile()`, **no harness anywhere**, both forms side by side:

```
                                                      host   standalone
INLINE gOPD(RegExp.prototype,'global')                1      1
VAR    P = RegExp.prototype; gOPD(P,'global')         1      0   <- DIFF
INLINE gOPD(RegExp.prototype,'exec')                  1      1
VAR    P = RegExp.prototype; gOPD(P,'exec')           1      0   <- DIFF
INLINE Array.prototype.hasOwnProperty('push')         1      1
VAR    P = Array.prototype; P.hasOwnProperty('push')  0      0   <- BOTH LANES
```

**Binding a built-in prototype to a local and reflecting through the alias gives a
different answer than reflecting on it inline.** Same object, same property.

This also **exonerates both harnesses** — it reproduces with zero harness assembly,
closing the "is the instrument in the measurement path" question that held routing
for three exchanges. And it **hits the host lane too** (`var P = Array.prototype;
P.hasOwnProperty('push')` → 0 on host, inline → 1).

**So the decomposition is three defects, not two: lookup-registration ·
enumeration · aliasing.**

### Routing consequence — checked, not assumed

- The **20 descriptor rows** use `Object.defineProperty(Array.prototype, …)`
  **inline**, no alias. **They survive — copy-Array routes them correctly.**
- The **nine `RegExp/prototype` grid rows** that started this whole thread
  (including `S15.10.7.2_A8.js`) open with **`var __re = RegExp.prototype;`**. They
  need registration **AND** aliasing. **Copy-Array alone will NOT move them.**

So the copy-Array lookup fix is correctly scoped to the **descriptor** areas and
**insufficient** for the **prototype-accessor** areas that motivated this issue.

**Blast radius MEASURED — bounded, not near-universal.** The initial worry was that
`var __re = X.prototype` is near-universal in Sputnik-era ES5 tests. Counted across
the full 866-row wrong-answer cut: **14 / 866 = 1.6%**, with the nine grid rows as
the bulk of it. File it as its own issue sized at **~14**, not as a broad threat to
the lookup routing.

*Caveat:* the detector matches `(var|let|const) X = <Builtin>[.prototype]`, so it
misses aliases formed via parameter passing, property reads, or multi-step
assignment. **14 is a floor** — realistically 14–25, but not the hundreds implied by
"near-universal".

**And the 20 descriptor rows were re-checked in full** (all 20, not a sample):
**0 aliased**, every one inline. The lookup routing is unaffected.

## Sizing — re-cut BY ROUTE (supersedes all earlier figures)

| n | route exercised | moves on a copy-Array lookup fix? |
|---:|---|---|
| **20** | `hasOwnProperty` **only** | **YES** |
| 4 | no reflection route (define-side) | no — different cause |
| 1 | `gOPD` only | **no — already correct in standalone** |

Sample of the 20: `defineProperties/15.2.3.7-6-a-{169,171,173}.js`,
`defineProperty/15.2.3.6-4-{410,581,596}.js`. The single non-mover:
`getOwnPropertyDescriptor/15.2.3.3-4-163.js`.

**The re-cut went UP, not down** (~15 → 20). Both agents predicted it would shrink
once `gOPD` rows were excluded; instead the earlier "BOTH paths" bucket was a
classification artifact and mostly resolved to `hasOwnProperty`-only once split by
*actual route* rather than keyword presence. **Every other sizing in this lane was
revised downward — this is the one that grew.**

**Ceiling, not a flip count.** 20 rows exercise the broken route; each still has to
produce the right answer once `hasOwnProperty` reports correctly. A/B the 20 the way
#3420 was A/B'd rather than quoting 20 as a delta.

## 🚨 CORRECTED — the axis is receiver EXPRESSION SHAPE, not route

An earlier revision of this issue claimed the host lane had "per-route reflection
bugs" and prescribed *a control per route, not per probe*. **That was wrong about
the axis.** Measured:

```
                                              host   standalone
gOPD   ({a:1},'a') truthy                     0      1     <- WRONG on host
gOPD   var o={a:1}; gOPD(o,'a') truthy        1      1     <- CORRECT
gOPD   ({a:1},'zz') === undefined             1      1     <- CORRECT
hasOwn ({a:1}).hasOwnProperty('a')            1      1     <- CORRECT
propIsEnum ({a:1}).propertyIsEnumerable('a')  1      1     <- CORRECT
```

**`gOPD` with an INLINE object-literal argument returns `undefined`; bind the
literal to a variable first and it returns a real descriptor.** That is the *same*
receiver-expression-shape axis as the prototype aliasing defect above, running in
the opposite direction: for **built-in prototypes** inline works and the variable
fails; for an **object-literal argument to `gOPD`** inline fails and the variable
works.

So the broken host control was **a real defect, not a harness limitation** — and it
is the same family, not a separate mystery.

> **Instrument rule this yields — replaces "a control per route":** *any probe
> passing an inline object/array literal directly as an argument is suspect under
> bare `compile()`. Bind it to a variable first.* **Both** broken controls that
> derailed this investigation were exactly that shape.

⚠️ A proposed lane rule — "bare `compile()` is invalid for `Object.prototype`
methods, fine for `gOPD`" — is **measured backwards**: all four
`Object.prototype`-method cases are correct in bare compile on host, and `gOPD` is
the broken one. Adopting it would have sent every future measurement to the wrong
instrument for both questions.

## How it was found (the control property is the whole story)

Investigating nine `RegExp/prototype/{global,ignoreCase,multiline}` × `{A8,A9,A10}`
rows — all host-pass / standalone-fail, all flipping together with one identical
symptom, which by the shared-cause discriminator means **one** cause.

The nine all assert `RegExp.prototype.hasOwnProperty('<accessor>')`. A control was
added: **`RegExp.prototype.hasOwnProperty('exec')`** — an own method of
`RegExp.prototype` under every spec version, which should be `true` regardless of
how the accessor question resolves.

**The control came back `false` in standalone.** So the defect was never about the
three accessors.

## Measured (inlined probe, both lanes, same file)

| `X.prototype.hasOwnProperty(m)` | host | standalone |
|---|---|---|
| `RegExp.prototype` `exec` / `global` | true | **false** |
| `String.prototype` `trim` / `charAt` | true | **false** |
| `Object.prototype` `toString` | true | **false** |
| `Number.prototype` `toFixed` | true | **false** |
| `Boolean.prototype` `valueOf` | true | **false** |
| **`Array.prototype` `push`** | true | **TRUE** |
| CONTROL `({a:1}).hasOwnProperty('a')` | true | true |
| CONTROL `({a:1}).hasOwnProperty('zz')` | false | false |
| functional `" x ".trim()`, `/a/.exec("a")`, `[1].push(2)` | work | **all work** |

Both controls are correct, so **`hasOwnProperty` itself is not broken in general**
— it is correct on user objects. Every method works **functionally**.

## ⚠️ CORRECTED — the fix direction is the OPPOSITE of the first reading

An independent verification (decoding `10*hasOwnProperty + (gOPD !== undefined)`,
standalone reads **`1`**, not `0`) inverted the original claim:

| route | built-in prototype, standalone |
|---|---|
| `getOwnPropertyDescriptor` | **returns a REAL descriptor — spec-exact, identical to host** ✓ |
| `hasOwnProperty` | **returns `false`** ✗ |
| `getOwnPropertyNames` | **6 keys vs host's 40, omits `push`** ✗ |

**This is NOT "built-in prototypes have no reflection surface."** It is **multiple
reflection routes contradicting each other on the same property** — the same shape
as the **#3647** `propertyIsEnumerable`-vs-`gOPD` trap.

**Consequence for implementation: a fix aimed at `getOwnPropertyDescriptor` would
land on a route that already works and flip nothing.** The broken routes are
`hasOwnProperty` and `getOwnPropertyNames`.

Anyone bucketing rows by "gOPD returns undefined" will get a signal that **does not
reproduce** — classify on `hasOwnProperty` instead.

## ⚠️ This is TWO separable defects — and only one has a working reference

The first framing here said "`Array.prototype` works, so replicate it." That was
built on a **single data point** (`push`) and is **half wrong**. Probed properly,
both lanes, same file:

```
host:       push/pop/slice/map/indexOf/join = all true | length=false | bogus=false
            desc.push = value:function, enum:false, writ:true, conf:true
            getOwnPropertyNames(Array.prototype).length = 40, includes push = TRUE

standalone: push/pop/slice/map/indexOf/join = all true | length=false | bogus=false
            desc.push = value:function, enum:false, writ:true, conf:true   <- IDENTICAL to host
            getOwnPropertyNames(Array.prototype).length = 6,  includes push = FALSE
```

**What survives:** not a `push` fluke — six methods reflect, negative cases
(`length`, a bogus key) are correctly false, and the descriptor is **spec-exact and
identical to host**. The lookup mechanism genuinely exists and is genuinely correct.

**What breaks the story:** `getOwnPropertyNames(Array.prototype)` returns **6** vs
host's **40**, and **omits `push`** — the very property whose full descriptor it had
just returned correctly. **The two reflection paths disagree with each other inside
the one built-in that supposedly works.**

### Defect 1 — `hasOwnProperty` on built-in prototypes

Correct for `Array.prototype`, **returns `false`** for RegExp / String / Object /
Number / Boolean prototypes. **Bounded** — "replicate whatever registers
`Array.prototype`" is a fair routing call, and the reference implementation is real.

**`getOwnPropertyDescriptor` is NOT part of this defect** — it already returns a
spec-exact descriptor on every built-in prototype in both lanes. Do not touch it.

### Defect 2 — own-key enumeration (`getOwnPropertyNames` and friends)

**Broken even for `Array.prototype`** (6 keys vs 40, omitting the very property
whose descriptor `gOPD` returns correctly). **No in-repo reference exists** —
copying Array wholesale would propagate this bug rather than fix it. Unscoped;
needs its own sizing before anyone commits to it.

**So the three routes disagree pairwise**: `gOPD` is right everywhere,
`hasOwnProperty` is right only on `Array.prototype`, and `getOwnPropertyNames` is
wrong everywhere including `Array.prototype`.

## Sizing — deliberately UNMEASURED

Plausibly touches part of the **204 `RegExp/prototype`** gap rows, part of the
**97 `String/prototype`** rows, and part of the **410 `built-ins/Object`** rows —
the single largest area in the ES5 standalone gap.

**"Shares a mechanism" is not "flips on fixing it."** Two sizings on this lane were
already wrong at exactly that step. Needs per-row twin-control treatment before
anyone quotes a delta.

## Contamination warning for adjacent work

Any row currently attributed to **descriptor-fidelity** (#2668) whose target is a
property **of a built-in prototype** is failing for *this* reason, not a descriptor
reason — a descriptor fix will not move it. Re-check that split before sizing
either.

Likewise this may partly dissolve the assigned-method / `trim` receiver-coercion
work (#3254 family): those are receiver-coercion, this is object-model, but they
overlap in which rows they touch.

## Side finding — needs its own row

A probe using a helper function with a **polymorphic object parameter** hit an
unrelated standalone compile error:

```
Invalid types for ref.cast null: extern.convert_any … has to be in the same
reference type hierarchy
```

Structural, unrelated to reflection, not yet filed.

## Acceptance

- `hasOwnProperty`, `getOwnPropertyDescriptor` and `getOwnPropertyNames` **agree with
  each other** on built-in prototype properties, and match host, for `RegExp`,
  `String`, `Object`, `Number`, `Boolean` **and `Array`**.
- Do NOT "fix" `getOwnPropertyDescriptor` — it is already correct.
- Functional behaviour unchanged (methods already work; do not regress them).
- Twin-control per-row measurement of what actually flips, with all three
  denominators.
