// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import {
  irPreparedNestedOrdinaryClass,
  irPreparedNestedOrdinaryClassBindingName,
  type IrClassId,
  type IrNestedClassFieldCallAdmission,
} from "./identity.js";
import type { IrClassShape } from "./nodes.js";
import {
  requireIrPlanningSourceId,
  throwIrPlanningIdentityInvariant as planningInvariant,
  rethrowIrPlanningIdentityInvariant as rethrowPlanningInvariant,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import { unwrapParenthesizedExpression as unwrapParens } from "./select-expression-structure.js";

export type IrLegacyLocalClassExpressionResolver = (expression: ts.Expression) => string | undefined;

/** Exact local-class evidence retained across the legacy class-name seam. */
export interface IrLocalClassExpressionIdentity {
  readonly classId: IrClassId;
  readonly legacyName: string;
}

export type IrLocalClassExpressionResolver = (expression: ts.Expression) => IrLocalClassExpressionIdentity | undefined;

/**
 * Build a checker-backed resolver from an expression's exact instance type to
 * one projected top-level source class. Textual names are deliberately not a
 * fallback: aliases, duplicate declarations, constructor objects, and
 * unprojected classes must not acquire class-instance evidence by spelling.
 */
export function makeIrLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
): IrLegacyLocalClassExpressionResolver;
export function makeIrLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
  identityContext: IrPlanningIdentityContext,
  fieldCallAdmission?: IrNestedClassFieldCallAdmission,
): IrLocalClassExpressionResolver;
export function makeIrLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
  identityContext?: IrPlanningIdentityContext,
  fieldCallAdmission?: IrNestedClassFieldCallAdmission,
): IrLegacyLocalClassExpressionResolver | IrLocalClassExpressionResolver {
  if (identityContext) {
    return makeIrIdentityLocalClassExpressionResolver(
      checker,
      sourceFile,
      projectedShapes,
      identityContext,
      fieldCallAdmission,
    );
  }
  return makeIrLegacyLocalClassExpressionResolver(checker, sourceFile, projectedShapes);
}

/** Existing name-projected resolver retained for the temporary class-shape API. */
export function makeIrLegacyLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
): IrLegacyLocalClassExpressionResolver {
  const declarations: { readonly name: string; readonly symbol: ts.Symbol }[] = [];
  const nameCounts = new Map<string, number>();
  const symbolCounts = new Map<ts.Symbol, number>();
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    const shape = projectedShapes.get(name);
    if (!shape || shape.className !== name) continue;
    const symbol = checker.getSymbolAtLocation(statement.name);
    if (!symbol) continue;
    declarations.push({ name, symbol });
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
  }

  const classNameBySymbol = new Map<ts.Symbol, string>();
  for (const declaration of declarations) {
    if (nameCounts.get(declaration.name) !== 1 || symbolCounts.get(declaration.symbol) !== 1) continue;
    classNameBySymbol.set(declaration.symbol, declaration.name);
  }

  const exactProjectedType = (expression: ts.Expression): string | undefined => {
    try {
      const type = checker.getTypeAtLocation(expression);
      if (
        type.isUnionOrIntersection() ||
        type.aliasSymbol !== undefined ||
        (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)) !==
          0 ||
        type.getCallSignatures().length !== 0 ||
        type.getConstructSignatures().length !== 0
      ) {
        return undefined;
      }
      const symbol = type.getSymbol();
      return symbol ? classNameBySymbol.get(symbol) : undefined;
    } catch {
      return undefined;
    }
  };

  const resolveExpression = (rawExpression: ts.Expression, seen: Set<ts.VariableDeclaration>): string | undefined => {
    let expression = unwrapParens(rawExpression);
    while (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = unwrapParens(expression.expression);
    }

    const projected = exactProjectedType(expression);
    if (!projected) return undefined;
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolveExpression(expression.whenTrue, new Set(seen));
      const whenFalse = resolveExpression(expression.whenFalse, new Set(seen));
      return whenTrue === projected && whenFalse === projected ? projected : undefined;
    }
    if (!ts.isIdentifier(expression)) return projected;

    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)) {
      if (seen.has(declaration) || !declaration.initializer || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
        return undefined;
      }
      seen.add(declaration);
      return resolveExpression(declaration.initializer, seen) === projected ? projected : undefined;
    }
    if (declaration && ts.isParameter(declaration)) {
      const typeNode = declaration.type;
      return typeNode &&
        ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === projected
        ? projected
        : undefined;
    }
    // Binding elements, imports, and other alias-like value declarations need
    // their own producer proof before they can become class-instance evidence.
    if (declaration) return undefined;
    return projected;
  };

  return (expression) => resolveExpression(expression, new Set());
}

/** Explicit structural factory; the four-argument overload above is equivalent. */
export function makeIrIdentityLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
  identityContext: IrPlanningIdentityContext,
  /** (#3522 F4) The one proof-derived admitted-class marker; never recomputed here. */
  fieldCallAdmission?: IrNestedClassFieldCallAdmission,
): IrLocalClassExpressionResolver {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return planningInvariant(
      "source-record-mismatch",
      `local-class source ${sourceFile.fileName} does not resolve back to the exact planning SourceFile`,
    );
  }

  interface ProjectedClass extends IrLocalClassExpressionIdentity {
    readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
    readonly symbol: ts.Symbol;
  }

  const projectedByClassId = new Map<IrClassId, ProjectedClass>();
  const declarationCounts = new Map<ts.ClassDeclaration | ts.ClassExpression, number>();
  const symbolCounts = new Map<ts.Symbol, number>();
  const candidates: ProjectedClass[] = [];
  for (const record of identityContext.inventory.classes) {
    if (record.sourceId !== sourceId) continue;
    const statement = identityContext.declarationByClassId.get(record.id);
    if (!statement || (!ts.isClassDeclaration(statement) && !ts.isClassExpression(statement))) continue;
    // Existing nested accessor preparation intentionally leaves its containing
    // function on the direct path. Only the bounded ordinary-class family owns
    // the constructor/method/caller graph atomically, so only that family may
    // widen local-class expression resolution beyond source-file declarations.
    if (statement.parent !== sourceFile && !irPreparedNestedOrdinaryClass(statement, fieldCallAdmission)) continue;
    const legacyName =
      statement.parent === sourceFile && ts.isClassDeclaration(statement)
        ? statement.name?.text
        : irPreparedNestedOrdinaryClassBindingName(statement, fieldCallAdmission);
    if (legacyName === undefined) continue;
    const shape = projectedShapes.get(legacyName);
    if (!shape) continue;
    const classId = record.id;
    if (classId === undefined || identityContext.declarationByClassId.get(classId) !== statement) {
      return planningInvariant(
        "missing-class-declaration",
        `projected local class ${legacyName} has no exact structural class identity`,
      );
    }
    if (shape.classId !== classId) {
      return planningInvariant(
        "class-record-mismatch",
        `projected local class ${legacyName} carries ${shape.classId} instead of ${classId}`,
      );
    }
    const symbol = statement.name
      ? checker.getSymbolAtLocation(statement.name)
      : checker.getTypeAtLocation(statement).getSymbol();
    if (!symbol) continue;
    const candidate = { classId, legacyName, declaration: statement, symbol };
    candidates.push(candidate);
    declarationCounts.set(statement, (declarationCounts.get(statement) ?? 0) + 1);
    symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if (declarationCounts.get(candidate.declaration) !== 1 || symbolCounts.get(candidate.symbol) !== 1) continue;
    if (projectedByClassId.has(candidate.classId)) {
      return planningInvariant(
        "duplicate-class-declaration",
        `class identity ${candidate.classId} occurs more than once in the local-class projection`,
      );
    }
    projectedByClassId.set(candidate.classId, candidate);
  }

  const assertExpressionSource = (expression: ts.Expression): void => {
    const expressionSource = expression.getSourceFile();
    const expressionSourceId = requireIrPlanningSourceId(identityContext, expressionSource);
    if (expressionSource !== sourceFile || expressionSourceId !== sourceId) {
      planningInvariant(
        "source-record-mismatch",
        `local-class expression source ${expressionSource.fileName} is outside ${sourceFile.fileName}`,
      );
    }
  };

  const projectedClassForSymbol = (symbol: ts.Symbol | undefined): ProjectedClass | undefined => {
    if (!symbol) return undefined;
    const declarations = [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
      (declaration, index, all): declaration is ts.ClassDeclaration | ts.ClassExpression =>
        declaration !== undefined &&
        (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
        all.indexOf(declaration) === index,
    );
    if (declarations.length !== 1) return undefined;
    const declaration = declarations[0]!;
    const classId = identityContext.classIdByDeclaration.get(declaration);
    if (classId === undefined || identityContext.declarationByClassId.get(classId) !== declaration) return undefined;
    const projected = projectedByClassId.get(classId);
    return projected?.declaration === declaration ? projected : undefined;
  };

  const exactProjectedType = (expression: ts.Expression): ProjectedClass | undefined => {
    try {
      const type = checker.getTypeAtLocation(expression);
      if (
        type.isUnionOrIntersection() ||
        type.aliasSymbol !== undefined ||
        (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)) !==
          0 ||
        type.getCallSignatures().length !== 0 ||
        type.getConstructSignatures().length !== 0
      ) {
        return undefined;
      }
      return projectedClassForSymbol(type.getSymbol());
    } catch (error) {
      rethrowPlanningInvariant(error);
      return undefined;
    }
  };

  const parameterProjectedType = (parameter: ts.ParameterDeclaration): ProjectedClass | undefined => {
    const typeNode = parameter.type;
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
    try {
      // Resolve the annotation's symbol itself. De-aliasing or comparing its
      // text would let a same-spelled alias/shadow stand in for another class.
      return projectedClassForSymbol(checker.getSymbolAtLocation(typeNode.typeName));
    } catch (error) {
      rethrowPlanningInvariant(error);
      return undefined;
    }
  };

  const resolveExpression = (
    rawExpression: ts.Expression,
    seen: Set<ts.VariableDeclaration>,
  ): ProjectedClass | undefined => {
    let expression = unwrapParens(rawExpression);
    while (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = unwrapParens(expression.expression);
    }

    const projected = exactProjectedType(expression);
    if (!projected) return undefined;
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolveExpression(expression.whenTrue, new Set(seen));
      const whenFalse = resolveExpression(expression.whenFalse, new Set(seen));
      return whenTrue?.classId === projected.classId && whenFalse?.classId === projected.classId
        ? projected
        : undefined;
    }
    if (!ts.isIdentifier(expression)) return projected;

    try {
      const symbol = checker.getSymbolAtLocation(expression);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (
          seen.has(declaration) ||
          !declaration.initializer ||
          (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
          return undefined;
        }
        const nextSeen = new Set(seen);
        nextSeen.add(declaration);
        return resolveExpression(declaration.initializer, nextSeen)?.classId === projected.classId
          ? projected
          : undefined;
      }
      if (declaration && ts.isParameter(declaration)) {
        return parameterProjectedType(declaration)?.classId === projected.classId ? projected : undefined;
      }
      // Binding elements, imports, and other alias-like value declarations
      // require their own producer proof before they become class evidence.
      if (declaration) return undefined;
      return projected;
    } catch (error) {
      rethrowPlanningInvariant(error);
      return undefined;
    }
  };

  return (expression) => {
    assertExpressionSource(expression);
    const projected = resolveExpression(expression, new Set());
    return projected ? { classId: projected.classId, legacyName: projected.legacyName } : undefined;
  };
}

/** Explicit compatibility boundary for consumers that still require a class name. */
export function projectIrLocalClassExpressionResolverToLegacy(
  resolver: IrLocalClassExpressionResolver,
): IrLegacyLocalClassExpressionResolver {
  return (expression) => resolver(expression)?.legacyName;
}
