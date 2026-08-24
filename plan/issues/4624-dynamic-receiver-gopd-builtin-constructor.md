---
id: 4624
title: "standalone: Object.getOwnPropertyDescriptor(obj, name) through a DYNAMIC receiver answers undefined for a builtin constructor — repairs the two vacuous-pass rows #4519 exposed (S15.3.3.1_A1/_A3)"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [4519, 4479, 4506]
origin: "dev-4519 residual 6 (2026-08-23): the −2 its guard cost were vacuous passes riding on exactly this gap. Lead routing decision: repair the descriptor lookup so both rows pass for a real reason."
---

# #4624 — dynamic-receiver gOPD for builtin constructors

## Problem (measured by dev-4519)

| shape | result |
| --- | --- |
| `Object.getOwnPropertyDescriptor(Function, "prototype")`, LITERAL receiver | object ✓ |
| `Object.getOwnPropertyDescriptor(o, "a")` via a dynamic parameter, plain object | object ✓ |
| `Object.getOwnPropertyDescriptor(obj, name)` via a dynamic parameter, `obj = Function` | **undefined** |

`object-runtime.ts` states the rule at `__getOwnPropertyDescriptor`'s
registration: missing own prop / **non-`$Object` receiver → undefined** —
and a builtin-constructor carrier is not a `$Object`. The literal-receiver
form works because a static arm intercepts it before the runtime helper.

Consequence: test262's real upstream `propertyHelper.js` (line 457 reads
`.configurable` off the descriptor) turned `built-ins/Function/prototype/
S15.3.3.1_A1.js` and `_A3.js` into VACUOUS passes — `!undefined` satisfied
the assert. #4519's member-get guard (merged) makes that read throw, so
both rows now FAIL honestly. This issue makes them pass for a real reason.
The exposure class is bounded: of the complete 248-file set calling any
deprecated descriptor verifier, exactly these 2 flip (#4519's Test
Results).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   the three-shape table on current campaign HEAD first.
2. Read the static literal-receiver arm (what does it answer for
   `Function.prototype`? — reuse its answer) and `__getOwnPropertyDescriptor`
   in `object-runtime.ts`. The fix: give the runtime helper an arm for
   builtin-constructor carriers (the #4485/#4621-C carrier family exposes
   callable constructor globals with own `length`/`name`/`prototype`) that
   answers the §20.2.3/§10.2.x-correct descriptor for the own properties
   the carrier actually serves — at minimum `prototype`
   ({writable:false, enumerable:false, configurable:false} for Function
   per §20.2.3). Decline shapes the carrier cannot answer honestly
   (absent-not-wrong) rather than fabricating descriptors.
3. Acceptance rows: `built-ins/Function/prototype/S15.3.3.1_A1.js` and
   `_A3.js` pass; the 246 unmoved verifier files stay unmoved (re-run the
   248-file set, own runs, both arms).
4. Pins: tests/issue-4624.test.ts — the three-shape table as positives,
   verifier-row positives, residual pins for declined shapes.

## Root cause

Not the `$Object`-only rule the problem statement names, and not a
builtin-constructor problem in general. **`Function` is the only builtin whose
VALUE is not a `$Object` carrier**, so it is the only one this hits — measured
on the base, `--target standalone`, real `runTest262File`:

| dynamic-receiver probe                       | base        |
| -------------------------------------------- | ----------- |
| `gOPD(Number, "prototype")`                   | descriptor  |
| `gOPD(Date, "prototype")`                     | descriptor  |
| `gOPD(Function, "prototype")`                 | `undefined` |
| `Function.hasOwnProperty("prototype")`        | `true`      |

`Number`/`Date`/… mint the #3006 `__builtin_ctor_*` carrier — a real `$Object`
whose own `length`/`name`/`prototype` `pushBuiltinCtorOwnPropSeed` seeds, so
every dynamic MOP surface already worked. A bare `Function` read is an
`intrinsic-value` boundary site and arrives as the
`$RuntimeEvalInterpretedCallback` marker (`function-intrinsic-carrier.ts`), a
nominal struct. #4491 T7-B taught `__hasOwnProperty` / `__object_hasOwn` /
`__delete_property` about that marker but **not**
`__getOwnPropertyDescriptor` — so PRESENCE said "own" while the DESCRIPTOR said
"absent", which is precisely the two-surfaces-disagree defect #4491 set out to
remove.

`propertyHelper.js`'s deprecated verifiers read the descriptor DIRECTLY
(`.writable` line 411, `.configurable` line 457). Before #4519 that was
`!undefined` — true — so `S15.3.3.1_A1/_A3` passed for no reason; after #4519
the same read throws and they failed honestly. Everything else those two rows
need (`isWritable`, `isConfigurable`, the `delete` half, `hasOwnProperty`)
already worked, which is why the descriptor was the whole fix.

## Fix

One file: `src/codegen/runtime-eval-intrinsic-own-props.ts` (+219/−58, the bulk
of it doc). A fourth widened native — `__getOwnPropertyDescriptor`
`(externref, externref) -> externref` — spliced at the front of the body behind
the SAME marker+string-key guard the presence/delete trio uses (extracted into
`unshiftIntrinsicFunctionArm` so the surfaces cannot drift apart):

| key         | value source                                          | attributes (§20.2.2 / §17) |
| ----------- | ----------------------------------------------------- | -------------------------- |
| `prototype` | `buildLazyNativeProtoGetInstrs(Function)` — the identity-stable `$NativeProto` singleton | `{w:F, e:F, c:F}` (flags `0`) |
| `length`    | `BUILTIN_CTOR_ARITY["Function"]` = 1, boxed           | `{w:F, e:F, c:T}`          |
| `name`      | the literal `"Function"`                              | `{w:F, e:F, c:T}`          |

Every value is the SAME source the LITERAL-receiver fold
(`builtin-static-gopd.ts`) uses, so `gOPD(Function,"prototype").value ===
Function.prototype` holds through either path (pinned). Design constraints
honoured:

- **Absent-not-wrong.** Each key is emitted only when its value is producible.
  `buildLazyNativeProtoGetInstrs` answers `null` unless the `Function` proto
  glue is registered (a module that mentions `Function.prototype`
  syntactically), and registering glue at FINALIZE is out of regime — so the
  `prototype` key DECLINES there rather than fabricating a value. Residual R1
  below, pinned.
- **No finalize-time shifts.** `__create_descriptor` / `__box_number` are
  resolved by name from `funcMap`, never via a fresh `ensureLateImport`.
  `prependBuiltinFnObjectSemantics` reaches the same proto singleton the same
  way, in the same finalize phase.
- **Receiver-disjoint front position.** The guard is `ref.test` on a nominal
  marker struct, so it cannot shadow the `$Object` walk or the proxy / vec /
  TA-view arms that also `unshift` into this body. Pinned with a plain-object
  control.
- Host/gc bytes untouched (`!ctx.standalone` early return); a standalone module
  with no marker type is byte-identical.

## Test Results

All numbers below are from runs I executed on this branch, base =
`.tmp/base-runtime-eval-intrinsic-own-props.ts` restored into the tree (file-copy
A/B, never `git stash`).

**Three-shape table** (the issue's acceptance table), lane-measured:

| shape                                                    | base      | after  |
| -------------------------------------------------------- | --------- | ------ |
| `gOPD(Function, "prototype")`, LITERAL receiver           | object    | object |
| `gOPD(o, "a")` through a parameter, plain object          | object    | object |
| `gOPD(obj, name)` through a parameter, `obj = Function`   | undefined | object |

After: `{writable:false, enumerable:false, configurable:false}` and
`value === Function.prototype`; `length` `{1, F, F, T}`; `name`
`{"Function", F, F, T}`; an unowned key still `undefined`.

**248-file deprecated-verifier set, complete, both arms.** Same predicate as
#4519 (any of the six `verify{Not,}{Configurable,Writable,Enumerable}`
identifiers in an ES≤5 file — 248 files, reproduced exactly):

```
before: 243 pass / 5 fail        after: 245 pass / 3 fail
fail -> pass  built-ins/Function/prototype/S15.3.3.1_A1.js
fail -> pass  built-ins/Function/prototype/S15.3.3.1_A3.js
flips: 2  (the 246 others unmoved, 0 regressions)
```

The 3 still-failing rows fail identically on both arms and are unrelated
(`S15.3.5.2_A1_T1` — a `Function(...)`-minted function's own `prototype`;
`15.2.3.7-6-a-231`; `15.2.3.6-4-195`).

**370-file `built-ins/Function` ES≤5 directory sweep, both arms:**

```
before: 336 pass / 33 fail / 1 CE    after: 338 pass / 31 fail / 1 CE
flips: 2 — the same two rows. 0 regressions.
```

**Pins — `tests/issue-4624.test.ts`, 15 tests**, green in three configurations:
plain, `--sequence.shuffle`, and `JS2WASM_EVAL_ENGINE=interpreter` (the CI
`quality` tier, refusal provider built via
`scripts/build-runtime-eval-provider.mjs --refusal-only`). **They are shown to
bite:** re-run with the base file restored, **6 of 15 FAIL** (row 3, `length`,
`name`, the presence-vs-descriptor agreement, and both acceptance rows); the 4
controls and the 3 `it.fails` residuals pass on both arms, which is exactly the
job of a control.

One control row was swapped during this work: the obvious neighbour
`built-ins/Function/prototype/S15.3.5.2_A1_T2.js` runs `Function(void 0, "")`,
which the refusal provider throws on by design — it fails under
`JS2WASM_EVAL_ENGINE=interpreter` on BOTH arms for a reason unrelated to
descriptors. Replaced with `built-ins/Function/prototype/call/S15.3.4.4_A10.js`
(same verifier family, a builtin-FUNCTION receiver the arm must not claim).

**Neighbouring suites, green:** `issue-4519` + `issue-4479` (32),
`issue-4491-function-binding-widening` + `issue-4442` + `issue-4485` (36),
`issue-4464` + `es5-standalone-descriptors` + `es5-standalone-instanceof` (42).

**Gates:** `typecheck` clean · `biome lint` clean on both changed files ·
`prettier --check` clean · `check:oracle-ratchet` OK (+0 raw checker usage) ·
`check:coercion-sites` OK · `check:func-budget` OK · `check:loc-budget` OK (no
allowance needed) · `check:stack-balance` OK (no fixup-bucket increases) ·
`check:dead-exports` OK · `check:host-import-policy` OK.

## Residuals

- **R1 — a module that never MENTIONS `Function.prototype` gets no `prototype`
  descriptor** (`length`/`name` still answer). The decline described under Fix.
  Closing it means registering the `Function` proto glue at the marker's MINT
  site (ordinary compile time, in regime) instead of at finalize; that also
  mints the proto global for every module reading bare `Function`, so it needs
  its own byte/cost measurement. Owner: this file's family (#4491/#4624).
  Pinned `it.fails`. Not hit by any propertyHelper row — the harness always has
  `Function.prototype.call.bind(...)`.
- **R2 — `Object.getOwnPropertyNames(Function)` still omits all three keys.**
  Enumeration was not widened by #4491 and is not widened here; it needs an
  own-names arm on the marker (`obj → vec`), a different shape from a
  descriptor arm. Owner: #4491 family. Pinned `it.fails`.
- **R3 — `delete Function.length` still does not remove it** although the
  descriptor now says `configurable: true`. #4491's stated residual (no store
  on the marker to tombstone in); the fix is the cross-module marker-slot ABI
  change #4491 priced and declined. This issue makes the asymmetry visible
  through a second surface but does not create it — the literal-receiver fold
  has always answered `c:true` here. Pinned `it.fails`.
- **R4 — a GENERIC marker** (the result of `Function(src)`) has no `prototype`
  descriptor. Deliberately out of scope for the same reason #4491 gives: no
  `prototype` OBJECT exists to hand back, so claiming one would be a lie.
  `built-ins/Function/prototype/S15.3.5.2_A1_T1.js` is the row; it fails
  identically on both arms.
