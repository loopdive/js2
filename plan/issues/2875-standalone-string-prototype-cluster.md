---
id: 2875
title: "Standalone: String.prototype.* cluster (159 host-pass/standalone-fail, de-masked from #2862)"
status: in-progress
assignee: ttraenkler/fable-dev-3
created: 2026-06-30
updated: 2026-07-18
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
loc-budget-allow:
  - src/codegen/native-strings.ts
  - src/codegen/array-object-proto.ts
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
