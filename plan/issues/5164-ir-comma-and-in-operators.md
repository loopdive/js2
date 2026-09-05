---
id: 5164
title: "IR: adopt the comma operator (value/for-incr positions) and a bounded dynamic-lane `in`"
status: done
completed: 2026-08-29
assignee: ttraenkler/opus-5164
sprint: current
created: 2026-08-28
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: adoption
area: ir
language_feature: operators
goal: ir-full-coverage
related: [4459, 4787, 3583, 3518]
origin: "2026-08-28 IR-takeover session — expr-binary-op-, / expr-binary-op-in residuals; scout probes in .tmp/ci-*.ts"
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  # 2026-08-29 — S3 adds `preregisterInOperatorSupport`, the pre-Phase-3
  # registration of `__extern_has`. It has to live beside the sibling
  # pre-registrations it mirrors (`preregisterForInSupport`,
  # `preregisterDynamicSupport`) because they share the one preparation
  # boundary where a funcidx shift is still hazard-free. Without it the `in`
  # slice depends on LEGACY's dual compile to register the import, which
  # IR-first skips — an `unknown-function-ref` HARD error, not a demote (the
  # #3143 `__extern_is_undefined` failure mode).
  - src/ir/integration.ts
# 2026-08-29 — each grant below is ONE guarded arm added to an existing large
# dispatcher, not new complexity inside it. The arm bodies were extracted to
# `selectorValuePositionComma` / `selectorDynamicLaneIn` / `lowerDynamicLaneIn`
# (measured: that halved the growth, from +37/+20/+13 to +17/+17/+10); what
# remains is the dispatch guard itself, which by construction has to live in the
# dispatcher. `dynamicUsesAreMoveOnly` and `scanExpr` are the same single edit
# counted twice — `scanExpr` is nested inside `dynamicUsesAreMoveOnly`.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExpr
  - src/ir/from-ast.ts::lowerBinary
---

# #5164 — IR adoption of the comma operator and a bounded `in`

## Problem

Measured 2026-08-28 (probes `.tmp/ci-*.ts` via
`JS2WASM_IR_SHAPE_DIAG=1 npx tsx .tmp/ir-probe.mts`):

| shape | result |
| --- | --- |
| `const c = (a, b);` value position | REJECT `expr-binary-op-,` |
| `a, b;` statement position (pure) | CLAIMS+EMITS (#4459 discard arm) |
| `a = 1, b;` statement / `(a = 1, b)` value | REJECT (`nontail-compound-or-binary-stmt` — the #4459 discard gate is pure-only, select.ts:3355 / `expr-binary-op-,`) |
| `for(...; ...; i++, j++)` | REJECT `expr-binary-op-,` (isPhase1ForUpdateExpr's non-identifier-left arm at select.ts:4429 routes to generic isPhase1Expr) |
| `"x" in o` (every receiver probed: typed object literal, variable key, numeric key on array, class instance, if-condition) | REJECT `expr-binary-op-in` |
| `a ** b` and `2.5 ** 0.5` | CLAIM+EMIT — the adoption table's "`**` rejects" note is STALE (#4787 landed it; capability.ts:114, bounded exact-numeric gate select.ts:8620-8632) |

### Gate sites (read 2026-08-28)

- `src/ir/select.ts:6642` — rejection producer: `if (!isPhase1BinaryOp(binOp)) return shapeNo(...)`, reached from the isPhase1Expr binary arm at 8766.
- `src/ir/capability.ts:194-196` — `binaryOpCapability` table lookup; CommaToken has NO row (defaults to defer); InKeyword is explicit defer at capability.ts:115 ("needs property/prototype-chain probe"); `**` is claim at :114.
- `src/ir/select.ts:4427-4429` — for-incrementor gate falls to generic isPhase1Expr for non-identifier-left.
- Downstream already prepared for `in`: `isComparisonResultOperator` at select.ts:6141 lists InKeyword as boolean-family.
- Dual-mode `in` runtime exists: `__extern_has(obj,key)->i32` (runtime.ts:12032 import; object-runtime.ts:4512 standalone native); the IR already calls it by name via `emitCall(irRuntimeFuncRef(...))` for for-in liveness (from-ast.ts:9175).
- Legacy `in` lowering: src/codegen/binary-ops-in.ts (key-first order at 504-527; comma-key special case at 278-307; grandfathered raw checker query at :176).

## Implementation Plan

**Fable lane, 2026-08-28.** Opus implements slice-by-slice.

### S1 (S) — value-position pure comma

Add a CommaToken "claim-partial" row to BINARY_OP_CAPABILITY
(capability.ts:71-117). Selector: in the isPhase1Expr binary arm (before the
:8766 tail, like the `**` arm at :8620) accept CommaToken when
`probeShape(isPhase1DiscardedExpr(expr.left)) && isPhase1Expr(expr.right)` —
deliberately inheriting the :3355 discard-mutating-operand restriction, so
`(a=1, b)` stays legacy (the same purity line #4459 drew). Builder: intercept
CommaToken in `lowerBinary` BEFORE the :11922 assertNotDeferred (the
`??`/`&&`/instanceof pattern): `lowerDiscardedExpression(expr.left, cx); return
lowerExpr(expr.right, cx, hint);` — identical semantics to legacy
binary-ops.ts:702 (evaluate-drop-evaluate); left-to-right order falls out of
lowering order. Nested commas recurse for free.

### S2 (S) — for-incrementor comma

CommaToken arm in `isPhase1ForUpdateExpr` (select.ts:4427) recursing BOTH sides
through ITSELF (each side gets the update-arm bookkeeping:
clearProjectionBinding, module-slot rules) + mirror arm in
`lowerForUpdateExpr` (from-ast.ts:9926) recursing both sides. This enables the
mutating `i++, j++` idiom via the update-arm rules, not the discard gate.
Constraint: loop-plan pattern matchers (dense-fill from-ast.ts:4453-4459,
isIncreasingStep :9456) match single ++ shapes strictly — re-check any plan
assuming "incrementor mutates exactly one binding".

### S3 (M) — `in` dynamic-lane claim-partial

Selector accepts `<key> in <recv>` ONLY when the receiver is provably
externref/dynamic-carrier (shape-only + resolver evidence, NO raw checker
queries — keeps the oracle-ratchet clean; legacy's checker use at
binary-ops-in.ts:176 is grandfathered, do NOT replicate) and the key is
Phase-1. Provably-primitive receivers (§13.10.1 TypeError arm) and
struct/vec/class receivers stay rejected pre-claim. Builder lowers KEY FIRST
then receiver (§13.10.1 steps 1-4, matching binary-ops-in.ts:504-527), boxes a
non-ref key to externref, emits `emitCall(irRuntimeFuncRef("__extern_has"))`.
Flip capability.ts:115 InKeyword to claim-partial. Keep comma-keys
(`(x,"key") in o`) OUT of the accept set (legacy special-cases them at
binary-ops-in.ts:278-307).

### S4 (XL) — DEFERRED, documented

Full static-fold parity for `in` (checker folds, #3920 presence bits,
#4222/#4491 overlay+hole index routes, #4765 escaped receivers, #2617 Proxy
slot overrides, private brand `#x in o`) is an XL surface tied to legacy-ctx
analyses. Stays deferred with the documented capability-row reason; retire
lane-by-lane later.

### Follow-up (not this issue)

Mutating comma operands in value position (`(a=1, b)`, `(i++, j)`) — the
test262 idiom `(NUMBER = Number, "MAX_VALUE") in NUMber` is exactly this shape;
needs the statement-arm assignment bookkeeping reused in value position.

## Acceptance criteria

1. Probe set re-run per slice: targeted FALLBACK lines disappear, no new
   buckets; `(a=1, b)` still rejects (assert the purity line held).
2. Emission confirmed via trackIrOutcomes (kind:emitted, irBodyEmitted:true) —
   claim alone is not evidence (the probe's `claimed=` line is always empty;
   use FALLBACK-line absence + emission).
3. Equivalence tests: value/nested/for-incr/try comma shapes (results AND
   side-effect order); `in` extern-receiver cases legacy-vs-IR equal; Proxy
   has-trap (#2617) must STAY legacy — assert selector reject.
4. `pnpm run check:ir-fallbacks -- --update-on-decrease` banks shrinkage;
   growth in any unintended bucket fails.
5. Ratchet gates chained bare before commit; new IR code checker-free
   (check:oracle-ratchet); CI merge_group is the conformance backstop (watch
   the S11.8.7 family for the `in` slice).
6. Update the stale `**` note in scripts/gen-ir-adoption.mjs (BinaryExpression
   row) + `pnpm run gen:ir-adoption` in whichever slice lands first.

## Results (measured 2026-08-29)

S1, S2 and S3 all landed. S4 stays deferred, with its reason now written into
the `InKeyword` capability row itself.

### Probe flips

Probes are `.tmp/ci-*.ts`; selector lines via
`JS2WASM_IR_SHAPE_DIAG=1 npx tsx .tmp/ir-probe.mts`, emission via a real
`compile({ trackIrOutcomes: true })`. Claim alone is never the evidence — the
probe's `claimed=` line is always empty, so a flip is "FALLBACK line gone" AND
`kind:emitted` + `irBodyEmitted:true`.

| probe | before | after |
| --- | --- | --- |
| `const c = (a, b)` | REJECT `expr-binary-op-,` | emitted |
| `(a, b, c)` + nested `(a, b)` | REJECT `expr-binary-op-,` | emitted |
| `for (…; …; i++, j++)` | REJECT `expr-binary-op-,` | emitted |
| `(a = 1, b)` | REJECT `expr-binary-op-,` | REJECT `expr-binary-op-,` (unchanged — purity line held) |
| `"x" in <any>` / `k in <any>` / `i in <any>` | REJECT (`param-type-not-resolvable`) | emitted |
| `"a" in {a:1}` / `"x" in <number>` | REJECT `expr-binary-op-in` | REJECT `expr-binary-op-in` (unchanged) |
| `"zzz" in new Proxy(…)` | REJECT | REJECT `constructor-resolution-unsupported` |
| `in`, `target: standalone` / `wasi` | REJECT | REJECT `body-shape-rejected` |

Zero post-claim demotions in every row.

### Three findings the plan could not have predicted

1. **Flipping a capability row off `defer` also opens `isPhase1BinaryOp`**
   (`binaryOpCapability(op) !== "defer"`), so the generic binary tail began
   accepting EVERY `in` — including a typed object literal and a primitive
   receiver, which then post-claim-demoted. Both new arms are therefore
   TERMINAL: they answer accept-or-`expr-binary-op-<op>` themselves and never
   fall through. (The comma arm was already terminal by construction.)
2. **S3's bounded lane was unreachable one layer above the operator.** The
   pre-claim dynamic-value flow scan (`dynamicUsesAreMoveOnly`/`scanExpr`) has
   no `in` arm, so every `any`-receiver function rejected at
   `param-type-not-resolvable` before the `in` arm ever ran. Added a
   three-line arm that admits a dynamic receiver into a concrete-result `in`.
   It changes no representation — the receiver reaches `__extern_has` as the
   dynamic carrier it already is, exactly as the #2952 for-in arm does.
3. **`__extern_has` was registered only as a side effect of LEGACY compiling
   the same function.** Under IR-first that body is skipped and the resolver
   throws `unknown-function-ref` — a HARD compile error, not a demote (the
   #3143 `__extern_is_undefined` failure mode). Added
   `preregisterInOperatorSupport`, mirroring `preregisterForInSupport`; the two
   cannot share, because for-in's host-mode liveness helper is the DIFFERENT
   `__for_in_has` import.

### Bound on S3, tightened past the plan

The plan's receiver gate alone still claimed-then-demoted the WHOLE standalone
lane: with native strings a key is `(ref $AnyString)`, which no externref
host-arg position accepts. S3 therefore also requires the host-string carrier
certificate, so standalone/WASI reject PRE-claim. Measured before/after: 2
post-claim demotions → 0.

### Validation

- `tests/issue-5164-comma-and-in.test.ts` — 17/17. Every runtime case asserts
  legacy ≡ IR ≡ the JavaScript reference for the VALUE and for the ordered
  side-effect log; `in` covers string-literal hit/miss, present-but-undefined,
  inherited (prototype-chain), variable key, `"length"` on an array, and a
  numeric key on an array receiver — 10 receiver/key shapes.
- Gates, run bare: `check:ir-fallbacks` OK (no unintended/post-claim/module
  growth) · loc + func + coercion + oracle-ratchet + dead-exports OK, also
  under `LOC_GATE_BASE=origin/main` · `gen-ir-adoption --check` OK.
- Pre-existing and NOT caused by this change (identical failures on the
  `origin/main` base, verified by revert-and-measure): 3 failing tests plus 2
  collection errors across `issue-2949-s5-2-eq`, `issue-2949-s5-3-relational`,
  `issue-3053-u2-claim-flip`, `issue-3529-dataflow-outcomes`.

### Follow-ups this work leaves open

- The mutating value-position comma (`(a = 1, b)`) is still legacy — the
  test262 `(NUMBER = Number, "MAX_VALUE") in NUMBER` idiom needs BOTH that and
  S3's comma-key fold, so neither half alone unlocks it.
- S3 consumes two certificates that are named for for-in
  (`isDynamicForInReceiver`, `forInHeadValueIsHostString`) because both ask a
  CARRIER question, not a statement-shape one. Renaming them is a pure-rename
  cleanup, deliberately not taken here to keep this PR off #2949's surface.
