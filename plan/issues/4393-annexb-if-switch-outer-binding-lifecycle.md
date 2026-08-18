---
id: 4393
title: "Annex B function-scope if/switch declarations skip outer-binding lifecycle"
status: done
sprint: 78
created: 2026-08-12
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: annex-b, function-declarations, hoisting
goal: es5
assignee: ttraenkler/codex-es5-annexb-function
related: [1518, 2200, 2552, 4166]
files:
  - src/codegen/annexb-cancel.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements.ts
  - src/codegen/statements/nested-declarations.ts
  - tests/issue-4393-annexb-if-switch-lifecycle.test.ts
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
---

# #4393 — Annex B function-scope if/switch outer-binding lifecycle

## Problem

Annex B B.3.3 gives a sloppy function declaration in a statement position a
second, var-scoped binding in the enclosing function. That outer binding must
exist as `undefined` when the function activation begins, remain mutable, and
receive the function value only when control evaluates the declaration.

The current Phase-2 allocator in
`src/codegen/statements/nested-declarations.ts` recognizes only a declaration
whose direct parent is an explicit `Block`. It therefore misses the other two
statement-position shapes already recognized by the canonical
`annexBDeclaringRange` helper: an Annex B `if` arm and a `switch` case/default
clause. Those declarations follow ordinary eager function hoisting instead, so
a read before their statement evaluates observes the function object rather
than `undefined`.

## Fresh standalone evidence

Baseline: `origin/main` `a28c6bfcb3df2e61dcfd63a7baddfb0d5d33c711`,
published standalone oracle v13 fetched 2026-08-12. The complete maintained
ES5 failure population in the assigned directories is 77 rows: 47 under
`language/statements/function` and 30 under
`annexB/language/function-code`.

The precise root-cause family is eight `*-func-init.js` rows:

- `block-decl-func-init.js`;
- five `if-*` declaration-position variants;
- `switch-case-func-init.js`;
- `switch-dflt-func-init.js`.

The baseline JSONL grouped `block-decl-func-init.js` by its first assertion, but
execution exposed the same assignment-lifecycle failure at its second
assertion. All eight therefore share one implementation root. The originally
claimed seven `if`/`switch` rows fail before the declaration is evaluated: the
five `if` rows report `Expected SameValue(function, undefined)` and the two
switch rows report `ReferenceError: f is not defined`.

## Implementation boundary

Use `annexBDeclaringRange` as the single definition of an eligible Annex B
statement position, preserving the existing cancellation, observation,
reassignment, lexical-binder, and same-name-var guards. Recursively collect
direct `if`-arm declarations, mark ordinary assignments as writes to the
synthetic outer binding, and prevent function-local Annex B bindings from
escaping their owning activation. Do not add test-name or path-specific
handling.

These generated tests execute inside a top-level synthesized IIFE. Today that
IIFE and its lifted declaration bodies are created before a source-function
body can be claimed by the function IR pipeline, so this is an AST
hoist/lifecycle boundary rather than an IR lowering site. When synthesized
IIFEs and Annex B binding instantiation become IR-owned, the lifecycle operation
must move with them; this issue must not create a second IR-invisible semantic
implementation.

## Acceptance criteria

- [x] All seven maintained ES5 `if`/`switch` `*-func-init.js` rows pass in the
      standalone lane.
- [x] The explicit-block lifecycle twin passes its complete lifecycle, including
      the assignment assertion hidden by the baseline's first-error grouping.
- [x] The affected declarations read as `undefined` before evaluation, accept
      an ordinary assignment, and receive the function value only at the
      declaration site.
- [x] A same-SHA standalone comparison of the full 159-file Annex B
      function-code directory has zero pass-to-nonpass regressions.
- [x] Focused host and standalone tests prove the three declaration positions
      without host imports in the standalone artifacts.

## Result

On the implementation SHA, the focused regression is 18/18: the eight
lifecycle files pass in both host and standalone lanes, and a representative
existing-direct-function case remains passing in both lanes. The fresh
same-base standalone comparison over all 159 Annex B function-code files moves
from 128 to 146 passes: 18 non-pass-to-pass transitions and zero
pass-to-nonpass regressions.

## Merge-queue trap repair implementation plan

The first merge-group validation of PR #4428 proved that the semantic gain is
real but exposed one unsafe existing-binding edge. The content-current host
comparison gained 35 passes with zero pass-to-nonpass transitions, while the
uncatchable-trap ratchet found two new `null_deref` results:

- `switch-case-func-existing-fn-no-init.js`;
- `switch-dflt-func-existing-fn-no-init.js`.

Both files already failed on the baseline, but changing a normal JavaScript
failure into an uncatchable Wasm trap is forbidden. They declare an outer
function directly in the IIFE body and an inner same-name Annex B function in a
switch clause. The current repair recognizes that existing direct function
only when `annexBDeclaringRange` returns the declaration itself (the implicit
`if`-arm block). For a switch clause it returns the surrounding `CaseBlock`, so
the recursively visited inner declaration can still replace or mask the
already-instantiated outer function binding.

Implement the follow-up in this order:

1. In `nested-declarations.ts`, make the same-name direct-function guard apply
   to every canonical Annex B declaring range, including explicit blocks and
   switch case/default clauses. Reuse `annexBSameNameDirectFunctionInScope`;
   do not add test-name or path checks. Represent this case with a separate,
   initialized live binding seeded from the existing direct function rather
   than reusing the undefined/TDZ-like synthetic Annex B binding.
2. Do not blanket-skip the recursively visited declaration. The direct
   declaration must retain ownership of the name-keyed eagerly initialized
   hoist slot. Defer each safe inner block/case declaration until its statement,
   compile and cache that exact declaration separately, restore the canonical
   name-keyed metadata afterward, and write the distinct closure to the live
   binding when B.3.3.1 step 3 evaluates that declaration.
3. Cover the exact `block`, `if`, switch `case`, and switch `default`
   `existing-fn-no-init` rows and their corresponding `existing-fn-update`
   rows in both host and standalone lanes. Keep the original eight lifecycle
   rows green as well.
4. Re-run the focused suite, typecheck, issue integrity, IR-fallback and budget
   gates. Then repeat the complete 159-file Annex B function-code comparison
   on the same base/candidate pair in the host lane that triggered the ratchet;
   confirm zero pass regressions and zero `null_deref` growth. Recheck the
   standalone slice as a cross-lane control.
5. Push the fix to PR #4428, let fresh PR checks settle, and remove `hold` only
   after the exact head SHA is green. The server-side workflow, not an agent,
   owns merge-queue enqueueing.

This remains an AST binding-instantiation boundary. It must not create a
legacy-only implementation of semantics that an IR-owned source function
already handles; when synthesized IIFEs become IR-owned, this single lifecycle
decision moves with that boundary.

## Suspended Work

Work was suspended at a coherent, uncommitted checkpoint on 2026-08-13:

- worktree:
  `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm/worktrees/codex-es5-annexb-function-cluster-20260812`;
- branch: `codex/4393-annexb-if-switch-lifecycle`;
- preserved branch tip: `6e7ffc2ffd98c58bbf1359b12e40be0be67aaecc`;
- focused Test262 regression suite: 48/48 passing, covering the eight original
  lifecycle rows plus all eight `existing-fn-no-init` and all eight
  `existing-fn-update` shapes in both host and standalone lanes;
- `pnpm run typecheck`: passing;
- `pnpm run check:issues`: passing;
- `pnpm run check:ir-fallbacks`: passing;
- `pnpm run check:loc-budget`: passing;
- `pnpm run check:func-budget`: passing after extracting the new
  statement-time update path from `compileStatementInner`;
- `git diff --check`: passing.

Remaining work is deliberately not claimed as complete: run the exact
same-base/candidate 159-file Annex B function-code A/B in host and standalone,
confirm zero pass-to-nonpass transitions and zero `null_deref` growth, review
and commit the checkpoint as Thomas Tränkler with the Codex co-author trailer,
push PR #4428, wait for fresh checks on the exact pushed SHA and a CLEAN merge
state, then remove `hold`. Do not manually enqueue the PR.
