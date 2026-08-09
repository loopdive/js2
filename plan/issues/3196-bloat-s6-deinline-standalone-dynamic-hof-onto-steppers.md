---
id: 3196
title: "bloat S6: de-inline the standalone dynamic-HOF lane in compileArrayLikePrototypeCall onto the #3098 __hof_* steppers"
status: ready
model: fable
fable_role: spec
created: 2026-07-12
updated: 2026-07-17
priority: medium
feasibility: hard
model: fable
task_type: refactor
area: codegen
es_edition: n/a
language_feature: array-methods
goal: maintainability
sprint: current
horizon: l
umbrella: 3182
related: [3098, 3029, 3102, 3185]
---

# #3196 — bloat S6: de-inline the standalone dynamic-HOF lane

Slice **S6** of the #3182 code-bloat-elimination epic. See #3182 §D5.

## Problem

`compileArrayLikePrototypeCall` (`src/codegen/array-methods.ts:763-1887`,
~1,124 LOC) emits a fresh `[[Get]]`-style element loop **at every call site**
for any-typed `Array.prototype.X.call(obj, …)`. Meanwhile #3098's
`ensureNativeArrayHof` (`src/codegen/hof-native.ts:74`; `NATIVE_HOF_METHODS`
`:72`) already emits ONE shared `__hof_<name>` helper per method (11 methods)
over the same `__extern_length`/`__extern_get_idx` substrate + the
`__apply_closure` bridge — but only under `ctx.standalone`. Under standalone
there are therefore **two dynamic-receiver HOF lowerings** of the same ES2025
semantics.

## Approach (verified anchors)

- **Standalone lane only**: replace the per-call-site HOF loop inside
  `compileArrayLikePrototypeCall` (`:763-1887`) for the 11
  `NATIVE_HOF_METHODS` with arg-marshalling + a call to the shared
  `__hof_<name>` helper from `ensureNativeArrayHof` (`hof-native.ts:74`).
- **Keep the JS-host lane as-is** — it rides host imports as the sanctioned
  fast path (dual-mode principle). `ensureNativeArrayHof`'s
  `__extern_get_idx` array-like arms are emitted only under `ctx.standalone`;
  extending the stepper to host mode is a **separate decision** — file a
  follow-up if a spike shows it viable, don't smuggle it in.
- **Boundary watch**: hof-native documents deliberate boundaries
  (reduce-of-empty returns undefined instead of TypeError; dense carriers, no
  hole-skip — `hof-native.ts:43-49`). If the inline loop currently implements
  the *stricter* spec behavior for a method, routing through the stepper is a
  behavior CHANGE — that method stays on the inline path (gap tracked under
  #3098) and the slice notes it.

## Acceptance criteria

- Zero test-diff on the standalone/wasi test262 lanes AND the host lane.
- Per-call-site loop copies gone for the migrated methods.
- `pnpm run typecheck` clean.

## Coordination (priority lowered: hot-file collision + L size)

`src/codegen/array-methods.ts` is under active behavioral change
(dev-array-hof, #3185 slices #3199-#3201, epic S3 #3193). Priority is
**medium** and this is the epic's largest slice (L). Claim **serially** with
#3193 (disjoint ranges: S6 is `:763-1887`, S3 is `:2378-3075`, but both shift
line numbers — re-anchor by symbol). Re-merge `origin/main` before enqueue.

## Progress — Slice 1 (dev-m, recovered + landed by dev-k, 2026-07-17)

**Landed:** the standalone dynamic-HOF method-arm switch de-inlined verbatim
out of `src/codegen/array-prototype-borrow.ts` into a new sibling module
`src/codegen/array-like-hof-arms.ts` (`emitArrayLikeHofArm`, ~766 LOC).

`array-prototype-borrow.ts` shrinks **1840 → 1186 LOC** (-676). The arm bodies
move verbatim behind a single `emitArrayLikeHofArm(ctx, fctx, methodName,
callExpr, arm)` entry point; the per-call loop-local state (receiver/len/idx/
elem temps, closure info, stepper callbacks) is threaded through an
`ArrayLikeHofArmCtx` struct param. `borrow.ts` retains only the two call sites.

**Safety (REFACTOR — zero behavior change):** bodies moved verbatim. `tsc
--noEmit`: clean (validated post-merge with latest `main`). `check:loc-budget`:
green. Targeted vitest (standalone array-HOF suites): pass.
