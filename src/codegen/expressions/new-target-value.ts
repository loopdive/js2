// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 S4) `new.target` as a first-class VALUE on the standalone target.
//
// The #2023 machinery (new-target.ts) keeps an i32 CLASS-ID in a module global
// and lowers only `new.target === C` against it. Every other use — `nt =
// new.target`, `typeof new.target`, a `new.target` read in a plain function
// constructor or in an arrow — needs the constructor OBJECT:
//
//   * a class constructor maps the live class-id back to the class object; only
//     the current class and its subclasses can be the derived-most target, so
//     the dispatch covers exactly that set (anything else reads `undefined`);
//   * a plain function's synthesized `new F()` body (`isFnctorConstructor`)
//     answers `F` itself, read through `newTargetValueNode`; the plain-call
//     body of the same function never sets it, so it answers `undefined`;
//   * an arrow has no own `new.target`: its creator snapshots the value into
//     `NEW_TARGET_LEXICAL_LOCAL`, which the closure captures like any binding.
import { ts, forEachChild } from "../../ts-api.js";
import type { ValType, Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { coerceType, compileExpression, resolveEnclosingClassName } from "../shared.js";
// Late-bound: a direct import of late-imports.ts would close an import cycle (#6797).
import { emitUndefined } from "../registry/expression-helper-delegates.js";
import { emitNewTargetClassId, getOrAssignClassNewTargetId } from "../new-target.js";

/** Closure-captured local holding an arrow's lexical `new.target`. */
export const NEW_TARGET_LEXICAL_LOCAL = "__new_target_lex";

function isNewTargetMeta(node: ts.Node): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === "target";
}

/** Does `node` read `new.target` in ITS OWN activation (arrows included, other functions/classes not)? */
export function referencesOwnNewTarget(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isNewTargetMeta(n)) {
      found = true;
      return;
    }
    if ((ts.isFunctionLike(n) && !ts.isArrowFunction(n)) || ts.isClassLike(n)) return;
    forEachChild(n, visit);
  };
  forEachChild(node, visit);
  return found;
}

/** Emits `new.target` as an externref value. Only called on the standalone target. */
export function compileNewTargetValue(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const lexical = fctx.localMap.get(NEW_TARGET_LEXICAL_LOCAL);
  if (lexical !== undefined) {
    fctx.body.push({ op: "local.get", index: lexical });
    return { kind: "externref" };
  }
  if (fctx.isFnctorConstructor && fctx.newTargetValueNode !== undefined) {
    return emitAsExternref(ctx, fctx, fctx.newTargetValueNode);
  }
  const className = fctx.isConstructor && ctx.usesNewTarget ? resolveEnclosingClassName(fctx) : undefined;
  if (className !== undefined && ctx.classSet.has(className)) return emitClassNewTargetValue(ctx, fctx, className);
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}

function emitAsExternref(ctx: CodegenContext, fctx: FunctionContext, node: ts.Expression): ValType {
  const t = compileExpression(ctx, fctx, node, { kind: "externref" });
  if (t === null || t === undefined) fctx.body.push({ op: "ref.null.extern" });
  else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  return { kind: "externref" };
}

/** `className` and every class whose parent chain reaches it, each with a named declaration. */
function constructibleTargets(
  ctx: CodegenContext,
  className: string,
): { name: string; id: ts.Identifier }[] | undefined {
  const out: { name: string; id: ts.Identifier }[] = [];
  for (const [name, decl] of ctx.classDeclarationMap) {
    let cur: string | undefined = name;
    const seen = new Set<string>();
    while (cur !== undefined && cur !== className && !seen.has(cur)) {
      seen.add(cur);
      cur = ctx.classParentMap.get(cur);
    }
    if (cur !== className) continue;
    const id =
      decl.name ??
      (ts.isVariableDeclaration(decl.parent) && ts.isIdentifier(decl.parent.name) ? decl.parent.name : undefined);
    if (id === undefined) return undefined; // an unnameable target: keep the legacy class-id
    out.push({ name, id });
  }
  return out;
}

function emitClassNewTargetValue(ctx: CodegenContext, fctx: FunctionContext, className: string): ValType {
  const targets = constructibleTargets(ctx, className);
  if (targets === undefined) {
    emitNewTargetClassId(ctx, fctx.body); // #2023 lowering: truthy inside a construction
    return { kind: "i32" };
  }
  const idLocal = allocTempLocal(fctx, { kind: "i32" });
  emitNewTargetClassId(ctx, fctx.body);
  fctx.body.push({ op: "local.set", index: idLocal });
  const saved = fctx.body;
  fctx.body = [];
  emitUndefined(ctx, fctx);
  let chain: Instr[] = fctx.body;
  for (const target of targets) {
    fctx.body = [];
    emitAsExternref(ctx, fctx, target.id);
    const then = fctx.body;
    chain = [
      { op: "local.get", index: idLocal },
      { op: "i32.const", value: getOrAssignClassNewTargetId(ctx, target.name) },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then, else: chain },
    ];
  }
  fctx.body = saved;
  fctx.body.push(...chain);
  releaseTempLocal(fctx, idLocal);
  return { kind: "externref" };
}

/**
 * At an arrow's creation, snapshot the creator's `new.target` into a private
 * frame slot (`fctx.newTargetSnapshotLocal`) that the arrow captures under
 * `NEW_TARGET_LEXICAL_LOCAL`. The slot is deliberately NOT the creator's own
 * binding: a creator read compiled after it may execute before it is written.
 */
export function snapshotArrowNewTarget(ctx: CodegenContext, fctx: FunctionContext, arrow: ts.Node): void {
  if (!ctx.standalone || !ts.isArrowFunction(arrow) || !referencesOwnNewTarget(arrow)) return;
  compileNewTargetValue(ctx, fctx);
  const slot = fctx.newTargetSnapshotLocal ?? allocLocal(fctx, "__new_target_snapshot", { kind: "externref" });
  fctx.newTargetSnapshotLocal = slot;
  fctx.body.push({ op: "local.set", index: slot });
}

/** The capture-analysis twin: does this arrow capture the creator's snapshot? */
export function arrowCapturesNewTarget(ctx: CodegenContext, fctx: FunctionContext, arrow: ts.Node): boolean {
  return (
    ctx.standalone &&
    fctx.newTargetSnapshotLocal !== undefined &&
    ts.isArrowFunction(arrow) &&
    referencesOwnNewTarget(arrow)
  );
}

/** The binding a fnctor's `new.target` reads: `function F(){}` → `F`, `var F = function(){}` → `F`. */
export function fnctorBindingName(fn: ts.FunctionLikeDeclaration): ts.Identifier | undefined {
  const parent = fn.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name;
  return fn.name !== undefined && ts.isIdentifier(fn.name) ? fn.name : undefined;
}
