---
id: 2051
title: "short-circuited ?. produces the type's default value (0 / \"null\") instead of undefined"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: core-semantics
assignee: ttraenkler/cs-2164
related: [16, 2049, 2050, 1603]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2051 — optional-chain short-circuit fabricates `0` / `"null"` instead of `undefined`

## Problem

When an optional chain short-circuits, the value must be `undefined`. The
compiler instead pushes the lowered result type's **default value** — `f64 0`
for numeric properties, `ref.null` for reference-typed ones. Idiomatic guards
(`x === undefined`, `typeof x`, string interpolation) silently go wrong.

## Repro (verified on main)

```ts
type Obj = { f: (x: number) => number; v: number };
function getObj(b: boolean): Obj | null { if (b) return { f: (x) => x * 2, v: 9 }; return null; }
export function t4(): string { const o = getObj(false); const r = o?.v; return "" + r; }
export function t6(): string { const o = getObj(false); return typeof (o?.v); }
```

| fn | wasm | node |
|----|------|------|
| `t4` | `"0"` | `"undefined"` |
| `t6` | `"number"` | `"undefined"` |
| `"" + o?.f(1)` (null receiver, `?.()` form) | `"null"` | `"undefined"` |

## Root cause

- `src/codegen/property-access.ts:1095-1102` (`compileOptionalPropertyAccess`
  null-arm pushes `f64.const 0` / `i32.const 0` / `ref.null extern`)
- same pattern at `src/codegen/expressions/calls-optional.ts:43-48,158,168`
  (`defaultValueInstrs(resultType)`)

The optional chain's result is lowered to the property's value type (f64/i32),
which cannot represent `undefined`, so the short-circuit arm fabricates a 0.
Issue #16's original design explicitly chose null/default here — a baked-in
spec deviation, not a regression.

## Fix direction

An optional chain whose target type is primitive must widen the result to
externref (boxed value in the non-null arm, host `undefined` in the null arm),
or at minimum use NaN-boxing/`emitUndefined` consistently with how `undefined`
is represented elsewhere (`emitUndefined`, `__extern_is_undefined`). The
widening must propagate to `===`/`typeof`/ToString consumers. Needs a small
design note (architect input) on representation choice before dev work —
this changes the lowered type of every `?.` expression whose source type is
primitive.

## Acceptance criteria

- `"" + o?.v` and `typeof o?.v` match Node for nullish and non-nullish `o`
- `o?.v === undefined` is true when `o` is nullish
- No regression on non-optional property access perf paths (widening is scoped
  to optional chains)
- test262 `optional-chaining` net positive

## Dupe check

Grepped `instead of undefined`, `optional chain`, `default value` over
plan/issues/. Closest is #1603 (`const x = undefined` receivers, fixed
differently). No issue tracks the short-circuit result representation.

---

## Implementation Plan

> Verified against `origin/main` @ `c19a2e9c1` (post-#2049, post-#1377 AnyValue
> cluster). Line anchors are from that HEAD; re-grep the function names if they
> have drifted.

### Representation decision (the architecture question this issue asks)

**The whole-expression result type of any `a?.b` / `a?.[i]` / `a?.m()` chain
whose non-nullish result type is a *primitive* (number / boolean) is `externref`,
and the short-circuit (nullish-base) arm emits host `undefined` via
`emitUndefined`, never a typed zero.** The non-nullish arm boxes the produced
primitive to `externref` (`__box_number` / `__box_boolean`) so both arms of the
short-circuit `if` agree on `externref`.

Rationale — three independent facts already on main make `externref` the only
representation that round-trips `undefined`, and they already line up:

1. **The binding slot is already `externref`.** `localTypeForDeclaration`
   (`src/codegen/statements/variables.ts:100-102`) widens any
   `isNullablePrimitiveType` binding (which includes `number | undefined`, the
   static type of `o?.v`) to `externref`. So `const r = o?.v` *already* allocates
   an externref local. The defect is purely that the **value** flowing in is a
   fabricated `f64.const 0`, which the var-init coercion then boxes with
   `__box_number(0)` (`type-coercion.ts:1477-1488`) → a real JS `0`, not
   `undefined`. Producing host `undefined` directly removes the lie at the source.
2. **`=== undefined` already distinguishes externref-undefined from null.** The
   externref strict-eq arm (`src/codegen/binary-ops.ts:411-422`) routes
   `x === undefined` through `__extern_is_undefined`. A short-circuit arm that
   emits `emitUndefined` (host `__get_undefined`) satisfies it; an `f64 0` or a
   bare `ref.null.extern` does not.
3. **`typeof` and ToString already do the right thing for an externref carrying
   host undefined.** `typeof o?.v` does **not** const-fold: the static type
   `number | undefined` makes `staticTypeofForType`
   (`src/codegen/typeof-delete.ts:762-770`) return `null` (union of "number" +
   "undefined" → size 2 → dynamic), so it reaches the runtime `__typeof`
   (`typeof-delete.ts:874-895`). `__typeof(host undefined)` → `"undefined"`;
   `__typeof(__box_number(0))` → `"number"` (today's bug). Likewise
   `"" + (o?.v)`: an externref operand routes through `__extern_toString`
   (`src/codegen/string-ops.ts:143`, `311`) → JS `String(undefined)` =
   `"undefined"`; an f64 operand routes through `number_toString` → `"0"`.

So the fix is **not** a new representation — it is making the optional-chain
codegen *emit the value type the rest of the pipeline already expects for a
nullable-primitive*, instead of the property's bare value type.

#### Per-result-type-context table

| Non-nullish result type of the chain | Whole-`?.` result ValType | Null-arm emits | Non-null arm emits |
|---|---|---|---|
| `f64` (number prop/elem/return) | `externref` | `emitUndefined(ctx, fctx)` | value, then `coerceType(f64 → externref)` (`__box_number`) |
| `i32`-as-boolean (boolean prop) | `externref` | `emitUndefined(ctx, fctx)` | value, then `coerceType(i32 → externref)` (`__box_boolean`) |
| `i32`-as-`.length` (string length, `typeof`-irrelevant) | `externref` | `emitUndefined` | `f64.convert_i32_s` + `__box_number`, or keep the existing i32 path **only** if the chain result is immediately consumed numerically (see "Scope guard" below) |
| `externref` (object/string/any prop, method-call return) | `externref` (unchanged) | `emitUndefined` (replaces today's `ref.null.extern`) | value as-is (already externref) |
| `ref` / `ref_null` (struct/class prop) | `externref` (already widened at p-a.ts:1158-1160) | `emitUndefined` (replaces `ref.null.extern`) | `extern.convert_any` the struct ref → externref |
| statement-position (result dropped) | unchanged — no widening needed | n/a | n/a |

**Why not NaN-boxing / sNaN sentinel:** the f64 channel cannot be distinguished
from a *real* `NaN`-valued property (`o?.v` where `v === NaN`), and `=== undefined`
on an f64 is unconditionally `false` (`binary-ops.ts:479-482`). The externref +
host-`undefined` channel is the only one all three consumers (`===`, `typeof`,
ToString) already discriminate.

**Standalone caveat (documented, not blocking):** in `nativeStrings`/standalone
mode `ensureGetUndefined` returns `undefined` and `emitUndefined` falls back to
`ref.null.extern` (`late-imports.ts:553-571`), which is **indistinguishable from
null**. That is the *existing, pervasive* standalone limitation (every
`emitUndefined` callsite shares it), so this fix does not regress standalone — it
makes standalone `o?.v` short-circuit to `ref.null.extern` (an externref nullish),
which `ToString`-via-native and `=== null`/`== undefined` still read as nullish.
A fully faithful standalone `undefined` distinct from `null` is out of scope and
tracked by the broader `emitUndefined` standalone gap; do **not** invent a new
sentinel here.

### Composition with the #1377 AnyValue cluster (REQUIRED — read before coding)

This fix emits host `undefined` (`__get_undefined`) and boxes primitives with
`__box_number`/`__box_boolean` **at the optional-chain site only**. It is
disjoint from and must not perturb the #2058/#2059/#2063 per-operator-site tag
dispatch:

- **Do NOT touch the `externref → AnyValue` boxing in
  `type-coercion.ts:1207-1219`.** That generic boxing stays tag-5; the −788
  test262 comparator trap (`isSameValue`/`assert.sameValue` harness) is caused by
  re-tagging *there*. This issue never boxes into `AnyValue`; it boxes a *number*
  into a plain `externref` via `__box_number` (an honest boxed-number that
  `__typeof`/`__extern_toString` already handle), and emits host `undefined` via
  `__get_undefined`. Neither path goes through the AnyValue struct, so the
  comparator ABI is untouched.
- The value this fix produces is a **plain `externref`** (host undefined, or a
  `__box_number`/`__box_boolean` result), identical in shape to what
  `compileOptionalPropertyAccess` already returns today for object-typed props.
  When such an externref later reaches an `any`/AnyValue slot, it flows through
  the *unchanged* tag-5 boxing — exactly as an object-typed `o?.obj` does now.
- Because the only behavior change is "short-circuit arm emits host undefined and
  the result is widened to externref for primitive props", the test262 blast
  radius is the `optional-chaining` directory, not the comparator buckets. Re-run
  the standalone shard and confirm `isSameValue`/`sameValue` buckets do not move
  (same guard the cluster uses).

### Changes

**File: `src/codegen/property-access.ts` — `compileOptionalPropertyAccess`
(line 1145).**

Two sub-sites, both currently fabricating typed zeros:

1. **Non-reference receiver short-circuit (lines 1168-1178).** Today: `drop`,
   then `f64.const 0` / `i32.const 0` / `ref.null.extern`, `return resultType`.
   Change: if `resultType` is `f64` or `i32`, set the returned type to
   `{kind:"externref"}` and emit `emitUndefined(ctx, fctx)` instead of the typed
   zero (keep the `drop`). For an already-`externref`/`ref` `resultType`, replace
   `ref.null.extern` with `emitUndefined`.
2. **Main `ref.is_null` short-circuit (lines 1180-1313).** This is the hot path
   for the issue repro. Steps:
   - **Widen `resultType` up-front** (right after lines 1156-1160 compute it):
     if `resultType.kind === "f64"` or `resultType.kind === "i32"`, remember the
     original primitive type as `primResultType` and set
     `resultType = { kind: "externref" }`. (The `ref`/`ref_null` → `externref`
     widening at 1158-1160 already exists; extend it to primitives.)
   - **Then-arm (null path, lines 1187-1195):** replace the `f64.const 0` /
     `i32.const 0` / `ref.null.extern` ladder with a single
     `emitUndefined(ctx, fctx)` captured into `thenInstrs` (build it into a
     temporary body via the `savedBody`/`fctx.body = []` swap already used for
     `elseInstrs`, since `emitUndefined` pushes to `fctx.body` and may flush late
     imports — do **not** hand-roll the instr array).
   - **Else-arm (non-null path):** after the property is read and `elseResultType`
     is known (lines 1207-1300), the existing coercion at 1301-1304
     (`coerceType(elseResultType, resultType)`) now coerces the primitive field
     value to `externref` automatically (`__box_number`/`__box_boolean`), because
     `resultType` is now `externref`. No extra code — just verify the coercion
     fires (it will, since `elseResultType` is f64/i32 and `resultType` is
     externref → not `valTypesMatch`).
   - Return `resultType` (now `externref`).

**File: `src/codegen/expressions/calls-optional.ts` —
`compileOptionalCallExpression` (line 21).**

1. **Non-reference receiver short-circuit (lines 44-50).** Today: `drop`, then
   `defaultValueInstrs(shortType)` (sNaN f64 / 0 i32 / ref.null). Change: when
   `resultType` lowers to `f64`/`i32`, set the result to `externref` and emit
   `emitUndefined`; for ref/externref returns, emit `emitUndefined` instead of
   `defaultValueInstrs`.
2. **`ref.is_null` then-branch (line 198) — `then: defaultValueInstrs(resultType)`.**
   This is the *short-circuit* arm of the optional call (receiver was null). When
   the call's `resultType` is a primitive, widen `resultType` to `externref`
   before building the `if` (mirror p-a.ts), and make the then-branch
   `emitUndefined`. The else-branch (the actual call, lines 87-188) keeps its
   value; if the call's lowered return is `f64`/`i32`, coerce it to `externref`
   at the tail of the else body so both arms agree (reuse `coerceType`).
   - Note the existing `defaultValueInstrs(resultType)` at lines 181/188 inside
     the else-branch is a *different* concern (unresolved method / void return) —
     leave those as-is except for the final both-arms-agree coercion. A void
     optional call (`o?.log()`) keeps returning `VOID_RESULT`; do not widen those.

**File: `src/codegen/property-access.ts` — `compileElementAccess` (line 3726),
the optional `a?.[i]` short-circuit.**

This branch is added by **#2050** (`compileElementAccess` does not yet consult
`expr.questionDotToken` on main — confirmed at HEAD). #2050's spec explicitly
defers the undefined-representation to this issue. **Coordination:** whichever of
#2050 / #2051 lands second owns wiring the short-circuit arm. The required shape
is identical to `compileOptionalPropertyAccess`: tee base → `ref.is_null` →
then-arm `emitUndefined` (with `resultType` widened to externref for primitive
element types) / else-arm reads `base[i]` and coerces to externref. If #2050
lands first with a typed-zero placeholder, this issue's PR replaces that
placeholder; if #2051 lands first, #2050 must call `emitUndefined` in its new
short-circuit arm (note this in the #2050 task).

### Shared helper (recommended)

Factor the "widen a primitive optional-chain result type to externref and emit
the nullish value" into one helper so all three sites stay consistent, e.g. in
`property-access.ts` (exported) or `calls-optional.ts`:

```ts
// Returns the widened whole-chain result type. For f64/i32 results, the chain
// result becomes externref so the nullish arm can carry host `undefined`.
function optionalChainResultType(rt: ValType): ValType {
  return rt.kind === "f64" || rt.kind === "i32" ? { kind: "externref" } : rt;
}
// Emit the nullish (short-circuit) value into fctx.body for a widened chain.
function emitOptionalChainNullish(ctx, fctx, widenedRt: ValType): void {
  // widenedRt is externref for primitives and refs alike → host undefined
  emitUndefined(ctx, fctx);
}
```

The non-null arm always coerces its produced value to `widenedRt` via the
existing `coerceType`, which boxes f64/i32 and is a no-op for externref.

### Wasm IR pattern (number property, JS-host mode)

```wasm
;; o?.v  where v: number, result type widened to externref
local.tee $opt_recv        ;; receiver: ref/externref
ref.is_null
if (result externref)
  call $__get_undefined     ;; null arm → host undefined (NOT f64.const 0)
else
  local.get $opt_recv
  ref.cast $Obj
  struct.get $Obj $v        ;; f64
  call $__box_number        ;; f64 → externref (honest boxed number)
end
;; result: externref carrying either host undefined or a boxed number
```

### Edge cases

- **`(a?.b).c`** — `a?.b` short-circuits to host `undefined`; the outer `.c`
  is a *non-optional* member access on `undefined` → must throw `TypeError`
  (§13.3.9 only the inner chain short-circuits, the outer access still runs).
  The widened externref-undefined flows into `compilePropertyAccess`’s null
  check (`property-access.ts:1020-1026` / element-access null-check at
  3296-3305), which already throws on a nullish externref. Verify it does **not**
  silently return a default. (Today, with `a?.b` = f64 0, `(a?.b).c` would not
  throw — so this fix also *corrects* the throw behavior. Add a test.)
- **`a?.b ?? d`** — `??` checks nullish. `a?.b` = host `undefined` → `??` must
  yield `d`. The `??` lowering must treat the externref operand as nullish via
  `ref.is_null || __extern_is_undefined`. Grep the `??` codegen
  (`QuestionQuestionToken`) and confirm it handles an externref-undefined LHS;
  if it only checks `ref.is_null`, host `undefined` (a non-null externref) would
  wrongly take the LHS. **This is the one consumer that may need a companion
  tweak** — flag it in the PR and add a `?? ` test; if `??` already routes
  externref through `__extern_is_undefined` (as `==`/`===` do), no change needed.
- **`typeof a?.b`** — covered above: reaches runtime `__typeof`, returns
  `"undefined"` for the nullish arm. Add `t6`-style test.
- **boolean context `if (o?.flag)`** — host `undefined` is falsy; the truthiness
  lowering of an externref must use the nullish+falsy host check, not
  `i32.eqz` on a fabricated 0. Confirm the `if`-condition externref-truthiness
  path treats host undefined as false (it should, via the existing externref
  ToBoolean). Add a test: `o?.flag` nullish → falsy branch.
- **non-nullish base** — `getObj(true)?.v` must still return the real number
  (boxed). Equivalence: `"" + o?.v` = `"9"`, `typeof o?.v` = `"number"`.
- **`o?.v` where `v === 0` and base non-null** — must yield boxed `0`, and
  `o?.v === undefined` is `false`, `"" + o?.v` is `"0"`. This is the
  distinguishing case the typed-zero representation can never get right.
- **chained `a?.b?.c`** — inner `a?.b` widened to externref; outer `?.` re-tees
  that externref, `ref.is_null`/undefined-checks it, short-circuits the whole
  chain to host `undefined`. Each `?.` link is independent; the widening composes.
- **void optional call `o?.log()`** — stays `VOID_RESULT`; do not widen, do not
  box. Only widen when the call has a primitive return type that is consumed.

### Scope guard (no perf regression on non-optional paths)

- The widening fires **only inside** `compileOptionalPropertyAccess` /
  `compileOptionalCallExpression` / the optional branch of `compileElementAccess`
  (all gated on `questionDotToken`). Non-optional `o.v` / `o[i]` / `o.m()` are
  untouched — no boxing, no host call, identical f64/i32 codegen.
- Where a `.length`-style optional access feeds an immediately-numeric consumer
  and the static type is `number` (non-nullable, e.g. `s?.length` where `s` is
  `string` not `string | undefined`), the result type is plain `number` not
  `number | undefined`, so `resultType` is f64 and the widening **does not fire**
  — only genuinely-nullable optional chains widen. (Double-check `s?.length`’s
  static type: if TS gives `number` for a non-nullable receiver under
  `?.`, no widening; if it gives `number | undefined`, widening is correct.)

### Test plan

Add `tests/issue-2051.test.ts` (equivalence-style: compile + run, compare to
Node) covering — using the issue's `getObj`/`Obj` harness:

- `t4`: `const r = o?.v; "" + r` → `"undefined"` (nullish base); `"9"` (non-null).
- `t6`: `typeof (o?.v)` → `"undefined"` (nullish); `"number"` (non-null).
- `tEq`: `o?.v === undefined` → `true` (nullish); `false` (non-null).
- `tZero`: non-null base with `v: 0` → `o?.v === undefined` is `false`,
  `"" + o?.v` is `"0"` (guards against the typed-zero conflation).
- `tCall`: `"" + o?.f(1)` (null receiver) → `"undefined"`; (non-null) → `"2"`.
- `tElem` (after #2050 lands): `a?.[0]` nullish → `typeof` is `"undefined"`,
  `=== undefined` true; non-null → real element.
- `tNullish`: `o?.v ?? 42` → `42` (nullish base); real value (non-null).
- `tBool`: `o?.flag` in `if` → falsy branch when nullish.
- `tOuter`: `(o?.f)` / `(o?.v).toString()` throw `TypeError` on nullish base
  (only if Node throws — verify the §13.3.9 boundary in the test harness).
- Equivalence suite (`tests/equivalence.test.ts`) stays green — no perf path
  touched.
- test262: re-run `optional-chaining` directory; expect net-positive. Re-run the
  **standalone** shard and assert `isSameValue`/`assert.sameValue` comparator
  buckets do **not** move (the #1377 −788 guard).

### Landing note

Independent of the #2058/#2059/#2063 staged landing — this issue adds no host
import (`__get_undefined`, `__box_number`, `__box_boolean` all already exist) and
touches a disjoint code path (optional-chain sites only). It can land any time
after #2050. Coordinate only the `compileElementAccess` optional-branch ownership
with #2050 (see above).

---

## Resolution (2026-06-15, sdev5) — property access + typeof landed; call/element carried forward

**Landed in this PR:**

1. **`compileOptionalPropertyAccess`** (`property-access.ts`) — when the chain's
   whole-expression static type is a nullable primitive
   (`isNullablePrimitiveType(tsPropType)`, e.g. `number | undefined`), the result
   widens to externref; the short-circuit (null) arm emits host `undefined`
   (`emitUndefined`) and the non-null arm's existing `coerceType(elseResultType,
   resultType)` boxes the primitive (`__box_number`/`__box_boolean`). Both the
   non-reference-receiver short-circuit and the main `ref.is_null` arm updated.
2. **`staticTypeofForType`** (`typeof-delete.ts`) — unions are now resolved
   BEFORE the `resolveWasmType` collapse. `number | undefined` collapsed to f64
   and mis-folded `typeof o?.v` to the constant "number"; per §13.5.3 it is only
   statically known if every member agrees, so `number`+`undefined` (size 2) →
   dynamic → reaches runtime `__typeof` → "undefined" for the nullish arm.

Verified (default JS-host mode, `tests/issue-2051-optional-chain-undefined.test.ts`,
8 cases): nullish `o?.v === undefined`, `typeof o?.v === "undefined"`,
`"" + o?.v === "undefined"`, `o?.v ?? 5 === 5`; non-null `o?.v === 9`,
`typeof === "number"`, the `v=0` distinguishing case, and nullish boolean
`if (o?.flag)` falsy. No regression: `??` already routes externref through
`__extern_is_undefined`, `issue-2049`/typeof suites green. Per the plan this
boxes into a plain externref (not AnyValue), so the #1888 tag-5 comparator ABI is
untouched.

**Carried forward (still on #2051, status in-progress):** the optional **call**
short-circuit (`o?.f()`, `calls-optional.ts`) and optional **element** access
(`a?.[i]`, `compileOptionalElementAccess`). An initial calls-optional widening
attempt regressed the non-nullish path (the call's VOID_RESULT handling +
closure-field re-eval fallback + multiple `defaultValueInstrs` sites make the
result-type widening interact badly — `o?.f(1)===2` started trapping). Reverted
to keep this PR clean; those two arms need the same widen-to-externref +
`emitUndefined` treatment but applied with care to the call's else-branch value
coercion (the call arm must box its primitive return only when widening fires,
and VOID_RESULT calls must never widen). The standalone caveat (host `undefined`
falls back to `ref.null.extern`, indistinguishable from null) is unchanged and
out of scope, per the plan.

## Element slice — LANDED (2026-06-18, cs-2164)

**Done — optional ELEMENT access `a?.[i]`.** The element arm is the
property-access-shaped half: `compileOptionalElementAccess`
(`property-access.ts`) lowered the whole `a?.[i]` result to the element's bare
value type (f64/i32) and fabricated a typed zero in both the non-ref
short-circuit and the `ref.is_null` then-arm — so a nullish base gave
`a?.[0] === undefined` false, `typeof a?.[0]` "number", `"" + a?.[0]` "0".

**Why this slice is safe where the CALL arm is not.** The else (non-null) arm of
`compileOptionalElementAccess` ends in `compileElementAccessBody` — an
`array.get`/`struct.get`, **not** a `call`/`call_ref`. So pulling `__box_number`
in as a late import after the read does NOT desync a baked-in funcIdx (the exact
hazard the call-arm attempts hit). It is the **same** pattern the landed
property-access fix uses, applied verbatim to the element arm.

**Fix** (`compileOptionalElementAccess`): compute
`widenToUndefinedExternref = (resultType is f64/i32) && isNullablePrimitiveType(tsResultType)`;
when set, widen `resultType` to externref. The non-ref short-circuit and the
`ref.is_null` then-arm now emit host `undefined` (`emitUndefined`, via the
`fctx.body` swap so late-import flushes are safe) instead of the typed zero; the
else arm's existing `coerceType(elseResultType, resultType)` boxes the element
value (`__box_number`/`__box_boolean`) since `resultType` is now externref.
Boxes into a plain externref, NOT AnyValue — #1888 tag-5 ABI intact.

**Validation.** New `tests/issue-2051-optional-element-undefined.test.ts` (7,
JS-host): nullish `a?.[0] === undefined` / `typeof` / `"" +` / `?? 42`; the
non-null distinguishing case (element value `0` must NOT read as undefined →
`=== undefined` false, `"" +` "0"); non-null real element; string-element array
(nullish typeof "undefined", non-null "x"). The 17 #2051 / #2050
optional-element / #2049 optional-call regression cases stay green. tsc +
prettier + biome(error) + coercion-sites + any-box + stack-balance gates clean.
(The pre-existing 2-case failure in `optional-direct-closure-call.test.ts` is on
stock `main`, unrelated to this slice — verified by stashing the change.)

**Type-inference note:** the widening gate keys on `a?.[i]` having the nullable
static type `number | undefined`. A `getArr` body written as `b ? [...] : null`
narrows TS's inference of `a?.[0]` to a bare `number` in some contexts (gate
doesn't fire); the `if (b) return …; return null;` shape gives the
reliably-nullable type. This is a pre-existing static-type limit **shared by the
property-access gate** (not new to the element slice) — the broader fix is a
type-resolution improvement, out of scope here.

**Still open (the issue's `reasoning_effort: max` core):** the optional **CALL**
short-circuit (`o?.f()`, `calls-optional.ts`) — blocked by the late-import
index-shift hazard documented above; needs the pre-flush-box-helpers ordering and
is architect-spec territory. **#2051 stays in-progress** for that arm.
