---
id: 5150
title: "ES2015 standalone: buffers conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-09-02
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/declarations.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/new-indexed.ts
  - src/codegen/expressions/new-builtin-globals.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
---

# ES2015 standalone: buffers conformance wave 1

LOC/function-growth allowance rationale (2026-09-01, measured on the landed
change-set): the wave adds codegen arms — the explicit-`undefined` tests and
the shared `isView` carrier chain (`dataview-native.ts` +128), the DataView
constructor's brand / detached / bounds validation (`new-indexed.ts` +196 in
`tryCompileIndexedBuiltinNew`), the module-global `$__ta_view` slot lookups
(`property-access*.ts`, `declarations.ts`), the `undefined`-singleton argument
padding (`closed-method-dispatch.ts`) and the `ArrayBuffer.isView` value
closure (`builtin-value-read.ts`). The `new-indexed.ts` function growth is the
one that deserves a follow-up: `tryCompileIndexedBuiltinNew` is now 884 lines
and its DataView arm should be lifted into its own `tryCompileDataViewNew`
before the next buffer wave adds to it.

## Problem

82 ES2015-bucket test262 tests under `built-ins/ArrayBuffer/**` and
`built-ins/DataView/**` fail on the standalone target (re-verified 2026-08-28
on head, branch `claude/es2015-test262-standalone-9vij99`: all 82 from the
day-old baseline still fail — 76 FAIL + 6 COMPILE_ERROR, 0 already fixed).
Seven root causes cover all 82; the top four cover 78%. ArrayBuffer/DataView
are load-bearing for the whole TypedArray corpus (#5138), so several fixes
here (ctor object model, NewTarget residual, windowed views) directly feed
that larger wave.

**Target list**: `.tmp/es2015/wp-buffers-current-fails.txt` (82 paths,
regenerated 2026-08-28). Per-cluster lists:
`.tmp/es2015/buf-cl-{A-setter-undefined,B-ctor-object-model,C-slice-species,D-ctor-validation,E-newtarget,F-ta-windowed-view,G-isview}.txt`.
Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(split lists >150 lines; some tests take up to 20 s). Minimal repro probes
from this analysis are saved under `.tmp/es2015/probes5150/*.js` (run one via
`npx tsx .tmp/probe-one.mts /home/user/js2/.tmp/es2015/probes5150/<name>.js`).

**Triage hazard found during analysis**: any program containing a TypedArray
element WRITE over an explicit `new ArrayBuffer(n)` degrades Test262Error
rendering to a raw `[object WebAssembly.Exception]` with unreliable line
attribution (probes `ta-view4.js`/`ta-view5.js` — identical throws render
fine without the TA write). Do not trust "at L<n>" on such tests; add a
try/catch probe (like `dv-alias.js`) before concluding which statement threw.

## Current failure clusters

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | DataView set* returns null, not undefined | 20 | `dataview-native.ts:1796-1801` `ensureDvAccessorHelper` — setter arm pushes `ref.null.extern`; comment predates the #2106 distinct-undefined singleton | `DataView/prototype/setUint16/set-values-return-undefined.js`, `setFloat64/no-value-arg.js`, `setInt32/set-values-little-endian-order.js` |
| B | Ctor/instance object model (getPrototypeOf, own-props, gOPD, `.constructor`) | 19 | no reflective function-object behind `ArrayBuffer`/`DataView` values — `builtin-value-read.ts` + `__builtinfn_get_meta` arms answer reads only; hasOwnProperty/gOPD/getPrototypeOf/instance-`constructor` all miss | `DataView/proto.js`, `ArrayBuffer/prop-desc.js`, `DataView/return-instance.js` |
| C | `ArrayBuffer.prototype.slice`: species + brand + undefined-end | 14 | `dataview-native.ts:130` `emitArrayBufferSlice` — no receiver brand TypeError, no SpeciesConstructor (§24.1.4.3 steps 6-15), explicit `undefined` end coerced NaN→0 (:194-198) | `slice/species.js`, `slice/context-is-not-object.js`, `slice/end-default-if-undefined.js` |
| D | Ctor argument validation (RangeError order, ToIndex, detached, no-new; 2 CEs) | 11 | `new-super.ts:5019/5050` — no upper-bound check before `array.new` (traps), no buffer-brand check before ToIndex(byteOffset) (2 wasm-validation CEs), no plain-call TypeError | `ArrayBuffer/allocation-limit.js`, `DataView/buffer-not-object-throws.js` (CE), `DataView/newtarget-undefined-throws.js` |
| E | Reflect.construct NewTarget residual (#3371) + realms | 8 | 6 CEs on the #3371 refusal arm (NewTarget.prototype not statically resolvable); 2 need `$262.createRealm` | `DataView/custom-proto-access-throws.js` (CE), `ArrayBuffer/prototype-from-newtarget.js` (CE), `DataView/proto-from-ctor-realm.js` |
| F | 2-arg TA-over-buffer windowed view broken | 5 | `new Uint8Array(buffer, 0)` (the #3054 B2 arm: `dataview-native.ts:3400` `emitTaViewConstructWindowed`, gate `new-builtin-globals.ts:1622-1640`) yields a view whose element READ throws "Cannot access property on null or undefined"; 1-arg works | `DataView/prototype/setUint8/no-value-arg.js`, `setUint8/toindex-byteoffset.js` |
| G | `ArrayBuffer.isView` as value / subclass instances | 5 | static-call site is implemented (`call-namespace-static.ts:574-634`) but the method READ AS A VALUE falls to the generic `builtin-value-read.ts:1570` throw; TA/DataView SUBCLASS instances don't test as views | `isView/invoked-as-a-fn.js`, `isView/arg-is-dataview-subclass-instance.js` |

Cluster evidence re-measured 2026-08-28 on head. Probes:
`dv-setuint8-b.js` (setter returns null), `ctor-desc.js` (hasOwnProperty/gOPD
miss on DataView), `global-own.js` (gOPD(globalThis,"ArrayBuffer") undefined),
`ctor-value.js` (getPrototypeOf(DataView)=null while typeof works),
`instance-ctor.js` (sample.constructor undefined), `ta2arg.js` (2-arg view
read throws — fails with NO DataView in the program), `dv-alias.js` (same,
try/catch-instrumented).

## Implementation Plan

Ordered by count descending — partial completion maximizes yield. Each step
independently shippable; re-run its `buf-cl-*` list plus the spotcheck after
each.

### Step 1 — cluster A: setter returns undefined (20 tests)

In `ensureDvAccessorHelper` (`src/codegen/dataview-native.ts`, setter arm at
:1796-1801): replace the `ref.null.extern` result with the undefined
singleton, using the exact pattern already proven at :3043-3053 (#3177 OOB
read): `...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }])`.
(`undefinedExternInstrs` is the any-helpers.ts accessor over the #2106
`$undefined` global; keep the null fallback for the pre-singleton lane.)

Then fix the MISSING-value plumbing so the no-value-arg tests pass end-to-end:

1. The reflective closure body pads absent args with `ref.null.extern`
   (`dataview-native.ts:1896-1903`); the closed-method dispatcher does the
   same (`closed-method-dispatch.ts` — see its `$__dv_window` brand arm
   ~:1456). Pad with the undefined singleton (`undefinedExternInstrs`)
   instead, so ToNumber(missing)=ToNumber(undefined)=NaN — float setters must
   genuinely write NaN (`setFloat32/no-value-arg.js` asserts
   `getFloat32(0)` is NaN; a null pad coerces to 0 and fails).
2. **Edge case**: the BigInt-setter missing-value detection at
   `dataview-native.ts:1751-1754` tests `ref.is_null` on param 2 to throw
   the §7.1.13 ToBigInt(undefined) TypeError. Once padding becomes the
   non-null singleton, switch that test to an is-undefined check (compare
   against the singleton / tag==1 — see `any-boxing-helpers.ts:146` for the
   established test) or the setBigInt64 no-value throw silently stops firing.
3. Verify the standalone externref→f64 `coerceType` chokepoint maps the
   undefined singleton to NaN (it must already — `x === undefined` and
   arithmetic on undefined rely on it); if integer setters wobble, the codec
   wraps NaN→0 (:1626-1628 comment) so only float setters are sensitive.

The static-args path (`:1605-1636`) already handles missing args correctly
(`f64.const NaN`); only the runtime-helper lane is broken.

### Step 2 — cluster B: ctor/instance object model (19 tests)

**Coordinate with #4490 first** (in-progress; "builtin ctor own-property
coherence — D7 ctor-value-as-real-$Object, one ctor per PR"; its
loc-budget already covers `dataview-native.ts`) and #5138 step 2 (the
%TypedArray% intrinsic build-out, same mechanism). Check the claim ref
(`node scripts/claim-issue.mjs --check 4490`) and `git log origin/main
--grep="#4490"` — if D7 has landed for any ctor, replicate that landed
pattern for `ArrayBuffer` and `DataView` instead of inventing a parallel one.
Do NOT re-implement #4490; this step is "apply its mechanism to the two
buffer ctors".

Concrete sub-defects to close (each probe-verified):

1. `Object.getPrototypeOf(ArrayBuffer|DataView)` → `Function.prototype`;
   `Object.getPrototypeOf(X.prototype)` → `Object.prototype`
   (`__object_getPrototypeOf` native + the MOP arms — mirror
   `ta-dyn-mop.ts`'s handling per #5138 step 2(i)).
2. `hasOwnProperty`/`getOwnPropertyDescriptor` on the ctors for
   `name`/`length`/`prototype`/`isView` (meta already exists —
   `builtin-fn-meta.ts:129` has `ArrayBuffer: { isView: 1 }`; the #2896
   `fillBuiltinFnMeta` descriptor arms are the place: report
   name/length configurable:true (ES2015), prototype
   writable:false/enumerable:false/configurable:false).
3. Global-object own property: `gOPD(globalThis, "ArrayBuffer")` must answer
   `{value, writable:true, enumerable:false, configurable:true}`
   (`ArrayBuffer/prop-desc.js`, `DataView/dataview.js` use
   `verifyProperty(this, ...)`).
4. Instance `.constructor`: prototype-chain lookup from a DataView instance
   (`$__dv_window` brand) and an ArrayBuffer (i32_byte vec) must reach
   `X.prototype.constructor` === the ctor value
   (`property-access-dispatch.ts` — the brand→proto-member fallthrough;
   `builtin-prototype-brand.ts:151-152` lists the branded members).
   `ArrayBuffer.prototype.constructor === ArrayBuffer` identity included.
5. `DataView.prototype.getInt16.length` — method fn `.length`/`.name` meta
   through `verifyPrimordialProperty` (needs 2's descriptor arms on
   prototype-method values).
6. `instance-extensibility.js`: expando add + `hasOwnProperty` on a DataView
   instance — the `$__dv_window` expando field exists (#3177 slice 4,
   `dataview-native.ts:4295`); wire hasOwnProperty/gOPD/delete over it.
7. `ArrayBuffer[Symbol.species]` accessor descriptor (get present, set
   undefined, configurable:true) — same owner as 2.

`is-a-constructor.js` ×2 need `isConstructor()` (harness
`isConstructor.js`, uses `new (class extends F {})`-free Reflect.construct
probing) to see the ctor as constructable — falls out of the ctor value
being a real carrier + cluster E's Reflect.construct arm.

### Step 3 — cluster C: slice species + brand + undefined-end (14 tests)

All in `emitArrayBufferSlice` (`src/codegen/dataview-native.ts:130`), plus
its dynamic-receiver twin if the dispatch route differs
(`call-receiver-method.ts:897`):

1. **Brand check** (2 tests): receiver not an i32_byte vec (after
   `any.convert_extern`) → catchable TypeError, BEFORE coercing begin/end.
   Use `ref.test` + `buildThrowJsErrorInstrs` — the detached check
   (`emitArrayBufferDetachedCheck`, :140-171) is the in-file pattern. Today
   a bad receiver either traps at `ref.cast` (:154) or never reaches slice.
2. **Explicit-undefined end** (1 test): `slice(1, undefined)` — the
   `args.length >= 2` arm (:194-198) coerces undefined→NaN→0. Spec: an
   undefined end defaults to srcLen. Runtime-test the compiled arg for
   undefined (singleton test, `any-boxing-helpers.ts:146` pattern) and
   select srcLen; a compile-time `ts.isIdentifier(e) && e.text==="undefined"`
   short-circuit covers the literal form (see the #3177 literal-`undefined`
   detection import at :43).
3. **SpeciesConstructor §24.1.4.3 steps 6-15** (11 tests): after computing
   `newLen`: read `this.constructor` (through the cluster-B MOP — an
   expando-assigned `.constructor` on the instance must be seen:
   `slice/species.js` does `arrayBuffer.constructor = speciesConstructor`);
   undefined → intrinsic default (current fast path); non-object →
   TypeError; else read `C[Symbol.species]`; null/undefined → default;
   non-constructor → TypeError; else CALL it with (newLen) and validate the
   result: not-an-ArrayBuffer → TypeError, detached → TypeError, SameValue
   with `this` → TypeError, `result.byteLength < newLen` → TypeError; then
   copy bytes into the RESULT buffer and return it (larger-than-requested
   result is legal — `species-returns-larger-arraybuffer.js`).
   Follow the SpeciesConstructor shape #5138 step 2 prescribes for TA
   `map`/`filter` so the two land on one shared helper if #5138's lands
   first — check `git log origin/main --grep="#5138"` before writing it.
   Invoking the species ctor is a dynamic call of a user function value —
   reuse the closure-call dispatch (`calls.ts` `tryEmitInlineDynamicCall`),
   not a new mechanism.

### Step 4 — cluster D: ctor argument validation (11 tests, kills the 2 CEs)

1. **Upper bound before allocation** (2): `new-super.ts:5019` validates
   non-integer/negative only; a huge length reaches `array.new_default` and
   TRAPS ("requested new array is too large" — uncatchable). Add
   `len > 2^31-1 → RangeError "Invalid array buffer length"` to the same
   `if` chain (engine array limit is below 2^31 anyway; spec allows
   implementation-defined RangeError for any length it cannot allocate).
2. **ToIndex via ToPrimitive** (1): `toindex-length.js` — a
   `{valueOf(){return 42}}` length currently misses valueOf (compiled with
   an f64 hint that doesn't route plain objects through ToPrimitive). Route
   the length arg externref→f64 through `coerceType` exactly like the
   DataView accessor helper does (`dataview-native.ts:1721-1722`) so
   `__to_primitive` runs; undefined→0 falls out of NaN→0.
3. **DataView buffer-brand BEFORE ToIndex(byteOffset)** (2 CEs + 1): the two
   COMPILE_ERRORs (`buffer-not-object-throws.js`,
   `buffer-does-not-have-arraybuffer-data-throws.js`) are wasm-validation
   failures — `new DataView(0, obj)` with a statically non-buffer arg emits
   a `struct.get` on the wrong type inside the `assert.throws` closure
   (`__cb_*`). Gate the native DataView-construct arm on the
   oracle-resolved arg type (use `ctx.oracle`, NOT `ctx.checker` — the
   oracle-ratchet gate): statically-known non-buffer → emit "evaluate args
   for side effects, throw TypeError" (the §25.3.2.1 step-order test:
   brand throw fires BEFORE the byteOffset valueOf runs — the unary.ts
   evaluate-drop-throw pattern used at `dataview-native.ts:1611-1617`).
   Dynamic/externref args: `ref.test` the vec carrier at runtime, same
   TypeError on miss. `detached-buffer.js` (1): after the brand test, run
   `emitDvDetachedCheck` (exists — :1877) in the ctor path → TypeError.
4. **Offset/length RangeError** (3): `excessive-byteoffset-throws.js`
   (`offset > buffer.byteLength` → RangeError),
   `excessive-bytelength-throws.js` (`offset + byteLength >
   buffer.byteLength` → RangeError),
   `defined-byteoffset-undefined-bytelength.js` (EXPLICIT undefined
   byteLength = "to end of buffer", currently 0 — same
   undefined-runtime-test as step 3.2). The offset validation block at
   `new-super.ts:5050+` (#1515) already coerces; extend it with the two
   buffer-relative bounds checks against the vec length field.
5. **Called without `new`** (2): `ArrayBuffer(10)` / `DataView(b)` as plain
   calls must throw TypeError. Direct-identifier call: compile-time arm in
   the call dispatch (evaluate args, throw — mimic the landed #5100/#4732
   Set/WeakSet fix; find it via `git log origin/main --grep="#5100"`).
   Value call (`var f = DataView; f(b)`): extend the #3177 slice-3
   `wantTaCtorArm` (`calls.ts:4197-4205`) to the buffer ctor carriers once
   cluster B gives them real values.

### Step 5 — cluster E: NewTarget residual (6 CE tests; 2 deferred) (8)

Same shape as #5138 step 6 F2 — do them together if both waves are staffed:

1. **Observable NewTarget.prototype get** (3): `custom-proto-access-throws`,
   `custom-proto-access-detaches-buffer`,
   `byteOffset-validated-against-initial-buffer-length` — the #3371 refusal
   (`standalone Reflect.construct cannot preserve...`) fires before the
   `newTarget.prototype` GET is even attempted. Evaluate the get through
   the MOP (it throws the test's Test262Error / detaches the buffer /
   resizes it) in §25.3.2.1 order (OrdinaryCreateFromConstructor's proto
   get happens BEFORE offset validation against the buffer), THEN hit the
   refusal only if construction must actually proceed with a distinct
   proto. `custom-proto-access-*` never construct successfully, so no
   proto plumbing is needed for them; `byteOffset-validated...` constructs
   against the MUTATED buffer state and needs the ctor re-validation of
   step 4.4 to throw RangeError.
2. **Distinct-proto carriage** (3): `prototype-from-newtarget`,
   `data-allocation-after-object-creation`,
   `newtarget-prototype-is-not-object` need the constructed instance to
   carry `newTarget.prototype` (or fall back to the intrinsic default when
   non-object). The `$__dv_window` struct already has a `constructProto`
   field reserved for exactly this (`dataview-native.ts:4296` — "#3371
   constructProto (intrinsic default)"); populate it on the
   Reflect.construct path and honor it in `Object.getPrototypeOf`/
   `instanceof`/property fallthrough. One field write + the cluster-B
   getPrototypeOf arm — do after step 2.
3. **Defer** (2): `proto-from-ctor-realm.js` ×2 require `$262.createRealm`
   — out of scope; belongs to #4274 (true realms). Note them in the PR as
   deliberately unfixed.

### Step 6 — cluster F: 2-arg windowed TA view (5 tests)

`new Uint8Array(buffer, 0)` produces a view whose element read throws
"Cannot access property on null or undefined"; the 1-arg form works (probes
`ta2arg.js` vs `ta-view5.js` — the failure needs NO DataView in the
program). Suspects, in order: (a) `emitTaViewConstructWindowed`
(`dataview-native.ts:3400`) returns null at compile time for this shape and
the fallthrough at `new-builtin-globals.ts:1641-1648` builds a 0-length TA;
(b) the gate's `ctx.oracle.builtinReceiverOf(args[0])` doesn't resolve the
untyped-JS `var buffer` and skips the arm; (c) `inferTaViewType`
(variables.ts) disagrees with the construct arm on the local's type — the
comment at `new-builtin-globals.ts:1620-1621` says they MUST match — so the
read dispatches down a null path. Diagnose with `--emit-wat` on `ta2arg.js`
(see `/analyze-wat`), fix the disagreeing side, and re-run
`buf-cl-F-ta-windowed-view.txt` (these five also need step 1's
return-undefined fix to pass fully). This overlaps #5138 cluster A
(dyn-ctor argument protocols) — check the claim ref for #5138 work in
flight on the same arm before starting.

### Step 7 — cluster G: isView value + subclasses (5 tests)

1. `invoked-as-a-fn.js`: add an `ArrayBuffer.isView` body arm in
   `builtin-value-read.ts` (beside `Object.is`, :1523) so the VALUE read
   mints a real closure instead of the generic :1570 throw. Body = the
   ref.test chain already written at `call-namespace-static.ts:617-634`
   (vec carriers + `$__dv_window`); extract it into a shared helper in
   `dataview-native.ts` rather than duplicating. NOTE the existing
   static-call site (:588-590) uses raw `ctx.checker` — pre-ratchet code;
   the NEW helper must go through `ctx.oracle` or carry an
   `oracle-ratchet-allow:` grant only if a raw `ts.Type` identity is
   genuinely needed (it is not — carrier `ref.test`s are type-free).
2. `arg-is-typedarray.js` / `arg-is-typedarray-buffer.js`: use
   `testWithTypedArrayConstructors` (ctors as values, dynamic construct) —
   they resolve once the value-read closure (7.1) + #5138's ctor-value work
   give a real construct path; the ref.test chain answers the check itself.
   Beware the harness-name poisoning documented in #5138 ("(Testing with X
   and makeArray.)" suffixes are unreliable).
3. `arg-is-{typedarray,dataview}-subclass-instance.js`: `class Sub extends
   Uint8Array/DataView` instances must carry the vec/`$__dv_window` carrier
   so the ref.test sees them (`standalone-subclass-ctors.ts:103` already
   lists ArrayBuffer in the subclassable set — extend/verify DataView + TA
   subclass construction routes through the native carriers). If subclass
   construction itself is broken, bound the fix to these two tests and
   leave general subclassing to #1455/#1366.

### What NOT to do (any cluster)

- **No new host imports without a standalone fallback** (dual-mode rule);
  everything above is Wasm-native — the `__arraybuffer_isView` host import
  stays host-lane-only.
- **Never edit** `tests/test262-runner.ts`, any skip list, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- **Do not use raw `ctx.checker`** in new codegen — `ctx.oracle` only
  (oracle-ratchet gate; 5 PRs hit this wall in one session).
- Do not re-implement #4490/#5138/#2046 machinery — check the claim ref and
  `git log origin/main` per step; adopt landed patterns.
- Run every source-ratchet gate before committing (LOC/func budgets,
  coercion sites, oracle ratchet, dead exports), chained with `&&`, never
  piped.

## Acceptance criteria

- All 82 tests in `.tmp/es2015/wp-buffers-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-buffers-current-fails.txt`
  (partial landing per-cluster is fine — each step's `buf-cl-*.txt` list
  goes green with its PR; steps ordered by yield). The 2 deferred
  `proto-from-ctor-realm.js` tests (step 5.3) may remain failing — if so,
  80/82 with the deferral noted in the PR body is acceptance for this wave.
- Every test in `.tmp/es2015/wp-buffers-passing-spotcheck.txt` still passes
  (all 40 verified passing on head 2026-08-28 — a regression here is a
  regression, not drift).
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports` (also
  with `LOC_GATE_BASE` set to upstream-main tip to simulate CI's merge
  preview).
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## References

- #5138 — sibling TypedArray wave: shares the ctor object model (its step
  2), SpeciesConstructor shape (step 2), Reflect residuals (step 6), and the
  windowed-view arm (its cluster A). Coordinate; do not duplicate.
- #4490 (in-progress) — builtin ctor own-property coherence / D7
  ctor-value-as-real-$Object; cluster B applies its mechanism to
  ArrayBuffer/DataView.
- #3371 (done, refusal arm remains) — standalone Reflect.construct
  NewTarget; cluster E is its buffer-side residual.
- #2106 — the standalone distinct-undefined singleton; cluster A is a
  stale pre-#2106 `ref.null.extern` site.
- #3173 — DataView accessor helper architecture (the file cluster A edits).
- #3054 — B1/B2 shared-backing `$__ta_view` (cluster F's arm); #3177 —
  slices 3/4 (TA-ctor-call arm, expando field, OOB-undefined pattern).
- #1698/#1717 — ArrayBuffer.prototype.slice standalone history (cluster C).
- #5100/#4732 (done) — Set/WeakSet called-without-new TypeError; the landed
  pattern for cluster D.5.
- #2594/#965 — isView history (cluster G); #1455/#1366 — builtin
  subclassing (cluster G.3 boundary); #3610 (in-progress) — the wider
  missing-brand-check trap cluster (cluster C.1/D.3 are its buffer cases).
- #2046 (in-progress) — standalone Reflect spec gaps; #4274 — true realms
  (the two deferred proto-from-ctor-realm tests).

## Suspended Work (2026-09-01T21:56Z — user-requested 2-hour pause)

- **Branch**: local lane branch `worktree-agent-aeeb8b33069f63eff` at `0795f838f`
  (WIP snapshot on top of base `d153a0882`; NOT pushed — durable copy is
  `plan/agent-context/es2015-suspend-2026-09-01/patches/lane-5150.mbox`, 4
  patches: `dd9370a31` clusters A+F (+ cluster C's explicit-`undefined` slice
  end), `6911a46bb` cluster D, `b615b634d` cluster G, then the snapshot carrying
  the untracked focused test `tests/issue-5150-es2015-buffers.test.ts` and this
  file's edits; apply with `git am --3way` onto current main).
- **Worktree at suspension**: `/home/user/js2/.claude/worktrees/agent-aeeb8b33069f63eff`
  (treat as gone).
- **State** (implementer's handoff): clusters A, C (slice end), D, F, G done
  and committed; Step 2 (cluster B ctor/instance object model), Step 3.3
  (slice species) and Step 5 (cluster E, #3371) NOT done — B blocks the 3
  remaining `defined-byteoffset*` rows and the species family.
- **Verified so far** (implementer's runs, standalone, the 53-row list,
  `.tmp` runner with a 120 s compile timeout): before 0 pass / 48 fail / 5 CE
  → after **16 pass / 32 fail / 5 CE — +16, zero regressions**; the 5 CEs are
  the #3371 refusal. All 16 flipped rows verified host-import clean
  (`check-leak.mts`). Gates green (loc, func, coercion, oracle-ratchet,
  dead-exports); `tsc --noEmit` identical to the unmodified checkout; focused
  test 14/14.
- **NOT yet verified / next steps**: (1) `git am` + `pnpm run typecheck`; (2)
  the 20-row TypedArray collateral sample (`lists/ta-sample.txt` if present,
  else pick 20 currently-passing `TypedArray/prototype/**` rows) in BOTH lanes;
  (3) `pnpm run test:equivalence:gate`; (4) write the `## 2026-09-01
  implementation (Opus)` section; (5) Step 2 (cluster B) then 3.3.
- **Traps**: `scripts/run-test262-paths.mts` uses the runner's hard-coded 15 s
  compile timeout — under load 33/53 rows falsely read `compilation timeout`;
  use a runner with a longer timeout (the implementer's `run-rows.mts`) or an
  idle box. `runTest262File` does not apply the standalone leak check (#5272).
  Do not A/B by restoring `.tmp/*-new.ts` snapshots (it silently reverted the
  `isViewRefTestInstrs` taView fix once). Host-lane `ab.slice(1,3).byteLength`
  fails to compile on unmodified main — pre-existing. `tryCompileIndexedBuiltinNew`
  is now 884 lines: lift the DataView arm into `tryCompileDataViewNew` before
  the next wave. #5194 edits neighbouring TypedArray functions in
  `dataview-native.ts` — reconcile at merge, never rebase.

## 2026-09-01 PR #5224 integration

The draft PR #5224 carried an **unvalidated, interrupted WIP snapshot**
(`99fdfec26`, 2026-08-28, 11 files, +858/−55) whose base was ~714 commits behind
`main`. That WIP is the artefact the validated lane later MINED and
re-implemented on current main. This integration replaces it: the PR branch
`claude/es2015-buffers-wave1-wip` is now `origin/main` (`813b828b6`) plus the
four validated `lane-5150.mbox` patches, applied with `git am --3way` — no
history rewritten, no force-push.

### Merge resolution — every WIP file resolved to MAIN

`git pull --no-rebase origin main` conflicted in 5 files and auto-merged 6.
All 11 were resolved to **main's** side, because each WIP hunk is an older
version of something main (or the lane patch applied on top) already has:

| WIP file | Why main wins |
| --- | --- |
| `src/codegen/expressions/call-receiver-method.ts` | main already emits `canonicalUndefinedExternInstrs(ctx)` for the DataView-setter expression result (#2864). The WIP diff against main was **comment-only**. |
| `src/codegen/expressions/calls.ts` | main renamed the arm to the table-driven `tryCompileCollectionCtorCallWithoutNew`; the WIP's separate dispatch site for its own `tryCompileBufferCtorCallWithoutNew` no longer has a slot. |
| `src/codegen/expressions/new-builtin-globals.ts` | same mechanism, better: the lane adds `ArrayBuffer`/`SharedArrayBuffer`/`DataView` to `CALL_WITHOUT_NEW_COLLECTION_CTORS` instead of adding a fourth near-copy of the throw helper. |
| `src/codegen/dataview-native.ts` | main already imports and uses `canonicalUndefinedExternInstrs` for the setter return. |
| `src/codegen/declarations.ts` | main kept `proxyOrTransferredResultNeedsExternref`; the WIP had renamed it to `transferredArrayLikeResultNeedsExternref` on a 714-commit-old tree. The lane adds `inferTaViewType` alongside main's name. |
| `src/codegen/property-access.ts`, `property-access-dispatch.ts` | the WIP's module-global `$__ta_view` lookups and the lane's are the **same code**; the lane's comments are the refined ones. |
| `src/codegen/builtin-value-read.ts`, `closed-method-dispatch.ts`, `expressions/new-indexed.ts` | superseded wholesale by lane patches 3, 1 and 2. |
| `plan/issues/5150-es2015-standalone-buffers-wave1.md` | main's copy; lane patch 4 re-applies the lane's edits. |

The merge commit's tree is therefore byte-identical to `origin/main`; the
implementation arrives entirely in the four lane commits.

**WIP-only hunks DROPPED** (~56 lines, all superseded — none kept):

- `expressions/new-builtin-globals.ts::tryCompileBufferCtorCallWithoutNew`
  (+37) and its `expressions/calls.ts` dispatch site (+8) — the lane's
  table entry covers the identical §25.1.3.1 / §25.3.2.1 step-1 clause, and the
  two arms would have shadowed each other (the WIP's ran first).
  Empirically confirmed: `ArrayBuffer/undefined-newtarget-throws.js` and
  `DataView/newtarget-undefined-throws.js` both flip to `pass` with only the
  lane's arm present.
- `expressions/call-receiver-method.ts` (+5/−6) — comment-only against main.

No WIP-only hunk was kept, so the "does a buffers row depend on it" test
resolved by construction: with all three files at main's version plus the lane
patches, all 16 rows the wave targets pass.

### Validation on the integrated branch (HEAD `9deedf8fe`)

Measured 2026-09-01/02 in worktree
`/home/user/js2/.claude/worktrees/wf_27c6d40c-3be-1`.

| Check | Result |
| --- | --- |
| 53-row buffers list, `--target standalone`, before (`origin/main`) | **0 pass / 48 fail / 5 compile_error** |
| 53-row buffers list, after (this branch) | **16 pass / 32 fail / 5 compile_error** |
| Net | **+16, zero regressions, zero other status transitions** |
| Host-import check on all 16 flipped rows | **16/16 clean** (compiler `result.imports` empty) |
| 20-row `built-ins/TypedArray/prototype/**` control sample (standalone, all passing at base) | **20/20 pass** |
| `pnpm run typecheck` (TS7) | clean |
| `pnpm run typecheck:ts5` | 2 pre-existing `WebAssembly.Tag` errors in `src/linked-provider-runtime.ts`, a file this branch does not touch |
| `npx vitest run tests/issue-5150-es2015-buffers.test.ts` | **14/14** |
| loc / func / coercion / oracle-ratchet / dead-exports | all green (merge-base == `origin/main`, so this is also CI's base) |
| `pnpm run test:equivalence:gate` | 24 failing / 1718 passing / 24 known-failures — **no new regressions** |

Commands used for the measurement (both runs used a **120 s** compile timeout,
not the stock probe's hard-coded 15 s — under load on this 4-core box the 15 s
ceiling falsely reports ~a third of these rows as `compilation timeout`, which
is the trap recorded in `## Suspended Work`):

```
# before, in the pristine main checkout (verified src/ byte-identical to origin/main)
cd /home/user/js2 && npx tsx .tmp/es2015/run-rows.mts \
  /home/user/js2/.tmp/es2015/buffers-head.txt --standalone --timeout 120000
# after, in the integration worktree
npx tsx .tmp/es2015/run-rows.mts .tmp/es2015/buffers-head.txt --standalone --timeout 120000
```

`buffers-head.txt` was derived from the suspension manifest's
`lists/buffers-paths.txt` by stripping the leading `test/` (the manifest ships
no `buffers-head.txt`).

### The 16 flipped rows

```
built-ins/ArrayBuffer/allocation-limit.js
built-ins/ArrayBuffer/length-is-too-large-throws.js
built-ins/ArrayBuffer/prototype/slice/end-default-if-undefined.js
built-ins/ArrayBuffer/toindex-length.js
built-ins/ArrayBuffer/undefined-newtarget-throws.js
built-ins/DataView/buffer-does-not-have-arraybuffer-data-throws.js
built-ins/DataView/buffer-not-object-throws.js
built-ins/DataView/detached-buffer.js
built-ins/DataView/excessive-bytelength-throws.js
built-ins/DataView/excessive-byteoffset-throws.js
built-ins/DataView/newtarget-undefined-throws.js
built-ins/DataView/prototype/setUint8/index-is-out-of-range.js
built-ins/DataView/prototype/setUint8/negative-byteoffset-throws.js
built-ins/DataView/prototype/setUint8/no-value-arg.js
built-ins/DataView/prototype/setUint8/set-values-return-undefined.js
built-ins/DataView/prototype/setUint8/toindex-byteoffset.js
```

`ArrayBuffer/isView/invoked-as-a-fn.js` did NOT flip, but its failure moved from
"`ArrayBuffer.isView` is not yet implemented in --target standalone" to a real
`isView(<TypedArray>)` value assertion — cluster G lands the closure; the
remaining half needs the per-kind TypedArray carrier work in #5194.

### Two notes for the reviewer

- **`DataView/detached-buffer.js` links `js2wasm:runtime-eval::*`.** Those four
  imports are the #2928/#4242 **Wasm-native** eval substrate the standalone lane
  links on purpose (the row's `$DETACHBUFFER` goes through `eval`), not a JS
  host import. The compiler's `result.imports` — the manifest CI's
  `scripts/test262-worker.mjs` (~L1797) actually gates on — is **empty** for
  this row, so it is not a `host_import_leak`. Worth stating explicitly because
  a probe that reads `WebAssembly.Module.imports` instead will flag it.
- **The 5 compile_errors are unchanged and out of scope**: all five are the
  #3371 refusal, "standalone `Reflect.construct` cannot preserve an arbitrary
  distinct NewTarget without a statically-resolved NewTarget".

Remaining work is unchanged from `## Suspended Work`: Step 2 (cluster B, the
ctor/instance object model), Step 3.3 (slice species) and Step 5 (cluster E,
#3371). `status` stays `in-review` — the PR author is not the merger.

### 2026-09-02 review pass — four findings, three fixed

Two independent reviewers audited the integration at `475d23f4c`. All four
findings reproduced; the dispositions:

**1 (blocking, FIXED) — the module-global `$__ta_view` pin swallowed a rebind.**
`moduleGlobalWasmType` (declarations.ts) pinned `var t = new Uint8Array(buf)` to
the view struct *unconditionally*, so a later `t = new Uint8Array(2)` — a plain
`$Vec` — no longer fit the slot: the store dropped to null and the next read
trapped. Standalone, `origin/main` vs `475d23f4c`:

| probe | main | branch @475d23f4c | branch, fixed |
| --- | --- | --- | --- |
| `t = new Uint8Array(2)` then `t[0]` | `29` | THROW null-deref | `29` |
| `t = new Uint8Array([7,8])` then `t[1]` | `28` | THROW null-deref | `28` |
| `t2 = new Uint8Array(otherBuf)` | compiler crash | `29` | `29` |

The middle column is a real pass→trap flip, i.e. a standalone regression against
main, and the failure mode is a silent null store. The widening helpers the
consult sits above (#4428 / #4204 / #4491) cannot catch it — both sides of the
rebind are objects, so there is no JS-tag disagreement — so the fix is a
dedicated guard, `taViewGlobalIsRebound` (declarations.ts): the pin survives
only when every `t = …` in the file assigns a view of the same element type.
Host/gc lane was byte-identical branch vs main on the same probes, so this was
standalone-only.

*The same defect exists for FUNCTION LOCALS and is NOT fixed here* — it predates
this branch (`inferLetConstInitializerWasmType`, #4376, has the identical
unconditional consult), and the local probe traps on `origin/main` too. Left for
a follow-up rather than widened into this wave.

**2 (should-fix, FIXED as documentation) — `explicitUndefinedExternTestInstrs`
docstring.** It justified having no `undefinedSingletonActive` gate by calling
`undefinedSingleton` "default-off". It is default **TRUE** (create-context.ts:430,
`process.env.JS2WASM_UNDEF_SINGLETON !== "0"`; #2106 flip). Measured under
`JS2WASM_UNDEF_SINGLETON=0`, standalone: `new DataView(b,4,undefined).byteLength`
reads 0 instead of 4, and `dv.setFloat64(0)` with no value argument stops
storing NaN — i.e. the clauses revert to the legacy answers, they do not
degrade gracefully.
No behaviour change was warranted (nothing in `.github` or `scripts/` sets the
variable, and with the singleton off the helper's `ref.test` correctly answers
0 by construction), so the comment now states the dependency instead of denying
it.

**3 (should-fix, RECORDED not fixed) — cluster F stops at the read site.**
A module-global view passed to a *typed* `Uint8Array` parameter still traps:
`taViewReceiverTypeIdx` and the `tryLengthAndNameReads` spill both key off the
identifier at the read site, so the value falls back to the checker-typed vec at
the call boundary and the parameter slot rejects it. The `any`-typed sibling
works. **Not a regression** — the same program is a compiler crash on
`origin/main` ("Cannot read properties of undefined (reading 'slice')"), so no
row is lost. Cluster F should be read as "direct property/length reads on a
module-global view", not "module-global views work"; the call-boundary half is
remaining work alongside Step 2.

**4 (should-fix, FIXED) — `emitArrayBufferSlice` boxed a statically-numeric
`end`.** The explicit-`undefined` arm routed `args[1]` through externref
unconditionally, so `ab.slice(2, 6)` dragged `__box_number` and the whole
ToPrimitive chain into the module. Measured, standalone, same probe both sides:

| | `ab.slice(2,6)` bytes | `__to_primitive` present | compile ms |
| --- | --- | --- | --- |
| `origin/main` | 51,101 | no | ~1,755 |
| branch @`475d23f4c` | 122,604 | yes | ~2,450 |
| branch, fixed | 51,125 | no | back on main's order |

`ab.slice(2)` and the DataView arms were unaffected, so the whole +71.5 KB was
that one line. Fixed with the gate the two sibling ToIndex sites already use
(`ctx.oracle.staticJsTypeOf(arg) === "number"` → compile straight to f64,
new-indexed.ts:196/499). A statically-numeric argument cannot BE `undefined`, so
the spec arm is untouched for every other shape.

#### Re-validation after the three fixes

| Check | Result |
| --- | --- |
| 53-row buffers list, standalone, 120 s timeout | **16 pass / 32 fail / 5 compile_error** — row-for-row identical to the pre-fix run (`diff` of status+path: no differences) |
| 20-row `built-ins/TypedArray/prototype/**` control sample, standalone | **20/20 pass** |
| `npx vitest run tests/issue-5150-es2015-buffers.test.ts` | **14/14** |
| `pnpm run typecheck` (TS7) | clean |
| loc / func / coercion / oracle-ratchet / dead-exports | all exit 0 (oracle: "+0 getTypeAtLocation, +0 ctx.checker"; dead-exports: "25 known, 0 new") |
| loc + func gates re-run with `LOC_GATE_BASE=origin/main` (CI's merge preview) | both exit 0 |
| `pnpm run test:equivalence:gate` | 24 failing / 1718 passing / 24 known-failures — **no new regressions** |
| `ab.slice(2,6)` standalone binary | 51,125 bytes, `result.imports` empty, no `__to_primitive` |
| rebind probes A/B/C/E (standalone) | `29` / `29` / `28` / `10` — A and C back to main's answers, B and E keep the wave's improvement |

## 2026-09-02 post-merge regression fix (PR #5224 → main)

The wave landed as `5dd7a92169` (first parent `985de5b65b`). The merge-group run
[33593621223](https://github.com/loopdive/js2/actions/runs/33593621223) —
"check for test262 regressions", JS-HOST lane — then flagged nine rows that the
PR-level checks could not see, and the lead re-confirmed them on current main.

### Root cause

Cluster F pinned a MODULE-GLOBAL typed-array binding to the type
`inferTaViewType` answers (`declarations.ts`, `moduleGlobalWasmType`). That
helper is dual-purpose: on the STANDALONE lane it answers the shared-backing
`$__ta_view` struct — the thing the wave is about — but on the JS-HOST lane it
answers **`externref`**, because it doubles as the local-slot chooser for the
#3097 host construct bridge. Adopting the host answer for a module global is a
representation change on a lane the wave never measured: a top-level
`const i32a = new Int32Array(new SharedArrayBuffer(16))` stopped being the
native element vec the rest of the host lane assumes and became a REAL host
`Int32Array`. Two consequences, both observed:

- **`Atomics/{notify,wait}` stopped throwing their TypeError** (pass→fail). The
  pre-wave native vec is not a valid `Atomics` receiver, and that is what
  produced the TypeError those two rows assert. Handed a genuine host view over
  a genuine SharedArrayBuffer, `Atomics.wait(i32a, 0, 0, 0)` simply returns.
- **Seven detached / resizable `TypedArray/**` rows went from an ordinary
  assertion failure to `RuntimeError: illegal cast in __module_init_chunk_*`** —
  a downstream read `ref.cast`s the host view to the checker-typed vec. That is
  the illegal_cast trap growth 28→35 the same run reported.

A **second, standalone-lane** defect of the same pin surfaced while measuring:
both `$__ta_view` arms in `array-methods.ts::compileArrayMethodCall` (the
`subarray` sibling-view arm and the #3054 B1 materialise-and-rebind arm) are
guarded by `fctx.localMap.has(receiver)`, i.e. they only ever ran for a LOCAL
receiver. With the module-global pin in place, `ta.fill(…)` on a top-level `ta`
fell through to the generic arm and `ref.cast` the view to the element vec —
five standalone rows changed trap kind (null-deref / TypeError → illegal cast).
Minimal repro, `--target standalone`:

```ts
let rab = new ArrayBuffer(4, { maxByteLength: 8 });
let ta = new Int8Array(rab);
export function test(): number { ta.fill(9); return ta[0]; }   // illegal cast
```

### Fix

1. **`declarations.ts`** — the module-global pin adopts `inferTaViewType`'s
   answer **only when it is a `$__ta_view` struct** (`isTaViewTypeIdx`). A
   host-lane global keeps the slot it had before the wave. This is the whole
   host-lane regression: reverting only this file restores all nine rows
   verdict-for-verdict.
2. **`array-methods.ts`** — a `$__ta_view` receiver that is a MODULE GLOBAL is
   spilled into a synthetic local (the same struct ref, so the shared backing
   and the #3054 B3 write-through are unaffected) so both existing arms apply
   unchanged. The synthetic mapping is DELETED after dispatch — restoring it
   would shadow the global for the rest of the function.

No trap-growth valve, no skip-list edit, no new host import.

### Verdict matrix — the nine flagged rows, 9 × 2 lanes × 3 trees

`pre` = pristine `git archive 985de5b65b` tree, `main` = `5dd7a92169` (current
main), `fix` = this change. Compile timeout 120 s (the stock 15 s default
falsely reports a third of these rows as `compilation timeout` on a loaded
4-core box).

| # | Row | host `pre` | host `main` | host `fix` | sa `pre` | sa `main` | sa `fix` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `Atomics/notify/null-bufferdata-throws.js` | **pass** | fail (Expected a TypeError but got a undefined) | **pass** | fail (illegal cast, pre-existing) | fail (illegal cast) | fail (illegal cast, unchanged) |
| 2 | `Atomics/wait/cannot-suspend-throws.js` | **pass** | fail (Expected a TypeError… no exception at all) | **pass** | fail (illegal cast, pre-existing) | fail (illegal cast) | fail (illegal cast, unchanged) |
| 3 | `TypedArray/from/…-mapper-detaches-result.js` | fail (TypeError: `%TypedArray%.from` on incompatible receiver) | fail (**illegal cast**) | fail (same TypeError as `pre`) | fail (illegal cast, pre-existing) | fail (illegal cast) | fail (illegal cast, unchanged) |
| 4 | `TypedArray/from/…-makes-result-out-of-bounds.js` | fail (same TypeError) | fail (**illegal cast**) | fail (same TypeError as `pre`) | fail (Array method called on null/undefined) | fail (**illegal cast**) | fail (TypeError, no trap) |
| 5 | `TypedArray/out-of-bounds-behaves-like-detached.js` | fail (SameValue «10» vs «undefined») | fail (**illegal cast**) | fail (same assertion as `pre`) | fail (illegal cast, pre-existing) | fail (illegal cast) | fail (illegal cast, unchanged) |
| 6 | `TypedArray/prototype/fill/absent-indices-computed-from-initial-length.js` | fail (SameValue «1» vs «4») | fail (**illegal cast**) | fail (same assertion as `pre`) | fail (dereferencing a null pointer) | fail (**illegal cast**) | fail (SameValue «1» vs «4» — real assertion) |
| 7 | `TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js` | fail (compareArray mismatch) | fail (**illegal cast**) | fail (same assertion as `pre`) | fail (Array method called on null/undefined) | fail (**illegal cast**) | fail (compareArray mismatch — real assertion) |
| 8 | `TypedArray/prototype/subarray/result-byteOffset-from-out-of-bounds.js` | fail (SameValue «NaN» vs «4») | fail (**illegal cast**) | fail (same assertion as `pre`) | fail (Array method called on null/undefined) | fail (**illegal cast**) | fail (SameValue «0» vs «4» — real assertion) |
| 9 | `TypedArray/prototype/with/index-validated-against-current-length.js` | fail (array element access out of bounds) | fail (**illegal cast**) | fail (same trap as `pre`) | fail (WebAssembly.Exception) | fail (**illegal cast**) | fail (array element access out of bounds) |

Totals — host: `pre` 2 pass / 7 fail, `main` 0 pass / 9 fail (7 illegal casts),
`fix` **2 pass / 7 fail, row-for-row identical to `pre`, zero illegal casts**.
Standalone: no pass/fail movement in any tree; the illegal-cast SET is
`{1, 2, 3, 5}` in `pre` and exactly `{1, 2, 3, 5}` again in `fix` (it was all
nine on `main`), so standalone trap growth is back to zero and rows 6/7/8 now
reach a real assertion instead of any trap.

### Re-validation

| Check | Result |
| --- | --- |
| 9 rows, host lane, 120 s | **2 pass / 7 fail**, identical to the pre-PR tree, no `illegal cast` |
| 9 rows, standalone, 120 s | 9 fail; illegal casts only the 4 that pre-date the wave |
| 53-row buffers list, standalone, 120 s | **16 pass / 32 fail / 5 compile_error** — same 16 rows as the wave's own run, `diff` of status+path against it: no differences |
| 20-row `built-ins/TypedArray/prototype/**` control (deterministic every-38th passing row) | **20/20 pass** |
| 27-row `fill/set/subarray/with/copyWithin/sort/slice/includes/indexOf/join/reverse` control (every-11th passing row) | **27/27 pass** — covers the `array-methods.ts` arm directly |
| `npx vitest run tests/issue-5150-es2015-buffers.test.ts` | **18/18** (14 + the 4 new guards) |
| `pnpm run typecheck` (TS7) | clean |
| loc / func / coercion / oracle-ratchet / dead-exports | all exit 0 |
| `pnpm run test:equivalence:gate` | no NEW failures |

The four rows above are now IN-PROCESS cases in
`tests/issue-5150-es2015-buffers.test.ts` (`HOST_ATOMICS_ROWS` must `pass`;
`HOST_NO_TRAP_ROWS` must not contain `illegal cast`), so this cannot return
silently — the host lane had no guard at all in the original wave.

## 2026-09-28 census handoff: dynamic DataView constructor identity

Frozen standalone census index 55 at `f924650c6c26237f62b08a362d7003d4d2b1e12d`
records `test/built-ins/DataView/defined-byteoffset-undefined-bytelength.js`
failing a SameValue comparison of two printed native functions. The original
checks byte length, offset, and buffer before `sample.constructor === DataView`
and prototype identity. The observed error is consistent with the constructor
assertion; an assertion-specific emitted diagnostic is still required.
Issue 4444 retains the complete 92-path shard receipts and hashes.

Read-only current-base audit (`e5e69140ea74f9f143639ddfa41b94312895f3b0`)
identifies a likely dynamic default-prototype gap. DataView's `constructProto`
field uses null to mean intrinsic `DataView.prototype`. In
`ta-dyn-mop.ts::fillDataViewConstructProtoArm`, getPrototypeOf has the intrinsic
fallback, while the dynamic property-read arm delegates only for a non-null
custom prototype. The bare `var sample` can take this dynamic route. Existing
static/prototype paths already provide canonical constructor identity.

Plan, coordinated with issue 3371's DataView construction/prototype owner:

1. Verify the failing assertion and dynamic route using the exact original
   with a matched passing constructor/prototype control.
2. Repair generic intrinsic-prototype lookup for the null default carrier,
   preserving custom NewTarget prototypes and instance-own precedence. Do not
   special-case the property name `constructor` or extend ArrayBuffer's
   different carrier incidentally.
3. Cover offsets 0–4 with explicit undefined length; dynamic constructor and
   prototype identity; another inherited member; custom NewTarget prototype;
   and own-property shadowing before repeating the matched maintained cohort.

No source changes or compiler runs were made by this audit. The exact source
area overlaps issue 3371's recorded claim; independent implementation remains
held until that ownership is reconciled.

Root's fresh read-only claim check (session 84870) confirms the hold:
authoritative upstream issue 3371 is claimed by `ttraenkler/fable-es6`
since 2026-09-04. The script exits 3 for the occupied claim and explicitly
identifies a different origin record as stale/shadowed. No takeover or
competing DataView implementation was attempted.

## 2026-10-05 Astra plan: admit a DataView subclass to the existing isView test

This is a source-only proposal for the single original
`test/built-ins/ArrayBuffer/isView/arg-is-dataview-subclass-instance.js`,
not a constructor, TypedArray, or shared-carrier repair. Root must read this
appendix before a Sol 6.1 High implementer changes source. No compiler,
runtime, provider, harness, claim, or fixture was changed by this planning pass.
The old 784-line issue history is preserved, including its uncompleted work.

### Pinned original and evidence

The scout receipt in the read-only native-guard observation worktree is
`.tmp/scout-v3/receipt.json`, SHA-256
`a4001f4c9c74a140444064c96f9cb6f612372608c79354965bd9e265118c89f6`.
It records source head `1787b1af4a2f010f51ca1f45fc68fa540bfa4673` and
the retained full-census row: honest oracle 14, providers auto, strict both,
reached_test true, `Test262Error: Expected true but got false`.
That is historical evidence, not a current baseline or a measured gain.

The unchanged 583-byte original has SHA-256
`ae677fa63dfe206d04fb838b81ebaaefa165b4d769723c3081bbdfd54c897397`.
Its executable body declares an empty `class DV extends DataView {}`,
constructs `new DV(new ArrayBuffer(1), 0, 0)`, and asserts
`ArrayBuffer.isView(sample)`. Its normative contract tests the internal
ViewedArrayBuffer slot, not the class name or prototype resemblance.

### First semantic loss and the already-landed producer

In `src/codegen/expressions/call-namespace-static.ts`,
`compileNamespaceStaticCall` starts at line 767; its argument-bearing
ArrayBuffer.isView arm is lines 938–998 in the read source
SHA-256 `919dc90b319bc53ad87d1cb9f4feac5da94a87f76799c96a7b6762cd981f6f9f`.
The static symbol is DV, not DataView. Lines 956–970 classify this named
class as `isResolvableNonView`, evaluate and drop the value, then emit false.
Consequently the existing runtime carrier test never examines that value.

This is not evidence that the constructor needs another implementation:
`builtin-subclass-new-site.ts::newSiteBuiltinParent` lines 61–73 admits
this memberless, direct, externref-backed DataView subclass. The landed
`new-super.ts` lines 8033–8045 delegates its same argument nodes through
`tryCompileIndexedBuiltinNew`; `compileNewSiteBuiltinSubclass` boxes the
actual native result and performs the existing constructor-property install.
These producer functions are read-only dependencies, not proposed edits.

The consumer already compiles an admitted runtime argument once as externref,
coerces an actual differing result type, converts to anyref, and stores it in
one local before `isViewRefTestInstrs(ctx, anyTmp)`. That helper registers the
DataView window type and tests actual carrier references. Its existing
ArrayBuffer exclusion and TypedArray handling stay byte-for-byte unchanged.
Its documented ordinary-array imprecision is not a grant to broaden this fix.

### One production hunk; no new helper or dependency edge

Only change the static-negative admission predicate inside the existing
standalone ArrayBuffer.isView arm of `compileNamespaceStaticCall`.
Use the already-resolved `argSym`, normalize through the existing
`ctx.classExprNameMap` convention if needed, and consult existing class
metadata: externref-backed membership, builtin parent DataView, and direct
parent DataView. A positively identified direct DataView subclass is NOT
eligible for the static-negative fold. Let it fall through into the existing
runtime branch. Do not emit constant true from heritage.

The context producers were inspected: `class-bodies.ts` lines 1181–1201
sets builtin-parent and externref-backed records, including ancestor
propagation. Requiring the direct-parent record keeps the new admission
bounded to the direct subclass family; it does not adopt deeper-constructor
work. No context map is written, widened, or reinterpreted. No new raw
checker query, import, shared helper, runtime field, type-registry entry,
feature flag, or late-import registration is needed.

Keep `isView`'s existing builtin-typed positive fold, all other static-negative
cases, unknown/union fallback, zero-argument arm, and JS-host route unchanged.
Gate the new exception to the negative fold on the standalone mode where the
read producer is established; do not silently extend WASI construction.
The runtime value decides the result even when an admitted class-typed input
does not carry a native DataView. A lookup miss remains the previous route.
Evaluate the argument once, preserve its exception, and neither synthesize a
view nor consult or invoke a user prototype getter to manufacture a brand.

Only the one source file, one new issue-local test file, and this issue's own
append are prospective implementation scope. If the original still fails
after bypassing the false fold, preserve its evidence and stop: do not repair
the constructor, shared isView carrier chain, generic coercion, or IR here.
Do not opportunistically repair extra-argument, shadowed-namespace, arbitrary
Reflect.construct, custom-constructor, or first-class method behavior.

### Function-level ownership and integration gate

The maintained scout read at assignment tip
`2394b66331c392d3adeedf3ac0191f542fff35f7` reports
`5150:isview-subclass-static-fold` UNASSIGNED from upstream; parent 5150 is
reserved without a live claim. The implementer must freshly check and acquire
that exact leaf on its own branch before code. The planner has not claimed it.
3240's legacy reservation is not an implementation grant.

The positive live 5317 hold remains held by `ttraenkler/fable-es6`. Its CURRENT
constructor-lookup rescue scope, lines 44–65, owns ta-dyn-mop ordinary Get,
native-proto companions, and proto-index-store reservation, not this static
ArrayBuffer.isView predicate. Do not use historical umbrella tables or a done
status as a release. The proposed predicate does not edit those protocols.
6651's native producer, 3972's subclass machinery, 3240's constructor tracking,
and 6769's TypedArray subclass work remain outside scope and unchanged.

Positive published shared-file patches were read, not labeled whole-file
clear: PR5883 at `6f73c8e` changes Promise imports and combinator emission;
PR5753 at `11b3995` changes Symbol.for branding and JSON record-array lowering;
the PR6468 file patch (blob `07ee0d5542e838b04b95f1aad1914bceec0d3cd8`)
changes Reflect function admission and defineProperty rejection handling.
None of these reviewed hunks changes the ArrayBuffer.isView negative fold.
They still require ordinary merge preservation. Fresh pre-dispatch must
recheck changed published heads and any new exact hunk reservation; this
dated review is not a global source clearance or takeover.

### Finite unchanged originals and focused controls

Keep the original eight-row manifest immutable. Use the additive nine-row
manifest `.tmp/scout-v3/5150-nine-originals.txt`, SHA-256
`31270258baad9e7dc8fd34e717b126b387bad079edaa4db24ee3074be6cd81a7`,
for one target plus eight historical PASS controls: direct DataView,
ArrayBuffer, ordinary object/array, primitives, omitted argument, DataView
constructor, DataView buffer, and the ordinary TypedArray constructor family.
The added TypedArray original is a positive control, NOT the held subclass
failure. The nine-row contract SHA-256 is
`c1e60e459a85db706cf477dd21ba87a555e77dd4faba360f3da960b7f775619a`;
its original and testTypedArray harness hashes are pinned. Historical 8P/1F
does not substitute for current measurement. Corpus/oracle/expectations stay
unchanged; no provider shortcut or customized original body is acceptable.

The separate eight-case source-only proposal is pinned at
`.tmp/scout-v3/5150-focused-proposal.mjs`, SHA-256
`08bd3891eebe7d91efbe04cd153d8dfcf80dca00a36cc846fed532e0ae6c1a16`.
It covers the empty subclass, direct DataView, direct TypedArray, ordinary
class, plain array, ArrayBuffer, one evaluation with expected 11, and a
runtime non-view value with expected false. Freeze these sources and normal
standalone options before execution; the last union-return control guards
against heritage-constant-true reasoning but does not alone prove admission
of a non-view with the exact DV static type. Supplement the issue-local test
with a DV-typed parameter supplied an ordinary object through a type-only
cast: expected false, no cast to the DataView carrier before ref.test. This
additional negative must be root-read and frozen before its first run.

### Execution and acceptance, all still NOT_RUN

After source approval, Sol prepares one isolated worktree at verified main,
the exact leaf claim, the one-hunk patch, and frozen sources/options. Root
reads the diff and manifests before granting a heavy lease. Use canonical
Node 24 and the maintained original harness, honest oracle 14, auto providers,
unaltered strictness and physical identity expansion. Rebuild normal bundles
and validate current cache provenance after source changes; no stale key or
provider override. Record actual imports and reject host fallback.

Measure baseline then candidate for all nine originals and focused controls,
retaining row identities, registered callback/physical floors, reached_test,
terminal status, imports, actual source/binary/WAT hashes and provider
fingerprints. Inspect the original's WAT/export for the removed false fold
and reached native reference test, not merely the presence of helper names.
Root must read actual rows before any attribution claim.

For attribution, remove ONLY this admission hunk in a separate controlled
version: the target must recover its baseline failure while all baseline PASS
controls stay PASS; restore the exact patch and recover the candidate result.
No unrelated source removal, weaker expectation, case deletion, oracle change,
or carrier mutation is permitted. If target remains failing or any control
regresses, stop at that finite result and hand off the first-loss evidence.

Before publication run normal source/architecture ratchets and ordinary hooks;
there is no new allowance, SCC node, flat codegen file, or IR edge intended.
Only a matched unchanged-original improvement with preserved controls and
successful removal/restoration supports one original gain. No present gain,
completion of the 82-row buffers wave, or repair of the TypedArray subclass
original is claimed by this plan.

## 2026-10-05 Sol preparation: bounded DataView isView consumer admission

Isolated worktree `/Users/thomas/Code/js2/.codex-worktrees/5150-dataview-subclass-isview-sol`,
branch `codex/5150-dataview-subclass-isview`, exact freshly verified upstream
main `fd60087e505e964b23c642bc20b3c2d7e3476c4f`. The source grant is only
the standalone negative-fold predicate in `compileNamespaceStaticCall`, one
new issue-local focused test, and this MD. No constructor, shared carrier,
coercion, identity/prototype, TypedArray, frontend/IR, runner or oracle edit.
Other agents are active; their changes and retained worktrees remain intact.

The approved Astra appendix was read completely and transferred byte-for-byte
through apply_patch: original784-line prefix SHA256
`8ba447ac4877050692967006866e78d5b3e136d106a7ed4e06f8f239fc036a23`,
append SHA256`635ecd083acd44ec3f6693984f418d221afd034121b39bc05a59a1d413bb298d`,
whole transferred MD SHA256
`27da1c4b19362fa7486e2170e047815ebe32a27df53a83c250e61666c5748280`.
This preparation record is additive; all earlier wave/history remains.

Fresh maintained ledger read actual handle3423/terminal434002 exit0 at
`b0d6be7f215af281c4dc66055e112ac62f15615d`:2662 records/1044 held;
exact`5150:isview-subclass-static-fold` UNASSIGNED. Complete upstream open-PR
scan reads19 PRs/1432 changed paths, including full REST pagination when
GraphQL's100-file page is incomplete. All actual matching source patches were
read for PR5753@11b3995784,5784@5aa3d8f857,5883@6f73c8edd1,
6468@b19e6d6b1d. They change Symbol/JSON/Reflect/Promise regions, not this
isView predicate. This is hunk-level preservation, not whole-file clearance.
Live5317/3972/6651/6769 held records stay held;5317's current narrow
constructor-lookup rescue scope44–65 was read, not released from old status.
Exact own leaf acquisition actual handle66228/terminald772d3 exit0 verifies
`ttraenkler/script_plan_p1_sol`, own branch, upstream assignment ref only.
Full raw calls, claims, paginated paths and matching patches are retained
under own ignored`.tmp/5150-preparation`; no competing leaf was acquired.

The one source hunk normalizes existing argSym via existing classExprNameMap,
then reads standalone + externref-backed + builtin-parentDataView + direct
parentDataView metadata. Such a value bypasses only the static-false fold and
reaches the unchanged actual-carrier runtime test. No constanttrue from
heritage; no map write/new raw checker query/import/helper or registry change.
Current source SHA256
`58cf524dc788bcb2915e33b7e2ab01efc2f752c0f1fc945744d0fab996e559d9`;
baseline preimage retained SHA256
`919dc90b319bc53ad87d1cb9f4feac5da94a87f76799c96a7b6762cd981f6f9f`.

New`tests/issue-5150-dataview-subclass-isview.test.ts` SHA256
`1ca7bf1086e35eab26a3269ae831791e8b6db86aa96c6c6c166ae22a086f9de7`
preserves all8 proposed cooked source/expectation pairs and adds the9th
DV-typed parameter supplied an ordinary object through type-only casts,
expectedfalse. Exact focused compile options are fileNametest.js (9thtest.ts),
allowJstrue, skipSemanticDiagnosticstrue, targetstandalone. The diagnostic
suppression is focused-only, never an original-runner override. Each case
requires compile success, empty host and physical import maps, ordinary
buildImports/instance initialization and an actual callable run export.

Approved read-only dependency links point to existing canonical primary
node_modules and26 populated corpus entries, excluding.git while retaining
own test262 directory. Actual corpus HEAD
`b363f29d3c43c626dc852744ad64a0b48a003693`, all9 original body hashes and
testTypedArray harness hash match the scout. No installs/provision/config/LFS
repair. Initial ordinary status failed sandbox LFS temp write; retained, then
read-only filter-disabled status succeeded without changing Acorn bytes.

Source-only `.tmp/5150-preparation/frozen-contract.json` SHA256
`e0fe5965c926933b11e29a13c066aaa3fdaebf7df690c0e5cc3d0e0efedd3d04`
records1848 actual inputs/1824src files, all9 literal originals/harnesses,
9 focused sources/options and accepted native input artifact byte pins.
Compact full contract for root review is`contract-review.json` SHA256
`ae6ee0eb8ed7e0d8b26a121203319e2a88d1833bf2015da8b47047cfe6fcfffa`.
Manifest9 SHA256
`31270258baad9e7dc8fd34e717b126b387bad079edaa4db24ee3074be6cd81a7`
is unchanged; historical8PASS/1FAIL is context only. One original target,
eight original positive controls, nine separate focused cases; no conflation.
The initial freeze script hit a wrong guessed completeness-validator filename;
no compiler ran. Corrected to actual validate-test262-completeness.mjs and
the source-only freeze completed; no expectation or source contract changed.

Proposed build/maintained exact-manifest/sharded-runner recipe is retained as
`.tmp/5150-preparation/recipe.md`. ROOT must review the bounded executable
recipe and WAT diagnostic collector and grant each runtime/build lease.
Every baseline/candidate/removal/restored run, focused execution, diagnostic
compile, native/adapter build and normal hook is currently **NOT_RUN**.
No original gain, current full-census result,82-row completion, constructor
repair or TypedArray-subclass credit is claimed.

## 2026-10-05 Sol measurement: one original attributed by removal/restoration

This supersedes the preparation-only NOT_RUN statements above for the finite
measurements recorded here, not for the remaining buffers wave. Root independently
read all four actual result maps and all 64 durable shard completions and accepted
this narrow attribution. The whole historical MD prefix through the preparation
record is preserved byte-for-byte; its pre-append SHA-256 is
`b7f2e824f6ff0b06b1cc7153c5140ed111aed61d347e0e5f3c2f7e01e20cddb7`.
The implementation remains the single consumer hunk and nine-case focused test;
the constructor/helper/shared-carrier/TypedArray/IR/runner/oracle exclusions remain.

### Matched instrument and artifact contract

Additive frozen contract `.tmp/5150-preparation/frozen-contract-v2-final.json`,
SHA-256 `72508e4117557493007889212bddf287ccd1c27dc0fef63cc1286de25d1fcf7f`,
pins 2,293 actual inputs including all 1,824 src files, all 16 maintained shard
entrypoints, assembly/factory/worker/provider/build inputs, nine original bodies,
three harness files and nine focused sources/options. The canonical Node binary
and 310 existing dependency files make 311 byte-pinned tool inputs. Earlier V1
and provisional V2 receipts are retained rather than rewritten.

Canonical Node 24.19.0 was used throughout; bundle/build/original/diagnostic parent
and worker limits were 3,072 MiB, while the focused test parent/fork used 1,024 MiB.
Inherited provider/compiler/IR/skip/Git overrides were scrubbed and original PATH
was preserved. No install, provisioning, configuration, LFS repair or donor write
occurred. No source or MD change occurred while a test/build was live.

Read-only accepted native input came from the retained P1 shipped artifact, copied
as exactly three pinned bytes into each new exclusive own build directory. Native
binary SHA-256 `95333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c`,
ABI SHA-256 `4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b`
and build-info SHA-256 `c970d9db70077ade6277b6f6cb44fc110951b7ebc3c240d3abd5845c3db3876e`
were verified in donor, own acquisition copy and ordinary keyed cache before/after.
This root-approved source-consistent artifact acquisition was not a semantic
provider override; original runs used the ordinary own cache with quickjs/auto.

The reviewed build-only wrapper SHA-256 is
`392c01e43eb430e0ea8cf612e4aecd4203c4c8123acd12ef12b6df8bc625a074`.
Every successful arm ran the same four ordinary commands: compiler bundle, runtime
bundle, maintained provider builder, then maintained builder --require-cache.
All four true command exits were zero; normal canary/linked-pair gates passed.
The candidate was a normal adapter MISS with canary verification; subsequent arms
used normal HIT linked-pair verification. No raw canary values are invented from
the successful maintained gate. Native key remained `04a9abfac8350642`.
Baseline/removal compiler-input key was `ff97d4c71ce3b003`, adapter key
`d37c636f62467b93`; candidate/restored keys were `98aa31dd0e712cf3` and
`b46310166a106197`. Both adapters have the same actual SHA-256
`fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`,
27 physical imports and 39 exports; native core has five WASI imports and 80
exports. Full maps and provenance are retained in each postflight JSON.

Build postflights, all under this worktree's ignored `.tmp/`, are:

- Baseline `5150-baseline-build.xs98vZ/postflight.json`, actual handle 59423,
  terminal c2aace exit 0, SHA-256
  `836cc7ff603195f8257ac9ee45f16bc0441e37fdd4a2b0bf03b6ed94bba0618e`.
- Candidate `5150-candidate-build.Ep3DdI/postflight.json`, handle 42364,
  terminal 9caa1a exit 0, SHA-256
  `5a40cde20a26e594dce00513f2b04f8f32f95bf3aa9c9c51d60daf9553181294`.
- Removal `5150-removal-build.5mw1OY/postflight.json`, handle 59060,
  terminal 659583 exit 0, SHA-256
  `5781a73523ebde5281e3bfc7a42c43209d7b2c4bd1e6f8c3ce3c4e8b646755de`.
- Restored `5150-restored-build.ZL7G2h/postflight.json`, handle 23676,
  terminal 98e4d5 exit 0, SHA-256
  `3439c87e76e79de4f6286a51f46f5d7487951ca206e6bc2cc1e9387e49ea7604`.

Removal bundles/native/adapter bytes exactly match baseline; restored bytes
exactly match candidate. All 2,293 phase-aware source pins, 311 tool bytes and
three donor bytes remained unchanged within each arm.

### Nine unchanged originals: exact physical identity floor

The unchanged manifest SHA-256 remains
`31270258baad9e7dc8fd34e717b126b387bad079edaa4db24ee3074be6cd81a7`.
All nine physical originals are under `test/built-ins/ArrayBuffer/isView/`:
`arg-is-dataview-subclass-instance.js`, `arg-is-dataview.js`,
`arg-is-arraybuffer.js`, `arg-has-no-viewedarraybuffer.js`, `arg-is-not-object.js`,
`no-arg.js`, `arg-is-dataview-constructor.js`, `arg-is-dataview-buffer.js` and
`arg-is-typedarray.js`. Their bodies/harnesses and expectations were not edited.

The reviewed original-only wrapper SHA-256 is
`757396facd74c18dede87a1b2f2660d3a7cc73cffcb1010ac5b7596b60da3fd1`.
It used all 16 maintained shards, one fork, no file parallelism, honest oracle 14,
auto semantic providers and unchanged strict policy. Every arm has nine unique
registered/reached_test physical rows, strict=both, zero exclusions/skips, nine
started/settled callbacks and all 16 durable completion manifests. The bounded
--passWithNoTests flag only accommodates the seven empty shards; the positive
nine-row floor and maintained completeness validator still fail closed.

- Baseline: actual handle 16492, true terminal 428fc4 exit 1; Vitest 1,
  completeness 0; **8 PASS / 1 FAIL**. Receipt
  `5150-baseline-originals.2TSS2L/receipt.json` SHA-256
  `f721bbe6bc280c69a51350bffd86384142dfcf365804d718580f862d3a8c7c4a`.
- Candidate: handle 9640, terminal 059c70 exit 0; Vitest/completeness 0;
  **9 PASS / 0 FAIL**. Receipt `5150-candidate-originals.bQYkEU/receipt.json`
  SHA-256 `111d722845692f4863c618c01d514d05ff5c2756b7b5aaf7065347c4bfd071fc`.
- Removal: handle 5227, terminal 023ff9 exit 1; Vitest 1, completeness 0;
  **8 PASS / 1 FAIL**, exact baseline identity/status/error map. Receipt
  `5150-removal-originals.mw6fYP/receipt.json` SHA-256
  `317ccd104921f51bef09ac1d80ce6fa205f8d04765358a7cbbc63bafb4103165`.
- Restored: handle 50242, terminal 1a4050 exit 0; Vitest/completeness 0;
  **9 PASS / 0 FAIL**, exact candidate identity/status/error map. Receipt
  `5150-restored-originals.2WWzZc/receipt.json` SHA-256
  `be03b1e163fac800c294f1e31b4c9ac0132c9dfb7fe4fc97a0b1a1c6b4b93cc2`.

The only changed verdict is `arg-is-dataview-subclass-instance.js`: baseline and
removal retain `Test262Error: Expected true but got false`; candidate and restored
pass. All eight controls pass in all four arms. Read-only process checks confirm
the completed own Vitest PIDs and own test262 workers absent before source-arm
transitions. Final restored proof SHA-256 is
`7c394bcc640a80f9e3b4e4895e13ea047ea14a1eeb4c618c81c9a3211c912a9d`.

### Focused safety and generated-code observations

The unchanged nine-case focused fixture ran once: handle 57078, actual Vitest
exit 0 and all nine assertion rows passed, including one-evaluation result 11 and
both non-view negatives. Whole source/tool/artifact bytes stayed fixed.
The capture process exited 1 because its title matcher compared unquoted case IDs
to Vitest's single-quoted it.each titles. Original false-floor receipt SHA-256
`9b0620922112edde0a9915983d7e7d06c22ae4335e1fae5bd404b221e1a03cee` and
actual JSON SHA-256 `fff19d6accae2e3740d32de89b99c88f056431a9c5faaabbe043d1792044ae74`
remain immutable. Root reviewed the actual nine rows; receipt-only corrected audit
`5150-candidate-focused.tAVIf6/corrected-audit.json`, SHA-256
`3f1da7cc09b9f56d2fcbbcaae2f2cab36da2ef017a1cbb62bc7e6f43edbfe988`,
requires exactly the nine frozen single-quoted titles, unique/equal sets, all passed,
zero skips and original terminal 0. No test rerun or expectation/source change.

Diagnostic-only collector SHA-256
`ab62d56941ce2e981e24cb19875be6a648e68ae4eefecc1931e94f691f783c15`
ran handle 94506, terminal d3aa5f exit 0. Actual maintained assembly gives **18**
units, not 27: nine original primary assemblies (strict rerun classified
strict-neutral by the unchanged harness) plus nine focused sources. Every unit
compiled successfully, with binary/WAT bytes and both metadata and physical
imports empty. Receipt `5150-candidate-collect.bxZpX8/receipt.json` SHA-256
`a9b96a84856a4996445903b94664c7f7167d196f95ac289221a8460dbfb345f0`
binds source/options/worker compiler hash, native input key and complete maps.
These are diagnostic compilations, not 18 extra original verdicts or executions.

Original target WAT's actual `__module_init` reads sample at lines 132433–132448,
converts extern to any and reaches the ref.test chain including the native
DataView window (type 303, declaration line 305), not a heritage constant true.
The DV-typed-parameter negative has an externref parameter, actual any conversion
and ref.test chain; its complete check body has no ref.cast, and run supplies an
ordinary object. The focused execution observes false. No inliner override or
constructor/helper change was needed.

A separate removal pre-child failure is also retained: terminal 81e0e7 exit 1
correctly rejected source SHA 501835... because removal had left the negative
predicate's candidate multiline formatting rather than its literal baseline line.
No build child/stage began. Root read the formatting-only diff; apply_patch restored
the exact 919dc90b... preimage before the separately named successful removal
build. The original failed log was not overwritten; no unknown live job was retried.

### Publication boundary

This establishes **one attributable unchanged-original gain** with eight controls
preserved. It does not promote a full-census rate, close this 82-row wave or repair
TypedArray subclasses, held constructor protocols, or any other residual family.
At this checkpoint normal publication gates/hooks/commits/push/PR remain NOT_RUN.
The later read-only upstream check resolves main to
`27b18d375f0c446fcd5662056a35261db9881f7b`; own measured source was based on
`fd60087e505e964b23c642bc20b3c2d7e3476c4f`. Root authorizes ordinary own-branch
integration and normal gates only: preserve foreign IR changes, rebuild current
artifacts, and rerun focused nine plus unchanged original nine on integrated
source before publication. Prior four-arm receipts remain historical matched
evidence, not a substitute for integrated-source measurement. No hook/skip/config
bypass, installation, force push, shared cleanup or primary-checkout mutation.

### Actual publication gate stop, 2026-10-05

Scoped Prettier --check for the two owned TS files returned 0 (cb6484). The next
required LOC ratchet returned **1** (6057ca):
`src/codegen/expressions/call-namespace-static.ts: 4564 > 4550 (+14)`.
The existing issue allowances do not cover this driver file. Publication stopped
before staging, commit, merge, hooks or push. No allowance/baseline/gate/config
change, helper/protocol expansion or bypass was applied. The heavy lease was
yielded; resolution needs scoped root review. Function-growth and remaining
normal gates are still NOT_RUN, not presumed passing from the focused results.

The exact public main comparison is retained as ignored
`.tmp/5150-preparation/integration-compare.json`, SHA-256
`891890fffb6b12eecd60b9bfb2303995b705331a3bd9bef3259a37e5077a59f0`:
seven commits ahead, zero behind, merge-base fd60087..., all 47 changed paths.
Canonical IR-owner relocations, N0/Map documentation and benchmark data are
foreign changes to preserve; none overlaps these three owned paths. This is
read-only integration evidence, not a performed merge or current merged-source
validation. Prepared publication steps and repository-formatted PR body are
retained in own ignored files; no GitHub issue or PR was created at this stop.

## Structural publication repair: pure isView classification, 2026-10-05

Astra High plan only, requested after actual LOC gate failure6057ca.
The measured one-function DataView-subclass repair is retained; this plan
changes its organization, not its semantics or original-test contract.
The implementer's read-only donor is
`.codex-worktrees/5150-dataview-subclass-isview-sol`, branch
`codex/5150-dataview-subclass-isview`.
Actual candidate `src/codegen/expressions/call-namespace-static.ts` has
4,564 lines against a 4,550-line base. There is no allowance for this file.
No budget/configuration change or waiver is proposed.

### Exact ownership and patch boundary

A fresh maintained check returned CLAIMED by the existing Sol owner,
`ttraenkler/script_plan_p1_sol`, for
`5150:isview-subclass-static-fold`, since2026-10-04T22:17:11Z,
read upstream/issue-assignments; exit3 is the expected positive ownership
record, not permission for this planner to replace it.
The same owner should implement the structural repair in the same isolated
candidate worktree after root reads this plan and grants the exact diff.

The current5317 document's authoritative scope, lines44–65, is constructor
lookup in ta-dyn-mop/native-proto/proto-index-store. Its live fable claim is
preserved. No constructor, class-metadata producer, TypedArray carrier, shared
isView emitter, IR or runtime implementation is touched here.
The proposed leaf only reads the already populated class maps and set.

The bounded one-shot open-PR exact-path audit returned all16 inventories with
the same complete file floors128/294/93/302/10/9/4/17/3/6/11/102/4/4/4/402.
Actual positive call-namespace-static patches were read:
5753 changes JSON-record-array and Symbol-result arms;
5784 changes Symbol.keyFor and Reflect argument/prototype handling;
5883 changes Promise-combinator imports and dispatch;
6468 at pinned b19e6d6 changes Reflect function admission/define rejection.
None changes the isView classification block or introduces the proposed leaf.
These are disjoint hunk observations, not whole-file releases.
Recheck if any head changes before implementation/publication; preserve every
foreign arm and shared import. No fresh umbrella claim is authorized.

### Selected extraction, with one small pure interface

Add `src/codegen/expressions/arraybuffer-isview-static-decision.ts`.
It has **zero runtime imports**. Use structural TypeScript interfaces declared
inside that file; no import of index.ts, TypeScript, CodegenContext, emitter,
registry, coercion or backend modules is needed.

Export one function returning `boolean | undefined`: true/false mean a static
constant, undefined means the existing runtime path. Inputs are the already
computed `argSym`, `isAnyOrUnknown`, a structural
`rawType: { isUnion(): boolean }`, the existing typed-array-name ReadonlySet,
and structural read-only metadata:
standalone; classExprNameMap; classExternrefBackedSet; classBuiltinParentMap;
classParentMap. The maps are ReadonlyMap<string,string>, the class set is
ReadonlySet<string>; the ordinary context is structurally assignable.
Do not add context fields, new registrations, caches, adapters or map writes.

The driver keeps these existing queries, unchanged and in order:
getTypeAtLocation(arg0), getNonNullableType, getSymbol().name,
getTypeAtLocation(arg0) again, and the existing Any/Unknown flag computation.
Do not move checker work to the leaf or collapse the two queries.

Inside the leaf, move the existing decision statements in their current order:

1. Compute isView from argSym and the supplied typed-array set / DataView.
2. Resolve className through the existing class-expression-name map.
3. Compute the same direct-DataView-subclass runtime requirement:
   standalone, a class name, externref-backed class, builtin parent DataView,
   and immediate parent DataView. Do not broaden to indirect inheritance,
   TypedArray subclasses, different targets or spelling-only heritage.
4. Compute isResolvableNonView with the identical ordered short circuit:
   not Any/Unknown, not isView, not subclass-runtime, not BigInt64Array,
   not BigUint64Array, then not rawType.isUnion().
   In particular, do not evaluate isUnion eagerly.
5. Only then return true for isView or either BigInt array spelling;
   return false for isResolvableNonView; otherwise return undefined.

The static true precedence remains unchanged even for contrived combinations
of Any/Unknown/union flags with a recognized view symbol. Preserve actual
existing conditions, not a simplified interpretation of the comment.

### Caller, LOC and graph contract

Replace candidate lines956–987 (exactly32 lines) with the one pure call and
one shared constant arm. For a defined boolean decision, the caller executes
compileExpression(arg0) once, emits drop only if its result is non-null,
emits i32.const(decision ? 1 : 0), and returns i32.
The old true and false arms perform exactly those same operations.
Use `decision !== undefined`, not truthiness, so false is a constant decision.

Keep the outer namespace/name/argument-count guard, noJsHost branch and all
checker lines intact. Keep the whole runtime fallback and host-import path
byte-for-byte unchanged, including externref request/coercion, temporary,
any.convert_extern, isViewRefTestInstrs, late-import shift flushing and fallback.
The zero-argument and other argument-count behavior is not a new semantic task.

A compact seven-line call/constant arm plus one import replaces32 lines:
the source-level estimate is4,540 total lines, ten below the existing4,550
budget. Formatting may change that number; require the actual formatted gate
to pass before proceeding. Moving only the new14 lines is insufficient.
No baseline, issue allowance, LOC padding/minification or unrelated cleanup.

The leaf's sole incoming production edge is from the existing driver and it
has no outgoing runtime edges, so it cannot join the driver's existing SCC.
It is in the existing expressions subdirectory; the maintained flat-directory
gate counts only direct src/codegen files. No new codegen-to-IR edge or raw
checker query is introduced. Verify all three claims with the normal unchanged
import-cycle, flat-directory and oracle ratchets, not with an exemption.

### Finite verification and publication handoff

Before runtime, root reviews the exact two-source-file diff plus owned tests/MD.
Add finite pure-classifier tests covering recognized numeric views/DataView,
both BigInt arrays, Any, Unknown, unions, undefined symbols, primitive/ordinary
class/array/ArrayBuffer negatives, class-expression aliases, direct DataView
subclass, non-direct parent, non-externref class and standalone=false.
Include call-order spies for isUnion/maps: static-view/Any/subclass arms must
not newly evaluate the union predicate. The classifier must not mutate inputs.

Preserve all previously frozen original9 and focused9 sources/expectations.
After structural correction, ordinary current bundles must be rebuilt and
the same complete focused/original gates rerun under the root's heavy lease.
Compare emitted runtime path/helper behavior to the measured semantic candidate.
Retain the original four-arm baseline/candidate/removal/restored provenance;
this extraction does not create another original gain or erase prior failures.

Run normal type/format/LOC/import-cycle/flat-directory/oracle gates and normal
publication hooks, all unskipped, without allowance changes. Stop on any
semantic row loss, missing physical identity, helper/import change, shifted
evaluation count or failed structural gate. The existing owner's publication
workflow resumes only after actual terminal evidence and root acceptance.
No source was changed, compiled or executed by this planner.

## 2026-10-05 Sol structural implementation: source-only review checkpoint

The exact approved 133-line Astra repair plan above was read fully, then copied
with apply_patch. Approved append SHA-256 remains
`45a6dde3184a1b48710c98d59da746d92bea084082dc2ee4d35b5cb6ff06422c`;
all prior owned history through the actual LOC failure retains prefix SHA-256
`9c0876fa3fc55c74d976d642072c7eadceb3309b5b719f3b0f500320fa959b5a`.
The prior failure is not erased or turned into a gate pass by this preparation.

New private `src/codegen/expressions/arraybuffer-isview-static-decision.ts`
has 42 lines and zero imports, SHA-256
`bc94fb90ebcab4ae0761c2b1406349890dffb2217d8221f15e53a6b421660470`.
Its only exported function returns boolean or undefined from structural readonly
metadata, existing symbol/Any-Unknown facts, a lazy structural isUnion method
and the supplied existing typed-array-name set. It preserves the measured
candidate's decision/read ordering and static-view priority, and never evaluates
arguments or emits code. No context/schema/map/registry/constructor/carrier/IR
change, runtime dependency, barrel reexport or budget allowance was introduced.

The driver keeps its original checker queries and TypeFlags calculation exactly,
then calls the leaf and shares the defined-boolean constant arm. It evaluates
arg0 once, drops only non-null results, emits decision ? 1 : 0 and returns i32;
false remains a defined decision. The measured source is now 4,540 newline-counted
lines, ten below the 4,550-line original driver and 24 below the rejected semantic
candidate. Its source SHA-256 is
`7e7f205a01e8f0f34f6bafd41c2989a1251f30ae0e43aab72ec026da1a4bfa5a`.
These are actual file counts, not a claimed normal ratchet result.

Static capture reconstructed the prior semantic candidate and required exact
58cf524d... SHA before comparison. Ignoring only the new import, the entire
driver prefix through checker queries and suffix from the runtime fallback
through host/other namespaces are byte-for-byte unchanged. This includes the
no-arg guard and unchanged evaluator/coercion/temporary/reference-test path.
All nine original bodies/harnesses and existing nine focused sources/expectations
still match their old frozen bytes; focused file SHA-256 remains
`1ca7bf1086e35eab26a3269ae831791e8b6db86aa96c6c6c166ae22a086f9de7`.

New `tests/issue-5150-isview-static-decision.test.ts` has 31 finite pure controls,
SHA-256 `2516fe751a24a5d0ef16399a674c236c90dedf6da35cc587b5aa63e74f791202`.
They cover all nine numeric view names, DataView, both BigInt arrays, Any,
Unknown, unions, undefined symbols, Number/ordinary class/array/ArrayBuffer
negatives, direct subclass and class-expression alias, non-direct parent,
non-externref class, different builtin parent and standalone=false. Contrived
view-plus-Any/union combinations pin existing static-true precedence. Ordered
map/set/isUnion spies assert exact lazy reads; mutation spies and before/after
entries require no mutation. No new test is counted as a Test262 original.

Scoped Prettier --check initially identified only layout in the new unit test;
four whitespace-only apply_patch edits made all three structural files pass
(actual 6fac1a exit 0). No existing focused source changed. Full source/test patch
snapshot `.tmp/5150-preparation/structural-source.patch` SHA-256
`d95ea5904464132b3b3ff5cc5ef7f48c6dc3d08b57fec107e235bc2f7eb1f13a`
and static proof JSON are retained for root's full read. Current snapshot tests,
type/lint/LOC/function/cycle/flat/oracle gates, rebuild/integration and publication
are **NOT_RUN**. No staging, commit, hooks, push, PR or heavy process was started.
The accepted prior four arms remain historical narrow attribution; this structural
organization and latest-main integration require their own normal verification.

### 2026-10-05 — structural verification and inventory stop

New versioned V3 freeze retained historical V2 unchanged and includes the actual
untracked pure leaf and classifier fixture: 2,299 input files, all 1,825 source
files, all 16 shard entries, nine original bodies, three harnesses and 797 actual
tool files. V3 SHA-256 is
`86004947ac4a9cf393d532031bccdaa25380e3ec1025ff667bf2ecc91f50fa5d`.
The ignored freeze collector's first attempt failed because the installed
`typescript7` alias package identifies itself as `typescript`; explicit package
JSON resolution corrected that instrument-only error. No dependency/configuration
or source change was made to resolve it.

Finite canonical Node24/1024 verification handle 95904 reached true terminal
exit 1 (64be77), stopping at the first actual failed gate. The 31 pure classifier
assertions and nine unchanged focused assertions all passed: 40 unique identities,
zero skipped/pending, Vitest exit 0. Actual Vitest JSON SHA-256 is
`dc0a426c7a1ba95a851b05410b373c1e54b1e34b750e3fd90cb337881df86d22`.
Normal LOC, function, oracle, import-cycle and flat-directory gates each exited 0.
All frozen source, corpus, native-artifact and tool bytes remained unchanged
through each completed boundary. These fixture assertions are not additional
Test262 originals or a full-census result.

The maintained compiler-boundary inventory exited 1 with exactly
`unclassified-module` and `unclassified-target` for the new private leaf.
Its exhaustive per-file policy does not yet contain that path. Full actual gate
log SHA-256 is
`b766eee90bcb1aca3de0d177d5a44273bf69b3e44bd31918c70aa3904683ab09`;
finite-chain receipt SHA-256 is
`503078ecdd5fde4fca80b90ea5c357f8414d209843538709a2cc406a72527cbf`,
under `.tmp/5150-structural-verification.KCxx3V/`.
This is an actual inventory failure, not waived or converted to a pass by the
leaf's zero imports. The policy is outside the five-path source grant; no policy
entry, allowance, layer activation or foreign classification was edited.
Lint/type/issues, staging, commit, integration, push and PR creation did not run
after the failure. Publication remains stopped pending the narrow owned policy
classification decision; prior four-arm attribution remains historical.

### 2026-10-05 — exact new-leaf inventory bookkeeping

Root approved the fully read 73-line Astra inventory appendix (planner MD lines
1090–1162) and extended ownership to exactly one additional policy path. Added
one files[] record for the private classifier: state unmigrated, existing layer
mixed-needs-split, existing destination backend-wasmgc, architectural owner
3518-coordinator, and nextBoundary "Separate legacy class-metadata static
decisions from frontend classification and backend lowering." No layer activation,
allowed edge, existing classification, threshold, allowance or checker changed.
Purity is not claimed as completed architectural migration or conformance gain.

Actual parsed comparison required every previous record and all other policy
fields to equal HEAD exactly: 1,822 old records retained, one new record only.
Ledger SHA-256 is
`b417bbca9ba3ca633cf5d47e6638f2e83af6cdff92668799681b4d39eb693fab`;
proof is `.tmp/5150-preparation/ledger-one-entry-proof.json` (21d762 exit 0).
No assignment absence is inferred from the planner's fresh DNS-UNKNOWN reads;
the existing architectural owner and execution leaf remain preserved. Historical
V3 failure/source freeze is retained. Remaining normal gates, integration and
publication will use a new versioned snapshot and actual outcomes.

### 2026-10-05 — pre-integration normal gate completion

V4 ledger snapshot SHA-256
`b423576b0c7b62f3117c400e521fde3cf9ade2f7862c87f5299da0c6c0065a65`
retains all 2,299 source/build inputs and 797 actual tool files. Canonical
Node24/1024 remaining-gate handle 93018 reached true terminal exit 0 (e733e0):
inventory, full normal lint, TypeScript7 typecheck and issue index/retirement
gates each passed. Inventory honestly reports valid inventory but incomplete
architecture; all old records remain architectural debt where previously so.
Full actual logs and receipt are retained under
`.tmp/5150-remaining-gates.6aYGfO/`, with inventory log SHA-256
`17c49153195533b59e5d0a5d6e9506745af19867ff9191c1eb83c1f85a47fe27`.
Every frozen input/tool/corpus/native byte remained unchanged through the chain.
Together with the preceding five successful ratchets and 31+9 fixtures, the
pre-integration structural snapshot passes the finite checks. The historical
failed inventory and LOC receipts remain recorded; no waiver was used.

Thomas author configuration was verified unchanged before publication steps.
Only the six owned paths will be staged. Full normal commit/pre-push hooks and
latest-main integration followed by new bundles/provider/canaries and original9,
focused9/classifier31 remain pending; no publication success is asserted here.

### 2026-10-05 — integrated source and final finite validation

Candidate commit `cd5bd0f492a06a340da650efa1db0f257431426c` completed normal
unskipped hooks (handle 25129, true terminal 36ccd2 exit 0). Author/committer are
Thomas Tränkler; Codex coauthor and actual GPT-6.1 Sol High attribution are present.
Lint-staged formatting/lint, LOC/function gates, both changed-root fixtures
(nine plus 31 assertions) and oracle gate passed; all six staged images stayed
byte-identical. Terminal log SHA-256 is
`a0d87fe7ab4738ebbb088f4faba8ddebf7077594dd53706d36264eb440fd9e34`.

Normal fetch followed by conflict-free normal merge preserved current upstream
main `27b18d375f0c446fcd5662056a35261db9881f7b`, including IR analysis relocation
and exact policy changes. Integrated HEAD is
`8c69820fa251c64130913e859e087ffb2bb56763`. Actual parsed policy equals upstream
except the one approved new debt record; the other five owned file images equal
the candidate commit exactly. Branch diff against main contains only six owned
paths. No primary checkout, foreign protocol, layer activation or IR source was
edited by this implementation.

New V5 freeze includes all 1,827 actual source files and 2,301 total inputs,
797 tools, unchanged original9/harness3/focused9/classifier31 contracts. SHA-256
`12d900baf399613c33edbf25050896002c7c9510dd2382a500974e5b7c661da7`
is distinct from retained V2/V3/V4 historical freezes. Ordinary maintained bundle
commands and provider/canary build plus require-cache verification completed all
four commands at exit 0 (61008, true terminal 943952). The three pinned native
artifact bytes were copied only into a fresh exclusive own staging directory;
all donor bytes and all source/tool bytes stayed unchanged. Fresh compiler key
`271f317460104faa`, native key `04a9abfac8350642`, adapter key `f36ed7826c560624`
were verified by normal adapter MISS/build/canaries and subsequent required HIT.
No key override, metadata edit, install, provider fallback or skipped gate occurred.
Actual bundles are SHA-256
`7d936f304fb7b530ebaeb20f7b1f52be4da2c36a7cb0fd67e1113db7f8c02ce3`
and `cedd07a11f29e25314a0c33459d0c95794af614dc2b192f27b7b8a397b314e91`.
Actual native/adapter bytes retain 95333826... / fa105724... hashes; actual
imports/exports and full provenance/tool receipts are in
`.tmp/5150-integrated-build.6BFkXb/postflight.json`, SHA-256
`158262f9fbee3e300e9a9ff0937c7249702e6cb725427f4d16e141e46360a798`.

Integrated authoritative nine-original run (91090, true terminal 836a31 exit 0)
passed all nine physical identities: target and all eight positive controls.
Every row has honest oracle14/auto, default both-strict policy and reached_test;
all 16 durable shard completions account for nine registered/settled callbacks,
zero exclusions/skips and completeness exit 0. The approved passWithNoTests flag
only permits empty shards; positive nine-row and 16-completion floors still gate.
All 2,301 inputs, tools, corpus and six artifact hashes remained unchanged.
Full raw rows/maps are retained in `.tmp/5150-integrated-originals.iUuHXd/`,
receipt SHA-256
`1d5bccc3a68d97cfbe82947dea84c26af9bae5740c57d5ede1808a2ad1322bac`.

Integrated classifier31/focused9 and all nine normal gates completed exit 0
(36726, true terminal 50e06a): LOC, function, oracle, import cycles, flat directory,
compiler inventory, full lint, TypeScript7 and issues/retirement. Forty unique
assertions passed, zero pending/skipped. Every source/tool/artifact byte stayed
pinned through every boundary. Actual Vitest JSON SHA-256 is
`5d9dbb80dc446c23181c648eaeb43e76da613f5b3fa8716a30f4ffc1182c5d7f`;
full finite-chain receipt under `.tmp/5150-integrated-verification.rx39WO/` is
`85269e53d52b465768a14a8243f8874c6eea093e1df55c5a0168a3965ec9daa9`.

The prior baseline/candidate/removal/restored attribution remains one original
gain, not another gain for structural extraction or policy bookkeeping. No new
full census, rate, buffers-wave completion or held constructor/TypedArray/helper
protocol result is claimed. Historical LOC/inventory, quoted-title instrument
failure and pre-child restoration-format failure remain intact. This checkpoint
is documentation-only after final semantic validation. Normal final commit and
pre-push/public PR outcomes remain pending until their actual terminal receipts.
