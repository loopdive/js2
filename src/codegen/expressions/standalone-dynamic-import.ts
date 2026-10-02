// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3494) `import(specifier)` in `--target standalone`, with no host loader.
 *
 * A standalone binary has exactly one module graph: the sources compiled into
 * it. compileMulti/compileProject flatten that graph into one topologically
 * ordered module initializer (dependencies first, entry last — see
 * `analyzeMultiSource`), and same-compilation module namespace objects already
 * exist for static `import * as ns` (`module-namespace-value.ts`). So an
 * `import()` whose target is a module of THIS graph that has finished
 * evaluating before the importer starts needs no loader at all: the result is
 * `PromiseResolve(%Promise%, namespace)` — the ContinueDynamicImport step
 * (§16.2.1.8.2) with Evaluate() already complete.
 *
 * Every other case is a module the binary cannot load, and settles the way a
 * host whose loader fails does: a REJECTED Promise carrying a TypeError. That
 * covers a non-literal specifier, a literal naming a module outside the graph
 * (a Node builtin such as lru-cache's `import("node:diagnostics_channel")`),
 * a target that is not yet evaluated when the importer runs (itself, a later
 * module, a cycle), an asynchronous (top-level-await) graph prefix, import
 * options, and a namespace this compilation cannot materialize. Nothing here
 * fabricates a namespace or an always-fulfilled placeholder.
 *
 * Argument expressions are still evaluated left to right first, so their side
 * effects and synchronous throws are unchanged (§13.3.10.1 steps 3-6 use `?`).
 */
import type { Instr } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { emitStandalonePromiseReject, emitStandalonePromiseResolve } from "../async-scheduler.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { moduleInitHasTopLevelAwait } from "../declarations.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { tryEmitModuleNamespaceObjectForSource } from "../module-namespace-value.js";
import { compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";

/** An evaluated in-graph target, or the reason the import must reject. */
type DynamicImportTarget = { readonly sourceFile: ts.SourceFile } | { readonly reason: string };

function resolveEvaluatedTarget(ctx: CodegenContext, expr: ts.CallExpression): DynamicImportTarget {
  if (expr.arguments.length !== 1) {
    return { reason: "import options are not supported by the standalone module graph" };
  }
  const specifier = expr.arguments[0]!;
  if (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier)) {
    return { reason: "a non-literal specifier cannot be resolved in the standalone module graph" };
  }
  const graph = ctx.callableSourceFiles ?? [];
  const target = ctx.oracle.declarationsOf(specifier).find((node): node is ts.SourceFile => ts.isSourceFile(node));
  const targetIndex = target === undefined ? -1 : graph.indexOf(target);
  if (target === undefined || targetIndex < 0) {
    return { reason: `Cannot find module '${specifier.text}' in the standalone module graph` };
  }
  // The namespace snapshots `export const` values when it is first built, and
  // a flattened initializer has no evaluation promise to wait on. Only a module
  // that finished evaluating before the importer's own initializer began is
  // therefore safe to publish; a self-import, a later module or a cycle is not.
  if (targetIndex >= graph.indexOf(expr.getSourceFile())) {
    return { reason: `module '${specifier.text}' is not evaluated before its importer in the standalone module graph` };
  }
  for (let index = 0; index <= targetIndex; index++) {
    if (hasTopLevelAwait(graph[index]!)) {
      return { reason: `module '${specifier.text}' has an asynchronous (top-level await) dependency graph` };
    }
  }
  return { sourceFile: target };
}

const topLevelAwaitBySource = new WeakMap<ts.SourceFile, boolean>();

/** Memoized: every in-graph `import()` re-checks its whole graph prefix. */
function hasTopLevelAwait(sourceFile: ts.SourceFile): boolean {
  let known = topLevelAwaitBySource.get(sourceFile);
  if (known === undefined)
    topLevelAwaitBySource.set(sourceFile, (known = moduleInitHasTopLevelAwait(sourceFile.statements)));
  return known;
}

/** Compile a standalone `import()` to a native Promise; never a host import. */
export function compileStandaloneDynamicImport(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult {
  const target = resolveEvaluatedTarget(ctx, expr);
  for (const argument of expr.arguments) {
    if (compileExpression(ctx, fctx, argument) !== null) fctx.body.push({ op: "drop" });
  }
  if ("sourceFile" in target) {
    // An `undefined` answer emits nothing, so the reject path needs no rollback.
    if (tryEmitModuleNamespaceObjectForSource(ctx, fctx, target.sourceFile) !== undefined) {
      const namespaceLocal = allocLocal(fctx, `__dynimport_ns_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: namespaceLocal });
      emitStandalonePromiseResolve(ctx, fctx, [{ op: "local.get", index: namespaceLocal }]);
      return { kind: "externref" };
    }
    return emitRejectedImport(ctx, fctx, "the module namespace cannot be materialized in the standalone module graph");
  }
  return emitRejectedImport(ctx, fctx, target.reason);
}

function emitRejectedImport(ctx: CodegenContext, fctx: FunctionContext, reason: string): InnerResult {
  const errorInstrs: Instr[] = buildThrowJsErrorInstrs(ctx, "TypeError", `import() failed: ${reason}`, { flush: fctx });
  // The builder ends in `throw $exc`; the error VALUE is everything before it.
  if (errorInstrs.pop()?.op !== "throw") throw new Error("standalone import(): TypeError builder shape changed");
  emitStandalonePromiseReject(ctx, fctx, errorInstrs);
  return { kind: "externref" };
}
