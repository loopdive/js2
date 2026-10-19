// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

export interface IrQualifiedExternConstructor {
  readonly className: string;
  readonly registryKey: string;
  readonly namespacePath: readonly string[];
}

export type IrQualifiedExternConstructorResolver = (
  expression: ts.NewExpression,
) => IrQualifiedExternConstructor | undefined;

function declarationIdentity(
  declaration: ts.Declaration,
  source: ts.SourceFile,
): (IrQualifiedExternConstructor & { root: ts.ModuleDeclaration }) | undefined {
  if (!ts.isClassDeclaration(declaration) || !declaration.name || declaration.getSourceFile() !== source)
    return undefined;
  const modules: ts.ModuleDeclaration[] = [];
  let owner: ts.Node = declaration.parent;
  while (ts.isModuleBlock(owner) || ts.isModuleDeclaration(owner)) {
    if (ts.isModuleDeclaration(owner)) {
      if (!ts.isIdentifier(owner.name)) return undefined;
      modules.unshift(owner);
    }
    owner = owner.parent;
  }
  if (!ts.isSourceFile(owner) || modules.length === 0) return undefined;
  if (
    !modules.some((module) =>
      ts.getModifiers(module)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword),
    )
  )
    return undefined;
  const namespacePath = modules.map((module) => module.name.text);
  return {
    className: declaration.name.text,
    registryKey: [...namespacePath, declaration.name.text].join("."),
    namespacePath,
    root: modules[0]!,
  };
}

/** Recover the exact declared namespace for a typed capability receiver. */
export function qualifiedExternClassKey(type: ts.Type, source: ts.SourceFile): string | undefined {
  const declarations = type.getSymbol()?.declarations;
  return declarations?.length === 1 ? declarationIdentity(declarations[0]!, source)?.registryKey : undefined;
}

/** Certify a static, same-file ambient API path, never a same-spelled local. */
export function makeIrQualifiedExternConstructorResolver(
  checker: ts.TypeChecker,
): IrQualifiedExternConstructorResolver {
  return (expression) => {
    if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.questionDotToken)
      return undefined;
    const callee = expression.expression;
    const symbol = checker.getSymbolAtLocation(callee.name);
    const declarations = symbol?.declarations;
    if (!declarations || declarations.length !== 1) return undefined;
    const identity = declarationIdentity(declarations[0]!, expression.getSourceFile());
    if (!identity || identity.className !== callee.name.text) return undefined;
    const names: string[] = [];
    let root: ts.Expression = callee.expression;
    while (ts.isPropertyAccessExpression(root) && !root.questionDotToken) {
      names.unshift(root.name.text);
      root = root.expression;
    }
    if (!ts.isIdentifier(root)) return undefined;
    names.unshift(root.text);
    if (
      names.length !== identity.namespacePath.length ||
      names.some((name, index) => name !== identity.namespacePath[index])
    )
      return undefined;
    const rootDeclarations = checker.getSymbolAtLocation(root)?.declarations;
    if (!rootDeclarations?.includes(identity.root)) return undefined;
    if (
      !rootDeclarations.every(
        (item) =>
          ts.isModuleDeclaration(item) &&
          ts.getModifiers(item)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword),
      )
    )
      return undefined;
    return {
      className: identity.className,
      registryKey: identity.registryKey,
      namespacePath: names,
    };
  };
}
