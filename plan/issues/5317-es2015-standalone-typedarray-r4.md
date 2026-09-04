---
id: 5317
title: "ES2015 standalone typedarray — r4: species protocol, coercion order, sort, join traps, integer-indexed internals"
status: ready
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: high
horizon: xl
feasibility: hard
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen, runtime
language_feature: typedarray, arraybuffer
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5194, 5561, 3371, 2175, 4444]
loc-budget-allow:
  # 2026-09-04 r4 plan: species-constructor validation, element-coercion
  # ordering and the integer-indexed [[DefineOwnProperty]]/[[OwnPropertyKeys]]
  # arms are new emitted natives; existing files grow by dispatch wiring.
  - src/codegen/dataview-native.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/index.ts
---

## Problem

The 2026-09-04 census (post-#5576 baseline) has **201 non-pass typedarray
rows** in ES2015 standalone: 183 `fail`, 18 `compile_error`. 14 of the fails
are the other team's (#2175: "`Object.prototype.toString` /
`Function.prototype.call` is not yet implemented in --target standalone") and
11 of the CEs are #3371's view rows (reflect lane, this wave). The remaining
**169 fails** group by mechanism; the families below are the plan's steps, in
the order that maximises rows per mechanism. The r3 handover in #5194 (its
last two sections) is required reading: it names the two `$__ta_ctor` mint
sites, the `descTypeIdx` carrier and `emitTaDynCtorConstructFromLocals`.

### Rows by family (from the census TSV; the `reflection-gated` block is NOT claimed)

```
## reflection-gated (14)
built-ins/TypedArray/Symbol.species/result.js
built-ins/TypedArray/prototype/Symbol.toStringTag/this-has-no-typedarrayname-internal.js
built-ins/TypedArrayConstructors/ctors/typedarray-arg/same-ctor-buffer-ctor-species-null.js
built-ins/ArrayBuffer/prototype/slice/species-constructor-is-undefined.js
built-ins/TypedArrayConstructors/ctors/typedarray-arg/same-ctor-buffer-ctor-species-undefined.js
built-ins/ArrayBuffer/prototype/slice/species-is-undefined.js
built-ins/TypedArrayConstructors/of/custom-ctor-returns-other-instance.js
built-ins/TypedArrayConstructors/ctors/no-species.js
built-ins/TypedArrayConstructors/from/custom-ctor-returns-other-instance.js
built-ins/TypedArray/prototype/Symbol.toStringTag/this-is-not-object.js
built-ins/ArrayBuffer/prototype/slice/species-is-null.js
built-ins/TypedArrayConstructors/ctors/object-arg/as-generator-iterable-returns.js
built-ins/ArrayBuffer/newtarget-prototype-is-not-object.js
built-ins/TypedArrayConstructors/ctors/length-arg/toindex-length.js
## built-ins/TypedArray/prototype/sort (12)
built-ins/TypedArray/prototype/sort/comparefn-nonfunction-call-throws.js
built-ins/TypedArray/prototype/sort/detached-buffer.js
built-ins/TypedArray/prototype/sort/stability.js
built-ins/TypedArray/prototype/sort/sort-tonumber.js
built-ins/TypedArray/prototype/sort/sortcompare-with-no-tostring.js
built-ins/TypedArray/prototype/sort/comparefn-calls.js
built-ins/TypedArray/prototype/sort/return-same-instance.js
built-ins/TypedArray/prototype/sort/sorted-values.js
built-ins/TypedArray/prototype/sort/sorted-values-nan.js
built-ins/TypedArray/prototype/sort/comparefn-is-undefined.js
built-ins/TypedArray/prototype/sort/arraylength-internal.js
built-ins/TypedArray/prototype/sort/comparefn-call-throws.js
## built-ins/TypedArrayConstructors/ctors/object-arg (11)
built-ins/TypedArrayConstructors/ctors/object-arg/throws-setting-obj-valueof.js
built-ins/TypedArrayConstructors/ctors/object-arg/iterator-is-null-as-array-like.js
built-ins/TypedArrayConstructors/ctors/object-arg/iterating-throws.js
built-ins/TypedArrayConstructors/ctors/object-arg/throws-setting-obj-to-primitive-typeerror.js
built-ins/TypedArrayConstructors/ctors/object-arg/throws-setting-obj-valueof-typeerror.js
built-ins/TypedArrayConstructors/ctors/object-arg/length-excessive-throws.js
built-ins/TypedArrayConstructors/ctors/object-arg/iterator-not-callable-throws.js
built-ins/TypedArrayConstructors/ctors/object-arg/throws-setting-obj-tostring.js
built-ins/TypedArrayConstructors/ctors/object-arg/iterated-array-with-modified-array-iterator.js
built-ins/TypedArrayConstructors/ctors/object-arg/iterator-throws.js
built-ins/TypedArrayConstructors/ctors/object-arg/throws-setting-obj-to-primitive.js
## built-ins/ArrayBuffer/prototype/slice (10)
built-ins/ArrayBuffer/prototype/slice/species-returns-smaller-arraybuffer.js
built-ins/ArrayBuffer/prototype/slice/species-returns-same-arraybuffer.js
built-ins/ArrayBuffer/prototype/slice/species.js
built-ins/ArrayBuffer/prototype/slice/species-is-not-object.js
built-ins/ArrayBuffer/prototype/slice/species-returns-not-arraybuffer.js
built-ins/ArrayBuffer/prototype/slice/context-is-not-arraybuffer-object.js
built-ins/ArrayBuffer/prototype/slice/species-is-not-constructor.js
built-ins/ArrayBuffer/prototype/slice/context-is-not-object.js
built-ins/ArrayBuffer/prototype/slice/species-returns-larger-arraybuffer.js
built-ins/ArrayBuffer/prototype/slice/species-constructor-is-not-object.js
## built-ins/TypedArray/prototype/toLocaleString (10)
built-ins/TypedArray/prototype/toLocaleString/calls-tolocalestring-from-each-value.js
built-ins/TypedArray/prototype/toLocaleString/calls-valueof-from-each-value.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-nextelement-tolocalestring.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-firstelement-valueof.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-nextelement-valueof.js
built-ins/TypedArray/prototype/toLocaleString/calls-tostring-from-each-value.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-firstelement-tostring.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-firstelement-tolocalestring.js
built-ins/TypedArray/prototype/toLocaleString/detached-buffer.js
built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-nextelement-tostring.js
## built-ins/TypedArray/prototype/subarray (8)
built-ins/TypedArray/prototype/subarray/detached-buffer.js
built-ins/TypedArray/prototype/subarray/result-is-new-instance-from-same-ctor.js
built-ins/TypedArray/prototype/subarray/byteoffset-with-detached-buffer.js
built-ins/TypedArray/prototype/subarray/return-abrupt-from-end-symbol.js
built-ins/TypedArray/prototype/subarray/speciesctor-get-species-custom-ctor-invocation.js
built-ins/TypedArray/prototype/subarray/speciesctor-get-ctor-inherited.js
built-ins/TypedArray/prototype/subarray/return-abrupt-from-begin-symbol.js
built-ins/TypedArray/prototype/subarray/speciesctor-get-species-custom-ctor-returns-another-instance.js
## built-ins/TypedArray/prototype/slice (7)
built-ins/TypedArray/prototype/slice/return-abrupt-from-end-symbol.js
built-ins/TypedArray/prototype/slice/speciesctor-return-same-buffer-with-offset.js
built-ins/TypedArray/prototype/slice/invoked-as-method.js
built-ins/TypedArray/prototype/slice/return-abrupt-from-start-symbol.js
built-ins/TypedArray/prototype/slice/speciesctor-get-species-custom-ctor-returns-another-instance.js
built-ins/TypedArray/prototype/slice/speciesctor-get-species-custom-ctor-invocation.js
built-ins/TypedArray/prototype/slice/speciesctor-get-ctor-inherited.js
## built-ins/TypedArray/prototype/join (6)
built-ins/TypedArray/prototype/join/return-abrupt-from-separator.js
built-ins/TypedArray/prototype/join/custom-separator-result-from-tostring-on-each-value.js
built-ins/TypedArray/prototype/join/custom-separator-result-from-tostring-on-each-simple-value.js
built-ins/TypedArray/prototype/join/invoked-as-method.js
built-ins/TypedArray/prototype/join/detached-buffer.js
built-ins/TypedArray/prototype/join/return-abrupt-from-separator-symbol.js
## built-ins/TypedArray/prototype/filter (6)
built-ins/TypedArray/prototype/filter/callbackfn-arguments-with-thisarg.js
built-ins/TypedArray/prototype/filter/callbackfn-set-value-during-iteration.js
built-ins/TypedArray/prototype/filter/callbackfn-arguments-without-thisarg.js
built-ins/TypedArray/prototype/filter/result-empty-callbackfn-returns-false.js
built-ins/TypedArray/prototype/filter/speciesctor-get-ctor-inherited.js
built-ins/TypedArray/prototype/filter/speciesctor-get-species-custom-ctor-invocation.js
## built-ins/TypedArray/prototype/map (6)
built-ins/TypedArray/prototype/map/speciesctor-get-species-custom-ctor-invocation.js
built-ins/TypedArray/prototype/map/speciesctor-get-ctor-inherited.js
built-ins/TypedArray/prototype/map/return-new-typedarray-from-empty-length.js
built-ins/TypedArray/prototype/map/callbackfn-arguments-without-thisarg.js
built-ins/TypedArray/prototype/map/callbackfn-set-value-during-interaction.js
built-ins/TypedArray/prototype/map/callbackfn-arguments-with-thisarg.js
## built-ins/TypedArray/prototype/fill (5)
built-ins/TypedArray/prototype/fill/coerced-indexes.js
built-ins/TypedArray/prototype/fill/coerced-value-detach.js
built-ins/TypedArray/prototype/fill/coerced-end-detach.js
built-ins/TypedArray/prototype/fill/coerced-start-detach.js
built-ins/TypedArray/prototype/fill/detached-buffer.js
## built-ins/TypedArray/prototype/copyWithin (5)
built-ins/TypedArray/prototype/copyWithin/detached-buffer.js
built-ins/TypedArray/prototype/copyWithin/coerced-values-end.js
built-ins/TypedArray/prototype/copyWithin/coerced-values-end-detached.js
built-ins/TypedArray/prototype/copyWithin/coerced-values-end-detached-prototype.js
built-ins/TypedArray/prototype/copyWithin/coerced-values-start-detached.js
## built-ins/TypedArrayConstructors/internals/DefineOwnProperty (5)
built-ins/TypedArrayConstructors/internals/DefineOwnProperty/key-is-not-numeric-index.js
built-ins/TypedArrayConstructors/internals/DefineOwnProperty/desc-value-throws.js
built-ins/TypedArrayConstructors/internals/DefineOwnProperty/non-extensible-redefine-key.js
built-ins/TypedArrayConstructors/internals/DefineOwnProperty/key-is-symbol.js
built-ins/TypedArrayConstructors/internals/DefineOwnProperty/key-is-not-canonical-index.js
## built-ins/TypedArrayConstructors/internals/OwnPropertyKeys (4)
built-ins/TypedArrayConstructors/internals/OwnPropertyKeys/integer-indexes-and-string-and-symbol-keys-.js
built-ins/TypedArrayConstructors/internals/OwnPropertyKeys/integer-indexes-and-string-keys.js
built-ins/TypedArrayConstructors/internals/OwnPropertyKeys/integer-indexes.js
built-ins/TypedArrayConstructors/internals/OwnPropertyKeys/not-enumerable-keys.js
## built-ins/TypedArray/prototype/some (3)
built-ins/TypedArray/prototype/some/detached-buffer.js
built-ins/TypedArray/prototype/some/callbackfn-not-callable-throws.js
built-ins/TypedArray/prototype/some/callbackfn-detachbuffer.js
## built-ins/TypedArray/prototype/entries (3)
built-ins/TypedArray/prototype/entries/detached-buffer.js
built-ins/TypedArray/prototype/entries/return-itor.js
built-ins/TypedArray/prototype/entries/iter-prototype.js
## built-ins/TypedArray/prototype/forEach (3)
built-ins/TypedArray/prototype/forEach/callbackfn-detachbuffer.js
built-ins/TypedArray/prototype/forEach/callbackfn-is-not-callable.js
built-ins/TypedArray/prototype/forEach/detached-buffer.js
## built-ins/TypedArray/prototype/values (3)
built-ins/TypedArray/prototype/values/return-itor.js
built-ins/TypedArray/prototype/values/detached-buffer.js
built-ins/TypedArray/prototype/values/iter-prototype.js
## built-ins/TypedArray/prototype/every (3)
built-ins/TypedArray/prototype/every/callbackfn-detachbuffer.js
built-ins/TypedArray/prototype/every/callbackfn-not-callable-throws.js
built-ins/TypedArray/prototype/every/detached-buffer.js
## built-ins/TypedArray/prototype/keys (3)
built-ins/TypedArray/prototype/keys/detached-buffer.js
built-ins/TypedArray/prototype/keys/return-itor.js
built-ins/TypedArray/prototype/keys/iter-prototype.js
## built-ins/TypedArrayConstructors/ctors/buffer-arg (2)
built-ins/TypedArrayConstructors/ctors/buffer-arg/toindex-byteoffset.js
built-ins/TypedArrayConstructors/ctors/buffer-arg/toindex-bytelength.js
## built-ins/TypedArrayConstructors/ctors/typedarray-arg (2)
built-ins/TypedArrayConstructors/ctors/typedarray-arg/returns-new-instance.js
built-ins/TypedArrayConstructors/ctors/typedarray-arg/other-ctor-returns-new-typedarray.js
## built-ins/TypedArray/prototype/reduce (2)
built-ins/TypedArray/prototype/reduce/callbackfn-detachbuffer.js
built-ins/TypedArray/prototype/reduce/callbackfn-is-not-callable-throws.js
## built-ins/TypedArrayConstructors/internals/Set (2)
built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-prototype-chain-set.js
built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js
## built-ins/TypedArray/prototype/reduceRight (2)
built-ins/TypedArray/prototype/reduceRight/callbackfn-detachbuffer.js
built-ins/TypedArray/prototype/reduceRight/callbackfn-is-not-callable-throws.js
## built-ins/TypedArrayConstructors/from/invoked-as-func.js (1)
built-ins/TypedArrayConstructors/from/invoked-as-func.js
## built-ins/TypedArrayConstructors/of/invoked-as-func.js (1)
built-ins/TypedArrayConstructors/of/invoked-as-func.js
## built-ins/TypedArrayConstructors/from/mapfn-arguments.js (1)
built-ins/TypedArrayConstructors/from/mapfn-arguments.js
## built-ins/TypedArrayConstructors/of/inherited.js (1)
built-ins/TypedArrayConstructors/of/inherited.js
## built-ins/DataView/instance-extensibility.js (1)
built-ins/DataView/instance-extensibility.js
## built-ins/TypedArray/from/iter-next-value-error.js (1)
built-ins/TypedArray/from/iter-next-value-error.js
## built-ins/ArrayBuffer/isView/arg-is-typedarray-subclass-instance.js (1)
built-ins/ArrayBuffer/isView/arg-is-typedarray-subclass-instance.js
## built-ins/DataView/return-instance.js (1)
built-ins/DataView/return-instance.js
## built-ins/TypedArray/prototype/findIndex (1)
built-ins/TypedArray/prototype/findIndex/detached-buffer.js
## built-ins/ArrayBuffer/isView/arg-is-dataview-subclass-instance.js (1)
built-ins/ArrayBuffer/isView/arg-is-dataview-subclass-instance.js
## built-ins/ArrayBuffer/isView/arg-is-typedarray.js (1)
built-ins/ArrayBuffer/isView/arg-is-typedarray.js
## built-ins/TypedArray/prototype/reverse (1)
built-ins/TypedArray/prototype/reverse/detached-buffer.js
## built-ins/TypedArrayConstructors/of/new-instance-using-custom-ctor.js (1)
built-ins/TypedArrayConstructors/of/new-instance-using-custom-ctor.js
## built-ins/TypedArrayConstructors/from/custom-ctor.js (1)
built-ins/TypedArrayConstructors/from/custom-ctor.js
## built-ins/DataView/proto-from-ctor-realm.js (1)
built-ins/DataView/proto-from-ctor-realm.js
## built-ins/TypedArray/from/iter-next-error.js (1)
built-ins/TypedArray/from/iter-next-error.js
## built-ins/TypedArray/prototype/length (1)
built-ins/TypedArray/prototype/length/invoked-as-accessor.js
## built-ins/DataView/dataview.js (1)
built-ins/DataView/dataview.js
## built-ins/TypedArrayConstructors/from/inherited.js (1)
built-ins/TypedArrayConstructors/from/inherited.js
## built-ins/TypedArray/from/from-array-mapper-detaches-result.js (1)
built-ins/TypedArray/from/from-array-mapper-detaches-result.js
## built-ins/TypedArrayConstructors/from/mapfn-is-not-callable.js (1)
built-ins/TypedArrayConstructors/from/mapfn-is-not-callable.js
## built-ins/ArrayBuffer/isView/invoked-as-a-fn.js (1)
built-ins/ArrayBuffer/isView/invoked-as-a-fn.js
## built-ins/TypedArrayConstructors/from/new-instance-using-custom-ctor.js (1)
built-ins/TypedArrayConstructors/from/new-instance-using-custom-ctor.js
## built-ins/TypedArray/from/iter-access-error.js (1)
built-ins/TypedArray/from/iter-access-error.js
## built-ins/TypedArray/from/not-a-constructor.js (1)
built-ins/TypedArray/from/not-a-constructor.js
## built-ins/TypedArray/prototype/byteLength (1)
built-ins/TypedArray/prototype/byteLength/invoked-as-accessor.js
## built-ins/TypedArrayConstructors/of/custom-ctor.js (1)
built-ins/TypedArrayConstructors/of/custom-ctor.js
## built-ins/TypedArrayConstructors/from/set-value-abrupt-completion.js (1)
built-ins/TypedArrayConstructors/from/set-value-abrupt-completion.js
## built-ins/TypedArray/prototype/find (1)
built-ins/TypedArray/prototype/find/detached-buffer.js
## built-ins/DataView/custom-proto-if-not-object-fallbacks-to-default-prototype.js (1)
built-ins/DataView/custom-proto-if-not-object-fallbacks-to-default-prototype.js
## built-ins/TypedArray/of/not-a-constructor.js (1)
built-ins/TypedArray/of/not-a-constructor.js
## built-ins/DataView/defined-byteoffset.js (1)
built-ins/DataView/defined-byteoffset.js
## built-ins/DataView/proto.js (1)
built-ins/DataView/proto.js
## built-ins/TypedArray/from/arylk-to-length-error.js (1)
built-ins/TypedArray/from/arylk-to-length-error.js
## built-ins/TypedArray/from/iter-invoke-error.js (1)
built-ins/TypedArray/from/iter-invoke-error.js
## built-ins/TypedArray/invoked.js (1)
built-ins/TypedArray/invoked.js
## built-ins/TypedArray/from/iterated-array-changed-by-tonumber.js (1)
built-ins/TypedArray/from/iterated-array-changed-by-tonumber.js
## built-ins/DataView/defined-bytelength-and-byteoffset.js (1)
built-ins/DataView/defined-bytelength-and-byteoffset.js
## built-ins/TypedArray/from/arylk-get-length-error.js (1)
built-ins/TypedArray/from/arylk-get-length-error.js
## built-ins/ArrayBuffer/prop-desc.js (1)
built-ins/ArrayBuffer/prop-desc.js
## built-ins/ArrayBuffer/proto-from-ctor-realm.js (1)
built-ins/ArrayBuffer/proto-from-ctor-realm.js
## built-ins/TypedArray/prototype/toString (1)
built-ins/TypedArray/prototype/toString/detached-buffer.js
## built-ins/DataView/defined-byteoffset-undefined-bytelength.js (1)
built-ins/DataView/defined-byteoffset-undefined-bytelength.js
## built-ins/ArrayBuffer/isView/arg-is-typedarray-buffer.js (1)
built-ins/ArrayBuffer/isView/arg-is-typedarray-buffer.js
## built-ins/TypedArray/prototype/Symbol.toStringTag (1)
built-ins/TypedArray/prototype/Symbol.toStringTag/invoked-as-func.js
## built-ins/TypedArray/from/from-typedarray-mapper-detaches-result.js (1)
built-ins/TypedArray/from/from-typedarray-mapper-detaches-result.js
```

## Implementation Plan — r4 (2026-09-04, Fable)

**Step 0 — inventory.** Isolate-run all 169 claimed rows on a `git archive
origin/main` base tree and the lane tree; record error per row. Control
corpus: every ES2015 row under `test/built-ins/TypedArray`,
`test/built-ins/TypedArrayConstructors`, `test/built-ins/ArrayBuffer`,
`test/built-ins/DataView` (the r3 lane's sweep lists in #5194 —
`ta-controls.txt`, `arrobj-controls.txt` — plus the 59-control
`tests/issue-5194-es2015-typedarray-set-r2.test.ts`). Keep the passing list.

**Step 1 — species protocol (slice 7, subarray 8, filter 6, map 6, ArrayBuffer
.prototype.slice 10 ≈ 37 rows).** `TypedArraySpeciesCreate` / `SpeciesConstructor`
(§23.2.4.1, §7.3.22): read `C = O.constructor` (undefined ⇒ default;
non-Object ⇒ TypeError), `S = C[@@species]` (undefined/null ⇒ default;
non-constructor ⇒ TypeError), construct `S(args)` and VALIDATE the result:
`ValidateTypedArray` (not a TypedArray ⇒ TypeError; detached ⇒ TypeError),
same content type (BigInt vs Number ⇒ TypeError), and for `slice`/`subarray`/
`filter`/`map` the length rule each row pins ("result is new instance from
same ctor", "speciesctor-get-species-custom-ctor-length-throws",
"speciesctor-get-species-returns-smaller-length" ⇒ TypeError). `this` inside
the @@species getter is the constructor being read (`this-value-in-species`).
`ArrayBuffer.prototype.slice`: species result must be an ArrayBuffer, not
detached, not the SAME buffer (`species-returns-same-arraybuffer` ⇒
TypeError), length ≥ newLen, and the source must be re-checked for
detachment AFTER the species construct (`species-constructor-is-not-object`,
`species-is-not-constructor`, `species-returns-not-arraybuffer`,
`species-returns-smaller-arraybuffer`, `species-returns-larger-arraybuffer`).
Anchor the runtime in `ta-dyn-mop.ts` / `dataview-native.ts` where the
existing species fast path lives (grep `species`); the fast path (no own
`constructor`, `Symbol.species` untouched) must stay byte-identical.

**Step 2 — element coercion order and abrupt completion (ctors/object-arg
11, toLocaleString 10, fill 5, copyWithin 5 ≈ 31 rows).** Object-arg
constructor: `IterableToList` / array-like read, then per element
`ToNumber`/`ToBigInt` in index order with the abrupt completion propagated
(`abrupt completion from ToNumber(sample)`, `… @@toPrimitive`, `… valueOf`)
and the `length` read before the element reads. `toLocaleString`: for each
element `Invoke(element, "toLocaleString")` with the abrupt completion
propagated and the separator `","`; a detached buffer mid-way ⇒ TypeError
(`detached-buffer-during-fromNumber`); `return-abrupt-from-firstelement-
tolocalestring` / `-nextelement-`. `fill`: `ToNumber(value)` (or ToBigInt)
FIRST, then `ToIntegerOrInfinity(start)`, `(end)`, then the detached check
(`coerced-indexes`, `coerced-value-detach` ⇒ TypeError after coercion).
`copyWithin`: `ToIntegerOrInfinity(target)`, `(start)`, `(end)` in that
order, then the detached check; `coerced-values-end-detached` etc.

**Step 3 — sort (12 rows).** `comparefn` must be callable or undefined at
entry (else TypeError, BEFORE ValidateTypedArray? — check the row
`comparefn-nonfunction-call-throws` vs `invoked-as-func`); the comparator's
abrupt completion propagates; the sort is stable and the default comparator
orders numerically with `-0 < +0` and `NaN` last (`sorted-values`,
`sorted-values-nan`, `stability`, `pre-sorted`); a detached buffer inside
the comparator: the sort completes on the (now stale) values without a throw
(`detached-buffer-comparefn-coerce` rows pin the exact rule — read them).

**Step 4 — `join` traps (6 rows, all `illegal cast [in __closure_N ← …]`).**
A trap is worse than a fail: find the cast (likely the separator/element
`ToString` on a BigInt array or an `undefined` separator through the closure
ABI) with `--isolate` + the wasm stack; fix the conversion in the join
native; the fix must not change the `Array.prototype.join` lowering.

**Step 5 — integer-indexed exotic internals (DefineOwnProperty 5,
OwnPropertyKeys 4, buffer-arg 2, typedarray-arg 2, HasProperty/Get residue).**
`[[DefineOwnProperty]]` (§10.4.5.3): a numeric key ⇒ not a valid integer
index ⇒ false; accessor descriptor ⇒ false; configurable false / enumerable
false / writable false ⇒ false; value present ⇒ `IntegerIndexedElementSet`;
`[[OwnPropertyKeys]]` (§10.4.5.7): integer indices ascending, then string
keys in creation order, then symbols — through `Reflect.ownKeys` and
`Object.getOwnPropertyNames`. Anchor `ta-dyn-mop.ts` (the "MOP" = the
per-internal-method dispatch for typed arrays).

**Step 6 — iteration methods (some / every / forEach / entries / values /
keys, 3 each = 18 rows).** Read the three rows per method first — they are
usually the same three shapes: `callbackfn` abrupt completion, a detached
buffer during iteration (the callback detaches ⇒ subsequent reads yield
`undefined`, no throw, for `forEach`/`some`/`every`; the iterator's `next()`
throws TypeError for `entries`/`values`/`keys`), and `%ArrayIteratorPrototype%`
identity/`toStringTag`. Implement the shared rule once in the
integer-indexed read helper rather than per method.

**Order-preservation constraints.** Modules with no typed array / ArrayBuffer
/ DataView reference are byte-identical to base on every target. The r3
pins (`tests/issue-5194*.test.ts`, 4 files) stay green unchanged.

## Acceptance criteria

- Claimed rows `pass` under `--isolate --standalone` or given up with the
  mechanism; `reflection-gated` and #3371 rows recorded as gated, not
  claimed.
- Zero rows lost in the control corpus vs the base tree.
- `tests/issue-5317-r4-*.test.ts` per step: kept rows + node-parity probes
  (species matrix, coercion-order call logs, sort matrix, join separators,
  ownKeys order).
- Gates, typecheck, lint green; growth granted above with the measurement.

## Lane protocol (applies to every step above)

- **Worktree only.** Work in the worktree the workflow gave you; branch from the
  merge-base you were spawned on and `git pull --no-rebase --no-edit origin main`
  before the first source edit. `git merge` is hook-blocked in the repo root;
  `git pull --no-rebase` is not. Link `node_modules` and `test262` DIRECTLY to
  `/home/user/js2/node_modules` and `$(readlink -f /home/user/js2/test262)` (no
  symlink chains through sibling worktrees). Copy
  `/home/user/js2/.test262-cache/quickjs*` into the worktree's `.test262-cache/`
  and run `node scripts/build-quickjs-eval-provider.mjs` there, or every
  eval-dependent row fails fast with "quickjs provider is not built" and hides
  both wins and regressions.
- **Measure, do not predict.** Every row you claim flips is run with
  `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone` on BOTH
  a `git archive origin/main` base tree and the lane tree; the enclosing control
  corpus named in the plan is re-run the same way and every base-pass row must
  still pass. A `compile_timeout` under load is re-run alone before it counts.
  Name the artifact and the time for every number you write down.
- **The failure family to hunt for is "a working program now throws."** Every
  confirmed regression across the last four waves was a "provable" predicate
  resolving by NAME or by declaration shape without a single-assignment /
  shadowing proof. Decline to base unless the proof holds under reassignment,
  destructuring, loop heads, parameters, `eval`/`with` and shadowing — and
  never let a new arm change the answer of a program that worked on base.
- **Node is the oracle, but the engine differs.** CI runs node 25; this
  container runs node 22 (a node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`).
  A pin that asserts node's answer must probe the running engine, not assert a
  fixed value, when the two disagree (sloppy-function own `caller`/`arguments`
  is the known case).
- **Do not touch the other team's territory:** the generator carrier (#2864,
  every `__gen_*`/`__create_generator` row), the promise/microtask carrier
  (#2867), and built-in method reflection (#2175 — `length.js`/`name.js`/
  `prop-desc.js`/`not-a-constructor.js` rows and the
  "`Object.prototype.toString` / `Function.prototype.call` is not yet
  implemented in --target standalone" rows). Leave those rows out of your
  claims and your acceptance list; record them as gated.
- **Gates before every commit, chained:** `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)`; plus
  `pnpm run -s check:speculative-rollback` (a raw `fctx.body.length = n`
  rollback outside `context/speculative.ts` fails CI — use
  `withSpeculativeCompile`/`probeCompiledType`), `check:stack-balance`,
  `check:codegen-fallbacks`, `check:any-box-sites`, TS7 typecheck
  (`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`)
  and `pnpm run -s lint`. Growth grants go in THIS issue's frontmatter
  (`loc-budget-allow` / `func-budget-allow`) with a dated rationale; never edit
  `scripts/*-baseline.json`. New codegen type queries go through `ctx.oracle`.
- **Tests:** `tests/issue-<id>-r4-*.test.ts` pin every kept row through
  `runTest262File(file, "issue-<id>", 60_000, "standalone")` plus node-parity
  probes compiled with `compile(source, { target: "standalone", allowJs: true,
  skipSemanticDiagnostics: true })`, asserting `result.imports` is `[]`. Run
  them at the CI fork heap, single fork:
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/issue-<id>*.test.ts
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
  --dangerouslyIgnoreUnhandledErrors`.
- **Commits:** author stays the repo's configured identity; subject ends with
  ` ✓`; `SKIP_SLOW_PRECOMMIT=1`; never `--no-verify`; trailers
  `Model: Claude Opus 5 Medium`, `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>`. Commit each step separately with the measurement
  in the body. Do NOT push, open a PR, or enqueue — the integrator merges the
  lane branch, validates the combined tree and opens the PR.
- **Report** (your final message): the per-step row table (base → lane, kept /
  given up), the control-corpus result, gate status, the worktree path and head
  sha, and every residual with its mechanism.

