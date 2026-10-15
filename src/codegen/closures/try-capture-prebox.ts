// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6993) Pre-box closure captures that a `try … finally` shares with its
 * finally body.
 *
 * `compileTryStatement` compiles the finally body ONCE, before the try block
 * and the catch clause, so it can clone the instructions into every exit path.
 * Capture boxing is lazy: the first closure construction promotes a mutable
 * captured local to a ref cell and re-aims `localMap` from there on. A closure
 * first constructed inside the try block (or catch clause) therefore boxes the
 * binding AFTER the finally clone was emitted against the raw slot — the
 * finally's `x = 5` lands in the dead slot and the closure reads the stale
 * cell. The mirror case (closure first built in the finally, binding written
 * in the try block) mints the cell from the raw slot only when the finally
 * runs, dropping the try block's write.
 *
 * Promoting such a binding to its cell BEFORE the finally is compiled makes the
 * finally clones, the try block, the catch clause and every closure share one
 * cell. The cell stays the binding's storage for the rest of the function,
 * exactly as the construction site would have left it (the #6960 loop
 * `functionWide` pre-box): once the try statement is behind us, a path that
 * skipped it (the try sits in a conditional arm) may still hold a null cell, so
 * the raw slot is recorded for the lazy repair (conditional-capture-box.ts).
 *
 * Admission (narrow on purpose — every other try statement compiles exactly as
 * before): the statement has a finally block; the name is captured by a nested
 * closure somewhere in the statement, referenced from the finally block, and
 * written somewhere in the statement (a read-only capture keeps its unboxed
 * slot); it is a value-typed local of this frame that is not already boxed, is
 * not still in its TDZ at the statement (see `lexicalDeclaredBefore`), is not a `__module_init` shadow of a module global, is not a
 * parameter of a function with a mapped `arguments` object, and is not
 * lexically (re)declared inside the statement (a block-scoped `let`/`const`/
 * class/function or the catch parameter is a different binding).
 *
 * TODO(#6992): the write scan is `findNamesWrittenInLoop` (node-generic); route
 * it through the shared written-bindings helper #6992 introduces, and lift the
 * cell minting below and the loop pre-box (`preBoxLoopCapturedBindings`,
 * statements/loops.ts) into one helper once both land.
 */
import type { ValType } from "../../ir/types.js";
import { ts, forEachChild } from "../../ts-api.js";
import { collectPatternBindingNames, collectReferencedIdentifiers } from "../../ir/analysis/ast-scope.js";
import { collectNamesCapturedByClosures, findNamesWrittenInLoop } from "../../ir/analysis/loop-shape.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getOrRegisterRefCellType } from "../registry/types.js";
import { scopeVariableDeclarations } from "./declaration-write-analysis.js";

/** A binding promoted by {@link preBoxTryFinallyCapturedBindings}. */
export interface TryPreBoxedBinding {
  name: string;
  refCellTypeIdx: number;
  valType: ValType;
  rawLocalIdx: number;
}

/** Names lexically declared inside the try statement (not crossing nested functions). */
function collectLexicalNamesDeclaredWithin(stmt: ts.TryStatement): Set<string> {
  const names = new Set<string>();
  const decl = stmt.catchClause?.variableDeclaration;
  if (decl) for (const n of collectPatternBindingNames(decl.name)) names.add(n);
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassExpression(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) !== 0) {
      for (const d of node.declarations) for (const n of collectPatternBindingNames(d.name)) names.add(n);
    }
    forEachChild(node, visit);
  };
  visit(stmt.tryBlock);
  if (stmt.catchClause) visit(stmt.catchClause.block);
  if (stmt.finallyBlock) visit(stmt.finallyBlock);
  return names;
}

/**
 * A TDZ-flagged `let`/`const` is admitted only when its declaration precedes
 * the try statement: its flag then cannot change inside the statement, so the
 * finally's TDZ checks against the raw flag stay exact while the closures box
 * the flag themselves. A binding still in its TDZ here keeps the lazy path.
 */
function lexicalDeclaredBefore(stmt: ts.TryStatement, name: string): boolean {
  let scope: ts.Node | undefined = stmt.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  if (!scope) return false;
  const decl = scopeVariableDeclarations(scope).get(name);
  return decl !== undefined && decl.end <= stmt.pos;
}

function isBoxableValueType(type: ValType): boolean {
  switch (type.kind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64":
    case "externref":
    case "ref_null":
    case "ref":
      return true;
    default:
      return false;
  }
}

/**
 * Box every admitted binding into a fresh ref cell at the CURRENT body position
 * (must be the try statement's outer body, before the finally is compiled) and
 * re-aim `localMap` at the cell. Returns the promoted bindings for
 * {@link finishTryFinallyPreBox}.
 */
export function preBoxTryFinallyCapturedBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.TryStatement,
): TryPreBoxedBinding[] {
  const preBoxed: TryPreBoxedBinding[] = [];
  if (!stmt.finallyBlock) return preBoxed;
  const captured = new Set<string>();
  collectNamesCapturedByClosures(stmt, captured);
  if (captured.size === 0) return preBoxed;
  const inFinally = new Set<string>();
  collectReferencedIdentifiers(stmt.finallyBlock, inFinally);
  let written: Set<string> | undefined;
  let declaredWithin: Set<string> | undefined;
  for (const name of captured) {
    if (!inFinally.has(name)) continue;
    if (fctx.boxedCaptures?.has(name)) continue;
    if (fctx.tdzFlagLocals?.has(name) && !lexicalDeclaredBefore(stmt, name)) continue;
    const rawLocalIdx = fctx.localMap.get(name);
    if (rawLocalIdx === undefined) continue; // module global / import / unbound
    if (fctx.moduleBindingShadowLocals?.get(name) === rawLocalIdx) continue;
    if (rawLocalIdx < fctx.params.length && fctx.mappedArgsInfo) continue;
    written ??= findNamesWrittenInLoop(stmt);
    if (!written.has(name)) continue;
    declaredWithin ??= collectLexicalNamesDeclaredWithin(stmt);
    if (declaredWithin.has(name)) continue;
    const valType = getLocalType(fctx, rawLocalIdx);
    if (valType === undefined || !isBoxableValueType(valType)) continue;
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, valType);
    const boxedLocal = allocLocal(fctx, `__pre_box_${name}`, { kind: "ref_null", typeIdx: refCellTypeIdx });
    fctx.body.push({ op: "local.get", index: rawLocalIdx });
    fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
    fctx.body.push({ op: "local.set", index: boxedLocal });
    fctx.localMap.set(name, boxedLocal);
    (fctx.boxedCaptures ??= new Map()).set(name, { refCellTypeIdx, valType });
    preBoxed.push({ name, refCellTypeIdx, valType, rawLocalIdx });
  }
  return preBoxed;
}

/**
 * After the whole try statement: the cell dominated every access inside it,
 * but a later path may have skipped the statement, so record the raw slot for
 * the lazy repair. The cell stays the binding's storage (function-wide).
 */
export function finishTryFinallyPreBox(fctx: FunctionContext, preBoxed: readonly TryPreBoxedBinding[]): void {
  for (const pb of preBoxed) {
    fctx.boxedCaptures?.set(pb.name, {
      refCellTypeIdx: pb.refCellTypeIdx,
      valType: pb.valType,
      rawLocalIdx: pb.rawLocalIdx,
    });
  }
}
