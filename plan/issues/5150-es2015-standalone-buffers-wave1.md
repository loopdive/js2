---
id: 5150
title: "ES2015 standalone: buffers conformance wave 1"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/dataview-native.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-fn-meta.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/new-indexed.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
---

# ES2015 standalone: buffers conformance wave 1

LOC-growth allowance rationale (2026-08-28): the clusters below add codegen
arms (setter-undefined return, ArrayBuffer.prototype.slice SpeciesConstructor,
ctor argument validation, isView closure body, NewTarget.prototype
observability) to the files in `loc-budget-allow` — measured growth is
expected and granted for this change-set.

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
