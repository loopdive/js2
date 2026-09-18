---
id: 6642
title: "standalone: a BigInt value does not survive a consumer↔provider link (typeof/===/Object.is/String/arithmetic all answer as if it were not a BigInt)"
status: blocked
assignee: ttraenkler/senior-dev-s59
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-18
loc-budget-allow:
  # 2026-09-18 (S59, #6642) — `compileTypeofComparison`'s dynamic helper-call
  #   arm now routes an `any`/`unknown` non-bigint operand of BigInt strict
  #   equality through the native `__extern_strict_eq` helper instead of
  #   statically folding to a compile-time constant. The new branch (operand
  #   compilation + the dynamic-dispatch call + the re-read-funcIdx-after-
  #   compiling-the-operand fix, same root cause as the typeof-delete.ts one
  #   below) lives in `compileBinaryExpression`'s existing BigInt cascade —
  #   splitting it into a new file was rejected: the cascade already threads
  #   ~8 shared locals (`leftTsType`/`rightTsType`/`leftIsBigInt`/…) that a
  #   split would have to re-parameterize for a net negative (more code, more
  #   risk) versus the modest overage.
  # 2026-09-18 (S60, #6642) — the same file also gains the `BIGINT_I64`
  #   module constant + its rationale comment (the bigint-BRANDED i64 hint
  #   that `coerceType`'s `externref → i64` row consults to pick §7.1.13
  #   `__to_bigint` over the plain-number unbox). It is a one-line constant
  #   with a ~17-line comment explaining why a bare `{ kind: "i64" }` hint is
  #   a silent data-loss bug; the comment is the whole value of the change
  #   and belongs next to the constant, not in a new file.
  - src/codegen/binary-ops.ts
func-budget-allow:
  # 2026-09-18 (S59, #6642) — same new branch lands inside
  # `compileBinaryExpression`, and `compileTypeofComparison` (typeof-delete.ts)
  # grows for the funcIdx re-read fix (see Root Cause). Both are the single
  # function each defect's fix belongs next to; splitting either purely to
  # dodge the gate was rejected for the same reason as the LOC grant above.
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
---

## Problem

Twelve `test/built-ins/Temporal/ZonedDateTime/prototype/` rows fail under
`--target standalone` because a `BigInt` value minted by a linked standalone
Temporal PROVIDER does not survive the link to its CONSUMER:
`zdt.epochNanoseconds`, `zdt.add(...)`'s result, etc. compare/format/typeof as
if they were not BigInts at all.

Reduced (see `## Implementation Notes` below) to a single-module, link-free
repro:

```ts
const NS = Object.freeze({
  __proto__: null,
  giveBigInt() { return 217175010_123_456_789n; },
});
export function f(): number {
  return NS.giveBigInt() === 217175010123456789n ? 1 : 0; // answers 0
}
```

No link boundary is needed to reproduce this — `NS.giveBigInt()` is a
DYNAMICALLY DISPATCHED property/closure call, and that dispatch shape alone
is enough. The link only determines the TS *static type* of the far-side
value (`any`, via a `field(): any` boundary stub), which is what the second
fix below needed.

## Root Cause — FOUR independent defects found, THREE fixed, ONE identified but not fixed

**Fix 1 (landed) — stale `funcIdx` captured before a link-boundary import
shift.** `typeof-delete.ts`'s `compileTypeofExpression` and
`compileTypeofComparison` both captured the `__typeof`/`__typeof_bigint`
helper's `funcIdx` from `ctx.funcMap` BEFORE compiling the operand
expression. Compiling a cross-module link-boundary read can itself lazily
register new import functions (`standaloneLinkBoundaryPeerIndices` /
`ensureLateImport`), which SHIFTS every already-registered defined-function
index (`shiftLateImportIndices`). The captured local variable sits in a bare
TS variable, not yet inside any emitted `Instr`, so the shifter cannot find
and repair it — the stale value then baked a `call` into whatever function
had since slid into that slot. Measured: `__typeof_bigint`'s funcIdx moved
65 → 75 → 76 across two import batches in the reduction; the stale `65`
pointed at `__box_bigint` by the time the module finished compiling, and
`WebAssembly.Module()` rejected it: `call[0] expected type i32, found block
of type externref`. Fixed by re-reading `ctx.funcMap.get(helperName)`
immediately before emitting the `call`, in both functions.

**Fix 2 (landed) — BigInt-vs-`any` strict equality over-folded to a compile-
time constant.** `binary-ops.ts`'s `compileBinaryExpression` BigInt cascade:
`if (leftIsBigInt !== rightIsBigInt) { ...strict eq: compile both sides for
side effects, then answer a hardcoded false/true... }`. Correct when the
non-bigint side is PROVABLY some other type (`5n === "5"` is always false by
spec) — WRONG when that side is statically `any`/`unknown`, which is exactly
how a value read through a link boundary (or, as the link-free reduction
above shows, through ANY dynamically-dispatched call/property whose static
type collapses to `any`) is typed. The fold ran anyway, because
`isBigIntType(anyType)` is trivially false and the code never asked whether
the OTHER side could dynamically be a BigInt. Fixed by routing an
any/unknown non-bigint operand of strict `===`/`!==` through the existing
native `__extern_strict_eq` helper (`any-helpers.ts`) instead — its
`bigintArm` (`extern-eq-fast.ts`, #3173/#4173) already does the correct
`ref.test $BigInt` + `i64.eq` dynamic classification; it was simply never
reached for this operand shape before.

**Fix 3 (built, then DROPPED as unnecessary) — candidate `$BigInt`
canonical-rec-group membership.** Initial hypothesis: `$BigInt` (a
module-private WasmGC struct, minted lazily by
`addUnionImportsAsNativeFuncs`) needed to join the frozen canonical runtime
rec-group (`RUNTIME_RECGROUP_TYPE_NAMES`, #2527) for two separately-compiled
standalone modules' `$BigInt` structs to canonicalize to the same WasmGC
runtime type. Built (eager registration in `registerNativeStringTypes` +
`buildBigIntType` + an ABI version bump + a `canonicalHashOfTypeGroup` fix
for the pre-existing `i64.bigint` vs. plain-`i64` token mismatch between the
IR-side hasher and the binary-parsing verifier) — then MEASURED to be
unneeded: `tests/issue-6642-link-bigint-value.test.ts`'s canonicalization
test passes identically on the pre-fix base tree. WasmGC isorecursive type
equivalence for a size-1 rec group (one immutable i64 field, no
self-reference) needs no shared ABI registry the way the bigger String/Vec
family genuinely does (that family is mutually self-referential — ConsString
references NativeString/AnyString, HashedString subtypes NativeString — so
`planPhysicalTypeSection`'s forward-reference grouping bundles them into ONE
multi-member rec group, where position/order DOES matter for canonicalization
in a way it never does for an isolated single-field struct). Kept OUT of this
PR: unproven, and it materially grows the frozen ABI surface (every
nativeStrings module, not just standalone ones, would carry the type) for
zero measured benefit.

**Residual (NOT fixed, blocks all 12 target rows) — `coercionPlan` has no
bigint-brand column.** `NS.giveBigInt()`'s WASM-level compiled body is a
NATIVE, monomorphic `() -> i64` closure (`$__closure_2` in the reduction's
WAT dump — no boxing at all, just `i64.const …; return`). The generic
closure/property dispatch machinery (`__apply_closure`) wraps this in the
usual externref ABI at the call site, and the comparison
`NS.giveBigInt() === 217175010123456789n` compiles the call with an i64Hint
expected type. The call's naturally-compiled result is a
`(block (result externref))`, and reconciling that against the i64Hint is
left to `stack-balance.ts`'s POST-HOC `fixBranchType` pass, which infers the
produced type from the raw emitted instructions and calls `coercionPlan`
(`coercion-plan.ts`) to bridge `(externref, i64)`. `coercionPlan`'s
`externref → i64` row is a `(from.kind, to.kind)` table with **no bigint-
brand column** — measured directly in the WAT: it emits
`call $__unbox_number; i64.trunc_sat_f64_s` (the plain-NUMBER unbox path)
instead of `call $__to_bigint` (the ToBigInt/§7.1.13 path `coerceType`, the
OTHER coercion engine in `type-coercion.ts`, already has correctly for this
exact `(from, to)` pair). `__unbox_number` has no `$BigInt` classification
arm, so it falls to a default/NaN answer, `i64.trunc_sat_f64_s` turns that
into `0`, and every downstream comparison/arithmetic op on the value is
silently wrong — no crash, no diagnostic, just a wrong number.

Confirmed link-independent: `.tmp/s59/probe/samemod.mjs` and
`propcheck.mjs` (single standalone module, method call and property read
respectively, no `link`/`compileProject` involved) both reduce it.

Why not fixed in this slice: `coercionPlan` is deliberately a PURE
`(from, to, helpers)` function (coercion-plan.ts's own docstring: "the only
context the stack-balancer can supply post-hoc"), and its `CoercionHelpers`
carries exactly `{boxNumberIdx, unboxNumberIdx}`. `stack-balance.ts` resolves
those TWO indices ONCE (`findFuncByName("__box_number")` /
`findFuncByName("__unbox_number")`) and threads them as a PAIR through
~16 function signatures (`fixBranchType`, `fixBody`, `fixBranch`,
`plannedCallArgCoercionInstrs`, `callArgCoercionInstrs`, and their mutual
recursion) down to the two `coercionPlan(...)` call sites. Adding a THIRD
helper (`toBigIntIdx`, resolved via `findFuncByName("__to_bigint")`) requires
mechanically widening every one of those ~16 signatures and their call
sites — a large, purely-mechanical but unverified-in-budget change for this
slice. `type-coercion.ts`'s OWN `coercionInstrs` (a sibling pre-built-Instr[]
coercion function, used by array-method callback loops — NOT the path this
bug hits) got the equivalent bigint-aware rows added defensively in an
earlier iteration of this slice's investigation but was reverted along with
the canonical-recgroup work once it was confirmed not to be on the hit path
for this defect (kept out to minimize an unproven diff).

## S60 — the residual, fixed. The S59 diagnosis was on the wrong table.

**S59's "Next step" below is superseded. Do NOT thread `toBigIntIdx` through
`stack-balance.ts`.** Traced directly (a `console.error` stack in
`coercionPlan`'s `externref → i64` arm, compiling S59's own reduction):
`coercionPlan` is **never called** for this shape. The site that fires is
`type-coercion.ts`'s `coerceType`, reached from
`expressions.ts:1037 → compileExpressionBody → compileBinaryExpression`
(binary-ops.ts) — and `coerceType` **already has** the correct
`if (to.bigint) { … __to_bigint … }` arm S59 pointed at. It did not fire
because `to` arrived as `{"kind":"i64"}` with **no brand**. The brand was lost
before the coercion site, exactly the second-defect case the S60 brief flagged.

Two brand DROPS, one per direction of the generic externref ABI:

**Fix A — the UNBOX side: `binary-ops.ts`, the both-operands-BigInt arm.**
`const i64Hint: ValType = { kind: "i64" }` — bare. Every operand of a BigInt
operator was compiled against an UNBRANDED i64 expected type, so
`coerceType(externref → i64)` took the plain-NUMBER row
(`__unbox_number; i64.trunc_sat_f64_s`) and the comparison ran against `0`.
Fixed by hoisting a module constant `BIGINT_I64 = { kind: "i64", bigint: true }`
and using it as that hint. Measured in the WAT: `call $__unbox_number;
i64.trunc_sat_f64_s` → `call $__to_bigint`.

**Fix B — the BOX side: `closures/result-boxing.ts`,
`buildClosureResultBoxing`.** With Fix A alone the reduction went from a wrong
answer to a **thrown TypeError** — `__to_bigint` correctly refused a value that
was no longer a BigInt by the time it arrived. `NS.giveBigInt()` compiles to a
native monomorphic `() -> i64` closure; reaching it through dynamic dispatch
makes the `__call_fn_*` ABI box the result, and that arm boxed EVERY i64 as a
NUMBER: `f64.convert_i64_s; call $__box_number`. Two losses in one line —
`f64.convert_i64_s` rounds anything above 2^53 (217175010123456789n → …792),
and `__box_number` erases bigint-ness outright. The **i32 arm immediately
above it** (`boxI32ClosureResult`) already preserved the `boolean` and `symbol`
brands for precisely this reason; the i64 arm just had no brand column. Added
`boxI64ClosureResult`, which picks `__box_bigint` for a branded i64 and leaves
the unbranded (native `type i64 = number`) path byte-identical.

Neither fix touches `coercion-plan.ts` or `stack-balance.ts` — so the
number rows of the shared table, and the gc lane that shares them, are
untouched by construction.

### Witness — revert-and-measure

`tests/issue-6642-coercion-plan-bigint.test.ts` (5 cases). File-copy A/B
against `8a95c4dace` (S59's head), same command both times
(`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 npx vitest run --maxWorkers=2`):

| case | base `8a95c4dace` | with S60 fixes |
| --- | --- | --- |
| dynamically dispatched METHOD `===` matching literal | **FAIL** (`0`, expected 1) | pass |
| dynamically dispatched PROPERTY `===` matching literal | **FAIL** (`0`, expected 1) | pass |
| linked provider, `Object.is(bigint, literal)` | **FAIL** (`0`, expected 1) | pass |
| NON-matching literal still `false` (not a blanket true) | pass | pass |
| native UNBRANDED `type i64 = number` keeps the number box | pass | pass |

Base: `3 failed | 2 passed`. Fixed: `5 passed`. The two that pass on both are
guards, not witnesses — they exist so the fix cannot be a blanket switch.

Link-level probe (`.tmp/s60/probe/reduce2.mjs`, 5 consumer shapes over a real
`compileProject` link), base → S60: `eqLiteral` 0 → **1**, `objectIs` 0 → **1**,
`typeofResult` 0 → **1**. Still wrong and NOT claimed fixed: `toStr` (`"" + v`
where `v` is `any` — String() of a dynamically-classified BigInt) and
`arithAdd` (`v + 1n` with `v` typed `any` — throws). Both are the
`any`-typed-operand path, a different mechanism from the branded-hint one
fixed here; neither is on the 12 target rows' critical path (see the row table
below) and both are left open.

## Next step for whoever picks this up

1. Add `toBigIntIdx: number | null` to `coercion-plan.ts`'s
   `CoercionHelpers`, and add bigint-aware rows to the `externref → i64` (and,
   for symmetry, `i64 → externref`) branches, gated on `to.bigint`/`from.bigint`
   — mirror the shape of `type-coercion.ts`'s `coerceType` arms at (search)
   `if (to.bigint) { const toBigIdx = ctx.funcMap.get("__to_bigint"); ... }`.
2. In `stack-balance.ts`, resolve `toBigIntIdx` once alongside
   `boxNumberIdx`/`unboxNumberIdx` (same `findFuncByName` call site, ~line
   3019-3020) and thread it through the SAME ~16-function chain those two
   already travel (`fixBranchType`, `fixBody`, `fixBranch`,
   `plannedCallArgCoercionInstrs`, `callArgCoercionInstrs`) — purely
   mechanical (add one parameter next to the existing pair everywhere), with
   TypeScript's own compiler as the safety net for any missed call site.
3. Re-run `tests/issue-6642-link-bigint-value.test.ts`'s `samemod`/`propcheck`-
   style reduction (not yet committed as a test — see Implementation Notes)
   and confirm `NS.giveBigInt() === 217175010123456789n` answers `1`; then
   re-run the S59 battery (`.tmp/s59/battery`, if still present in a sibling
   worktree) against the 12 ZonedDateTime rows.

## Implementation Notes

- Witness tests: `tests/issue-6642-link-bigint-value.test.ts` — three cases,
  all revert-and-measured (fail on `d8642a8e06`, pass with the two landed
  fixes): (1) the crash fix (typeof comparison across a link no longer
  throws a WasmGC validation error), (2) the strict-equality static-fold fix
  (an `any`-typed BigInt-holding value now compares `===` correctly against
  a matching/non-matching bigint literal, and a non-bigint literal, with no
  link boundary needed to isolate it from the residual), (3) a canonicalization
  regression guard that passes on BOTH the base tree and the fix (documented
  as "measured, not a fix" — see Fix 3 above).
- Reduction scripts (not committed, ephemeral): `.tmp/s59/probe/reduce2.mjs`
  (the original 5-case linked-provider probe), `samemod.mjs` / `propcheck.mjs`
  (single-module, link-free reductions of the residual, one via method call
  and one via property read), `canon.mjs` (the isolated cross-module
  canonicalization check), `combo.mjs` (confirms the residual survives even
  when the value provably crosses a real link, not just a same-module dynamic
  dispatch).
- Files touched: `src/codegen/typeof-delete.ts` (Fix 1),
  `src/codegen/binary-ops.ts` (Fix 2, pulls in
  `ensureExternStrictEqHelper` from `any-helpers.ts`).
- Gates run: `npm run -s typecheck` (clean); `node scripts/check-loc-budget.mjs`
  / `check-func-budget.mjs` (both required this issue's grants above);
  `node scripts/check-coercion-sites.mjs`, `check:oracle-ratchet`,
  `check:speculative-rollback`, `check:issue-ids:against-main`,
  `update-issues.mjs --check`, `check-issue-spec-coverage.mjs`, `lint`,
  `prettier --check` — see the handback report for full results.
- `status: blocked` — the 12 target ZonedDateTime rows do NOT move with this
  PR alone; Fixes 1/2 are independently correct and load-bearing (Fix 1 is a
  crash fix), but the residual documented above is the actual blocker for the
  battery. Re-open to `ready` once the coercion-plan threading (Next step
  above) lands.
