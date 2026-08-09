---
id: 3282
title: "Decompose the second-level god-functions created by the Wave-B/C extractions (+ ensureAnyHelpers, + deferred object-runtime core)"
status: in-progress
assignee: ttraenkler/dev-opus-4
sprint: current
created: 2026-07-14
priority: high
feasibility: medium
model: opus
horizon: l
reasoning_effort: high
task_type: refactor
area: codegen
goal: maintainability
subtask_of: 3182
related: [3112, 3274, 3105, 3259]
# Slice B relocates the byte-identical equality tails (__any_eq/__any_strict_eq)
# out of the SANCTIONED any-helpers.ts into the sibling any-eq-helpers.ts. The
# coercion-sites gate can't see the sanctioned-source decrease, so it reads the
# net-zero move as +2/+2 growth. prove-emit-identity 60/60 proves it's a pure
# relocation, not new hand-rolled coercion.
coercion-sites-allow:
  - src/codegen/any-eq-helpers.ts
---

# #3282 — the next god-function decomposition wave (post Wave-B/C)

**Source:** the 2026-07-14 god-function breakdown session. Wave B decomposed the 5
biggest single functions (`compileCallExpression` 13,371→1,671, `ensureNativeStringHelpers`
4,843→47, `compilePropertyAccess` 3,335→96, `ensureObjectRuntime` 7,378→3,494,
`compileArrowAsClosure` 1,311→637) and Wave C the 2 biggest untouched ones
(`compileBinaryExpression` 3,129→1,330, `compileNewExpression` 3,082→1,357) — all
byte-identity IDENTICAL. That closes **#3112** (its three named functions —
compilePropertyAccess / compileBinaryExpression / compileNewExpression — are done; mark it
done).

## Problem: the extractions created *second-level* god-functions

Extracting a giant dispatch arm into a new sibling module is byte-neutral, but the arm is
itself large — so several *new* modules now contain a >1,500-LOC function that #3112 could
not have named because it didn't exist before the extraction. Measured on `main` after
Wave C (functions >1,500 LOC, excluding the deliberate lean dispatch skeletons):

| LOC   | Function                     | File (created by Wave B/C)                       |
| ----- | ---------------------------- | ----------------------------------------------- |
| 3,494 | `ensureObjectRuntime`        | object-runtime.ts — **deferred entangled core** (see #3274) |
| 3,017 | `compileReceiverMethodCall`  | expressions/call-receiver-method.ts             |
| 2,964 | `compileBuiltinStaticCall`   | expressions/call-builtin-static.ts              |
| 2,500 | `buildObjectDescriptorHelpers` | object-runtime-descriptors.ts                 |
| 2,010 | `compileIdentifierCall`      | expressions/call-identifier.ts                  |
| 1,930 | `compileNamespaceStaticCall` | expressions/call-namespace-static.ts            |
| 1,860 | `ensureAnyHelpers`           | any-helpers.ts — **never touched by any wave**  |
| 1,793 | `compileTailDispatch`        | expressions/call-tail-dispatch.ts               |

The lean skeletons `compileCallExpression` (1,671), `compileBinaryExpression` (1,709 pre-#3092
/ ~1,330), `compileNewExpression` (~1,357) are the intended reduced dispatch cores — leave
them unless a clean further cut appears.

## Approach (proven on Wave B/C)

Same byte-identity-guarded intra-function decomposition:
- Extract cohesive dispatch/receiver-family/helper-builder groups into named helpers in new
  sibling modules; `prove-emit-identity check` must print **IDENTICAL 39/39** after every step;
  `tsc --noEmit` 0.
- Both relocation-shift gates are now net-per-field / net-zero-immune (oracle-ratchet #3070,
  coercion-sites #3084), so pure relocations pass with **no** per-issue allowance.
- Continuous stacking (branch each slice off the current branch; don't idle-wait for merges),
  one PR per slice, #2093 smoke test per issue.
- **Coordinate the last stacked slice's finalization** — the July-14 run hit worktree-removal
  stranding when authors stood down mid-stack (see notes); land each stack fully before standing down.

## The `ensureObjectRuntime` entangled core (~3,494) is a distinct, harder sub-target

Per #3274's deferral note, the remaining object-runtime core (`__obj_hash`/`__key_equals`/
`__obj_find`/`__extern_get`/`__obj_insert`/`__extern_set` + the shared `emitClassifyKey`/
`emitKeyMatch`/`withKeyCoercion` closures + forward-splice machinery) is NOT a clean
byte-identical lift — it *defines* cross-cutting closures. It warrants a dedicated architect
pass; keep it a separate slice within this issue (or its own issue) rather than forcing it.

## Acceptance

1. No codegen function >1,500 LOC except the deliberate dispatch skeletons and (if still
   deferred) the object-runtime entangled core, which must carry a documented reason.
2. Every slice byte-identity IDENTICAL (39/39 gc/standalone/wasi); tsc 0; no test262 regression.
3. #3112 marked done (superseded here).

## Relation to the reduction epics

This is *structural* (breaks up functions), setting up the *reductive* follow-ons under #3182:
the emit-idiom builder library (#3105) and jscpd-quantified dedup (#3259) become far easier
once these arms are small, named helpers — decompose first, then dedup.

## Slices landed

- **Slice A (opus-1) — `__any_box_*` + `__any_unbox_*` families out of
  `ensureAnyHelpers` → new sibling module `any-boxing-helpers.ts`.**
  Lifted the seven tag-boxing primitives (`__any_box_null`, `…undefined`,
  `…i32`, `…f64`, `…bool`, `…string`, `…extern_s1`, `…ref`) and the four
  tag-unboxing primitives (`__any_unbox_i32`, `…f64`, `…bool`, `…extern`)
  verbatim into `registerAnyBoxHelpers` / `registerAnyUnboxHelpers` in the new
  `src/codegen/any-boxing-helpers.ts`. `addHelper` is threaded in as a callback
  so registration order + bodies are unchanged → emitted Wasm byte-identical
  (`prove-emit-identity check`: IDENTICAL 56/56). Extracting to a **sibling
  module** (not same-file) shrinks the god-file: `any-helpers.ts` drops
  2752 → 2425 LOC (−327), keeping the LOC-regrowth ratchet green with no
  allowance. The `undefinedSingletonActive` import back into `any-helpers.ts`
  is a runtime-only ESM cycle (both function declarations), safe. tsc 0,
  biome/prettier/loc-budget clean. Epic remains open for the eq / add families
  and the larger call-family functions.
- **Slice B (dev-opus-4) — equality & relational-comparison family out of
  `ensureAnyHelpers` → new sibling module `any-eq-helpers.ts`.**
  Lifted `__any_eq`, `__any_strict_eq`, and the four relational comparisons
  `__any_lt`/`__any_gt`/`__any_le`/`__any_ge` (via the `addComparisonHelper`
  nested registrar) verbatim into `registerAnyEqHelpers` in the new
  `src/codegen/any-eq-helpers.ts`. `addHelper` is threaded in as a callback and
  the tag-5 coercion/equality closures (`tag5ToNumber` / `tag5ValueEqThen`) are
  threaded as params so their captured environment is unchanged; the
  standalone/wasi-gated #2175 V2-S3 reference-identity reconciliation inside
  `__any_strict_eq` moved verbatim WITH its guard. Registration order
  (eq → strict_eq → lt → gt → le → ge) preserved → emitted Wasm byte-identical
  (`prove-emit-identity check`: **IDENTICAL 60/60** across gc/standalone/wasi/
  linear). `any-helpers.ts` drops 2425 → 1926 LOC (−499). No import back into
  `any-helpers.ts` (the eq region references nothing from it) → no ESM cycle.
  tsc 0, biome + check:godfiles clean. Epic remains open for the arithmetic
  (`__any_to_f64`/`__any_add`/`__any_div`/`__any_mod`/`__any_neg`) and
  `__any_typeof` tail families.
