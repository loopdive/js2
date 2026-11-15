---
id: 7346
title: "IR: a string module binding is an ordinary string value at its uses"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [3523, 7125, 7252, 7292, 7106]
# 2026-11-15 (prototype): the resolver surface method `readsStringValue` (+15: interface,
# legacy resolver, owner-aware and legacy projections) and the selector's one consult in
# `moduleExternBinding` plus the capability-union line (+6). The decision itself lives in
# module-binding-string.ts.
loc-budget-allow:
  - src/ir/module-bindings.ts
  - src/ir/select.ts
# 2026-11-15 (step A): the one guard line that runs the string-use rules
# (`selectorRefusesStringUse`) beside isPhase1Expr's other pre-arm guards.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# #7346 — IR: consumers of a string module binding

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

A script `var` that holds a string (`var __str = String(1)`) binds as the
module value kind `string`. The selector treats that kind like an opaque host
reference: `isIrModuleReferenceValueKind` puts it beside `extern` and
`native-map`, so `moduleExternConsumerIsProven` (`src/ir/select.ts`) admits
only a pass-through, a call, and `=== null` / `=== undefined`. Everything else
is refused as `expr-module-extern-consumer`:

```js
var __str = String(1);
if (typeof __str !== "string") { … }   // refused
if (__str !== "1") { … }               // refused
if (__str.length !== 1) { … }          // refused
var t = " " + __str + " ";            // refused
```

The same expressions on a function-local string are lowered by the IR today.
The comment on `isIrModuleReferenceValueKind` already names the way out: a
site that earns a proven string lowering tests `valueKind.kind === "string"`
there, and the predicate is not widened.

## Measured

Census of 2026-11-14 (`plan/log/es5-ir-only-census-2026-11-14.md`, main
`8e2a65b374`); the counts below were re-derived from its raw rows on
2026-11-15.

| measure | files |
| --- | --- |
| carry `expr-module-extern-consumer` | 138 |
| it is the only remaining reason, in one unit | 49 |
| of those 49, every refused expression is a plain string use | 38 |
| of all 138, every refused expression is a plain string use | 78 |

"Plain string use" is a text filter, not a compile: no `.match(`, `.exec(`,
`.replace(`, `.split(`, `.index`, `.input`, `new`, or element access in the
refused expression. The most frequent refused shapes:

| count | shape | example |
| --- | --- | --- |
| 41 | `x !== "lit"` | `__str !== ""` |
| 36 | `typeof x !== "string"` | `typeof __str !== "string"` |
| 20 | `x.p !== y.p` | `__lowerCase.index !== __expected.index` (a match result, out of scope) |
| 8 | `x.length !== y.length` | |
| 9 | `a + x + b` | `" " + str + " "` |
| 6 + 4 | `x != y`, `x === y` | `str != strObj` (wrapper compare, out of scope) |

So the yield is at most 38 files alone, at most 78 together with other
levers. Neither number is a compile result.

## Implementation Plan

### Target structure

- **One decision, in the binding's own module.** A new sibling of
  `module-binding-vec.ts` and `module-binding-class-instance.ts`:
  `src/ir/module-binding-string.ts`, exporting one predicate that answers "is
  this read of a `string` binding an ordinary string value?". It is true when
  the read follows the declaration in module-init
  (`scriptVarUseFollowsDeclaration`, the rule the vec and class-instance homes
  already use) and every write of the binding is a proven string
  (`scriptVarWrites` plus the existing string classifier).
- **The selector stops treating such a read as an extern.** `moduleExternBinding`
  (and through it `expressionTouchesModuleExtern`) does not count a read the
  predicate accepts. The ordinary expression arms then judge the expression
  exactly as they judge a local string. No list of admitted consumer shapes is
  added to the selector: that would restate what from-ast lowers.
- **What it reuses.** `scriptVarUseFollowsDeclaration`, `scriptVarWrites`,
  `makeIrPrimitiveExpressionClassifier`, and the `string` arm of
  `resolveModuleBindingGlobal`, which already reads the slot as `IrType.string`.
- **What duplicate it removes.** None exists yet; the point is not to create
  one (a per-shape allow-list in `moduleExternConsumerIsProven`).
- **`typeof`.** `scriptVarUseFollowsDeclaration` refuses a `typeof` operand.
  For a string binding whose every write is a proven string and whose read
  follows the declaration, `typeof x` is the constant `"string"`. If from-ast
  already folds `typeof` of a string-typed value, pass a flag-free variant of
  the position rule (split the `typeof`/`delete` test out of the helper so each
  home states it); if it does not, leave `typeof` refused and report the count.
  Do not add a new lowering for it in this issue.

### Hazards to prove, not assume

1. **Unwritten slot.** The slot is a nullable reference. A read that can run
   before the write (a hoisted `var`, a use inside a function, a declaration
   in a branch) must stay refused; `reachableScriptVarHome` and the
   follows-declaration rule are the existing answers. Test rows for each.
2. **Arms never proven with a module string.** The comment on
   `isIrModuleReferenceValueKind` warns about an unboxed `throw` and numeric
   method dispatch. Measure: 0 post-claim errors on the population, and a
   matrix of at least 40 small programs (compare, `typeof`, `.length`, concat,
   `throw x`, `x.charAt(0)`, `x + 1`, `x < y`, `x ? a : b`, `!x`, `switch (x)`,
   argument to a local function, return from module code) answers as node does
   or stays refused at select.
3. **Loose equality with a wrapper** (`str != strObj`) and match-result
   members are out of scope and must stay refused.

### Lane

Standalone only, gated the way #7280 and #7340 gate theirs, so
JS-environment output stays byte-identical.

### Constraints

- No new host imports; no new lowering arms in from-ast.
- No unit that main lowers on IR may be lost; no new post-claim error; refuse
  at select, never claim and then withdraw.
- `select.ts` does not grow beyond a dated grant in this file.

## Acceptance criteria

Correctness:

1. Census on the 138 files plus 300 IR-only control files: report files gained
   IR-only, files lost 0, units newly legacy 0, new compile errors 0,
   post-claim errors not increased.
2. Verdicts of every routing-changed file are unchanged.
3. The probe matrix of hazard 2: nothing claimed answers differently from
   node.
4. JS-environment output byte-identical on the routing-changed files and on
   200 others.

Code quality:

5. The decision lives in `src/ir/module-binding-string.ts`, shaped like its
   two siblings; `moduleExternConsumerIsProven` gains no per-shape branch.
6. No selector-side copy of from-ast's string lowering rules.
7. A fresh-context adversarial review records its verdict in the PR body.

## Plan check (2026-11-15) — stopped before the full slice

A prototype on branch `claude/7346-string-module-binding` implements the plan's mechanism:
- `src/ir/module-binding-string.ts` decides when a read is an ordinary string value;
- the resolver exposes the decision as `readsStringValue`;
- `moduleExternBinding` drops such a read;
- the typeof/delete test is split out of `scriptVarUseFollowsDeclaration`;
- a standalone-only `module-string-value` capability gates it.

The mechanism holds where the plan expects it to: `typeof` folds to `"string"`, and compare, `.length`,
concat, `charAt`, `switch` and `<` all lower and answer as node does.

It does not hold everywhere, because several general arms claim and then demote a string value. They
already do this for a function-local string on main: `.constructor` / `.index` reads, `str == null`,
`s[0]` with an unproven index, and typed `+=`. Routing module strings to them carries those post-claim
errors over.

Measured on the 138 carriers plus 300 IR-only control files (head against main `6bab37c0cd`):

| measure | result |
| --- | --- |
| gained IR-only | +31 |
| lost | 0 |
| units newly legacy | 0 |
| new compile errors | 0 |
| new post-claim files | **7** (main 2, head 9) |

The 7 new post-claim files are:
- `.index` on a string: 4 files (`S15.5.4.1[6-9]_A1_T4`);
- `.constructor` on a string: `S8.4_A12`;
- `== null` on a string: `S8.4_A8`;
- `'+' operands not provably …`: `S8.4_A2`.

The two files `S13.2.1_A6_T1` / `T3` add a post-claim error in a reached function (typed `+=`) to the
same files' list.

Hazard matrix: 407 programs. Of the 172 admitted cells now claimed, 0 answer wrong. 10 cells have a
post-claim error on head only:
- `s[0]`;
- a dynamic-valued concat stored into a string slot. That is a write-admission gap: main post-claims the
  same write when nothing else refuses the unit.

## Step A: string uses the IR claims and then withdraws

Before #7346 routes module strings to the general arms, the selector refuses the string uses from-ast
cannot lower instead of claiming and withdrawing them. Local and module strings take the same rules.

**Where it lives.** `src/ir/select-string-uses.ts` holds the rules. The selector supplies two things:
- its string proof: `provenIrFamily(e) === "string"` or `expressionIsProvenString`;
- the unit's literal lengths.

Each rule asks the predicate that from-ast's own arm asks:
- **Member read,** other than a call's callee: `stringMemberReadLowerable`, newly in `capability.ts`.
  from-ast's `lowerPropertyAccess` now asks it too, in place of its inline `propName !== "length"`. No
  list of served members exists to share: a string's read surface is `.length`, and its methods are
  calls.
- **Element read:** `stringElementReadLowerable` over `collectStringLiteralLens(unit)`, plus the
  counted-loop proof. `detectCountedLoopSafeIndex` moved from from-ast to `fixed-literal-loop-proof.ts`,
  beside its helpers. `countedLoopProvesElementRead` reads that proof off the AST.
- **Equality with `null`:** `nullComparisonFolds(op, "string")` and `nullValueAdmissible("string")`.

**Gate.** The standalone-only `native-string-uses` capability, so JS-environment output is unchanged.

**Not built,** because from-ast has no table the selector can ask:
- **Typed `+=`.** from-ast decides from the slot's tracked string encoding (`inferStringEncoding` over
  `cx.scope` bindings, `proveTypedStringAppend`). That is flow state inside the lowering. A selector rule
  would copy it.
- **A dynamic-valued expression stored into a string slot.** The selector proves no `dynamic` family for
  a dynamic module binding read: `provenIrFamily` answers `unknown`, deliberately, per #5289. So it
  cannot see that `" " + d + " "` lowers to the carrier.

### Step A measured alone (2026-11-15)

Head is Step A without Step B's read hook. Main is `6bab37c0cd`. The set has 969 files:
- the 138 carriers;
- the 300 IR-only controls;
- the 31 files whose 2026-11-14 census row had a post-claim error;
- 500 further IR-only files, chosen with a seed.

| measure | result |
| --- | --- |
| IR-only files | 800 → 800 |
| gained / lost | 0 / 0 |
| units newly legacy | 0 |
| post-claim → refused at select | 0 |
| new compile errors | 0 |
| post-claim errors | 31 → 31 |
| routing-changed files | 0 |

None of main's 31 post-claim errors in this set is one of Step A's string shapes. Most are bare
`null`, mixed string/number equality, `throw`, and the typed `+=` that Step A does not build. So
Step A frees nothing in the census; it exists for Step B.

On small programs, Step A does refuse the shapes: a local `str == null`, `str.constructor` and
`a.index`.

**The hazard the coordinator named shows up there.** The refused function's IR caller, `<module-init>`,
which main claimed beside a withdrawn callee, now goes to legacy through the call-graph closure. The
census set contains no such case.

`tests/issue-2766` and `tests/issue-2972` fail 6 tests on main and on this branch alike. I checked by
swapping main's sources into the worktree.
