---
id: 6994
title: "codegen: a block-scoped `let`/`const` that shares its name with a module global, module function or nested function declaration leaks a never-assigned hoisted slot past its block (post-block reads see 0/null/trap) and, inside the block, a call resolves to the nested declaration instead of the block's own closure (hoistLetConstWithTdz pass 2 + saveBlockScopedShadowsForNames; call-identifier nestedBindingVisible)"
status: ready
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
