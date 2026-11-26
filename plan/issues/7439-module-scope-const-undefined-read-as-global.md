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

## Implementation Plan (2026-11-26)

**Reproduced** on `origin/main` c3b7be66 and 1a726b3e: `const undefined = 42; export function f(): number { return (undefined as any) + 1; }`
returns NaN on gc and standalone, **in both the default and the legacy pipeline** (`experimentalIR: false`).

**Two causes, one per front-end.**

1. IR: `classifyIdentifierRead` (`src/ir/identifier-read.ts`) answers `global-undefined` for any `undefined` that has
   no scope binding and no module binding. "No module binding" proves nothing: the resolver can be absent, or present
   and not track this binding (the ordinary pipeline here). `isUnshadowedGlobalExpression` (`from-ast.ts`) makes the
   same inference. Only `lowerExpressionStatement`'s discard arm (`from-ast.ts` ~2716) asks the checker for proof.
2. Legacy: `compileExpressionInner` (`src/codegen/expressions.ts` ~1133) emits the undefined value for every
   identifier spelled `undefined`, shadowed or not. So an IR refusal alone demotes the function to legacy, which still
   answers NaN; acceptance 1 ("43 or refused by name, never NaN") needs both.

**Target structure.**

- `src/ir/identifier-read.ts`: one predicate, `isProvenGlobalUndefined(expr, checker)`: no binding shadows the read,
  as the checker proves it (`getSymbolAtLocation(expr)` is the ambient `undefined` symbol). It is the proof that
  `from-ast.ts` ~2716 already writes inline; that copy moves here and is the only one. `classifyIdentifierRead`
  answers `global-undefined` only on that proof, else falls through to `unresolved` (the existing named refusal,
  `identifier "undefined" is not in scope`). The context gains the checker it needs (`checker?`).
- `from-ast.ts`: the discard arm and `isUnshadowedGlobalExpression(…, "undefined")` call the predicate (the latter
  keeps its module-binding check for its other names). Without a checker the read is refused, never guessed.
- Legacy (`expressions.ts`): the `undefined` arm applies only when the read is the global (through `ctx.oracle`, not
  the raw checker; a shadowed read falls through to the ordinary identifier path, which reads the module global
  `undefined` like any other). If the oracle cannot answer this, a small `oracle-ratchet-allow:` with a reason.

**Reuses / removes.** The ambient-symbol proof exists once instead of inline in one arm and missing in two.

**Acceptance.**
- The program above returns 43 on gc and standalone, default and legacy; a local `let undefined = 1` likewise.
- Without a checker, an `undefined` read is refused by name; the two #7380 red tests in
  `tests/issue-3518-native-family-source-identity.test.ts` pass unchanged.
- Quality: one proof predicate, no new inline checker queries; bytes unchanged on a 100-file sample × default and
  standalone (an unshadowed `undefined` lowers exactly as before).

**Open question for the lead:** the legacy arm is outside "a refusal in from-ast". Without it the program is refused
by the IR and still NaN in legacy. Include it in this PR, or file it separately?
