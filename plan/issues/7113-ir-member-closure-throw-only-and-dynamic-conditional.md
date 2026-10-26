---
id: 7113
title: "IR: throw-only member closures (void plan) and dynamic-arm conditional values"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-26
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
depends_on: [7112]
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7113): the selector's dynamic-arm conditional predicate and
# from-ast's `tryLowerDynamicConditionalValue`.
# 2026-10-25 (#7113 round 10): select.ts grows by the positive value-family
# admission for closures that mint a dynamic-shaped local
# (`plannedClosureValueFamilyAdmissible` and its write / family helpers).
# 2026-10-26 (#7113 round 11, rebuilt on #7144): the hand-written refusal
# helpers are deleted in favour of the shared walk; select.ts keeps +302
# against main (the dynamic-join shape and position gate, the
# representation walk for minting closures); from-ast +72 (the dynamic-join
# lowering with the real-undefined `void` arm, `lowerConditionalBranches`).
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# IR: throw-only member closures, dynamic-arm conditionals

Parent: [#7106](7106-ir-test262-harness-units.md), Stage 4 (`<module-init>`). This slice is stacked on
[#7112](7112-ir-dynamic-value-call.md).

The lead's census on the open stack (#6831 + #6830 + #6826, run on
S11.6.1_A2.1_T1) assigned two rows to the member-closure plan owner.

## Row 7: a throw-only body

`Test262Error.thrower = function (message) { throw new Test262Error(message); }`
was refused with `closure-return-type`. The planner's own inputs show why:
the oracle reports the return as `unresolvable` (TS `never`), while the legacy
physical signature is `(externref) → (none)`. Because legacy registers the
closure with no result, it takes the same VOID plan as `sameValue`.
`openVoidBodyKey` still refuses any `return <value>`.

## Row 2: `message === undefined ? '' : message`

`assert.compareArray` failed on this expression with
`expr-mixed-conditional-context`. On the stripped standalone probe the same line
shows up as `operand-coercion-unsupported` at selection. Replacing it by hand
on the base tree moves the blocker, which confirms that this line is the cause.
The #5092 mixed-primitive route covers two
primitive arms, and only in a top-level function. This conditional instead
joins a dynamic parameter with a string literal.

## Fix

- **Selector** (`dynamicConditionalValueArms`): accepts a conditional value
  inside a planned member closure when exactly one arm is a primitive literal
  and the other is one of the closure's dynamic parameters (or a nested
  conditional of the same shape). Two dynamic arms are not this shape: the
  generic conditional walk already admits them and the generic lowering joins
  them. The check runs before the #5092 route.
- **Sink** (`dynamicConditionalValuePosition`): the join is a bare dynamic, so
  the shape is admitted only where the closure takes a bare dynamic as-is — a
  `throw`, an expression statement, an untyped declaration initializer, a
  reassignment of a dynamic parameter, or an arm of an outer conditional whose
  sibling arm is itself dynamic. Anywhere else (`var n = 5; n = m ? m : 1;`,
  a call argument, a return) the walk falls through to the #5092 route and is
  refused at select with `operand-coercion-unsupported`, as before this shape
  existed. This is the rule the top-level move-only scan applies to a dynamic
  value in a concrete position; a planned closure does not run that scan, so
  the shape carries the proof itself.
- **from-ast** (`tryLowerDynamicConditionalValue`, over the shared
  `lowerConditionalBranches`):
  - each arm is lowered in its own branch, so evaluation short-circuits;
  - the literal arm is boxed into the carrier inside its branch;
  - the join is bare dynamic.

  A top-level subject never takes the selector shape (its dynamic parameters
  are not in the closure set, and the move-only scan refuses a dynamic/concrete
  join there). The lowering also sees a top-level two-dynamic-arm conditional
  the generic route admitted; it lowers it as the generic tail did (bytes
  identical, measured).

### Review round (2026-10-25)

- **Throw of a concrete scalar in a planned closure is refused at select**
  (`isPhase1ThrowStatement`, `throw-closure-concrete-scalar`). The void plan
  is pre-existing and already reached throw-only bodies with an early
  `return` (`function (m) { if (m) return; throw 42; }` withdrew after the
  claim on the base too); routing `unresolvable` returns into it widened the
  class to every throw-only body, so the gap is closed for planned closures
  here. `lowerThrowStatement` refuses an f64/i32 value unless its
  number-boundary projection is configured, and no lane that mints a plan
  configures it (measured: standalone, wasi, gc native-first). The same
  withdrawal for a **top-level** `throw 42` is pre-existing on every lane and
  stays out of this slice: its refusal would move host-assisted gc bytes.
- **A dynamic parameter joined with `undefined` / `null`** is refused at
  select (`expr-conditional-dynamic-nullish-join`); the generic tail typed
  the arms `dynamic` vs `dynamic<tag:1>` and withdrew (pre-existing on the
  base for closures with an early return).
- **A bare dynamic assigned to a concrete slot** inside a planned closure is
  refused at select (`expr-closure-write-unlowerable`, reported as
  `body-shape-rejected`): the closure's dynamic parameter (`var s = "a";
  s = m;`) or a dynamic-shaped local it minted (`var r = m ? m : 1; s = r;`)
  written to a local with a type annotation or a non-dynamic initializer. On
  the base both shapes withdrew after the claim
  (`property-write-unsupported`, `assignment to "s" (string) got dynamic`)
  and gc native-first failed to compile; the second was new with this slice's
  conditional shape, so its sink rule (`dynamicAssignmentSink`) now covers the
  conditional and the local reads alike. The same rule admits the conditional
  into a dynamic-shaped local (`var r; r = m ? m : 1;`, `var r = m; r = m ?
  m : 1;`), which the first cut over-refused. The rule covers the plain `=`
  and the admitted compound writes (`closureWriteUnlowerable`, one check on
  every assignment RHS): `+=` is admitted into a dynamic slot with any RHS
  (`m += r`, `var s; s += r`, `r += 1`, `r += undefined` — the dynamic add)
  and refused into a concrete one with a dynamic RHS (`s += r`, which otherwise claimed and
  withdrew `string-evidence-unsupported`); `-=`, `*=`, `/=` on a dynamic
  slot are refused whatever the RHS (from-ast lowers only `+=` there —
  `r -= 1`, `m -= r` withdrew `compound-assign-unsupported`). A bare `null`
  inside a planned closure is admitted only where from-ast materialises it
  (`closureNullValuePosition`: a `throw` operand, also behind a comma's right
  side — `throw (1, null)`; the direct operand of an equality
  `tryFoldNullCompare` folds — strict against a dynamic value or the catch
  binding, any against a numeric / boolean operand — but not `null ===
  undefined`, a loose compare against a dynamic value, or a string operand)
  and refused everywhere else — a slot write (`r = null`,
  `r += null`), a declaration (`var nul = null`), behind `??` or a comma, a
  conditional arm, a call argument, a member store — all of which withdrew
  `nullish-value-unsupported`. Still open, out of scope: `r += a` with
  `var a = [4]` (the dynamic `+=` operand has no carrier for `vec<f64>`,
  pre-existing for `m += a`); a
  dynamic value reaching a typed slot through any other expression (`var r =
  m + 1; s = r;`), a chained write (`s = r = m`), a write to a `const`
  (`const s = m; s += r` — the IR withdraws, legacy throws the TypeError node
  throws), or `String(r)` / `String(m)` as a throw value (claims, then
  `late-preparation-unsupported`)
  withdraws after the claim — identical on base and head for a closure with
  a return (measured, `x25r`, `strMr`), and newly reachable in a throw-only
  body, where the base minted no plan at all (`x25`, `strM`). The closure
  runs no move-only scan; closing it means a selector-side dynamic typing of
  the initializer, not another position list.

## Implementation Plan — round 9 (Fable, 2026-10-25; implement on Opus)

Round-8 fresh-context review of head `ced5832946` (verdict on PR #6834,
`review-6834-r8`) left four blockers, all the same class — the selector admits
a `null` or `??` shape in a planned member closure that from-ast then refuses
(claim-then-demote), or refuses a shape the base lowered (lost claim). One
commit on top of `ced5832946` in `src/ir/select.ts` + tests + this file. Every
limit below is read from from-ast; cite the line in the JSDoc, do not
paraphrase.

### Y — object-shaped operand of `=== null`

`nullCompareFoldFails(other, op, scope)` (select.ts ≈6604–6611) does not
mirror `tryFoldNullCompare`'s object/class bail (from-ast.ts ≈16186–16193).
Resolve `other` through `unwrapPhase1Parens` and `closureLocalDeclaration` to
its initializer; return `true` when `obviousSelectorValueFamily` of the
operand **or of that initializer** is `"reference"` **unless** the initializer
is an array literal (`ts.isArrayLiteralExpression`) — a `vec` IS folded
(`eqArrR`, `vecLitEqR`, `vecElEqR` claim and match node on the base; keep).
Refusal row: `var o = { a: 1 }; if (o === null) throw "n"; throw r;`.

### Z — loose `== null` with a non-identifier dynamic operand

select.ts ≈6607 `if (!strict && dynamicShapedValue(other)) return true;` only
sees identifiers / params / catch / conditional arms; `m.x == null`,
`m[0] == null`, `m() == null`, `m.g() == null`, `(1, r) == null` pass and
withdraw. Spell the loose branch **positively**: a loose operator is admitted
only when the other operand is provably numeric or boolean —
`obviousSelectorValueFamily ∈ {number, boolean}` or
`declaredExpressionHasExactFamily(other, number | boolean, scope)`; the array
family may stay admitted (`var a = [1]; a == null`, `a.length == null` fold on
the base). Everything else → `return true`. Must keep claimed (measured on the
base): `k == null`, `var q = 5; q == null`, `5 == null`, `true == null`,
`-r == null`, `!r == null`, `(r > 1) == null`, `subject() == null`.
Refusal row: `if (m.x == null) throw "n"; throw r;`.

### AA — `??` with the minted dynamic local on the left

`var t = r ?? 1; throw t` claims and withdraws
`'??' on non-reference lhs (dynamic)`. In `isPhase1Expr`'s binary arm, under
`currentInPlannedMemberClosure`, refuse a `QuestionQuestionToken` whose left
operand (through parens) is `dynamicShapedValue(...)`, with its own reason
code (`expr-closure-nullish-coalesce-dynamic`), JSDoc citing from-ast's `??`
limit. Refusal row: `var t = r ?? 1; throw t;`.

### AB — discarded `null` (20 lost base claims)

`closureNullValuePosition` climbs parens and a comma's RIGHT operand to a
`throw`, then tests equality; a `null` in a **discarded** position reaches
neither and is refused, while from-ast's `lowerDiscardedExpression`
(≈2546–2620) lowers it under an externref hint (`:2619`). Extend the climb:
while the parent is a `ParenthesizedExpression`, a `VoidExpression`, a comma
(`node` on EITHER side) or a `ConditionalExpression` of which `node` is an
arm, climb; then admit when the parent is a `ThrowStatement` **or** an
`ExpressionStatement`. Do **not** admit a `for` initializer / incrementor
(`lowerForUpdateExpr`, ≈12449, lowers with its own hints; those rows were PCE
on the base — keep refusing). The comma-left admission subsumes
`throw (null, m)`; `(null, m) === null` is admitted by the same walk.
Positive rows: `null;`, `(1, null); throw m;`, `throw (null, m);`,
`void null;`, `k ? null : 1;` — each prepared `<module-init>`, empty PCE,
result = node.

### AC — JSDoc (nit, same commit)

Remove "comma-left" from the withdrawing positions; replace "a class-typed
operand has no selector family" with the truth (object/array/function
literals are `"reference"`; only the identifier→declaration hop was missing);
add the `boxed` (≈16163) and `ref_null` (≈16208) bails as unreachable-today;
opening sentence names three admitted positions: throw operand, discarded
value, folded equality operand.

### Validation (bare, exit codes in the report)

`pnpm run -s typecheck`; vitest one file at a time on
`tests/issue-7106-member-closure-shapes.test.ts`,
`tests/issue-7106-dynamic-value-call.test.ts`,
`tests/issue-7106-dynamic-evidence*.test.ts`; `node scripts/check-loc-budget.mjs`
and `node scripts/check-func-budget.mjs`, each also with
`LOC_GATE_BASE=$(git rev-parse origin/main)`; coercion-sites, oracle-ratchet,
dead-exports, import-cycles, ir-layering. Probes: re-run
`probe7/9/10/11/12/13/14/15/16/17-6834-*.mts` (scratchpad) head vs base
`/home/user/js2/.claude/worktrees/refresh-6832` @ `1f01ea20` with `cmp-r6.sh`:
Y/Z/AA rows refused with empty PCE, every AB row claimed again (= node), zero
lost base claims on standalone / wasi / gc, host-assisted gc and fast bytes
identical on every row. Report the new head and a one-line PR-body addition.

## Implementation Plan — round 10 (Fable, 2026-10-25; implement on Opus)

Round-9 review of `c8a50936a5` (`review-6834-r9`) closed Y/Z/AA/AB/AC and
found AD–AH. Nine rounds have each closed one refusal and exposed the next in
the same class: the dynamic-conditional admission lets a closure that **mints a
dynamic-shaped local** (`D` = `var r = m ? m : 1`) reach from-ast, and every
construct in that body that from-ast cannot lower for a dynamic or
reference-typed value becomes a claim-then-demote. The base refused every such
closure wholesale at the conditional, so refusing more `D`-closures can never
lose a base claim. Enumerating refusals does not converge; this round inverts
the rule.

### 1. Positive admission for `D`-closures (replaces the refusal half of the
null / write / `??` rules; closes AD, AE, AF)

Add `plannedClosureValueFamilyAdmissible(body, scope)` in `src/ir/select.ts`,
evaluated once when `dynamicConditionalValuePosition` would mint the local
(before the move-only scan). It walks the closure body and admits only when
**every** value that flows into a slot or an operator has a selector family in
the lowerable set:

- declarations (`var`/`let`/`const`) and `=` / `+=` writes into a closure
  local: RHS family ∈ {`number`, `boolean`, `string`, `undefined`, the dynamic
  value itself or its aliases, an array literal whose elements are all
  `number`} — `obviousSelectorValueFamily`, with one identifier hop through
  `closureLocalDeclaration` to the declaration's own admitted family (an alias
  of an admitted local is admitted; an alias of anything else is not);
- a `"reference"` family anywhere (object / function / arrow / class literal,
  array literal with a non-number element) → refuse (AD, AE rows 1–2);
- numeric prefix unary (`- + ~`) and arithmetic whose operand family is not
  `number`/`boolean`/dynamic → refuse (AE row 3);
- `??` anywhere in the closure → refuse (AF; `lowerNullish`
  from-ast.ts ≈15686–15697 lowers only an extern/externref/ref_null left, and
  no planned-closure value lowers to one — cite it);
- call results, member/element reads, `typeof`, comparisons, `!`, `.length`,
  `throw`, `return`, `if`/`while`/`for`, `catch` bindings, discarded
  expressions: admitted exactly as the r9 head admits them today (they are
  measured claims in probes 7–19; do not widen or narrow them here).

One reason code, `expr-closure-value-family-unproved`, one JSDoc listing the
admitted families with the from-ast sites that lower each. Then **delete** the
refusal spellings this subsumes: the `"reference"` and loose-operand tests in
`nullCompareFoldFails` keep only the nullish-other-operand and loose-on-dynamic
limits (strict equality against an admitted family is folded by
`tryFoldNullCompare`); the `??` arm in `isPhase1Expr`'s binary case goes
(subsumed); `closureWriteUnlowerable` keeps the operator half. No two spellings
of one limit may remain — grep the reason codes.

Must keep claimed (measured on the base or kept since r4, see
`probe*-r9-head.txt` claimed rows): the 27 `+=` admissions of probe9, the
`k`/`q`/`b`/`c`/`m.length`/`k + 1`/`!r`/array-local equality folds of probe15,
`catch (e) { e === null }`, `throw (1, null)`, `subject() == null`, every
no-`D` closure (the rule applies only to `D`-closures).

### 2. AG — value-position `void`

`closureNullValuePosition`: climb a `VoidExpression` unconditionally and
`return true` at it — from-ast's value `void` (≈5321–5324) discards its operand
in every position, so the `null` is never the failing node. Keep the
conditional-arm climb discarded-only (measured right: `throw k ? null : m`
withdraws on the base). `throw void null` then re-admits and withdraws like the
base's `throw void 0` (PCE on both trees): extend the scalar-throw refusal
(`isPhase1ThrowStatement`, `throw-closure-concrete-scalar`) to a
`VoidExpression` operand — an f64 NaN throw value is "throw val not in slice 9"
whatever sits under the `void`. Rows: positive `if (void null) throw "n"`,
`if (void null === null)`; refusal `throw void 0`, `throw void null`.

### 3. AH — JSDoc

Say that a value `void` discards its operand (≈5321–5324) and that the throw of
the resulting NaN is the throw-value rule's; drop the "only while discarded"
sentence for `void`.

### 4. Residual to record (not fixed here)

`void 0 == null` / `void 0 != null` were base **miscompiles** (`ran=0`, node
1): `tryFoldNullCompare` constant-folds the f64 NaN sentinel as non-nullish.
The positive rule refuses them (legacy = node). Record the two repros under
"Residual" as a from-ast fold bug for the lead to file.

### Validation

As round 9, plus: probes 7–19 head vs base (`refresh-6832` @ `1f01ea20`) —
**zero PCE rows beside `D` on any lane** (that is the acceptance for the
inversion), zero lost base claims, host-assisted gc and fast bytes identical;
list every r9-head claim the new rule drops, each with its base status (base
refused = acceptable; base claimed = blocking, fix the allow-list). Gates as
round 9 incl. `LOC_GATE_BASE=origin/main` on a throwaway main merge.

## Acceptance

- `tests/issue-7106-member-closure-shapes.test.ts`: a throw-only member
  closure, and a closure assigning `message = message === undefined ? '' : message`
  together with `value ? value : 7`, are both prepared `<module-init>` IR
  bodies. Results match node. Refusal rows (`throw 42`, `throw 1` after a
  conditional throw, the typed-slot sink, `m ? m : undefined`) are refused at
  select with no post-claim withdrawal on standalone and gc native-first; the
  host-assisted gc lane mints no plan (bytes identical to the base, measured).
- (Round 9) A discarded `null` (`null;`, `(1, null);`, `throw (null, m)`,
  `void null;`, `k ? null : 1;`) is a prepared `<module-init>` body, = node.
  `var o = { a: 1 }; o === null`, `m.x == null` and `var t = r ?? 1` beside
  the minted dynamic local are refused at select with no post-claim
  withdrawal on standalone and gc native-first.
- (Round 10) A closure that mints a dynamic-shaped local is admitted only
  when every value it represents is in the lowerable family set
  (`plannedClosureValueFamilyAdmissible`, `expr-closure-value-family-unproved`).
  Refused at select with no post-claim withdrawal on standalone and gc
  native-first: an aliased object local and an object-valued property
  compared with `null`, an array of objects, an object written into `var o;`,
  unary `-` of an object, `r.x ?? 1` and `s ?? "b"` (`??` is refused in every
  planned closure), a dynamic sum written into a string slot, a write into a
  `const` local, `r += [4]`, `throw void 0` and `throw void null`; in every
  planned closure also a value `void` as a declaration initializer
  (`var t = void null`) and a chained write over slots of different types
  (`var s = "a"; var r; s = r = m`). A `null`
  under a value-position `void` (`if (void null)`, `while (void null)`,
  `(void null) ? 1 : 2`, `!(void null)`, `void null === null`) is a prepared
  `<module-init>` body again, = node.
- Census on the Test262Error-stripped probe: the next `<module-init>` blocker
  is `var format = compareArray.format;`. That is a function-object member
  READ (`expr-ident-not-in-scope «compareArray»`), followed by `format(…)` on
  a dynamic local. Both belong to Stage 2's function-object surface, so this
  slice leaves them for that owner.

## Residual (round 10, not fixed here)

- **`void 0 == null` / `void 0 != null` miscompile on the base.** In a planned
  member closure, `if (void 0 == null) throw "n"; throw m;` was claimed by
  the base (`1f01ea20`) and returned 0 where node returns 1 (and the `!=`
  twin likewise): `tryFoldNullCompare` (from-ast.ts:16115-16213)
  constant-folds the f64 NaN that `void 0` lowers to as non-nullish, so
  `undefined == null` folds to `false`. The positive loose-operand rule in
  `nullCompareFoldFails` refuses both today (legacy body, = node). The fold
  itself is a from-ast bug for the lead to file: a loose null compare
  against `void <expr>`, or any f64 "undefined sentinel", must fold to
  `true` / `false` the other way round, or bail.
- **wasi `call-graph-closure` (class P).** A direct call to a top-level
  function inside a planned closure (`r += subject()`, `subject() == null`,
  `var o = subject()` beside the minted local) claims and withdraws on wasi
  only — `direct call to "subject" has no exact AST-site plan`
  (from-ast.ts:7862-7867) — and claims, = node, on standalone and gc. The
  no-`D` twin `m += subject()` withdraws identically on the base, so this is
  the wasi lane's missing direct-call plan, not a family limit; the selector
  has no lane signal to refuse it on wasi alone, and refusing it everywhere
  would drop the standalone / gc claims.

## Addendum (2026-10-22): `message.toString()`

The #7110 dynamic-method refusal is merged into this branch. It refuses
method calls on dynamic receivers inside planned member closures, because the
IR's dynamic method call returns `undefined` for primitive and vec receivers.
With it in place, the stripped-probe census stops at
`assert.compareArray`'s `message = message.toString();` (assert.js:151,
`closure-member-dynamic-method`), before reaching
`var format = compareArray.format;`. This slice's two shapes, the throw-only
plan and the dynamic-arm conditional, are unaffected.

## Implementation Plan: round 11, rebuild on #7144 (C, 2026-10-26)

The stakeholder decided on 2026-10-26 that [#7144](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7144-ir-shared-operand-admissibility-predicate) lands first and #6834 is then rebuilt on top of it. Round 11 replaces #6834's hand-written refusal logic with the shared predicates in `src/ir/analysis/operand-admissibility.ts` and adds only the missing rules. Inputs:
- the #6927 review section "Readiness for the #6834 rebuild" (round 1);
- the round-2 and round-3 reviews.

### 0. Base
- Merge origin/main, which contains #7144, into `claude/7106-module-init-member-shapes`.
- Resolve conflicts in `src/ir/select.ts`, `src/ir/select-planned-closure-operands.ts` and `src/ir/from-ast.ts` by **taking #7144's shared predicates**. Do not keep both mechanisms.
- Then run `npm run -s check:dead-exports`. A supersede-style merge leaves the old twins' exports unreferenced, and that fails `quality`.

### 1. Delete in favour of the shared walk
#7144 already covers these, so delete #6834's own versions:
- `plannedClosureWriteProved`;
- the operator arm of `plannedClosureValueAdmitted`;
- the `??` arm;
- the families inside `nullCompareFoldFails`.

This covers round-10 findings AI, AJ and AF, which are operator, write, increment, `??` and null-compare typing inside a closure that mints a dynamic local (`var r = m ? m : 1`). They map onto these predicates: `binaryOperandsAdmissible`, `compoundWriteAdmissible`, `slotWriteVerdict`, `incrementSlotAdmissible`, `nullishLeftAdmissible` and `nullComparisonFolds`.

### 2. New shared rules (add to `operand-admissibility.ts`; both the selector and from-ast read them)
1. **`conditionalJoinFamily(whenTrue, whenFalse)`.** It returns `dynamic` when one arm is dynamic and the other passes `boxableIntoDynamic`.
   - A `void` arm is family `"undefined"`, so `m ? m : void 0` must box a real undefined into the carrier and never mint NaN. Assert this.
   - Use it in `operandProof`, which today returns `unknown` for mismatched arms at `select-planned-closure-operands.ts:212`.
   - Use it again where from-ast lowers the join to the carrier.
2. **`throwOperandAdmissible(family)`** for member-closure throw-only. It admits externref, dynamic and string, and refuses scalar `throw`, which stays a left-out class. Share it with `lowerThrowStatement`.
3. **Loose `==`, `in` and regex on the carrier.** They fail at preparation on standalone and gc because of the `__ir_dyn_call_box` / `__dyn_member_get` ABI gap. Gate them with a lane capability through `supportsBackendCapability`, or with a refusal predicate, so they are refused at select and never claimed and then withdrawn.

### 3. Still out of scope (list under Left out)
- element and member stores;
- element reads;
- `switch` on the carrier;
- the wasi direct-call plan;
- `(void 0 as any) == null` (#7144 N2);
- the shadowed `let undefined` legacy miscompile (#7144 round-3 NIT 2, pre-existing).

### 4. Acceptance
- **Probes:** the p7–p24 probe matrix and the #6927 reviewers' probes (scratchpad `6927-adv1/2`, `r2-*`) on standalone, wasi and gc native-first must show:
  - 0 new post-claim errors;
  - 0 IR-claimed results that differ from node;
  - no claim lost against the #7144 merge base, unless it is listed with its reason.
- **New tests**, covering the closure shapes from round 10 and:
  - `m ? m : void 0`, then observed;
  - `throw` of a dynamic or string value in a member closure;
  - a loose `==` on the carrier, refused on standalone and gc.
- **Bytes:** unoptimized output is byte-identical to base on a sample of playground and equivalence programs. Report native gc, standalone, wasi and fast separately. Note that the host-assisted lane was removed by #6979.
- **Gates:** every gate run bare (loc, func with both bases, coercion-sites, oracle-ratchet, dead-exports, import-cycles, ir-layering, `check:ir-fallbacks`), and the equivalence gate with no new failures.
- **Review:** keep `hold` until C's fresh-context review records a verdict.

## Round 11 — result (Opus, 2026-10-26)

Rebuilt on origin/main `00adb35c26` (contains #7144). The merge had no
textual conflicts; it left two compile errors (`isEqualityOperator` declared
twice, `isPhase1CompoundAssignOperator` renamed by #7144), both resolved by
taking #7144's spelling.

**Deleted from `select.ts`** (the shared walk now owns them):
`plannedClosureWriteProved`, `plannedClosureConcreteFamily`,
`closureWriteUnlowerable`, `writtenValue`, `plannedClosureChainTargetsShareSlot`,
`closureNullValuePosition`, `nullCompareFoldFails`, `nullCompareOperandSources`,
`plannedClosureVoidValueUnlowerable`, `isPlannedClosureArithmeticOperator`,
`isAssignmentOperatorKind`, `isPrimitiveLiteralArm`, the local
`isEqualityOperator`, the `throw-closure-concrete-scalar` block, the `??` arm
(`expr-closure-nullish-coalesce`), the `null` / `void` value arms and the chain
check. `plannedClosureValueFamilyAdmissible` keeps only what no operand family
carries: reference literals, array element evidence, declaration initializers,
unary operands and `const` writes. `isForIncrementorClause` moved into the walk.

**Added to `analysis/operand-admissibility.ts`:**

| Predicate | Read by |
| --- | --- |
| `conditionalJoinArmFamily`, `conditionalJoinFamily` | selector shape, the walk's `operandProof`, from-ast `tryLowerDynamicConditionalValue` |
| `throwOperandAdmissible` | the walk, from-ast `lowerThrowStatement` |
| `carrierHelperOperator` (+ capability `prepared-dynamic-helper-abi`, true on WASI only) | the walk |
| `storeAdmissible`, `switchDiscriminantAdmissible`, `dynamicCallArgumentAdmissible` | the walk |

The last four have no single from-ast site to share. They name from-ast
withdrawals that the selector reaches only on a dynamic carrier:
- "property assignment on dynamic";
- `element-store-unsupported`;
- "switch disc must lower to i32/f64";
- "array literal flows into a widening sink".

The preparation gap is a lane fact, not a from-ast rule. A value `void` arm of
the join now yields `dyn.undefined` (asserted by a test: `typeof r ===
"undefined"`, `r === undefined`). It never yields the NaN. The walk also types
the unshadowed `undefined` identifier as the carrier, as from-ast lowers it.

**Probes** (p7, p9–p24, `6927-adv1`, `6927-adv2`, `r2-probe`, round-11 rows):
1,430 rows × standalone / wasi / gc. Compared with origin/main (base) and
with `f1bf7dae9d` (round 10, old):

- **New post-claim errors vs base:** 7, all on wasi and all class P (a direct
  call to `subject()` in a minting closure). The old head had the same 7. This
  is still left out.
- **IR-claimed results ≠ node:** 17. All 17 are pre-existing and
  byte-identical on base:
  - 11 are p7 gc rows where the probe harness's throwing import stub fires
    (`stub:env.__boundary_object_set`; legacy on base hits it too);
  - 6 are the top-level `F_asV` (`(void 0 as any) == null`, #7144 N2) and
    `F_assignVnum`.
- **Lost claims:** 0 vs base. 90 row-lanes vs old, and on every one of them
  the head matches base. They are #7144's `void` / write rules (finding A)
  applied to closures the old head claimed.
- **Changes vs base:** 966 newly claimed row-lanes, and 567 row-lanes whose post-claim error is gone (now refused at select or lowered).

**Bytes** (unoptimized, 111 playground and equivalence units): identical to
base on native gc, standalone, wasi and fast.

**Left out:** element / member stores beyond the carrier refusal, element
reads, `switch` on the carrier (refused, not lowered), the wasi direct-call
plan (class P), `(void 0 as any) == null` (#7144 N2), and the shadowed
`let undefined` legacy miscompile
([#7175](7175-shadowed-undefined-compare-legacy-wrong.md)).
