---
id: 2742
title: "String.prototype methods: ToString(this) generic-receiver coercion, RequireObjectCoercible, and function `.length` own property"
status: in-progress
sprint: current
created: 2026-06-27
updated: 2026-08-12
assignee: ttraenkler/codex-es5-string
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: string-methods
goal: es5
related: [2670]
depends_on: []
# (#3102 ratchet) Accessor-return marshalling belongs beside its sibling
# host-value bridges and closure caches in runtime.ts. The merge-group
# regression repair also needs source rest-parameter metadata and one narrow
# emitted classifier: the generic host dispatcher cannot materialize a rest vec,
# so the runtime must classify that source shape before exposing the closure.
# PR #3753 keeps lastIndexOf's method-specific NaN fallback beside the shared
# native-string integer-argument lowering.
# (#2742 s78-dev2) The standalone arm of this issue lands in the reflective
# String proto member-body dispatcher: the superseded #2875 wiring that
# intercepts ahead of #3254's corrected borrowed-receiver path lives in
# array-object-proto.ts, and the transferred-shape arms it composes with live
# in char-at-transfer.ts / vec-props.ts / native-proto.ts.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/char-at-transfer.ts
  - src/codegen/native-proto.ts
  - src/codegen/vec-props.ts
  - src/runtime.ts
  - src/codegen/closure-exports.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/string-ops.ts
  - src/codegen/binary-ops-typed-dispatch.ts
  - tests/issue-2742-native-string-equality.test.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
coercion-sites-allow:
  - src/codegen/binary-ops-typed-dispatch.ts
---

# #2742 — String.prototype generic-receiver `ToString(this)` coercion

Every `String.prototype` method begins with `RequireObjectCoercible(this)` then
`ToString(this)` — it must work when `this` is **not** a primitive string
(a `Number`/`Boolean`/`Array`/plain-`Object` wrapper, or `null`/`undefined`).
Our implementations assume a string receiver, so the large
`built-ins/String/prototype/*` cluster fails on the generic-receiver path. This
mirrors #2670 (Array generic array-like receiver) but for String, and is a
single clean root cause spanning ~50 tests.

## Failing patterns / test262 files (current main)

**(a) Non-string `this` must be `ToString`-coerced** (e.g.
`__instance = new Object(42); __instance.charAt = String.prototype.charAt;
__instance.charAt(0)`):

- `test/built-ins/String/prototype/charAt/S15.5.4.4_A1_T1.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A1_T1.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T1.js`
- `test/built-ins/String/prototype/lastIndexOf/S15.5.4.8_A1_T1.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A1_T1.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T1.js`,
  `…/S15.5.4.15_A3_T2.js`, `…/S15.5.4.15_A3_T4.js`
- `test/built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js`

**(b) `null`/`undefined` `this` must throw a real `TypeError`
(`RequireObjectCoercible`), not an internal null-deref:**

- `test/built-ins/String/prototype/charAt/S15.5.4.4_A2.js`,
  `…/charAt/S15.5.4.4_A1.1.js`, `…/charAt/S15.5.4.4_A5.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A2.js`,
  `…/charCodeAt/S15.5.4.5_A4.js`
- `test/built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js`,
  `…/slice/S15.5.4.13_A1_T5.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A3_T7.js`,
  `…/substring/S15.5.4.15_A3_T10.js`

**(c) `this` whose `valueOf`/`toString` must run through `ToPrimitive`/`ToString`
ordering (trim family):**

- `test/built-ins/String/prototype/trimStart/this-value-object-tostring-meth-priority.js`
- `test/built-ins/String/prototype/trimEnd/this-value-object-toprimitive-meth-priority.js`
- `test/built-ins/String/prototype/trimStart/this-value-object-valueof-meth-priority.js`
  (currently `Cannot convert object to primitive value` runtime traps)

**(d) Each `String.prototype.X` must expose a `length` own data property
(function arity):**

- `test/built-ins/String/prototype/charAt/S15.5.4.4_A8.js`
- `test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A8.js`
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A8.js`
- `test/built-ins/String/prototype/substring/S15.5.4.15_A8.js`

## Acceptance criteria

- Group (a): a `String.prototype` method invoked with a non-string `this`
  (`new Number(n)`, `new Boolean(b)`, `new Array(...)`, plain object) coerces via
  `ToString(this)` and returns the spec result. ≥8 of the listed (a) files pass.
- Group (b): `null`/`undefined` `this` throws `TypeError`; ≥7 of the listed (b)
  files pass (no `dereferencing a null pointer` / `Cannot access property` trap).
- Group (c): the trim-family `this`-ToPrimitive ordering tests stop trapping;
  ≥2 of 3 pass.
- Group (d): `String.prototype.{charAt,charCodeAt,indexOf,substring}.hasOwnProperty('length')`
  is `true`; all 4 listed (d) files pass.
- **Target: ≥40 of the ~66 ES3-core `String.prototype` generic-receiver tests
  fixed.** No regression in currently-green String tests.

## Implementation notes

**Group (d) fixed** (PR #2742-d carve-out, 2026-06-27): The test runner was
incorrectly transforming `obj.propertyIsEnumerable(key)` → `obj.hasOwnProperty(key)`
globally, which masked the non-enumerable nature of builtin function `.length`.
The codegen (`compilePropertyIntrospection`) already correctly emits
`__propertyIsEnumerable` for `externref` receivers (native functions), which
delegates to `Object.prototype.propertyIsEnumerable.call(obj, key)` in the
runtime — returning `false` for the non-enumerable `.length` own property. Fix:
removed the two blanket `propertyIsEnumerable→hasOwnProperty` transforms from
`wrapTest()` in `tests/test262-runner.ts`. All 4 group-(d) test262 files now pass;
no regressions in currently-passing tests.

**Groups (a)/(b)/(c) remain open** — substrate-gated (generic-receiver
`ToString(this)` coercion). Tracked in this issue; assigned separately.

## Scope / out of scope

- IN: charAt, charCodeAt, indexOf, lastIndexOf, slice, substring, concat,
  trim/trimStart/trimEnd generic-receiver + `ToString(this)` + `.length`.
- OUT: regex-driven methods (`match`/`matchAll`/`replace`/`replaceAll`/`split`/
  `search`) — those depend on the RegExp engine residual (#2161); `localeCompare`
  / `normalize` / Unicode case-folding (toLowerCase/toUpperCase locale) — separate
  Unicode-substrate slice; BigInt-argument coercion tests (blocked).
- Spec: ES2023 §22.1.3 String.prototype methods; `RequireObjectCoercible` §7.2.1,
  `ToString` §7.1.17.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — group carve-out. Group (d) (builtin function .length non-enumerable + a test-runner fix) landed. The headline ToString(this) generic-receiver coercion for String.prototype methods (charAt/charCodeAt/indexOf/slice/substring/concat...) + remaining groups remain. Stays in-progress.

## Measurement re-grounding (2026-07-26, opus-loop-d) — the group framing above is WRONG

Before writing code I re-ran the **exact 22 files this issue lists** through
`runTest262File` on `main` @ `e16edd48a`, with a positive control (a String test
expected to pass) and a negative control (a deliberately-wrong expectation) to
prove the harness can report both outcomes. **Baseline: 10 pass / 12 fail.**
Three of this issue's claims do not survive contact with the measurement.

> ⚠️ **LANE CORRECTION (s78-dev2, 2026-08-01): everything in the section below
> was measured on the DEFAULT (JS-host) lane ONLY.** `runTest262File` defaults
> to the host target unless `"standalone"` is passed as its 4th argument. On
> `--target standalone` these same group-(a) shapes still FAIL. So "group (a) is
> essentially ALREADY FIXED" is true of one lane and false of the other, and
> reading it unqualified is how this issue looked done while 157 ≤ES5
> `String/prototype` files were failing standalone-only. Measured 2-lane numbers
> are in "Two-lane decomposition" below. **Do not quote a claim from this
> section without naming the lane it was measured on.**

**1. Group (a) is essentially ALREADY FIXED — 8 of its 9 listed files pass on
`main` today.** `charAt`/`charCodeAt`/`indexOf`/`lastIndexOf`/`slice` +
3× `substring` with a non-string `this` all pass. Only `concat/S15.5.4.6_A1_T10`
fails, and for an unrelated reason (an _argument_'s `toString`, not the
receiver's). The issue's headline — "our implementations assume a string
receiver" — is stale.

**2. Group (b) is MISLABELLED.** It is described as `RequireObjectCoercible`
(null/undefined `this`). It is not: genuine `String.prototype.charAt.call(undefined)`
already throws a proper `TypeError` on `main` (probed directly). The 8 failing
(b) files are two _different_ mechanisms:

- **6 files — "X is not a function".** Shape is
  `__FACTORY.prototype.charAt = String.prototype.charAt; new __FACTORY().charAt(…)`.
  **This is NOT String-specific.** The decisive control: assigning a _plain user
  function_ to a user constructor's prototype (`F.prototype.m = function(){…}`)
  and calling it fails **identically** (`m is not a function`). The real defect is
  **dynamic `F.prototype.X = …` augmentation followed by an instance call** — a
  separate, broader issue that should not be filed under String.
  Note `charAt/S15.5.4.4_A1.1` additionally uses `eval("1")`, so it is
  `runtime-eval`-gated regardless.
- **2 files — `charAt/S15.5.4.4_A5`, `charCodeAt/S15.5.4.5_A4`** ("dereferencing
  a null pointer"). These belong with group (c): the receiver's own
  `toString`/`valueOf` must run and propagate a user throw.

⚠️ **This also corrects the #3626 census's C1 `missing_builtin` classification.**
The census reads the "`X` is not a function" signature (58 corpus-wide) as
_"genuinely missing methods — add/repair the method"_. Measured here, the methods
are **present and correct**; the failure is prototype-chain augmentation. Sizing
any work off "add the missing method" would be sizing off a mislabel.

**3. Group (c) is the one real in-scope defect — root-caused and fixed below.**

## What landed in this slice (group (c) root cause)

Traced through the host-marshalling boundary with the argument actually handed to
V8's native `String.prototype.trim`:

```
arg0: rawIsWasmStruct=false  toStringType=undefined  valueOfType=object
      descs=toString:getter,valueOf:getter   valueOfIsWasmStruct=true
```

`get valueOf() { return function () { … }; }` lowers the inner function to a
**WasmGC closure struct**. The getter itself was already bridged (V8 can invoke
it), but its **return value crossed back raw**, so V8 saw
`typeof o.valueOf === "object"` — not callable. In `OrdinaryToPrimitive`
(§7.1.1.1 step 5.b `IsCallable(method)`) a non-callable method is silently
**skipped**; with `toString` also non-callable the algorithm reaches step 6 and
throws `"Cannot convert object to primitive value"`.

**Fix** (`src/runtime.ts`): `_wrapAccessorGetterReturn` marshals an accessor
getter's return through `_maybeWrapCallableUnknownArity`, which converts only
values `__is_closure` positively identifies and passes everything else through.
Deliberately confined to the **accessor** path — marshalling _generic_ call exits
was tried and reverted for regressing ~85 dstr files (#3123/#2835), which is also
why `wasmClosureDynamicBridge` carves out the `new`-path only.

Post-fix, the receiver now matches V8 exactly on the encoded probe
(`toStringAccessed=1, valueOfAccessed=1`, `trim` → `"xy"`; V8 = 111).

## Honest result — gross fixed and regressions, separately

- **Regressions: 0** (22-file set re-run; equivalence suite green).
- **test262 files flipped by this slice: 0 of 22.** The pass count is 10 → 10.
  The 3 group-(c) files move _past_ the spurious `TypeError` to a deeper
  assertion, but do not flip.
- **New coverage: 3 tests red on the merge base**, green with the fix
  (`tests/issue-2742.test.ts`, group (c) block), plus 2 narrowness/no-regression
  guards green on both.

This slice removes a real spec violation and a whole spurious-`TypeError` class;
it does **not** claim conformance flips it cannot demonstrate.

## Remaining blockers (measured, not guessed)

1. **`@@toPrimitive` on the receiver is never consulted.** With a
   `get [Symbol.toPrimitive]()` present, the encoded probe returns `0` accesses
   where V8 gives `1` (`toString`/`valueOf` are now correct at 1/1). This is what
   still blocks all 3 group-(c) test262 files — they assert the _access counters_,
   not just the value. Symbol-keyed accessors are not reaching the host
   ToPrimitive path.
2. **Dynamic `F.prototype.X = …` then instance call** (the 6 "not a function"
   files) — broader than String; needs its own issue.
3. **`concat/S15.5.4.6_A1_T10`** — argument-side `toString`, unrelated to the
   receiver.

Stays `in-progress`: this closes the group-(c) root cause, not the issue.

## Merge-group regression remediation (PR #3660, 2026-07-26)

The bot-held merge-group run `30187000346` tested immutable merge commit
`ff373100552e1d6c4f9c792a8eecf6e01fadbd23`. Recomputing the gate from its
downloaded candidate artifact against exact selected baseline
`100c90d3b71426b6ec2cf6a6e920878325ac1a02` found 33 stable regressions after
flakiness/quarantine filtering, 42 fine-gate improvements, and signature
`fc7292a8a6f761c1`. The trap ratchet also isolated one new
`illegal_cast`: `test/built-ins/Object/keys/proxy-keys.js`.

There were two causal defects:

1. The first implementation wrapped the already-cached getter bridge in a
   second JavaScript function. Accessor getter identity is observable, so
   `Object.getOwnPropertyDescriptor(o, "x").get === getter` became false and a
   SameValue redefinition of a non-configurable accessor incorrectly threw.
   The repair marks bridge-owned getter functions and marshals the return inside
   that same bridge. No new function replaces the descriptor getter.
2. `proxy-keys.js` returns a source rest closure from an accessor. Rest lowering
   gives that closure one concrete Wasm vec formal, but a native `Proxy` call
   supplies positional host arguments. Sending the first host argument through
   the generic dynamic dispatcher therefore trapped in a concrete `ref.cast`.
   `ClosureInfo` now records the source rest shape and the module emits a narrow
   `__closure_has_rest` discriminator. The accessor bridge leaves such closures
   raw, preserving current-main's accepted `missing_builtin` limitation instead
   of worsening it to an uncatchable Wasm trap. Ordinary zero- and nonzero-arity
   returned functions are still bridged.

No-capture closures reuse a signature-keyed wrapper type. A non-rest closure
with the exact same concrete vec signature is therefore conservatively left raw
too; captured closures retain distinct subtypes. This bounded tradeoff avoids an
ABI change to closure structs in a regression-only repair.

This deliberately does not catch and retry a trapped dynamic call, alter any
Test262 baseline, or broaden generic call-exit marshalling (the latter already
regressed ~85 dstr files in #3123/#2835).

Validation after merging current `main` (`f7d1187fa2c79e0153731308200ebb2c6cac274b`):

- `tests/issue-2742.test.ts`: 15/15 pass, including getter identity,
  non-configurable SameValue redefinition, an arity-1 returned setter, and the
  rest-closure trap guard.
- Exact immutable affected set: 75/75 Vitest cases pass — all 33 stable
  regressions and all 42 fine-gate improvements.
- Exact controls: the three dominant identity regressions pass;
  `proxy-keys.js` reports `missing_builtin` (“not a function”), with no
  `illegal_cast`.

## `lastIndexOf` NaN-position residual (PR #3753, 2026-07-28)

Standalone lowering now preserves `lastIndexOf`'s from-end sentinel when a
position expression coerces to `NaN` or `undefined`. Other integer-indexed
String methods retain their ordinary NaN-to-zero behavior.

Exact local-vs-local Test262 A/B on base `c5bd4631724afa`:

- JS-host directory: 19/25 → 19/25; ES5 subset: 15/21 → 15/21.
- Standalone directory: 15/25 → 17/25; ES5 subset: 11/21 → 13/21.
- Fail→pass: `S15.5.4.8_A1_T10.js` and `S15.5.4.8_A4_T3.js`.
- Pass→fail: none. Every remaining failure kept the same normalized signature.

---

# Standalone re-grounding (s78-dev2, 2026-08-01)

Sprint 78 lever: raise ≤ES5 conformance in the **standalone** lane. Everything
below is measured; where a hypothesis was refuted, the refutation is kept
because it is the expensive part.

## Two-lane decomposition — this is a LANE GAP, not "unimplemented"

Scope: `built-ins/String/prototype/**` filtered to `es5id:` frontmatter.
Sources: `.test262-cache/test262-standalone-current.jsonl` and
`test262-current.jsonl`, same baselines run `20260801-010858`.
**Rows floored:** 630 es5id files exist; 630 have a standalone row, 629 have a
default row, so **629 are comparable**. The 1 missing row is reported, not
silently dropped.

| lane           | pass    | of 629 |
| -------------- | ------- | ------ |
| **standalone** | 412     | 65.5 % |
| **default**    | 552     | 87.8 % |

2×2 over the same 629 files:

| bucket                                | n       |
| ------------------------------------- | ------- |
| pass in BOTH lanes                    | 395     |
| fail in BOTH lanes                    | 60      |
| **default passes, standalone fails**  | **157** |
| standalone passes, default fails      | 17      |

**157 vs 60 settles it**: the dominant failure mode is a standalone lane gap,
not a feature nobody implemented. Excluding the 51 RegExp-engine codegen
refusals (explicitly out of this issue's scope), 119 of 166 standalone failures
pass on default (71.7 %).

Causal buckets of the 218 standalone ≤ES5 failures (host-pass count in
brackets — that is what turns "a failure" into "a standalone-only defect"):

| n   | bucket                                   | host-pass |
| --- | ---------------------------------------- | --------- |
| 113 | assertion mismatch                       | 82        |
| 51  | RegExp-engine refusal (OUT of scope)     | 38        |
| 24  | null/undefined receiver deref            | 9         |
| 15  | invalid Wasm binary (`__bindfn_*` locals) | 15        |
| 9   | host-import leak                         | 8         |
| 4   | unimplemented in standalone              | 3         |
| 2   | misc                                     | 2         |

## Instrument calibration (do not skip this when re-running)

`runTest262File(file, cat, 60000, "standalone")` — **status only** is
trustworthy (its error category and source location are artifacts; see
`reference_runtest262file_not_ci_path_status_only`). Calibrated against the
fresh standalone baseline on a 15-file subset: **14/14 agree, 0 disagreements**,
and a known-passing file reports `pass`. All A/B below is same-box, same-run,
same-file-list — never a local sweep diffed against a CI baseline.

Two instrument bugs were caught by controls before they could mislead, both
worth knowing:

- `compile()` is **async**. An un-awaited call makes `r.success` `undefined`, so
  **every** case — including a trivial positive control — reads as a compile
  failure. The positive control is the only reason this was caught.
- An ad-hoc "compile, instantiate, call the export, compare the value" harness
  **fails on both lanes** (host needs a real import object; standalone string
  returns do not marshal back naively). Its CONTROL failed, so the entire matrix
  it produced was discarded rather than read. See
  `project_wrapforhost_setexports_harness`.

## REFUTED: "generalize the two hardcoded `charAt` transfer arms"

The obvious fix shape, and it is wrong. `src/codegen/char-at-transfer.ts` holds
two arms keyed on the **literal string `"charAt"`** —
`buildTransferredCharAtMethodArm` (into `__extern_method_call`) and
`buildTransferredCharAtApplyArm` (into `__apply_closure`). Generalizing them
over the wired member set typechecks clean and flips **0 of 15** files.

The diagnostic that killed it, rather than a rationalization of the zero:
grep the emitted WAT for `__proto_method_\d+_<member>`. In the
`__instance = new Object(42); __instance.charCodeAt = String.prototype.charCodeAt`
shape **no proto-method closure is minted at all** — *not for `charCodeAt`, and
not for `charAt` either*. Since those arms exist to serve `charAt`, they cannot
be the mechanism by which anything works. The generalization was dead code and
was reverted.

(Also note: the first probe used `(String.prototype as any).charAt`. Per #3642
the **declaration shape** changes the lowering, so an `as any` cast is a
confound — re-probe with the exact untyped test262 spelling.)

## ROOT CAUSE, proven by kill-switch removal

Honest per-(shape, member) matrix, receiver `new Object(42)`, calibrated
instrument, CONTROL (primitive-string receiver) green on every arm. The
kill-switch forces `emitStringProtoMemberBody` to refuse, so the caller falls
through to the legacy lowering:

| arm                       | `String.prototype.M.call(obj)` | `obj.M = String.prototype.M; obj.M()` | total     |
| ------------------------- | ------------------------------ | ------------------------------------- | --------- |
| current `main`            | 5/14                           | 1/14                                  | 6/28      |
| **String wiring refused** | **14/14**                      | 2/14                                  | **16/28** |

The split is exact and inverts this issue's assumption. The members that FAIL
`.call()` are precisely the ones **#2875 wired** (`charCodeAt`, `indexOf`,
`lastIndexOf`, `trim`, `at`, `codePointAt`, `includes`, `startsWith`,
`endsWith`). The ones that PASS are the ones **not** wired (`toUpperCase`,
`slice`, `concat`) and therefore fall through to the legacy path — plus
`substring`/`charAt`, which have bespoke bodies.

**The reflective wiring is currently WORSE than the path it intercepts.**

### Why — a superseded fix that was never removed

- **#2875** added the wired bodies on this stated motivation: *"the reflective
  path returns `undefined` and lands on a legacy `.call` that drops `thisArg`
  and returns 0."* True when written.
- **#3254** (status `done`, sprint 72, 2026-07-13) then added
  `emitBorrowedStringReceiverToString` as a `receiverOverride` on the borrowed
  dispatch, covering **every** method in `STANDALONE_STR_PROTO_METHODS`
  (`calls.ts:6966`) — which contains every member the switch unwires.

So #2875's motivating defect was fixed by #3254 in the legacy path, but the
wiring that existed only to work around it stayed, and now intercepts *ahead* of
the corrected path. This is a **revert of a superseded fix**, not a new feature.

### The removal does NOT cost the descriptor surface (verified, not assumed)

Descriptor/value-read callers pass `refusalBodyFallback: true`, so they still
get a minted closure with correct metadata even when `emitMemberBody` refuses;
only CALL dispatch falls through. Asserted empirically on both arms rather than
read off the comment:

| case                                                | baseline | wiring refused |
| --------------------------------------------------- | -------- | -------------- |
| `String.prototype.charCodeAt.name` / `.length`      | pass     | **pass**       |
| `gOPD(String.prototype,"charCodeAt")` value/writable | pass     | **pass**       |
| `charCodeAt.hasOwnProperty('length')`                | pass     | **pass**       |

## THREE populations — do not conflate them in flip accounting

Removing the wiring fixes exactly one of three. Naming them so the residual is
not later misread as a regression:

- **P1 — literal `String.prototype.M.call(obj)`.** Syntactic; #3254 covers it.
  **Fixed by the removal** (5/14 → 14/14 on the micro matrix).
- **P2 — transferred `obj.M = String.prototype.M; obj.M()`.** The single
  largest sub-bucket (30 ≤ES5 files, 27 host-pass). Goes 1/14 → 2/14 — i.e.
  **essentially untouched**. Legacy does not cover it either. This is a
  genuinely separate second defect and needs its own root-cause pass.
- **P3 — non-syntactic spellings.** `#3254`'s override fires only when
  `typeName`/`methodName` are compile-time constants, so it cannot see:

  | spelling                                             | baseline | wiring refused |
  | ---------------------------------------------------- | -------- | -------------- |
  | `var m = String.prototype.charCodeAt; m.call(o,0)`   | fail     | fail           |
  | `String.prototype.charCodeAt.apply(o,[0])`           | fail     | fail           |
  | `Function.prototype.call.bind(String.prototype.M)`   | fail     | fail           |

  Unchanged by the removal — the wiring was not helping these either. The last
  row is the propertyHelper/uncurryThis idiom and is the **#3571** seam; #3571's
  own S1 analysis (`66ab19f84`) records that its host arm landed via #3635 and
  only the standalone arm remains.

> ## ❌ RETRACTED — "strictly dominant" was FALSE
>
> An earlier revision of this issue claimed the blanket removal *"is strictly
> dominant on everything measured: it fixes P1, regresses nothing, and leaves
> P2/P3 exactly as broken as they already are. It is not a tradeoff."*
>
> **A second sweep falsified that.** A blanket "unwire every member except
> `substring`/`charAt`" causes **13 pass→fail regressions**. See
> "Sweep 2 — the residual-risk population, and the retraction" below.
>
> **Why the first measurement could not see it:** the ≤ES5 scope contains no
> `trimStart`/`trimEnd`/`codePointAt`/`includes`/`startsWith`/`endsWith` tests
> at all, and none of the `*-this-value-not-obj-coercible.js` files. Sweep 1 was
> not wrong; it was **silent** on the population where the cost lives — which is
> exactly what a scope limit does, and why the residual risk was written down
> before shipping rather than after.
>
> The narrowed candidate that survives is below, and it is labelled a
> **prediction**, not a result.

With the caveat above, on the ≤ES5 population the removal fixes P1 and leaves
P2/P3 exactly as broken as they already are.

### P3 sized against the CORPUS — it is the biggest of the three

In the 28-row micro matrix P3 reads as "one spelling of four". That badly
understates it, because the uncurried spelling is how test262 reaches these
methods **at corpus scale**: `harness/propertyHelper.js` builds the uncurryThis
bindings at include time, so every file that includes it routes through the
shape #3254's syntactic override cannot see.

Provenance first, so the sizing is not vacuous — the bindings actually exist in
the harness on disk (4 found):

```
__join                 = Function.prototype.call.bind(Array.prototype.join)
__push                 = Function.prototype.call.bind(Array.prototype.push)
__hasOwnProperty       = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
__propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable)
```

Rows floored: all **48,088** standalone jsonl rows scanned against the corpus on
disk.

| metric                                       | n         |
| -------------------------------------------- | --------- |
| corpus files including `propertyHelper.js`   | **4,898** |
| standalone PASS                              | 1,494     |
| standalone FAIL                              | 3,404     |
| …of those, host PASSES (standalone-only)     | **1,810** |
| ≤ES5 subset                                  | 803 files, 282 fail, **119** host-pass |

For scale: the **entire** ≤ES5 `String/prototype` non-RegExp failure population
— the whole lever this issue was opened on — is **167 files, 119 host-pass**. So
the P3 seam gates roughly **11×** more standalone-only failures corpus-wide than
P1+P2 combined.

⚠️ **1,810 is a population GATED, not a predicted flip count, and the proxy is
weaker here than elsewhere in this issue.** `includes: [propertyHelper.js]` is
evidence the file *routes through* the uncurried shape; it is **not** evidence
that the uncurried shape is *why* that file fails. Many of the 3,404 will fail
for unrelated reasons. Treat 1,810 as an upper bound on what fixing the seam
could reach, and measure the real ratio on a sample before sizing any work off
it. Do not quote this number without this paragraph.

This is the same seam **#3571** documents; its own S1 analysis (`66ab19f84`)
records the host arm landed via #3635 and the **standalone arm is still open**.

## Scoped test262 A/B — the measured flip, and why it is 10 and not 46

Same box, same run, same file list, both arms from one working tree. Scope: the
≤ES5 files under every member directory the switch can touch, **plus 65
`substring/` + `charAt/` files carried as an in-sweep CONTROL** (their bodies are
untouched by the switch, so they must not move).

**Rows floored:** 265 requested / 265 ran on BOTH arms, **0 timeouts, 0 harness
errors** on either arm — so nothing here is contention noise (this mattered: the
box sat at load 15–26 throughout). Arm A independently agrees with the fresh
standalone baseline **264/265**.

| | |
| --- | --- |
| arm A (wiring ON) | **220** / 265 pass |
| arm B (wiring refused) | **230** / 265 pass |
| **fail → pass** | **10** |
| **pass → fail** | **0** |
| **net** | **+10** |
| in-sweep control (65 files) | **0 moved** |

Per directory:

| dir           | n   | A-pass | B-pass | Δ      |
| ------------- | --- | ------ | ------ | ------ |
| trim          | 126 | 114    | 124    | **+10** |
| charAt        | 24  | 19     | 19     | 0      |
| charCodeAt    | 19  | 13     | 13     | 0      |
| indexOf       | 34  | 28     | 28     | 0      |
| lastIndexOf   | 21  | 15     | 15     | 0      |
| substring     | 41  | 31     | 31     | 0      |

### The honest reading: gated 46, flipped 10 (21.7 %)

**Every flip is in `trim/`.** `charCodeAt`, `indexOf` and `lastIndexOf` move by
**zero**, even though the micro matrix showed their `.call()` shape going
fail → pass. That is not a contradiction — it is P1-vs-P2 doing exactly what
this issue predicts:

- the `trim` ≤ES5 tests are written `String.prototype.trim.call(obj)` — the
  **literal P1 shape**, which the removal fixes;
- the `charCodeAt`/`indexOf`/`lastIndexOf` ≤ES5 tests are written
  `__instance.M = String.prototype.M; __instance.M(…)` — the **P2 transferred
  shape**, which the removal does not touch and never claimed to.

So the micro matrix was a correct statement about *shapes* and a bad predictor
of *file counts*, because the corpus does not exercise the shapes uniformly.
**46 was the population gated in this scope; 10 flipped.** Quote the 10.

### This also closes the loop on #3254's reopening

#3254 was reopened 2026-07-31 as false-`done` specifically because it *"left
`trim` itself on the pre-fix `[object Object]` terminal."* The 10 flips are
exactly the `trim` tests. So #3254's fix was **not** incomplete for `trim` — it
was **masked**: the #2875 wiring intercepts ahead of it, so `trim` never reached
the corrected path.

> ### 🚩 DO NOT WRITE A SECOND `trim` FIX
>
> **Whoever picks up #3254: `trim` is already repaired by removing the
> superseded #2875 wiring described above. It is ONE repair, not two.**
>
> A second `trim` fix would be a redundant change against a path that is no
> longer broken, and — because both changes target the same legacy borrowed
> receiver path — the two would make each other's attribution unreadable.
>
> The evidence is the A/B directly above: with the wiring refused, **10 `trim`
> files flip fail→pass and 0 files regress**, with a 65-file in-sweep control
> that does not move. `trim`'s body was never the defect; its *dispatch* was
> intercepted.
>
> If you believe a residual `trim` defect remains after this removal lands,
> re-measure first and quote the file list — do not assume the reopening text
> is still accurate, because it was written while the masking was in effect.

## Sweep 2 — the residual-risk population, and the retraction

The residual risk flagged below was measured rather than shipped around: the
**185** `String/prototype` files sweep 1 did not cover (the wired members with no
`es5id:` tests, plus the non-ES5 files of the members sweep 1 did cover). Same
box, same run, same list, both arms from one tree.

**Rows floored:** 185/185 on both arms, **0 timeouts**, and arm A reproduces the
baseline **exactly** (124 pass / 61 fail). In-sweep control: **0 moved**.

| | sweep 1 (265) | sweep 2 (185) | combined (450) |
| --- | --- | --- | --- |
| fail → pass | 10 | **20** | 30 |
| pass → fail | 0 | **13** | **13** |
| net | +10 | +7 | +17 |

### The 13 regressions are a coherent mechanism, not noise

- **`this-value-not-obj-coercible.js` × 5** (`charCodeAt`, `indexOf`,
  `lastIndexOf`, `trimStart`, `trimEnd`) — these assert that a `null`/`undefined`
  receiver **throws TypeError**. The wired bodies call
  `emitStringRequireObjectCoercible`; the legacy path does not, or not
  equivalently. **The wiring IS load-bearing for RequireObjectCoercible** —
  half of this issue's own title.
- **`trimStart`/`trimEnd` `this-value-{boolean,number,whitespace,line-terminator}`
  × 8** — legacy does not lower those two members correctly at all.

So the #2875 wiring is **not** uniformly superseded by #3254. It is superseded
for *some* members and still load-bearing for others, and only a per-member
measurement can tell them apart.

### Per-directory ledger (both sweeps combined)

| member      | Δ pass | gains | losses | verdict                    |
| ----------- | ------ | ----- | ------ | -------------------------- |
| trim        | +10    | 10    | 0      | **unwire**                 |
| codePointAt | +2     | 2     | 0      | **unwire**                 |
| includes    | +2     | 2     | 0      | **unwire**                 |
| startsWith  | +2     | 2     | 0      | **unwire**                 |
| endsWith    | +2     | 2     | 0      | **unwire**                 |
| trimEnd     | +1     | 6     | 5      | KEEP wired (mixed)         |
| trimStart   | +1     | 6     | 5      | KEEP wired (mixed)         |
| charCodeAt  | −1     | 0     | 1      | KEEP wired                 |
| indexOf     | −1     | 0     | 1      | KEEP wired                 |
| lastIndexOf | −1     | 0     | 1      | KEEP wired                 |
| at          | 0      | 0     | 0      | KEEP wired (no signal)     |
| substring   | 0      | 0     | 0      | control — bespoke body     |
| charAt      | 0      | 0     | 0      | control — bespoke body     |

## ✅ SHIPPED — arm C validated the narrowed carve-out, arm D validated the code

**Arm C** (narrowed unwire: `trim`, `codePointAt`, `includes`, `startsWith`,
`endsWith` only; every regressing member kept wired) over the **full 450**:

| assertion                                            | result                        |
| ---------------------------------------------------- | ----------------------------- |
| rows floored                                          | 450/450, **0 timeouts**       |
| fail → pass                                           | **18**                        |
| pass → fail                                           | **0**                         |
| the 13 blanket-removal regressions held `pass`        | **13/13 held**                |
| in-sweep control (`substring`/`charAt`, 76 files)     | **0 moved**                   |
| **off-target moves** (a member NOT unwired changing)  | **0**                         |

Per directory: `trim` +10, `codePointAt` +2, `includes` +2, `startsWith` +2,
`endsWith` +2; `at`, `charAt`, `charCodeAt`, `indexOf`, `lastIndexOf`,
`substring` all exactly **0**. The predicted +18/−0 was arithmetic; it is now
**measured**, and the assumption it rested on — per-`(brand, member)`
independence — is the thing that came back green rather than being waved
through.

**Arm D — the shipped code, with the experimental env var DELETED**, re-run over
the same 450: **identical to arm C on 450/450 files, 0 differences.** A kill
switch proves a *behaviour*; only this proves the *committed constant* produces
it. Worth doing as a matter of course: the scaffold can read at a different
time, cover a different set, or short-circuit a path the real edit does not.

### What actually shipped

`emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts`) gains a
five-member carve-out routing to `emitProtoMemberBodyRefusal`, so those members
fall through to #3254's corrected borrowed-receiver path:

```ts
const SUPERSEDED_BY_BORROWED_PATH = new Set(["trim","codePointAt","includes","startsWith","endsWith"]);
```

**It is a carve-out, NOT a removal, and the distinction is the finding**:
#2875 is *superseded* for these five and *still load-bearing* for the rest,
because it carries `emitStringRequireObjectCoercible` — which legacy never had.
That single fact explains both measurements: why blanket removal costs 13 files
and why this set costs zero. The comment at the site names the five, names the
eight deliberately excluded, and tells the next reader not to "simplify" the set
without re-running the A/B — because tidying it into a loop silently
reintroduces the 13.

### Scope of the +18 — read before quoting it

**+18 is measured over 450 `String/prototype` files and is P1 only.** It is the
smallest of the three populations. **P2** (transferred shape, 30 files / 27
host-pass) and **P3** (uncurryThis seam, ~1,810 host-pass gated, ~11× larger)
are **untouched**. The strategic follow-up is P3, not more of P1.

### The narrowed candidate — (superseded by the arm C/D result above)

Unwire **only** `trim`, `codePointAt`, `includes`, `startsWith`, `endsWith`;
keep every regressing member wired. Arithmetic over the ledger gives
**+18 / −0**.

**Do not quote +18 as measured.** It is arithmetic over two arms in which those
five members were unwired *together with* the regressing ones. Per-member
independence is plausible — each closure is minted per `(brand, member)` and the
arms are guarded by exact metadata identity — but **plausible is not measured**,
and this issue has already had one plausible hypothesis killed by a control (see
the REFUTED section). **Run a third arm with only those five unwired, and quote
that number instead.**

### Residual risk NOT covered by sweep 1 (measured above — kept for the record)

`at` / `codePointAt` / `includes` / `startsWith` / `endsWith` are wired today and
the switch unwires them, but they carry **no `es5id:` tests**, so this ≤ES5-scoped
sweep says nothing about them. Their non-ES5 files must be measured before the
removal ships. Members never wired (`toUpperCase`, `toLowerCase`, `slice`,
`concat`, `split`, `replace`, …) are unaffected by construction — they already
route to `emitProtoMemberBodyRefusal`.

## Adjacent, separate: the `__bindfn` invalid-Wasm cluster

The 15 "invalid Wasm binary" files are corpus-wide **28 files, 25 host-pass**,
one validation message (`call[N] expected type externref, found ref.null of
type (ref null N)`), locals `__bindfn_tgt/__bindfn_arg/__bindfn_args` ⇒ the
standalone arm of `compileFunctionBind` (`calls.ts:2277`). It is the
propertyHelper family but a **compile-time** sub-mode, distinct from the runtime
receiver-drop mode #3571 documents, so it does not double-attribute. A synthetic
`Function.prototype.call.bind(...)` does **not** reproduce it (positive control
green, so the instrument was live) — the trigger needs the full
`propertyHelper`/`verifyNotWritable` shape. Keep it in its own PR.

## Reconciling with "#3254 reopened as false-`done`" (below)

The section folded in from #3877 reports #3254 reopened on 2026-07-31 because it
left `trim` on the `"[object Object]"` terminal. That does **not** weaken the
supersession finding above, and the two are consistent — but only because the
claim above is empirical rather than inherited:

- The load-bearing evidence is the **kill-switch measurement**, not #3254's own
  status. With the #2875 wiring refused, `String.prototype.M.call(new Object(42))`
  passes **14/14** on the calibrated instrument — `trim` included. Whatever
  remains wrong in #3254, the path it feeds is measurably correct for the
  literal-`.call` spelling on these members *today*.
- #3254's stated "known limitation" (a dynamic `any`-typed OBJECT receiver
  stringifies through `__any_to_string`) would predict `new Object(42)` FAILING.
  It passes. So that limitation has been closed by something since, or is
  narrower than written — worth pinning down before leaning on #3254's text for
  anything other than the two facts used here (that it added the
  `receiverOverride`, and which member set it covers).

The residual `trim` defect #3254 was reopened for lives in the **same legacy
path** this issue would route more traffic to, so the two should be sequenced,
not raced: land the `trim` repair, then the wiring removal, or measure them
together.

## Measured frontier (2026-07-31) — folded in from #3877 (closed as duplicate)

#3877 was filed for this defect before its author found this issue; it is now
`wont-fix / duplicate_of: 2742`. Its measured content is preserved here.

### Per-method matrix

Receiver `new Number(1234)` (`ToString` → `"1234"`), method assigned as an own
property and invoked. Harness: `runTest262File(abs, cat, 60000)` and
`(…, "standalone")` on the same file. **Controls
`Object.keys({a:1,b:2}).length===2`, `"ab".toUpperCase()==="AB"`,
`String(new Boolean(false))==="false"` all pass on both lanes** (#3885), so
these readings are load-bearing.

| method        | host    | standalone |
| ------------- | ------- | ---------- |
| `substring`   | `23`    | `23` OK    |
| `charAt`      | `2`     | `2` OK     |
| `toUpperCase` | `1234`  | **`null`** |
| `toLowerCase` | `1234`  | **`null`** |
| `slice`       | `23`    | **`null`** |
| `charCodeAt`  | `49`    | **`null`** |
| `indexOf`     | `1`     | **`null`** |
| `lastIndexOf` | `1`     | **`null`** |
| `trim`        | `1234`  | **`null`** |
| `concat`      | `1234X` | **`null`** |
| `split`       | `2`     | **`0`**    |

**9 of 11 broken; `substring` and `charAt` already work** — a working in-tree
reference for whatever the other nine are missing. `split` returning `0` is a
wrong number rather than a `null` and is attributed to nothing yet.

### The receiver round-trip is NOT the problem

```
standalone: typeof=function  identity=true  hasOwn=true
            String(b)="false"  toUpperCase.call(b)="FALSE"  b.toUpperCase()=null
```

`typeof`, `===` identity, `hasOwnProperty`, and `ToString` on the receiver are
all correct, and the `.call()` form works on the **identical receiver**. Only the
assigned-method invocation fails — but see below, that is a test shape, not a
second defect.

### Dispatch is NOT the differentiator

The per-method call helpers are structurally identical between a failing member
and a working one — `call 120` (member lookup) then `call 171` (invoke), same
shape, opposite outcomes. So `obj.m = String.prototype.m; obj.m()` versus
`String.prototype.m.call(obj)` is a **test-shape** distinction, not a defect
axis.

### Located: the per-member `__proto_method_*` wrapper

Found by diffing a working arm against a broken one, with a repro **verified to
reproduce the matrix first** — an `any`-annotated receiver
(`const a: any = new Number(1234)`) does **not** reproduce (`charAt` returns null
there); the repro must be plain-JS shape `var a = new Number(1234)` with
`{ target: "standalone", allowJs: true }`.

- The emitted `$test` bodies for `charAt` vs `charCodeAt` differ by **one line**
  (the argument constant). Both use the same generic dispatch. So the defect is
  not at the call site.
- `$__proto_method_<brand>_charAt` coerces the receiver
  (`extern.convert_any` → `call 128` → `ref.cast` to `$AnyString`);
  `$__proto_method_<brand>_charCodeAt` has no such step and reads `struct.get` on
  the raw receiver.
- Bodies come from `glue.emitMemberBody` in `createNativeProtoMember`
  (`src/codegen/native-proto.ts` ~537), dispatched per-member by
  `emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts:812`).
  `toUpperCase` / `toLowerCase` / `slice` / `concat` / `split` are in **no arm**
  and fall to `emitProtoMemberBodyRefusal`.

### Three attributions tried and EXCLUDED — do not re-derive by reading

1. **`substring`-only bail-out** (`call-receiver-method.ts` ~2311) pins a
   guarded-native-string bail-out to `substring` while
   `sourceHasMethodReassignment` is already generic. Generalising it produced
   **byte-identical** standalone output. Reverted.
2. **Refusal return type** — `emitProtoMemberBodyRefusal` does
   `emitThrowTypeError` then `return null`, and `createNativeProtoMember` bails
   on `null`, which would discard the wrapper _including the throw_. Returning
   `{ kind: "externref" }` instead produced **byte-identical** output. Reverted.
3. **"The refusal is never reached"** — WRONG, and the probe was invalid: it
   grepped emitted **WAT text** for the refusal's message, which lives in the
   **string pool**, so zero was structurally guaranteed. The wrapper for
   `toUpperCase` is six lines and its entire body IS the refusal, ending in
   `throw 0`.

**Use a marker bisect, not source reading**: put a unique sentinel constant in
each candidate emitter, compile, dump the wrapper, and see which survives to WAT.
Attribution by marking cannot be wrong; attribution by reading was wrong three
times here.

### Acceptance bar for this frontier

- **11/11 correct on BOTH lanes**, not "the nine standalone nulls are gone" —
  host is already correct for 8 of the 9, so any shared-prologue change risks
  perturbing paths host depends on (the #3871 shape). Note the
  `__proto_method_*` wrappers are **standalone-only** (host emits **0** of them),
  which bounds that risk but does not remove it for other shared structures.
- `charAt` / `substring` must still pass — if a change breaks them, the change is
  wrong, not the references.
- **Kill-switch seen to fail**: revert and confirm the nine `null`s return.
- Report pass→fail, fail→pass and net from an actual standalone run; #3468's
  notes say floor impact is mixed and not computable in advance. State it in the
  PR description — a floor movement explained up front is a review conversation;
  the same movement found in `merge_group` is a park.

### Related

- **#3254** — reopened 2026-07-31 as false-`done`: it claims to generalise beyond
  `trim` and left `trim` itself on the pre-fix `"[object Object]"` terminal.
- **#3887 / #3888** — "TypeError never raised" family, separate from this one.

## Standalone residual: native String carrier equality (2026-08-12)

Fresh ≤ES5 standalone clustering on `main` @
`8c9f889680730001c08d0290bc40234514277505` left 44 failures under
`test/built-ins/String/prototype/`. Five shared one representation defect: the
reported actual value had the expected text, but the inline strict comparison
returned false.

Two physical shapes reached the same wrong terminal:

- a dynamic concatenation returned `(ref $AnyValue)` and was compared with a
  native String literal;
- a dynamically-dispatched String method returned `(ref null $AnyString)` and
  was compared with a separately allocated native String literal.

`compileTypedBinaryDispatch` treated both as ordinary object refs and emitted
raw `ref.eq`. The fix preserves `ref.eq` for actual objects, but routes native
String-ref pairs through the null-safe `__str_equals` content comparator and
routes mixed `$AnyValue`/native-String pairs through the canonical
`__any_strict_eq` engine. That is the same tag-aware equality engine used by IR
`dyn.eq`; the regression suite additionally requires the dynamic concat/equality
control to appear in `irCompiledFuncs`, so the semantic contract stays live on
the IR path. The `coercion-sites-allow` entry records this reviewed call-site
increase: it reuses that canonical engine instead of introducing another
coercion or equality implementation.

Exact fresh-baseline A/B over the 44-file residual:

- base: 0 pass / 44 non-pass;
- candidate: 5 pass / 39 non-pass;
- fail → pass: 5; pass → fail: 0 within the fixed residual;
- flipped files: the two `charAt` rows `S15.5.4.4_A1_T1/T2`,
  `slice/S15.5.4.13_A3_T3`, `toLowerCase/S15.5.4.16_A1_T3`, and
  `toUpperCase/S15.5.4.18_A1_T3`.

The remaining 39 rows retain distinct causes (RegExp-backed methods, concat and
split coverage, ToPrimitive/object branding, and missing transferred-method
semantics); they are not attributed to this equality fix.
