---
id: 7337
title: "Preserve values from heterogeneous mutable bindings (GitHub issue 7077)"
status: done
completed: 2026-11-08
created: 2026-11-08
updated: 2026-11-08
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
assignee: "ttraenkler/codex-7077"
loc-budget-allow:
  # 2026-11-08: +5 lines, one shared binding-carrier query and its declaration use.
  - src/ir/from-ast.ts
  # 2026-11-08: +4 lines, wire shared carrier analysis into existing IR resolver.
  - src/ir/integration.ts
  # 2026-11-08: +6 lines, import formatting and shared inferred-return ABI projection.
  - src/codegen/index.ts
func-budget-allow:
  # 2026-11-08: +2 lines each, shared inference wiring in existing planning seams.
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::makeFromAstResolver
---

# Preserve values from heterogeneous mutable bindings

External report: https://github.com/loopdive/js2/issues/7077. Local plan 7077
tracks unrelated work and is deliberately untouched. ID 7337 was atomically
reserved on upstream/issue-assignments with the open-PR scan verified.

## Problem

The shared binding analysis already chooses a boxed carrier for `var x = 1;
x = 'one'`. Consumers still consult the checker's initializer-derived number
type: console coerces to NaN, boolean assignment prints 1, addition can trap,
and a function returning a heterogeneous local loses the value in its result ABI.

## Implementation Plan

- Extend the existing shared runtime-carrier inference in
  `src/codegen/strict-eq-stale-type.ts` from mutated properties to exact
  heterogeneous bindings and inferred function results. Reuse
  `bindingHasMixedAssignmentCarrier`; preserve declaration identity and cycle guards.
- Reuse that verdict for import planning and result ABI inference, and through
  an IR resolver query for mutable-local lowering. Keep existing specialized
  representations when writes remain within their declared domain.
- Preserve the frozen direct AST emitter logic; its existing shared inference
  queries consume the corrected facts. Rename those queries mechanically to
  reflect the expanded contract.
- Code quality: one carrier verdict and one expression traversal, no duplicate
  binding-write analysis or per-consumer semantic patches.

## Acceptance Criteria

- [x] Exact report prints `one`, `0ab`, `one`.
- [x] Boolean assignment retains its tag; string-to-number addition prints 6.
- [x] Explicit TypeScript `any`, immediate and deferred initialization work.
- [x] IR lowers the mutable-local path without a type mismatch.
- [x] Nearby regressions preserve their measured baseline; typecheck and source ratchets pass.

## Baseline

Untouched upstream main `6ce8636cb20`, native-first gc, `compile` with
`allowJs`, `skipSemanticDiagnostics`, deferred init, runtime `buildImports`,
Node 25.9.0 with `--experimental-wasm-exnref`: combined report prints three
NaNs; boolean prints 1; string-to-number addition traps `illegal cast`;
explicit `any` prints `one`. Four programs executed, 1/4 correct.

## Measured validation

- Candidate focused regressions: **35/35 PASS**, gc native-first, compile-returned
  `importObject` plus `__setInstance` for immediate start and `buildImports` for
  deferred init. Tests execute output and preserve boolean tags, arithmetic,
  aliases and forwarded returns. Two separate import objects
  decode independently; repeated installation does not replay logs; later calls
  remain immediate.
- Existing `issue-5386-console` regressions: **4/4 PASS**. Final focused total:
  **39/39 PASS**, recorded in `.tmp/7337-private-name-tests.log`.
- Nearby final eight-file run: **374/388 PASS**; all fourteen failures belong
  to `issue-5208-compiled-date-host-bridge` and reproduce identically on untouched
  `6ce8636cb20` with the same Node 24/exnref Vitest configuration. The separate
  earlier nearby run was **101/104 PASS**; its three failures (two raw native
  string export comparisons in `issue-6885-host-heterogeneous-array-literal`,
  one existing IR assertion in `issue-7104-dynamic-undefined-return`) also
  reproduce on untouched main. These are baseline failures, not claimed passes.
- Typecheck and production build pass. LOC/function budgets, coercion sites,
  oracle ratchet and dead-export command all exit zero, including explicit
  `LOC_GATE_BASE=6ce8636cb20` checks. Dead-export reporting still prints its
  existing incomplete dynamic-import modeling diagnostics.
- The original `f` is emitted through the IR overlay with zero post-claim errors.
  The observed ledger still records legacy body preparation and R2 withdrawal
  `return-signature-unstable`: this is **not** a claim of complete IR admission.
- Startup marshalling extends the existing funcref protocol with primitive
  decoders and a tiny UTF-16 memory reader. Console effects stay synchronous,
  including before a thrown exception; no console deferral queue is introduced.
  Runtime and codegen now share the append-only helper ID list.

The before-state copies live in `.tmp/base/` for controlled A/B validation.
No full Test262 run was performed.

## Adversarial review

Fresh review accepted the final implementation with no remaining actionable
findings. It verified the original inferred-return IR path, synchronous console
side effects before startup throws for strings/numbers/objects, independent
instance decoders, Unicode decoding, and absence of startup-registration imports
in standalone/WASI. The reported reader-name collision was fixed with the shared
private `__\0js2_str_mem_read16` symbol and an executable regression.
