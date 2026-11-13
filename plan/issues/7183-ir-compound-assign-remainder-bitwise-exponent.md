---
id: 7183
title: "IR: compound assignment `%=`, `**=` and the bitwise operators on number slots — one numeric binary emitter for `a op b` and `x op= b`"
status: done
created: 2026-10-28
updated: 2026-10-28
completed: 2026-10-28
assignee: ttraenkler/opus-ir-compound
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
language_feature: compound-assignment
goal: ir-full-coverage
sprint: current
parent: 7143
related: [7144, 3741, 5163]
loc-budget-allow:
  # 2026-10-28 (#7183): +2 net — `isSelectableNumberCompound`, the selector's
  # `math.pow` provider gate for `**=` (it reads the selection options, so it
  # cannot leave select.ts), after folding two nested ifs at the call sites.
  # The same change-set shrinks src/ir/from-ast.ts by 66 lines.
  # 2026-10-29 (PR #6963 review): the gate became
  # `exactNumericExponentiationAdmissible`, the one predicate `**` and `**=`
  # share, extracted from `isPhase1Expr`'s `**` arm (it reads the selector's
  # module state, so it stays in select.ts).
  - src/ir/select.ts
---

# #7183 — IR: `%=`, `**=` and bitwise compound assignment on number slots

## Problem

The #7143 B1 census (PR #6956; `JS2WASM_IR_SHAPE_DIAG=1 node --import tsx
scripts/measure-legacy-reach.mjs --target standalone --blockers 4`, full B0
corpus, measured 2026-10-28) ranks `nontail-compound-or-binary-stmt` as the
blocker with the most units that it alone keeps on legacy: **13 of its 16
first-blocker units have no other blocker**, so fixing it claims them outright.
Every one is a compound assignment statement with an operator the selector does
not admit:

```ts
x %= 5;  x |= 3;  x &= 9;  x <<= 3;  x >>= 2;   // compound-assignment-coercion.test.ts #4–#8
```

`isF64CompoundAssignOperator` (`src/ir/analysis/operand-admissibility.ts`)
admits only `+= -= *= /=`, and from-ast's `compoundF64Binop` maps exactly those
four to `f64.add/sub/mul/div`. Yet `lowerBinary` (`src/ir/from-ast.ts`) already
lowers the binary forms of all the missing operators on numbers:

| operator | `lowerBinary` producer |
| --- | --- |
| `%` | `emitNumberRemainder` with `remainderFastPathPlan` + `fmodRefFor` |
| `**` | the `AsteriskAsteriskToken` arm |
| `& \| ^ << >> >>>` | `js.bitand/bitor/bitxor/shl/shr_s/shr_u`, result f64 |

So `compoundF64Binop` is a second, smaller copy of `lowerBinary`'s numeric
switch, and the operators missing from the copy are the coverage gap.

## Implementation Plan

**Target structure (quality criterion first).**

1. **One numeric binary emitter.** Extract from `lowerBinary` the part that,
   given two already-lowered number operands, emits `+ - * / % ** & | ^ << >>
   >>>` (including `%`'s fast-path plan and `**`'s helper), as
   `emitNumberBinary(op: BinaryOperator, lhs, rhs, left: ts.Expression,
   right: ts.Expression, cx)` next to `lowerBinary` in `src/ir/from-ast.ts` (or
   a sibling module under `src/ir/` if from-ast's func budget requires it; same
   layer). `lowerBinary` calls it for number operands; behaviour unchanged.
2. **Compound reuses it.** `lowerCompoundAssignment` maps the compound token to
   its binary operator (`ts.SyntaxKind.PercentEqualsToken` → `PercentToken`, …)
   and calls `emitNumberBinary` with the slot read as `lhs`. **Delete
   `compoundF64Binop`.** The string `+=` and the i32-promoted
   (`lowerPromotedI32CompoundAssignment`, #3741) arms stay as they are.
3. **Selector admits the same set.** Widen `isF64CompoundAssignOperator` in
   `operand-admissibility.ts` to the full numeric compound set (rename to
   `isNumberCompoundAssignOperator`; all six call sites in `select.ts` follow).
   `compoundWriteAdmissible` keeps its families: a number slot and a number or
   `undefined` value. The selector and from-ast keep using the one predicate
   (#7144), so a new operator cannot be admitted without a producer.
4. Out of scope (separate blockers in the census): element/property targets
   (`obj[key] %= 3`), module-scope compounds (`tail-module-compound`, 5 units),
   logical assignment, BigInt operands.

**Acceptance.**

- `tests/issue-7183-ir-compound-numeric.test.ts`: for each of `%= **= &= |= ^=
  <<= >>= >>>=` on a function-local number, the function is IR-claimed with
  zero post-claim errors and the result equals node, on standalone and gc.
  Include ToInt32 edges (`x = 2**32 + 5; x |= 0`, negative shifts, `>>>=` of a
  negative, shift counts ≥ 32), `%=` with negative / fractional / zero / NaN
  operands, and `**=` with `NaN`/`Infinity`.
- The 5 `compound-assignment-coercion.test.ts` cases (#4–#8) claim on IR.
- Existing `+= -= *= /=` output is **byte-identical** to main on the
  equivalence corpus and the playground examples, gc and standalone (the
  extraction must not change a single instruction). Quote the counts.
- Census re-run: `nontail-compound-or-binary-stmt` first-blocker count drops
  by at least 13 on the full corpus; standalone demoted total drops by ≥ 13.
- `compoundF64Binop` is gone; no new operator table exists outside
  `emitNumberBinary` and the selector predicate.
- Gate chain bare: loc, func, coercion, oracle, dead-exports, import-cycles,
  compiler-boundaries, ir-layering, ir-fallbacks, flat-dir, standalone-arms.

## Result

Implemented as planned, measured 2026-10-28 against base `f3b5b1a00f`
(`origin/main`, the branch's fork point).

**Structure.**

- `emitNumberBinary(op, lhs, rhs, left, right, cx)` in `src/ir/from-ast.ts`
  is the one producer of `+ - * / % ** & | ^ << >> >>>` on two lowered number
  operands. `lowerBinary` routes every number operator to it (its switch now
  holds only the comparisons). `lowerExactNumericExponentiation` keeps the
  #4787 operand proof, then delegates. The `math.pow` emission moved into
  `emitExactNumericExponentiation`, sited at the left operand, which is where
  both `a ** b` and `a **= b` start.
- The compound arms (identifier, property and element compounds, and member
  `++`/`--`) all call `emitNumberBinary`. `compoundF64Binop` is deleted.
- `operand-admissibility.ts` holds the one table,
  `NUMBER_COMPOUND_BINARY_OPERATORS` (compound token → binary token). These
  are derived from it:
  - `NumberBinaryOperator`;
  - `isNumberBinaryOperator`;
  - `numberCompoundBinaryOperator`;
  - `isNumberCompoundAssignOperator`, which replaces
    `isF64CompoundAssignOperator`.
- The three from-ast dispatch sites that hand-listed `+= -= *= /=` now call
  the shared predicate.
- `lowerBinary`'s private copy of the `js.*` bitwise table is gone. The shared
  `jsBitwiseBinop` table is now the typed record `JS_BITWISE_BINOPS`, matching
  its sibling `I32_COMPARE_BINOPS`.
- Selector: all five `select.ts` sites use `isSelectableNumberCompound`. It is
  the shared predicate, except that `**=` goes through
  `exactNumericExponentiationAdmissible`, the predicate `**` uses: the
  `math.pow` provider, the exact-exponentiation context (no module init, a
  top-level function declaration, a prepared single-source resolver), and
  checker-proven exact number operands. The linear backend selects with
  `supportsSymbolicMathHelpers: false`. (Revised after review; see below.)
- The string `+=` arm and the i32-promoted arm
  (`lowerPromotedI32CompoundAssignment`) are unchanged. The i32-promoted
  bitwise arm is now reachable for the first time: the selector never
  admitted `&= |= ^= <<= >>=` before. The #3741 equivalence test exercises it,
  and so does the new test.
- Size: `from-ast.ts` −66 lines, `select.ts` +2 (granted above), net −43 src
  lines.

**Byte identity.** Every `website/playground/examples/**/*.ts` (13), every
equivalence-test source the `legacy-reach-corpus.mjs` extractor finds (1,514),
and the census's cited test262 files (353) were compiled on base and head,
gc and standalone, and their sha256 compared:
`node --import tsx .tmp/bytecheck.mts <label> --full --shard i/2`, a scratch
script over `loadCorpus`.

- 1,880 programs, 3,760 rows. 3,744 rows are identical and 16 differ.
- 14 of the 16 rows are the 7 programs whose function is newly IR-claimed
  with a new operator:
  - `compound-assignment-coercion.test.ts` #4–#8;
  - `modulo-fmod.test.ts` `modAssign`;
  - `ts-wasm-equivalence.test.ts` `powAssign`.

  A per-function WAT diff shows that only that function changed. In
  `ts-wasm-equivalence` #11, the binary `**` functions `pow`, `square` and
  `sqrtViaPow` are identical.
- The other 2 rows are the test262 file
  `async-generator/yield-star-getiter-sync-returns-undefined-throw.js`. Its
  output depends on which programs the same process compiled before it. In a
  fresh process, base and head produce identical binaries, WAT and IR
  outcome rows. This is a pre-existing determinism issue, not caused by this
  change.
- The `+= -= *= /=` subset (280 equivalence sources using any touched
  operator, plus the 13 playground examples) is identical apart from the same
  7 programs.

**Census.** Command:
`JS2WASM_IR_SHAPE_DIAG=1 node --import tsx scripts/measure-legacy-reach.mjs --target standalone --blockers 4 --workers 3 --json`.
It used PR #6956's tool and the full B0 corpus of 1,880 entries (corpus
digest `f1d03db0…`).

| standalone | base | head |
| --- | --- | --- |
| units | 4,232 | 4,232 |
| demoted | 2,042 | 2,035 (−7) |
| `nontail-compound-or-binary-stmt` first / only | 16 / 13 | 7 / 6 |
| newly demoted units | — | 0 |

- 7 units now claim: the 5 coercion cases, `modAssign` and `powAssign`.
- The two `obj[key] %= 3` / `obj[key] ^= 0xFF` units now pass the compound
  arm. They stop pre-claim at `move-only[concrete]` on the `any` receiver,
  exactly like their `+=` twins (`param-type-not-resolvable`, out of scope).
- **The ≥ 13 target is not reachable within this issue's scope.** Six of
  the 13 "only" units, and every one of the 7 that remain, are logical
  assignments on properties (`obj.x ||= 42`, `&&=`, `??=` in
  `logical-assignment-property.test.ts`). The census label lumps them in with
  the numeric compounds, and the plan's out-of-scope list excludes them. The
  numeric part of the blocker is fully retired.

**Tests.**

- `tests/issue-7183-ir-compound-numeric.test.ts`, 11 tests, all pass.
  - For each of the 8 operators, it checks 5 compound positions (statement,
    loop body, `for` update, property, element). Each position must be
    IR-claimed with zero post-claim errors and match node on the edge
    matrices, on standalone and gc.
  - It covers the `**=` provider gate (mutation-checked: dropping the gate
    fails it), the i32-promoted arm, and the 5 coercion cases.
- `tests/issue-7144-operand-admissibility.test.ts`: the compound-write matrix
  gained `%=`, `**=` and `|=`. The selector agrees with from-ast in planned
  closures on standalone, wasi and gc.
- `tests/issue-4787-ir-numeric-exponentiation.test.ts`: the "compound
  assignment" pre-claim row is removed, because `a **= b` now claims.
- These pass: compound-assignment equivalence files (5), `modulo-fmod`,
  `ts-wasm-equivalence`, #3741, #3758, #283, #2887, #4181, #2945, #2135,
  #7144, #3623.
- Four tests fail identically on base, so they are not caused by this change:
  - #4150 "AOT proofs" (`return_call` vs `call`);
  - #5163 S3 string chains ×2 (the legacy result is `{}`);
  - #3523 "all-statics-before-statements" (`host` vs `standalone`).

**Gates.** All exit 0, run bare: loc (granted +2 `select.ts`), func,
coercion, oracle, dead-exports, import-cycles, compiler-boundaries,
ir-layering, ir-fallbacks, flat-dir, standalone-arms. Typecheck (`tsc` ts7)
and biome are clean.

**Residuals.**

- The shared `math.pow` provider is not correctly rounded: `10 ** 308`
  returns `1.0000000000000006e+308`, and `2 ** -1074` returns `0`. This is the
  same for `**`, `**=` and `Math.pow`, and the same for legacy `**=` on base.
  The spec allows implementation-approximated results, but the subnormal
  underflow is worth its own issue.
- ~~`COMPOUND_TO_BITWISE_TOKEN` is a subset table~~: folded after review.
- The selector's nontail and body identifier-compound arms are near-duplicates
  that differ only in rejection labels. Folding them changes `ir-fallbacks`
  buckets, so that belongs in its own issue: #7192.
- Compile output of the async-generator test262 file above depends on what the
  same process compiled before it. This is a determinism bug.

## Review follow-up (PR #6963, 2026-10-29)

The fresh-context review (APPROVE WITH NITS) raised five findings and one
observation. Each is fixed or rebutted:

1. **`**=` gate looser than `**`'s — fixed.** `**=` now goes through
   `exactNumericExponentiationAdmissible`, the predicate `**` uses (extracted
   from `isPhase1Expr`'s `**` arm). On the lowering side the checker-proof
   assertion moved from `lowerExactNumericExponentiation` into
   `emitExactNumericExponentiation`, so `a ** b` and `a **= b` reach one
   emitter with one proof. Consequence: `**=` is claimed exactly where
   `x = x ** b` is — not in class methods, module init, or on member targets
   (`o.v **= b`, `xs[0] **= b`), which now stay legacy.
2. **Three bitwise-compound lists — fixed.** `COMPOUND_TO_BITWISE_TOKEN` and
   the hand-written chain in `writeShapesAreLowerable` are replaced by
   `compoundBitwiseToken(op)`, derived from `numberCompoundBinaryOperator` +
   `isBitwiseToken`.
3. **Three identifier-compound dispatch sites in from-ast — two folded, one
   kept, selector side filed.** The statement-list and `lowerStmt` dispatchers
   now reach `lowerCompoundAssignment` through `lowerAdoptedMutatingStatement`,
   the helper they already share. `lowerForUpdateExpr` keeps its arm: the
   update clause has its own grammar (no member targets) and its own `=` arm.
   The selector's near-duplicate arms are #7192.
4. **`rhs ?? lhs` — fixed.** `emitNumberBinary` takes `right: ts.Expression |
   null`; `%` and `**` read it through `numberOperandSource`, which throws on
   null.
5. **`lowerBinary`'s intercept must exclude `**` — rebutted, covered by 1.**
   `op === **` returns unconditionally earlier in `lowerBinary`, so TypeScript
   already narrows `**` out of `op` there (`op !== AsteriskAsteriskToken` does
   not compile). The operand proofs now live in the emitter, so even a lost
   early dispatch fails as an invariant instead of silently skipping them.
6. Observation (unused promoted-arm scratch locals): pre-existing, no action.

**Byte identity vs the pre-review head (`f6324d0a`):** the playground,
cutover and equivalence corpus (`scripts/legacy-reach-corpus.mjs`, 1,527
programs — the test262 submodule was not checked out) plus 51 operator probes
(promoted i32 loops for every operator, slot / member / for-update compounds,
a hash loop) × standalone and gc = 3,156 rows. Six differ: the `member-**`,
`class-pow` and `module-pow` probes, the three shapes finding 1 moves to
legacy. Everything else, including the reviewer's five programs and every
i32-promoted probe, is byte-identical.

**Tests:** the #7183 file pins the shared gate (each compound form claimed
iff its `x = x ** b` twin is: local slot yes; class method and module-level
binding no; member `**=` no) and the provider gate with a prepared context.
A mutation run against the pre-review sources fails the new test. The #7144
module-init harness now expects `**=` unclaimed, as `**` is there.
