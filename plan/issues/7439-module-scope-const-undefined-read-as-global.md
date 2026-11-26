---
id: 7439
title: "A module-scope `const undefined = 42` is read as the global `undefined`"
status: done
sprint: current
created: 2026-11-20
updated: 2026-11-26
completed: 2026-11-26
priority: low
horizon: s
task_type: bug
area: ir
goal: core-semantics
related: [7380, 7104, 7106, 7514, 7515]
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

## Implementation Plan (2026-11-26, v3: answers the PRV-7439 blockers on d05f111c)

**Reproduced** on `origin/main` c3b7be66 and 1a726b3e. Every shadowing form returns NaN today, in both pipelines, on gc
and standalone; node returns the bound value. PRV-7439's matrix covers module `const` / `let` / `var`, a parameter, a
local `var` / `let`, a catch parameter, module and local destructuring, and a closure capture. The IR also **claims**
and answers wrong for two forms:

- `var undefined: any = "x"; export function f() { return undefined }` returns undefined.
- `function undefined() {}` with `typeof undefined === "function"` gives 0.

The selector's rule `isGlobalUndefinedIdentifier` (`src/ir/analysis/operand-admissibility.ts:92`) trusts
`isDirectModuleBinding`, which is false for a non-number `var` and for function and class declarations.

**Causes.**

1. Legacy `compileExpressionInner` (`src/codegen/expressions.ts:1133`) emits the undefined value for every identifier
   spelled `undefined`.
2. The IR has one rule, `isGlobalUndefinedIdentifier`, "the one rule the selector and the builder ask". Its "not a
   direct module binding" test misses bindings, and several sites bypass the rule and test only the spelling and the
   local name set: `select.ts` 3541, 3697, 4219, 11980, 12815, and `from-ast.ts` 2717 (with its own inline checker
   proof), 8175 (`isUnshadowedGlobalExpression`) and 15948, plus `identifier-read.ts`'s `global-undefined` arm.

**One three-valued answer, from the oracle.** New `TypeOracle` method
`undefinedReadOf(id: ts.Identifier): "ambient" | "shadowed" | "unknown"`.

- **Checker backend.**
  - `ambient`: the symbol at `id` is the checker's ambient `undefined` (`resolveName("undefined", undefined, Value,
    false)`) and its type is `undefined`. Because the symbol is the same one, a top-level script `var undefined` (no
    effect per spec) stays `ambient`.
  - (PRV nit) The arms run in this order. First, the ambient symbol with declarations merged into it
    (`declare global { var undefined: number }`, a script `var undefined`) is `unknown`. Then the ambient symbol with
    none is `ambient`. Only after that, a different symbol declared in a non-declaration source file is `shadowed`.
  - `unknown`: anything else. That covers no symbol (inside `with` and on synthesized nodes, where
    `getSymbolAtLocation` is undefined, as PRV measured), and `declare global { var undefined: number }`.
- **In-house backend.** It disagrees with the checker (script `var`, `with`), so it answers only what its binder proves:
  `shadowed` for a binding that is a function-scoped local, a parameter, or a declaration in a module file. Everything
  else is `unknown`, never `ambient`.

The answer is one oracle method, not a composition of `declarationsOf` / `isUnresolvableIdentifier`, because only
symbol identity tells the script-`var` case apart. Raw checker access stays inside the oracle, so the oracle ratchet
does not grow.

**Callers. Each consumer uses the answer only in its safe direction.**

- **The rule.** `isGlobalUndefinedIdentifier(id, locals, undefinedReadOf)` keeps the local-name test and replaces
  `isModuleBinding` with `undefinedReadOf(id) === "ambient"`. It is the only IR rule. The selector and the builder reach
  the oracle through the module-binding resolver. (PRV-7439 C1) `undefinedReadOf` is added once, in
  `makeIrLegacyModuleBindingResolver` (`src/ir/module-bindings.ts`), over `options.oracle`. Every resolver factory
  inherits it: codegen's, integration's, and the Prepared path's `makeIrIdentityModuleBindingResolver`, which already
  passes `oracle: input.oracle`. So the Prepared path, which reads `undefined` in the shared harness prelude, answers
  `ambient` rather than `unknown`. With no oracle the answer is `unknown`, so the read is refused by
  name, and the #7380 no-checker test passes unchanged.
- **IR sites routed through the rule** (folding the duplicates):
  - `select.ts` 3541, 3697, 4219, 11980, 12815 and the `isUnshadowedUndefinedIdentifier` wrapper (call sites recounted
    and listed in the PR, unchanged callers);
  - `from-ast.ts` 2717 (its inline `resolveName` / `getSymbolAtLocation` proof is deleted), `isUnshadowedGlobalExpression`'s
    `undefined` case, and 15948;
  - `identifier-read.ts`'s `global-undefined` arm.

  The selector therefore refuses PRV's two claimed cases at select, before claiming.
- **Legacy.** `expressions.ts:1133` keeps emitting the undefined value unless `ctx.oracle.undefinedReadOf(expr) ===
  "shadowed"`; only then does it fall through to the ordinary identifier read. On `unknown` (`with` bodies, synthesized
  nodes, the in-house backend) the bytes are today's.
- **`shared/ambient-intrinsics.ts`.** `isUnshadowedUndefined` / `isUnshadowedGlobalConstant` stay. They are a checker-free,
  file-wide syntactic under-approximation of `ambient` (nothing in the file declares the name), used by object-statics,
  descriptor and buffer-operand admissibility over `undefined` / `NaN` / `Infinity`. They are sound as they are, and this
  plan does not change them. Their doc gains one line pointing at the oracle answer as the precise form.

**Not in scope (follow-ups filed in this PR).**

- [#7514] Legacy sites that decide argument treatment from the spelling give wrong answers under shadowing too, as PRV
  measured: `x === undefined` with a module `const undefined = 42` gives 0 (node: 43), and `g(undefined)` takes the
  default parameter (8 instead of 43). There are 88 such syntactic tests in `src/codegen`.
- [#7515] An unrelated IR bug: `(void 0 as any) === (void 0)` is false on the default IR lane, while legacy gives true.

**Acceptance.**

- PRV's shadow matrix returns node's value on gc and standalone, default and legacy. The two claimed cases are refused
  at select (`irCompiledFuncs` excludes them), and their legacy answers match node.
- A top-level script `var undefined = 5` still reads undefined.
- Unshadowed `undefined` is unchanged. Bytes are identical on:
  - a 100-file test262 sample × {default, standalone} and the same × legacy;
  - every test262 file with a `with` statement that reads `undefined`;
  - every file that declares a binding named `undefined`.

  The exception is files with a `shadowed` read; each is listed with its reason.
- The two #7380 tests in `tests/issue-3518-native-family-source-identity.test.ts` pass unchanged.
- (PRV-7439 C2) No lost passes on the Prepared path (`TEST262_COMPILER_PATH=ir`), measured on the same test262 sample
  before and after.
- Quality:
  - one oracle method and one IR rule;
  - every listed spelling-only IR site goes through the rule;
  - no inline checker query at `from-ast.ts:2717`;
  - no oracle-ratchet growth.
