---
id: 2875
title: "Standalone: String.prototype.* cluster (159 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
updated: 2026-08-21
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2885]
umbrella: 2860
# Slice A (#2875, 2026-07-18): +21 native-strings.ts (box-struct ensure comment
# + addUnionImports call) and +10 array-object-proto.ts (trim flatten + guard).
# Slice B (#2875, 2026-08-21) — fnctor-receiver ToString. Three arms of ONE
# defect ("a plain-function-constructor instance never consults its own
# toString"), each in the module that owns the step it belongs to:
#   * native-strings.ts (+110): the §7.1.17 OrdinaryToPrimitive terminal in
#     `__any_to_string` — the arm that decides what an unrenderable object
#     stringifies to. Half of it is the guarded box-recovery ladder for the
#     reduced primitive (string / boxed number / i31 / boxed boolean), which
#     cannot reuse `stringifyBoxedExtern` without a builder-level cycle.
#   * object-runtime.ts (+25): the MISSING `$BoxedBoolean` primitive early-out
#     in `__to_primitive`, sibling to the number and string ones already there.
#     Load-bearing, not cosmetic — without it, emitting a `__call_toString`
#     dispatcher at all makes `String.prototype.trim.call(true)` answer
#     "[object Object]" (measured: 2 pass→fail before this arm was added).
# Slice B follow-up (#2875, 2026-08-21) — class-to-primitive.ts, the SHARED
# source of the three "action-at-a-distance" carriers Slice B patched one at a
# time. `__class_to_primitive`'s STRING-hint arm answered the inherited-
# Object.prototype.toString string "[object Object]" whenever `__call_toString`
# reported "absent" — but "absent" also describes every value that is not a
# user object at all, and EVERY non-`$Object`/non-`$Vec` value reaches the
# driver (`undefined`, `$AnyValue` boxes, `$PropEntry` slot values, RegExp
# match arrays). So one harness object literal with a `toString` field was
# enough to flip that module's `__class_to_primitive` from its "return the
# input unchanged" stub to the full body, and every unrelated carrier in the
# file started rendering "[object Object]". The absent-toString branch now
# falls through to the driver's shared return-unchanged tail; both callers
# already re-render a real object as "[object Object]" themselves. The
# `$BoxedBoolean` / `$Error` early-outs added above stay (valid §7.1.1 step-1
# primitive early-outs, and a per-site cost saving).
# Slice D (#2875, 2026-08-21) — sub-cluster b2, the TRANSFERRED builtin-proto
# method call (`o.charAt = String.prototype.charAt; o.charAt(1)`). The arm
# itself is a NEW module (src/codegen/expressions/transferred-native-proto-call.ts,
# ~155 lines, no budget entry). What lands in the two god-files is only the
# seam: calls.ts +14 (widen `emitReflectiveNativeProtoClosureCall`'s arg source
# to `{arguments}` so a synthesized `[thisArg, …args]` list can be passed, plus
# the extracted+exported `nativeProtoBrandForInterface` the two spellings now
# share) and calls-closures.ts +8 (a two-line call to the new module at the top
# of `compileCallablePropertyCall`, which is also the +7 in that function).
# Neither is new subsystem logic in the barrel.
# Wave-4 lane F slice F1 (2026-08-21): +5 property-access-dispatch.ts — the
# irreducible dispatch wiring for the new `string-primitive-constructor.ts`
# module (one import line, one comment, two call lines, one blank). The whole
# body lives in the new module; nothing else was added to the driver.
# Wave-4 lane F slice F5 (2026-08-21): +5 eval-inline.ts — one `emitUndefined`
# call replacing a `ref.null.extern`, plus the five-line comment recording the
# measurement that justifies it. No new function; the arm already existed.
loc-budget-allow:
  - src/codegen/native-strings.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/calls-closures.ts
# Slice B, same three arms. Each addition is a NEW leaf arm inside an existing
# dispatch ladder (a terminal `else`, one `ref.test` early-out, one `entry.mode`
# branch); splitting the host function is a separate refactor from #3399's list,
# not something this behaviour fix can carry.
func-budget-allow:
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
  - src/codegen/native-strings.ts::ensureAnyToStringHelper
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::emitToPrimitiveMethodExports
  - src/codegen/index.ts::emitDispatchForMethod
  # Slice D: the two-line early-out described above. The function is on #3399's
  # split list already; this change adds a dispatch hop, not a subsystem.
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

> **Blocked on #2885** (standalone descriptor-reflection core). The reflective
> descriptor reads over `String.prototype` members (sub-cluster b) share the
> builtin-proto intrinsic-accessor defect specced there; land #2885's core
> (PR1+PR2) first, then fill in the String per-builtin glue member bodies.
>
> **Unblocked machinery (#2885 + #2876, both merged):** gOPD builtin-proto
> accessor descriptor SYNTHESIS (#2885) and the brand-agnostic reflective
> `.call`/`.apply` recovery of a descriptor-retrieved getter — static data-flow
> trace of `gOPD(<Builtin>.prototype, "<getter>").get.call(R)` →
> `emitReflectiveNativeProtoClosureCall`, `calls.ts` (#2876). The remaining
> String work is the **per-cluster glue**: wire the String getter/method
> `emitMemberBody` arms (`ensureStringNativeProtoGlue`) + their proto-identity
> opt-in; the gOPD + reflective-call surfaces then apply for free.

# Standalone: String.prototype.\* failures (de-masked)

## Problem

~**159** `built-ins/String/prototype/**` (plus ~25 `built-ins/String/**`) tests
are host-pass but standalone-fail, de-masked by #2870 from the phantom
ToPrimitive signature (#2862).

## Triage needed

Likely sub-clusters: (a) `this`/argument `ToString`/`ToPrimitive` coercion of
object args in String prototype methods, (b) reflective descriptor reads over
`String.prototype` members (overlaps native-proto glue), (c) RegExp-arg methods
(`split`/`replace`/`match`) routing through `__str_flatten` (overlaps the
invalid-Wasm #2868 carrier). Triage with
`runTest262File(file, cat, undefined, "standalone")`, group by method.

## Test plan

Per sub-cluster: standalone fail → pass, verify-first, full `merge_group` +
standalone high-water. `ctx.standalone` only.

## Reground (2026-07-02, dev-2873)

Full fresh triage of all **1223** `built-ins/String/**` files against current
`main` (`runTest262File(..., "standalone")`, host-confirmed): **159 → 129**
host-pass/standalone-fail (less shrinkage than #2873's 276→10). Buckets:

| n   | bucket                                                                                                      | root cause                                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 21  | RequireObjectCoercible on `this` (`this-is-null/undefined`, `not-obj-coercible`, `return-abrupt-from-this`) | **reflective** `String.prototype.X.call(null)` — closure body missing  |
| 14  | `not-a-constructor`                                                                                         | reflective `isConstructor`/`Reflect.construct(fn,[],method)`           |
| 69  | `uncaught Wasm-GC exception`                                                                                | #2862 ToPrimitive substrate + `eval` + `new String` wrapper reflection |
| 6   | `searchstring` IsRegExp                                                                                     | `endsWith`/`includes` RegExp-arg throw                                 |
| ~19 | misc (`fromCharCode` static read, `Symbol.iterator`, `matchAll`, …)                                         | mixed                                                                  |

**Root cause is deeper than the tests suggest — no #2873-style one-liner.** Even
the DIRECT any-receiver path is broadly broken standalone:
`(x:any="abc").charAt(1)` returns `0` (want `"b"`), `(null).charAt()` does not
throw. The reflective form `String.prototype.charAt.call(...)` falls through
`ensureStandaloneNativeMethodClosure` (native-proto.ts) because String's
`emitMemberBody` is `emitProtoMemberBodyRefusal` → returns `null`, so the whole
reflective path returns `undefined` and lands on a legacy `.call` that drops
`thisArg` and returns `0`.

**Fix = the "per-cluster glue" this issue already flags:** implement per-member
native String closure bodies — a new `emitStringProtoMemberBody(ctx, fctx,
member, kind)` doing `RequireObjectCoercible(this)` → `ToString(this)` →
delegate to the native string helper — wired into `ensureStringNativeProtoGlue`'s
`makeGlue`, mirroring `emitArrayProtoMemberBody` (Array's `slice` is the only
built body today). This lives in the funcidx/type-index-sensitive
`native-proto.ts` / `array-object-proto.ts` subsystem and carries real
`merge_group` standalone-floor regression risk — **L-sized, architect-spec /
senior-dev work**, not a plain dev slice. A scoped subset
(`charAt`/`charCodeAt`/`codePointAt`/`indexOf`/`lastIndexOf`/`includes`/
`endsWith` — the methods with simple native cores) is the natural first PR once
the closure-ABI + type-index approach is spec'd. Triage data:
`.tmp/triage-string-result.json`.

## Implementation Plan (dev-2873, 2026-07-02)

Implement per-member native reflective closure bodies for `String.prototype.*`,
mirroring `emitArrayProtoMemberBody` (the one proven in-tree template — Array's
`slice`). Scope: the RequireObjectCoercible (~21), `not-a-constructor` (~14),
IsRegExp (~6) buckets. **NOT** the 69-test #2862 ToPrimitive substrate bucket.

### Mechanism (verified on current main)

- `ensureStringNativeProtoGlue` (`array-object-proto.ts`) registers String glue
  via `makeGlue(ctx, brand, "String", STRING_PROTO_METHODS)`. Today its
  `emitMemberBody` arm returns `emitProtoMemberBodyRefusal` → **`null`**, so
  `ensureStandaloneNativeMethodClosure` (`native-proto.ts`) returns null and the
  reflective `String.prototype.X.call(...)` (`emitReflectiveNativeProtoClosureCall`,
  `calls.ts`) **falls through** to a legacy `.call` that drops `thisArg` and
  returns 0. That is why `X.call(null)` neither throws nor works.
- **Closure ABI** (from `emitArrayProtoMemberBody` + `ensureStandaloneNativeMethodClosure`):
  the lifted body's params are `param0 = self` (wrapper struct), `param1 = this`
  (externref), `param2.. = user args` (externref-boxed; over-padded). Result is
  the uniform **externref** (box native/number results).
- **RequireObjectCoercible (§22.1.3.1 step 1)** in standalone is host-free:
  `undefined` is conflated with `null` as `ref.null.extern`
  (`ensureGetUndefined`/`emitUndefined`, late-imports.ts), so the guard is simply
  `local.get 1; ref.is_null; if → throw TypeError` via the shared
  `emitBrandCheckTypeError`/`throwNativeError` helper. **No host import.**
- **ToString(this)**: `$__any_to_string(this)` (`ensureAnyToStringHelper`) →
  native `$AnyString` → `__str_flatten`. (nullish already excluded by step 1.)
- **Native cores** (registered by `ensureNativeStringHelpers`, native-strings.ts):
  `__str_charAt(flat,i32)→str`, `__str_indexOf`, `__str_includes`,
  `__str_endsWith`, etc. Integer args: `unboxArgToI32(ctx,fctx,paramIdx)`
  (array-object-proto.ts) unboxes an externref-boxed number → i32.
- **Result boxing**: string result → `extern.convert_any`; number result (i32/f64)
  → `__box_number` (per the type-coercion patterns).

### New code

1. `emitStringProtoMemberBody(ctx, fctx, member, kind)` in `array-object-proto.ts`
   (next to `emitArrayProtoMemberBody`). Per in-scope member: emit the
   RequireObjectCoercible guard, then ToString(this)+flatten into a local, then
   the member core, then box → externref; return `{kind:"externref"}`. Members
   NOT yet in scope → `emitProtoMemberBodyRefusal` (returns null → unchanged
   fall-through, zero behavior change).
2. Wire `makeGlue`'s `emitMemberBody` arm: add
   `name === "String" ? emitStringProtoMemberBody(c, fctx, member) : …`.

### Staging

- **Slice 1 (this PR): glue skeleton + index-accessor family** — `charAt`,
  `charCodeAt`, `codePointAt`, `at`. Flips their RequireObjectCoercible +
  reflective-valid-call tests.
- Slice 2: search family — `indexOf`, `lastIndexOf`, `includes`, `endsWith`,
  `startsWith` (+ IsRegExp-arg throw for the last three).
- Slice 3: `not-a-constructor` (closure IsConstructor=false / `new` throws) if it
  doesn't fall out of slices 1–2.

### Hazard checklist (guardrails)

- **Type-index discipline** (`project_type_index_shift_and_deadelim`,
  `reference_subview_type_idx_stability`): reuse the wrapper/func types
  `ensureStandaloneNativeMethodClosure` already creates via
  `getOrCreateFuncRefWrapperTypes`; register any shared helper types **late +
  once** (the `ensure*` helpers are idempotent) — never per-member, never
  up-front.
- **Funcidx repoints are NAME-BASED** (`ctx.funcMap.get(name)`), never index
  arithmetic. Delegate to helpers by name.
- **Never rebuild a helper body at finalize** (no splice —
  `reference_no_rebuild_helper_body_at_finalize`): the body is emitted once in
  `ensureStandaloneNativeMethodClosure`'s committed emission.
- **Floor safety**: change only RAISES `host_free_pass`; blast radius = tests
  that reflectively touch `String.prototype.<member>`. Before each PR: re-run the
  full 1223-file String triage **and** a ~1k-file Array/Object/Number standalone
  sweep → require zero new fails (the standalone floor gate only fires in
  `merge_group`).

## Progress log

The staging above was re-sliced during implementation (the index-accessor
family split across two PRs):

- **Slice 1 — MERGED (PR #2440):** `emitStringProtoMemberBody` glue skeleton +
  `calls.ts` String-brand enablement + `charAt`/`at`.
- **Slice 2 — in PR (this branch, dev-2875b):** the two number-returning index
  accessors `charCodeAt`/`codePointAt`. RequireObjectCoercible(this) (host-free
  `ref.is_null` throw) → ToString(this) → UTF-16 read; `charCodeAt` NaN out of
  range (§22.1.3.3), `codePointAt` undefined out of range + surrogate-pair
  combine (§22.1.3.4); f64 result boxed via `__box_number` ensured in the same
  first late-import batch as `__unbox_number` (funcidx-shift discipline). 10/10
  host-free tests pass; byte-diff neutrality re-verified after `git merge
origin/main` (12/12 unrelated programs byte-identical to main; only the two
  target reflective programs change output).
- **Slice 3 — in PR (dev-2875f, salvaged from dev-2875b's rotation):** the full
  search family — `indexOf`, `lastIndexOf` (number results, `__box_number`) and
  `includes`, `startsWith`, `endsWith` (boolean results, `__box_boolean` so the
  externref is a real JS boolean — `1 === true` is false).

  **Root cause of the predecessor's invalid-Wasm ("compile succeeds, invalid
  module"):** `ensureStandaloneNativeMethodClosure` sized the lifted func type's
  user params to the member's SPEC arity (`glue.memberLength` — `fn.length` is
  **1** for the whole search family; the optional `position` is UNCOUNTED per
  spec), so the salvaged body's `local.get 3` for the position arg pointed at
  the first DECLARED LOCAL (`unboxArgToI32`'s own i32 scratch — locals start at
  index 3 in a 3-param func) and fed `__unbox_number(externref)` an i32:
  `call[0] expected externref, found local.get of type i32`. Slices 1–2 never
  hit this because their single arg (the counted position) sits at param 2.

  **Fix (mechanism, not patch):** new optional
  `NativeProtoBuiltinGlue.memberParamSlots` — the closure sizes its user params
  to `max(memberLength, memberParamSlots)`; `.length` reads stay honest because
  they resolve via `nativeClosureMeta` (+ the #2896 meta type), which records
  the SPEC arity, never the func type. All call surfaces
  (`compileClosureCall`, `emitReflectiveNativeProtoClosureCall`) already pad
  missing args with `ref.null.extern`. Scoped to String
  (`STRING_PROTO_METHOD_PARAM_SLOTS`: the 5 search members = 2 slots); every
  other family/member returns 0 → arity-sized as before, byte-identical.

  **Also fixed (direct-path core bugs found by the family triage):** the
  `min(max(pos, 0), len)` clamps (§22.1.3.23 step 12 / §22.1.3.6 step 7 /
  §22.1.3.9 step 8) were missing from `__str_startsWith` (Infinity position
  overflowed `position + pLen` → OOB trap; negative position → OOB read),
  `__str_endsWith` (no `max(0)` — `endsWith('', -1)` false instead of true),
  `__str_lastIndexOf` (negative fromIndex skipped the position-0 check). Flips
  `startsWith/out-of-bounds-position`,
  `{starts,ends}With/return-true-if-searchstring-is-empty` on the DIRECT path.
  Byte-radius note: the string helpers emit as ONE bundle
  (`ctx.nativeStrHelpersEmitted`), so every standalone module's bytes shift —
  neutrality vs main is asserted on the HOST lane (12/12 byte-identical) +
  behaviorally via the 1223-file String sweep (base-vs-head, zero regressions).

  **Known adjacent defects (pre-existing on main, verified out of scope):**
  - Reflective number-`this`/`needle` mis-ToString: `charAt.call(42, 0)` ≠ "4",
    `indexOf.call(42, "2")` = -1 — fails identically on main for slices 1–2, so
    NOT introduced here. Clue for the follow-up: the same comparison
    `v === "4"` yields FALSE in `return v === "4" ? 1 : 0` but TRUE in an
    if-chain probe — smells like a call-site index-shift (string-constant
    global) interaction, not the closure itself.
  - `return-abrupt-from-this` (poisoned `toString`) doesn't throw through
    `$__any_to_string` — the #2862 ToPrimitive substrate adjacency.
  - Runtime IsRegExp(searchString) throw on the REFLECTIVE path is not emitted
    (matches the direct path's static-only `argIsStaticRegExp` fold); no
    test262 case exercises a runtime-only RegExp arg reaching a reflective
    call today.

- **Slice 4 — in PR (dev-2875f): the `not-a-constructor` bucket was a harness
  STUB TYPE BUG, not compiler work.** The runner replaces the test262
  `isConstructor` harness entirely (`needsIsConstructor` preamble,
  test262-runner.ts) because real `Reflect.construct` is a #1472 Phase C
  compile refusal standalone. The stub was
  `function isConstructor(f: number): number { return 0; }` — and
  `assert.sameValue(isConstructor(x), false)` compiles to a strict `===`
  where `0 === false` is (correctly!) false in the standalone lane, so every
  `*/not-a-constructor.js` failed at assert #1. (The host lane passed the same
  comparison via a lax host-eq quirk — worth its own look.) The tests' second
  assert — `new String.prototype.X()` throws TypeError — already exercises
  real compiled semantics and passes standalone. Fix: stub returns a real
  `boolean false`. Verified: all 5 String search + charAt + Array indexOf
  `not-a-constructor.js` → pass/pass both lanes; `is-a-constructor.js` stays
  fail/fail both lanes (no false conformance for constructors until real
  standalone `Reflect.construct` newTarget-validation lands — that is the
  honest Phase C follow-up, out of this cluster). Blast radius: 533
  `not-a-constructor.js` + 45 `is-a-constructor.js` + ~58 other harness users
  — standalone wins only in sampling (18 diverse files + 5 base-compared);
  full validation in `merge_group`.
  - Adjacent gap (documented, not in-bucket): `const C: any =
String.prototype.indexOf; new C()` silently does NOT throw (the direct
    member form does) — generic new-on-non-constructor-closure runtime check
    missing.
- **Slice 5 — in PR (dev-2875f): fromCharCode ToUint16 + zero-arg.** Post-#2477
  reground of the misc dirs (fromCharCode / Symbol.iterator / matchAll /
  fromCodePoint / raw): 12 hp/sf. Two compiler bugs fixed:
  - **§7.1.8 ToUint16**: the native lane coerced f64 args with a bare
    `i32.trunc_sat_f64_s`, which SATURATES before the helper's low-16 mask —
    `fromCharCode(+Infinity)` → 0xFFFF instead of +0 (S9.7_A1 #5), and any
    |x| ≥ 2³¹ lost its true modulus (`fromCharCode(2³²+65)` ≠ "A"). Fixed with
    an f64-domain floor-mod (t = trunc(x); m = t − floor(t/2¹⁶)·2¹⁶ — exact
    for all finite f64s since /2¹⁶ is an exponent shift; NaN/±∞ propagate to
    NaN → trunc_sat → the spec's +0). Flips S9.7_A1, S9.7_A2.1.
  - **Zero-arg `String.fromCharCode()` / `fromCodePoint()`**: an
    `arguments.length >= 1` gate dropped the spec-valid zero-arg form
    (§22.1.2.1/2 → "") to the generic member-call path = `__get_builtin`
    Phase-B refusal → CE. Gate removed; the family fold's empty-parts arm
    already returns the empty-string literal. Flips S15.5.3.2_A2.
  - **Remaining misc hp/sf (next sub-slices, each a separate mechanism):**
    (a) `String.hasOwnProperty("fromCharCode")` → false (static own-property
    reflection over the builtin CONSTRUCTOR object; blocks S15.5.3.2_A1 whose
    typeof + .length asserts already pass); (b) `String.prototype[Symbol.
iterator].call(null/undefined)` must throw — the @@iterator symbol-member
    ROC guard; needs TS-symbol-name → `@@<id>` sentinel normalization in the
    reflective-call resolver before the glue arm can fire (2 tests);
    (c) matchAll flags/custom-@@matchAll (route with the RegExp-arg (c)
    sub-cluster / #2868).
- **Out of scope (routed elsewhere):** the 69-test #2862 ToPrimitive substrate
  bucket; the property-attribute `compile_error` tests (S15.5.4.7_A8–A11
  et al — `delete`/for-in over builtins, a different mechanism).

## Takeover + fresh re-measure (fable-dev-3, 2026-07-18)

**Takeover:** assignee cleared from `dev-2875f` (stale since 07-02; all six
`issue-2875-slice*` branches are fully merged — 0 commits ahead of main — and
there is NO open PR). Prior slices 1–5 (charAt/at, charCodeAt/codePointAt,
indexOf/lastIndexOf, includes/startsWith/endsWith, not-a-constructor,
fromCharCode) all LANDED. Grounding on merged state; nothing to salvage.

**Fresh re-measure (process-isolated per method subdir — the in-process runner
poisons `RegExp.prototype` mid-sweep and crashes ~780 files, so a single sweep
undercounts):** the residual is now **~282 host-pass/standalone-fail** across
`built-ins/String/**`, matching the #2860 re-measure. Largest coherent buckets:

| bucket                                                                                     |  fails |
| ------------------------------------------------------------------------------------------ | -----: |
| RegExp-arg family (match 18, replace 21, split 19, replaceAll 13, search 21, matchAll ~22) |   ~114 |
| **trim family (trim 42, trimStart 11, trimEnd 11)** — mostly `wrong_value`                 | **64** |
| case family (toLowerCase 14, toUpperCase 11)                                               |     25 |
| substring 16, slice 9, normalize 9, indexOf/lastIndexOf 12, …                              |   rest |

### Slice A (THIS PR) — reflective non-string-primitive ToString + trim flatten

**Two root causes, both in the `ToString(this)` of a reflective
`String.prototype.<m>.call(<non-string primitive>)`:**

1. **`ensureAnyToStringHelper` box-struct ordering hazard (the big one).**
   `__any_to_string`'s `stringifyBoxedExtern` arm recovers a boxed primitive
   (`$__box_number_struct`/`$__box_boolean_struct`) ONLY when
   `ctx.nativeBoxNumberTypeIdx`/`nativeBoxBooleanTypeIdx` are registered — else
   it bakes the `"[object Object]"` fallback and CACHES it module-wide. When a
   **0-arg** reflective glue (the trim family) is the FIRST `__any_to_string`
   consumer, those idxs are still `-1` (unlike the char/search bodies, trim
   never calls `unboxArgToI32`, which is what pulls in the union native funcs +
   box structs). So `trim.call(false)` rendered `"[object Object]"` instead of
   `"false"`, `trim.call(123)` → `"[object Object]"`, etc. This is the SAME
   ordering hazard #3216 fixed for `number_toString`, one arm over. **Fix:**
   `ensureAnyToStringHelper` now calls `addUnionImports(ctx)` (idempotent,
   native-strings-gated) up front, so the box struct types exist before
   `stringifyBoxedExtern` captures their idxs. Fixes non-string-primitive
   ToString for EVERY reflective String method, not just trim.

2. **trim glue missing the flatten.** `emitStringTrimMemberBody` fed the raw
   `$__any_to_string` result straight into `__str_trim*`, but that helper (like
   the DIRECT path in `string-ops.ts`, which calls `emitFlatten()` first)
   expects a FLATTENED receiver. **Fix:** insert `__str_flatten` between
   `$__any_to_string` and `__str_trim*` (direct-path parity).

**Impact (process-isolated re-measure):** trim 42→13, trimStart 11→9,
trimEnd 11→9 — **~33 tests flipped**, zero regressions in the char/search
slices (charAt/charCodeAt/indexOf/includes unchanged). Boolean/number receiver
ToString now correct across all reflective String methods.

### Residual for the next slice (NOT this PR)

- **`undefined`-receiver RequireObjectCoercible** — `trim.call(undefined)` (and
  `charAt.call(undefined)`, all methods) does NOT throw: in standalone
  `undefined` is a DISTINCT sentinel externref, NOT `ref.null.extern`, so the
  glue's `ref.is_null` guard misses it (ToString(undefined) → "undefined").
  `null` receivers DO throw (they are `ref.null`). Needs an `is_undefined`
  test alongside `ref.is_null` in every String proto glue's RequireObjectCoercible
  — a separate, shared slice (also fixes the pre-existing `*.call(undefined)
throws` assertions in `issue-2875*.test.ts`, which fail on main today).
- RegExp-arg family (~114), case family (25), substring/slice/normalize.

## Slice B (LANDED, dev-std-4) — undefined-receiver RequireObjectCoercible

The `undefined`-receiver residual flagged above is now fixed for all four wired
reflective String proto member-body families. Root cause confirmed by
measurement on `origin/main`: under the #2106 `undefinedSingleton` regime
(default-on in standalone) `undefined` is a DISTINCT non-null sentinel externref,
so the glue's bare `ref.is_null` RequireObjectCoercible guard caught `null` but
MISSED `undefined` — `charAt.call(undefined)` etc. silently ToString'd it to
`"undefined"` and returned a value instead of throwing a TypeError.

**Fix** (`src/codegen/array-object-proto.ts`): a shared
`emitStringRequireObjectCoercible` helper OR-s in the canonical native
`__extern_is_undefined` predicate alongside the `ref.is_null` test, applied to
all four families (index-accessor `charAt`/`at`/`charCodeAt`/`codePointAt`;
search-numeric `indexOf`/`lastIndexOf`; search-boolean
`includes`/`startsWith`/`endsWith`; `trim`/`trimStart`/`trimEnd`). The native is
registered up front (`ensureStringRocUndefinedNative` → `ensureObjectRuntime` +
`flushLateImportShifts`) so its funcIdx is post-shift-correct at the guard site.
Host-free (native predicate, no host import). Gated on `undefinedSingletonActive`
— host lane and the non-singleton regime keep the bare `ref.is_null` (undefined
≡ `ref.null` there), so byte-identical.

**Measured impact** (standalone lane, base-vs-head diff, 0 regressions):

- **+6 test262 files** flip FAIL→PASS:
  `{charAt,charCodeAt,indexOf,lastIndexOf,trimEnd,trimStart}/this-value-not-obj-coercible.js`.
- **+3 committed vitest tests** fixed (previously RED on main):
  `charAt.call(undefined) throws`, `lastIndexOf.call(undefined,'a') throws`,
  `endsWith.call(undefined,'') throws`.
- Byte-neutral for the host lane and for standalone programs outside the
  reflective-String-closure blast radius (5/5 sample hashes identical).

Covered by `tests/issue-2875-slice-b-undefined-roc.test.ts` (20 cases: all 12
wired members throw on undefined, null-receiver + valid-receiver regression
guards). `tsc --noEmit` clean.

**Still residual (unchanged, NOT this slice):** the `at`/`codePointAt`
out-of-range `=== undefined` return-value comparison (a separate return-path
undefined-singleton mismatch), the case family (`toUpperCase`/`toLowerCase`,
un-wired), the RegExp-arg family (~114), and the #2862 ToPrimitive
object-receiver bucket.

## Slice C (LANDED, lead-es5, 2026-08-06) — borrowed `String.prototype.slice`

`emitStringProtoMemberBody` wired `substring` to a real reflective body but let
`slice` fall through to `emitProtoMemberBodyRefusal`, so
`x.slice = String.prototype.slice; x.slice(0, 1)` threw *"String.prototype.slice
is not yet implemented in --target standalone"*.

The two methods differ only in §22.1.3.22-vs-§22.1.3.24 index resolution
(`slice` resolves negative indices; `substring` swaps reversed bounds), and that
difference lives entirely inside the native helper: `__str_slice` and
`__str_substring` share the signature `(ref $NativeString, i32 start, i32 end)
-> ref $NativeString` **and** the same `0x7fffffff` absent-end sentinel — the
two direct paths in `string-ops.ts` already emit the same call sequence with
only the helper name differing. So `emitStringSubstringMemberBody` is now
parameterised on `"substring" | "slice"` and swaps the helper; nothing else
changed.

**Measured** — scoped standalone test262, `built-ins/String/prototype/slice`:
**29/38 → 33/38, +4**, no regressions in that path. Covered by
`tests/issue-2875-borrowed-string-slice.test.ts` (7 cases, including the two
that prove the helper swap actually happened: negative indices resolve from the
end, and reversed bounds give `""` rather than substring's swap; plus a
substring-unaffected guard).

Harvested from fork PR #4124's `#3978` slice, re-derived against current main.
**Most of that PR's String work is already on main** — its census claimed +29
across the case-conversion family, `indexOf`, `charCodeAt` and `substring`, and
all of those now pass on main by other routes. `slice` was the only part still
outstanding. Do not re-harvest #3978 expecting its headline number.

## Slice D (LANDED, 2026-08-21) — sub-cluster **b2**, the TRANSFERRED-slot call

The W13 decomposition's **b2** row ("glue exists but the call never reaches it")
had a second, sharper half than the ToString framing it was written under: the
two SPELLINGS of one operation disagreed. Measured on this branch's base
(`runTest262File(…, "standalone")`):

| spelling | base | spec |
| --- | --- | --- |
| `String.prototype.charAt.call(o, 1)` | `"b"` | `"b"` |
| `o.charAt = String.prototype.charAt; o.charAt(1)` | **THREW** `TypeError: Cannot access property on null or undefined` | `"b"` |

Root cause is NOT ToString and not a missing glue body — the glue runs fine
through `.call`. It is `compileCallablePropertyCall`'s funcref dispatch
(calls-closures.ts): candidates are admitted by **exact param count** against
the field's DECLARED signature (`charAt: (pos: number) => string`, one param),
while a native-proto member closure is lifted to `(self, this, …args)` — two
params here. No candidate matched, the guarded `ref.cast` produced null, and
the null funcref surfaced as that TypeError.

Widening the candidate filter was rejected: it would admit any same-arity
closure stored in a mis-typed field, trading a loud failure for a silent
mis-dispatch. Instead a new module
`src/codegen/expressions/transferred-native-proto-call.ts` resolves the SYNTAX
that put the value in the slot (`var o = { m: <Iface>.prototype.<member> }`) and
re-emits the call through `emitReflectiveNativeProtoClosureCall` — the same
emitter the `.call` spelling already uses, so the two cannot drift. It declines
(byte-identical lowering) for a non-identifier receiver, a non-literal
initializer, a slot the module ASSIGNS anywhere, an interface with no wired
glue, and a non-`method` glue kind.

**Measured** — 38-row standalone re-run of the `built-ins/String/prototype` +
`built-ins/Function/prototype` failing set, base vs head:
**+2, 0 regressions** — `charAt/S15.5.4.4_A5` and `charCodeAt/S15.5.4.5_A4`
flip FAIL→PASS. Control sweep of **204** files sampled across
`built-ins/String/prototype` + `built-ins/Object/prototype` +
`built-ins/Function/prototype`: **identical** (157 pass / 45 fail / 2
compile_error on both sides). Covered by
`tests/issue-2875-transferred-proto-method-call.test.ts` (5 cases, including the
reassigned-slot decline and an ordinary-literal-method guard).

**Pre-existing, NOT introduced here:** `tests/issue-2875-slice-b-undefined-roc.test.ts`
› `includes.call('abc','b') === true` fails on base as well (verified by
file-copy A/B on this branch).

## Slice E (LANDED, 2026-08-21) — prototype-installed `toString`, DIRECT call only

Found while sizing `slice/S15.5.4.13_A3_T4`. #4482 taught the direct
`.toString()` arm (call-receiver-method.ts) to step aside when the program
installs its own `toString` on the receiver, but
`sourceOverridesMethodOnReceiver` saw only two routes — a write on the BINDING
(`a.toString = …`) and a write on `this` inside the constructor. The third ES5
route writes to `F.prototype`, which matches neither, so a fnctor instance whose
prototype defines a real `toString` kept the static `Object.prototype.toString`
arm. Measured standalone on base (literal-JS `allowJs` lane):

| probe (`function F(v){this.value=v}`) | base | spec |
| --- | --- | --- |
| `F.prototype.gimme = fn; new F(7).gimme()` | `"G7"` | `"G7"` |
| `F.prototype.toString = fn; new F(7).toString()` | `"[object Object]"` | `"T7"` |

An ORDINARY prototype method already dispatched, so this was one name being
wrong, not a missing feature. `ctorPrototypeInstallsMethod` (member-override-scan.ts)
adds the third route.

**Measured: 0 test262 rows move, 0 regressions.** Stated plainly because the
fix is a wrong-answer repair, not a conformance lever. Controls run:
the 38-row failing set (identical), the 204-file
String/Object/Function-prototype sweep (identical), all **14** test262 files
matching `prototype.toString = function` (identical, file-copy A/B), and the
**10** prototype-touching `tests/equivalence/*` files, 160 tests (identical; the
one failure in `arguments-nested-and-loops` reproduces on base). Covered by
`tests/issue-2875-prototype-installed-tostring.test.ts`.

### Why `slice/S15.5.4.13_A3_T4` still fails — the remaining half, diagnosed

That row needs `__instance.slice(0,100) === "undefined"`, i.e. ToString of the
instance INSIDE the borrowed String glue, not a direct `.toString()` call.
Measured after slice E:

| expression | after slice E | spec |
| --- | --- | --- |
| `i.toString()` | `"undefined"` ✓ | `"undefined"` |
| `String(i)` / `"" + i` / `i.slice(0,100)` | `"[object Object]"` | `"undefined"` |

All three of the still-wrong ones reduce to `__any_to_string` → the Slice B
OrdinaryToPrimitive terminal → `__class_to_primitive` → `__call_toString`.
`emitDispatchForMethod` (index.ts) builds that dispatcher's entries from own
struct FIELDS (four modes: `standalone`, `closure`, `closure-extern`,
`closure-eqref-multi`, plus Slice B's `callable-dynamic`) and has **no
prototype-installed arm**, so a `$__fnctor_F` with no own `toString` field
produces no entry and the dispatcher answers `ref.null.extern`.

The fix is a fifth entry mode: for a `$__fnctor_F` struct whose ctor `F` has a
`F.prototype.<method> = …` write, look the method up in the per-fnctor
`__fnctor_proto_F` `$Object` and invoke it with `__apply_closure` — the same
runtime route `emitFnctorSubclassDynamicMethodCall` (calls-closures.ts) already
uses for an approved standalone fnctor's prototype method. `emitDispatchForMethod`
is already in this issue's `func-budget-allow`. Not attempted here: it is an
index.ts dispatcher change with a corpus-wide blast radius and wants its own
control sweep.

## Next slice — primitive-number and builtin-brand receivers return `null`

Found while measuring slice C; **not fixed**. Probed on main + slice C
(literal-JS `allowJs` lane, `--target standalone`), each returning a
discriminator rather than a boolean:

| receiver shape | result |
| --- | --- |
| `new Object(true).toUpperCase = String.prototype.toUpperCase` | **correct** |
| `"AB".toLowerCase()` direct | **correct** |
| `Number.prototype.toLowerCase = String.prototype.toLowerCase; NaN.toLowerCase()` | `null` |
| same, `(123).toLowerCase()` | `null` |
| same, `new Number(123).toLowerCase()` | `null` |
| `var r = new RegExp("abc"); r.toUpperCase = String.prototype.toUpperCase; r.toUpperCase()` | `null` |
| controls `String(NaN)`, `"" + NaN` | **correct** |

`null` is `emitProtoMemberBodyRefusal`'s "not wired — fall through" signal, so
these calls are **not reaching the reflective body at all**. Since a plain
`new Object(...)` receiver works, the gap is not "borrowed methods" generally —
it is member-call dispatch when the borrowed method is installed on a **builtin
prototype** (`Number.prototype`) or a **builtin-branded instance** (a RegExp
object), and/or when the receiver is a **primitive** number. That points at the
transferred-closure dispatch arms rather than at ToString.

Worth roughly **12–17 ES5-label standalone files** in the 2026-08-06 baseline:
the `Number.prototype.<caseMethod>` × `{NaN, Infinity, -Infinity}` matrix (~12),
the `new RegExp(...)` receiver family (~5), and two `eval("\"bj\"")`-produced
string cases. Verify by repro before sizing — the L6 census that produced these
counts is signature-derived.

**Out of scope for this issue** (measured 2026-08-06, `ES5` label, standalone,
`built-ins/String/prototype` = 109 failures): `split` 11 + `replace`/`match`
RegExp-gated ~16 belong to the standalone RegExp engine (#4016/#4065 — #4065
already refuted the "51-file RegExp lever inside String.prototype" framing);
`concat` (4) is variadic and needs a different closure ABI.

## Re-measure + decomposition (W13, 2026-08-06)

Full ES5-label sweep of `built-ins/String/prototype` on 2026-08-06 main, with
the in-process runner patched to attach the `js2wasm:runtime-eval` provider (the
fix that PR **#4163** lands properly, at a shared seam across all five
instantiate sites) and `TEST262_FULL_RUNTIME_EVAL=1` (the CI-comparable
interpreter tier): **630 files, 528 pass, 102 fail.** The `split` count above is
**23, not 11** — the earlier figure was taken through a runner whose
`js2wasm:runtime-eval` link error overwrote the real signatures.

**67 of the 102 are ONE idiom**: `x.m = String.prototype.m; x.m(…)` — a borrowed
`String.prototype` method on a non-String receiver. But that idiom is **three
different defects**, and the previous "Next slice" note conflated them and
under-sized the whole thing at 12–17:

| # | sub-mechanism | probe | ES5 files | owner |
| --- | --- | --- | ---: | --- |
| **b1** | receiver is a **builtin prototype** (`Number.prototype.m = …`) — the write itself is a silent no-op; nothing to dispatch to | `Number.prototype.foo = f; typeof Number.prototype.foo === "undefined"` | ~23 | **#4176 / PR #4155** (not this issue) |
| **a** | member has **no reflective glue body** → `emitProtoMemberBodyRefusal` → *"not yet implemented in --target standalone"* | `new Boolean().split = String.prototype.split; …split()` throws | ~19 (`split` 10, `concat` 3, `search` 2, `replace` 2, `match` 2) | **this issue** |
| **b2** | glue exists but **ToString of an exotic receiver** is wrong — `__any_to_string` answers `"[object Object]"` instead of the brand's `toString` | `fn.slice(0,8)` → `"[object "` (want `"function"`); `regExp.toUpperCase()` → `"[OBJECT OBJECT]"` (want `"/ABC/"`) | ~6 | this issue (or #2862) |

The remaining 35 are: RegExp-engine-gated `replace`/`match` (#4016/#4065, ~16,
do not re-litigate), `String.hasOwnProperty('prototype')` static reflection (4),
`delete String.prototype.toString` (3), and a long tail.

**The 12-file `Number.prototype.<caseMethod>` matrix named in the previous
"Next slice" is b1, i.e. #4176 / PR #4155 — it is NOT fixable inside the String
glue, and it is already implemented there.** The
`null` return that section observed is not the glue's refusal signal reaching a
String receiver; it is the *assignment never having happened*. Confirmed by the
brand-independent probe: `Object.prototype.qux = fn; ({}).qux()` is `null` too,
with no String involvement anywhere.

So the honest next slice for **this** issue is (a) — wire `split` and `concat`
reflective glue bodies, ~13 ES5 files — with (b2) as a small follow-up. That is
a genuinely ~15-file lever, not a 67-file one.

---

## Wave-4 lane F — slice F1: `<primitive string>.constructor` (2026-08-21)

**Measured before/after** (`runTest262File(…, "standalone")`, this branch's base
`284bd91a1f`, probe `test262/test/probe/f-str-ctor2.js`):

| expression | base | after | spec |
| --- | --- | --- | --- |
| `String.prototype.constructor === String` | `true` | `true` | `true` |
| `new String("abc").constructor === String` | `true` | `true` | `true` |
| `"abc".constructor === String` | **`false`** | `true` | `true` |
| `typeof "abc".constructor` (via a local) | `undefined` | `function` | `function` |
| `"abc"["constructor"] === String` | **`false`** | `true` | `true` |

The object receivers were already served by the #3006/#4223 `.constructor` arm
ladder in `tryConstructorPrototypeIdentity`; every arm there keys off a receiver
type that HAS a symbol (`String` the interface, `Object`, a TypedArray
interface). The primitive `string` type has none, so the read fell past the whole
ladder to the dynamic tail, which answers `undefined`.

**Fix**: new module `src/codegen/string-primitive-constructor.ts` — when
`ctx.oracle.typeFactOf(receiver).kind === "string"` and the property is
`constructor`, evaluate the receiver for side effects, drop it, and emit the same
`__builtin_ctor_String` carrier (`emitBuiltinConstructorIdentity`). Five lines of
dispatch wiring in `property-access-dispatch.ts` (allowances above).

**Rows flipped (4)**: `language/types/string/S8.4_A12`, `S8.4_A9_T1`,
`S8.4_A9_T2`, `S8.4_A9_T3`.

**Blast radius**: standalone-only; declines unless the oracle proves the exact
primitive `string` type (no union / `any` / wrapper object), declines on a write
or `delete` target, and declines module-wide if the module touches any
`.constructor` property (`moduleTouchesConstructorProp`) or writes to
`String.prototype` / `Object.prototype`. Control set of 63 currently-passing
neighbours (String/prototype/{charAt,indexOf,slice,split,concat,toString,valueOf,
substring,trim}, built-ins/String, built-ins/RegExp{,/prototype/exec,/prototype/test},
Array/prototype/join, language/expressions/addition, language/types/string,
language/literals/string): 63/63 pass before and after.

**Deliberate non-attempt**: the same hole exists for `number`/`boolean`
primitives (`(1).constructor === Number`). Not extended here — those rows are not
in this lane's set, and each extra primitive widens the fold's blast radius
without a measured row to justify it.

## Wave-4 lane F — slice F2: `String` static methods as own props (2026-08-21)

**Measured before/after** (standalone, probe `test262/test/probe/f-fcc.js`):

| query | base | after |
| --- | --- | --- |
| `gOPD(String, "fromCharCode")` | `{value:<fn>, w:true, e:false, c:true}` | unchanged |
| `String.hasOwnProperty("fromCharCode")` | **`false`** | `true` |
| `Object.getOwnPropertyNames(String)` | `length,name,prototype` | `length,name,prototype,fromCharCode,fromCodePoint,raw` |

`builtin-static-gopd.ts` already synthesized the descriptor for a syntactic gOPD,
but presence goes through the runtime `$Object` carrier, which
`pushBuiltinCtorOwnPropSeed` seeded with `length`/`name`/`prototype` only. A
descriptor that exists while `hasOwnProperty` denies the property is worse than
either answer alone.

**Fix**: `CTOR_STATIC_METHODS` in `builtin-ctor-own-props.ts` seeds the three
§22.1.2 String statics onto the carrier with `{w:true,e:false,c:true}`, value =
the same per-(builtin, method) singleton the descriptor and a plain
`String.fromCharCode` read yield. Seeded after `prototype` so
`getOwnPropertyNames` reports creation order.

**Rows flipped (1)**: `built-ins/String/fromCharCode/S15.5.3.2_A1`.

**Deliberately String-only**: seeding materializes one singleton closure per
listed method at carrier-init, so applying it to all of
`BUILTIN_STATIC_METHOD_ARITY` would pull ~30 closures for `Math` and ~24 for
`Object` into any module that mentions the bare identifier — the #4232 §5
cost-regression shape. Same reasoning as #4234's Number-only constants.
Widening needs its own cost measurement.

**Controls**: 63/63 (same set as F1).

### Declined in this slice, with reasons

- `S15.5.3.2_A3_T2` (`var f = String.fromCharCode; delete String.fromCharCode;
  f(65,66,66,65) === "ABBA"`) and `S15.5.3.2_A4` (`new f(...)` must throw). The
  seed does not help: measured after the change, `typeof f === "function"` and
  the value survives the delete, but **calling** it throws — `String.fromCharCode`
  has no wired native closure BODY (`f-transfer-static.js`: a call through an
  any-typed helper answers *"String.fromCharCode is not yet implemented in
  --target standalone"*, and a direct call of the transferred variable answers
  *"Cannot access property on null or undefined"*, i.e. two different unwired
  call paths, not one). `Math.abs` behaves identically; `Array.isArray` — which
  IS wired — works. So these two rows need a static-method body slice
  (`fromCharCode` from f64 char codes) plus [[Construct]] refusal on a
  builtin-fn singleton, neither of which is a property-seed change.

## Wave-4 lane F — slice F5: `eval()` with no argument returns `undefined` (2026-08-21)

**Measured** (`--target standalone`, probe `test262/test/probe/f-und.js`):

| producer | base | after | spec |
| --- | --- | --- | --- |
| `String(undefined)` | `"undefined"` | `"undefined"` | `"undefined"` |
| `String(function(){}())` (bare `return`) | `"undefined"` | `"undefined"` | `"undefined"` |
| `String(void 0)` | `"undefined"` | `"undefined"` | `"undefined"` |
| `String(eval(undefined))` | `"undefined"` | `"undefined"` | `"undefined"` |
| `String(eval())` | **`"null"`** | `"undefined"` | `"undefined"` |
| `typeof eval()` | **`"object"`** | `"undefined"` | `"undefined"` |

`emitStandaloneIndirectEvalRuntime`'s zero-argument arm pushed
`ref.null.extern`. §19.2.1.1 step 2: `eval()` passes `undefined`, which is not a
String, so PerformEval returns it unchanged — and this build DOES distinguish the
two values everywhere else, which is why only this one spelling was wrong.
(The sibling `emitStandaloneDirectEvalRuntime` already called `emitUndefined`;
the script-global direct-eval route takes the indirect emitter, so it hit the
wrong one.)

**Fix**: one `emitUndefined(ctx, fctx)` in place of the `ref.null.extern`.

**Rows flipped (1)**: `built-ins/String/S15.5.1.1_A1_T6`.

**Controls**: 137/137 — the set was widened with 17 passing `built-ins/eval` and
`language/eval-code/{direct,indirect}` rows for this slice. Three rows in that
batch fail identically before and after (`built-ins/eval/{length-non-configurable,
name,not-a-constructor}` — `eval` has no own `length`/`name` and no
[[Construct]] refusal) and are excluded.
