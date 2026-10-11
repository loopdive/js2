---
id: 6916
title: "Linear remainder shared integral fast path: default-route benefit unproven"
status: blocked
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: medium
task_type: performance
area: ir, codegen-linear
goal: ir-full-coverage
model: gpt-6-astra
reasoning_effort: high
related: [2144, 3525, 4150, 6915]
---

## Decision

Astra High investigated this independent numeric alternative while issue6915
awaits exact string ownership confirmation. The proposed optimization is
CURRENTLY REJECTED for default typed-IR performance. No source implementation
is dispatched. Reopen only with a genuine default source-derived caller that
executes the existing helper with eligible integral operands and a reviewed,
bounded qualification plan. DRY consolidation alone does not satisfy this task.

## Candidate and published contract

Linear `src/codegen-linear/runtime.ts::addFmodRuntime` contains the older
exact binary-long-division remainder body. Published generic physical
`src/wasm/physical/number-remainder.ts::buildNumberRemainderBody(false)` adds
an exact i32 integral fast path and preserves the exceptional/f64 fallback.
Reusing it could remove duplicated code and change executed helper instructions;
no speedup or correctness defect has been demonstrated.

Inspection base: canonical main
`c41bca2bc07e9d8fddbb38ca77904dd1f0cac438`; recipe and relevant numeric IR
sources are unchanged fromfefc9c0e79. Source inspection is not execution evidence.
Registry already classifies the recipe as clean/wasm-physical and permits
legacy-linear -> wasm-physical. No shared registry change is needed for this
candidate. The ABI stays f64,f64 -> f64; registration/type allocation guards
would stay unchanged. Shared builder, compiler/preparation/physical emitter
and all A-owned files would be consumed read-only, never edited here.

Issue2144 and3525:whole-program-fmod-closure-20261007/remainder-source-inventory
claims are done. The published3525 plan explicitly excluded the independently
existing Linear body from its consolidation change. Existing B runtime PRs
concern other exact functions, not addFmodRuntime. These facts identify a
possible disjoint scope, not proof that changing it benefits default IR.

## Why the proposed integer gain does not establish IR value

`src/ir/from-ast.ts` uses `remainderFastPathPlan` and `emitNumberRemainder`.
The current control flow is explicit:

- Proven integral ranges use direct i64.rem_s.
- Unknown numeric operands use guarded i64.rem_s. Ordinary eligible i32
  integers satisfy those guards and do not execute the exact-helper fallback.
- Statically impossible integral cases call the helper but cannot satisfy its
  proposed i32 integral fast path.
- Exceptional fallback inputs likewise fail that fast path.

`src/ir/backend/linear-integration.ts` maps the exact fmod symbols to the
defined Linear FMOD_FN helper. A syntactic call in a fallback branch is not
proof that eligible integer inputs execute it. Recipe reuse would add integral
checks to fallback executions without an established default-IR benefit.

Setting JS2WASM_INLINE_REMAINDER_FAST_PATH=0 would demonstrate only a diagnostic
configuration. It must not become the primary performance case or justify
disabling the existing default optimization. Do not substitute hand-authored
IR, boxed-any fixtures, changed source/admission, or direct-legacy results for
the requested real default typed-IR consumption evidence.

## Required evidence before any implementation

1. Preserve this negative finding and identify a genuine unchanged default
   source route whose eligible integral operands actually invoke the helper.
2. Join real source owner, accepted/frozen body, consumer, physical helper call
   and native execution. Missing observation is unknown, not passing evidence.
3. Refresh exact function claims/PR overlaps and file an Astra High finite
   source/test/performance specification before Sol6.1 implementation.
4. Compare complete native values, signed zero, NaN/exceptional classes,
   boundaries, extreme ratios and floating fallback against unchanged baseline.
   Retain fixtures, original failures, guards and default options.
5. Predeclare paired artifact timing/lifecycle/caps and retain default fallback
   controls. No performance acceptance with unresolved systematic regression.

No compiler/API/registry wiring, early-helper symbol remapping, policy weakening,
legacy retirement or speculative adapter is authorized by this record.
Session A retains final integration and queue ownership.

## Publication and claims

Canonical allocation6916 is verified upstream with pr_scan=ok, owner
ttraenkler/codex-linear-b-remainder-plan-20261007. Exact planning-only slice
6916:linear-remainder-astra-plan-20261007 has unique owner
ttraenkler/codex-linear-b-remainder-astra-plan-20261007. The planning record is
intended for publication alongside the related blocked alternatives in PR6593;
verify the actual remote/PR HEAD after normal push gates. No source/test
implementation claim has been acquired. The unused isolated6916 checkout is
retained unchanged. This record prevents a speculative optimization, not a
claim of completed IR migration.
