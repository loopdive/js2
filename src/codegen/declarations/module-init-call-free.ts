// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap-1a) Is the accumulated module-init population call-free?
 *
 * ## Why the question is worth asking
 *
 * A typed-Unsupported module initializer compiles its DIRECT body twice:
 * `module-init-pass1` seeds closure/setup discovery for the top-level function
 * bodies compiled after it, and `module-init-pass2` recompiles once those
 * bodies are done. Pass 2 exists for exactly one stated reason — "so call
 * sites inside module-level code can see the final inlinable-function
 * registry" — and `ctx.inlinableFunctions` is consulted only when compiling a
 * call. Pass 1's body is already kept structurally valid to the end (module
 * global and late func-index shifts patch `ctx.pendingInitBody`), so when the
 * population contains no call at all the second compile can only reproduce the
 * first, and the caller may keep pass 1's body and skip the recompile.
 *
 * ## What "call-free" means here, precisely
 *
 * The scan walks the FULL subtree of exactly the nodes
 * `compileModuleInitBody` compiles — every `ctx.moduleInitStatements`
 * statement and every `ctx.staticInitExprs` entry's `staticBlock ??
 * initializer` — and refuses on any of:
 *
 * | node                        | why                                        |
 * | --------------------------- | ------------------------------------------ |
 * | `CallExpression`            | the registry consumer (covers `super(…)`, `import(…)`, `a?.()`) |
 * | `NewExpression`             | construction dispatch reads the same name-keyed state |
 * | `TaggedTemplateExpression`  | a call in operator clothing                |
 * | `Decorator`                 | evaluates its expression as a call         |
 * | `AwaitExpression`           | suspends into machinery compiled later     |
 *
 * Nested arrow / function-expression / class-expression bodies inside an
 * initializer are INCLUDED: `const f = () => h()` compiles that closure body
 * during the init statement, so pass 1 would otherwise bake in the un-inlined
 * call.
 *
 * The scan deliberately does NOT look at the source file. A call inside a
 * top-level function body is not an init input and must not disqualify;
 * a call inside a static block or a class-expression method that IS an init
 * input must.
 *
 * Fail-closed: anything not provably call-free keeps both passes. There is no
 * allowlist of "harmless" callees — the point of the gate is that it needs no
 * judgement about what a call does.
 */

import ts from "typescript";
import type { CodegenContext } from "../context/types.js";

/** Node kinds that disqualify the population from the single-pass route. */
function disqualifies(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.TaggedTemplateExpression:
    case ts.SyntaxKind.Decorator:
    case ts.SyntaxKind.AwaitExpression:
      return true;
    default:
      return false;
  }
}

/** True when no node in `root`'s subtree (inclusive) disqualifies. */
function subtreeIsCallFree(root: ts.Node): boolean {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (disqualifies(node)) return false;
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return true;
}

/**
 * True when NOTHING in the accumulated module-init population contains a call.
 *
 * `ctx.moduleInitStatements` / `ctx.staticInitExprs` are graph-global
 * accumulated state, so a call-bearing statement contributed by an EARLIER
 * source keeps two passes even when the emitting source's own statements are
 * call-free — the population, not the file, decides.
 */
export function moduleInitPopulationIsCallFree(ctx: CodegenContext): boolean {
  for (const statement of ctx.moduleInitStatements) {
    if (!subtreeIsCallFree(statement)) return false;
  }
  for (const entry of ctx.staticInitExprs) {
    const node = entry.staticBlock ?? entry.initializer;
    if (node && !subtreeIsCallFree(node)) return false;
  }
  return true;
}
