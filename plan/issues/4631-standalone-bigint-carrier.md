---
id: 4631
title: "Standalone: BigInt literal/value support (env::__new_BigInt host-import refusal)"
status: ready
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
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
  - src/codegen/wrapper-proto-value-of.ts::fillWrapperValueOfDynCallArm
  - src/codegen/wrapper-proto-value-of.ts::fillBigIntWrapperValueOfResolutionArm
  - src/codegen/wrapper-proto-value-of.ts::ensureBigIntWrapperValueOfClosure
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

REMAINING HOLE for `harness/deepEqual-primitives-bigint.js`: the 0-arg
`a.valueOf()` call on an ANY receiver routes through a dispatcher that is
neither `__extern_method_call` nor the `__extern_get`+apply pair (markers in
both never fire) — locate the actual 0-arg valueOf any-receiver dispatch
(suspects: the `__call_valueOf` per-struct ToPrimitive dispatcher family or
a call-receiver-method special case) and teach it the wrapper slot. Legs
a/c/d of the test already pass; only `deepEqual(Object(1n), 1n)` fails.

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
