---
id: 2934
title: "Standalone: invalid-Wasm heterogeneous tail after #2878 (test/__closure_*/__cb_0 — distinct codegen bugs)"
status: in-progress
assignee: ttraenkler/dev-2934f
created: 2026-07-02
updated: 2026-07-02
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone
related: [2860, 2868, 2878]
umbrella: 2860
---

# Standalone: invalid-Wasm heterogeneous tail after #2878

#2878 retired the `externref → eqref` coercion class (the
`__call_toString`/`__call_valueOf`/`__set_member_toString` invalid-Wasm bucket).
This tracks the **residual tail** measured on current `main` after that fix — a
set of **heterogeneous, unrelated** codegen defects (NOT a single mechanism, NOT
the eqref/funcIdx-shift class), so each is fixed as a **separate slice**.

## Measurement (2026-07-02, dev-2878)

`--target standalone` compile + `WebAssembly.compile` validate over a 3,500-file
`built-ins` stride sample, AFTER #2878: **26 invalid binaries** remaining.
Clustered by failing function + validator signature:

| failing fn           | count      | validator signature (representative)                                        | example test                                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`               | ~15        | `call[0] expected type (ref null …)`                                        | `String/prototype/concat/S15.5.4.6_A1_T8.js`                                                                                   |
| `test`               | (in above) | `call[0] expected type externref`                                           | `RegExp/prototype/test/S15.10.6.3_A8.js`                                                                                       |
| `test`               | (in above) | `array.get: Array type N has packed…` / `array.set[2] expected type i32`    | `TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js`, `Uint8Array/prototype/toBase64/results.js`      |
| `__closure_2/4/7/20` | ~8         | `call[1] expected type f64` / `call[0] expected type (…)` / `struct.get[0]` | `Array/prototype/map/15.4.4.19-4-7.js`, `Array/prototype/filter/create-species-poisoned.js`, `Proxy/revocable/tco-fn-realm.js` |
| `__closure_5`        | 1          | `not enough arguments on the stack` (funcIdx-shift-shaped)                  | `AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`                                                 |
| `__cb_0`             | 1          | `array.set[2] expected type i32`                                            | `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions-sab.js`                                 |

(3,500-file sample → the full `built-ins` corpus + `language`/other roots scale
this ~3–4×.)

## Slices (each a separate net-positive PR)

The TypedArray packed-array surface turned out to be **several DISTINCT bugs**,
not one — triaged 2026-07-02:

- [x] **(1) TypedArray packed iterator READ (`.values()`/`.keys()`)** — DONE.
      `emitBoxedElem` (`array-methods.ts`) read a packed i8/i16 backing array with a
      plain `array.get` (validator error `Array type N has packed type i8`). Fixed
      with the established `getOp` idiom (`i8 → array.get_u`, `i16 → array.get_s`).
      Flips `TypedArray/prototype/values/make-{in,out-of}-bounds-after-exhausted.js`
      standalone invalid → valid.
- [x] **(1b) packed-element for-of / vec→tuple `encodeValType: packed`** — DONE
      (dev-2934f, slice 3). Bigger than the `.entries()` label: EVERY
      `for (const v of u)` / `of u.values()` / `of u.entries()` over a packed
      (i8/i16) typed array was a standalone emit error, plus the manual-iterator
      `it.next().value` tuple destructure. THREE distinct leak sites of one class
      ("a packed STORAGE type reached a VALUE position"):
  1. `compileForOfArray`/`compileForOfArrayEntries` (`statements/loops.ts`)
     allocated the **loop variable local** with the raw `arrDef.element`
     (i8/i16 — invalid local type) and read with plain `array.get` (invalid on
     packed arrays). Fixed: bind as `unpackedElemType` (i32), read with
     `elemGetOp` driven by **view-name signedness** (`Int*` → get_s, `Uint*` →
     get_u — the storage kind alone can't distinguish, #2648), coerce/destructure
     from the widened i32.
  2. `stack-balance.ts` type simulation pushed the raw packed element/field
     type for `array.get_s/_u`/`struct.get`; the struct.new arg-coercion repair
     then materialized it into a `$sn_tmp` **temp local** → invalid. Fixed:
     the simulator now models the widened i32 that is physically on the stack
     (`widenPackedToI32` at all 4 producer sites + defensive widen at the
     temp-local alloc).
  3. `type-coercion.ts` vec→tuple paths (`buildTupleFromExternref` runtime
     ref.test chain over ALL vec types incl. the packed i8_byte vec, and
     `emitVecToTupleBody`) used plain `array.get` + a packed `if` **blockType**.
     Fixed: `elemGetOp` (storage heuristic — no view name exists on the shared
     vec type) + widened blockType + `f64.convert_i32_s` lift before the
     f64/externref coercion arms.
     Helpers `unpackedElemType`/`elemGetOp` are now canonical in `shared.ts` (the
     acyclic sink — type-coercion.ts can't import array-methods.ts). Flips
     `language/statements/for-of/{u,}int{8,16}array{,-mutate}.js` +
     `uint8clampedarray{,-mutate}.js` (10 files) standalone CE → **pass**;
     byte-identical on host mode and standalone non-packed paths (verified by
     SHA over plain-array/string/entries for-of). Tests:
     `tests/issue-2934-packed-forof-valtype.test.ts` (12 cases incl. signedness
     semantics: Int8 −56, Uint8 200, Uint16 40000, Int16 −30000).
- [x] **(1c) `TypedArray.prototype.set` / `Uint8Array.toBase64` packed-element
      coercion** — DONE (dev-2934f, slice 5). **The DCE-remap hypothesis was
      WRONG**: instrumented `eliminateDeadImports` entry/exit — the bad
      instructions exist verbatim at DCE-entry (and `remapTypeIdxInBody` already
      carries the #1302/#2564 double-remap guards). The real mechanisms were
      three packed-element coercion gaps:
  1. `coerceType` (`type-coercion.ts`) normalized packed i8/i16 kinds ONLY for
     the numeric short-circuit pairs; every OTHER arm tests the raw
     `from.kind`/`to.kind`, so `i8 → externref` matched NO arm → lossy
     drop+null fallback (silent data loss), and `externref → i8` emitted NO
     unbox → un-coerced externref reached the packed `array.set`
     (`array.set[2] expected i32, found array.get of externref`). Fix: entry
     now rewrites the packed side(s) to the true stack kind (i32) and FALLS
     THROUGH to the real box/unbox arms. Packed elements are never
     boolean/symbol/bigint-branded, so a bare i32 is the exact rewrite.
  2. `emitVecToVecBody` (`type-coercion.ts`) read a packed source vec with a
     plain `array.get` (`Array type N has packed type i8`) — same class as
     (1)/(1b); now `elemGetOp` + widened-i32 coercion source.
  3. The `new TypedArray(arrayLike)` copy loop (`expressions/new-super.ts`)
     had an element-conversion matrix that only knew f64↔int — an externref
     (any[]) source element (`new Uint8Array([102])` where the literal
     compiled to an externref-elem vec) flowed raw into the packed
     `array.set` (the `toBase64`/`__cb_0` signature). Now unboxes (ToNumber)
     - truncates for integer storage; width truncation on packed store is
       free.
       Verified: 3/3 named repros standalone INVALID → valid (now runtime-fail
       on separate pre-existing semantics gaps — resizable-arraybuffer log
       order, toBase64 core, sab — same acceptance class as 2a); 100-file
       `TypedArray/prototype/set` + base64 sweep 78→90 VALID (+12, 0 new
       invalid; 10 residual CEs are the unrelated `__get_builtin` class);
       byte-identical on host mode and non-packed standalone paths; value
       semantics probed across all conversion directions (u8←literal,
       i8←200→−56, f64←u8, u8←i16 truncation, u8←fractional). Tests:
       `tests/issue-2934-packed-elem-coercion-1c.test.ts` (8 cases).
- [ ] **(1d) simple `for (const v of u.values())`** — demotes to the IR path
      (`ir/from-ast: unknown class`), a separate IR-adoption gap. NOTE: after (1b)
      the legacy-path fallback now compiles these shapes correctly (valid Wasm,
      right semantics), so this is a pure IR-adoption item, no longer an
      invalid-Wasm producer.
- [x] **(2a) `RegExp/test` receiver → `hasOwnProperty`/`propertyIsEnumerable`
      missing `extern.convert_any`** — DONE (dev-2934b, slice 2). `RegExp.prototype.
test.hasOwnProperty('length')` — the receiver `RegExp.prototype.test` is a
      function object, compiled to a concrete function-object struct `(ref $fn)`.
      `compilePropertyIntrospection` (`object-ops.ts`) takes the `receiverWasm.kind
=== "externref"` branch because `resolveWasmType` reports the receiver's
      _static_ (method) type as `externref` — then pushed the receiver with
      `compileExpression` but **did not coerce** the actually-emitted `(ref $fn)` to
      externref, while the key argument WAS coerced. Result: `call[0] expected type
externref, found struct.new of type (ref …)` invalid Wasm. Fix: coerce the
      receiver's _compiled_ type (`recvType.kind !== "externref"` → `coerceType`
      → `extern.convert_any`), mirroring the existing key-arg coercion. Verified
      before/after over the 90-file `.hasOwnProperty/.propertyIsEnumerable('length')`
      DontEnum-length family: **9 standalone INVALID → 0** (RegExp `test`/`exec`/
      `toString` `_A8/_A9/_A10`); the other 81 were already valid and stay valid.
      Host-mode byte-neutral (host receiver is already externref → guard skips it;
      `S15.10.6.3_A8` et al. still pass host). Standalone runtime still fails these
      on the separate `__hasOwnProperty` function-`.length`-own semantics gap — a
      distinct issue, not this slice.
- [x] **(2b) `String(x).<method>()` + `exec(...).toString()` receiver
      coercion** — DONE (dev-2934f, slice 4). Two more "static type says X,
      compiled value is Y" receiver gaps, same class as (2a):
  1. `String(42).concat(void 0)` — `number_toString` returns the native string
     EXTERNALIZED (`extern.convert_any`), so a statically-string-typed receiver
     COMPILES to externref; `compileNativeStringMethodCall`'s `emitReceiver`
     (`string-ops.ts`) fed it uncoerced to `__str_concat((ref null $AnyString),
…)` → `call[0] expected (ref null 6), found call of externref`. Fix:
     emitReceiver casts an externref result back via the established
     `emitNativeStringRefFromExternref` inverse — covers EVERY string-method
     arm (concat/charAt/indexOf/slice/…) in one place.
  2. `regObj.exec(str).toString()` — static receiver type resolves externref,
     but standalone lowers exec natively to a capture-array vec `(ref null
$Vec)`; the generic `.toString()` fallback (`expressions/calls.ts`) passed
     the raw ref to `__extern_toString(externref)` → `call[0] expected
externref, found if of (ref null 98)`. Fix: coerce the COMPILED type
     (mirrors the 2a fix). Runtime ToString-of-match-array semantics is a
     separate pre-existing gap (2a precedent) — this slice is validity.
     Verified: 120-file concat/exec/toString sweep 115→117 VALID (+2, 0 new
     invalid); byte-identical host mode + standalone literal-receiver paths.
     Tests: `tests/issue-2934-receiver-coercion-2b.test.ts`.
     **Residual (NOT this slice):** (i) `concat/S15.5.4.6_A4_T2.js` — "not enough
     arguments on the stack" (wasm-dis can't even parse: stack-arity/body-mutation
     class, belongs with slice 3); (ii) Array map/filter `create-species-*` /
     `__closure_*` `call[1] expected f64, found array.get of externref` — the
     non-closure callback path bridges through the HOST import `env.__call_1_f64`
     even in standalone (`setupArrayCallback`, `array-methods.ts:~6033`) AND
     mismatches the boxed-any (externref) element rep of `new Array(N)`; needs a
     standalone-native callback-bridge design (host-import leak + IsCallable +
     hole semantics), likely an architect spec — split to its own slice.
- [x] **(3a) object-toString string-coercion stack-arity family** — DONE
      (dev-2934f, slice 6). The `concat/S15.5.4.6_A4_T2` "not enough arguments
      on the stack" was three mechanisms:
  1. **`ensureNativeStringExternBridge` late-import over-shift**
     (`native-strings.ts`): the bridge queued its 3 late imports and baked
     their indices into helper bodies WITHOUT closing the deferred batch; the
     eventual `flushLateImportShifts` bumps every `funcIdx >= importsBefore`
     and cannot distinguish freshly-baked (final) import refs from stale
     defined-func refs — `__str_to_extern`'s `call __str_from_mem` (arity 2)
     landed on `__str_copy_tree` (arity 3). Fix: flush the batch after
     registering, BEFORE baking (gated on actual registration — pure lookups
     don't force-flush an outer batch). **This also fixes a LIVE main
     regression**: plain `console.log("ab".concat("cd"))` standalone became
     INVALID when #2473 (slice 2b) made the bridge emission reachable for
     that shape — bisected to the a3576e7 merge; the shape is invisible to
     the PR gates (test262 wrapping avoids `console_log_string`; the
     standalone floor lacks a console.log-string shape → gate blind spot,
     flagged to the lead).
  2. **`normaliseToString` no-result arm** (`type-coercion.ts`
     `tryStructToString`): a dispatched toString whose Wasm func type has NO
     result (always-throws/never, or void) pushed nothing then fed
     `$__any_to_string` (0 operands for a 1-arg call). Per §7.1.1
     OrdinaryToPrimitive that path ends in TypeError — emit the throw (stack
     goes polymorphic; dead code after an always-throwing call).
  3. **Reflective receiver ToString** (`string-ops.ts` emitReceiver):
     `String.prototype.concat.call(obj, …)` compiles the receiver to a
     concrete object struct ref; §22.1.3.x requires ToString(this) — now
     dispatched via `tryStructToString` (which handles the throwing case
     after fix 2). A4_T2 flips standalone INVALID → **pass** (it asserts the
     receiver's "intostring" throw).
     Verified: 120-file concat/exec/toString sweep 117→118 VALID, 0 new
     invalid; throwing-toString family (plus-concat/template/concat-method/
     reflective-call) all valid + right exception semantics; 71/71 string
     equivalence tests. Tests: `tests/issue-2934-tostring-dispatch-s3.test.ts`.
- [ ] **(3b) void-`return()` IteratorClose drop underflow** — DIAGNOSED
      (dev-2934f, 2026-07-02), fix verified but **deliberately HELD — see the
      PAIRING CONSTRAINT below**. Root cause: the for-of IteratorClose
      lowering (`statements/loops.ts` ~5035) emits an UNCONDITIONAL `drop`
      after `call <iter>_return`; a VOID `return() { … }` method (no Wasm
      result — common in test262 close-count probes) underflows the stack
      ("not enough arguments on the stack for drop") — this is what made
      `__closure_5` in `AsyncFromSyncIteratorPrototype/next/
for-await-next-rejected-promise-close.js` invalid (the for-await drives the
      same close path inside the lifted async closure). The one-line fix:
      guard the drop on the callee's result arity (`retFt.results.length >
0`). Verified: all validity probes green, close-count semantics correct
      (`rc === 1` after `break`), 21/21 iterator equivalence tests.
      **PAIRING CONSTRAINT (#2978)**: landing the validity fix ALONE exposes a
      runtime JS-heap OOM — the async scheduler loops forever on `for await`
      over a sync iterator yielding rejected promises (~3 GB in ~14 s, racing
      the 15 s test timeout → CI shard-worker OOM flake). Today the file
      fail-fasts as invalid Wasm, so CI is safe. **Land the drop-arity fix
      together with, or after, the #2978 scheduler fix — never alone.**

## Implementation Plan — `__closure_*` host-bridge slice (spec by dev-2934f, /architect-spec, 2026-07-02)

### Root cause

`setupArrayCallback` (`src/codegen/array-methods.ts` ~6033): when the map/
filter/forEach callback argument is NOT a recognized closure (arrow/function
expression), it bridges through the JS-HOST import `env::__call_1_f64`
(`ctx.fast ? "__call_1_i32" : "__call_1_f64"`, registered `(externref, f64) →
f64`). Two independent defects meet at that call:

1. **Host-import leak**: `env::__call_1_f64` survives into `--target
standalone` binaries (zero-import instantiation impossible).
2. **Element-rep mismatch**: `new Array(N)` standalone has BOXED-ANY
   (externref) elements (`reference_2379`); the loop feeds `array.get` →
   externref into the bridge's `f64` param → `call[1] expected type f64,
found array.get of type externref` — the `__closure_2/4/7/20` invalid-Wasm
   cluster (`Array/prototype/map/15.4.4.19-4-7.js`,
   `filter/create-species-poisoned.js`, `Proxy/revocable/tco-fn-realm.js`).

### Work Item A: compile-time IsCallable TypeError (LOW risk, do FIRST)

**Patterns addressed**: `map/15.4.4.19-4-7.js` (`arr.map(new Object())`) and
every `create-species-*` sibling where the callback is statically a
non-function object.
**Spec**: §23.1.3.18 step 3 — `If IsCallable(callbackfn) is false, throw a
TypeError` BEFORE any iteration.

**File `src/codegen/array-methods.ts`** — `setupArrayCallback` (~6033): the
file already has `isKnownNonCallable(ctx, arg)` (line ~176) and uses it at two
other call sites (215, 7583). In the `!closureInfo` arm, BEFORE resolving the
bridge: if `isKnownNonCallable(ctx, cbArg)` — extend it to cover
`new Object()` / object-literal-typed expressions (TS type has no call
signatures and is an object type) — emit the spec TypeError throw
(`emitThrowTypeError`) and return a sentinel so the caller skips the loop
emission entirely. No bridge import is registered, no loop is emitted: the
invalid-Wasm shape AND the host-import leak disappear for these tests, and the
runtime behavior is the spec throw the tests assert.

**Edge cases**: `arr.map(undefined)` / explicit-undefined (see the 7583
`isExplicitUndefined` guard precedent); a `Function`-typed identifier must NOT
be gated (stays dynamic).

**Test**: `Array/prototype/map/15.4.4.19-4-7.js` standalone invalid → pass;
`filter/create-species-poisoned.js` → valid.

### Work Item B: standalone-native dynamic callback dispatch (MEDIUM risk)

For a genuinely dynamic callback (externref at runtime — e.g. a function
value passed through `any`), standalone must not import `env::__call_1_f64`.
Replace the bridge under `ctx.standalone || ctx.wasi` with the native
dispatch the codebase already uses elsewhere (`emitReflectiveNativeProto
ClosureCall` / the #2151 any-receiver dispatch family):
`any.convert_extern` → `ref.test` each tracked closure type
(`ctx.closureInfoByTypeIdx`) → `call_ref` with the loop element coerced to
that closure's param type (via `coercionPlan`) → else-arm: spec TypeError
("not a function"). Register NO env import. JS-host mode keeps the
`__call_1_f64` fast path byte-identical.

### Work Item C: element-rep coercion at the bridge call (host mode too)

Wherever the bridge/`call_ref` consumes the loop element, coerce from the
ACTUAL element stack type (externref for boxed-any vecs, i32 for packed —
`unpackedElemType`) to the callee param type via `coercionPlan` — never assume
f64. This is the same "coerce the COMPILED type, not the static assumption"
class as slices 2a/2b.

**Ordering**: A first (small, unblocks the named tests), then B+C together
(they share the dispatch site). Hole semantics (`new Array(10)` is all holes —
map must SKIP holes, §23.1.3.18 step 5.b) should be audited in B's loop but is
NOT required for the named invalid-Wasm tests (they throw before iterating
once A lands).

**Status (dev-2934f, 2026-07-02): A DONE, C DONE, B open.**

- A: `isKnownNonCallable` extended — plain object type with no call/construct
  signatures (excluding any/unknown/unions) is statically non-callable;
  `emitCallbackTypeCheck` (already wired into all 12 callback methods) now
  fires for `arr.map(new Object())`. map/15.4.4.19-4-7 standalone invalid →
  **pass** (runner-verified TypeError at the right time).
- C: implemented as `bridgeElemConvertInstrs` (shared by
  `buildBridgeCallInstrs` + both reduce/reduceRight bridge arms): externref
  elems unbox (`__unbox_number` → ToNumber), packed i8/i16 read as widened
  i32 then convert — never assume the element is already numeric.
  filter/create-species-poisoned + map/create-species-poisoned invalid →
  valid. Sweep: 648-file map/filter/forEach dirs 632→646 VALID (+14, 0 new
  invalid); byte-identical common paths; array equivalence tests green.
  Tests: `tests/issue-2934-hostbridge-iscallable.test.ts` (5).
- Residual (NOT this class): `Proxy/revocable/tco-fn-realm.js` `__closure_20`
  `call[0] expected externref, found call_ref of f64` — a realms/Proxy
  closure-result coercion, out of standalone scope (Proxy is #1472 Phase C /
  #1355); not a callback-bridge site.

## Approach

Per the #2868/#2878 playbook: pick one repro per cluster, disassemble with
`node_modules/.bin/wasm-dis`, read the exact validator complaint, cluster by
shared construct, fix the emitter. Each slice ships independently.

## Acceptance

- Each named cluster: standalone invalid → valid module for its repros.
- 0 test262 regressions; full `merge_group` + standalone floor.
- Pure correctness (invalid binary → valid) — no host-mode path touched.
