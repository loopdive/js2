---
id: 7066
title: "IR: lower mixed primitive conditional addition without a legacy fallback"
status: in-progress
sprint: current
created: 2026-10-18
updated: 2026-10-22
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
assignee: "ttraenkler/codex-session-b"
language_feature: ir-first, string-concat, demote
goal: ir-full-coverage
related: [7001, 2138, 3143]
depends_on: [7138]
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

## Historical implementation proposal

1. Make the selector's `+` admission use the SAME operand-type predicate as the builder (`irFirstBodyIsProvenLowerable` in `src/codegen/ir-first-gate.ts` vs from-ast's `lowerBinary` string arm) so a mixed string/number conditional operand is refused pre-claim.
2. Independently, a post-claim BUILD demote under IR-first must never leave an unpatched slot: fall back to compiling the legacy body for that unit (the pre-#3143 overlay order) rather than erroring. Add a test that asserts the compile succeeds and the output matches node for the repro with and without a caller.
3. Record the demote count change in `scripts/ir-fallback-baseline.json` only via `--update-on-decrease`.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.


## Implementation Plan — current-main native IR repair, 2026-10-22

Reproduced on upstream main `a94ec762305031c5dda3680068668c9c01b80e90`,
Node 25.9.0, standalone and WASI: the uncalled export fails with a post-claim
operand-coercion demotion and unpatched-slot invariant. Adding a caller keeps
a legacy body and returns the correct value but still reports the failed IR
claim. A typed string+number pair also demotes; an existing dynamic parameter
uses canonical dynamic addition. Raw evidence: `.tmp/7066-main-probe.log`.
The upstream/issue-assignments claim is verified for Session B.

The historical fallback proposal above is superseded by the active migration
objective and direct-AST development freeze. This repair must increase actual
IR execution rather than add another legacy escape route.

- Target structure: reuse `mixedPrimitiveConditionalClaim`, the existing exact
  proof consumed by `lowerConditional` in `src/ir/from-ast.ts`. Its mixed
  primitive conditional already joins as `irDynamic`; the existing
  `expressionProducesDynamic` source predicate must recognize that actual
  producer before the additive specialization gate runs.
- Reuse the existing `IR_DYN_ADD_FN` provider, concrete-to-dynamic boxing and
  native string return conversion. Keep numeric/string fast paths proved by
  their existing operand authority. Do not add an IR opcode, a runtime helper,
  a second ToPrimitive implementation or an AST fallback.
- Measure uncalled and called exports, both conditional arms, nested additions,
  branch/RHS evaluation counts and values against JS; inspect actual IR outcome
  rows and all errors/post-claim channels. Wrong/absent prepared proof must
  retain the existing typed invariant. Unsupported broader shapes must remain
  explicit rather than being admitted by an unproved representation guess.
- Preserve native targets as the implementation priority and existing gc corpus
  bytes. Record exact-base effects, required ratchets and any residual compile-
  twice ownership. Fresh-context adversarial review precedes release.
- Code quality: extend the existing producer fact through its canonical proof;
  do not duplicate the mixed-family classifier or create a one-use abstraction.
  No source-size/cycle/layering allowance is planned.

## Acceptance

- [x] The original uncalled export compiles and actually emits its body via IR
      on both native targets, with no post-claim diagnostic or legacy fallback.
- [x] Called, nested and effectful controls agree with JS through existing
      dynamic addition and preserve single, ordered source evaluation.
- [x] Existing proof-tamper failures remain typed invariants, and numeric/string
      controls retain their sound specialization rules.
- [ ] Required source gates, gc byte preservation, exact-base evidence and
      independent review are recorded; no broader migration closure is claimed.


### Native dependency composition and effect control

The surrounding-operand effect fixture exposed prepared component sealing:
the module-init component had no exact native box/equality evidence and the
plain `__ir_dyn_add` call had no reserve-time Program ABI identity. This is not
a reason to weaken its all-errors assertion. The branch composes the existing
Session B native Dynamic-ABI prerequisite at
`05149798414be6ce069474c10ea6f059e7cf15bb` with current main; it does not copy
that implementation. Merge `b7c696dbab` preserves main's self-guarded
constructor/instanceof admission and strict/sloppy member-write distinction,
including exact evidence for `__dyn_member_set_sloppy`. The shared native
carrier policy is reused by selection and prepared signatures, avoiding a new
size grant.

Extend the existing runtime-provider observer to observe a demanded dynamic
addition after reservation, and extend existing exact truthiness/type/equality
evidence to the same native externref policy already used by boxes. Dynamic
callable/type references remain exact and dependency validation is unchanged.
The tag fault control uses a numeric true arm so the injected string tag
actually changes the prepared tag; a string true arm would be a no-op fault.


## Qualification, 2026-10-22

Node 25.9.0 / Vitest, one fork; standalone and WASI. The final focused
population is **22/22 passing**, versus **22/22 failing** with the same test
file on exact dependency-composed parent `1924e7184bdc396a39cfae9ca5ac5821bf7e23df`.
The merge message was subsequently clarified before publication as
`b7c696dbab57b722b77aba562c88c8695eb657e3`; both complete trees are exactly
`e65cf4a7a3b96892e69be888434ee4f0da127ce9`. No historical run or source
revision label was rewritten.

- The original no-caller string export has IR=true / legacy=false. Both arms,
  left/right operand positions, primitive string/number/boolean tags and nested
  additions agree with JavaScript. NaN, infinities and signed zero exercise the
  condition. Proof/tag/result fault injection still yields a typed build
  invariant and no binary. The tag fault changes an actual numeric tag.
- The effect program's exact four-unit denominator (left, right, run and
  module-init) is IR=true / legacy=false with no errors or post-claim failures.
  Both native targets return 1012, proving two operand calls occur once in the
  expected order. This is real component preparation, not a selector-only gain.
- Numeric mixed addition returns 9/3 directly from the no-caller export and
  preserves TypeScript's existing code-2365 operand warning explicitly. That
  source diagnostic is not a post-claim failure and is not suppressed.
- The wider eleven-file cohort has **383 passes / six failures out of 389**.
  The two old additive suites reproduce all six identical failure blocks on
  the exact parent (**nine passes / six failures**); they concern historical
  JS-boundary expectations and a stale demotion expectation. Final focused
  assertions additionally retain actual four-unit ownership and numeric
  results. No old failure assertion was weakened.
- Final i32 environment qualification passes **173/173** across this final
  22-registration file and all 81 member-boundary / 70 numeric-domain controls.
- The five original kernel/Set suites have **65 passes / the same 22 failure
  blocks out of 87** on both sides after path normalization. The candidate's
  first attempt lacked a Test262 checkout (53 passes / 22 failures / 12 skips);
  that raw failure remains in `7066-kernel-set.log`. The authentic rerun uses
  the exact audit-base Test262 tree, with assert.js SHA256
  `206e274ca325eb8a652e3911c3fbd090e2480d11ed7579dc17a5d17a2360ed48`,
  and is recorded separately in `7066-kernel-set-authentic.log`. No test data
  was deleted or substituted with a reduced harness.
- Byte comparison with that exact parent is **60/60 identical records**,
  including every successful gc, standalone, WASI and linear corpus binary.
  This slice adds no new Wasm drift; predecessor WASI differences and async
  qualification limits remain documented in the prerequisite issue.
- Typecheck, lint, file/function budgets, IR layering, import cycles, flat
  directories, coercion-site and oracle ratchets pass without a new allowance.
  The actual IR fallback ratchet passes with no unintended, post-claim or
  module-level increases; its baseline file was not edited.
- Compiler inventory is valid with zero errors and incomplete architecture,
  source fingerprint `3d7e41d18319f9991dbd914c0f6035b66b4dbfd9315a5254c1106fe1b4e4a81e`.
  Dead-export preservation passes, but strict graph closure remains OPEN at
  the two existing nonliteral dynamic imports. No retirement is certified.

Raw logs live in the worktree's `.tmp/7066-*`; the paired parent logs are in
the existing base-audit checkout. Called string-export controls without a
module-init component still retain compile-twice ownership, explicitly checked
by `7066-producer-fix-probe.log`; no all-program compile-once claim is made.
Independent adversarial review remains required for this final slice, the
prerequisite changes and the three source conflict resolutions. No predecessor
PR head, HOLD, queue entry or running test was changed.
