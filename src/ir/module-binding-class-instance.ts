// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7252) Admission for a SCRIPT `var` that only ever holds instances of one
 * top-level class. Legacy stores it in a `(ref null $Class)` `__mod_<name>`
 * slot (`scriptVarHome`'s `class-instance` home); the IR reads it as that
 * class's non-null `class` value, so every IR read must see a written slot:
 *   - every write anywhere in the source (the initializer, `=`, a `var`
 *     redeclaration, a nested function's assignment) is `new X(...)` of the
 *     same class, and no `with` / direct `eval` resolves a name outside
 *     checker identity, so a written slot never holds `null` or another class;
 *   - an IR use is a module-init use that runs after the declaration: a
 *     top-level statement after it, outside every function and class body,
 *     and not the operand of `typeof` / `delete`.
 * A use anywhere else is refused at its site and stays on the direct path,
 * which reads the same slot.
 */
import { ts } from "../ts-api.js";
import { hasDynamicScope, identifierWritesOf, outermostParenthesized, stripParens } from "../shared/binding-writes.js";
import type { IrModuleBindingValueKind } from "./module-binding-value-kinds.js";

type ClassInstanceKind = Extract<IrModuleBindingValueKind, { kind: "class-instance" }>;

const bindingClassCache = new WeakMap<ts.VariableDeclaration, ts.ClassDeclaration | null>();

/** The top-level class of this source that `expr` constructs (`new X(...)`), if any. */
function constructedTopLevelClass(checker: ts.TypeChecker, expr: ts.Expression): ts.ClassDeclaration | undefined {
  const candidate = stripParens(expr);
  if (!ts.isNewExpression(candidate) || !ts.isIdentifier(candidate.expression)) return undefined;
  const declaration = checker.getSymbolAtLocation(candidate.expression)?.valueDeclaration;
  return declaration !== undefined &&
    ts.isClassDeclaration(declaration) &&
    declaration.name !== undefined &&
    declaration.parent === expr.getSourceFile()
    ? declaration
    : undefined;
}

function computeBindingClass(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  declaredType: ts.Type,
): ts.ClassDeclaration | undefined {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return undefined;
  const classDeclaration = constructedTopLevelClass(checker, declaration.initializer);
  if (classDeclaration === undefined) return undefined;
  const classSymbol = checker.getSymbolAtLocation(classDeclaration.name!);
  if (declaredType.isUnion() || declaredType.getSymbol() !== classSymbol) return undefined;
  const sourceFile = declaration.getSourceFile();
  if (hasDynamicScope(sourceFile)) return undefined;
  const bindingSymbol = checker.getSymbolAtLocation(declaration.name);
  let exact = true;
  const visit = (node: ts.Node): void => {
    if (!exact) return;
    for (const write of identifierWritesOf(node)) {
      if (checker.getSymbolAtLocation(write.target) !== bindingSymbol) continue;
      if (write.kind !== "value" || constructedTopLevelClass(checker, write.expr) !== classDeclaration) exact = false;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return exact ? classDeclaration : undefined;
}

/** The kind of a binding every write of which constructs one class, or `undefined`. */
export function classInstanceValueKind(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration | ts.BindingElement,
  declaredType: ts.Type,
): ClassInstanceKind | undefined {
  if (!ts.isVariableDeclaration(declaration)) return undefined;
  let cached = bindingClassCache.get(declaration);
  if (cached === undefined) {
    cached = computeBindingClass(checker, declaration, declaredType) ?? null;
    bindingClassCache.set(declaration, cached);
  }
  return cached ? { kind: "class-instance", classDeclaration: cached } : undefined;
}

/** True when `value` constructs exactly the binding's class. */
export function classInstanceWriteMatches(
  checker: ts.TypeChecker,
  target: ClassInstanceKind,
  value: ts.Expression,
): boolean {
  return constructedTopLevelClass(checker, value) === target.classDeclaration;
}

/**
 * True when `node` is the declaration itself or a module-init use that runs
 * after it, so the script var's slot has been written. (#7274) Shared with the
 * native-buffer script vars, which certify their writes the same way.
 */
export function scriptVarUseFollowsDeclaration(
  node: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.BindingElement,
): boolean {
  if (node === declaration.name) return true;
  const statement = ts.findAncestor(declaration, ts.isVariableStatement);
  if (statement === undefined || node.pos < statement.end) return false;
  const parent = outermostParenthesized(node).parent;
  if (ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent)) return false;
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return false;
  }
  return true;
}
