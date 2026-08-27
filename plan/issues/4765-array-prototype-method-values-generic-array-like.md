---
id: 4765
title: "Array.prototype methods do not reify as function values (19 of the 22 remaining ES2016 failures, and the whole array-like `.call` family)"
status: ready
created: 2026-08-26
updated: 2026-08-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: arrays
goal: spec-completeness
sprint: current
horizon: xl
loc-budget-allow:
  # 2026-08-27 — slice 1 (host-lane method value). Both are the minimum wiring
  # for a NEW mechanism whose logic lives in the leaf module
  # src/codegen/array-method-value.ts, not in the god files:
  #   property-access.ts +7 — the intercept call in compilePropertyAccess
  #   runtime.ts         +4 — the __array_proto_method intrinsic
  - src/codegen/property-access.ts
  - src/runtime.ts
func-budget-allow:
  # Same +4: resolveImport is the single switch every host import is registered
  # in, so a new import necessarily grows it.
  - src/runtime.ts::resolveImport
  # 2026-08-27 slice 2 (escape-aware `in`). +14 in compileInOperator: one route
  # predicate and its rationale, joining the five sibling route flags that
  # already live there (vecNamedKeyRoute, reassignedReceiverRoute,
  # fnctorProtoRoute, growableReceiver, inheritsFromObjectPrototype). The scan
  # itself is a leaf module, src/codegen/in-escaped-receiver.ts.
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# #4765 — `Array.prototype` method values and the generic array-like algorithm

## Problem

Reading an `Array.prototype` method as a **value** yields `null`. Calling one
works (the call site is inlined); taking it and invoking it through `.call` /
`.apply` does not.

Measured 2026-08-26 with `runTest262File` on the pinned submodule SHA
(`b363f29d3c43c626dc852744ad64a0b48a003693`):

```
built-ins/Array/prototype/includes/get-prop.js
  TypeError: Cannot read properties of null (reading 'call')
built-ins/Array/prototype/includes/values-are-not-cached.js
  TypeError: Cannot read properties of null (reading 'call')
    at [].includes.call(obj, "tc39")
built-ins/Array/prototype/includes/tolength-length.js
  TypeError: Cannot read properties of null (reading 'call')
```

The gap is **not** specific to `includes` — `indexOf` and `slice` read as `null`
too. The static-method row already works: `Array.isArray`, `Object.keys`,
`Reflect.get` and friends reify through
`ensureStandaloneBuiltinStaticMethodClosure` (`property-access.ts`) with
`{name, length}` metadata in `STANDALONE_STATIC_METHOD_META`
(`src/codegen/builtin-fn-meta.ts`). No equivalent exists for prototype
(instance) methods.

Two things are missing, and the second is the larger one:

1. **A callable value** for `Array.prototype.<m>` — a closure carrying the right
   `.name` / `.length`, dispatchable through the existing `.call` / `.apply`
   path.
2. **A generic array-like algorithm behind it.** The inlined lowerings assume a
   WasmGC vec receiver (`ref.cast` to the vec carriers, `array.get` on the
   backing). `[].includes.call(obj, …)` passes an ordinary object with a
   `length` property, so the closure body must run the spec algorithm over an
   arbitrary object: `ToObject` → `Get(O, "length")` → `ToLength` →
   `ToIntegerOrInfinity(fromIndex)` → per-index `Get`. Getters must be observed
   in spec order and their abrupt completions propagated — that is exactly what
   `return-abrupt-get-length.js`, `return-abrupt-get-prop.js`,
   `return-abrupt-tonumber-length.js` and
   `return-abrupt-tointeger-fromindex-symbol.js` assert, and why they currently
   report "Expected a Test262Error but got a TypeError" (the TypeError is the
   null-`.call`, not the test's own error).

## Impact

**19 of the 22 remaining ES2016 failures** — this single root cause is the ES2016
bucket. Measured 2026-08-26 over the 147 files tagged `Array.prototype.includes`
/ `exponentiation` / `u180e`, minus the 21 `intl402/` rows the runner's
`TEST_CATEGORIES` never walks: **104 pass / 126 in scope**, 22 failures. The
remaining 3 are unrelated singletons (`Function/prototype/toString/built-in-function-object.js`,
`Iterator/prototype/chunks/chunkSize-out-of-range.js`,
`language/expressions/object/cpn-obj-lit-computed-property-name-from-math.js`).

The two groups below share this one cause:

| rows | files |
| --- | --- |
| 9 | `Array/prototype/includes/{get-prop,length-boundaries,length-zero-returns-false,return-abrupt-get-length,return-abrupt-get-prop,return-abrupt-tointeger-fromindex-symbol,return-abrupt-tonumber-length,tolength-length,values-are-not-cached}.js` |
| 10 | `Array/prototype/{pop/length-near-integer-limit,reverse/length-exceeding-integer-limit-with-object,reverse/length-exceeding-integer-limit-with-proxy,slice/length-exceeding-integer-limit-proxied-array,splice/create-species-length-exceeding-integer-limit,splice/length-and-deleteCount-exceeding-integer-limit,splice/length-exceeding-integer-limit-shrink-array,splice/length-near-integer-limit-grow-array,unshift/clamps-to-integer-limit,unshift/length-near-integer-limit}.js` |

The second group additionally needs 2^53-safe length arithmetic (the loops use
`i32` counters against a `.length` up to 2^53−1). That is separable follow-up
work, but it cannot even be reached until the `.call` path resolves — those rows
never get past `[].splice.call(…)` reading as `null`.

Far more than 19 rows depend on this outside ES2016: every
`Array.prototype.<m>.call(arrayLike, …)` test262 row in every edition, and the
`Function.prototype.{call,apply,bind}`-on-builtin family.

## Slice 1 — DONE (host lane), and it re-sized the issue

The original sizing above ("XL, not a by-product of an includes fix") was wrong
about the first step, because it missed that **two call spellings behave
differently**:

| spelling | uses in the includes/reverse/splice/unshift/pop/slice dirs | status before slice 1 |
| --- | --- | --- |
| `Array.prototype.includes.call(obj, …)` | 72 | already resolved — runs the real generic algorithm through the host `Array` global |
| `[].includes.call(obj, …)` | 40 | `null` — no route from a vec receiver in non-call position |

So the generic algorithm was never the blocker for the first tranche; the
missing piece was only a **route from a vec-typed receiver to the intrinsic**.
`src/codegen/array-method-value.ts` adds it, modelled on the #2743b
`vec[Symbol.iterator]` → `%Array.prototype.values%` intercept: host lane, non-call
position, array/tuple receiver, receiver evaluated for effect then dropped,
intrinsic fetched via a new `__array_proto_method` import.

**Measured: ES2016 in-scope 102/124 → 109/124**, no regressions (full
before/after run of the 124 in-scope files with
`scripts/run-test262-paths.mts`). Seven of the nine `includes` rows flipped.

Remaining from the original 19, now 12:

- 2 `includes` rows fail on **`fromIndex` observation order**, not on the value
  read: `length-zero-returns-false.js` ("length is checked before
  ToInteger(fromIndex)" — we observe `valueOf` when we should not) and
  `return-abrupt-tointeger-fromindex-symbol.js` ("Expected a TypeError to be
  thrown but no exception was thrown"). Both point at argument marshalling
  coercing a WasmGC struct on its way to the host call, ahead of the host
  algorithm's own step order.
- 10 rows in the 2^53-length family. **Diagnosed 2026-08-27 — and it is not the
  length arithmetic.** See the section below.

## The 2^53 family is a `delete`-visibility problem, not an arithmetic one

Probed through the real runner (a scratch file under `test262/test/`, run with
`scripts/run-test262-paths.mts`, so the whole host-wrapper path is live):

```
var a = { length: 3, 0: "a", 1: "b", 2: "c" };
delete a[2];
  2 in a                                  →  true    (must be false)
  Object.prototype.hasOwnProperty(a, "2") →  false    (correct)
  a[2]                                    →  "c"      (must be undefined)
```

So a **direct `delete`** on a statically-shaped struct is already invisible to
`in` and to the index read, while `hasOwnProperty` honours it. The host's
`Array.prototype.pop` / `splice` / `unshift` remove elements with
`DeletePropertyOrThrow`, and those removals are exactly what these rows assert
("`arrayLike['9007199254740990']` is removed"). Nothing about 2^53 is involved —
the same failure reproduces at index 2.

**Dead end worth not repeating.** The obvious fixes do nothing:
`_wasmStructDeletedKeys` (the tombstone set) is consulted by `_wasmStructHasOwn`,
by gOPD, and by `__extern_has`, but adding the same guard to the host proxy's
`has` trap, to `__extern_has_idx`, and to `__extern_get_idx` changes no
behaviour — because a statically-typed receiver never reaches the indexed MOP
at all. `a[2]` lowers to a direct struct-field read (`__sget_2`), and `2 in a`
resolves statically from the struct shape. All three edits were tried and
reverted.

The string-key form behaves identically, which rules out the indexed MOP as the
site. Reproducing `pop/length-near-integer-limit.js` exactly (the row asserts
`"9007199254740990" in arrayLike === false`):

```
var a = { "9007199254740989": "x", "9007199254740990": "y", length: 2**53-1 };
Array.prototype.pop.call(a);
  pop returned "y"                         ✓
  a.length === 2**53-2                     ✓
  a["9007199254740989"] === "x"            ✓   (untouched element)
  hasOwnProperty(a, "9007199254740990")    ✓  false
  "9007199254740990" in a                  ✗  true   (must be false)
  a["9007199254740990"]                    ✗  "y"    (must be undefined)
```

The host `pop` did everything right — only the compiled `in` and the property
read disagree. Both resolve **statically from the struct shape** for a
literal key on a known-typed receiver, so neither reaches `__extern_has`
(which is tombstone-aware and would answer correctly).

The escape is the crux: the deletion happens **inside host code**
(`Array.prototype.pop.call(a)`), not via a `delete` statement, so no
"module uses delete" signal could catch it — and there is no
`escapesToHost` / `usesDelete` concept in `CodegenContext` today to hang a
narrow fix on (checked). An object handed to an unknown host callee can have
its shape mutated, so its later reads cannot be answered from the static shape.

## Slice 2 — DONE (host lane): escape-aware `in`

**Measured: 109/124 → 113/124**, no regressions. Four rows flipped
(`pop/length-near-integer-limit`, `splice/length-and-deleteCount-exceeding-integer-limit`,
`splice/length-exceeding-integer-limit-shrink-array`,
`splice/length-near-integer-limit-grow-array`).

The fix is not a presence bit after all — it is scoping the FOLD. `in` answers
§7.3.12 from the receiver's compile-time struct shape, which is sound only while
the compiler owns that shape. It stops owning it the moment the object is passed
to a callee it cannot see through: the callee may delete a key, and the field
list does not shrink. `src/codegen/in-escaped-receiver.ts` asks the cheap
value-independent question — "is this binding ever handed to a call?" — and a
`true` suppresses the fold and takes the existing `__extern_has` arm, which
consults the tombstone and was right all along.

That predicate joins five sibling route flags already in `compileInOperator`
(`vecNamedKeyRoute`, `reassignedReceiverRoute`, `fnctorProtoRoute`,
`growableReceiver`, `inheritsFromObjectPrototype`) — each one an existing case of
"the static type is not a fact about this site". It is deliberately conservative:
being permissive costs one `__extern_has` call on an `in`, never a wrong answer.

`growableReceiver` is the closest sibling and was tried first — it is exactly
this guard for standalone's growable `$Object` receivers. Ungating it does
nothing in the host lane, because the shape-widening pass that populates
`growableObjectLiteralVars` does not run there. That is why the host lane needs
its own question.

**Still open in this family** (`reverse` ×2, `slice`, `splice/create-species`,
`unshift` ×2): these assert on the READ (`arrayLike[i]`), on a Proxy receiver, or
on species construction — the property read has the same static-shape
unsoundness as `in` did, but routing every escaped read through `__extern_get`
is a much larger perf question than routing `in`. `unshift/clamps-to-integer-limit.js`
remains the one genuinely arithmetic row.

The read-side fix is where **per-instance property presence for statically-shaped structs**
— the struct field physically exists, so deletion needs a presence bit consulted
by the compiled read and `in`, not just a host-side tombstone. The precedent is
`bfnstate` in `src/codegen/builtin-fn-meta.ts`, which carries exactly this kind
of per-instance deleted-bits mask for a builtin function's `name`/`length` so
`verifyProperty`'s delete-then-`hasOwnProperty` round-trip works. Generalising
that to open-object structs is the shape of the work.

One separate row in the family is genuinely arithmetic:
`unshift/clamps-to-integer-limit.js` — after `arrayLike.length = 2 ** 53`,
`Array.prototype.unshift.call(arrayLike)` must write back `ToLength(len)` =
2^53−1; measured, the length stays 2^53.

**Standalone is untouched** — the intercept returns early under
`ctx.standalone || ctx.wasi`. A native answer still needs the generic array-like
algorithm below, so the rest of this plan stands for standalone and for the
2^53 work.

## Implementation Plan (remaining slices)

1. **Reify the value.** Extend the static-method closure machinery in
   `src/codegen/property-access.ts` to prototype methods: a
   `ensureBuiltinPrototypeMethodClosure(ctx, "Array.prototype.includes")`
   sibling of `ensureStandaloneBuiltinStaticMethodClosure`, with its
   `{name, length}` added to a `STANDALONE_PROTOTYPE_METHOD_META` table
   alongside `STANDALONE_STATIC_METHOD_META`. Spec `length`: `includes` 1,
   `indexOf` 1, `lastIndexOf` 1, `slice` 2, `splice` 2, `push` 1, `pop` 0,
   `unshift` 1, `reverse` 0.
2. **Write the generic body once, parameterised by method.** A single
   `__array_like_scan(O, searchElement, fromIndex, mode)` covering
   `includes` / `indexOf` / `lastIndexOf` (they differ only in the comparison —
   SameValueZero vs IsStrictlyEqual — and the direction / return shape) keeps
   this from becoming N hand-written closures. It must use the existing
   host-free `Get` / `ToLength` / `ToIntegerOrInfinity` helpers so standalone
   mode is not regressed; check `src/runtime.ts` and the `__extern_*` helper
   family for what already exists before adding any host import (the dual-mode
   rule in CLAUDE.md applies).
3. **Route the receiver.** `[].includes` must produce the closure; `arr.includes(x)`
   must keep the inlined vec fast path byte-for-byte. Gate on whether the
   property access is in call position with a statically-known vec receiver —
   the same discrimination `shouldUseHostArrayMethod` already makes.
4. **Order of observable operations.** `length-zero-returns-false.js` asserts
   `Get(O, "length")` happens **before** `ToIntegerOrInfinity(fromIndex)`;
   `values-are-not-cached.js` asserts each index is read fresh inside the loop,
   not snapshotted. Write these as equivalence tests first — they are cheap to
   get subtly wrong and the test262 error strings do not name the ordering.

### Sizing note

This is genuinely XL and should not be attempted as a by-product of an
`includes` fix. Steps 1–2 alone touch the closure-wrapper types, the builtin
meta tables, and a new runtime algorithm; step 3 is a codegen dispatch change on
a hot path.

## Acceptance criteria

- [ ] `([] as any).includes` is a callable value with `.name === "includes"` and
      `.length === 1`
- [ ] The 9 `Array/prototype/includes` rows above pass
- [ ] `arr.includes(x)` on a statically-known vec still takes the inlined path
      (verify the emitted binary is unchanged for the existing equivalence cases)
- [ ] No new host import in standalone mode
