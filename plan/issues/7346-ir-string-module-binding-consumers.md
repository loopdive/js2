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
