---
id: 2193
title: "standalone: builtin .prototype / static-property value reads refuse (~83 tests) — register $NativeProto glue for Array/Object/Promise"
status: done
assignee: ttraenkler/sendev-prb
completed: 2026-06-18
sprint: Backlog
created: 2026-06-18
updated: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
language_feature: builtins, reflection
goal: standalone-mode
related: [2175, 1907, 1888]
origin: "2026-06-18 — #43 standalone failure-bucket harvest (2nd-biggest tractable bucket, ~83)"
---

# #2193 — standalone builtin `.prototype` / static-property value reads

## Problem

Reading a builtin's `.prototype` (or a static property) **as a value** refuses in
standalone:

```ts
const p = Array.prototype; // Codegen error: Array.prototype ... not supported (#1907 / #1888 S6-b)
const q = Object.prototype; // same
const f = arr[Symbol.iterator]; // Symbol.iterator built-in static property value read ...
const r = Promise.resolve; // Promise.resolve ... not supported
```

Confirmed live on current main (`Array.prototype` / `Object.prototype` both CE).

## Root cause

`property-access.ts:~2304` resolves a `<Builtin>.prototype` value read via
`tryEnsureNativeProtoBrand(ctx, builtinName)` + `emitLazyNativeProtoGet` — but
`tryEnsureNativeProtoBrand` only returns a brand for builtins whose
**`NativeProtoBuiltinGlue` is already registered** (`getNativeProtoBuiltinGlue`).
Only **RegExp** registers glue today (`ensureRegExpNativeProtoGlue`,
regexp-standalone.ts). `Array` (brand `BUILTIN_BRAND_BASE+2`) and `Object`
(`+18`) have **reserved brands but no glue**, so the read falls to
`reportUnsupportedStandaloneBuiltinValueRead`.

## Bucket (from the #43 harvest, 06-12 standalone JSONL, epics excluded)

~83 standalone failures: `Array.prototype` value read (25) + `Symbol.iterator`
read (40, many async-gen-adjacent — those stay blocked on #1373b) +
`Object.prototype` (11) + `Promise.resolve` (7). The non-async slice is the
genuinely tractable portion.

## Implementation plan

Model on `ensureRegExpNativeProtoGlue` (regexp-standalone.ts:1968) +
`emitRegExpProtoMemberBody`:

1. **`ensureArrayNativeProtoGlue(ctx)`** (new, in array-methods.ts or a new
   `array-native-proto.ts`): `getBuiltinBrand(ctx,"Array")`, build a
   `memberCsv` of `Array.prototype`'s own method names
   (`at,concat,copyWithin,…,values,@@iterator`), `memberKind` (all `method`
   except none — Array.prototype has no accessors except `@@unscopables` data),
   `memberLength` from the spec arities, and `emitMemberBody(c,fctx,member,kind)`
   that runs a brand-recovery prologue on the externref `this` (recover the
   `$ObjVec`/array backing) then **delegates to the existing native array-method
   lowering** (`compileArrayMethodCall`-equivalent body) where one exists, and
   returns `null` (graceful refusal) for not-yet-native members. Call it from
   `tryEnsureNativeProtoBrand` (add an `Array` arm beside the `RegExp` one).
2. **`ensureObjectNativeProtoGlue(ctx)`**: same shape for `Object.prototype`
   (`hasOwnProperty,isPrototypeOf,propertyIsEnumerable,toString,valueOf,
toLocaleString`). Bodies are small; `hasOwnProperty`/`toString`/`valueOf`
   already have native standalone forms to delegate to.
3. **`arr[Symbol.iterator]` value read** (computed `@@iterator` member): route
   through the same `$NativeProto` member lookup so the iterator-protocol value
   read resolves host-free. (Overlaps task #42/#18 — the iterator consumer.)
4. **`tryEnsureNativeProtoBrand`**: replace the RegExp-only special-case with a
   small dispatch table `{ RegExp: ensureRegExp…, Array: ensureArray…, Object:
ensureObject… }` so any registered builtin resolves.

**Dual-mode:** host mode is unaffected (`__get_builtin` path stays). Pure Wasm,
no new host import. Reuse existing native method lowerings — do NOT hand-roll a
parallel array/object method matrix (respect the coercion-drift gate #2108 and
the any-box gate).

## Acceptance criteria

- `const p = Array.prototype` / `Object.prototype` compile + read a stable
  `$NativeProto` externref standalone (reference identity:
  `Array.prototype === Array.prototype`).
- `Array.prototype.slice` / `arr[Symbol.iterator]` as values resolve to a
  closure (callable where the member body is native; graceful refusal otherwise).
- The standalone `built-ins/Array/prototype/*` + `Object/prototype/*` value-read
  failures drop; RegExp proto reflection (#2175) stays green.
- No host-import leak; tsc + prettier + coercion + any-box gates clean.

## Notes

This is a sizable multi-method registration (Array.prototype alone has ~30
members). Recommend slicing: PR-A `Array.prototype` value read + `@@iterator`

- the 4–6 already-native methods; PR-B `Object.prototype`; PR-C the remaining
  Array methods. The harvest ranked this the 2nd-biggest tractable bucket (#43).

## PR-A (2026-06-18, sdev-proxy3) — the proto OBJECT value reads

**Landed (this PR).** `Array.prototype` AND `Object.prototype` value reads now
resolve to a host-free `$NativeProto` object in standalone, with reference
identity, instead of the hard compile refusal. New module
`src/codegen/array-object-proto.ts` registers lightweight `NativeProtoBuiltinGlue`
for both (proto member-name CSV + brand name); `tryEnsureNativeProtoBrand`
(property-access.ts) gains `Array`/`Object` arms beside the existing `RegExp`
one. **Key insight:** `emitLazyNativeProtoGet` builds the `$NativeProto` struct
purely from `glue.memberCsv` + `glue.name` and NEVER calls `emitMemberBody`, so
the value-read object works immediately with just the CSV; per-member native
closure bodies are deferred to PR-C and degrade to a catchable TypeError (not a
compile refusal) meanwhile.

High-value side effect: `Object.prototype.hasOwnProperty.call(o, key)` — the
frequent `assert(Object.prototype.hasOwnProperty.call(...))` idiom (>=12 in the
harvest) — now compiles + runs (the inner `Object.prototype` read no longer
refuses).

Verified: 7/7 `tests/issue-2193-builtin-proto-value-read.test.ts`; 17/17
existing #2175 native-proto suites unchanged; coercion + any-box gates clean;
no host-import leak.

**Remaining (PR-B/PR-C, issue stays in-progress):** per-member native closure
bodies for Array/Object.prototype (delegate to existing array/object-method
lowering); `arr[Symbol.iterator]` computed read; `Promise.resolve` static read.

## PR-B scoping finding (2026-06-18, sdev-json3) — needs a local-driven array-method entry first

Investigated the `emitMemberBody` wiring for Array.prototype member CLOSURES. The
crux: `emitMemberBody`'s body runs on RUNTIME values — `this` is closure-param 1
(externref), args at 2.. — but EVERY existing array-method lowering is **AST-driven**:
- `compileArrayMethodCall` (array-methods.ts:2557) takes `propAccess`/`callExpr`/
  `receiverTsType` and even synthesizes `syntheticPropAccess`/`syntheticCall` AST nodes
  internally (1910-1924) to route array-likes;
- the per-method helpers (`compileArraySlice` 4497, `compileArrayJoin` 4959, …) each
  call `compileExpression(ctx, fctx, propAccess.expression)` to materialise the receiver.

So a closure body (which has a recovered externref `this` local, not an AST receiver)
cannot delegate to these as-is. The RegExp precedent (`emitRegExpProtoMemberBody`)
works because it calls **struct-local-driven** helpers (`emitRegExpTestFromLocals`,
`emitRegExpReflectionFieldRead`) that take recovered locals — Array has NO such
local-driven variants.

**PR-B therefore needs a prerequisite refactor:** extract the body of each target
array method (after the `compileExpression(receiver)` line) into a
`compileArray<Method>FromVecLocal(ctx, fctx, vecLocal, argLocals…)` entry, then have
`emitArrayProtoMemberBody` (1) recover the `$ObjVec`/vec from the externref `this`,
(2) lower closure args 2.. into locals, (3) call the local-driven entry. This is the
"sizable / dedicated-session" work the spec flagged — it touches the hot array-method
lowering surface, so it must be floor-gated hard (the #1673 discipline) and is not a
quick slice (even a 1-method first cut needs the local-driven entry-point refactor).

Recommendation: PR-B as its own focused session — refactor ONE method (e.g. `slice`)
to a `*FromVecLocal` entry + wire `emitArrayProtoMemberBody` for it end-to-end (proves
the closure-this → local-driven bridge), floor-gate, then expand method-by-method.
Branch `issue-2193-pr-b` is set up on current main (incl PR-A #1685); claim released
for a clean-context pass.

### PR-B recovery primitive identified (2026-06-18) — the externref-this → array-vec bridge

The array-instance recovery for the closure body is `emitThisReceiverGuardConvert`
(property-access.ts:4221) + `thisReceiverGuardTargets` (4289): given an externref on
the stack, it `any.convert_extern` + chains `ref.test`/`ref.cast` over the registered
vec type idxs and runs a `thenEmit(concreteType)` arm on a hit (compiled array) or
`elseEmit()` on the host path. So `emitArrayProtoMemberBody` can:
1. `local.get` closure-param 1 (externref `this`) → `emitThisReceiverGuardConvert`
   with the registered numeric/externref vec type idxs as targets;
2. in the `thenEmit(vecType)` arm: `local.set` a vec local, lower closure args 2.. into
   i32/f64 locals, then call the new `compileArray<M>FromVecLocal(ctx, fctx, vecLocal,
   vecType.typeIdx, arrTypeIdx, argLocals…)`;
3. `elseEmit`: emitThrowTypeError (or ref.null.extern) — graceful non-array `this`.

**Full bridge design is now captured** (recovery primitive + local-driven-entry refactor
+ arg threading). The remaining work is the mechanical-but-careful build:
- refactor `compileArraySlice` (4497) → split the post-receiver body (4519-4568) into
  `compileArraySliceFromVecLocal(ctx, fctx, vecLocal, vecTypeIdx, arrTypeIdx, startLocal,
  endLocal)`; keep the AST wrapper calling it after `compileExpression(receiver)`;
- write `emitArrayProtoMemberBody` (replace the PR-A refusal) using the recovery above,
  wired for `slice` first (proving slice), graceful-refuse the rest;
- scoped standalone tests (`let m=Array.prototype.slice; m.call(a,1,3)` → correct slice);
  FLOOR-GATE HARD + WAT-diff the plain `a.slice()` call path (must be unchanged — the
  refactor is a pure extraction).

Branch issue-2193-pr-b is on current main (incl PR-A #1685) with this design committed.

### PR-B implementation progress (2026-06-18, sdev-json3) — bridge compiles + is invoked; 2 runtime gaps

Committed on branch issue-2193-pr-b (commits: extract compileArraySliceFromVecLocal,
emitArrayProtoMemberBody, slice arity-2 fix). STATUS:
- ✅ compileArraySliceFromVecLocal (AST-free entry) — proven: plain `a.slice()` path
  byte-correct (length/indexing/default-end/negative/no-args all pass standalone).
- ✅ emitArrayProtoMemberBody wired: recovers array from externref `this`
  (emitThisReceiverGuardConvert over ctx.vecTypeMap), unboxes begin/end
  (__unbox_number→i32), delegates to the *FromVecLocal core, boxes result to externref.
- ✅ slice arity fix: slice.length is 2 (was defaulting to 1 → the closure lacked the
  2nd arg param → "call[0] expected externref found i32" Wasm compile error). Added
  slice:2 to PROTO_METHOD_LENGTH. Closure body now COMPILES + RUNS (no trap).

TWO REMAINING RUNTIME GAPS (concrete):
1. **`.call` dispatch doesn't reach the proto closure.** `m.call(a,1,3)` returns 0 and
   `$t` has NO call_ref/call_indirect — so the value-materialized closure's
   Function.prototype.call path doesn't invoke __proto_method_<brand>_slice; it routes
   to an empty default. (Direct `m(a,1,3)` DOES reach the closure — proven below.) Next:
   trace how a $NativeProto member-closure value's `.call(thisArg, …args)` is dispatched
   standalone; it must funnel thisArg→param1, args→params2.. and call_ref the closure.
2. **Direct `m(a,1,3)` reaches the closure but THROWS a WebAssembly.Exception.** So the
   body is invoked but either the array-instance recovery misses (the boxed `number[]`
   `this` doesn't ref.test against the registered f64-vec, falling to the elseEmit) or a
   trap in the slice core. Next: probe which arm fires; verify the f64-vec idx is in
   ctx.vecTypeMap at closure-emit time and that the boxed array's runtime type matches.

The structural bridge (extraction + recovery wiring + arity) is DONE and the closure
compiles + is invoked. The two gaps are dispatch-routing + recovery-match — debuggable,
not architectural. Floor-gate + WAT-diff the plain a.slice() path (already byte-correct).

### PR-B gap-A root cause (sdev-proxy3, 2026-06-18) — closure type-erasure + dead-probe-wrapper renumber

Diagnosed gap A (`m.call(a,1,3)` → 0) end-to-end:

1. **Why `.call` returns 0 (not a thread-thisArg bug as framed):** a value-
   materialized `$NativeProto` member closure (`const m = Array.prototype.slice`)
   is **type-erased to `externref`** when stored in a variable (m's local wasm
   type is `externref`, not `(ref $wrap)`). So `resolveClosureInfoFromLocal`
   returns nothing, `closureInfo` is null, and the generic `.call` Case 1
   (calls.ts ~2932) drops thisArg and calls with the wrong arg slots → 0. (The
   verified-earlier "no call_ref" symptom is this: no closureInfo ⇒ no call_ref.)

2. **Recovery built (gated `JS2WASM_PRB_REFLECTIVE_CALL`):**
   `tryEmitNativeProtoReflectiveCall` (calls.ts) recovers the closure from the
   receiver's **TS symbol** — a builtin-proto method's symbol declares as a
   `MethodSignature` on the `Array`/`Object` lib interface; from `(ifaceName,
   member)` re-resolve brand+member → `ensureStandaloneNativeMethodClosure` →
   recover `closureInfo`, reshape args to `[thisArg, ...userArgs]`
   (this→param1), compile the receiver + `any.convert_extern` + `ref.cast` to
   the wrapper struct, then `call_ref`. Wired into `.call`/`.apply` before the
   legacy cases; unwraps `as`/paren casts.

3. **Remaining blocker — dead-probe-wrapper type-renumber off-by-one.** The
   `call_ref` trips `expected (ref null N) found (ref null N-1)` AFTER finalize.
   Registration is internally consistent (struct 53 / lifted func 54, self =
   ref 53). Root cause: `ensureStandaloneNativeMethodClosure` (native-proto.ts
   ~403) creates a **probe wrapper** `getOrCreateFuncRefWrapperTypes(userParams,
   [])` (empty results) only to learn the member's result type — that probe
   struct is **never emitted into live code** so it is DEAD. Dead-type
   elimination at finalize removes it and shifts every higher type index down by
   1. The value-read path survives (it returns the wrapper as externref — no
   self-type constraint), but the `call_ref` self-param constraint exposes the
   off-by-one shift between the wrapper struct and the lifted func type's self
   reference.

   **Recommended fix (PR-A-rooted):** eliminate the dead probe wrapper in
   `ensureStandaloneNativeMethodClosure` — e.g. learn the result type without
   minting a throwaway empty-results wrapper struct (probe into a scratch fctx
   whose self is the FINAL wrapper, created once), OR exclude these wrapper
   structs from the type-compaction shift, OR pin the type idx. Once the
   probe-struct is not dead/shifting, flip `JS2WASM_PRB_REFLECTIVE_CALL` on; the
   recovery + arg-threading is already shape-correct.

Default builds remain valid (helper gated off → `m.call` falls through to the
legacy path = returns 0, valid Wasm, no regression). tsc + prettier clean; PR-A
7/7 + #2175 17/17 green; plain `a.slice()` byte-correct.

### PR-B gap-A SURGICAL FIX DIRECTION (for the fresh pickup) — reserve the probe-wrapper type idx up-front

The blocker is NOT the shared type-renumber pass — do NOT trace/modify it. The
fix is localized to the **root**: `ensureStandaloneNativeMethodClosure`
(native-proto.ts ~403) mints a **dead probe wrapper struct**
(`getOrCreateFuncRefWrapperTypes(userParams, [])`, empty results) only to learn
the member's result type. That struct is never emitted into live code → DEAD →
dead-type elimination removes it and shifts higher type idxs down by 1, breaking
the reflective `.call`'s `call_ref` self-param (off-by-one vs the cast struct).

Two surgical options (either lands without touching the renumber pass):
- **(a) Don't mint the dead probe struct.** For `kind === "method"` the result
  is ALWAYS `externref` (every `emitMemberBody` method arm returns
  `{kind:"externref"}` or refuses with `null`), so skip the probe entirely and
  use `externref` directly. (Tried this in-session: it dropped the type count
  47→37 but ONE off-by-one persisted — so there is a SECOND dead wrapper or the
  getter probe also shifts. So (a) alone is insufficient; combine with (b).)
- **(b) RESERVE the wrapper struct type idx up-front** in the type-init phase so
  dead-elim cannot shift it — this is the **exact lesson in team memory
  `reference_subview_type_idx_stability`** ("a struct type whose idx must be
  stable must be RESERVED up-front, not on-demand"), same class as #2357/#47.
  Pre-register the native-proto wrapper struct types during type init (alongside
  the other eager type reservations) rather than on first reflective demand, so
  every wrapper survives compaction at a stable idx and `call_ref` self-param ==
  cast-struct idx post-renumber.

Then flip `JS2WASM_PRB_REFLECTIVE_CALL` on (the recovery + arg-threading in
`tryEmitNativeProtoReflectiveCall`, calls.ts, is already shape-correct), prove
`m.call(a,1,3) === a.slice(1,3)`, floor-gate HARD, WAT-diff the plain `a.slice()`
path byte-identical. Gap B (direct `m(a,1,3)`) rides the same closure-recovery
once the type idx is stable.

### PR-B gap-A — ACTUAL ROOT CAUSE + FIX (2026-06-18, sendev-prb) — DONE

The prior "dead probe-wrapper type-renumber" diagnosis was **wrong**. Two
disproofs, established empirically this session:
1. Removing the probe entirely (fix (a)) and reducing to a SINGLE canonical
   wrapper struct STILL produced the identical `expected (ref null N) found
   (ref null N-1)` — so the 2-level probe hierarchy was never the cause.
2. Dumping the final module before emit showed it is **internally consistent**
   (wrapper struct 47, lifted func type 48 with self-param `(ref 47)`, the
   `ref.cast`/local/`call_ref` all at the matching post-renumber indices) and
   the raw type-section bytes for the func type correctly encode self-param 47.
   The renumber pass is innocent.

**Real cause:** the reflective emitter's `call_ref` **trailing operand was the
wrapper struct, not the funcref.** `call_ref $funcType` pops `[self, ...args,
(ref $funcType)]` — the last operand must be the FUNCREF from the wrapper's
field 0, exactly like the canonical closure-call tail
(`calls-closures.ts` ~138-150: `local.get` wrapper → `struct.get` field 0 →
guarded funcref cast → null-check → `call_ref`). The draft pushed the wrapper
struct, so V8/binaryen reported `expected (ref $funcType=48) found
(ref $wrapStruct=47)` — the "off-by-one" was struct-vs-functype adjacency, not a
renumber drift.

**Fix (surgical, calls.ts only):** before `call_ref`, extract the funcref —
`struct.get structTypeIdx fieldIdx 0` + `emitGuardedFuncRefCast(funcTypeIdx)` +
`emitNullCheckThrow` — then `call_ref`. Default-on (escape hatch
`JS2WASM_DISABLE_PRB_REFLECTIVE_CALL`). `native-proto.ts` is UNCHANGED (the probe
stays — it is load-bearing: member result types VARY, e.g. RegExp.test→i32, so a
fixed `externref` assumption broke 5 #2175 RegExp closures; reverted).

**Verified:** `m.call(a,1,3) === a.slice(1,3)`, `.apply([1,3])`, thisArg
threading — `tests/issue-2193-builtin-proto-value-read.test.ts` 11/11 (7 PR-A +
4 PR-B). #2175 native-proto suites 17/17 (RegExp readers 12/12 + brands 5/5).
Plain `a.slice(1,3)` WAT **byte-identical** to the pristine tip (additive change,
no AST-path impact). tsc + prettier clean. No host-import leak.

**Gap B (direct `m(a,1,3)`) — out of scope / not a real gap.** In real JS
`Array.prototype.slice(a,1,3)` THROWS a TypeError (`this` is `undefined`), so the
"should return a slice" framing was incorrect. Our standalone does throw (an
uncatchable null-deref trap rather than a catchable TypeError) on the generic
value-closure dispatch path — and that null-deref is **pre-existing** (identical
with the reflective helper disabled), unrelated to this fix. Making direct-call a
catchable TypeError touches the generic dispatch path and is a separate low-value
follow-up; not bundled here to keep the floor-gate tight.
