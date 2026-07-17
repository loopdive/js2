---
id: 869
title: "Refactor default params: caller-side insertion instead of sNaN sentinel"
status: ready
assignee:
created: 2026-03-29
updated: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
goal: maintainability
sprint: current
related: [3182]
# The foldConstantNumericDefault helper is a cohesive extension of the
# existing extractConstantDefault in index.ts (its only caller), so it lives
# alongside it rather than in a separate module (#3104 split is a later pass).
loc-budget-allow:
  - src/codegen/index.ts
---

> **2026-07-12 (#3182 groom, elevated to current/high).** Still actionable:
> the sNaN sentinel (`0x7FF00000DEADC0DE`) is live in at least
> `src/codegen/array-methods.ts`, `src/codegen/any-helpers.ts`,
> `src/codegen/literals.ts`, `src/codegen/statements/destructuring.ts`,
> `src/codegen/statements/loops.ts` (grep `DEADC0DE`). Note the shared
> `pushDefaultValue`/`defaultValueInstrs` helpers in type-coercion.ts are the
> established default-emission machinery — build on them.
# #869 -- Refactor default params: compile-time insertion at call sites

## Problem

We use a signaling NaN bit pattern (`0x7FF00000DEADC0DE`) as a sentinel to detect missing f64 arguments. While functional, this is hacky — it adds i64 reinterpret instructions at every default param check and relies on a magic constant.

## Better approach

The compiler already KNOWS at the call site how many args are provided. It should insert defaults directly:

**Simple constant defaults** (90% of cases):
```js
function f(a, b = 10, c = 20) { ... }
f(1)  // compiler emits: call $f (f64.const 1) (f64.const 10) (f64.const 20)
```
No sentinel needed — caller fills in the values.

**Complex expression defaults** (10% of cases):
```js
function f(x = getSomething()) { ... }
f()  // default must evaluate at callee (side effects, scope)
```
Use an i32 boolean flag per param: `(call $f (i32.const 0) (f64.const 0))` where the i32 means "arg not provided, use your default expression".

## Edge case: exported functions

Exported functions called from JS can't have caller-side defaults — the JS caller doesn't know them. Three options:

1. **JS wrapper**: generate a JS wrapper in `.imports.js` that applies defaults before calling Wasm
2. **Externref params**: exported functions with defaults use externref params so `undefined` is distinguishable from NaN
3. **Dual compilation**: internal callers use the fast path (caller-side), exported functions keep the sentinel

Option 3 is simplest — most functions aren't exported.

## What changes

1. At internal call sites with missing args: emit the default value directly when it's a constant
2. For expression defaults: add an i32 flag param before the f64 param
3. For exported functions: keep the sentinel approach (or use JS wrapper)
4. Remove the sNaN sentinel from internal-only functions

## ECMAScript spec reference

- [§15.1 ParameterLists](https://tc39.es/ecma262/#sec-parameter-lists) — FormalParameters with Initializer
- [§10.2.11 FunctionDeclarationInstantiation](https://tc39.es/ecma262/#sec-functiondeclarationinstantiation) — steps 21-27: default parameter initializers evaluated at call time when argument is undefined


## Acceptance criteria

- No magic NaN values for internal calls
- `f(NaN)` and `f()` correctly distinguished
- Constant defaults inlined at internal call sites
- Exported functions still handle missing args correctly
- All test262 default param tests pass

## Progress — 2026-07-17 (dev-869): constant-expression folding

Extended the existing caller-side constant-default path (`extractConstantDefault`
in `src/codegen/index.ts`) with a new `foldConstantNumericDefault` helper that
folds **compile-time-constant numeric expressions** to a value emitted directly
at the call site, instead of taking the sNaN-sentinel fallback. Newly folded
forms:

- binary arithmetic (`30 * 1000`, `60 * 60 * 24`, `2 ** 10`, `7 % 3`)
- bitwise (`1 << 4`, `0xff & 0x0f`, `~5`, `>>`, `>>>`, `|`, `^`)
- logical (`1 && 7`, `0 || 9`, `a ?? b` over numeric operands)
- unary `-`/`+`/`~`/`!`, parenthesized expressions
- the read-only numeric globals `Infinity` / `-Infinity` / `NaN` / `undefined`

Both f64 and i32 (native-int) params are covered; i32 applies `| 0` (ToInt32) to
match the callee's coercion. This advances the acceptance criteria "Constant
defaults inlined at internal call sites" and shrinks the "magic NaN for internal
calls" surface without any function-signature changes — it rides entirely on the
already-wired `constantDefault` machinery (callee skips its default check; caller
emits the value).

**Safety guard (load-bearing):** the folder deliberately does NOT resolve
arbitrary identifiers or any expression with a non-constant operand, so defaults
with side effects (`= inc()`) or references to other parameters (`= a + 1`) are
never folded — they still evaluate at the callee, only when the argument is
actually omitted (§10.2.11). Tests in `tests/issue-869.test.ts` assert both the
folding and this preservation.

### Follow-on — 2026-07-17 (dev-869): immutable `const`-binding folding

Extended `foldConstantNumericDefault` to also resolve **immutable `const`
numeric bindings** (`const TIMEOUT_MS = 5000; function f(t = TIMEOUT_MS)`), plus
chains (`const A = 5; const B = A * 2; … = B`). This is safe precisely because
`const` cannot be reassigned — its value is fixed for the program lifetime.
`const` resolution is delegated to a new `constInitializerOf` method on the
`TypeOracle` (`src/checker/oracle.ts`) — the checker boundary — so the change
adds **no `ctx.checker` usage in `src/codegen`** and passes the oracle-ratchet
gate. `let`/`var` are still NEVER folded (a default over a reassignable binding
must observe the CALL-TIME value); a const bound to a non-constant initializer
(`const K = someLet`) is likewise not folded. Boundary locked by explicit
non-fold guard tests. `extractConstantDefault` gained an optional `ctx` param
(threaded from its 4 call sites); when absent, `const` folding is skipped
(identical to prior behavior).

**Still remaining (a separate, higher-risk pass — likely senior-dev):** fully
removing the sNaN sentinel (`0x7FF00000DEADC0DE`) for internal-only f64 functions
with genuine *expression* defaults. The callee already OR-checks the clean
`__argc` missing-arg signal alongside the sentinel (see `function-body.ts` f64
branch), so the sentinel is now only a fallback for call paths that don't set
`__argc` (spread/apply/indirect). Retiring it requires proving `__argc` is set on
every such path and is test262-gated — out of scope for this increment.

## Suspended Work
- **Worktree**: /workspace/.claude/worktrees/issue-869
- **Branch**: issue-869-default-params-refactor
- **Done**: Constant defaults merged (commit 89961840). extractConstantDefault() + pushCallerDefault() working for numeric literals, NaN, Infinity, booleans, unary minus.
- **Remaining**: Expression defaults (hasExpressionDefault flag), i32 boolean flag for non-constant defaults, cleanup of sNaN sentinel for internal-only functions
- **Files modified (uncommitted)**: index.ts (+96 lines: extractConstantDefault extended, hasExpressionDefault support), type-coercion.ts (+33: pushCallerDefault extended), statements.ts (+16: emitDefaultParamInit expression path), expressions.ts (+10), string-ops.ts (+2)
- **Resume**: Continue from extractConstantDefault in index.ts — add handling for string literals and expression defaults. Then update emitDefaultParamInit to check hasExpressionDefault flag and evaluate the expression only when the i32 flag is 0.
