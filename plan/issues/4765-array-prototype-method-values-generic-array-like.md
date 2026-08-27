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
  # 2026-08-27 slice 2b (the trap half of the same fix). +12 in _wrapForHost:
  # the tombstone guard in its `has` trap plus the rationale for why that trap
  # is the one an `in` on an externref-typed receiver reaches.
  - src/runtime.ts::_wrapForHost
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

### The read side, measured — and the trade-off it forces

`in` is fixed; the READ is narrower than "escaped reads are unsound", and the
difference matters because it decides how expensive the fix is. Probed:

```
var a = { "0": "zero", "2": "two", length: 3 };
Array.prototype.unshift.call(a, "new");
  a.length  4          ✓
  a["0"]    "new"      ✓   declared field, host WROTE it
  a["1"]    "zero"     ✓   undeclared key, read routes dynamically
  a["3"]    "two"      ✓   undeclared key, read routes dynamically
  a["2"]    "two"      ✗   declared field, host DELETED it — must be undefined
```

So host **writes** are already visible, and undeclared keys already read
dynamically. Exactly one case is wrong: **a read of a DECLARED struct field that
the host deleted.** The write lands in the field; the delete only records a
tombstone and leaves the field in place, and the compiled `struct.get` does not
consult it.

That is the same missing tombstone check the `in` fold had — but the remedy is
not the same size. `in` could take an existing `__extern_has` arm, and `in` is
rare. Making the read correct means routing declared-field reads on an escaped
receiver through `__extern_get`, which deoptimises `obj.x` after any `f(obj)` —
ordinary TypeScript code, not just array-likes.

**This is a product trade-off, not a bug fix, and it is deliberately left for a
human to make.** Options, cheapest first:

1. Narrow the escape predicate for READS to array-like receivers only (static
   type has `length` plus numeric-ish keys). Fixes
   `unshift/length-near-integer-limit.js`; cannot deopt ordinary object code.
   Ad hoc, but the population it targets is exactly the generic-array-algorithm
   one.
2. Per-instance presence bits on the struct (the `bfnstate` precedent in
   `src/codegen/builtin-fn-meta.ts`), so the compiled `struct.get` can check a
   deleted-bit without a host call. Correct everywhere, keeps reads native,
   costs a field per open-object struct and a branch per read.
3. Route all escaped declared-field reads through `__extern_get`. Simplest,
   most correct, worst for performance.

Option 2 is the principled one. **Option 1 was built and does NOT buy the row** —
correcting what an earlier draft of this section claimed. It was implemented
(`tryCompileEscapedArrayLikeElementRead`, gated on `identifierEscapesToCall` plus
`propertyFactOf(recv,"length").kind === "number"` and an integer literal key —
note `typeFactOf(...).shape` is NOT populated for these anonymous object types,
so the per-property question is the only one the oracle answers here). It
demonstrably fixed the wrong answer:

```
var a = { "0": "zero", "2": "two", length: 3 };
Array.prototype.unshift.call(a, "new");
  a["2"]   "two" before  →  undefined after   ✓
```

…and moved **zero** conformance rows, so it was reverted rather than shipped: a
hot-path change with a perf trade-off, bought with no measured conformance, is
not a trade worth making unilaterally.

### Why `unshift/length-near-integer-limit.js` still fails — traced, not guessed

It fails on its `in` assertion, not on a read, so slice 2's escape route did not
fire for that receiver. Two hypotheses were tried and both were wrong; the
answer came from tracing the site:

```
IN2 key=9007199254740989 rightWasm=externref escaped=false tsHas=true has=true
```

The receiver is **externref**, not a struct ref, so `escapedReceiverRoute`'s
`ref`/`ref_null` gate excluded it and `tsTypeHasProperty` folded the answer to
`true`. (The getter in the object literal was a red herring — hypothesis 1.)

Widening the gate to drop the `ref`/`ref_null` requirement makes it fire exactly
as intended — traced `escaped=true`, `has=false`, so the fold is suppressed and
the existing `__extern_has` arm is taken — **and the row still fails.** Measured
across the full 124: still 113, no regressions, no gains. So it was reverted
(hypothesis 2 wrong).

### Slice 2b — the missing half, found by probing the receiver shape

Reproducing the row's own object shape (throwing getter, small indices) settled
it:

```
function Stop() {}
var a = { get "6"() { throw new Stop(); }, "7": "seven", "9": "nine", length: 12 };
try { Array.prototype.unshift.call(a, null); } catch (e) {}
  hasOwnProperty(a, "9")  false   ✓   tombstone IS in the JS WeakMap
  a["9"]                  undefined ✓ the compiled READ is correct
  "9" in a                true    ✗
```

So `_wasmStructHasOwn` and the read were both right; only `in` disagreed. With
an **externref**-typed receiver the routed `__extern_has` does not take its
`_isWasmStruct` arm — it falls through to `key in obj`, which hits the host
wrapper's **`has` trap**, and that trap read the static struct shape without
consulting the tombstone.

Both halves are needed, which is why each looked like a no-op alone: dropping
the `ref`/`ref_null` gate on `escapedReceiverRoute` (so the fold is suppressed
and `in` actually routes), plus the tombstone guard in the `has` trap (so the
routed question is answered correctly). Verified: `in9=false`, and
`in`/`hasOwnProperty` now agree.

**This is the vindication of the very first attempted fix in this issue.** The
proxy-`has` tombstone guard was tried early, measured as a no-op, and reverted —
correctly, on the evidence available, because the fold was short-circuiting
before the trap was ever reached. Testing a fix whose precondition is not met
reads exactly like testing a wrong fix.

`unshift/length-near-integer-limit.js` still fails: with the mechanism working at
small indices, what remains for that row is genuinely the 2^53 scale (keys near
2^53, `length: 2**53-2`). Measured 113/124 with slice 2b — no rows gained, no
regressions. Shipped anyway: it closes a real `in`-vs-`hasOwnProperty`
disagreement any host mutation can produce, at zero measured cost, in the same
class as slice 2 (which did gain rows).

Superseded diagnosis, kept for the record: The earlier probe showed it answering correctly for a
plain object literal, so something about THIS receiver puts the deletion
somewhere `_wasmStructHasOwn` does not look — most likely the host `unshift`
deleted through the native `__delete_property` path (an `_isNativeOpenObject`
receiver) while `_wasmStructHasOwn` consults the JS-side
`_wasmStructDeletedKeys` WeakMap. That divergence is the thing to verify next,
and it is a runtime question, not a codegen one.

### CORRECTION (2026-08-27): the sparse-write diagnosis below is WRONG

I read the runner's error line as naming the failing statement. It does not —
`"in __module_init() at source L30 | at L40: <text>"` puts the FRAME first and
the statement second, so the trap was never at the setup assignment.

Measured directly, both spellings of the huge-index write are fine:

```
var a = []; a[9007199254740988]  = "num";   // ok
var b = []; b["9007199254740988"] = "str";  // ok
```

They are fine because the mechanism already exists: `SPARSE_INDEX_CEILING`
(16,777,216) in `src/codegen/vec-sparse-index.ts` marks an index "unbackable",
and `emitUnbackableIndexFlag` / `needsGrowCondInstrs` / `guardedElementSetInstrs`
suppress both the growth and the store, with reads answering `undefined`. So the
write path already does what I claimed it did not.

The trap is in the METHOD, isolated:

```js
var proxy = new Proxy(array, { get: (t, pk, r) => pk === "length" ? 2 ** 53 + 2 : Reflect.get(t, pk, r) });
Array.prototype.slice.call(proxy, 9007199254740989);
  → RuntimeError: requested new array is too large   (and NOT catchable by a JS try/catch)
```

Narrowed further, and `slice` is not required either — this alone traps:

```js
var array = []; array["9007199254740989"] = "a";
var proxy = new Proxy(array, { get: (t,pk,r) => pk === "length" ? 2 ** 53 + 2 : Reflect.get(t,pk,r) });
proxy.length;            // no slice, no splice
```

while each ingredient on its own is fine:

```js
var a = []; a[9007199254740988] = "x";              // ok
var b = []; b["9007199254740988"] = "y";            // ok
var c = []; c[9007199254740988] = "z"; new Proxy(c, {});   // ok
```

So the trigger needs a Proxy whose `get` REPORTS a length past 2^53 over a
sparse vec — something on our side then materialises a backing of that reported
length. `slice`/`splice` are downstream victims, not the cause.

**Bisected to a single operation.** Deleting statements one at a time: Proxy
construction alone is fine, `proxy.length` alone is fine (returns 9007199254740994,
correct), `proxy["9007199254740989"]` alone is fine (returns "a"). The trigger is
**`Array.isArray(proxy)`** — which per §23.1.2.2 is a pure IsArray check that
allocates nothing.

`__extern_is_array` in the runtime is clean, so the allocation is on the way IN.
`new Proxy(t, h)` is typed as its TARGET (ProxyConstructor returns `T`), so a
proxy over an array resolves to a **vec** in `call-builtin-static.ts`, takes the
`isArrayCarrierValType` constant-fold branch, and compiles the argument AS a vec
"for side effects" — materialising the host proxy through its reported `length`.

**The obvious fix does not work.** Applying the #2617 precedent (trust the local's
actual SLOT type when it is externref/anyref, as `compileInOperator` does for the
same staleness) does not fix even the isolated probe, so `proxy` is not sitting in
an externref slot and the materialisation is elsewhere. Written and reverted, not
shipped.

### COMPLETE causal chain (2026-08-27) — and it lands on a deliberate trade-off

Instrumenting `buildVecFromExternref` to dump a stack, then naming the coerced
expression, gives the whole path with no guesswork left:

```
COERCE externref -> ref_null: new Proxy(array, { get(t, pk, r) { … } })
  compileExpressionBody → coerceType → buildVecFromExternref
```

The materialisation is **at the declaration** `var proxy = new Proxy(array, h)`,
not at any later use. TypeScript types `new Proxy(t, h)` as its target, so the
binding gets a vec slot and the host proxy is materialised into it — reading
`__extern_length` (2**53+2), narrowing to a saturated i32, and allocating.

**And this is already governed by an existing, deliberate rule.**
`moduleInitForcesExternref` in `src/codegen/declarations.ts` (~L2431) DOES force
externref for `isDirectProxyConstruction(decl.initializer)` — except when
`proxyBindingEscapesToCall(ctx, decl)`, where it keeps the structural slot on
purpose, because (quoting the code) "widening it would make the consumer cast a
host Proxy externref back to the target struct and trap."

Our rows hand `proxy` to a call (`Array.prototype.slice.call(proxy, …)`), so the
escape gate fires, the vec slot is preserved, and the materialisation traps.
The heuristic trades one trap for another, and #4707 / #4754 / #4931 already
tuned this seam (`proxyModuleEscapeGateEnabled` is described there as "the sole
attribution seam").

**Measured what flipping it would buy.** The gate has a documented off-switch
(`JS2WASM_PROXY_MODULE_ESCAPE_GATE=0`, `declarations.ts:1649`), so the benefit
side of the trade is a number, not a guess:

| escape gate | ES2016 in-scope |
| --- | --- |
| on (today's default) | 113 / 124 |
| off | **114 / 124** |

Exactly one row flips — `slice/length-exceeding-integer-limit-proxied-array.js`.
`splice/create-species-length-exceeding-integer-limit.js` and
`reverse/…-with-proxy.js` do NOT flip, so they fail for reasons beyond the
materialisation.

**Cost side, now measured too.** The gate only affects module-level bindings
initialised with `new Proxy`, so the affected population is enumerable: 450
test262 files matching a top-level `var|let|const x = new Proxy(`. Both ways:

| escape gate | pass | fail | skip |
| --- | --- | --- | --- |
| on (default) | 179 | 196 | 75 |
| off | **196** | 179 | 75 |

Diffing the two fail sets: **18 rows fixed, 1 regressed.** The single regression
is `built-ins/Object/getOwnPropertySymbols/proxy-invariant-not-extensible-absent-string-key.js`
— almost certainly the invariant #4931 was introduced to protect.

**The −1 is itself diagnosed, and it is shallow.** With the gate off, `proxy`
stays a real host Proxy, and the row needs the host's §10.5.11 invariant check to
fire. Probed:

```
var t = { prop: 2 };
Object.isExtensible(t)                     true    ✓
Object.preventExtensions(t);
Object.isExtensible(t)                     false   ✓   extensibility tracking is correct
Object.getOwnPropertySymbols(new Proxy(t, { ownKeys: () => [] }))
                                           does NOT throw   ✗
```

Extensibility is tracked correctly. So is everything else on the target — probed
one level further:

```
Object.getOwnPropertyNames(t)              ["prop"]              ✓
Object.getOwnPropertyDescriptor(t, "prop") { configurable: true } ✓
Reflect.ownKeys(t)                         ["prop"]              ✓
Object.isExtensible(t)                     false                 ✓
```

Every input §10.5.11 step 21 needs is present and correct, and the wrapper's
`ownKeys` trap does report `"prop"` (it returns `collectKeys()`). So the check is
never running: **our `Object.getOwnPropertySymbols` lowering is not routing to
the host Proxy's `[[OwnPropertyKeys]]` at all** — it answers from our own
reflection instead, where the user `ownKeys` trap returning `[]` is simply never
consulted.

That makes the −1 a `getOwnPropertySymbols`-routing gap, not a wrapper-trap gap.
Correcting my own note one line above, which blamed the `ownKeys` trap.

**And the runtime half is already correct.** `__getOwnPropertySymbols`
(`runtime.ts:13192`) does `if (!_isWasmStruct(obj)) return Object.getOwnPropertySymbols(obj)`
— for a real host Proxy that runs the trap and the §10.5.11 invariant, and would
throw. So the fold is in **codegen**: `proxy` is typed as its target
(`{prop: number}`), and the call is answered statically from that type instead of
reaching the runtime import.

That is the same "the static type is not a fact about this site" shape as the
#2617 `in` guard and the escape-aware `in` fix in slice 2 — and my two attempts at
that shape for `Array.isArray` (locals, then module globals) both failed to fire,
so the slot-type approach is NOT the right instrument here. Find where
`Object.getOwnPropertySymbols` is folded and gate on the argument being a
`new Proxy`-derived binding directly.

Fix that trap and the gate flip becomes **+19 / −0** on this population, which
would make it a clean decision rather than a trade.

So the real trade is **+18 / −1 inside the Proxy population, plus +1 in ES2016**,
against one proxy-invariant row. That looks strongly favourable, and it is still
not mine to flip: the −1 is a genuine conformance regression, the number was
measured on a subset rather than the full suite, and the gate has been tuned by
three prior issues. Run the full suite both ways in CI and let #4931's owner
decide; this at least makes it a decision with numbers on both sides instead of
one.

**The earlier cost note (now superseded):** The gate exists
because of #4707/#4754/#4931; turning it off restores #4931's behaviour by the
code's own account. Nobody should flip the default on the strength of +1 ES2016
row without running the full suite both ways — that measurement is the actual
next step, and it is cheap in CI and expensive locally.

**So this is a policy decision on a tuned heuristic, not a defect to patch.**
The options are to make the escape gate distinguish "handed to a typed consumer
that will cast" from "handed to a generic host algorithm that will not", or to
make the materialisation itself refuse a length it cannot represent with a
catchable RangeError instead of a Wasm trap. Whoever owns #4931 should pick;
flipping the gate blind would re-open whatever it was introduced to close.

**The allocation site itself is `buildVecFromExternref`** (`src/codegen/type-coercion.ts:757`).
It materialises a host array-like into a vec by calling `__extern_length` (which
returns **f64**), narrowing that to an i32 `lenLocal`, and allocating a backing
of that size. A proxy reporting `2 ** 53 + 2` narrows to a saturated i32 (~4.29
billion) and `array.new_default` refuses it — the uncatchable
"requested new array is too large".

Two things follow, and they are separable:

1. **Defensive, and correct regardless of the rest**: an f64 length that does not
   fit a sane vec size should raise a catchable **RangeError**, not a Wasm trap.
   A trap cannot be caught by the JS `try` in the test (or in user code), so
   today the failure mode is a hard abort rather than a JS exception. This alone
   will not flip these rows — they expect neither — but it converts an
   uncatchable crash into a diagnosable error.
2. **The actual row fix**: nothing should be materialising here at all.
   `Array.isArray` is a pure predicate, and `Array.prototype.slice.call(proxy, …)`
   should reach the host bridge with the proxy intact. Finding why the proxy is
   coerced into a vec on the way to those calls is the work.

Note the three failing rows do NOT call `Array.isArray` themselves — they call
`Array.prototype.slice.call(proxy, …)`. Same class (a host proxy materialised
through a fake `length`), different site. Fixing the marshalling generally is
what these rows need, not a per-builtin patch.

**Deliberately not asserting the exact statement for the .call rows.** The runner's error line names
the frame, not the failing statement, and believing it has now produced two wrong
diagnoses in this issue. Whoever picks this up should bisect by deleting
statements, not read the location out of the message.

This is the second time this session an error STRING drove a wrong diagnosis
(the first was the stale baseline text on `includes/samevaluezero.js`). Isolate
the failing operation in a probe before believing a location.

### Superseded: the "requested new array is too large" trap — diagnosed

`slice/length-exceeding-integer-limit-proxied-array.js` and
`splice/create-species-length-exceeding-integer-limit.js` do NOT trap inside the
array algorithm. They trap in the test's **setup**, before the method under test
is ever called:

```js
var array = [];
array["9007199254740988"] = "9007199254740988";   // <-- RuntimeError here (L30)
```

Assigning a huge index to a real Array must, per §10.4.2.1, set
`length = index + 1` and store the property — **sparse, no allocation**. The
compiler instead grows the vec's physical backing toward the logical length and
the allocation is refused.

So the fix is in the vec element-assignment write path, not in `slice`/`splice`:
an index beyond a threshold must land in the sparse overlay (the #3251 overlay /
#3537 bag already used for named keys on vecs) and only move the logical
`length`. `#3201` already established that logical length can exceed the physical
backing on the READ side (`compileArrayIncludes` clamps its scan to
`array.len`), so the representation supports this — the write path is what does
not.

This is a hot path (every `a[i] = v`), so it wants a real design pass, but it is
a bounded one and it is the largest remaining ES2016 bucket.

**Genuinely separate** — `reverse` ×2 need host observation of a throwing
accessor on the wrapped struct; `unshift/clamps-to-integer-limit.js` needs the
`ToLength` write-back; `unshift/length-near-integer-limit.js` needs the same
sparse-write fix as above (its keys are at the 2^53 scale). `unshift/clamps-to-integer-limit.js`
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
