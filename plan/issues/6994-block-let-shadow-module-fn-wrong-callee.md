---
id: 6994
title: "codegen: a block-scoped `let`/`const` that shares its name with a module global, module function or nested function declaration leaks a never-assigned hoisted slot past its block (post-block reads see 0/null/trap) and, inside the block, a call resolves to the nested declaration instead of the block's own closure (hoistLetConstWithTdz pass 2 + saveBlockScopedShadowsForNames; call-identifier nestedBindingVisible)"
status: done
completed: 2026-10-15
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: scoping, let-const, shadowing, function-declarations
goal: core-semantics
related: [5271, 817, 428]
loc-budget-allow:
  # 2026-10-15 (#6994): call-identifier.ts +3 — the lexical-precedence test at
  # the nested-declaration scope check (helper lives in
  # function-declaration-observation.ts). index.ts +~14 — the pass-2 reserved
  # set in hoistLetConstWithTdz threaded through walkStmtForLetConst; restated
  # here so the grant does not strand on #3518's file.
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-10-15 (#6994): +2 lines, the shadow test folded into the existing
  # out-of-scope flag (no new flag).
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
---

# Block-scoped shadow of a module/nested function binding resolves wrong

Found by the 2026-10-15 audit (scoping lane). Both lanes.

## Repro (node → wasm)

```ts
let f = 1;
export function test(): number { let r = 0; { let f = 7; r = f; } return r*10 + f; }  // node 71, wasm 70 (post-block f reads 0)
```
```ts
export function test(): number {
  function f(): number { return 1; }
  let a = f(); { let f = (): number => 2; a += f()*10; } return a + f()*100;
}  // node 121, wasm 111 — the inner f() inlines the nested declaration
```
Module `function f(){return 1}` + block `let f = () => 2`: post-block `f()` traps (WebAssembly.Exception). Nested `function f` + block `let f = 7`: post-block `f()` → null.

## Root cause

(a) `src/codegen/index.ts:15163-15192` — `hoistLetConstWithTdz` pass 2 recurses into nested blocks and claims a FUNCTION-level slot per name (`walkStmtForLetConst`, :14946). At block entry `saveBlockScopedShadowsForNames` (`src/codegen/statements/shared.ts:185`) saves that pre-hoisted slot as if it were the outer binding, and `restoreBlockScopedShadows` (:277-295) reinstalls it after the block — so post-block reads hit the never-assigned hoisted local instead of the module global / function binding.
(b) `src/codegen/expressions/call-identifier.ts:1773-1880` — `nestedBindingVisible` (a nested `function f` declared anywhere in the enclosing function) forces `closureInfo = undefined` and skips `resolveClosureInfoFromLocal`, so the block's own `let f = () => 2` is ignored and the call inlines the nested declaration. WAT shows `r = f()` lowered to `f64.const 1` with the closure sitting unused in a second `$f` local.

## Implementation Plan

1. (a) In `hoistLetConstWithTdz` pass 2, do NOT pre-register a function-level `localMap` entry for a nested-block `let`/`const` whose name is ALSO a module global (`ctx.moduleGlobals`/`ctx.capturedGlobals`), a module function (`ctx.funcMap`), or a nested function declaration in the same function. Either skip the pre-hoist for those names (the block-entry `preallocateBlockScopedSlots` in `statements/shared.ts` already allocates a slot at block entry — verify it runs for these names) or make `saveBlockScopedShadowsForNames` record "no outer local" (`undefined`) when the pre-hoisted slot was never assigned, so `restoreBlockScopedShadows` deletes the `localMap` entry instead of reinstalling the dead slot. Prefer the second: it is the save/restore pair that lies.
2. (b) In `call-identifier.ts`, make the precedence explicit and lexical: a `localMap`/closure binding that is in scope at the call site (block-scoped `let`/`const` closure) wins over `nestedBindingVisible`; only when no such local binding exists does the nested declaration apply. There is a precedence ladder (funcMap / closureMap / localMap) in that file — write it down in a comment at the decision point and add the missing case rather than another flag.
3. Tests: the four repros plus `fn-decl-hoisted-over-let-shadow-in-block` (nested function declared AFTER the block shadowing it) and a var shadow of a module function (`var f = 2; return f` inside the function, node TypeError when called — only assert the value read, not the throw).

## Acceptance

- Repros match node on standalone and gc.
- `tests/equivalence/*shadow*`, `*block-scope*`, `*tdz*` pass (TDZ throws remain known failures; do not change them here).
- No change in `scripts/equivalence-baseline.json` known failures except removals.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6994-block-let-shadow-module-fn-wrong-callee.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

Both halves shipped; one adjacent residual of (a) is left (see below).

**(a) post-block leak — save/restore no longer reinstalls the block's own
pre-hoist slot.** `blockOwnPreHoistedNames` (`statements/shared.ts`) returns
the block's direct `let`/`const`/`using` names whose live `localMap` entry is
that declaration's own `preHoistedLetConstSlots` record (same
`preHoistedBindingIsLive` test the CaseBlock path already uses).
`saveBlockScopedShadowsForNames` takes that set: those names are hidden as
before but recorded as having NO outer binding, so the block's exit forgets
them and later reads fall through to the real binding (module global / module
function). `saveBlockScopedShadows(fctx, block)` passes the set itself, so the
plain block, try/catch/finally blocks and loop bodies (loops.ts:152, unedited)
all get it; the plain-block path in `statements.ts` now calls
`saveBlockScopedShadows`.

**(a') nested function/class declaration of the same body.** For
`function f(){…}` + `{ let f = 7 }` the save/restore fix is not enough: pass 2
of `hoistLetConstWithTdz` claimed `f` before `hoistFunctionDeclarations` ran,
and the declaration then adopted the block's slot and TYPE (gc: invalid Wasm
`local.tee expected f64`; standalone: `null`). Pass 2 now skips names declared
by a function/class declaration directly in the hoisted statement list
(`reserved`, threaded through `walkStmtForLetConst`); the block binding gets
its own slot at block entry (`preallocateBlockScopedSlots`) like any genuine
shadow. Pass 1 and block-entry preallocation are unchanged. Module globals are
deliberately NOT reserved: measured, that breaks a block function declaration
capturing a block `let x` beside a module `x` (#5271 F1 pinning: 107 → 200).

**(b) call precedence.** In `compileBoundIdentifierCall` the nested-declaration
scope check now also treats the declaration as out of scope when the callee
resolves lexically (`ctx.oracle.valueDeclarationOf`) to a block-scoped
`let`/`const` binding other than that declaration
(`blockBindingShadowsNestedDeclaration`, function-declaration-observation.ts).
Ladder at that decision point: the binding the identifier resolves to
lexically wins; a nested declaration is consulted only when it is in scope AND
not shadowed by an in-scope block binding; otherwise the closureMap / local /
funcMap paths run in their existing order. Folded into the existing
`isOutOfScopeNestedBinding` flag — no new flag.

**Measured.**
- `tests/equivalence/issue-6994-block-let-shadow.test.ts`: 14 shapes × 2 lanes,
  28/28 — the four issue repros, `fn-decl-hoisted-over-let-shadow-in-block`, the
  `var` shadow of a module function (value read only), module `const`,
  sibling blocks, nested function used as a value / with a capture / vs a block
  `const` function expression, block function declaration vs inner block
  `let`, and the #5271 F1 guard (block function capturing a block `let` beside
  a module global). On base 12 of these 14 differed on at least one lane
  (only the module-function-vs-block-number and `var` cases matched).
- JS (cf-harness, both lanes): `{ let x } … x` now throws ReferenceError like
  node (base read 0 from the dead slot), `var y` global read after a
  same-named block `let` and a post-block read beside a closure built in the
  block now match node; `typeof` after the block and an Annex B block function
  beside a block `let` are unchanged and correct.
- Byte-identity: 400 equivalence-test sources × 2 lanes (776 successful
  compiles) hash identically base vs fix — the change only alters output for
  programs that reference the shadowed name outside the block or declare a
  same-named function/class in the enclosing body.

**Residual (not fixed, documented):**
1. PRE-block reads of a module global shadowed later by a block `let` still see
   the dead function-entry slot: `let f = 1; function t(){ const b = f; { let f
   = 7 } return b }` → 0 (node 1). Same root cause (the pass-2 pre-hoist is
   visible function-wide), but the slot must stay in `localMap` until
   `hoistFunctionDeclarations` has pinned block-function captures (#5271 F1),
   which runs at ~20 hoist call sites. Fix shape: after the function-entry
   hoist phase, hide pass-2 claims from `localMap` (keep the records), so only
   block entry reinstalls them.
2. A closure built AFTER the block that reads the module global
   (`{ let f = 7 } const g = () => f; g()`) → 0 (node 1), pre-existing on base:
   the #1177 rescan in `closures/arrow-phases.ts` (localMap miss → find a
   `fctx.locals` slot BY NAME) picks the retired block slot. Not touched here
   (arrow-phases.ts is being edited by #6991/#6992); the rescan needs the same
   "is this slot's declaration in scope here" test.

