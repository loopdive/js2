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

## Step 1 (2026-11-01, reworked after review): a mixed conditional is a dynamic `+` operand

The first cut of step 1 added a selector option (`additiveOperandProof`) and a
static-operand refusal. Review (2026-11-01) found that it duplicated the
existing `classifyPrimitiveExpression` option, that its static set was
narrower than its own argument, and that it overlapped #7106 S0 (PR #7034).
S0 refuses at selection every typed non-equality pair that
`binaryOperandsAdmissible` refuses over proven families (`"x" + 1`,
`null + 1`, …), and so already covers the `S11.*_A4` initializers.
The rework is stacked on #7034 and keeps only the case S0 does not cover.

- **Root cause:** a #5092 mixed-primitive conditional (`n > 0 ? "p" : 0`)
  lowers to the dynamic carrier (`lowerConditional`). However,
  `expressionProducesDynamic` read a conditional as the carrier only when
  both arms were already the carrier. The `+` proof therefore fell back to the
  checker's union (`"p" | 0`): unprovable, and demoted after the claim.
- **Fix:** `expressionProducesDynamic` also answers the carrier for a
  conditional that `proveMixedPrimitiveConditional` proves. That is the same
  proof `lowerConditional` lowers it with. The `+` then takes the dynamic add
  (`IR_DYN_ADD_FN`).
- **Result:** the repro lowers instead of being refused. The IR-first gate
  already typed `"prefix" + dynamic` as a string, and now the builder agrees,
  so `"v" + (n > 0 ? s : 0)` with a string parameter lowers too. Before the
  rework it failed with `unpatched-slot` on every lane.
- **Footprint:** no selector change, no new option, no grants; `from-ast.ts`
  grows by 4 lines (net).

**Measured** (A/B against the #7034 merge without the edit):
- **Repro and string-parameter variant:** both lower on gc, standalone and
  wasi, with and without a caller. Both answer as node does (`b(1) === "vp"`,
  `b(-1) === "v0"`; `b(1, "q") === "vq"`, `b(-1, "q") === "v0"`).
- **Slice:** the 342 ES5 `S*` files of the addition, subtraction,
  multiplication, division, modulus, shift and bitwise directories. This
  includes the 7 files review named.
  - 0 `+` post-claim demotes and 0 compile errors on both lanes.
  - Binaries are identical to the base: no mixed conditional sits under a
    `+` there.
- **Bytes:** identical for the S1 chunk sample plus the playground (150/150
  programs, both lanes), legacy-only programs included.
- **Tests:** `tests/issue-7066-concat-select-desync.test.ts` is rewritten
  for the rework. It passes, as do the #5092, #7106 S0/S1, #3143 and #3203
  suites.
