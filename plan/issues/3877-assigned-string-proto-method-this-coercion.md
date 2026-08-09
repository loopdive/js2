---
id: 3877
slug: assigned-string-proto-method-this-coercion
title: "Standalone: assigned String.prototype method on a non-string `this` returns null"
status: wont-fix
duplicate_of: 2742
created: 2026-07-31
updated: 2026-07-31
completed: 2026-07-31
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, string-ops
language_feature: this-coercion
goal: standalone-mode
sprint: current
es_edition: es5
related: [1781, 2742, 3254]
---

> **DUPLICATE of #2742 — closed 2026-07-31. All measured content moved there.**
>
> #2742 ("String.prototype methods: ToString(this) generic-receiver coercion,
> RequireObjectCoercible, and function `.length` own property") states this exact
> defect and predates this issue by three days. Its `func-budget-allow` already
> names `src/codegen/string-ops.ts::compileNativeStringMethodCall` — the same
> code.
>
> **Why this was NOT kept as an "assigned-method sub-case".** The tempting split
> is `obj.m = String.prototype.m; obj.m()` versus `String.prototype.m.call(obj)`.
> The measurement rejects it: the per-method call helpers are **structurally
> identical** between working and failing members (`call 120` member-lookup then
> `call 171` invoke, same shape, opposite outcomes). Assigned-method vs `.call()`
> is a **test-shape** distinction, not a defect axis — keeping a separate issue
> would enshrine a split this issue's own evidence rejects.
>
> **How this duplicate came to exist**, recorded because the gap is reusable:
> `pre-dispatch-gate.mjs` was run on a **freshly allocated id**, which can find
> nothing _by construction_. It protects against id collision; it does **not**
> protect against filing a new issue for a symptom family that already has one.
> The rule — _search existing issues for the SYMPTOM before allocating an id, not
> the id after allocating it_ — is filed on #3879 with this as the worked example.
>
> Not deleted: the id is spent, and a dangling reference is worse than a
> tombstone. **#3887 / #3888 are unaffected** — "TypeError never raised" is a
> different family from ToString coercion.

# #3877 — `obj.m = String.prototype.m; obj.m()` on a non-string `this`

## Problem

ES5 §15.5.4.x: every `String.prototype` method performs
`ToString(CheckObjectCoercible(this))`. Under `--target standalone`, assigning a
`String.prototype` method onto a non-string object and invoking it as a method
returns **`null`** instead of operating on the coerced receiver.

```js
var b = new Boolean();
b.toUpperCase = String.prototype.toUpperCase;
b.toUpperCase(); // host "FALSE"  ·  standalone null
```

## The property round-trip is NOT the problem

Twin control, both lanes, same file:

```
standalone: typeof=function  identity=true  hasOwn=true
            String(b)="false"  toUpperCase.call(b)="FALSE"  b.toUpperCase()=null
```

`typeof`, `===` identity against `String.prototype.toUpperCase`, and
`hasOwnProperty` are all correct. `ToString` on the receiver is correct. The
`.call()` form on the **identical receiver** is correct (that is #3254). Only
the assigned-method invocation fails.

## Measured per-method matrix

Receiver `new Number(1234)` (`ToString` → `"1234"`), every method invoked as an
assigned own property. Harness: `runTest262File(abs, cat, 60000)` and
`(…, "standalone")` on the same file (`.tmp/probe-3877-matrix.js`).
**Controls `Object.keys({a:1,b:2}).length===2`, `"ab".toUpperCase()==="AB"`,
`String(new Boolean(false))==="false"` all pass on both lanes**, so these
readings are load-bearing (per #3885).

| method        | host    | standalone |
| ------------- | ------- | ---------- |
| `substring`   | `23`    | `23` ✅    |
| `charAt`      | `2`     | `2` ✅     |
| `toUpperCase` | `1234`  | **`null`** |
| `toLowerCase` | `1234`  | **`null`** |
| `slice`       | `23`    | **`null`** |
| `charCodeAt`  | `49`    | **`null`** |
| `indexOf`     | `1`     | **`null`** |
| `lastIndexOf` | `1`     | **`null`** |
| `trim`        | `1234`  | **`null`** |
| `concat`      | `1234X` | **`null`** |
| `split`       | `2`     | **`0`**    |

**9 of 11 broken; `substring` and `charAt` already work.** As with
`Array.prototype` in #3876, a working reference exists in-tree — the fix is
very likely to route the other nine the way those two already go, rather than
to invent a mechanism.

## This supersedes the original framing — read before implementing

This issue was opened on the diagnosis _"the §22.1.3 preamble is applied at the
borrowed `.call()` site (`emitBorrowedStringReceiverToString`, #3254) but not at
assigned-method dispatch."_ That is **incomplete**: `substring` and `charAt`
reach the correct answer through the same nominal assigned-method dispatch, so
"the dispatch site has no preamble" cannot be the whole cause. The real question
is why those two coerce and the other nine do not.

Starting point: `compileNativeStringMethodCall`'s `emitReceiver`
(`src/codegen/string-ops.ts`) already handles two receiver shapes — externref →
native string, and a concrete object struct ref → `tryStructToString` (the
§22.1.3 ToString dispatch). Establish first **whether the nine even reach
`compileNativeStringMethodCall`**, or whether they are compiled as a generic
dynamic method call that never consults it. Do not assume; the matrix above says
the two paths diverge somewhere and the divergence has not yet been located.

### Dead end already excluded — do not repeat it

`src/codegen/expressions/call-receiver-method.ts` (~line 2311) guards the
guarded-native-string fast path with

```ts
!(propAccess.name.text === "substring" && sourceHasMethodReassignment(ctx, propAccess.expression, "substring")) &&
```

This looks exactly like the cause: `sourceHasMethodReassignment` is already
generic in `methodName` and only the **call site** is hard-coded to
`"substring"` — the one method that works. **It is not the cause.**

Generalising it to
`!sourceHasMethodReassignment(ctx, propAccess.expression, propAccess.name.text)`
and re-running the matrix produced **byte-identical standalone output** — all
nine still `null`. The conditional block is therefore not being entered for
these calls at all (some earlier predicate in the same `if` — `ctx.nativeStrings`,
`receiverMayBeNativeStringAtRuntime`, or the `STRING_METHODS` name test — already
excludes them), and the `null` originates **downstream in the generic dynamic
method dispatch**, not in the native-string fast path.

The change was reverted rather than shipped: it had no measured effect, so it is
an unproven edit, and it would also widen a perf-relevant bail-out on nothing but
a plausible story.

## SITE LOCATED — the per-method `__proto_method_*` wrapper

Found by diffing the two arms rather than by instrumenting, using the working
(`charAt`) and broken (`charCodeAt`) pair with everything else held constant.

**A faithful repro is required and is easy to get wrong.** With
`const a: any = new Number(1234)` (TypeScript, `any`-annotated) the split does
**not** reproduce — `charAt` returns null there, unlike the matrix. The repro
must be plain JS shape, `var a = new Number(1234)`, compiled with
`{ target: "standalone", allowJs: true }`. Verified to reproduce all four arms
(`charAt` works, `charCodeAt` null, `substring` works, `slice` null) before any
diff was read. `.tmp/diff-arms2.mts` is the control; `.tmp/diff-arms3.mts` dumps
the WAT.

**The call-site bodies are identical.** Diffing the emitted `$test` bodies for
`charAt` vs `charCodeAt` yields exactly one line — my own argument constant
(`f64.const 1` vs `f64.const 0`). Both emit the same generic dynamic dispatch
(`call 201`) on a value materialised as `ref.func`. So the defect is **not** at
the call site, and not in the generic dispatch either.

**It is inside the materialised wrapper.** Both modules generate
`$__proto_method_<brand>_<member>` (`native-proto.ts:509`), and diffing those two
functions shows the divergence:

- `charAt`'s wrapper contains a receiver-coercion step —
  `global.get 14 / extern.convert_any / call 128`, then
  `ref.cast null (ref null 6)` (`$AnyString`) before the native helper.
- `charCodeAt`'s wrapper has **no** such step: it goes straight to
  `struct.get 7 0` on the raw receiver, so a non-string `this` yields null.

The wrapper body comes from `glue.emitMemberBody(ctx, closureFctx, member, kind)`
in `createNativeProtoMember` (`src/codegen/native-proto.ts`, ~line 537). The
§15.5.4.x `ToString(CheckObjectCoercible(this))` preamble is therefore
**per-method, emitted by the String glue's `emitMemberBody`**, and is present for
`charAt`/`substring` and absent for the other nine.

**Do not** re-verify through bare `compile()` with an `any`-annotated receiver —
that is the shape that does not reproduce.

## The obvious fix is WRONG — enumerate the readers before writing

The natural plan is _"hoist the §15.5.4.x preamble out of the per-method arms
into the shared `kind === "method"` wrapper prologue for the String brand."_
Enumerating what actually emits those bodies kills it.

**(a) The wrapper machinery is standalone-only.** Compiling the same source on
both lanes: the host module contains **0** `__proto_method_*` wrappers,
standalone contains one per member. So host does not work "because it has the
preamble" — host never goes near this code. That retires the cross-lane
regression risk (the #3871 shape) for any change confined to these wrappers, and
it also means host correctness here is evidence about a _different_ code path.

**(b) Most of the nine have no member body at all.**
`emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts:812`) is a
per-member dispatch:

| member                               | body                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `substring`                          | `emitStringSubstringMemberBody`                                                 |
| `indexOf`, `lastIndexOf`             | `emitStringSearchNumericMemberBody`                                             |
| `includes`, `startsWith`, `endsWith` | `emitStringSearchBooleanMemberBody`                                             |
| `trim`, `trimStart`, `trimEnd`       | `emitStringTrimMemberBody`                                                      |
| `charAt`                             | `emitTransferredCharAtProtoMemberBody` (ROC + coercion passed as callbacks)     |
| `at`, `charCodeAt`, `codePointAt`    | inline path — **already does** `emitStringRequireObjectCoercible` then ToString |
| **everything else**                  | `emitProtoMemberBodyRefusal`                                                    |

`toUpperCase`, `toLowerCase`, `slice`, `concat`, `split` are in **no** arm, so
they reach the refusal — which is supposed to emit a catchable
`"…is not yet implemented in --target standalone"` **TypeError**.

**So there is no missing preamble to hoist.** There is nowhere central that
nine arms are failing to call.

## The real question, unresolved — two anomalies

1. **`charCodeAt` already performs ROC + ToString** (the inline arm, steps (1)
   and (2) in the source) and still returns `null` on a non-string `this`. So
   having the preamble is not sufficient; something downstream of it in that arm
   discards the coerced value.
2. **`toUpperCase` / `slice` / `concat` should throw a loud TypeError** via
   `emitProtoMemberBodyRefusal` and instead return `null` silently. A refusal
   degrading to a silent wrong value is a **worse** defect than the missing
   feature it stands for, and it is the same silent-wrong-value family as the
   bare-`compile()` hazard in #3885.

Anomaly 2 is arguably the higher-value fix: a loud refusal is correct behaviour
for an unimplemented member, and turning silent `null`s back into throws is both
smaller and strictly safer than implementing nine member bodies.

**Acceptance bar for whoever implements** (unchanged, and it is 11/11 on BOTH
lanes, not "the nine nulls are gone"): run the full matrix before and after on
both lanes and report both columns; `charAt` and `substring` must still pass —
if a change breaks them the change is wrong, not the references; and the fix
must be seen to fail with a kill-switch (revert it, confirm the matrix returns
to nine `null`s) before it is believed.

`split` returning `2` on host and **`0`** on standalone is a wrong number rather
than a `null` and has not been attributed to either anomaly — do not let it ride
along unexamined.

## Scope of anomaly 2 is UNRESOLVED — and the probe that failed says why

The deciding question is whether the refusal→`null` degradation is String-only
(small, safe, fix in place) or general to `emitProtoMemberBodyRefusal` (a
correctness **and measurement-integrity** bug — refused features that should
raise loud classifiable errors instead answer quietly wrong, so standalone
conformance may be mis-attributing an unknown number of rows).

**Call-site census.** `emitProtoMemberBodyRefusal` has **16** call sites in
`src/codegen/array-object-proto.ts` (+1 reference in `native-proto.ts`). Several
pass a generic brand `name` rather than `"String"` — notably
`makeGlueWithGetters` (~1618), whose `emitMemberBody` routes **every** member of
its brand to the refusal. `ArrayBuffer` and `DataView` are registered through it.
So the refusal is **not** String-specific machinery.

**The cross-brand probe could not answer it, because its throw-detector fails on
the lane under test.** Probe returns `2` = threw, `1` = value, `-1` =
null/undefined:

```
case                                    host   standalone
String/toUpperCase  (refusal-routed)    1      -1
String/slice        (refusal-routed)    1      -1
ArrayBuffer/slice   (refusal-routed)    2      -1
DataView/getInt8    (refusal-routed)    2      -1
String/charAt       (CONTROL, works)    1       1     <- control PASSES
CONTROL throw       (must be 2)         2      -1     <- control FAILS
```

The throw control is `var a = null; a.nosuch()`, which must raise a TypeError
under any spec version. Host gives `2`. **Standalone gives `-1`.** So on the
standalone lane this probe cannot distinguish "the refusal threw" from "the
refusal returned null" — every standalone cell reading `-1` is exactly what a
blind instrument reports. **Discard the standalone column; the scope question
stands open.**

### RESOLVED — detector built, census answered, swallow hypothesis re-falsified

The prerequisite detector **was** buildable. `7` = threw and was caught:

```
case                                      host   standalone
DETECTOR hand-written throw/catch         7      7
DETECTOR throw from a callee              7      7
DETECTOR instanceof TypeError in catch    7      7
#3468 function-object own property        7      7    <- #3468's mechanism is FIXED on main
OBSERVED null-receiver method call        7      1    <- returns normally, never throws
```

**Throws propagate and are caught correctly in standalone.** So the
"standalone swallows throws" hypothesis is falsified a second time, now by
direct measurement rather than by citation — consistent with #3468
(`status: done`, completed 2026-07-24), whose title already records
_"root cause is function-object own-property gap, NOT a catch_all swallow"_.
**Nothing is being caught because nothing is being raised.** Anyone tempted to
re-open the swallow theory should stop here; this is its third grave.

**#3468's own mechanism no longer reproduces** — `f.m = function(){}` then
`typeof f.m === "function"` returns `7` in standalone on current `main`. The
observations below are therefore **not** residue of #3468.

**Census re-run with the proven detector — the degradation is GENERAL, not
String-specific:**

```
case                              host   standalone
DETECTOR CONTROL (must be 7)      7      7      <- instrument proven on the lane
String/toUpperCase (refusal)      1      -1
String/slice       (refusal)      1      -1
String/concat      (refusal)      1      -1
ArrayBuffer/slice  (refusal)      7      -1     <- host THROWS, standalone nulls
DataView/getInt8   (refusal)      7      -1     <- host THROWS, standalone nulls
String/charAt      (works)        1       1
String/charCodeAt  (anomaly 1)    1      -1
```

`ArrayBuffer` and `DataView` refusal-routed members return `null` on standalone
where host correctly throws. Since the detector proves a raised TypeError _would_
be caught, `emitProtoMemberBodyRefusal` is **not raising one** — across brands.

**Consequences.** The fix belongs in the refusal emitter, **once**, not in five
String call sites — patching those would leave every other brand silently wrong
while looking solved. And this is a **measurement-integrity** bug as much as a
correctness one: refused features that should produce loud, classifiable errors
instead answer quietly wrong, so standalone conformance may be mis-attributing an
unknown number of rows.

**Two separable defects, both "TypeError never raised" (NOT "swallowed"):**

1. `emitProtoMemberBodyRefusal` yields `null` instead of raising, across brands.
2. A null-receiver method call (`var a = null; a.nosuch()`) returns normally
   instead of raising TypeError.

Neither is covered by #3468. Both need ids; neither has one yet.

### Superseded reasoning, kept so it is not re-derived

`var a = null; a.nosuch()` returning `null` instead of throwing is itself a spec
violation, and it is upstream of everything above. If a `throw` does not
propagate out of this call path in standalone, that would explain **both**
anomalies at once: the refusal's catchable TypeError and `charCodeAt`'s
`RequireObjectCoercible` throw would both evaporate into `null`, which is
precisely the observed shape in each case.

That is a hypothesis with one supporting observation, not a finding. Before
acting on it, build a throw-detector that is **demonstrated to work in
standalone** — e.g. a hand-written `throw new TypeError(...)` inside the same
`try`/`catch` shape — and only then re-run the cross-brand census. Without a
detector proven to report `2` on that lane, no scope conclusion is measurable.

## Sibling defect — #3254 is FALSE-DONE on its own headline method

#3254 (`status: done`, completed 2026-07-13) is titled _"…borrowed
String.prototype.<m>.call receiver"_ and its text claims _"the fix generalises
beyond trim"_, citing _"the ~76 trim-family tests"_. Measured, it generalised to
the other methods and left **`trim` itself** on the pre-fix
`$__any_to_string` `"[object Object]"` terminal. Same probe, controls passing:

```
                                     host      standalone
String.prototype.trim.call(boolObj)  [false]   [[object Object]]
String.prototype.trim.call(numObj)   [123]     [[object Object]]
String.prototype.toUpperCase.call(numObj)  123 123            <- works
```

So `.call()` is fixed for the other methods and **not** for `trim`. #3254's
`status: done` is wrong and should be corrected by whoever lands the `trim`
half. That is a separate ~10 rows from this issue's ~51.

## Size

~51 ES5 standalone rows carry the assigned-method shape (from the
`built-ins/String/prototype` wrong-answer cut of 97). Treat as a **ceiling, not
a flip count** — the matrix shows the shape is method-dependent, so rows using
`substring`/`charAt` are already passing and must not be counted.

## Acceptance criteria

- `obj.m = String.prototype.m; obj.m()` agrees with
  `String.prototype.m.call(obj)` and with the host lane, for every method in
  the matrix above, on a boolean-object, number-object, plain-object-with-
  `toString`, and array receiver.
- A receiver whose `toString` throws propagates that exception
  (§15.5.4.x ToString dispatch), rather than returning `null`.
- `null` / `undefined` receivers throw `TypeError` (RequireObjectCoercible).
- `tests/issue-3877.test.ts` permanently covers the matrix, both lanes.
- Every verification run states **harness, lane, and control outcome** (#3885).
- Any pass-count claim is re-measured per row, not read off the baseline.

## Not in scope

- The `trim`-specific `.call()` hole (see above) — same area, separate fix and
  separate ~10 rows.
- `split` / `concat` "not yet implemented in `--target standalone`" refusals,
  which are a distinct missing-builtin surface.
