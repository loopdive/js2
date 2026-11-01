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
  # 2026-11-01 (lowering WIP): the IR-first skip input threads the lane's
  # number-to-string flag to the gate (+2); revisited with the step-1 rework
  - src/codegen/ir-prepared-free-functions.ts
  # 2026-11-01 (step 1): `makeIrAdditiveOperandProof` sits beside the other
  # selection classifier factories, so codegen reaches it over its existing
  # module-bindings import instead of a new codegen->ir edge (+11)
  - src/ir/module-bindings.ts
func-budget-allow:
  # 2026-11-01 (step 1): the one `additiveOperandProof` option line in each selection call
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  # 2026-11-01 (lowering WIP, parked for the step-1 rework): the gate keeps
  # its proofs for the string `+` arm, and the closure gate passes the lane flag
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/select-planned-closure-operands.ts::plannedClosureOperandRefusal
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
