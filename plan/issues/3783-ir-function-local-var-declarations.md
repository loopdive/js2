---
id: 3783
title: "IR: adopt semantically local var declarations used by Acorn"
status: ready
assignee: ttraenkler/codex-ir-var
sprint: current
created: 2026-07-29
updated: 2026-08-09
priority: high
horizon: s
feasibility: medium
task_type: feature
area: ir, codegen
language_feature: variable-declarations
goal: ir-full-coverage
related: [1372, 2856, 2949, 2952, 3523, 3583, 4273, 4275]
loc-budget-allow:
  - src/ir/function-local-var.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - tests/issue-3783-ir-function-local-var.test.ts
  - scripts/gen-ir-adoption.mjs
  - plan/log/ir-adoption.md
---

# #3783 — IR function-local `var` declarations

## Problem

The IR currently rejects every `var` declaration even when its observable
behavior is identical to an already-supported mutable local. The direct path
therefore retains small Acorn helpers whose declarations do not depend on
hoisting, redeclaration, or function-scope escape.

The exact unchanged runtime-dynamic Acorn driver after #3801 reports 15 of 43
reachable functions emitted through IR. Of the 18 `body-shape-rejected`
outcomes, seven first reject at `vardecl-var-kind`:

- `isInAstralSet`
- `getOptions`
- `isPrivateNameConflicted`
- `checkKeyName`
- `buildUnicodeData`
- `__npmCompatStandaloneBenchmark`
- `<module-init>`

The module initializer must remain direct in this slice because its `var`
bindings are observable module globals. Some function bodies will expose a
later independent blocker after their first declaration is accepted; the exact
driver determines the net adoption change.

## Scope

Adopt only initialized identifier declarations whose `var` behavior can be
represented by the existing IR local/slot model:

- no duplicate declaration or parameter name;
- no read or write before the declaration;
- every use remains inside the lexical region represented by the IR binding;
- `for (var i = ...; ...; ...)` is allowed only when every use of `i` remains
  inside that loop;
- functions containing `for...of` remain direct in this first slice because a
  generator callee can still be withdrawn for ABI parity after selection;
- declarations in module initialization remain unsupported;
- destructuring, missing initializers, cross-block escape, and hoisting-sensitive
  forms remain on the direct path.

The selector owns the proof and must reject before claim. Lowering reuses the
existing mutable-local slot representation, including numeric i32 promotion
where its current proof applies.

## Slice 1 acceptance criteria

- [x] Selector tests cover accepted body-level, nested-block, and `for`-head
      declarations plus hoisting/redeclaration/scope-escape negatives.
- [x] IR execution matches JavaScript results for accepted numeric, branch, and loop
      cases.
- [x] Module-init `var` remains direct.
- [x] The exact unchanged Acorn outcome driver reduces function-local
      `vardecl-var-kind` blockers from six to zero with zero withdrawals and
      records the newly exposed later blockers.
- [x] Typecheck, fallback/adoption/oracle ratchets, IR-only status, formatting,
      and focused tests pass.
- [x] The adoption matrix records `VariableStatement` as mixed with this live
      owner until all remaining declaration forms are retired.

## #3796 integration constraints

PR #3796 remains the direct-backend Acorn performance baseline. This slice does
not modify its owned direct-codegen files:

- `src/codegen/expressions.ts`
- `src/codegen/typed-this.ts`
- `src/codegen/statements/control-flow.ts`
- `src/codegen/closed-method-dispatch.ts`

The final named runtime-dynamic reference is 48.970 ms/op versus Node
4.406 ms/op, checksum 422, zero imports, and zero reachable IR-emitted
functions. The stripped reference is 50.114 ms/op versus 4.424 ms/op,
1,765,609 bytes.

Retirement parity still requires:

1. proven f64 switch discriminants avoid boxing and type dispatch;
2. only twin-exclusive unguarded trampolines omit `__current_this`;
3. argc frames are omitted only under the existing safe argument constraints;
4. the native RegExp brand arm precedes field and user-method dispatch.

## Outcome

- Added a dedicated whole-function proof that certifies only initialized,
  non-redeclared `var` bindings whose uses occur after initialization and stay
  inside the IR-represented block or C-style loop region.
- Reused the existing mutable slot lowering and native-i32 loop-counter proof;
  no parallel `var` code generator was added.
- Kept use-before-init, cross-block/loop escape, missing initializers,
  redeclarations, nested captures, destructuring, and module-global `var` on
  the direct path.
- Exact Acorn census: `vardecl-var-kind` 7→1 (only `<module-init>` remains),
  `body-shape-rejected` 18→15, and 15/43 functions remain emitted with zero
  withdrawals. The six functions now expose their real next blockers:
  parameter-carrier evidence (3), empty object (1), chained assignment (1),
  and module-binding read (1).
- The wider equivalence sweep exposed eight legacy-only interactions. String
  and object loop conditions now use the matching IR `ToBoolean` lowering, and
  two-argument `String.indexOf` now boxes its numeric position for the existing
  host ABI. Class-instance array literals reject before claim until vec element
  reads preserve class metadata; `for...of` consumers remain direct until
  generator ABI withdrawal propagates to callers.
- Focused tests: 6/6. The eight new equivalence regressions all pass after the
  parity fixes or clean selector withdrawals. Related executable loop/control
  tests: 114/114; two
  additional WAT snapshots could not start because their hard-coded
  `/workspace/node_modules/.bin/wasm-dis` path is unavailable on this macOS
  worktree.
- Typecheck, fallback gate, adoption gate, oracle ratchet, LOC budget, function
  budget, Prettier, and targeted Biome lint pass.
- IR-only audit remains NOT READY at the existing boundary: 31/37 terminal
  playground units emit through IR, six are unsupported, and all 37 still emit
  legacy bodies.

## Remaining under this owner

- Model module-global `var` storage and hoisting before allowing it in the
  synthetic module-init unit.
- Re-enable `var` inside `for...of` consumers once generator ABI-parity
  withdrawal is represented in call-graph closure.
- Decide whether uninitialized, destructuring, captured, or cross-block
  function-scoped forms should gain exact IR storage or remain explicit
  unsupported shapes.

## 2026-08-09 exact ES2015 literal-harness evidence

#4275's direct-iterator assignment-destructuring audit found a concrete
pass-rate dependency on the remaining module-global arm. Its 15 resolved-target
fixtures place the `for-of` statement at script top level. The non-empty forms
declare `var x;` or `var _;` without an initializer; the empty `[]` forms still
share the literal Test262 runtime/assert/sta prefix, which contains top-level
`var` declarations.

An authentic production compile of
`language/statements/for-of/dstr/array-elem-iter-nrml-close.js` reports the
source-owned `<module-init>` terminal as
`body-shape-rejected / vardecl-var-kind:FirstStatement`, with
`legacyBodyEmitted=true`, `irBodyEmitted=false`, and no IR-compiled function.
The target loop has no smaller executable terminal in the current inventory.

This evidence does not reopen the completed function-local slice. It freezes
the next boundary: module-global `var` requires real hoisting/storage identity
shared with legacy and IR functions, and must compose with #3523's ordered
prepared module-init transaction. A function-local shadow is not a valid
implementation. Until that boundary lands, #4275's iterator operation can be
proved only as substrate and its 15 authentic Test262 rows remain uncredited.
