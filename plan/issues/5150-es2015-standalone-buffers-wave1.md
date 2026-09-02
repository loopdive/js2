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
