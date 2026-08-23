---
id: 4631
title: "Standalone: BigInt literal/value support (env::__new_BigInt host-import refusal)"
status: done
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: low
horizon: xl
feasibility: hard
task_type: feature
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/object-runtime.ts
  - src/codegen/standalone-wrapper-instanceof.ts
  - src/codegen/wrapper-proto-value-of.ts
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/wrapper-proto-value-of.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/index.ts
  - src/codegen/declarations/param-return-inference.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/wrapper-proto-value-of.ts::fillBigIntDynValueOfArm
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
---

# #4631 — Standalone BigInt carrier

## Problem

`test/harness/deepEqual-primitives-bigint.js` (and every standalone test
touching a BigInt value) fails at module level: BigInt construction lowers
to the `env::__new_BigInt` host import, which the standalone lane refuses
(#2961 leaked-import gate). There is no Wasm-native BigInt representation.

## Scope note

This is a FEATURE slice, not a bug: dual-mode rule (CLAUDE.md
"Architecture Principles") requires a Wasm-native implementation before
the host import can remain as a fast path. i64-branded values exist for
`type i64` annotations (`from.bigint` arm in type-coercion.ts boxes via
`__box_bigint`), but arbitrary-precision semantics, mixed comparisons and
`typeof x === "bigint"` are unimplemented standalone.

## Progress (2026-08-23)

Landed: native `__new_BigInt(i64)` wrapper (object-runtime, [[PrimitiveValue]]
slot — `Object(1n)` is a real `$Object`, was null), `instanceof BigInt`
wrapper brand arm (standalone-wrapper-instanceof), a `$Symbol`-style
`__any_to_string` render is NOT yet done for bigint (String(1n) through any
still "[object Object]"), plus two valueOf arms (an `__extern_method_call`
arm and an `__extern_get` resolution closure). The typed probes all answer
correctly (typeof/===/instanceof/valueOf on typed receivers).

RESOLVED (2026-08-23, second slice): the harness test PASSES standalone.

**The dispatcher was `__dyn_valueOf`** (`src/codegen/wrapper-valueof.ts`), not
`__extern_method_call` and not an `__extern_get`+apply pair at the call site.
`tryEmitValueOfFallback` (`src/codegen/expressions/valueof-fallback.ts`)
intercepts every zero-arg `<expr>.valueOf()` property-access call under
standalone — before the generic dynamic method-call lowering — and routes it to
that one-argument native. Evidence: each of the helper's four exits was made to
return a distinct native-string sentinel under an env gate; the repro
`function anyv(v){return v} anyv(Object(1n)).valueOf()` observed `A4631_APPLY`,
i.e. arm 1 (`m = __extern_get(recv,"valueOf")` → `__apply_closure(m, recv, [])`).

Why arm 1 answered wrongly: for a Number/String/Boolean wrapper `m` is the
brand's minted `__proto_method_<brand>_valueOf` closure, which returns the
`[[PrimitiveValue]]` slot. BigInt has no minted brand closure, so `m` resolved
to the Object-brand `valueOf` (return `this`) and arm 2 — the slot read that
would have been right — is only reached when `m` is null.

Fix: `fillBigIntDynValueOfArm` (wrapper-proto-value-of.ts) prepends one arm to
`__dyn_valueOf` at finalize — `$Object` receiver ∧ no OWN `valueOf` ∧ reserved
FLAG_INTERNAL `[[PrimitiveValue]]` slot ∧ that slot's value `ref.test`s as the
native bigint carrier ⇒ return the slot value. The last conjunct is what keeps
the change inert for the other brands: a Number/String/Boolean slot fails the
test and keeps resolving through the proto walk, so a program that REPLACES
`Number.prototype.valueOf` still beats the slot.

Both earlier arms proved dead and were REMOVED: the `__extern_get` resolution
closure was actively broken (`__apply_closure` cannot invoke a finalize-minted
closure struct that is not in `closureInfoByTypeIdx`, so `w.valueOf()` came back
null — the "r:null" symptom), and disabling the `__extern_method_call` arm left
the harness category at exactly 113 pass / 3 not-pass, i.e. it fixed nothing
while out-ranking proto-resolved overrides for all brands.

Measured: harness category 112/4 → **113 pass / 3 not-pass** (the three
remaining — return-not-thenable, throwsAsync-same-realm,
wellKnownIntrinsicObjects — unchanged, they belong to #4630/#4633);
`sa-sample` 60/60 and `regr-list` 90/90 standalone; js-host sample 59/60 (the
AsyncDisposableStack failure is pre-existing).

RESIDUAL, not fixed here: strict equality on a slot-recovered bigint through the
any channel is still wrong — `anyv(Object(1n)).valueOf() === 1n` answers
`false`, and a probe that also compares `anyv(1n) === 1n` throws
`TypeError: Cannot convert value to a BigInt`. `deepEqual` does not depend on it,
so the harness leg passes regardless. Same family as the missing `String(1n)`
render below.

ORIGINAL HOLE (kept for the record) for `harness/deepEqual-primitives-bigint.js`: the 0-arg
`a.valueOf()` call on an ANY receiver routes through a dispatcher that is
neither `__extern_method_call` nor the `__extern_get`+apply pair (markers in
both never fire) — locate the actual 0-arg valueOf any-receiver dispatch
(suspects: the `__call_valueOf` per-struct ToPrimitive dispatcher family,
`declinesToOwnOrInheritedSlot`'s valueOf carve-out in
call-receiver-method.ts, or a compile-time valueOf special case) and teach
it the wrapper slot. Method: env-gated mark-trace on the CALL lowering
(mirror the compileNewExpression return-instrumentation used for #4626's
second slice) with the exact repro
`function anyv(v){return v} anyv(Object(1n)).valueOf()` — identify the
winning arm empirically before editing. Legs a/c/d of the test already
pass; only `deepEqual(Object(1n), 1n)` fails. Acceptance: the harness test
passes standalone; full category run + the 90-test Map/Set/Symbol sample
stay clean; js-host untouched.

## Implementation Plan (phased)

1. **Phase 0 — inventory**: count standalone test262 failures whose error
   signature names BigInt (baseline jsonl grep) to size the payoff before
   committing; record the number here.
2. **Phase 1 — i64-backed small-BigInt carrier**: a `$BigInt` struct
   wrapping i64 for values that fit; literals (`123n`) mint it;
   `typeof` arm answers "bigint" (mirror the #4626 `$Symbol` typeof-arm
   splice in typeof-natives-finalize.ts); `===`/`==`/relational arms
   compare by value; ToString via existing i64 formatting.
   Out-of-range literals → honest CompileError (better than silent wrap).
3. **Phase 2 — deepEqual/harness needs**: `Object.is`, `assert.sameValue`,
   deepEqual classification (`typeof value === "bigint"`) — all fall out
   of the typeof arm + comparison arms.
4. **Phase 3 (deferred)** — arbitrary precision (limb array), BigInt64Array
   element type, `BigInt(string)`.
5. **Acceptance for phase 1-2**: `harness/deepEqual-primitives-bigint.js`
   passes standalone; no js-host byte change; standalone floor unaffected.

## Permanent repro

`test262/test/harness/deepEqual-primitives-bigint.js` (standalone lane via `pnpm run test:262` / `runTest262File`).
