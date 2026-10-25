---
id: 7113
title: "IR: throw-only member closures (void plan) and dynamic-arm conditional values"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-25
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
- Census on the Test262Error-stripped probe: the next `<module-init>` blocker
  is `var format = compareArray.format;`. That is a function-object member
  READ (`expr-ident-not-in-scope «compareArray»`), followed by `format(…)` on
  a dynamic local. Both belong to Stage 2's function-object surface, so this
  slice leaves them for that owner.

## Addendum (2026-10-22): `message.toString()`

The #7110 dynamic-method refusal is merged into this branch. It refuses
method calls on dynamic receivers inside planned member closures, because the
IR's dynamic method call returns `undefined` for primitive and vec receivers.
With it in place, the stripped-probe census stops at
`assert.compareArray`'s `message = message.toString();` (assert.js:151,
`closure-member-dynamic-method`), before reaching
`var format = compareArray.format;`. This slice's two shapes, the throw-only
plan and the dynamic-arm conditional, are unaffected.
