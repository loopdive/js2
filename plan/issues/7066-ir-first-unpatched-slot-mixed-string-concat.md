---
id: 7066
title: "ir: a `string`-declared result built from a mixed `+` (`'v' + (n > 0 ? 'p' : 0)`) fails to compile on EVERY lane when the function has no caller in the module — IR-first skips the legacy body, then the `+` operand proof demotes at build, leaving an `unpatched-slot` error (#7001 repro 2)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: ir-first, string-concat, demote
goal: ir-full-coverage
related: [7001, 2138, 3143]
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
