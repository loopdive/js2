# IR migration handover — 2026-07-30

Work is wound down after the R2 production-routing slice. No agents remain
active, and no further implementation slice was started. `origin/main` at
`5c44e1921605e04d6f399fc52f2009903077be45` contains the completed slice.
This handover is published in
[#3846](https://github.com/loopdive/js2/pull/3846).

## Resume from these trackers

- Epic: `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`
- Active compile-once slice:
  `plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md`
- Next blocked stages: `plan/issues/3522-*` through `plan/issues/3528-*`
- Acorn receiver-aware continuation:
  `plan/issues/3797-ir-stable-this-call-selector.md`

The issue markdown files are authoritative. This file records the handoff
point, validation evidence, and the safest next action.

## State at wind-down

The compiler is still a default-on hybrid. The direct front-end cannot be
removed yet.

- R0 typed outcomes and gates are landed.
- R1 (`#3520`) still has `in-progress` frontmatter. The ABI/session seams
  needed by the bounded R2 route are landed, but R1 has not been closed.
- R2 (`#3521`) now has a production prepare-before-direct route for a bounded
  default single-source population. It is still in progress.
- R3 through R8 remain blocked: classes/closures, module init, whole-program
  multi-source ownership, semantic runtime intents, AST-free async, and shared
  linear consumption.
- R9/R10 remain future integration/deletion stages. IR-only cannot become the
  default and direct AST-to-Wasm handlers cannot be deleted before those
  stages.
- The exact runtime-dynamic Acorn driver remains at 32/43 IR-emitted reachable
  functions. `#3797` has selector proof, but the receiver-aware production
  bridge needed for the next function is not enabled.

## Landed work in this slice

| PR                                                 | Result                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| [#3839](https://github.com/loopdive/js2/pull/3839) | Preclaim stable `this`-bound function calls.                             |
| [#3842](https://github.com/loopdive/js2/pull/3842) | Derive prepared-component dependencies.                                  |
| [#3840](https://github.com/loopdive/js2/pull/3840) | Bind host-data bridges to genuine instances.                             |
| [#3838](https://github.com/loopdive/js2/pull/3838) | Preserve `this` for stable named `.call` targets.                        |
| [#3845](https://github.com/loopdive/js2/pull/3845) | Prove prepared-component structural binding and source-global ownership. |
| [#3841](https://github.com/loopdive/js2/pull/3841) | Prepare bounded top-level free functions before direct body emission.    |

`#3845` merged as `e9743271df00c41fdd3ac1eb408927f8016452c7`.
`#3841` merged as `5c44e1921605e04d6f399fc52f2009903077be45`.

`#3841` replaces the old primitive numeric/boolean skip allowlist only when
the entire selected population is a closed scalar/string top-level component.
The route refuses class/member/module-init owners, late ambient/import/callback/
Date/Promise requirements, fast-mode mismatch, async/generator owners,
reference-shaped callable contracts, allocated-slot signature mismatch, and
unresolved cross-component dependencies.

The anti-vacuity case is a string-method body outside the old allowlist. It is
IR-owned with `direct=0, IR=1`. Unsupported owners still direct-compile once,
and invariants never retry through the direct path.

The final CI fix in `#3841` compares the prepared scalar signature with the
already allocated source-callable slot. A mismatch stays on the established
post-direct parity-withdrawal route instead of replacing an empty slot with an
incompatible body.

## What remains in R2

Do not start R3 until these are complete:

1. Consume the component dependency and binding-ownership adapters from
   `#3842`/`#3845` in the production R2 router.
2. Derive and seal the exact local-call, source-global, support, and ABI
   component before any body emitter runs.
3. Widen the bounded router one dependency family at a time. Every widening
   needs an executable `direct=0, IR=1` case, an Unsupported `direct=1, IR=0`
   case, and injected invariant/no-retry coverage.
4. Reconcile inventory, terminal outcomes, preparation attempts, direct
   emissions, and IR emissions by exact `IrUnitId`.
5. Run the full R2 completion matrix and record the per-unit emission table.
6. Remove the free-function placeholder/patch compatibility branch only after
   R3/R4 no longer consume it.

The safest next slice is step 1: production consumption of the already-landed
dependency/ownership adapters for one dependency-closed scalar/string
component family. Keep `src/codegen/index.ts`,
`src/codegen/declarations.ts`, `src/ir/integration.ts`,
`src/ir/prepare.ts`, and `src/ir/program.ts` under one owner.

## Optimization and deletion guard

Retirement must preserve all direct-path optimizations. At this handoff,
`check:ir-optimization-retirement` reports 11 tracked rows, 2 IR-owned, and 0
retirement-ready. Do not delete a direct handler until its behavior and
optimization decisions have an IR lowering/pass/runtime-intent owner plus
shape or performance evidence where semantic tests are insufficient.

Keep the Acorn direct-backend representation work separate from production IR
routing. In particular, retain these parity requirements when the matching IR
components are widened:

- grounded numeric switch discriminants avoid boxing/type dispatch;
- only twin-exclusive unguarded trampolines may omit the
  `__current_this` frame;
- safe direct trampolines omit unnecessary `argc` frames;
- native RegExp brand dispatch precedes user-field/method ladders where the
  representations are disjoint;
- closed outer token tables and proven open `Parser.options` carriers keep
  their specialized representation.

## Last green local validation

```bash
pnpm exec vitest run \
  tests/issue-3521-prepared-free-function-routing.test.ts \
  tests/issue-3521-prepared-ir-program.test.ts \
  tests/issue-3521-scoped-prepared-abi-seal.test.ts \
  tests/issue-3521-prepared-component-dependencies.test.ts \
  tests/issue-3143.test.ts \
  tests/issue-3203.test.ts \
  tests/issue-3795-ir-dynamic-member-set.test.ts \
  tests/issue-3471.test.ts \
  tests/issue-3551.test.ts
pnpm exec tsc --noEmit --incremental false
pnpm run check:ir-fallbacks
pnpm run check:ir-optimization-retirement
pnpm run check:loc-budget
pnpm run check:func-budget
pnpm run check:issues
```

The focused test matrix passed 119/119. Typecheck, fallback, optimization
retirement, LOC/function budgets, issue integrity, and formatting passed.
The rebuilt `#3841` merge group passed CI and full Test262 at the landed
commit: 110 successful jobs, four skipped, and zero failures.

## Resume procedure

1. Fetch `origin/main` and use a fresh isolated worktree. The primary worktree
   contained unrelated user changes at wind-down.
2. Confirm `#3841` and `#3845` are ancestors of `origin/main`.
3. Read `#3518`, `#3521`, and this handover before changing production code.
4. Re-measure the R2 router boundary before widening it; do not reuse the old
   37-unit readiness numbers as proof of the focused compile-once route.
5. Keep changes serial unless a new coordination plan assigns disjoint files.
6. Open completed PRs as ready, enable the merge queue, and do not rewrite a
   queued branch.

Worktrees retained for traceability:

- `/private/tmp/js2-3521-r2-production-routing`
- `/private/tmp/js2-3521-r2-binding-adapter`

Both merge commits are confirmed on `origin/main`; the worktrees are retained
only for traceability and can be removed in a later cleanup.
