---
id: 6432
title: "standalone: a module that contains `eval` AND links a provider throws `Object.prototype.toString is not yet implemented` at MODULE INIT — every test262 row in the linked Temporal lane fails before any test code runs (360 of 360 measured)"
status: done
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/senior-dev-5406
created: 2026-09-12
completed: 2026-09-12
assignee: ttraenkler/senior-dev-6432
---

## Problem

Measured in #5406 S6 (2026-09-12), reduced to **six lines**:

```js
var obj = { evalScript: function (sourceText) { return eval(sourceText); } };
var n = typeof obj;
```

compiled `--target standalone`, `hostBridge: "always"`, `deferTopLevelInit: true`:

| configuration | `__module_init()` |
| --- | --- |
| no linked provider | **OK** |
| one linked standalone provider (the compiled Temporal polyfill) | **throws `TypeError: Object.prototype.toString is not yet implemented in --target standalone`** |

Nothing in that source calls `Object.prototype.toString`. The throw happens in
compiler-generated init code, and it happens **before any test statement runs**.

Reproduce (`.tmp/s6-init.mts` in the S6 worktree, which uses the runner's own
seams — `assembleOriginalHarness`, `buildImports`, `instantiateTest262Module` —
so the result is the runner's, not a probe's):

```
S6_RAW=1 JS2WASM_TEMPORAL_CACHE=<dir> npx tsx .tmp/s6-init.mts .tmp/s6-e3.js       # throws
S6_RAW=1 S6_NOLINK=1 … npx tsx .tmp/s6-init.mts .tmp/s6-e3.js                      # init OK
```

Both answers are identical on the pre-#5406 tree and on the S6 tree, so this is
**not** caused by #5406's fix and #5406 does not repair it.

## Why this is the biggest thing in the standalone Temporal lane

The test262 harness prelude that is prepended to **every** row defines
`$262.evalScript`, whose body is exactly the shape above. So every linked row's
module init throws this TypeError, the row fails, and the runner reports the
TypeError as the row's error text.

That is the real explanation of the #5383 S5 measurement:

- **352 of 360 linked rows reported this one text.** It was read as
  "`Object.prototype.toString` refuses a boundary carrier" (#5406). Re-measured
  in S6: the text is the *module-init* failure, present on rows that contain no
  assertion at all.
- **All 360 rows score 0 pass linked.** An EMPTY row (`var s6 = 1;` with
  `features: [Temporal]`) fails with the same text — measured through the real
  runner, `.tmp/s6probe-row5.js`.
- Therefore the S5 sub-bucket table (136 `assert.throws` / 124
  `assert.sameValue` / …) classifies rows by the `at L<n>` fragment of a
  failure that **never reached** that line. Those numbers are not a
  classification of Temporal defects.

Until this is fixed, the linked lane cannot measure anything: every row fails
identically before its first statement.

## What is already known

- It takes BOTH ingredients. `eval` alone (unlinked) is fine; a linked provider
  without `eval` in the consumer is fine (`.tmp/s6-e1.js`: the same function
  body WITHOUT the `eval(...)` fallback, linked, inits OK).
- Bisected down the real harness prelude: keeping `$262` through `createRealm`
  but dropping `evalScript` inits OK (`.tmp/s6-pB.js`); keeping `evalScript`
  and dropping everything else still throws (`.tmp/s6-pF.js`, `.tmp/s6-e2.js`,
  `.tmp/s6-e3.js`).
- The consumer imports BOTH `js2wasm:npm:@js-temporal/polyfill:…` and
  `js2wasm:runtime-eval`. Only the `js2wasm:npm:` namespace is a #5383 S2d
  boundary peer (`peerNamespaces` filters on that prefix), so the runtime-eval
  module is linked but is not a peer — a plausible place for the interaction.
- The message text is `emitThrowTypeError`'s; the call site is compiler
  generated, so the next step is to find WHICH generated body raises it (the
  candidates are the `Object.prototype.toString` glue emitters:
  `object-proto-tostring.ts` `emitObjectProtoOrRefusal` /
  `ensureObjectProtoToStringRuntimeHelper`, and `native-proto.ts`'s
  `refusalBodyFallback`). #5406's peer arm sits in the first of those and does
  NOT silence this throw, which is evidence the raising body is a different one
  (or that the receiver is a value the peer also declines).

## Acceptance criteria

1. The six-line reduction inits OK with a provider linked, host-free, as a test
   in `tests/`.
2. The runner's EMPTY Temporal row (`features: [Temporal]`, one `var`) does not
   fail.
3. Re-run #5383's S5/S6 three-family sample (120 rows each, linked) and report
   the new pass count and the new top error buckets — the first measurement of
   that lane that is about Temporal rather than about init.
4. `--target gc` and unlinked standalone bytes unchanged (byte A/B, ≥8 modules).

## Notes

- Found by #5406 S6. Artifacts in that worktree's `.tmp/`: `s6-init.mts`,
  `s6-e{1,2,3}.js`, `s6-p{A,B,D,F}.js`, `s6probe-row{3,4,5}.js`,
  `s6-{pd,du,zdt}-link.tsv`, `s6-table.out`.
- Related: #5383 (umbrella), #5406 (the boundary `Object.prototype.toString`
  answer, which is a real and separate fix), #5407 (link cost), #5408
  (`PlainDate.from`), #2860 (standalone gap umbrella).

## S7 root cause + fix (senior-dev, Opus 5 High, 2026-09-12)

**The refusal is `Object.prototype.toString`'s only by accident. The defect is
that a Symbol was treated as an object by `ToPrimitive`.**

### How it was found (measurement, not inference)

1. Reproduced the six-line module through the runner's own seam
   (`.tmp/s7-init.mts`, a copy of S6's `s6-init.mts`) — `init threw: TypeError:
   Object.prototype.toString is not yet implemented in --target standalone`.
   Note the S6 worktree's warm `JS2WASM_TEMPORAL_CACHE` no longer links against
   this tree: it produces `LinkError: … "__js2wasm_link_to_string_tag":
   function import requires a callable`, because S6 added that import to the
   consumer after that cache entry was built. A fresh cache dir is required.
2. Wrapped every provider export with a logging trampoline
   (`.tmp/s7-trace.mts`) and took `new Error().stack` INSIDE the trampoline —
   V8 renders wasm frames there, so the boundary call that runs deepest in the
   failing chain hands back the whole wasm stack. That is what identified the
   caller; nothing else did (the thrown value is a `WebAssembly.Exception`,
   which carries no `.stack`, and the wat's TYPE-section ordering does not
   match the binary's type index space, so static reading of `ref.test`
   operands from `result.wat` is unsound — use `wasm-dis` on the binary).
3. An env-gated one-line probe in `emitThrowJsError` appending
   `[emitted in <fctx.name>]` to the message named the emitting body:
   `__proto_method_-1073741806_toString` — the `Object.prototype.toString`
   GLUE, i.e. someone *called* the method, rather than the classifier refusing.

### The chain

```
__protoidx_companion                          (native-prototype seeding)
 → __nativeproto_seed_<Array>
   → __defineProperty_accessor(Array, @@species, …)      key = __box_symbol(5)
     → __obj_find
       → __to_property_key                    §7.1.1.1 ToPropertyKey
         → __to_primitive                     ← SYMBOL NOT RECOGNISED AS PRIMITIVE
           → __class_to_primitive
             → (its generic runtime walk, guarded on
                __typeof_object(v) || __typeof_function(v) — and
                __typeof_object has NO Symbol arm, so it answers "object")
               → __call_fn_method_0 → sym.toString()
                 → Object.prototype.toString glue → loud standalone refusal
```

`__to_primitive`'s §7.1.1-step-1 "already a primitive" early-out cascade tested
`i31 · $BoxedNumber · $BoxedBoolean · $AnyString · $Error` and **not `$Symbol`**,
so every Symbol fell past the `$Object` test into the class path. The same
function's `returnIfPrimitive` helper has always counted `$Symbol` as primitive
(its `includeSymbol` arm), so the two halves disagreed.

This is the **fourth instance** of the action-at-a-distance hazard the
boxed-boolean and error-struct arms in that cascade already document in prose:
the wrong answer appears only once some *other* part of the module contributes a
`__class_to_primitive` body. Here the trigger pair was `eval` (forces the full
realm seed at init, via `__native_globalThis_ensure` → `__protoidx_companion`)
plus a linked provider (the state in which the in-flight seeding made
`sym.toString` resolve to the `Object.prototype` glue instead of being absent).
Neither is the cause; both are amplifiers.

### The fix

One arm, `src/codegen/object-runtime.ts` (`ensureObjectRuntime`'s `__to_primitive`
builder): add `ref.test $Symbol → return input` to the early-out cascade, gated
on `symbolKeysEnabled`. 34 lines, 30 of them the rationale.

### Acceptance criteria

1. **MET.** `.tmp/s6-e3.js` (the six-line reduction) with a linked provider:
   `init OK`, raw and through `assembleOriginalHarness`.
2. **MET.** `.tmp/s6probe-row5.js` (the EMPTY `features: [Temporal]` row):
   `init OK`.
3. **MET** — see the table in #5383's "S7 findings".
4. **PARTLY MET, honestly.** `--target gc`: **12 of 12 modules byte-identical.**
   Unlinked standalone: **7 of 12 identical, 5 changed** — every module that
   registers the native symbol carrier gains the ~9-instruction early-out. That
   is a real byte delta and it cannot be avoided while fixing the defect in the
   shared standalone object runtime. It is behaviour-preserving in the modules
   measured (a Symbol previously survived `__class_to_primitive` unchanged and
   was returned by `returnIfPrimitive`) and strictly faster (one `ref.test`
   instead of a dispatcher walk). Gating the arm on "a provider is linked" would
   have kept the bytes and left the latent bug; that was rejected.

### Test

`tests/issue-6432-standalone-link-symbol-key-toprimitive.test.ts`. Read its
header before trusting either arm: the host-free linked-pair arm is a SEMANTICS
GUARD that passes on the base tree too (a hand-written provider does not
reproduce — the throw needs the native-proto seeding to be mid-flight, which in
practice needs the 3.3 MB Temporal compile). The arm with teeth is structural:
the `$Symbol` carrier — read back from `__box_symbol`'s own `struct.new`, so it
cannot drift with type numbering — must appear among `__to_primitive`'s
early-out `ref.test` operands. Measured base `-20,61,62,6,70`; fixed
`-20,61,62,6,70,73`.

### Named residual (not fixed here)

`__typeof_object(<a $Symbol>)` answers **true**. That is what let the
class-to-primitive walk send a property read at a Symbol in the first place, and
it is observable beyond ToPrimitive. The early-out now keeps Symbols away from
that walk, so the lane is unblocked, but the predicate is still wrong and
deserves its own slice.
