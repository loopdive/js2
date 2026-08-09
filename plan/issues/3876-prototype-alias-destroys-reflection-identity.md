---
id: 3876
slug: prototype-alias-destroys-reflection-identity
title: "Aliasing a built-in prototype through a local binding destroys its reflection identity"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: reflection, object-model
language_feature: property-reflection
goal: standalone-mode
sprint: current
es_edition: es5
related: [1781, 3254]
---

# #3876 — `var P = X.prototype` destroys reflection identity

## Problem

Binding a built-in prototype to a local variable before reflecting on it
returns a different (wrong) answer than reflecting on it inline. Same object,
same property; the only difference is whether the receiver went through a local
binding.

**Affects BOTH lanes** — this is not standalone-only.

## Measured (2026-07-31, `origin/main` `af7d6f87`)

Apparatus: bare `compile(src, {target})` + `buildImports`, **no test262
frontmatter and no harness assembly**, so no test-harness code is in the
measurement path. Probe: `.tmp/reconcile4.mts`.

```
                                                      host   standalone
INLINE gOPD(RegExp.prototype,'global')                1      1
VAR    P=RegExp.prototype; gOPD(P,'global')           1      0   <- DIFF
INLINE gOPD(RegExp.prototype,'exec')                  1      1
VAR    P=RegExp.prototype; gOPD(P,'exec')             1      0   <- DIFF
INLINE RegExp.prototype.hasOwnProperty('exec')        1      0
VAR    P=RegExp.prototype; P.hasOwnProperty('exec')   1      0
INLINE Array.prototype.hasOwnProperty('push')         1      1
VAR    P=Array.prototype; P.hasOwnProperty('push')    0      0   <- BOTH LANES
```

The `Array.prototype` row is the clearest case: `hasOwnProperty('push')` is
correct (1) inline on both lanes, and wrong (0) on both lanes once the receiver
is a local binding.

## Re-measured through the AUTHORITATIVE harness (2026-07-31)

The table above came from bare `compile()`, which #3885 shows cannot be trusted
for host-lane `Object.*` statics. **The core finding was therefore re-run
through `runTest262File`, both lanes, with four controls** — and it survives,
with its surface wider than originally filed.

```
CONTROLS  keys_inline=true  keys_var=true  ownkey=true  bogus=false   (both lanes)

                    host     standalone
INLINE_arr          true     true
VAR_arr             FALSE    FALSE    <- the defect, BOTH lanes
INLINE_re_exec      true     false    <- standalone: lookup registration (#3875)
VAR_gopd_re         true     FALSE    <- aliasing also reaches gOPD
INLINE_gopd_lit     true     true     <- the retracted claim: NON-defect
```

Two corrections to the filing, both strengthening it:

1. **The aliasing defect is confirmed on BOTH lanes** under the authoritative
   harness with passing controls — not host-only, and not an artifact of the
   bare-`compile()` apparatus that first found it.
2. **It reaches `getOwnPropertyDescriptor` in standalone, not only
   `hasOwnProperty`** (`VAR_gopd_re` false on standalone). The defect's surface
   is wider than the original write-up recorded, so a fix must cover the
   descriptor path as well as the has-own path.

Row 4 (`INLINE_gopd_lit` true on both lanes) is the independent corroboration
of the retraction cited above. Note that the controls **pass** here, which is
what licenses reading any of these rows at all — the standard #3885 sets.

## Why this matters beyond the row count

It is a **measurement hazard as well as a defect**. It silently explains a
harness-vs-bare disagreement that consumed several exchanges between two agents
before it was isolated: one probe used `var P = RegExp.prototype` and the other
used the inline form, and the two apparatuses were blamed before the receiver
shape was.

## Size — measured, not inferred

`dev-es5-coercion` counted the `(var|let|const) X = <Builtin>[.prototype]`
idiom across the full 866-row ES5 standalone wrong-answer cut:
**14 / 866 = 1.6 %**.

- Carry as **~14–25 rows, floor 14**.
- The detector misses aliases via parameter passing, property reads, and
  multi-step assignment, so 14 is a floor, not an exact count.
- An earlier claim by this author that the idiom is "near-universal in
  Sputnik-era tests" was an unmeasured structural inference and is **withdrawn**
  — it was counted and it is 1.6 %.

## Interaction with the lookup-registration fix

The nine `RegExp/prototype/{global,ignoreCase,multiline}` × `{A8,A9,A10}` rows
all open with `var __re = RegExp.prototype;` (e.g. `S15.10.7.2_A8.js`). They
therefore need **both** the lookup-registration fix **and** this one. A
"replicate the `Array.prototype` registration" fix alone will **not** move them,
and would surface as a mystery half-fix after implementation.

By contrast, the ~20 `Object/define*` descriptor rows use
`Object.defineProperty(Array.prototype, …)` **inline** — all 20 verified, 0
aliased. They are unaffected by this issue.

## ~~Related but DISTINCT — inline object-literal argument to `gOPD`~~ RETRACTED

> **RETRACTED 2026-07-31. This defect does NOT exist. Do not implement a fix.**
>
> The section below is preserved for provenance; its conclusion is wrong. It was
> produced entirely by bare `compile()` + `buildImports`, **which cannot measure
> host-lane `Object.*` statics at all** — see the harness issue cross-referenced
> at the end of this note.
>
> **Re-measured through the authoritative harness** (`runTest262File`, a
> test262-shaped probe, both lanes). All correct, host and standalone
> identically:
>
> ```
> keys_len=2 | VAR_def=true | VAR_val=1 | INLINE_def=true | INLINE_val=1
>           | INLINE_writable=true | VAR_missing=true | INLINE_missing=true
> ```
>
> `Object.getOwnPropertyDescriptor({a:1},'a')` returns a **real descriptor**
> with the right `value` and `writable`; a missing key correctly returns
> `undefined`. There is no inline-vs-variable asymmetry for `gOPD`.
>
> **Independently corroborated from a second apparatus.** The re-run recorded
> below (four controls passing, both lanes) reports `INLINE_gopd_lit` **true on
> host and standalone**. That matters because the two setups had previously
> *disagreed* about scope — one reported variable-bound receivers passing, the
> other found them failing. They now agree the inline `gOPD` claim was an
> artifact. A retraction resting on two apparatus that once disagreed is
> stronger than one resting on a single re-measurement.
>
> **The licensing evidence — why the original measurement is void, not merely
> unreproduced.** Under bare `compile()` the host lane fails its own control:
>
> | probe | host | standalone |
> | --- | --- | --- |
> | `Object.keys({a:1,b:2}).length` **(CONTROL)** | **0** ✗ | 2 |
> | VAR `gOPD(o,'a')` truthy | **0** ✗ | 1 |
> | INLINE `gOPD({a:1},'a')` truthy | **0** ✗ | 1 |
>
> A control returning `0` for `Object.keys(…).length` invalidates every host
> number from that harness. Note it also fails the **variable** form — so that
> harness never supported an inline-vs-variable distinction even on its own
> terms. The table below reports the variable form as CORRECT (`1`); that cell
> is not reproducible and the two runs disagree on it.
>
> **Why this one was expensive.** Most instrument failures here produce false
> *negatives* — a silent zero, a green that means nothing. This one produced a
> false **positive**: a defect report for a bug that does not exist, arriving in
> the clothes of a finding. That is the more costly direction, because it spends
> real implementation time.
>
> **Instrument rule that supersedes point 2 below:** for any `Object.*` /
> `Reflect.*` / prototype-reflection question, measure through `runTest262File`
> in **both lanes**, and include a control that must hold under any spec version
> (`Object.keys({a:1,b:2}).length === 2` is a cheap one). **If the control
> fails, discard the run** — do not read its result. State harness, lane, and
> control outcome whenever such a measurement is reported.
>
> **The underlying harness hazard is filed as #3885** — *bare `compile()` +
> `buildImports` silently under-assembles host-lane `Object.*` statics, so any
> host measurement taken through it is invalid*. That issue carries the
> mechanism, the control-based instrument rule, and the list of wrong
> conclusions this harness produced. **The retraction above does not depend on
> it** — the phantom is disposed of either way, which is the part that needed
> writing down first.

Recorded here deliberately rather than folded in, because it is a separate
observation.

```
                                              host   standalone
gOPD   ({a:1},'a') truthy                     0      1     <- WRONG on host
gOPD   ({a:1},'a') === undefined              1      0     <- WRONG on host
gOPD   var o={a:1}; gOPD(o,'a') truthy        1      1     <- CORRECT
gOPD   ({a:1},'zz') === undefined             1      1     <- CORRECT
hasOwn ({a:1}).hasOwnProperty('a')            1      1     <- CORRECT
propIsEnum ({a:1}).propertyIsEnumerable('a')  1      1     <- CORRECT
```

`Object.getOwnPropertyDescriptor` with an **inline object literal** argument
returns `undefined` on host; binding the literal to a variable first returns a
real descriptor. This is the **same receiver-expression-shape axis, inverted**:
for built-in prototypes inline works and the variable fails; for an object
literal argument to `gOPD` inline fails and the variable works.

Two consequences:

1. ~~It is a real host-lane defect, not a harness limitation.~~ **WRONG — it is
   exactly a harness limitation. See the retraction note above.**
2. ~~**Instrument rule**: any probe passing an inline object/array literal
   directly as an argument is suspect under bare `compile()` — bind it to a
   variable first.~~ **Superseded.** The suspect thing is not the inline literal;
   it is bare `compile()` for host-lane `Object.*` statics in any receiver
   shape. Binding to a variable does not rescue it — the variable form fails
   that harness's control too.

An earlier framing of this as "the host lane has per-route reflection bugs" was
wrong about the axis: it is receiver expression shape, not route.

## Acceptance criteria

- `var P = X.prototype; P.hasOwnProperty(k)` agrees with
  `X.prototype.hasOwnProperty(k)` for every built-in prototype, on both lanes.
- `var P = X.prototype; Object.getOwnPropertyDescriptor(P, k)` agrees with the
  inline form — **on both lanes**. The authoritative re-run shows `VAR_gopd_re`
  false in standalone, so `gOPD` is part of the defect's surface and a
  `hasOwnProperty`-only fix does not satisfy this issue.
- Every verification run states **harness, lane, and control outcome**, per
  #3885. The original filing's bare-`compile()` table does not meet that bar and
  is retained only for provenance.
- ~~`Object.getOwnPropertyDescriptor({a:1},'a')` returns a real descriptor on
  host (the related-but-distinct defect above), or that defect is split into its
  own issue with this one citing it.~~ **DROPPED 2026-07-31 — retracted, see the
  note above. It already returns a real descriptor on host; the contrary
  measurement came from a harness that fails its own control. Implementing
  anything against this criterion would be work against a bug that does not
  exist.**
- `tests/issue-3876.test.ts` permanently covers inline-vs-variable receiver
  parity for `hasOwnProperty` and `getOwnPropertyDescriptor` across at least
  `Array.prototype` and `RegExp.prototype`, on both lanes.
- Any pass-count claim is re-measured per row rather than read off the baseline.

## Not in scope

- **Lookup registration** — `hasOwnProperty` returns 0 for RegExp/String/Object
  prototypes even inline, while `Array.prototype` returns 1. `Array.prototype`
  is a genuine working reference for that route. Separate issue.
- **Enumeration** — `getOwnPropertyNames().length` is a constant 6 in standalone
  for Array/RegExp/String/Object prototypes vs host 40/15/52/12. Broken for
  `Array.prototype` too, so there is **no** working reference for that route.
  Separate issue, harder.
