// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6781) Loud refusal: an abrupt resumption (`.throw()` / `.return()`) of a
 * generator that only the EAGER host-buffer lowering can compile.
 *
 * In the JS-host lane a sync generator that the lazy native state machine does
 * not claim (`isNativeGeneratorCandidate` is false — a method, a function
 * expression, an exported declaration, an instance or `{value, done}` result
 * that escapes the allowlisted consumers, …) falls to the eager lowering: the
 * WHOLE body runs when the generator is created and every yielded value is
 * buffered (#1687). `.next()` then drains that buffer, which is observably right
 * for the value sequence. `.throw(e)` / `.return(v)` are not: there is no live
 * suspension to resume, so
 *
 *   - a `catch` around the suspended `yield` never sees the thrown value — it
 *     escapes `.throw()` instead of being caught inside the generator;
 *   - a `finally` around it already ran at creation, so `.return()` cannot run
 *     it at the right time (or let it override the completion).
 *
 * Both turn a program that runs fine under Node into one that silently does
 * something else. Rule (mirrors #3587's async refusal): a sync generator that
 * will be lowered eagerly, whose body has a `yield` inside a region an abrupt
 * resumption would route through user code (a `try` block with a `catch` or
 * `finally`, or a `catch` block with a `finally`), and whose instance is
 * TRACEABLY resumed with an explicit `.throw(...)` / `.return(...)` call, is a
 * compile error at that call.
 *
 * Deliberately NOT refused (each is observably equivalent today, or not
 * provable from the source):
 *   - generators the lazy lowering claims — the check asks the same single
 *     candidate gate the declaration/nested/closure/method emit sites ask;
 *   - eager generators with no guarded `yield`: an abrupt resumption at an
 *     unguarded `yield` completes the generator exactly as the buffer does
 *     (the runtime drops the buffered remainder and any deferred body throw);
 *   - instances the scan cannot trace to a declaration (a parameter, a
 *     property, an exported generator driven from JS), and the implicit
 *     `.return()` of a for-of `break` / destructuring close. Those stay with
 *     #1687, whose real fix (resumable eager-lane generators) retires this gate.
 *
 * Standalone / WASI are out of scope here, as for #3587: their non-candidate
 * generators already need the `__gen_*` host shim and are tracked by #680.
 */
import { ts } from "../ts-api.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext } from "./context/types.js";
import { isNativeGeneratorCandidate, type GeneratorDecl } from "./generators-native.js";
import { isFunctionLikeScope } from "./generators-native-ast-scan.js";

/** Per-context dedupe: the collector may visit a source more than once. */
const reportedByCtx = new WeakMap<CodegenContext, WeakSet<ts.Node>>();

function skipParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isSyncGenerator(node: ts.Node): node is GeneratorDecl {
  if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))) return false;
  if (!node.asteriskToken || !node.body) return false;
  return !(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
}

/**
 * First `yield` in `decl`'s own body (not a nested function's) that sits where
 * an abrupt resumption runs user code before leaving the generator: inside a
 * `try` block (every `try` has a `catch` or a `finally`), or inside a `catch`
 * block whose `try` also has a `finally`. `null` when there is none.
 */
function firstGuardedYield(decl: GeneratorDecl): ts.YieldExpression | null {
  let found: ts.YieldExpression | null = null;
  const walk = (node: ts.Node, guarded: boolean): void => {
    if (found !== null || isFunctionLikeScope(node)) return;
    if (ts.isYieldExpression(node) && guarded) {
      found = node;
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, true);
      if (node.catchClause) walk(node.catchClause, guarded || node.finallyBlock !== undefined);
      if (node.finallyBlock) walk(node.finallyBlock, guarded);
      return;
    }
    ts.forEachChild(node, (child) => walk(child, guarded));
  };
  if (decl.body) ts.forEachChild(decl.body, (child) => walk(child, false));
  return found;
}

/** Generator declarations a callee expression (`g`, `obj.m`, `(function*(){})`) resolves to. */
function generatorsOfCallee(ctx: CodegenContext, calleeExpr: ts.Expression): GeneratorDecl[] {
  const callee = skipParens(calleeExpr);
  if (isSyncGenerator(callee)) return [callee];
  let declarations: readonly ts.Declaration[];
  if (ts.isIdentifier(callee)) declarations = ctx.oracle.declarationsOf(callee);
  else if (ts.isPropertyAccessExpression(callee)) declarations = ctx.oracle.declarationsOf(callee.name);
  else return [];
  const out: GeneratorDecl[] = [];
  for (const d of declarations) {
    if (isSyncGenerator(d)) out.push(d);
    else if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
      const init = skipParens(d.initializer);
      if (isSyncGenerator(init)) out.push(init);
    }
  }
  return out;
}

/**
 * Source-local trace of where a generator INSTANCE expression came from: a
 * direct call (`g()`, `obj.m()`, an IIFE), or a plain variable binding whose
 * initializer / plain `=` assignments are themselves traceable. Anything else
 * (parameters, properties, call results of ordinary functions) is untraceable
 * and yields nothing — the gate only refuses what it can prove.
 */
class InstanceTracer {
  private assignments: Map<ts.Declaration, ts.Expression[]> | undefined;

  constructor(
    private readonly ctx: CodegenContext,
    private readonly sourceFile: ts.SourceFile,
  ) {}

  generatorsOf(expr: ts.Expression, seen: Set<ts.Declaration> = new Set()): GeneratorDecl[] {
    const e = skipParens(expr);
    if (ts.isCallExpression(e)) return generatorsOfCallee(this.ctx, e.expression);
    if (!ts.isIdentifier(e)) return [];
    const binding = this.ctx.oracle.variableDeclarationOf(e);
    if (!binding || seen.has(binding)) return [];
    seen.add(binding);
    const sources = [...(binding.initializer ? [binding.initializer] : []), ...this.writesTo(binding)];
    return sources.flatMap((source) => this.generatorsOf(source, seen));
  }

  private writesTo(binding: ts.VariableDeclaration): readonly ts.Expression[] {
    if (!this.assignments) {
      const map = new Map<ts.Declaration, ts.Expression[]>();
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)
        ) {
          const target = this.ctx.oracle.variableDeclarationOf(node.left);
          if (target) {
            const list = map.get(target);
            if (list) list.push(node.right);
            else map.set(target, [node.right]);
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(this.sourceFile, visit);
      this.assignments = map;
    }
    return this.assignments.get(binding) ?? [];
  }
}

function generatorDisplayName(decl: GeneratorDecl): string {
  if (decl.name) return decl.name.getText();
  const parent = decl.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name) {
    return parent.name.getText();
  }
  return "<anonymous function*>";
}

/**
 * (#6781) Report every explicit `.throw()` / `.return()` call in `sourceFile`
 * that resumes an eager-lowered sync generator with a guarded `yield`. JS-host
 * lane only. Byte-neutral for every other program: the candidate gate is only
 * consulted for generators that already have a guarded `yield` AND a traced
 * abrupt-resumption call.
 */
export function reportEagerGeneratorAbruptResumptions(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (ctx.standalone || ctx.wasi) return;
  const guarded = new Map<GeneratorDecl, ts.YieldExpression>();
  const collect = (node: ts.Node): void => {
    if (isSyncGenerator(node)) {
      const hazard = firstGuardedYield(node);
      if (hazard) guarded.set(node, hazard);
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(sourceFile, collect);
  if (guarded.size === 0) return;

  const tracer = new InstanceTracer(ctx, sourceFile);
  const eager = new Map<GeneratorDecl, boolean>();
  const isEager = (decl: GeneratorDecl): boolean => {
    let answer = eager.get(decl);
    if (answer === undefined) {
      answer = !isNativeGeneratorCandidate(ctx, decl);
      eager.set(decl, answer);
    }
    return answer;
  };
  let seen = reportedByCtx.get(ctx);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "throw" || node.expression.name.text === "return") &&
      !seen?.has(node)
    ) {
      const method = node.expression.name.text;
      const decl = tracer.generatorsOf(node.expression.expression).find((d) => guarded.has(d) && isEager(d));
      if (decl) {
        if (!seen) reportedByCtx.set(ctx, (seen = new WeakSet()));
        seen.add(node);
        const name = generatorDisplayName(decl);
        const consequence =
          method === "throw"
            ? "the thrown value would bypass the generator's own catch/finally and escape .throw()"
            : "the finally around the suspended yield already ran and cannot run (or override the result) now";
        reportError(
          ctx,
          node,
          `generator-eager-unsupported: .${method}() on generator \`${name}\`, which can only be lowered ` +
            "with the eager buffer here (its whole body, including the try around its yield, runs when the " +
            `generator is created), so ${consequence}. The lazy lowering claims a non-exported function* ` +
            "declaration whose instances and {value, done} results stay in for-of / spread / Array.from / " +
            ".next()/.throw()/.return() calls read through .value/.done; restructure toward that, or move the " +
            "yield out of the try (#1687, #6781)",
          "error",
          { sticky: true },
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}
