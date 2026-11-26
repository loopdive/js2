---
id: 7439
title: "A module-scope `const undefined = 42` is read as the global `undefined`"
status: in-progress
sprint: current
created: 2026-11-20
updated: 2026-11-26
priority: low
horizon: s
task_type: bug
area: ir
goal: core-semantics
related: [7380, 7104, 7106]
---

# #7439 — module-scope `const undefined` is ignored

## Problem

```ts
const undefined = 42;
export function f(): number { return (undefined as any) + 1; }
```

node (module code): 43. js2wasm, default and `--target standalone`: NaN.

`lowerFunctionAstToIr` with a checker and no module-binding resolver lowers the read to `dyn.undefined` instead of
refusing. Both `src/ir/from-ast.ts`'s identifier arm for `undefined` (#7104 / #7106) and
`isUnshadowedGlobalExpression` treat "no module binding found" as "the global", which is false when no resolver is
present. Rare in real code, but a wrong answer.

## Evidence

`tests/issue-3518-native-family-source-identity.test.ts`: "does not certify a shadowed undefined read in direct
lowering: const undefined = 42; …" and "retains the unsupported undefined read when the lowerer has no checker".

## Acceptance criteria

1. The program above returns 43, or is refused by name; never NaN.
2. Without a resolver, a read of `undefined` that the checker does not prove global is refused.
3. The two red tests pass unchanged.

## Implementation Plan (2026-11-26, revised after the lead's decision: legacy fix in the same PR, one predicate)

**Reproduced** on `origin/main` c3b7be66 and 1a726b3e: `const undefined = 42; export function f(): number { return
(undefined as any) + 1; }` returns NaN on gc and standalone, in the default and the legacy (`experimentalIR: false`)
pipeline. In the default pipeline the IR claims only `<module-init>` (`irCompiledFuncs`), so `f` is legacy there too.

**Causes.**

1. Legacy: `compileExpressionInner` (`src/codegen/expressions.ts:1133`) emits the undefined value for every identifier
   spelled `undefined`, shadowed or not. This is the wrong value in both pipelines today.
2. IR: `classifyIdentifierRead` (`src/ir/identifier-read.ts`) answers `global-undefined` for an `undefined` with no
   scope binding and no module binding, but "no module binding" proves nothing (no resolver, or a resolver that does
   not track this name). `isUnshadowedGlobalExpression(…, "undefined")` (`from-ast.ts`) makes the same inference.
   Only the discard arm (`from-ast.ts:2717`) proves it, with its own inline raw-checker query.

**One predicate, over the oracle.** `isAmbientUndefinedRead(oracle, id)` in `src/checker/oracle.ts`, beside the
other derived oracle helpers (`identifierWriteFact`): `id` reads the ambient global `undefined` exactly when it
resolves (`!oracle.isUnresolvableIdentifier(id)`) and has no declaration (`oracle.declarationsOf(id).length === 0`).
The ambient `undefined` is the one binding with a symbol and no declaration. Any `const` / `let` / `var` / parameter /
function / import named `undefined` has one. No new `TypeOracle` method is needed, and both backends answer it: the
checker oracle through the symbol, and the in-house oracle through its binder plus `GLOBAL_VALUE_NAMES`.

**Callers.**

- Legacy, `expressions.ts:1133`: the arm applies only when `isAmbientUndefinedRead(ctx.oracle, expr)`. A shadowed read
  falls through to the ordinary identifier path, which reads the binding like any other name.
- IR, `identifier-read.ts`: `global-undefined` only when `cx.oracle` proves it; without an oracle, or when the proof
  fails and no module binding resolved, the read is `unresolved`, the existing named refusal
  (`identifier "undefined" is not in scope`).
- IR, `from-ast.ts`: the discard arm (2717) and `isUnshadowedGlobalExpression`'s `undefined` case call the same
  predicate. The inline `resolveName` / `getSymbolAtLocation` proof is deleted.

**Reuses / removes.** One proof instead of an inline raw-checker copy, a missing check in two IR places, and a missing
check in legacy. No new oracle surface.

**Not in scope.** `src/codegen` has 88 other syntactic `text === "undefined"` tests (counted on main 1a726b3e) (omitted-argument and
default-parameter detection, `JSON.stringify` replacer, `parseInt` radix, and others). They decide how an argument is
treated, not what value a read yields. Their callers can adopt the predicate later; I will list them in the PR.

**Selection.** No selector change: the selector does not claim `f` today, and the IR refusal is the existing
build-time one. If a shadowed read in an otherwise-claimed function now reaches it, the plan reviewer should say
whether `select.ts`'s `dynNames.has("undefined")` checks need the predicate too (refuse at select, not after claim).
I will measure claims on the sample to answer this.

**Acceptance.**

- The program above returns 43 on gc and standalone, default and legacy. A function-local `let undefined = 1` read,
  and a parameter named `undefined`, also return their values.
- An unshadowed `undefined` is unchanged. Bytes are identical on a 100-file test262 sample × {default, standalone}
  and the same × legacy, except files that declare a binding named `undefined`. List those files, with the reason.
- Without a checker or oracle, an IR read of `undefined` is refused by name. The two #7380 tests in
  `tests/issue-3518-native-family-source-identity.test.ts` pass unchanged.
- Quality: one predicate used by every caller above; no inline checker query left at `from-ast.ts:2717`; no
  oracle-ratchet growth.
