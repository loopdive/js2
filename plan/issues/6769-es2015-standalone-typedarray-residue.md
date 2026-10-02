---
id: 6769
title: "ES2015 standalone: TypedArray residue (38 rows) — live-receiver dyn HOFs, species carriers, TA sort compare, instanceof $__ta_ctor, intrinsic-prototype receivers, ctor-arg protocols"
status: done
completed: 2026-09-30
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 6766, 5138, 3177, 2872, 6453, 3406, 2773, 3037, 5185, 6484, 3240]
loc-budget-allow:
  # 2026-09-30 (#6769 plan): the dyn-view map/filter/slice/sort bodies are NEW
  # native helpers (live receiver, spec order) — they go in the two existing
  # leaves listed first; the other files grow by an arm or a guard each
  # (species-result carrier test, $__ta_ctor instanceof arm, intrinsic-proto
  # receiver guards, ctor-arg RangeError cap + static-vec source arm,
  # literal well-known-symbol routing, byte-vec prototype arm).
  - src/codegen/ta-hof-map-filter.ts
  - src/codegen/ta-dyn-proto-methods.ts
  - src/codegen/ta-dyn-method-call.ts
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/native-dynamic-instanceof.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/literals.ts
  - src/codegen/any-boxing-helpers.ts
  - src/codegen/native-proto.ts
  # 2026-09-30 (#6769 implementation): three more files the steps touch, each
  # by a routing arm or a guard — the dispatcher's dyn-view producer arm (S4),
  # the `__getPrototypeOf` ArrayBuffer-carrier arm's call site (S10), and the
  # `any`-receiver `join` decline for the `%TypedArray%.prototype` receiver (S7).
  # Restated here so the grants do not depend on another issue file (#6651's
  # broad grant covers the first today).
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  # 2026-09-30 (#6769 plan): the call-site two-arm gains a helper-call branch
  # per producer method; the species-create validator gains a second carrier
  # arm; the inline ctor gains one guard and one source arm.
  - src/codegen/array-methods.ts::emitDynViewSpeciesMethodTwoArm
  - src/codegen/array-methods.ts::emitDynViewMethodTwoArm
  - src/codegen/dataview-native.ts::emitTaDynSpeciesCreate
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructInline
  - src/codegen/native-dynamic-instanceof.ts::fillNativeDynamicInstanceOf
  # 2026-09-30 (#6769 S4, implementation): the closed-method dispatcher's
  # Array-HOF arm gains ONE conjunct line (a dyn view with a live-receiver
  # producer falls past the Array loop to the producer arm); the arm-building
  # logic itself lives in two new module-level helpers, so the fill grows by
  # exactly that call line.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  # 2026-09-30 (#6769 implementation): three growths #6651's broad grant covers
  # today, restated here so they do not strand if that file leaves the
  # change-set — the S9 detached guard in the 0-arg `toLocaleString` path
  # (+10), the S7d `%TypedArray%` construct throw after the buffer-arg dyn
  # construct (+3), and the S10 ArrayBuffer `[[Prototype]]` arm's call (+1).
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
coercion-sites-allow:
  # 2026-09-30 (#6769 S4, implementation): the live-receiver `filter` producer
  # applies §7.1.2 ToBoolean to the predicate result through the existing native
  # `__is_truthy` — the same helper the packed-vec `filter` in this file already
  # calls. No new coercion logic; one more call site of the canonical one.
  - src/codegen/ta-hof-map-filter.ts
---

## Problem

38 ES2015 standalone rows under `built-ins/TypedArray/**` and
`built-ins/TypedArrayConstructors/**` (realm rows excluded) do not pass.
Measured on `origin/main` @ `d4e15d90f9` (2026-09-30), standalone,
`flock … run-test262-paths.mts .tmp/6769/rows.txt --isolate --standalone`:
**38 fail** (`.tmp/6769/rows-main.log`; the four `detachArrayBuffer.js` rows
need the QuickJS provider — `npx tsx scripts/build-quickjs-eval-provider.mjs`
once — and are re-measured in `.tmp/6769/rows-qjs-main.log`, still 4 fail).

They are not 38 bugs. Thirteen probes (`.tmp/6769/p*.js`, harness shape: `TA`
a parameter, `sample` a function-local `var` — **that shape matters**: the
call-site two-arm only fires for an identifier receiver held in an externref
LOCAL, so a module-level `var sample` measures a different lowering) bucket
them into ten mechanisms, seven of which this slice takes:

| probe | what it measures | main | node |
| --- | --- | --- | --- |
| p1 | `sample.map(cb)`: cb arg 3 `=== sample` (1), `arguments[2] === sample` (2), `Reflect.set(sample,i,v)` inside cb returns true (4) and lands (8), live read of an in-loop write (16), same two for `filter` (32/64) | **16** | 127 |
| p2 | species returning a STATIC `new Int8Array([1,0,1])` carrier: `subarray` (1) / `slice` (4) — main **throws** "returned a non-TypedArray" (2/8); species from a `{ [Symbol.species]: fn }` literal is invoked once (16), result over the SAME buffer at offset 2 has length 4 (32) and reads `[20,20,20,60]` (64); species returning a DYN view (256) | **394** | 501 |
| p2b/p2d | a function-valued `[Symbol.species]` member of an object LITERAL is visible to a dynamic read (`o[k]`, `Reflect.get`, `getOwnPropertySymbols`) — every literal shape except `[Symbol.toPrimitive]` fails; the ASSIGNMENT form `o[Symbol.species] = fn` works | **385 / 192** | 2047 / 2047 |
| p3 | `x instanceof TA` with `TA` a PARAMETER (`$__ta_ctor` carrier): a freshly constructed dyn view (1), `subarray` result (2), `map` result (4), empty-length `map` result (8), array-like source (256), `%TypedArray%` intrinsic RHS (128) — all false; `.constructor === TA` and `getPrototypeOf(x) === TA.prototype` (16/512/1024) already true; static `st instanceof Float64Array` (4096) true | **5744** | 8191 |
| p4c/p4d | `Reflect.set(ta, 0, v, receiver)` with `v = { valueOf(){…} }`: `receiver[0] === v` false — p4d shows the cause is NOT the walk: `id(v) === v` is false for any literal with a function-valued member (`{}` and `{a:1}` keep identity) | **108 / 142** | 509 / 255 |
| p5c | `%TypedArray%.prototype`: `.length` (32→ should throw 64) and `.byteLength` (128→256) return normally; `.join()` returns normally (2048→4096); `getter()` for the `@@toStringTag` getter THROWS "Cannot access property on null or undefined" (16, should answer undefined 8); `TypedArray()`, `new TypedArray()`, `new TypedArray(1)`, `TypedArray({})` all return normally (8192/32768/131072/524288) | **699061** | 1397581 |
| p6a | `new TA({length: 2**53})` | **wasm trap** `requested new array is too large` | 21 (RangeError) |
| p6b | `new TA({length:2,0:1,1:2,[@@iterator]:null})` wrong (1); `new TA([0,{valueOf},2])` THROWS (32); `new Int8Array(new Int16Array(7)).length` 0 not 7 (64) | **281248** | 1632989 |
| p6e/p6f | `typeof item[1]` for a wide-union nested literal reads `"string"` (8); `Object.getPrototypeOf(<any ArrayBuffer carrier>) === ArrayBuffer.prototype` is false for `new ArrayBuffer(8)`, `view.buffer`, static and dyn (p6f 1/16/32/128/8192), `.constructor === ArrayBuffer` false, while `ab instanceof ArrayBuffer` is true | **8 / 7242** | 2017 / 16383 |
| p7 | a patched `%ArrayIteratorPrototype%.next` drives `new TA([0])` (1/2), `Array.from([0])` (4), spread (8) | **0** | 15 |
| p8 | dyn `sort()`: `-0` before `+0` (1), `[20,100,3]` → `[3,20,100]` numeric not string (2, also with `Number.prototype.toString` patched 4), comparator result goes through ToNumber → `@@toPrimitive` called (8) and order honoured (16); Int8 (32) and NaN-last (64) | **96** | 127 |
| p9 | `sample.filter(function(){ return val; })` over `[false,"",0,-0,NaN,undefined,null]` | **trap** `null pointer in __any_unbox_bool` | 3 |

Row list: `.tmp/6769/rows.txt` (38, relative to `test262/test/`). Runner:
`.tmp/6769/probe.mts` (compile `{ target: "standalone", allowJs: true,
skipSemanticDiagnostics: true, deferTopLevelInit: true }`, instantiate,
`__module_init`, `readResult`); node references via `.tmp/6769/node-ref.cjs`
(it mis-reports p8 because the probe patches `Number.prototype.toString`
inside `new Function` — the p8 reference above was re-derived by hand).

### Rows by step (27 reachable)

| step | rows |
| --- | --- |
| S1 | `TypedArray/prototype/filter/result-empty-callbackfn-returns-false.js` |
| S2 | `TypedArray/prototype/subarray/byteoffset-with-detached-buffer.js` (+ prerequisite for S4's `slice/speciesctor-return-same-buffer-with-offset.js` and S6's `sort/sort-tonumber.js`) |
| S3 | `TypedArray/prototype/map/return-new-typedarray-from-empty-length.js`, `TypedArray/prototype/subarray/result-is-new-instance-from-same-ctor.js`, `TypedArrayConstructors/ctors/object-arg/iterator-is-null-as-array-like.js` |
| S4 | `TypedArray/prototype/map/callbackfn-arguments-{with,without}-thisarg.js`, `TypedArray/prototype/filter/callbackfn-arguments-{with,without}-thisarg.js`, `TypedArray/prototype/map/callbackfn-set-value-during-interaction.js`, `TypedArray/prototype/filter/callbackfn-set-value-during-iteration.js`, `TypedArray/prototype/slice/speciesctor-return-same-buffer-with-offset.js` |
| S5 | `TypedArray/prototype/{subarray,slice}/speciesctor-get-species-custom-ctor-returns-another-instance.js` |
| S6 | `TypedArray/prototype/sort/{sorted-values,sortcompare-with-no-tostring,sort-tonumber}.js` |
| S7 | `TypedArray/prototype/{length,byteLength}/invoked-as-accessor.js`, `TypedArray/prototype/join/invoked-as-method.js`, `TypedArray/prototype/Symbol.toStringTag/invoked-as-func.js`, `TypedArray/invoked.js` |
| S8 | `TypedArrayConstructors/ctors/object-arg/length-excessive-throws.js`, `TypedArrayConstructors/ctors/typedarray-arg/other-ctor-returns-new-typedarray.js` |
| S9 | `TypedArray/prototype/toLocaleString/detached-buffer.js` |
| S10 | `TypedArrayConstructors/ctors/typedarray-arg/same-ctor-buffer-ctor-species-{undefined,null}.js` |

### Not reachable in this slice (11) — each with its mechanism

| rows | why not here |
| --- | --- |
| `internals/Set/key-is-valid-index-reflect-set.js`, `internals/Set/key-is-in-bounds-receiver-is-not-typed-array.js` | first failing assertion is `receiver[0] === value` where `value = { valueOf(){…} }`; p4d: such a literal loses identity across ANY externref round trip (`id(v) === v` false, `holder.p === v` false, `Map.get` false). Value-rep: the function-membered literal is a struct re-boxed per conversion — #2773 / #3037. The walk itself is right (p4c bit 8: a `{}` value keeps identity). Side finding, no row here: the walk answers `true` for a NON-EXTENSIBLE receiver (p4b bits 256/1024) — CreateDataProperty must consult `Object.isExtensible` first. |
| `internals/Set/key-is-valid-index-prototype-chain-set.js`, `internals/Set/key-is-canonical-invalid-index-prototype-chain-set.js` | `Object.create(<TA>)`, `Object.setPrototypeOf([], ta)`, `new String("")` with a TA prototype, and a Proxy receiver whose `defineProperty` trap must fire — a TA in `[[Prototype]]` position plus the array/String exotic receivers (#6766 F cluster, recorded there as "same"). |
| `internals/Set/key-is-out-of-bounds-receiver-is-proto.js` | `Object.create(int32array)`: `$Object.$proto` cannot hold a TA carrier (p4 bit 128: `valueOf` runs 0×, must run 1×). The #6766 `protoLink` field is `anyref`, so a TA link is representable, but every walker (`__extern_get`/`__extern_has`/`__extern_set_decide`/`__reflect_set_receiver`/`__getPrototypeOf`/`__isPrototypeOf`) needs a TA arm — that is its own issue, not a step here. |
| `ctors/length-arg/toindex-length.js` | `var expected = item[1]` over a `(number\|string\|boolean\|null\|undefined)[][]` literal reads the STRING lane (p6e bit 8; the row prints `[object Object]`). Value-rep union-element read — #5185's family. The `ToIndex(-0)` lead is refuted: `new TA(-0).length === 0` already (p6b bit 512). |
| `ctors/object-arg/iterated-array-with-modified-array-iterator.js` | a patched `%ArrayIteratorPrototype%.next` is not consulted by `new TA(array)`, `Array.from(array)` or spread (p7 = 0): the native iterator ladder (`iterator-native.ts`, `ITER_FAMILY_ARRAY`) steps natively. #6484's lane (iterator prototypes r3, in-progress). |
| `ctors/object-arg/iterated-array-changed-by-tonumber.js`, `from/iterated-array-changed-by-tonumber.js` | two mechanisms: the element list must be drained BEFORE any ToNumber (the copy loop reads the live array — `from` row reads `0` at index 2), AND the element `{ valueOf(){…} }` is the same function-membered literal as above — its `valueOf` is not found by `__to_primitive`, so ToPrimitive falls to `Object.prototype.toString` (the row's "not yet implemented" error; p6b block 2 throws). The drain half is a small change in the `$ObjVec` arm (`dataview-native.ts` ~L6240: snapshot `data`+`length` into a fresh `$ObjVec` before the coerce loop); it is not taken here because the row still fails on the second half. |
| `ctors/no-species.js` | `class GrossBuffer extends ArrayBuffer` + `super(...arguments)` (#3240) and `new Int8Array(<static view over that buffer>).buffer` reads `undefined` (p6d bit 1024). |
| `from/from-typedarray-into-itself-mapper-detaches-result.js` | `Int32Array.from.call(function(){ return target; }, target, mapper)` — a custom `this` returning an EXISTING view, with the mapper detaching mid-loop (result must be `target`, length 0). Traps `illegal cast` in `__module_init`; the `%TypedArray%.from` custom-`this` form is #6651 E5's remaining residual. |

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order is by yield per unit of risk; every step is independently shippable and
measured with the row list + the control before the next one starts. Type
queries go through `ctx.oracle`, never `ctx.checker`. Nothing here touches
`src/ir/select.ts`.

### Step 0 — base copies and the before-state

- `mkdir -p .tmp/6769/base-src && git archive origin/main src | tar -x -C .tmp/6769/base-src`
  (the revert copy; A/B by `cp`, never `git stash`).
- Copy the 13 probes + `probe.mts` + `node-ref.cjs` from the lead's
  `/home/user/js2/.tmp/6769/` into your worktree's `.tmp/6769/`; run them on
  the unmodified tree and confirm the `main` column above.
- Build the QuickJS provider once (`npx tsx scripts/build-quickjs-eval-provider.mjs`),
  then run `rows.txt` on the unmodified tree under the lock →
  `.tmp/6769/rows-base.log` (expect 38 fail).

### S1 — `__any_unbox_bool(null)` is `false` (1 row, 1 line)

- `src/codegen/any-boxing-helpers.ts` ~L380 (`addHelper("__any_unbox_bool", [anyRefNull], …)`):
  prepend `local.get 0; ref.is_null; if → i32.const 0; return`. The param is
  already `ref null $AnyValue`; a null box IS `undefined`/`null`, and
  §7.1.2 ToBoolean of either is false. p9 → 3.

### S2 — a function-valued well-known-symbol member of an object literal is a real symbol-keyed own property (1 row + 2 prerequisites)

- Root cause: `literals.ts:1680-1700` (`_hasRuntimeComputedKey`) and
  `:1876-1880` deliberately keep a `[Symbol.X]` key OUT of the runtime-key
  path so the literal stays on the struct path, whose field is the reserved
  `@@N` spelling. The static read `o[Symbol.species]` resolves that field;
  the dynamic MOP (`__extern_get(o, __box_symbol(N))`, `Reflect.get`,
  `getOwnPropertySymbols`, and the species ladder's `Get(C, @@species)`)
  never sees it. The `$Object` path already boxes the key correctly for BOTH
  data members (`:1338-1362`) and method members (`:1401-1430`).
- Change: at `literals.ts:1876-1880`, a `resolved.startsWith("@@")` key must
  make the literal take the `$Object` (`compileObjectLiteralAsExternref`,
  `:464`) path, not the struct path — i.e. return the same answer as a
  runtime computed key. Keep `@@toPrimitive` behaving exactly as today (p2d
  bit 64 is the one shape that already works — find why, and do not regress
  it). Measure p2d → 2047 and p2b → 2047.
- Byte identity: only literals with a well-known-symbol computed key change
  lowering. Control for this step (beyond the TypedArray one): every passing
  ES2015 standalone row under `built-ins/Symbol/**` and `built-ins/Array/**`
  that mentions `[Symbol.` (extract with `grep -l` over the control list).

### S3 — `x instanceof TA` for a `$__ta_ctor` RHS (3 rows)

- `native-dynamic-instanceof.ts:560-660` (`fillNativeDynamicInstanceOf`
  body): the RHS is classified by `__typeof_function` → `ref.test $Object`
  (own `prototype`) / closure carrier (`ownedPrototypeOrdinaryHasInstance`),
  then `prototypeEdgeArm`, `linkedPeerPrototypeArm`, `functionPrototypeTargetArm`,
  else `0`. A `$__ta_ctor` singleton (`registry/types.ts:559`, struct
  `{kind: i32, brand: i32}`, one global per kind —
  `getOrRegisterTaCtorSingleton`, `dataview-native.ts:4955`) matches none of
  them → conservative false. `getPrototypeOf(view) === TA.prototype` already
  holds (p3 bit 512), so the answer is OrdinaryHasInstance.
- Add an arm BEFORE the `__typeof_function` test (the ctor is callable, but
  the cheap identity test should come first): `RHS any.convert_extern
  ref.test $__ta_ctor` → walk `__getPrototypeOf(LHS)` and `ref.eq` each hop
  against `__extern_get(RHS, "prototype")` — reuse `ordinaryHasInstanceTail()`
  with `L_PROTO` = that read (the `<TA>.prototype` value is the per-view
  `$NativeProto` glue, which `Object.getPrototypeOf(view)` returns, so one
  hop hits). Gate on `ctx.taCtorTypeIdx >= 0`. Also handle RHS `ref.eq` the
  `%TypedArray%` intrinsic global (`TA_INTRINSIC_CTOR_GLOBAL`,
  `ta-static-from-of-spec.ts:55`) the same way (its `prototype` own property
  is the intrinsic glue; the view glue's `parentBrand` links to it —
  `array-object-proto.ts:3373-3378`).
- p3 → 8191 (bit 256 needs the array-like source to construct correctly:
  p6b bit 1 is off — `{length:2, 0:1, 1:2, [@@iterator]: null}` — check
  whether `iterator-is-null-as-array-like.js` passes after this step; if its
  length/elements are wrong, the `usingIterator` null test at
  `dataview-native.ts:6185-6196` is where to look, and it is a one-row
  follow-up, not a reason to hold S3).

### S4 — dyn-view `map` / `filter` / `slice` on the LIVE receiver, in spec order (7 rows)

- Root cause (`array-methods.ts:1588` `emitDynViewSpeciesMethodTwoArm`): for
  `map`/`filter`/`slice` the two-arm materialises the view into an f64 vec
  (`emitTaDynViewToVec`), REBINDS the receiver identifier to that copy in
  `fctx.localMap` and re-compiles the call as an array method. Consequences:
  the callback's third argument and `arguments[2]` are the copy (p1 bits
  1/2/32/64), the closure captures the copy so `Reflect.set(sample, …)`
  inside it targets a `$__vec_f64` and answers false (bits 4/8), and `slice`
  copies from a snapshot taken BEFORE TypedArraySpeciesCreate, so a species
  result over the same buffer reads `[20,30,40,60]` instead of the forward
  overlapping copy `[20,20,20,60]` (p2 bits 32/64).
- New helpers in `src/codegen/ta-hof-map-filter.ts` (the file already owns
  the packed-vec `map`/`filter` and the `__apply_closure` bridge):
  `ensureTaDynMapFilterHelper(ctx, "map" | "filter")` and, in
  `ta-dyn-proto-methods.ts` next to `ensureTaDynSubarrayHelper`,
  `ensureTaDynSliceHelper(ctx)`. Signatures follow the five-slot ladder ABI
  (`__ta_dyn_<m>(recv, a0, a1, a2, argc) -> externref`, header of
  `ta-dyn-proto-methods.ts`) so `ta-dyn-method-call.ts`'s ladder
  (`taDynMethodHelperName` → `ctx.funcMap.get`, `:22`) picks them up for
  non-identifier receivers too; register them in
  `ensureTaDynProtoMethodHelper` (`:60`) and `hasTaDynProtoMethodHelper`.
  Bodies (build with `makeTaDynHelperFctx`, validate with
  `emitTaDynViewValidate`, length via `pushTaDynViewInBoundsLen`, elements
  via the `ensureTaDynMopElemHelpers` getter/setter — the setter does ToNumber):
  - `map` (§23.2.3.22): `len` once; `A = TypedArraySpeciesCreate(O, «len»)`
    via `emitTaDynSpeciesCreate(ctx, fctx, { dvLocal, argLocals: [box(len)],
    requestedLengthLocal })` BEFORE the loop; per k: `v = Get(O, k)` (live),
    `r = __apply_closure(cb, thisArg, [v, box(k), O])`, `Set(A, k, r)`.
    `arguments[2]` is `O` because the args `$ObjVec` carries `recv` itself
    (same as `buildArgs` in the packed helper, `:121-135`).
  - `filter` (§23.2.3.10): callbacks first into a kept `$ObjVec`
    (`__objvec_push`), THEN species-create with `«kept.length»`, then write.
    `callbackfn-called-before-species.js` already passes and pins this order.
  - `slice` (§23.2.3.27): `count` from start/end (existing
    `pushTaDynRelativeIndex`), species-create with `«count»`, then a FORWARD
    element loop `Set(A, n, Get(O, k))` reading the LIVE source each step —
    for same-kind views that is byte-for-byte what the spec's forward byte
    copy produces on an overlapping buffer (p2 bit 64). Keep the
    `emitSymbolIndexArgThrow` guard at the call site.
- Wire: in `emitDynViewSpeciesMethodTwoArm`, the `map`/`filter`/`slice`
  branches call the helper with `recvExt`, the callback compiled as a closure
  (`compileArrowAsClosure` for arrow/function literals, else
  `compileExpression(…, {kind:"externref"})` — the `pushExt` shape in
  `emitDynViewMethodTwoArm` `:1950-1965`), and `thisArg`; delete the
  `localMap` rebind for those three. `subarray` stays as is. The ELSE arm
  (non-dyn receiver) is untouched — byte identity for static carriers.
- The detached guard: `map`/`filter`/`slice` are in
  `TA_DYN_VALIDATE_METHOD_NAMES`; `emitTaDynViewValidate` at the top of each
  body keeps `*/detached-buffer.js` green (control).
- p1 → 127, p2 bits 32/64 on. Control: every passing `map/**`, `filter/**`,
  `slice/**` row (≈170 in `.tmp/6769/control.txt`).

### S5 — a species result may be a STATIC typed carrier (2 rows)

- `dataview-native.ts:7159-7185` (inside `emitTaDynSpeciesCreate`): the
  TypedArrayCreate check is `ref.test $__ta_dyn_view` only; a species
  constructor returning `new Int8Array([1,0,1])` (a static `$__vec_i8` /
  `$__ta_view`) throws "returned a non-TypedArray" (p2 bits 2/8).
- Widen the test to "any TypedArray carrier": `$__ta_dyn_view` OR a static
  `__vec_<k>` whose element kind is a TypedArray kind (`ctx.vecTypeMap`
  entries `i8_byte`/`i16_byte`/`i32_elem`/`f32`/`f64` — the same set
  `fillOrdinarySetTypedArrayArm` enumerates, `object-runtime-ordinary-set.ts:557`)
  OR `$__ta_view`. When the result is static, `resultDvLocal` cannot be set:
  return the externref as-is and skip the `requestedLengthLocal` short check
  for `subarray` (no length requirement) — for `slice`/`map`/`filter` compare
  `__extern_length(result)` against the requested count, and write through
  `__extern_set_idx`-style dynamic element stores (the S4 loops should
  already store through the dynamic setter when the result is not a dyn
  view: make the S4 `Set(A, k, v)` a two-arm — dyn setter / `__extern_set`).
- `speciesctor-get-species-custom-ctor-returns-another-instance.js` for
  `map`/`filter` already pass (control) because their species returns
  `other` with `count` 0 through a different check — keep them green.

### S6 — dyn-view `sort`: TypedArray SortCompare, comparator ToNumber, detach-safe write-back (3 rows)

- Today (`emitDynViewMethodTwoArm`, `array-methods.ts:1890+`): materialise →
  `compileArrayMethodCall("sort")` → `compileArraySort` (`:8950`) → default
  `compileArrayDefaultToStringSort` (#1993, STRING order — p8 bit 2), or the
  comparator path whose result goes through `coercionInstrs(cmpReturn → f64)`
  (`array-methods.ts:9313-9400`; an object result becomes NaN without
  ToPrimitive — p8 bit 8) → write-through (`:2722`, `emitTaViewWriteBack`).
- New `ensureTaDynSortHelper(ctx)` in `ta-dyn-proto-methods.ts` (ladder ABI;
  register in `ensureTaDynProtoMethodHelper`): validate; snapshot to
  `$__vec_f64` (`emitTaDynViewToVec`); sort with `emitStableMergeSort`
  (`merge-sort.ts`, the #3902 skeleton) and a compare that is
  §23.2.4.7 TypedArraySortCompare when `argc == 0`/`undefined`: `x < y → -1`,
  `x > y → 1`, `x == y`: `-0` before `+0` (`i64.reinterpret_f64` sign bit),
  NaN last (`x != x → 1`, `y != y → -1`); when a comparator is present:
  `r = __apply_closure(cmp, undefined, [box(x), box(y)])`, then ToNumber via
  the same `__to_primitive`(hint number) + `__unbox_number` pair
  `coerceType(externref → f64)` uses (dataview-native.ts `:6033` names it),
  `NaN → 0`. Then write back element-by-element through the dyn setter ONLY
  if the buffer is not detached (`buf.length >= 0` — the detach marker is
  the vec length forced to `-1`, `taDynDetachedGuardInstrs` `:200-215`);
  a comparator that detaches mid-sort must not throw (`sort-tonumber.js`).
- Wire: in `emitDynViewMethodTwoArm`, `methodName === "sort"` calls the
  helper instead of the rebind path (the call-site `isKnownNonCallable`
  TypeError at `compileArraySort` `:8963` still runs first — keep
  `comparefn-nonfunction-call-throws.js` green).
- p8 → 127. Control: `sort/**` (≈20 rows incl. `stability.js`,
  `sorted-values-nan.js`, `comparefn-calls.js`).

### S7 — `%TypedArray%` / `%TypedArray%.prototype` receivers (5 rows)

Two static tracers already exist: `isTypedArrayIntrinsicCtorExpr` and
`tracesToTypedArrayIntrinsicProto` (`expressions/calls.ts:1849/1885`), which
follow the harness's `var TypedArray = Object.getPrototypeOf(Int8Array)` /
`var TypedArrayPrototype = TypedArray.prototype` aliases.

- (a) `.length` / `.byteLength` on the prototype (2 rows): in
  `property-access-dispatch.ts` before the generic `.length` read (`:3104`)
  and next to the `.byteLength` arm (`:287`): if `noJsHost(ctx) &&
  tracesToTypedArrayIntrinsicProto(ctx, expr.expression)` and the member is
  one of `TYPED_ARRAY_PROTO_GETTERS` (`array-object-proto.ts:555`), emit
  `emitThrowTypeError("get %TypedArray%.prototype.<m> called on an incompatible receiver")`
  and return `{kind:"externref"}` after `unreachable`. `byteOffset`/`buffer`
  already throw (p5c bits 4/8) — leave them.
- (b) `TypedArrayPrototype.join()` (1 row): `call-receiver-method.ts:2797`
  declines the array ladder for a traced receiver and expects the
  closed-method dispatcher's `$NativeProto` arm to raise the brand TypeError;
  eight sibling `*/invoked-as-method.js` rows pass that way, `join` does not
  (p5c bit 2048: returns normally). Find the `join` claim that runs BEFORE
  that decline (`array-methods.ts:2126` routes `join`/`toString`/
  `toLocaleString` for a dynamic receiver; `:5628` is the dyn-join guard
  site) and apply the same `receiverIsTypedArrayIntrinsicProto` decline
  there.
- (c) `@@toStringTag` getter called bare (1 row): `getter()` with `this ===
  undefined` throws "Cannot access property on null or undefined" BEFORE the
  wired body (`emitTypedArrayProtoToStringTagBody`,
  `array-object-proto.ts:1826`, which answers `undefined` for a non-view)
  runs. Trace the bare call of a `__proto_method_<brand>_get_@@4` closure
  value (`native-proto.ts:894-1060` mints it; the call path is the generic
  closure call with an undefined receiver) and let an undefined `this` reach
  the body. Do NOT special-case the member name at the call site — the
  descriptor's `.get` is the same closure `desc.get()` already calls
  successfully (p5 bit 128).
- (d) `TypedArray()` / `new TypedArray(…)` (1 row): the intrinsic is a plain
  `$Object` singleton (`emitTypedArrayIntrinsicCtorObject`,
  `array-object-proto.ts:3462`, global `TA_INTRINSIC_CTOR_GLOBAL`). `new`
  reaches `new-super.ts:5155` (`emitBuiltinFnNotAConstructorGuard` →
  `emitTaDynCtorConstructFromLocals` → `emitBuiltinCtorValueConstructOnNull`)
  and returns normally; the call form reaches the `__dyn_call_N` ladder
  (`calls.ts:4542`; the `$__ta_ctor` [[Call]] arm is at `:5517`) and returns
  normally (#3406 is the general "non-callable answers null" defect). Add one
  identity arm at both sites, gated on the global being registered
  (`ctx.builtinObjectGlobals.get("__builtin_%TypedArray%_ctor")`):
  `desc ref.eq global → throw TypeError("Abstract class TypedArray not directly constructable")`
  (the message `dataview-native.ts:7455` already uses).
- p5c → 1397581.

### S8 — constructor argument protocols (2 rows)

- RangeError cap (`length-excessive-throws.js`): in
  `emitTaDynCtorConstructInline` the array-like arm (`dataview-native.ts:6055-6075`)
  truncates `len` with `i32.trunc_sat_f64_s` and calls `emitAllocViewFromN`
  → `array.new_default` traps at 2^31−1. Before `emitAllocViewFromN()` in
  the array-like arm, the iterator-drain arm (`:6151-6160`) and the count
  arm (after `emitToIndexI32FromArgLocal`, `:6026`): if `n * elemSize >
  0x7FFF_FFF0` (compare in f64 — `n` as f64 before truncation) throw
  `RangeError("Invalid typed array length")` via `emitThrowRangeErrorIf`
  (`:4652`). §23.2.5.1 → AllocateArrayBuffer → CreateByteDataBlock RangeError.
- Static typed-vec source (`other-ctor-returns-new-typedarray.js`): the dyn
  ctor's source arms are `$Object` (array-like/iterable), `$ObjVec`, and
  `$__ta_dyn_view` (`:6349`); a STATIC `new Int16Array(7)` (`$__vec_i16`)
  matches none and falls to the count form → `ToIndex(carrier)` = 0 (p6b
  bit 64). Widen the `$Object` gate at `:6201-6207` to also take
  `ref.test $__vec_base` (`ctx.vecBaseTypeIdx`; every static typed vec
  subtypes it) into the array-like arm — `__extern_length`/`__extern_get_idx`
  already read those carriers (R4). A buffer-backed static `$__ta_view`
  still reads NaN through `__extern_get_idx` (#6453, not this slice); the
  row uses plain `new Int8Array(7)`/`new Int16Array(7)`.

### S9 — `toLocaleString()` on a detached dyn view throws (1 row)

- `call-receiver-method.ts:3782` special-cases a 0-arg `toLocaleString` and
  routes standalone to `__extern_toString` BEFORE any dyn-view guard runs.
  Splice `taDynDetachedGuardPrologue(ctx, fctx, "toLocaleString", <recv local>)`
  (`ta-dyn-method-call.ts`, the #6501 externref-local form) after the
  receiver is evaluated into a local and before the call, gated on
  `noJsHost(ctx) && ctx.taDynViewTypeIdx >= 0`. The method is already in
  `TA_DYN_VALIDATE_METHOD_NAMES`.

### S10 — an ArrayBuffer carrier's `[[Prototype]]` is `ArrayBuffer.prototype` (2 rows)

- `Object.getPrototypeOf(<any ArrayBuffer carrier>)` never answers
  `ArrayBuffer.prototype` and `.constructor` never `ArrayBuffer` (p6f), while
  `instanceof ArrayBuffer` does for static receivers. The two rows assert
  exactly `Object.getPrototypeOf(new TA(sample).buffer) === ArrayBuffer.prototype`
  after poking `sample.buffer.constructor = ctor` (the expando write already
  works — p6b bit 16384).
- `expressions/object-get-prototype-of.ts:402/425` are the view arms (kind →
  `<View>.prototype` glue via `isTypedArrayViewProtoName`). Add the byte-vec
  arm beside them: receiver `ref.test` the `i32ByteVec(ctx).vecTypeIdx`
  carrier → the `ArrayBuffer.prototype` glue from
  `ensureArrayBufferNativeProtoGlue` (`array-object-proto.ts:3154`) through
  the same lazy proto get the view arms use (`emitLazyNativeProtoGet`). Do
  the same for the dynamic `__getPrototypeOf` native if the rows reach it
  (they read through `Object.getPrototypeOf(<expr>)` with a dynamic
  argument — check which of the two paths compiles it; measure p6f bits
  1/16/32/128/8192 → on). `.constructor === ArrayBuffer` (p6f bits 4/512) is
  a bonus, not required by these rows.

### Step 11 — measure, controls, gates, record

- Re-run `rows.txt` (expect ≥ 27 pass; name each residual's first failing
  assertion) and the probes (`p1` 127, `p2` 501, `p2d` 2047, `p3` 8191,
  `p5c` 1397581, `p6a` 21, `p8` 127, `p9` 3, `p6f` bits 1/16/32/128/8192).
- Pin suite `tests/issue-6769-typedarray-residue.test.ts`: one case per probe
  above asserting the node answer (RED on `.tmp/6769/base-src` — swap `src/`
  in, run, swap back, write the base verdict into the record), plus three
  guards that answer the same on both trees: a static
  `new Int8Array([3,1,2]).sort()`, a static `map` with a species override
  through the assignment form, and `[1,2,3].filter(x => x > 1).length`.
- Controls (0 pass → non-pass, per-path set diff, `--isolate`, under the
  lock): `.tmp/6769/control.txt` — the 2,259 currently-passing standalone
  rows under `built-ins/TypedArray/**` (1,044), `TypedArrayConstructors/**`
  (589), `ArrayBuffer/**` (162), `DataView/**` (464), extracted from
  `.test262-cache/test262-standalone-current.jsonl` (2026-09-29 22:47 UTC,
  `status:"pass"`; all editions, ES2015 is a subset). ≈90 min; run it once at
  the end on the merged tree, plus the S2-specific `[Symbol.` slice of
  `built-ins/Symbol/**` + `built-ins/Array/**` after S2.
- Gates, bare and chained: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)` for loc/func, plus
  `node scripts/check-compiler-boundaries.mjs --mode inventory` (both leaves
  are already in `scripts/compiler-boundaries.json`) and `npm run -s
  typecheck`. Delete `.tmp/core-node-execution-*` after `check:dead-exports`.
- Record: append `### 2026-09-30 — #6769 implementation (Opus)` to THIS file
  with the before/after row table, the probe table's `branch` column, the
  pins' base verdict, the control diff, and residuals with mechanisms; then a
  one-paragraph pointer in `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`
  under a new `### 2026-09-30 — #6769 …` heading.

## Acceptance criteria

- ≥ 27 of the 38 rows pass on standalone (`--isolate`), measured on the
  branch with `origin/main` merged in; every remaining row has its first
  failing assertion and mechanism named in the record.
- Probe answers on the branch: p1 = 127, p2 = 501, p2d = 2047, p3 = 8191,
  p5c = 1397581, p6a = 21, p8 = 127, p9 = 3; the pin file is red on the base
  sources.
- 0 pass → non-pass across the 2,259-row TypedArray/ArrayBuffer/DataView
  control and the S2 `[Symbol.` slice.
- All gates green; `src/ir/select.ts` untouched; growth grants in this file's
  frontmatter only.

## Lane protocol

- Worktree: `git worktree add /home/user/js2/.claude/worktrees/issue-6769 -b issue-6769-typedarray-residue origin/main`,
  then `ln -s /home/user/js2/node_modules <wt>/node_modules` and
  `rm -rf <wt>/test262 && ln -s /home/user/js2/test262 <wt>/test262` (the
  hook does not provision them here). Never edit `/home/user/js2` itself —
  it is the BASE tree the lead measures against.
- One test262 runner at a time on this 4-core box: every
  `run-test262-paths.mts` invocation goes through
  `flock /tmp/claude-0/t262.lock …` (paths relative to `test262/test/`, i.e.
  `built-ins/…`). Rebuild the QuickJS adapter after a `src/` change if a row
  reports "provider is not built": `npx tsx scripts/build-quickjs-eval-provider.mjs`.
  No full vitest suites.
- Commit early and push the branch immediately (`git push -u origin <branch>
  > .tmp/6769/push.log 2>&1` in the background — the pre-push hook takes
  minutes — then confirm with `git ls-remote origin <branch>`). Do NOT open a
  PR and do NOT enqueue: the lead verifies the pushed head and opens it.
- Commit format: subject ends with ` ✓`; author `Thomas Tränkler
  <git@thomas.traenkler.com>`, committer `Claude <noreply@anthropic.com>`
  (`GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git
  -c user.name="Thomas Tränkler" -c user.email=git@thomas.traenkler.com
  commit -m "<msg>"`); trailers `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>`, `Claude-Session:
  https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`, `Model: Claude
  Opus 5.5 High`. Never `--no-verify`.
- No `git stash`; A/B by file copy from `.tmp/6769/base-src`.

### 2026-09-30 — #6769 implementation (Opus)

Branch `issue-6769-typedarray-residue` (plan branch + `origin/main` merged
twice, last at `ee6828f1ef`). One commit per step — S1 `26309df647`, S2
`65c6a74cf8`, S3 `097e4769a2`, S4 `7d3a8cee25`, S5 `39c491cf19`, S6
`05529ce6d6`, S7 `2b3b5d2dcb`, S8 `2e51e20c8a`, S9 `92629d34f6`, S10
`930d651b06`, then S7c `fc5cae6bcf` — each measured before it was committed.
The final 38-row + control run is on the merge `db07a0ec5c` (a `git archive`
snapshot, so the worktree could keep moving while it ran); S7c was taken while
that run was in flight and is measured by its own targeted control below. The
branch has NOT been re-merged since:
`origin/main` `ad10f2e860` is 8 commits ahead (incl. #5350 r2's
`new-super.ts` / `call-receiver-method.ts` edits) and `git merge-tree` reports
a clean merge.

#### Rows (38, standalone, `--isolate`, QuickJS provider built)

| | pass | fail |
| --- | ---: | ---: |
| base (`d4e15d90` plan measurement; re-run here on the fork point `a2546f6fc5`: `.tmp/6769/rows-base.log`) | 0 | 38 |
| branch — merged tree `db07a0ec5c` (`.tmp/6769/final-chunk-00.log`) | 26 | 12 |
| branch + S7c `fc5cae6bcf` (the one changed row measured in `.tmp/6769/s7c-ctl-branch.log`) | **27** | **11** |

Gained (27), by step:

| step | rows |
| --- | --- |
| S1 | `filter/result-empty-callbackfn-returns-false` |
| S2 | `subarray/byteoffset-with-detached-buffer` |
| S3 | `map/return-new-typedarray-from-empty-length`, `subarray/result-is-new-instance-from-same-ctor`, `ctors/object-arg/iterator-is-null-as-array-like` |
| S4 | `map/callbackfn-arguments-{with,without}-thisarg`, `filter/callbackfn-arguments-{with,without}-thisarg`, `map/callbackfn-set-value-during-interaction`, `filter/callbackfn-set-value-during-iteration`, `slice/speciesctor-return-same-buffer-with-offset` |
| S5 | `{subarray,slice}/speciesctor-get-species-custom-ctor-returns-another-instance` |
| S6 | `sort/{sorted-values,sortcompare-with-no-tostring,sort-tonumber}` |
| S7 | `{length,byteLength}/invoked-as-accessor`, `join/invoked-as-method`, `TypedArray/invoked`; S7c `Symbol.toStringTag/invoked-as-func` |
| S8 | `ctors/object-arg/length-excessive-throws`, `ctors/typedarray-arg/other-ctor-returns-new-typedarray` |
| S9 | `toLocaleString/detached-buffer` |
| S10 | `ctors/typedarray-arg/same-ctor-buffer-ctor-species-{undefined,null}` |

Residuals (11 — all eleven the plan put out of reach) — first failing
assertion, mechanism:

| row | first failing assertion | mechanism |
| --- | --- | --- |
| `internals/Set/key-is-valid-index-reflect-set` | `receiver[0] should be created (receiver: empty object)` — SameValue(`[object Object]`, `[object Object]`) false | a `{ valueOf(){…} }` literal loses identity across an externref round trip (p4d still 142) — #2773/#3037. |
| `internals/Set/key-is-in-bounds-receiver-is-not-typed-array` | L36 `assert.sameValue(receiver[0], value, …)` — same false SameValue | same identity loss. |
| `internals/Set/key-is-valid-index-prototype-chain-set` | `receiver[0] should be updated (receiver: empty object)` | TA in `[[Prototype]]` position + array/String exotic receivers — #6766 F. |
| `internals/Set/key-is-canonical-invalid-index-prototype-chain-set` | L45 `receiver[1] should not be created` | same (#6766 F). |
| `internals/Set/key-is-out-of-bounds-receiver-is-proto` | L40 `valueOf is called exactly once` — reads 0 | `Object.create(<TA>)`: the prototype walkers have no TA arm (plan). |
| `ctors/length-arg/toindex-length` | L45 `-0 length` — reads `[object Object]` | union-element read of a nested literal (#5185); p6e bit 1 still off. |
| `ctors/object-arg/iterated-array-with-modified-array-iterator` | L44 `ta.length` — 1, expected 4 | a patched `%ArrayIteratorPrototype%.next` is not consulted (#6484); p7 still 0. |
| `ctors/object-arg/iterated-array-changed-by-tonumber` | L39 → `TypeError: Object.prototype.toString is not yet implemented in --target standalone` | the element's `valueOf` is not found by `__to_primitive` (function-membered literal), so ToPrimitive falls to `Object.prototype.toString`; the drain-before-coerce half is also missing (plan). |
| `from/iterated-array-changed-by-tonumber` | `SameValue(0, 2)` near L34 | drain-before-coerce: the copy loop reads the live array (plan). |
| `ctors/no-species` | `SameValue(undefined, [object ArrayBuffer])` — `new Int8Array(<view over a GrossBuffer>).buffer` | `class extends ArrayBuffer` + `super(...arguments)` (#3240). |
| `from/from-typedarray-into-itself-mapper-detaches-result` | `RuntimeError: illegal cast in __module_init_chunk_0()` (source L24) | custom-`this` `%TypedArray%.from.call` returning an existing view (#6651 E5). |

#### Probes (`.tmp/6769/probes-base.log` → `.tmp/6769/probes-branch.log`)

| probe | base | branch | node | note |
| --- | ---: | ---: | ---: | --- |
| p1 | 16 | 127 | 127 | S4 |
| p2 | 394 | 501 | 501 | S4/S5 |
| p2b | 385 | 2047 | 2047 | S2 |
| p2d | 192 | 2015 | 2047 | S2; bit 32 (a dynamic read of an `[Symbol.iterator]` literal member) stays off — `@@iterator` keeps its closed-struct layout (it has static consumers); needs a symbol-key arm in the closed-struct `__extern_get` dispatch, not taken |
| p3 | 5744 | 8191 | 8191 | S3 (+ S4 for bit 2048, map on a non-identifier receiver) |
| p4c / p4d | 108 / 142 | 108 / 142 | 509 / 255 | out of scope (literal identity) |
| p5c | 699061 | 1397589 | 1397581 | S7; bits 8/16 stay off: the probe reads the getter off a descriptor binding that is ASSIGNED after a bare `var desc;`, which the S7c predicate does not follow (it takes an initialiser — the test262 rows' spelling) |
| s7c | 1198666 | 674121 | 674121 | S7c (added with the step; the pre-S7c branch also answers 1198666): direct and one-binding-removed accessor calls, built-in and user getters, a missing getter still a TypeError |
| p6a | trap | 21 | 21 | S8 |
| p6b | 281248 | 1370849 | 1632989 | S8 bits 1/64/128 on; the rest are the out-of-scope residuals |
| p6e | 8 | 1448 | 2017 | S10 bits 32/128/256/1024 on; bit 1 = toindex residual, 64/512 below |
| p6f | 7242 | 15611 | 16383 | S10 bits 1/16/32/128/8192 on; `.constructor === ArrayBuffer` (4/512) and a dyn buffer's `instanceof ArrayBuffer` (256) stay off |
| p7 | 0 | 0 | 15 | out of scope (#6484) |
| p8 | 96 | 127 | 127 | S6 |
| p9 | trap | 3 | 3 | S1 |

#### Pins — `tests/issue-6769-typedarray-residue.test.ts`

Ten probe pins (p1, p2, p2d, p3, p5c, p6a, p6f, p8, p9, s7c; node answers;
p2d and p5c masked to exclude exactly the residual bits named above, p6f
masked to the five S10 bits) and three guards. **Base sources**
(`.tmp/6769/btree`, `git archive` of the fork point): 10 failed / 3 passed.
**Branch**: 13 passed.
The plan's guard `new Int8Array([3,1,2]).sort()` is replaced by a static
`Float64Array` comparator sort: the default-comparator sort of a STATIC
`Int8Array` throws on BOTH trees (side finding below), so it cannot guard.

#### Control

**0 pass → non-pass.** Every row of the control passing on the
2026-09-29 22:47 standalone baseline still passes on the merged tree
`db07a0ec5c`:

| set | rows | how measured | pass |
| --- | ---: | --- | ---: |
| `.tmp/6769/control.txt` — TypedArray 1,044 + TypedArrayConstructors 589 + ArrayBuffer 162 + DataView 464 | 2,259 | see below | 2,259 |
| the per-step control rows outside it — S2's `[Symbol.` slice of `built-ins/Symbol/**` + `built-ins/Array/**`, the S3/S4/S5 slices, 157 Atomics/SharedArrayBuffer rows | 348 | see below | 348 |

How: the first 962 of the 2,607 rows ran with `--isolate` under the lock
(`final-chunk-00.log` rows 39–400, `final-sub-00…05.log`), 962/962 pass. The
background run was then stopped by the task-runner's 2-hour limit, so the
remaining 1,645 rows were screened IN-PROCESS, under the lock, in bounded
slices that record one verdict per row (`.tmp/6769/rest-inproc.tsv`):
1,645/1,645 pass. The in-process lane shares one realm, so a poisoning row
can only turn later rows into false NON-passes — none appeared, so no
`--isolate` confirmation was needed; the residual risk of that lane is a
false PASS, which is not ruled out.

S7c (`fc5cae6bcf`) was taken after this run started. Its only effect is at a
direct call of a binding initialised from
`Object|Reflect.getOwnPropertyDescriptor(…).get|set` (directly or through one
descriptor binding) — a static test that decides whether the arm is emitted
at all. The 23 test262 files with such a call were run with `--isolate` on
both trees (`s7c-ctl-base.log` / `s7c-ctl-branch.log`, one row re-run after a
provider rebuild): 15 → 17 pass (+ `Symbol.toStringTag/invoked-as-func` and
its BigInt twin), 0 lost. Every other file compiles through an unchanged path.

#### Side findings (not fixed here)

- A statically-carried `new Int8Array([3, 1, 2]).sort()` (default
  comparator) throws a Wasm exception on the base AND the branch — at module
  scope and inside a function. The dyn-view sort (S6) does not touch the
  static carrier path.
- `new %TypedArray%(buffer, badOffset)` now throws TypeError only after the
  buffer-form ToIndex coercions of offset/length have run (the construct is
  emitted before the intrinsic check on that one path); the spec throws before
  them. No row observes it.
- A static TypedArray carrier registered only AFTER a species-create site was
  emitted is not recognised as a species result there (S5 enumerates carriers
  at emit time).

#### Gates

loc, func, coercion-sites, oracle-ratchet, dead-exports, loc/func with
`LOC_GATE_BASE=ad10f2e860` (`origin/main` at record time),
`check-compiler-boundaries --mode inventory --base ad10f2e860` (valid),
typecheck — all green on the final tree (re-run after S7c). Grants added in this file's
frontmatter: loc (`closed-method-dispatch.ts`, `ta-dyn-mop.ts`,
`expressions/calls-closures.ts`); func
(`closed-method-dispatch.ts::fillClosedMethodDispatch` +2, and — restated
from #6651's broad grant so they cannot strand —
`call-receiver-method.ts::compileReceiverMethodCall` +10,
`new-super.ts::compileNewExpression` +3, `ta-dyn-mop.ts::fillTaDynViewMopArms`
+1); coercion-sites (`ta-hof-map-filter.ts`, the `filter` producer's
`__is_truthy`). S7c needed no grant (`call-identifier.ts` changes one
argument; `unmatched-closure-host-call.ts` stays under the file threshold).
No new source file; `src/ir/select.ts` untouched.
