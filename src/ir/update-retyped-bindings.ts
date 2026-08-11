// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binding-identity analysis for `++` / `--` targets whose initializer-shaped
 * storage cannot hold the numeric value written by the update.
 *
 * The analysis lives in IR because both selection and AST-to-IR lowering must
 * agree that the binding is dynamic before `dyn.to_number` can own the update.
 * Direct codegen consumes the same verdict when allocating the compatibility
 * module global, so an IR demotion cannot reintroduce the narrow-slot bug.
 */
import { TsCheckerOracle, type TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";

type UpdateRetypeOracle = Pick<TypeOracle, "declarationsOf" | "typeFactOf">;
type UpdateRetypeQuerySource = ts.TypeChecker | UpdateRetypeOracle;

const checkerOracles = new WeakMap<ts.TypeChecker, UpdateRetypeOracle>();
const cache = new WeakMap<object, WeakMap<ts.SourceFile, ReadonlySet<ts.VariableDeclaration>>>();

function queryOracle(source: UpdateRetypeQuerySource): UpdateRetypeOracle {
  if ("declarationsOf" in source && "typeFactOf" in source) return source;
  let oracle = checkerOracles.get(source);
  if (!oracle) {
    oracle = new TsCheckerOracle(source);
    checkerOracles.set(source, oracle);
  }
  return oracle;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function exactTopLevelDeclarations(
  oracle: UpdateRetypeOracle,
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
): readonly ts.VariableDeclaration[] {
  const declarations = new Set(
    oracle
      .declarationsOf(identifier)
      .filter(
        (candidate): candidate is ts.VariableDeclaration =>
          ts.isVariableDeclaration(candidate) &&
          candidate.getSourceFile() === sourceFile &&
          ts.isIdentifier(candidate.name) &&
          ts.isVariableDeclarationList(candidate.parent) &&
          ts.isVariableStatement(candidate.parent.parent) &&
          candidate.parent.parent.parent === sourceFile,
      ),
  );
  return [...declarations];
}

function updateReplacesInitializerRepresentation(
  oracle: UpdateRetypeOracle,
  declaration: ts.VariableDeclaration,
): boolean {
  if (!declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)) return false;
  if ((declaration.parent.flags & ts.NodeFlags.Const) !== 0) return false;
  try {
    const initializerType = oracle.typeFactOf(unwrap(declaration.initializer));
    // Number already has the update result's representation. BigInt updates
    // also remain BigInt under ToNumeric and therefore must not be widened to
    // the Number-oriented dynamic path.
    return initializerType.kind !== "number" && initializerType.kind !== "bigint";
  } catch {
    return false;
  }
}

/**
 * Exact top-level declarations that need a dynamic module slot because some
 * source update writes a Number over a non-Number initializer.
 *
 * The walk intentionally crosses nested function boundaries: a function may
 * update a module binding. Checker identity prevents a same-named local from
 * widening the global.
 */
export function collectUpdateRetypedModuleBindings(
  source: UpdateRetypeQuerySource,
  sourceFile: ts.SourceFile,
): ReadonlySet<ts.VariableDeclaration> {
  const oracle = queryOracle(source);
  let bySource = cache.get(oracle);
  if (!bySource) {
    bySource = new WeakMap();
    cache.set(oracle, bySource);
  }
  const cached = bySource.get(sourceFile);
  if (cached) return cached;

  const declarations = new Set<ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      const bindingDeclarations = exactTopLevelDeclarations(oracle, node.operand, sourceFile);
      // Sloppy-script `var` redeclarations are one binding. Test262 commonly
      // reuses `var x` for several checks in the same file, so a uniqueness
      // requirement would miss the exact conformance shape. If any declaration
      // establishes a non-numeric representation, every declaration of the
      // shared binding must request the same dynamic slot.
      if (bindingDeclarations.some((declaration) => updateReplacesInitializerRepresentation(oracle, declaration))) {
        for (const declaration of bindingDeclarations) declarations.add(declaration);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  bySource.set(sourceFile, declarations);
  return declarations;
}

export function updateRetypesModuleBinding(
  source: UpdateRetypeQuerySource,
  declaration: ts.VariableDeclaration,
): boolean {
  return collectUpdateRetypedModuleBindings(source, declaration.getSourceFile()).has(declaration);
}

/** Whether this exact identifier resolves to an update-retyped module binding. */
export function updateRetypesModuleIdentifier(source: UpdateRetypeQuerySource, identifier: ts.Identifier): boolean {
  const sourceFile = identifier.getSourceFile();
  const oracle = queryOracle(source);
  const retyped = collectUpdateRetypedModuleBindings(oracle, sourceFile);
  return exactTopLevelDeclarations(oracle, identifier, sourceFile).some((declaration) => retyped.has(declaration));
}

/** Name fallback for a caller that has already proved the use is module-scoped. */
export function updateRetypesModuleBindingName(
  source: UpdateRetypeQuerySource,
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  for (const declaration of collectUpdateRetypedModuleBindings(source, sourceFile)) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return true;
  }
  return false;
}
