// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6945) Per-activation identity for a NESTED function declaration whose
 * `.prototype` its enclosing body reassigns.
 *
 * §10.2.11 FunctionDeclarationInstantiation step 36 instantiates every nested
 * declaration afresh on each evaluation of the enclosing body, and MakeConstructor
 * gives each instance its own `prototype` slot. js2 binds a capture-free nested
 * declaration to ONE cached closure per function name, so Octane deltablue's
 *
 *   function inherits(shuper) {
 *     function Inheriter() {}
 *     Inheriter.prototype = shuper.prototype;   // every call overwrites …
 *     this.prototype = new Inheriter();         // … the one shared slot
 *   }
 *
 * aliased all six constraint classes onto the last parent written. On the host
 * lane the prototype lives in a sidecar keyed by the closure STRUCT and
 * `__register_fnctor_instance` links each instance to the constructor value the
 * `new` site evaluated, so binding the name to a fresh closure per activation is
 * the whole fix there.
 *
 * Scope (deliberately narrow, everything else keeps the singleton and its exact
 * bytes):
 *  - host lane only — standalone keeps a per-NAME prototype global
 *    (`__fnctor_proto_<F>`) and needs the prototype slot to travel with the
 *    function object first (see the issue's standalone residual);
 *  - a capture-free declaration directly in a FUNCTION body (capturing ones are
 *    already built per site, module-level ones have one activation);
 *  - the body writes `<name>.prototype = …` — the shape whose identity is
 *    observable through every later `new`;
 *  - every other mention of the name is in that same body, outside any nested
 *    function (those would still resolve the per-name singleton), and the name
 *    is not redeclared there; no direct `eval`, no `arguments` in the
 *    declaration (`arguments.callee` reads the singleton).
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { closureAllocInstrs, ensureFuncClosureSingleton, fnMetaAllocOf } from "../closures/method-trampolines.js";
import { normalizeOrdinaryFunctionConstructibility } from "../closures/ordinary-fn-constructibility.js";
import { allocLocal } from "../context/locals.js";

/**
 * Per-ACTIVATION sibling of `emitCachedFuncClosureAccess`: leave a FRESH closure
 * for `funcName` on the stack as an `externref`, sharing the singleton's
 * trampoline and wrapper type but not its cache global. Returns false (emits
 * nothing) when the singleton machinery declines.
 */
function emitFreshFuncClosure(ctx: CodegenContext, fctx: FunctionContext, funcName: string, funcIdx: number): boolean {
  const constructible = normalizeOrdinaryFunctionConstructibility(ctx, funcName, false);
  const singleton = ensureFuncClosureSingleton(ctx, funcName, funcIdx, constructible);
  if (!singleton) return false;
  const { trampolineFuncIdx, closureStructTypeIdx: structTypeIdx } = singleton;
  const arity = ctx.closureInfoByTypeIdx.get(structTypeIdx)?.paramTypes.length ?? 0;
  fctx.body.push(
    ...closureAllocInstrs(trampolineFuncIdx, structTypeIdx, arity, constructible, fnMetaAllocOf(singleton)),
  );
  return true;
}

function isPrototypeWriteOf(node: ts.Node, name: string): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const lhs = node.left;
  return (
    ts.isPropertyAccessExpression(lhs) &&
    lhs.name.text === "prototype" &&
    ts.isIdentifier(lhs.expression) &&
    lhs.expression.text === name
  );
}

function declaresName(node: ts.Node, name: string): boolean {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isBindingElement(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name) &&
    node.name.text === name
  ) {
    return true;
  }
  return false;
}

/** The syntactic gate described in the module comment. */
function needsActivationIdentity(decl: ts.FunctionDeclaration, body: ts.Block): boolean {
  const name = decl.name?.text;
  if (name === undefined || decl.body === undefined) return false;
  if (decl.asteriskToken !== undefined || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return false;
  }
  let prototypeWrite = false;
  let unsafe = false;
  const visit = (node: ts.Node, inNestedFunction: boolean): void => {
    if (unsafe) return;
    if (node === decl) {
      // The declaration's own body must not observe its identity.
      decl.body!.forEachChild(function inner(n): void {
        if (ts.isIdentifier(n) && (n.text === name || n.text === "arguments" || n.text === "eval")) unsafe = true;
        else n.forEachChild(inner);
      });
      return;
    }
    if (declaresName(node, name)) {
      unsafe = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "eval") unsafe = true;
      else if (node.text === name && inNestedFunction) unsafe = true;
      return;
    }
    if (!inNestedFunction && isPrototypeWriteOf(node, name)) prototypeWrite = true;
    const nested = inNestedFunction || ts.isFunctionLike(node) || ts.isClassLike(node);
    node.forEachChild((child) => visit(child, nested));
  };
  for (const stmt of body.statements) visit(stmt, false);
  return prototypeWrite && !unsafe;
}

/**
 * Bind each gated nested declaration of `stmts` to a fresh closure in a local
 * of the same name, at function entry (after the hoist compiled the bodies).
 * Identifier reads prefer the local, so every `.prototype` write and every
 * `new` site in this activation observes this activation's function object.
 */
export function bindActivationFnctorClosures(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: readonly ts.Statement[],
): void {
  if (ctx.standalone || ctx.wasi) return;
  const body = stmts[0]?.parent;
  if (body === undefined || !ts.isBlock(body) || !ts.isFunctionLike(body.parent)) return;
  for (const stmt of stmts) {
    if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined) continue;
    const name = stmt.name.text;
    if ((ctx.nestedFuncCaptures.get(name)?.length ?? 0) > 0 || fctx.boxedCaptures?.has(name)) continue;
    if (ctx.funcMapOwnerDecl.get(name) !== stmt || fctx.materializedHoistedFunctionValueBindings?.has(name)) continue;
    const reserved = fctx.localMap.get(name);
    // A pre-existing local must be the lazy hoisted-value binding (#prepare-
    // HoistedFunctionValueBindings), whose singleton materializer we pre-empt.
    if (reserved !== undefined && !fctx.hoistedFunctionValueBindings?.has(name)) continue;
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined || !needsActivationIdentity(stmt, body)) continue;
    if (!emitFreshFuncClosure(ctx, fctx, name, funcIdx)) continue;
    fctx.body.push({ op: "local.set", index: reserved ?? allocLocal(fctx, name, { kind: "externref" }) });
    // Published once, here: no read site may re-materialize the singleton over
    // it (the lazy materializer re-emits only for an unreassigned declaration).
    (fctx.materializedHoistedFunctionValueBindings ??= new Set()).add(name);
    (ctx.reassignedFunctionDeclarations ??= new WeakSet()).add(stmt);
  }
}
