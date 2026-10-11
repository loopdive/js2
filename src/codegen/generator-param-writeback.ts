// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A12) A native generator's parameter keeps a write across a suspension.
 *
 * The native frame carries each parameter in a `param_*` field that the
 * factory fills at call time, and every `.next()` re-enters the detached
 * resume function, whose prelude copies those fields into locals. Until A12
 * the fields were immutable and nothing stored a parameter local back — the
 * spill store that runs before each suspension (`frame-core.ts storeSpills`)
 * covers body-declared locals only. So every write to a parameter was undone
 * by the next resume:
 *
 *     function* g(a, b) { arguments[1] = 54; yield a; yield b; }
 *     // g(1, 2): the second next() re-read `b` from the frame -> 2, not 54
 *
 * (`language/expressions/yield/formal-parameters-after-reassignment-non-strict.js`).
 * A plain `a = 5; yield; yield a` lost the write the same way, on both
 * targets — the mapped `arguments` vec itself is frame-carried, so the two
 * copies of the binding disagreed after the first suspension.
 *
 * The fix makes the field of each WRITABLE parameter mutable and stores the
 * parameter local back wherever the spills are stored. A parameter nothing can
 * write keeps its immutable field and its bytes — including its wasm type
 * (an f64 lane stays f64): only mutability and the store-back change.
 *
 * "Writable" over-approximates, never under-approximates:
 *  - an assignment / update / destructuring-assignment target, a `for-in/of`
 *    head, a `var` re-declaration with an initializer (or as a loop head) and a
 *    function declaration of the same name, anywhere in the body — including
 *    nested functions, whose own shadowing bindings are not tracked (a false
 *    positive costs one `struct.set` per suspension, a false negative loses a
 *    write);
 *  - with a MAPPED `arguments` object (sloppy, simple parameter list): every
 *    parameter as soon as `arguments` is written through (`arguments[i] = v`)
 *    or escapes (`f(arguments)`, `Object.defineProperty(arguments, …)`,
 *    `var args = arguments`) — the #4701 reverse sync can write any formal
 *    from there. A pure read (`arguments[i]`, `arguments.length`,
 *    `...arguments`) writes nothing. Nested non-arrow functions have their own
 *    `arguments` and are not scanned for it.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { valTypesMatch } from "./shared.js";
import { walkChildren, walkInstructions } from "./walk-instructions.js";

type GeneratorDecl = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression;

/**
 * Indices into the frame's `paramNames` (source parameters start at
 * `sourceOffset`, after a synthetic receiver or leading captures) whose binding
 * the body can write. Binding-pattern parameters are excluded: their bound
 * names already ride the frame as spills.
 */
export function writableGeneratorParamIndices(
  decl: GeneratorDecl,
  sourceOffset: number,
  argumentsMapped: boolean,
): ReadonlySet<number> {
  const out = new Set<number>();
  const body = decl.body;
  if (!body) return out;
  const byName = new Map<string, number[]>();
  decl.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name)) return;
    const list = byName.get(p.name.text) ?? [];
    list.push(sourceOffset + i);
    byName.set(p.name.text, list);
  });
  if (byName.size === 0) return out;
  let allWritten = false;
  const markName = (name: string): void => {
    for (const idx of byName.get(name) ?? []) out.add(idx);
  };
  const markTarget = (target: ts.Node): void => {
    if (ts.isIdentifier(target)) markName(target.text);
    else if (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target)) markTarget(target.expression);
    else if (ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isSatisfiesExpression(target))
      markTarget(target.expression);
    else if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target)) markTarget(target.expression);
    else if (ts.isArrayLiteralExpression(target)) target.elements.forEach(markTarget);
    else if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties) {
        if (ts.isPropertyAssignment(prop)) markTarget(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) markName(prop.name.text);
        else if (ts.isSpreadAssignment(prop)) markTarget(prop.expression);
      }
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      markTarget(target.left); // a destructuring default: `[a = 1] = …`
    } else if (ts.isArrayBindingPattern(target) || ts.isObjectBindingPattern(target)) {
      for (const el of target.elements) if (!ts.isOmittedExpression(el)) markTarget(el.name);
    }
  };
  const visit = (node: ts.Node, ownArguments: boolean): void => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) markTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markTarget(node.operand);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      markTarget(node.initializer);
    } else if (ts.isVariableDeclaration(node) && isVarRedeclarationWrite(node)) {
      markTarget(node.name);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      markName(node.name.text);
    } else if (argumentsMapped && ownArguments && ts.isIdentifier(node) && node.text === "arguments") {
      if (argumentsUseMayWrite(node)) allWritten = true;
    }
    // A nested non-arrow function has its own `arguments` (§10.2.11 step 15).
    const childOwnArguments = ownArguments && !(ts.isFunctionLike(node) && !ts.isArrowFunction(node));
    ts.forEachChild(node, (child) => visit(child, childOwnArguments));
  };
  visit(body, true);
  if (allWritten) for (const list of byName.values()) for (const idx of list) out.add(idx);
  return out;
}

/** `var a = v`, or `var a` as a for-in/of head — both assign the parameter binding. */
function isVarRedeclarationWrite(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return false;
  return node.initializer !== undefined || ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent);
}

/** A use of the mapped `arguments` object other than a pure read of it. */
function argumentsUseMayWrite(id: ts.Identifier): boolean {
  let child: ts.Node = id;
  let parent = id.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  // `x.arguments` / `{ arguments: v }`: a property name, not this binding.
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === child) return false;
  if (ts.isSpreadElement(parent) || ts.isTypeOfExpression(parent)) return false;
  // `arguments[i]` / `arguments.length`: a read unless the access is a write target.
  if ((ts.isElementAccessExpression(parent) || ts.isPropertyAccessExpression(parent)) && parent.expression === child) {
    return isWriteTarget(parent);
  }
  return true; // an escape: an argument, an initializer, a return value, …
}

function isWriteTarget(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isObjectLiteralExpression(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && parent.left === child;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === child;
  return false;
}

/**
 * Run once the resume body is compiled. The store-back `storeSpills` emitted
 * is `local.get <param>; struct.set <field>`, typed at emission time — but the
 * resume function's parameter is an ordinary LOCAL, which a later `var a = 5`
 * re-declaration may re-type (externref -> f64; a real wasm param never is).
 * Such a store no longer validates, so its `local.get` is rewritten:
 *  - numeric <-> externref: through a field-typed temporary, whose `local.set`
 *    the stack-balance repair coerces exactly as it does the prelude's copy
 *    the other way round;
 *  - anything else: to a re-read of the field itself — the store becomes a
 *    no-op, the pre-A12 behaviour, rather than invalid Wasm.
 */
export function reconcileParamWriteBack(fctx: FunctionContext, info: NativeGeneratorInfo): void {
  const stale: { local: number; field: number; type: ValType; numeric: boolean; temp?: number }[] = [];
  for (const param of info.paramWriteBack ?? []) {
    const fieldType = info.paramTypes[param.field - info.paramFieldOffset];
    const localType = fctx.locals[param.local - fctx.params.length]?.type;
    if (!fieldType || !localType || valTypesMatch(localType, fieldType)) continue;
    if (localType.kind === "ref" && fieldType.kind === "ref_null" && localType.typeIdx === fieldType.typeIdx) continue;
    const scalar = (t: ValType) => t.kind === "f64" || t.kind === "i32" || t.kind === "i64";
    const numeric =
      (scalar(localType) && fieldType.kind === "externref") || (localType.kind === "externref" && scalar(fieldType));
    stale.push({ ...param, type: fieldType, numeric });
  }
  if (stale.length === 0) return;
  const rewrite = (arr: Instr[]): void => {
    for (let i = 0; i + 1 < arr.length; i++) {
      const get = arr[i]!;
      const set = arr[i + 1]!;
      if (get.op !== "local.get" || set.op !== "struct.set" || set.typeIdx !== info.stateTypeIdx) continue;
      const entry = stale.find((p) => p.local === get.index && p.field === set.fieldIdx);
      if (!entry) continue;
      const body: Instr[] = entry.numeric
        ? [
            get,
            { op: "local.set", index: (entry.temp ??= allocLocal(fctx, `__gen_param_wb_${entry.field}`, entry.type)) },
            { op: "local.get", index: entry.temp },
          ]
        : [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: entry.field },
          ];
      arr[i] = { op: "block", blockType: { kind: "val", type: entry.type }, body };
    }
  };
  rewrite(fctx.body);
  walkInstructions(fctx.body, (instr) => walkChildren(instr, rewrite));
}
