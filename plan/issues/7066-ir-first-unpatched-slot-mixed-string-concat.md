---
id: 7066
title: "ir: a `string`-declared result built from a mixed `+` (`'v' + (n > 0 ? 'p' : 0)`) fails to compile on EVERY lane when the function has no caller in the module — IR-first skips the legacy body, then the `+` operand proof demotes at build, leaving an `unpatched-slot` error (#7001 repro 2)"
status: in-progress
sprint: current
created: 2026-10-18
updated: 2026-11-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
assignee: "ttraenkler/codex-session-b"
language_feature: ir-first, string-concat, demote
goal: ir-full-coverage
related: [7001, 2138, 3143, 7106, 7144]
depends_on: [7138]
import-cycles-allow:
  - codegen->ir: 302 # 2026-11-01 (#7066): the IR-first gate's `+` row reads the shared `+` rule (ir/analysis/operand-admissibility.ts) instead of keeping its own copy, which drifted twice
loc-budget-allow:
  # 2026-11-01 (#7066 review round 3, +13): a template substitution and String(v) refuse a scalar element read before the claim (`scalarMayBeElementRead`, beside the template family it guards), and the static predicates get the lane's number-to-string flag; restated here so it does not ride on #7106's grant
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-01 (#7066 review round 3, +3): String(v) refuses a scalar element read before it claims
  - src/ir/select.ts::isPhase1Expr
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

## Current receiving reconciliation, 2026-10-30 (UNAPPLIED source proposal)

This proposal accounts for all 61 historical paths against current main,
including the later landed console and native-domain corrections. The
additional ir-dynamic-construct bridge carries canonical source strictness
into named and computed IR stores without changing entry-this admission.
Both member builder entries receive the same qualified numeric return
boundary as the existing free-function entry. These are source contract
repairs, not measured runtime regressions or fresh execution credit.

Current 7136 and 7137 fixtures each retain the original 70 registrations
and add two landed refusal controls. With the original 7066 (22) and 7138
(81), the prospective four-file source population is 247. All original IR
ownership, value, effect and invariant assertions remain. Actual current
qualification, source typing, native provider joins and the unsigned/gc
compatibility review are still pending; no PASS or byte identity is inferred.


## Current-main whole-scope qualification contract, 2026-10-30

This private reconciliation preserves all 61 published paths and their historical
receipts. Its two explicit additional paths are the canonical source-strictness
bridge in the existing `src/codegen/ir-dynamic-construct.ts` module and
`tests/issue-7138-source-store-strictness-context.test.ts`. It preserves the
current #7106/#7144 callable, operand, provider and refusal contracts. The
source-strictness query is independent of ambient-this/entry-this selection;
named and computed stores use the same canonical source context, including the
synthetic-wrapper `inferModuleStrictArguments` distinction. Unknown direct API
context is a typed refusal, not a guessed strict/sloppy mode or legacy body.

The maintained original #7066 22-case body and #7138 81-case body are exact
prefixes. Current #7136 and #7137 whole bodies, including their original 70 and
two subsequently landed refusal registrations apiece, remain exact. Proposed
whole-file collection is 26 + 72 + 72 + 87 + 2 = **259** registrations across
five fixtures. The 12 added registrations are four declared-number member
return controls, six real named/computed strict/sloppy store controls and two
direct unknown-context refusal controls. All are UNRUN: counts from source do
not establish collection, IR ownership, values or qualification. Original
assertions, warning 2365 and the native runtime/IR-no-legacy conditions remain.
Additional changed prepared-main and compatibility fixtures remain part of
normal hook/blast-radius selection; they are not replaced by these five files.

The member controls require the actual explicit `ReturnProbe_numeric` owner
and caller to emit IR bodies; static and instance source shapes are observed
separately without claiming they select distinct integration branches. Both
dynamic primitive arms must return 9/3 against genuine Node execution. Store
controls require both writer bodies to emit IR and use native readonly getters
to observe ignored sloppy writes versus strict TypeError, once-only receiver,
key and RHS evaluation and their order. No mocked provider or fallback-only
execution is accepted as proof.

The unsigned conversion uses the existing canonical ToUint32 helper only after
a successful non-lossy source-to-f64 subplan. Unbranded signed widening stays
unchanged. Explicit-u32 semantics and the narrower #7137 native-domain recovery
are separate contracts; no unmeasured universal gc byte-identity conclusion is
made from the historical corpus. Dynamic addition remains an explicit
`IR_DYN_ADD_FN` runtime call registered and observed by the existing call-target
dependency path; no new `dyn.add` instruction or redundant sidecar is added.

### Normal budget and issue coverage

All current PR-local grants and historical issue text remain intact, including
#7136's dated SCC 725 / ir-to-codegen 82 allowances and its current narrowly
listed LOC/function keys. The strictness bridge reuses an already-present
module/import edge. New controls belong to their existing #7066/#7138 issue
files; no new compiler inventory entry is needed for a test path. The registry
retains every current entry/policy field and adds only the six missing authored
modules from the original scope.

An exact newline comparison of all proposed src bodies against their receiving
preimages finds a net +68 lines, zero growing files above the 1500-line limit
and zero newly crossing that limit. This is source arithmetic, not a normal
gate run. No speculative new LOC, function, cycle, layering or global allowance
is granted here, and no main-only baseline is edited. The normal TypeScript-AST
function-budget and complete boundary/integrity checks remain mandatory and
UNRUN. Any genuine intended growth they identify must be resolved structurally
or by an exact documented PR-local issue grant; no hidden waiver or automatic
baseline update is permitted.

Before any publication, normal formatting/lint/source typing, the complete
original/added fixture population and its actual IR ownership, raw error
channels, normal gates and full post-source/tool checks must pass on the exact
frozen receiving epoch. No previous PR, source-only replay or historical PASS
is qualification of this reconciliation. This artifact authorizes no runtime,
source adoption, commit, push, hold or queue effect.

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

## Mixed concat lowering plan (2026-11-01)

Lower `'…' + x` when `x` is a proven number, boolean, `null` or `undefined`,
instead of refusing it. The plan is backed by a throwaway prototype that is not
committed. It covers only string + number: `additiveOperandsProvable`,
`additiveResultFamily` and `binaryOperandsAdmissible` were widened behind an
environment flag, and the string `+` arm reused
`lowerNumericSubstitutionToString`. Measurements are A/B, flag off against
flag on, in one tree.

### 1. Native support today

| Family | IR producer today | Host-free? |
| --- | --- | --- |
| number | `IR_NUMBER_TO_STRING_FN` (`src/ir/number-to-string-provider.ts`). On native-string lanes it binds `number_toString` from `emitNativeNumberFormat`, the #3912 formatter that legacy uses for the same `+`. The IR already calls it for numeric template substitutions (#4467, `lowerNumericSubstitutionToString`, from-ast ~5900) and for `n.toString()` (#4462). | Yes. Prototype kernels compile with 0 imports on standalone. On gc the IR concat drops the three `__str_*_mem` host imports that legacy pulls in for `"a" + i + "b" + i * 0.5`. |
| boolean | `lowerBooleanToString` (`src/ir/boolean-brand.ts`, #4503) selects between two string consts. | Yes, no runtime needed. |
| null / undefined | None needed: they are the spelled consts `"null"` and `"undefined"`. They cannot go through lowering today: a `null` operand demotes as a bare null, and `undefined` / `void x` lowers to the f64 NaN sentinel, which would print `"NaN"`. They must be spelled before operand lowering. | Yes. |

**Lane gate:** the legality capability `number-to-string` is wasmgc only
(`backend/legality.ts:233`). The resolver's `nativeNumberToStringAvailable` is
the builder-side twin. This is the same pair the numeric template substitution
uses, so linear and porffor keep refusing.

### 2. Shapes and counts

Scope: the 59 files (47 census mixed-`+` files plus 12 `S11.7.*_A4`). A checker
scan walked every top-level `+` chain whose node mixes a string side with a
non-string side.

- **Where the shapes sit:**
  - 52 of the 59 files carry such a chain in `<module-init>`.
  - In functions it occurs only in harness code: 1,264 chains, almost all
    `message += …` over `any` in `assert.js`.
  - The census sample shows no function-level `+` demote at all.
- **Non-string operand family**, files carrying each:
  - number 43;
  - object 14;
  - any 8;
  - undefined 4;
  - boolean 3;
  - null 2.
- **Lowerable:** 31 of the 52 files have only primitive non-string operands.
- **Out of scope:** the other 21 have an object or `any` operand, which needs
  ToPrimitive. Examples: `'…' + (x)` after `x = new Number(1)`, a catch binding
  `e`, `obj.length` on `{}`.

| Shape (module-init) | Files | Chains |
| --- | --- | --- |
| string + number expression (`'#1: …' + (-1 << 0)`, `+ (Number.MIN_VALUE / 2.1)`) | 30 | 6,243 (512 per shift file) |
| literal string + identifier (`'…' + p1`) | 24 | 72 |
| chain of 3 or more (`'Total error: ' + errorCount + ' bad … in ' + count + ' '`) | 4 | 4 |
| compound `+=` with a string slot | 0 | 0 |
| template literal with a non-primitive substitution | 1 | not a `+` blocker |

### 3. Lever value

**Census estimate.** Source: the #7106 true-blocker census `s792`, standalone,
691 live files out of 792, from 2026-11-01. The mixed key is split by the shape
scan, so only files whose mixed operands are all primitive count as solved.

| Levers solved | Newly legacy-free |
| --- | --- |
| mixed alone | +0 (+1 on `s792x`) |
| chunk | +8 |
| storage | +7 |
| mixed + chunk | +10 |
| mixed + storage | +7 |
| chunk + storage | +18 |
| mixed + chunk + storage | +20 |

In the greedy cover, mixed never enters the top 8: the eighth lever still gains
+5. Mixed is a **co-lever of the chunk budget**. On its own it frees almost
nothing, because its files are large module-inits.

**Prototype, measured on the 59 files** (string + number only, both lanes,
same counts on gc and standalone):

| Tree | Newly legacy-free | CE flips | Lost | Test262 flips |
| --- | --- | --- | --- | --- |
| step-1 branch (main-based) | 1 (`S9.6_A2.1`) | 0 | 0 | 0 |
| #7026 stack (chunks) + step 1 | **15**: the 12 `S11.7.*_A4`, `S11.5.1_A4_T2`, `S11.5.2_A4_T10`, `S9.6_A2.1` | 0 | 0 | 0 (15/15 pass before and after) |

- The one `+` post-claim demote left on the stack (`S11.5.2_A4_T10`, a
  non-static `Number.MIN_VALUE / 2.1` operand that step 1 cannot see) goes away.
- The census predicts 3 of these 15 (the shift rows were never censused).
- Besides chunk, the census co-blockers of the 19 primitive-only mixed files
  are:
  - storage (7);
  - `for-init-var-kind` (4);
  - `throw-module-scalar-unboxed` (3);
  - `isNaN` (3);
  - `var-kind` (3).
- Corpus-wide the sample's +2 is too few to extrapolate tightly. The
  measurable value is these 15 files once #7026 lands.

**Bytes:**
- The 15 newly claimed files shrink by 16.8% (7.43 MB to 6.18 MB on
  standalone).
- The S1 chunk sample plus the playground are identical (150/150, legacy-only
  programs included).
- The chain kernel shrinks by 22% (37,575 B to 29,187 B).

**Compile time:**
- On the 15 newly claimed files: 74 s to 100 s. The overlay now lowers 512
  asserts that legacy also compiles; this is #7026's known held-chunk cost, not
  this lever's.
- The 88 file-lane rows whose binary does not change: 1.02× in total, with a
  median per-file ratio of 0.995, which is load noise.

**Run time** (standalone, hot loop, 300k iterations, median of 5 alternating
rounds of 7 runs, against legacy):

| Kernel | Legacy | IR |
| --- | --- | --- |
| `"k" + i` | 34.2 ms | 33.0 ms |
| `"a" + i + "b" + i * 0.5` | 93.1 ms | 96.5 ms |

Both are within the ±10% run spread: parity.

### 4. Design: one `+` rule, one ToString, one arm

| Concern | Module | Change |
| --- | --- | --- |
| the `+` rule | `src/ir/analysis/operand-admissibility.ts` (#7144 home) | See "The `+` rule" below the table. |
| ToString of a proven primitive | new `src/ir/primitive-to-string.ts`, beside `boolean-brand.ts` | `lowerPrimitiveToString(builder, value, family)`: string is the identity; boolean uses `lowerBooleanToString`; number widens an f64/i32/i64 carrier to f64 and calls `IR_NUMBER_TO_STRING_FN`. Returns `null` for a carrier with no widening, and the caller throws its own reason. The widening block moves here from from-ast's `lowerNumericSubstitutionToString`, which keeps only its template guard. |
| the lowering | `src/ir/from-ast.ts` `lowerBinary` (~15215) | See "The lowering" below the table. |
| selection | `select.ts` (step-1 refusal, ~8882), `select-planned-closure-operands.ts:478`, `codegen/ir-first-gate.ts:215` | All three call `additiveOperandsProvable` with the lane flag. The IR-first gate's hand-written `+` row (a third spelling, narrowed 2026-08-28) folds into it, mapping domains number, string, bool, dynamic to proofs; an inline mixed conditional maps to `unprovable`, which is the builder's proof of it. |

**The `+` rule** (`operand-admissibility.ts`):
- `AdditiveProof` gains `boolean` and `nullish`.
- `classifyPrimitiveProof` returns `boolean` for an all-boolean type. Its other
  callers (from-ast ~3502, ~14841, `module-bindings.ts:542`) test only
  `number` / `string`.
- New `classifyAdditiveOperand(expr, type, isShadowed)`:
  - checks the nullish syntax first: `null`, unshadowed `undefined`, `void x`;
  - otherwise falls back to `classifyPrimitiveProof`.
- `additiveOperandsProvable(left, right, numberToString)` becomes one rule:
  - dynamic on either side: provable;
  - a string side: both sides must be concatenable (string, boolean, nullish,
    and number when `numberToString` is set);
  - otherwise: number + number.
- `additiveResultFamily`, and `binaryOperandsAdmissible`'s string `+` row, widen
  to the same concatenable set.

**The lowering** (`lowerBinary`):
- The #2781 gate passes `numberToString`, taken from the resolver.
- An operand whose proof is `nullish` is spelled instead of lowered; `void x`
  first lowers `x` as a discarded value.
- The existing `case PlusToken` string arm stays one arm. It converts each side
  with `lowerPrimitiveToString`, keyed by that side's **proof** family, not its
  carrier. So a boolean needs no brand, and there is no arm per type pair.
- `lowerTemplateExpression` calls the same helper.
- `inferStringEncoding`'s `+` row treats a number, boolean or nullish side as
  ASCII, as `inferEncoding` does for templates.

**Out of scope:**
- object, `any` and union operands. These need ToPrimitive and stay on legacy
  or the dynamic `+`.
- `+=` into a string slot (`compoundWriteAdmissible`). The same predicate covers
  it, but no census file needs it; file it as a follow-up.

**Acceptance criteria.**

- **Correctness:** a new `tests/issue-7066-*.test.ts`, checked against node, on
  gc, standalone and wasi, covering:
  - numbers: integers, negatives, `-0` (prints `"0"`), `NaN`, `±Infinity`,
    `1e21`, `0.1`, and native `i32` locals;
  - booleans, both branded and unbranded `i32`;
  - `null`, `undefined`, and `void f()` with its side effect run once;
  - chains, including `n + m + "s"` (which adds first) and `"s" + n + m`;
  - left-to-right operand evaluation;
  - linear refusing.
- **Test262:** 0 flips on the 59 files, on the 13 shift rows, and in the ES5
  ratchet.
- **Code quality:** this criterion goes to the adversarial review.
  - `additiveOperandsProvable` is the only `+` admission rule. It has 4
    callers: the builder gate, the selector static refusal, planned closures
    and the IR-first gate. The IR-first gate's private `+` row is deleted.
  - `lowerPrimitiveToString` is the only primitive ToString. It has 2 callers:
    `+` and templates.
  - The string `+` arm stays one `case`.
  - from-ast's net LOC change is ≤ 0, and `lowerBinary` gets no
    `func-budget-allow`.
- **Performance:** both hot-loop kernels stay within 5% of main's median on
  standalone, measured over ≥ 5 alternating rounds.
- **Bytes:** byte-identical for legacy-only programs and for the S1 chunk
  sample plus the playground (150/150). Files that become IR-claimed must not
  grow.

### 4b. Design, rebased on the reworked step 1 (2026-11-01)

Since the rework, step 1 sits on #7106 S0 (PR #7034). S0 refuses at selection
a typed non-equality pair whose proven families `binaryOperandsAdmissible`
refuses. The reworked step 1 makes a #5092 mixed conditional a dynamic `+`
operand. The lowering therefore widens one rule that already has four
readers, instead of adding a selector path of its own.

| Reader | Today | After |
| --- | --- | --- |
| builder gate (`lowerBinary`, #2781) | `additiveOperandsProvable(lProof, rProof)` | the same call with the lane flag (`nativeNumberToStringAvailable`) |
| selector, `selectorPrimitiveWrapperOrGenericBinary` (S0) | `binaryOperandsAdmissible` over proven families | for `+`, also `additiveOperandsProvable` over `additiveProofOf(family)`, with the `number-to-string` capability |
| planned closures (`closure-additive-operands`) | `additiveOperandsProvable` | the same call with `sources.numberToString` |
| IR-first gate (`irFirstBodyIsProvenLowerable`) | a hand-written `+` row | `additiveOperandsProvable` over its domains; the row is deleted |

- **The rule.** `additiveOperandsProvable(left, right, numberToString)`:
  - a dynamic side admits;
  - beside a string, the other side must be a string, a boolean, or a number
    when the lane formats numbers;
  - otherwise both sides must be numbers.

  `AdditiveProof` gains `boolean`; `classifyPrimitiveProof` returns it for an
  all-boolean type. `additiveProofOf(family)` is the one map from a proven
  family to a proof (number, string, boolean, dynamic; anything else is
  unprovable). `int32` maps to unprovable because it may be an unbranded
  boolean.
- **Carrier typing.** `binaryOperandsAdmissible`'s string `+` row accepts a
  string beside a string, number, `int32` or boolean carrier
  (`additiveResultFamily`). The rule above has already decided admission, so
  this row only types the producer.
- **The lane flag in the IR-first gate.** The gate is a constant `true`
  there: the skip set exists only on the WasmGC backend, whose lanes all bind
  the formatter (`number-to-string`, `backend/legality.ts`). This avoids
  threading the flag through three codegen files.
  - The gate's import of the rule is one new `codegen->ir` edge. It is
    granted, because it replaces a duplicate rule.
  - Its mixed-conditional special case is gone: since the rework, from-ast
    proves that conditional dynamic too.
- **The lowering.** `src/ir/primitive-to-string.ts`:
  - `lowerPrimitiveToString(builder, value, family)` is the one primitive
    ToString. Template literals, `String(v)`, the #5092 `String` arm and the
    string `+` all use it.
  - The `+` converts each side by its proof family (so an unbranded boolean
    still prints `"true"`), through a helper outside `lowerBinary`.
  - The #2781 gate moves into a helper that returns the proofs, so
    `lowerBinary` does not grow.
- **Out of scope:** `null` / `undefined` beside a string (no census file needs
  them, and `undefined` lowers to the NaN sentinel), and `+=` into a string
  slot.

### 5. Step 2: not made moot

The lowering removes the mixed-primitive share of the `+` post-claim demotes,
but not the IR-first `unpatched-slot` class:

- **Counterexample** (measured with the prototype on, every lane):
  `export function b(n: number, s: string): string { return "v" + (n > 0 ? s : 0); }`
  still fails to compile.
- **Cause:** the IR-first gate types the conditional as its `dynamic` domain
  and skips legacy. The builder proves the `string | number` operand
  `unprovable` and demotes, leaving the slot unpatched. Step 1 cannot see a
  non-static operand.
- **Recommendation:**
  - Fold the gate's `+` row into the shared predicate (§4 above), which closes
    this `+` desync.
  - Keep step 2 as its own issue: an IR-first-skipped unit that demotes after
    the claim compiles its legacy body. It is the net for every other gate row
    that can drift from the builder (the 2026-08-28 note in the gate records
    one such drift already).

**Update (2026-11-01, after the step-1 rework).** The counterexample above now
lowers: the builder proves the mixed conditional dynamic, which is what the
IR-first gate already assumed. Step 2 stays a general net and is filed below.

## Follow-up: step 2, a legacy fallback for an IR-first-skipped unit (filed here 2026-11-01)

Not a separate issue file: `claim-issue.mjs --allocate` cannot run in this
session.

- **Problem.** Under IR-first, a function in the skip set
  (`irFirstBodyIsProvenLowerable`) gets no legacy body. If from-ast then
  demotes it after the claim, the overlay finds the slot unpatched and the
  compile fails (`unpatched-slot`). The gate is a syntactic proof, so every
  row can drift from the builder's proofs. It has drifted twice on `+` alone:
  `"a" + 1` (2026-08-28, #3529) and the #7066 mixed conditional.
- **Proposal.**
  - A skipped unit that demotes after the claim compiles its legacy body
    instead (the pre-#3143 order for that unit), and the compile succeeds.
  - The post-claim error stays a diagnostic.
  - `STRICT_IR_POSTCLAIM_CODES` (`src/codegen/index.ts`) still decides which
    codes are invariants rather than demotes.
- **Where.** The IR-first routing in `src/codegen/index.ts`
  (`planIrFirstBodyRouting` and the overlay patch that reports
  `unpatched-slot`).
- **Acceptance.**
  - A forced post-claim demote in a skipped, caller-less function compiles and
    answers like node on gc, standalone and wasi.
  - Programs with no such demote are byte-identical.
  - No new `unpatched-slot` in the equivalence suite.

## Review round 2 (2026-11-01): one PR, and a mixed conditional beside a string stays a string

The round-2 review of #7033 merged the lowering into it (one PR). It found
that the step-1 rework still failed one step later.

**The failure.** The rework made a mixed conditional a dynamic `+` operand. So
`"v" + (n > 0 ? "a" : 1)` produced the carrier, and these forms then demoted
after the claim:
- `s = "v" + (n > 0 ? "a" : 1)` into a `string` slot (`assignment to "s"
  (string) got dynamic`);
- `const s = "v" + (cond); return s.length`;
- `c = c + s.length` in a loop.

The boxing also cost about 2.4× on standalone.

**The fix.**
- Beside a proven string, the operand is converted arm by arm, exactly as
  `String(c ? a : b)` converts it. #7034's `lowerBinaryOperands` calls
  `lowerConvertedMixedConditional`, which is factored out of
  `tryLowerExactMixedPrimitiveWrapperCall`.
- ToPrimitive is the identity on the primitive arms, so the `+` is a string
  concatenation, never boxed, and its result is a string.
- `expressionProducesDynamic` reads `mixedPrimitiveConditionalClaim`, not the
  tamper-sensitive proof.

All four forms above lower with no post-claim demote on gc, standalone and
wasi, and answer as node does (`tests/issue-7066-mixed-concat-lowering.test.ts`).

**Measured.** The A/B compares the #7026 head `dc767af398` merged with this
branch against the same merge without the lowering (the reworked step 1 plus
#7034 `28dcbf366e`):
- **The 59 files, both lanes:**
  - **+17 legacy-free:** the 12 `S11.7.*_A4`, `S11.5.1_A4_T2`,
    `S11.5.2_A4_T10`, `S9.6_A2.1`, `S11.10.1_A3_T2.3` and `S11.6.2_A3_T1.2`.
  - 0 compile flips, 0 `+` post-claim demotes, no new imports.
  - The 17 binaries shrink 16% (8.17 MB to 6.88 MB on standalone).
  - The conformance runner gives 17/17 passes before and after on both lanes:
    0 flips.
- **Bytes:** the S1 chunk sample plus the playground are 150/150 identical,
  including the 12 legacy-only programs.
- **Run time** (standalone, median of 5 alternating rounds of 7 runs, against
  main `22a6442977`):

  | Kernel | Change vs main |
  | --- | --- |
  | `"k" + i` | 1.04× (within the 5% bar) |
  | `"a" + i + "b" + i * 0.5` | 0.74× |
  | `"v" + (i % 2 > 0 ? "a" : i)` | 0.65× (the round-2 shape, no longer boxed) |

  The IR kernels import nothing. On gc the mixed kernel drops legacy's 18
  boundary and memory-string host imports.
- **Code size:** from-ast.ts shrinks by 21 lines against that base. The `+`
  side conversion lives in `primitive-to-string.ts`
  (`lowerConcatOperand`).

**Follow-up, not fixed here: `s += n > 0 ? "p" : 0`.** The compound form is
claimed and then demotes (`string-evidence-unsupported`): the `+=` into a
string slot takes only a string value (`compoundWriteAdmissible`). The legacy
body it falls back to traps with `illegal cast` on standalone. Both behaviours
predate this PR. The fix is the same arm-wise conversion in the compound arm,
plus the shared rule in `compoundWriteAdmissible`.

## Review round 3 (2026-11-01): element reads, one rule, one flag

**1. An element read past the end printed `NaN`.** `"v" + a[i]` with
`f([1], 5)` gave `"vNaN"`; node and main give `"vundefined"`. The checker
types `a[i]` as `number`, but past the end the value is `undefined`, and the
IR reads it as NaN (0 on linear; a boolean element would read `false`). No
IR scalar holds `undefined`, so no ToString may take such a value.
- `mayBeElementRead` (`operand-admissibility.ts`) looks through parentheses,
  type assertions and a conditional's arms.
- The `+` rule does not concatenate a number or boolean for which it holds.
  It still adds one as a number (NaN is ToNumber(undefined)).
- The selector refuses the same operand as a template substitution and as
  `String(v)`'s argument (`scalarMayBeElementRead`, `select.ts`). Both were
  wrong on main too: `` `v${a[i]}` `` and `String(a[i])` were claimed and
  printed `NaN`.
- No in-bounds proof is reused: the counted-loop proof
  (`isProvenInBoundsIr`) lives in the builder's loop context, which the
  selector cannot see. So `"," + a[i]` inside `for (i < a.length)` stays
  legacy, as on main.
- The static predicates' own element-read rule now calls the same predicate.

**2. One `+` rule.**
- `additiveOperandsProvable(expr, left, right, numberToString)` is the rule.
  It takes the expression so it can see an element read.
- `additiveResultFamily` is derived from it. `concatenatesToString` is gone,
  and with it the int32 disagreement and the missing lane flag.
- `binaryOperandsAdmissible` leaves a string `+` to the rule. Every caller
  that can see a `+` beside a string applies the rule first.

**3. One lane flag: the `number-to-string` capability.**
- The selector reads it through its `supportsBackendCapability` option.
- The builder reads the same query through the resolver's
  `supportsBackendCapability`, instead of `nativeNumberToStringAvailable`.
- The IR-first gate gets it through `IrFirstSkipIdentityInput.numberToString`
  instead of assuming `true`.
- `irBackendCapabilityQuery` (`backend/legality.ts`) replaces the five copies
  of the profile projection plus capability call.

**Measured.** The A/B compares the #7026 head `dc767af398` merged with this
branch (`355c54e59f`) against the same merge without the lowering (the
reworked step 1 plus #7034 `045e9a41f7`):
- **The 59 files, both lanes:** +17 legacy-free (the same 17 as round 2),
  0 compile flips, 0 `+` post-claim demotes, no new imports. The 17
  binaries shrink 16% (8.17 MB to 6.88 MB on standalone). They are
  byte-identical to round 2's. The conformance runner gives 17/17 passes
  before and after on both lanes: 0 flips.
- **Bytes:** the S1 chunk sample plus the playground are 150/150 identical,
  including the 12 legacy-only programs.
- **The element-read repros** (`"v" + a[i]`, `a[i] + "v"`,
  `"v" + (c ? a[i] : 2)`, `` `v${a[i]}` ``, `String(a[i])`) all answer as
  node on standalone, with no post-claim demote on gc, standalone or wasi.
  `1 + a[i]` still lowers through the IR (`tests/issue-7066-mixed-concat-lowering.test.ts`).
- `tests/issue-7144-operand-admissibility.test.ts` passes (12/12) after
  the #7034 merge.
- Gates, run bare: loc, func, coercion, oracle, dead exports, import cycles,
  boundaries inventory, typecheck, lint, IR fallbacks, changed-root tests and
  equivalence all pass. Against main's tip as base, loc flags only
  `property-access.ts` and `loops.ts`, which main shrank and this branch
  does not touch; the merge preview takes main's copies.

**4. Perf of `"v" + n`: the IR inliner, not the lowering.**
- The IR returns the concat helper's result with `call; return`.
  `ir-tail-call.ts` still refuses a tail call whose callee has a different
  arity from the caller, a guard #5270 removed from legacy as a proxy that
  `return_call` does not need. So the IR user-function inliner (#4157)
  inlines the concat helper into `f`, where legacy emits `return_call`.
- The formatter call and the allocations are identical to legacy's.
- With that guard dropped (a scratch probe, not in this PR), the module is
  byte-identical to main's: 28,553 bytes, against 30,349 with the inlined
  helper.
- **The perf claim, corrected.** Round 2's "within 5%" does not hold for a
  function that only returns `"v" + n`: it pays for the inlined helper, and
  the reviewer measured about 1.2×. Here, standalone, 1e6 calls, median of 7
  alternating rounds against main `22a6442977`: 1.00× called from JS and
  1.11× from a wasm loop. The same run read the byte-identical control at
  1.05× and 1.17×, so this box's noise is larger than the gap and cannot
  confirm or bound it more tightly.
- The three hot-loop kernels compile byte-identical to round 2's on both
  lanes, so round 2's medians stand: 1.04×, 0.74× and 0.65×.

**Follow-ups recorded in round 3, not fixed here:**
- **`+=` on a string local ignores the rule.** `s += n` is claimed and then
  demotes: the compound arm admits only a string value
  (`compoundWriteAdmissible`), not the `+` rule's concatenable families.
- **`s += cond ? "p" : 0` traps** (`illegal cast`) on standalone, in the
  legacy body it falls back to (see round 2).
- **A hole reads as 0.** `a[2] = 7; "v" + a[0]` gives `"v0"`; node gives
  `"vundefined"`. The grow-on-write store fills the gap with zeros. Legacy
  gives the same wrong answer, and so does main.
- **A local holding an element read** (`const x = a[i]; "v" + x`, or
  `` `v${x}` ``) prints `NaN` past the end. The f64 slot cannot hold
  `undefined`, and legacy's cannot either.
- **The IR tail-call arity guard** (part 4 above): `ir-tail-call.ts`
  `callIsTailEligible` refuses a `return_call` whose callee arity differs
  from the caller's. #5270 removed that guard from legacy. Dropping it from
  the IR is a two-line change, but it moves every IR function with such a
  tail call, so it needs its own byte and perf measurement.

## Review round 4 (2026-11-01): the class of reads, not its spellings

The round-4 review measured 22 past-the-end shapes on both lanes against
main `27f7d02251`. Two still went wrong:
- `"v" + (0, a[i])` printed `"vNaN"`: the comma hid the element read.
- `const [x] = a; return "v" + x` trapped on `f([])`. The IR's
  array-pattern reader (`elementReader`) uses an unchecked `vec.get`.

**The rule, stated as a class.** The IR reads an array element without a
bounds proof in exactly two places: an element access, and an array-pattern
leaf. `mayBeElementRead` asks whether the value can come from either one
unchanged, through the closed set of expressions whose value is one of
their operands':
- parentheses and type assertions;
- a conditional's arms;
- a comma's or an assignment's right side;
- `&&`, `||` and `??`.

Arithmetic produces a fresh number, so `"v" + (1 + a[i])` stays lowered.

**The leaf question comes from #7024's pattern plan.**
`patternLeafReadsElement` (`literal-pattern-plan.ts`) answers it. A leaf
reads an element unless the literal plan decomposes its declaration. When
the plan does decompose it, the leaf binds its source, and the question
repeats on that source.
- The selector resolves declarations through the module-binding resolver.
- The builder resolves them through the checker, with the same
  `localValueDeclaration` (now exported).
- Both reach the rule as one `AdditiveLane`: the `number-to-string` flag
  plus that leaf predicate.

**Why not the alternatives.**
- **An allowlist** of values that provably cannot be an absent element
  (literals, operator results, parameters, locals never written from a
  read) needs a write analysis of every local to keep `"k" + i` in a
  counted loop.
- **The marker test** (`emitF64IsUndefined` at the conversion) needs three
  producer changes: the past-end vec read yields NaN today, not the marker;
  the pattern reader traps; and the conversion itself. It would also change
  the bytes of every unproven vec read. And the test is unsound after
  `f64.abs` / `copysign`, which keep a signalling payload.

So the refusal is the smaller sound rule. The cost is one interface and one
predicate.

**The two `+` classifiers** in `select.ts` now derive from
`additiveResultFamily`:
- `obviousModuleValueFamily` reads the module slot families as operand
  families (`OBVIOUS_OPERAND_FAMILIES`).
- `boundedMixedConditionalPrimitiveFamily` takes the lane. Selection and
  build call it with the same lane.

Templates and `String()` over an element read are refused at selection
(round 3). Main claimed them and printed `NaN` past the end.

**Measured on the 24 shapes**, gc and standalone, against main
`27f7d02251`:
- Every shape main answers right still answers right.
- Main's wrong template and `String()` answers are now right, and so is its
  trap on a leaf in a template.
- No shape claims and then demotes; main had 14 that did.
- Two shapes stay wrong on both, as legacy is: an assignment's value
  `"v" + (t = a[i])` with `let t = 0`, and a local `const x = a[i]`. Both
  keep the read in an f64 slot.

**Main merged in** (`27f7d02251`, for #7024's plan):
- #7034's S0 already judges a literal-pattern leaf by its source's family,
  so main's separate judgment folds into it.
- #7024's `mixedPlus` rows (`const [a, b] = [1, 'x']; a + b`) are now
  claimed, and answer as node does.
- `tests/issue-3529-ir-producer-parity.test.ts` "array-literal widening"
  failed on main `27f7d02251` too, because #7024 lowers that source now.
  It is re-pinned here as the literal plan's claim.

**The 59 files, both lanes.** Measured on the #7026 head merged with this
branch, against the #7026 head alone (both on main `27f7d02251`):
- +17 legacy-free.
- 0 compile flips, 0 `+` post-claim demotes (the base has 15), no new
  imports.
- The 17 binaries shrink 16%, and they are byte-identical to round 3's.
- 17/17 pass before and after on both lanes: 0 flips.

Gates, run bare, pass: loc, func, coercion, oracle, dead exports, import
cycles, boundaries inventory, typecheck, lint, IR fallbacks, equivalence
and changed-root tests.


## 2026-11-05 private receiving preparation (unqualified)

The authored history was reconciled with the qualified S5 predecessor.
That predecessor subsequently landed as protected merge
`b41288eac97ed95e2442d5527b26cc6b94436b06`; its production/test/configuration
source matches this receiving base, with only five upstream report JSON files
different. A normal ancestry join is still required before this PR is delivered. Current
Boolean module brands and S5 slot ownership remain, and the duplicated class
plan fragments already present on main are not reinserted into the 7106 plan.
The producer-parity successor retains its current patch-stage assertion. The
exact former `"x" + 1` S0 program is preserved as a stronger claim-and-value
control rather than disappearing from the fixture.

Two bounded review nits have private source successors: logical assignments
forward either operand for the element-read question, and a cyclic pattern
leaf answers "may read" without recursive overflow or persistent query state.
The existing forwarding control gains the three assignment operators; a real
parsed cyclic binding graph and independent literal leaf cover the proof's
closed-query behavior. No runtime correctness or complete compiler-cycle fix
is claimed from this helper change. The two whole owned fixtures then passed 65/65 tests, together with normal
formatting, Biome on 22 changed TypeScript files and source TS7.

A genuine Boolean-array observation compiled and produced Node's result 1,
with a valid binary and no imports, but the selector claimed `f` before the
builder rejected its scalar ToString. The receiving successor asks the same
shared primitive rule before a non-carrier `+` with element-read provenance;
it only refuses and changes no builder or legacy value path. Three additional
requested-configuration controls pin pre-claim refusal, with the unchanged
program's value checked on standalone. Fresh qualification of the resulting
68 tests passed (9 concat-select tests and 59 mixed-lowering tests), with no
skipped tests or post-run survivors. Normal formatting checked all 23 selected
TypeScript/JSON files unchanged; lint checked 22 TypeScript files and stock
source typing passed. All source bodies, index entries, tool identities and
borrowed harness aliases remained unchanged across qualification. The earlier
65-test pass and genuine Boolean-element observation remain separate records.

The receiving changes are private and not delivered. All November1 census,
performance, legacy-byte and playground measurements above remain historical.
A fresh independent source/quality review, scoped neighboring tests, normal
commit/push hooks, current-main ancestry, CI and protected floors are pending.

### Independent receiving review: remaining Boolean ToString consumers

The fresh independent review found that scalarMayBeElementRead missed Boolean
array elements whose IR family is unknown, although their declared family is
Boolean. Two actual unchanged standalone observations confirmed BUILD withdrawal
for a Boolean array read in a template and String(a[i]); both binaries were valid,
import-free and returned Node's 1 through fallback. This is a pre-claim admission
bug, not a newly observed wrong value. Their full outcomes and failures remain
retained. The guard now also recognizes a positively declared numeric/Boolean
scalar when its IR family is unknown. It only refuses unbounded element reads;
string and dynamic carriers retain their existing paths. Six additive target
controls extend the focused population from 68 to 74. Fresh normal formatting
checked all24 selected files unchanged, lint23 and stock source typing passed,
and all74 focused tests passed (9 concat-select +65 mixed-lowering). Complete
source/index/tool/harness POST checks matched and no project descendants remained.

The actual four-fixture neighbor run produced 404 passes and two failures out of
406 cases. Both failures were the old legacy-only routing expectation for the
unchanged concatOperand guest Object.is("a" + 1, "a1"); its runtime assertion
already succeeded with IR emission. That exact guest moved from REFUSED to
CLAIMING, retaining its Node assertion and adding two genuine IR-off controls.
The ambient fixture therefore has 289 prospective tests instead of 287. The
original failed run remains evidence; the289-row ambient successor has not run
yet. A fresh independent full24-path source/quality review identified only the
Boolean ToString pre-claim gap above, then cleared the exact4,736-byte successor
including all added controls and unchanged ambient guest. Normal hooks and
current protected qualification still remain mandatory before delivery.

### Receiving-main scoped quality checks

Against immutable receiving main b412, normal LOC, function, coercion, oracle,
standalone-arm and import-cycle gates passed. The existing issue-local grants
cover selector growth and codegen-to-IR edge302; no baseline or global rule
changed. Compiler inventory passed in the maintained CI invocation, mode
inventory with the2048MiB limit; it reports inventory-valid and architecture
incomplete. A preceding invalid mode invocation stopped before evaluating the
inventory and is retained as an instrument error, with no pass credit.

The exact preservation-only dead-export contract exited0 with12/12 observed
core-node callers,10/10 core types and6/6 full/cut source witnesses. Its graph
remains OPEN and strict retirement/deletion is NOT certified; the two existing
unknown dynamic-import targets remain reported. The stock IR fallback gate
passed with no unintended, module-level or post-claim increase. Complete raw
streams and source/index/tool POST checks are retained. Normal commit/push
hooks, the289-row ambient successor and current protected checks remain pending.

### Normal author-history checkpoint and landed-main join

Private commit be2a6eee85 preserved both receiving36b and authored01d histories.
All normal hooks passed with9 whole changed-root files and679 tests:
overlay5, producer3, concat9, mixed65, ambient289, for-head94, script-var66,
wrapper136 and operand-matrix12. The earlier8-file/613 forecast omitted the
already-landed script-var fixture selected from the older common ancestor;
the actual normal hook counts are679/679. No test was skipped or rerun to
repair that bookkeeping forecast. Formatting, lint, LOC/function and oracle
hooks passed; the full qualified source/index vector and installed tools
remained unchanged and no process descendants survived.

A normal noncommitting merge of actual landed main b71bb594 then completed
without conflicts. Every one of the25 qualified paths retained its exact mode
and blob; all16,960 other indexed paths match that actual main exactly. The
only incoming differences are11 generated report JSON files and the7238 plan.
Their generated values are inherited, not edited by this repair; the two not
covered by the existing formatter ignores already pass normal Prettier checks.
The final merge commit hooks, nonforce publication, current CI and protected
floor checks remain pending. No November1 census/performance gain is remeasured.
