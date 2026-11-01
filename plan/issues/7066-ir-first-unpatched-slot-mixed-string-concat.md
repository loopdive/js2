---
id: 7066
title: "ir: a `string`-declared result built from a mixed `+` (`'v' + (n > 0 ? 'p' : 0)`) fails to compile on EVERY lane when the function has no caller in the module — IR-first skips the legacy body, then the `+` operand proof demotes at build, leaving an `unpatched-slot` error (#7001 repro 2)"
status: in-progress
sprint: current
created: 2026-10-18
updated: 2026-11-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: ir-first, string-concat, demote
goal: ir-full-coverage
related: [7001, 2138, 3143, 7106, 7144]
loc-budget-allow:
  # 2026-11-01 (step 1): each selection entry passes the checker `+` proof
  # (one option line plus its import), and the selector's generic binary tail
  # applies it (+7); the predicate itself lives in analysis/operand-admissibility.ts
  - src/ir/select.ts
  - src/codegen/index.ts
  - src/ir/integration.ts
  - src/ir/backend/linear-integration.ts
  # 2026-11-01 (step 1): `makeIrAdditiveOperandProof` sits beside the other
  # selection classifier factories, so codegen reaches it over its existing
  # module-bindings import instead of a new codegen->ir edge (+11)
  - src/ir/module-bindings.ts
func-budget-allow:
  # 2026-11-01 (step 1): the one `additiveOperandProof` option line in each selection call
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
---
# IR-first skipped slot with no legacy body after a build-time demote

Found while fixing #7001 (PR #6699); different root cause, all lanes.

## Repro

```ts
export function b(n: number): string { return "v" + (n > 0 ? "p" : 0); }
```
With no caller of `b` in the module, `compile()` fails with an IR-first `unpatched-slot` error on gc, standalone, wasi. Add a caller and it compiles (legacy body kept).

## Root cause

IR-first routing (`src/codegen/index.ts` ~5940-6130, `planIrFirstBodyRouting`) skips the legacy body for a claimed unit; the `+` operand proof in from-ast (`'+' operands not provably …`) then demotes at BUILD, and the demote path assumes a legacy body exists to fall back to. The selector admitted a shape the builder refuses — the #3341 selector↔builder desync class — and the caller-less case has no second route.

## Implementation Plan

1. Make the selector's `+` admission use the SAME operand-type predicate as the builder (`irFirstBodyIsProvenLowerable` in `src/codegen/ir-first-gate.ts` vs from-ast's `lowerBinary` string arm) so a mixed string/number conditional operand is refused pre-claim.
2. Independently, a post-claim BUILD demote under IR-first must never leave an unpatched slot: fall back to compiling the legacy body for that unit (the pre-#3143 overlay order) rather than erroring. Add a test that asserts the compile succeeds and the output matches node for the repro with and without a caller.
3. Record the demote count change in `scripts/ir-fallback-baseline.json` only via `--update-on-decrease`.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.

## Adoption (2026-11-01)

Adopted from `ttraenkler/codex-session-b`. Its claim dates from
2026-10-22 (10 days). Its branch `codex/7066-ir-mixed-concat-20261022` is not
on origin, and no PR exists. Re-claimed with `claim-issue.mjs --force` for
`claude/7066-concat-select-desync`. Scope checked against #3518 (the IR-only
default and legacy retirement umbrella): disjoint. #3518 changes routing and
retires legacy bodies, and touches no `+` admission.

## Step 1 (2026-11-01): one `+` predicate for selector and builder

- `classifyPrimitiveProof` (the TS-type number/string proof the builder's
  `+` gate uses) moves from `src/ir/from-ast.ts` to
  `src/ir/analysis/operand-admissibility.ts`, beside
  `additiveOperandsProvable`. The selector receives the same proof through a
  new selection option, `additiveOperandProof` (`makeIrAdditiveOperandProof`),
  wired where `classifyPrimitiveExpression` is.
- The selector refuses a `+` (`operand-coercion-unsupported`,
  `expr-additive-operands`) exactly when both operands are STATIC: literals
  and their unary, binary or conditional compositions. For such an operand the
  builder's proof is the checker's alone: it never yields the dynamic carrier,
  and the lattice facts cover only parameters and calls. So the two sides
  decide identically. Identifiers, member reads and calls keep their
  admission, so a mixed `+` over them can still demote at build; step 2 makes
  that demote safe.
- This covers the repro above (`"v" + (n > 0 ? "p" : 0)`) and every
  `S11.7.*_A4` file (`'#1: …' + (-1 << 0)`).

**Measured** (A/B against main `4fe61ff7f2`):
- **Repro:** compiles on gc, standalone and wasi, with and without a caller.
  Main fails the caller-less form with `unpatched-slot` on every lane.
- **Files:** the 47 mixed-`+` files from the #7106 census plus the 12
  `S11.7.*_A4` files, on standalone and gc:
  - 0 compile flips;
  - `+` post-claim demotes go from 1 to 0 (`S9.6_A2.1`, which passes before
    and after on both lanes);
  - 0 files newly legacy-free, because the refused initializers stay on
    legacy. On main the chunked ones (every `S11.7.*_A4`) are withdrawn before
    their `+` is reached; the demote shows only once #7106's chunk lowering
    admits them.
- **Bytes:** identical for the S1 chunk sample plus the playground (150/150
  programs, both lanes), legacy-only programs included.
