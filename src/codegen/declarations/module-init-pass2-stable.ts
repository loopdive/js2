// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap-1a/1b) Would a second direct compile of the module-init
 * population reproduce the first one?
 *
 * ## Why the question is worth asking
 *
 * A typed-Unsupported module initializer compiles its DIRECT body twice:
 * `module-init-pass1` seeds closure/setup discovery for the top-level function
 * bodies compiled after it, and `module-init-pass2` recompiles once those
 * bodies are done. Pass 1's body is already kept structurally valid to the end
 * (module-global and late func-index shifts patch `ctx.pendingInitBody`), so
 * whenever the recompile can only reproduce it, the caller may keep pass 1's
 * body and skip pass 2 outright.
 *
 * Pass 1 itself is NOT optional and this predicate never proposes removing it:
 * function bodies deliberately consume pass 1's END integrity state
 * (`definedPropertyFlags` / `frozenVars` / `sealedVars` /
 * `nonExtensibleVars`, the #2965 snapshot) and its `closureMap` discovery.
 * Compiling bodies first and running a single init compile in the pass-2 slot
 * was measured (2026-09-01) to turn a correct `TypeError` on a frozen object
 * into a silent write, to lose `call_ref` codegen on closure shapes, and to
 * regress six async test262 files. Only the SECOND compile is in question here.
 *
 * ## What makes a second compile differ — the two measured mechanisms
 *
 * 1. **The inlinable-function registry.** Pass 2's stated reason is "so call
 *    sites inside module-level code can see the final inlinable-function
 *    registry". `ctx.inlinableFunctions` is consulted only when compiling a
 *    call, so a population with no call anywhere cannot observe it (gap-1a).
 * 2. **Closure re-lifting.** A population that mints a closure
 *    (arrow / function-expression / class-expression) hands pass 2 a second
 *    lifting opportunity: pass 2 emits a re-lifted `$__closure_N` twin and
 *    applies registry inlining INSIDE the closure body it recompiles. Runtime
 *    values stay equal, but the bytes differ, so those populations keep both
 *    passes (gap-1b).
 *
 * The two mechanisms compose: a population is pass-2-stable when it is missing
 * EITHER ingredient — no call at all, or no closure at all. Both halves are
 * measured, not argued:
 *
 * | population                     | measured                                    |
 * | ------------------------------ | ------------------------------------------- |
 * | call-free (closure or not)     | gap-1a: 50/50 corpus binaries byte-identical |
 * | call-bearing, closure-free     | gap-1b: 52/52 shape×lane byte-identical     |
 * | call-bearing AND closure-bearing | bytes DIFFER — keeps two passes           |
 *
 * (The one measured exception to byte identity is `console.log` on WASI, where
 * the two-pass build carries a duplicate DEAD `"\n"` data segment that pass 2
 * re-registers; the one-pass build is smaller and its code is identical.)
 *
 * ## The refusals
 *
 * | node                       | class     | why                                     |
 * | -------------------------- | --------- | --------------------------------------- |
 * | `CallExpression`           | call      | the registry consumer (covers `super(…)`, `import(…)`, `a?.()`) |
 * | `NewExpression`            | call      | construction dispatch reads the same name-keyed state |
 * | `TaggedTemplateExpression` | call      | a call in operator clothing             |
 * | `ArrowFunction`            | closure   | pass 2 re-lifts it                      |
 * | `FunctionExpression`       | closure   | same                                    |
 * | `ClassExpression`          | closure   | its methods are lifted with it          |
 * | `Decorator`                | always    | evaluates its expression as a call, on a class that is itself lifted |
 * | `AwaitExpression`          | always    | suspends into machinery compiled later  |
 *
 * ## What the scan looks at
 *
 * The FULL subtree of exactly the nodes `compileModuleInitBody` compiles —
 * every `ctx.moduleInitStatements` statement and every `ctx.staticInitExprs`
 * entry's `staticBlock ?? initializer`. Nested bodies are INCLUDED, which is
 * what makes `const f = () => h()` a refusal: that closure body compiles
 * during the init statement and carries both ingredients at once.
 *
 * The scan deliberately does NOT look at the source file. A call inside a
 * top-level function body is not an init input and must not disqualify; a call
 * inside a static block, or inside a class-expression method whose owning
 * statement reaches the population, must be seen.
 *
 * Fail-closed: anything not provably stable keeps both passes. There is no
 * allowlist of "harmless" callees — the point of the gate is that it needs no
 * judgement about what a call does.
 */

import ts from "typescript";
import type { CodegenContext } from "../context/types.js";

/**
 * What a node contributes to the pass-2 divergence question.
 *
 * - `none` — the node cannot make pass 2 differ.
 * - `call` — consults the inlinable-function registry, which grows between
 *   passes.
 * - `closure` — gives pass 2 a second closure-lifting opportunity.
 * - `always` — refuses on its own, without needing a partner.
 */
type Ingredient = "none" | "call" | "closure" | "always";

function ingredientOf(node: ts.Node): Ingredient {
  switch (node.kind) {
    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.TaggedTemplateExpression:
      return "call";
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassExpression:
      return "closure";
    case ts.SyntaxKind.Decorator:
    case ts.SyntaxKind.AwaitExpression:
      return "always";
    default:
      return "none";
  }
}

/**
 * Test-only anti-vacuity seam. With
 * `JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE=1` the closure half of
 * the predicate is dropped, which lets the suite DEMONSTRATE that the closure
 * refusal is load-bearing rather than decorative: admit closures and a
 * call-inside-an-arrow population stops being byte-identical to its two-pass
 * build, and a closure-bearing test262 harness population starts reporting its
 * diagnostics twice. The seam only ever WIDENS admission, and nothing outside
 * the mutation test reads it.
 */
const CLOSURE_ADMIT_SEAM = "JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE";

/**
 * True when NOTHING in the accumulated module-init population makes a second
 * direct compile able to differ from the first.
 *
 * `ctx.moduleInitStatements` / `ctx.staticInitExprs` are graph-global
 * accumulated state, so a statement contributed by an EARLIER source counts
 * even when the emitting source's own statements are stable — the population,
 * not the file, decides.
 */
export function moduleInitPopulationIsPass2Stable(ctx: CodegenContext): boolean {
  const admitClosures = process.env[CLOSURE_ADMIT_SEAM] === "1";
  let sawCall = false;
  let sawClosure = false;
  const stack: ts.Node[] = [];
  for (const statement of ctx.moduleInitStatements) stack.push(statement);
  for (const entry of ctx.staticInitExprs) {
    const node = entry.staticBlock ?? entry.initializer;
    if (node) stack.push(node);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (ingredientOf(node)) {
      case "always":
        return false;
      case "call":
        if (sawClosure) return false;
        sawCall = true;
        break;
      case "closure":
        if (admitClosures) break;
        if (sawCall) return false;
        sawClosure = true;
        break;
      default:
        break;
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return true;
}
