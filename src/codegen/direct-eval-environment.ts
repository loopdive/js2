// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-function direct-eval environment reification (#2925/#2929).
 *
 * The AOT compiler already represents a mutable closure capture as a one-field
 * ref cell and routes identifier reads/writes through `boxedCaptures`. Direct
 * eval uses that same mechanism: only lexical ancestors of a real direct-eval
 * call promote their source bindings, and the interpreter receives references
 * to those cells. This keeps non-eval functions byte-neutral and avoids a
 * second environment representation or a lossy copy-in/copy-out bridge.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { TypeOracle } from "../checker/oracle.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getOrRegisterRefCellType } from "./registry/types.js";
import { coerceType } from "./shared.js";

function isGlobalEvalIdentifier(ident: ts.Identifier, oracle: TypeOracle): boolean {
  const declaration = oracle.valueDeclarationOf(ident);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

function isDirectEvalCall(node: ts.Node, oracle: TypeOracle): boolean {
  if (!ts.isCallExpression(node) || node.questionDotToken) return false;
  let callee: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && callee.text === "eval" && isGlobalEvalIdentifier(callee, oracle);
}

/**
 * A direct eval in a nested lexical descendant can still name an outer
 * binding, so the scan deliberately descends through nested functions. Each
 * nested function is compiled separately and receives its own binding set too.
 */
export function functionMayReachDirectEval(decl: ts.FunctionLikeDeclaration, oracle: TypeOracle): boolean {
  if (!decl.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isDirectEvalCall(node, oracle)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(decl.body);
  return found;
}

function addBindingName(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    if (name.text !== "this") names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingName(element.name, names);
  }
}

/** Collect bindings owned by `decl`, without stealing declarations from a
 * nested function/class scope. `arguments` is implicit but visible to eval. */
export function collectDirectEvalBindingNames(decl: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  // Arrow functions inherit `arguments` from their lexical parent; ordinary
  // functions create their own binding.
  if (!ts.isArrowFunction(decl)) names.add("arguments");
  for (const param of decl.parameters) addBindingName(param.name, names);

  const root = decl.body;
  if (!root) return names;
  const visit = (node: ts.Node): void => {
    if (node !== root) {
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) names.add(node.name.text);
        return;
      }
      if (
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        return;
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        if (node.name) names.add(node.name.text);
        return;
      }
    }
    if (ts.isVariableDeclaration(node)) addBindingName(node.name, names);
    if (ts.isCatchClause(node) && node.variableDeclaration) addBindingName(node.variableDeclaration.name, names);
    forEachChild(node, visit);
  };
  visit(root);
  return names;
}

/** Collect bindings whose lifetime is the whole current activation.
 *
 * This is intentionally narrower than `collectDirectEvalBindingNames`: nested
 * block/catch lexicals are call-site environment entries, while parameters,
 * the function body's top-level declarations, and recursively nested `var`
 * declarations belong to the persistent function activation. */
export function collectDirectEvalActivationBindingNames(decl: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  if (!ts.isArrowFunction(decl)) names.add("arguments");
  for (const param of decl.parameters) addBindingName(param.name, names);
  if (!decl.body || !ts.isBlock(decl.body)) return names;

  for (const statement of decl.body.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingName(declaration.name, names);
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
    }
  }

  const visitVarScoped = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      if (ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        addBindingName(node.name, names);
      }
    }
    forEachChild(node, visitVarScoped);
  };
  for (const statement of decl.body.statements) visitVarScoped(statement);
  return names;
}

function boxTopAsExternref(ctx: CodegenContext, fctx: FunctionContext, type: ValType): void {
  if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
}

/** Promote every currently allocated eval-visible binding to the canonical
 * `(mut externref)` cell. Calling this again is intentional: block/catch/loop
 * bindings can be allocated after the function-entry hoist pass. */
export function reifyCurrentDirectEvalBindings(ctx: CodegenContext, fctx: FunctionContext): void {
  const names = fctx.directEvalBindingNames;
  if (!names) return;
  const cellTypeIdx = fctx.directEvalRefCellTypeIdx ?? getOrRegisterRefCellType(ctx, { kind: "externref" });
  fctx.directEvalRefCellTypeIdx = cellTypeIdx;
  if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
  if (!fctx.directEvalActivationBindings) fctx.directEvalActivationBindings = new Map();

  for (const name of names) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    const existingMetadata = fctx.boxedCaptures.get(name);
    const currentLocalType = getLocalType(fctx, localIdx);
    // A rolled-back speculative promotion may have restored localMap while an
    // older snapshot implementation left the boxed metadata re-pointed. Never
    // trust cell metadata unless the live local actually carries that cell.
    const existing =
      existingMetadata &&
      (currentLocalType?.kind === "ref" || currentLocalType?.kind === "ref_null") &&
      currentLocalType.typeIdx === existingMetadata.refCellTypeIdx
        ? existingMetadata
        : undefined;
    if (existing?.refCellTypeIdx === cellTypeIdx && existing.valType.kind === "externref") {
      if (fctx.directEvalActivationBindingNames?.has(name)) {
        if (!fctx.directEvalActivationBindings.has(name)) {
          fctx.directEvalActivationBindings.set(name, localIdx);
        }
      }
      continue;
    }

    let valueType: ValType | undefined;
    if (existing) {
      // A default-parameter closure can box a param before the body pre-pass.
      // Promote the currently shared value into the canonical eval cell. Later
      // AOT reads/writes use this cell; ordinary body-hoisted closures see the
      // canonical cell because this pass runs before their compilation.
      fctx.body.push(
        { op: "local.get", index: localIdx },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: existing.refCellTypeIdx, fieldIdx: 0 },
      );
      valueType = existing.valType;
    } else {
      valueType = getLocalType(fctx, localIdx);
      if (!valueType) continue;
      fctx.body.push({ op: "local.get", index: localIdx });
    }
    boxTopAsExternref(ctx, fctx, valueType);

    const cellLocal = allocLocal(fctx, `__direct_eval_cell_${name}_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: cellTypeIdx,
    });
    fctx.body.push({ op: "struct.new", typeIdx: cellTypeIdx }, { op: "local.set", index: cellLocal });
    fctx.localMap.set(name, cellLocal);
    fctx.boxedCaptures.set(name, { refCellTypeIdx: cellTypeIdx, valType: { kind: "externref" } });
    if (fctx.directEvalActivationBindingNames?.has(name)) {
      if (!fctx.directEvalActivationBindings.has(name)) {
        fctx.directEvalActivationBindings.set(name, cellLocal);
      }
    }
  }
}

export interface DirectEvalBinding {
  name: string;
  cellLocal: number;
}

export interface DirectEvalBindingLayers {
  /** Persistent current-function environment, including eval-created vars. */
  activation: DirectEvalBinding[];
  /** Fresh lexical shadows visible at this particular call site. */
  lexical: DirectEvalBinding[];
  /** Canonical cells captured from outer function activations. */
  outer: DirectEvalBinding[];
}

/** Snapshot the cells visible at one direct-eval call site, after promoting any
 * binding allocated since the entry pre-pass (e.g. a block shadow). */
export function currentDirectEvalBindings(ctx: CodegenContext, fctx: FunctionContext): DirectEvalBindingLayers {
  reifyCurrentDirectEvalBindings(ctx, fctx);
  const names = fctx.directEvalBindingNames;
  const cellTypeIdx = fctx.directEvalRefCellTypeIdx;
  const activation: DirectEvalBinding[] = [];
  const lexical: DirectEvalBinding[] = [];
  const outer: DirectEvalBinding[] = [];
  if (!names || cellTypeIdx === undefined) return { activation, lexical, outer };

  for (const [name, cellLocal] of fctx.directEvalActivationBindings ?? []) {
    activation.push({ name, cellLocal });
  }

  for (const name of names) {
    const cellLocal = fctx.localMap.get(name);
    const boxed = fctx.boxedCaptures?.get(name);
    if (cellLocal !== undefined && boxed?.refCellTypeIdx === cellTypeIdx && boxed.valType.kind === "externref") {
      if (fctx.directEvalOuterBindingNames?.has(name)) {
        outer.push({ name, cellLocal });
      } else if (fctx.directEvalActivationBindings?.get(name) !== cellLocal) {
        lexical.push({ name, cellLocal });
      }
    }
  }
  return { activation, lexical, outer };
}
