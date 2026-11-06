// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7121) Is an `instanceof` RHS identifier a function-local binding that
 * SHADOWS a module-level or builtin constructor name?
 *
 * The legacy `instanceof` dispatch keys the RHS by its NAME (`classTagMap`,
 * `topLevelFunctionNames`, `__fnctor_<F>`, the builtin registry). That is only
 * sound when the identifier binds the declaration those tables were built
 * from. In
 *
 *     function F() {}
 *     function probe(v, F) { return v instanceof F; }
 *
 * the occurrence binds the PARAMETER, yet the fnctor arm answered for the
 * top-level `F`: `probe([], Array)` was `false`, and with the IR path on, the
 * arm minted `F`'s function-value trampoline after `F`'s prepared scope was
 * sealed — a compile error ("would mutate sealed prepared scope").
 *
 * A shadowed name must reach the generic runtime operator, which reads the
 * binding's VALUE. The check is deliberately narrow: a parameter, catch
 * variable or function-local `var`/`let`/`const` whose name ALSO names a
 * module-level declaration or a builtin global. Function-local class and
 * function declarations are left alone — the name-keyed tables register those
 * by their own name, and rerouting them is separate work.
 */
import { isBuiltinTypeName } from "../builtin-tags.js";
import type { CodegenContext } from "../context/types.js";
import { ts } from "../../ts-api.js";

/** Builtin globals the name-keyed paths answer that are not in the tag registry. */
const EXTRA_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Reflect",
  "Atomics",
]);

export function instanceofRhsShadowsModuleName(ctx: CodegenContext, rhs: ts.Expression): boolean {
  if (!ts.isIdentifier(rhs)) return false;
  const decl = ctx.oracle.valueDeclarationOf(rhs);
  if (!decl || decl.getSourceFile().isDeclarationFile || !isFunctionLocalBinding(decl)) return false;
  const name = rhs.text;
  return isBuiltinTypeName(name) || EXTRA_GLOBAL_NAMES.has(name) || declaresTopLevelName(rhs.getSourceFile(), name);
}

function isFunctionLocalBinding(decl: ts.Declaration): boolean {
  if (ts.isParameter(decl)) return true;
  let node: ts.Node = decl;
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node = node.parent;
  }
  if (ts.isParameter(node)) return true;
  if (!ts.isVariableDeclaration(node)) return false;
  const list = node.parent;
  if (ts.isCatchClause(list)) return true;
  if (!ts.isVariableDeclarationList(list)) return false;
  const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0;
  if (blockScoped) {
    // A `let`/`const` is module-level only as a direct top-level statement.
    return !(ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent));
  }
  // A `var` is module-level unless a function encloses it.
  for (let p: ts.Node | undefined = list.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}

function declaresTopLevelName(sourceFile: ts.SourceFile, name: string): boolean {
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
      return true;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindsName(declaration.name, name)) return true;
      }
    }
  }
  return false;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, name));
}
