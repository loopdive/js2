---
id: 3472
title: "Function-expression/closure string param in native compound += emits invalid Wasm (blocks #3468 routing net-positive)"
status: in-progress
assignee: ttraenkler/senior-dev-3472
sprint: current
priority: high
horizon: m
feasibility: hard
relates: [3468, 3418]
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
---

# #3472 — funcexpr/closure string-param native compound `+=` emits invalid Wasm

## Summary

Under `--target standalone` (nativeStrings), a **function EXPRESSION / closure**
parameter used as a string in the native compound-assign fast path
(`m = ''; m += 'x'`) compiles to **INVALID Wasm**:

```
call[0] expected type (ref null 6=$AnyString), found local.get of type externref
```

A function DECLARATION with the same body is fine. This is the pre-existing
codegen bug documented in #3468's "MEASUREMENT (2026-07-19)" note as the blocker
that prevents the #3468 closure-own-property routing from being net-positive.

## Why this matters (relation to #3468 / #3418)

**The #3418 routing is already DONE and WORKS.** Verified on branch
`issue-3468-closure-own-props` (predecessor of this branch): the full test262
`assert`-harness shape round-trips through the C-core side table —

- `function assert(x){...}; assert.sameValue = function(a,b){...}` stores the prop,
- `assert.sameValue(2,2)` does NOT throw (returns normally),
- `assert.sameValue(1,2)` **THROWS a WebAssembly.Exception** (assertion now
  genuinely fires — no longer a vacuous pass).

The ONLY thing stopping #3468 from flipping the vacuous passes net-positive is
THIS bug: the real test262 `assert.sameValue` builds its failure message with

```js
if (message === undefined) { message = ''; } else { message += ' '; }
message += 'Expected ...';
```

`message` is a closure param (externref slot). When the routing makes the harness
actually compile+run that body, it hits this bug -> invalid Wasm -> the ~391
assert-using tests flip from vacuous-pass to fail-to-instantiate (a regression,
not a truthful correction). Fixing this bug is the true prerequisite that makes
#3468's routing land net-positive.

## Root cause

`compileNativeStringCompoundAssignment` in
`src/codegen/expressions/operator-assignment.ts` (~line 1281-1298):

```ts
// Load current value as ref $AnyString
if (localIdx !== undefined) {
  fctx.body.push({ op: "local.get", index: localIdx });   // <-- yields externref
}
...
fctx.body.push({ op: "call", funcIdx: concatIdx });        // __str_concat(arg0: ref null $AnyString, ...)
```

A closure param is physically stored as an **externref** slot (closure calling
convention). When the param's static type flow-narrows to `string` (after
`m = ''`), the compound `+=` takes this native-string fast path, which assumes
the LHS local slot already holds a `ref $AnyString`. The bare `local.get` yields
`externref`, fed straight into `__str_concat` arg[0] which expects
`(ref null $AnyString)` -> validation failure.

The RHS operand arm (~line 1334-1337) already handles the identical externref->
`$AnyString` case (`any.convert_extern` + `ref.cast $AnyString`); the LHS load
simply lacked the mirror.

Minimal repro (function #58, smallest): `const f = function(m){ m=''; m+='x'; return m; };`
- `m='x'` alone: OK; `m+='x'` alone: OK; `m=''` THEN `m+='x'`: FAILS
  (the `m=''` is what flow-narrows the slot's static type to string).

## Fix (implemented on this branch)

In the LHS-load block, after `local.get index: localIdx`, compute the local's
PHYSICAL ValType (params occupy slots `[0, fctx.params.length)`, locals follow)
and, when it is `externref`, coerce with `any.convert_extern` + `ref.cast
$AnyString` — mirroring the RHS externref arm.

- gc/host **byte-identical**: the whole path is inside
  `if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0)`, off for gc/host.
- The store-back (`local.tee`) was NOT broken (the assignment coercion path
  already handles $AnyString->externref); only the load needed the mirror.

## Verification

- `tests/issue-3472-funcexpr-string-param-concat.test.ts` — 3/3 green:
  valid Wasm + correct values via in-wasm string equality (`f('a')==='a x'`,
  `f(undefined)==='x'`). NOTE: native strings do NOT marshal back to JS across a
  standalone `export function test(): any` boundary (they stay GC structs), so
  correctness is asserted via an in-wasm `=== 'literal' ? 1 : 0` compare, not a
  JS-side return value (which is `undefined` even for a trivial `return m`
  passthrough — a boundary artifact, not a bug in this fix).
- `tests/issue-3468-closure-own-props.test.ts` — 13/13 still green.

## Resume state (2026-07-19, budget-forced checkpoint)

- **Worktree**: `/workspace/.claude/worktrees/issue-3472-funcexpr-string-param-fix`
- **Branch**: `issue-3472-funcexpr-string-param-fix`
- **Predecessor / base**: `issue-3468-closure-own-props` (PR #3418, in-flight,
  DO-NOT-MERGE pending floor decision). Re-merge it if it changes.
- **remotes here**: `origin` = fork `ttraenkler/js2`, `upstream` = `loopdive/js2`.
  Push the branch to `origin` (the fork); open the PR against `upstream` with
  `--head ttraenkler:issue-3472-funcexpr-string-param-fix`.
- **Done**: root-caused the blocker; implemented the LHS load-coercion fix in
  `src/codegen/expressions/operator-assignment.ts`; added the regression test;
  confirmed valid + correct + no #3468 regression + gc/host byte-neutral.
- **Remaining / next steps**:
  1. Broader scoped check: run `tests/equivalence.test.ts` (or a string-heavy
     subset) to confirm no other native-string `+=` site regressed.
  2. Merge `origin/main` (once #3418 lands) into this branch; keep #3418's
     substrate; re-run the #3468 harness-shape test.
  3. Stack AFTER #3418. Enqueue only after #3418 is on main. The real floor win
     = #3418 routing + this fix together: with the harness message build now
     valid, the assert tests move from vacuous-pass to genuine assert (the ~391
     fail-to-instantiate regression the #3468 note measured does NOT occur).
     Measure the true standalone floor delta on the combined state.
  4. Report combined floor delta + host/gc byte-identity to the lead.

## Note for the lead (scope reframing)

The dispatch framed this as "do the front-end member-dispatch routing that
activates #3418". That routing is ALREADY implemented and working on the #3418
branch (commit `0a8ca7abc` in declarations.ts + the C-core substrate). The actual
open blocker to flipping the vacuous passes is this pre-existing string-codegen
bug, which is what #3472 fixes. #3472 is the genuine follow-up that unblocks
#3418's floor win.
