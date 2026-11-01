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
