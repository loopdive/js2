// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";
import { collectPatternBindingNames, isFunctionScopeBoundary } from "./analysis/ast-scope.js";
import {
  irPreparedNestedOrdinaryClass,
  irPreparedNestedOrdinaryClassBindingName,
  type IrClassId,
  type IrSourceId,
  type IrNestedClassFieldCallAdmission,
} from "./identity.js";
import type { IrClassShape } from "./nodes.js";
import {
  requireIrPlanningSourceId,
  requireIrPlanningClassRecord,
  throwIrPlanningIdentityInvariant as planningInvariant,
  rethrowIrPlanningIdentityInvariant as rethrowPlanningInvariant,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import { unwrapParenthesizedExpression as unwrapParens } from "./select-expression-structure.js";

/** One source binding, not one runtime class evaluation or a carrier proof. */
export interface IrClassValueBinding {
  readonly classId: IrClassId;
  readonly sourceId: IrSourceId;
  readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
  readonly kind: "declaration" | "class-name";
  readonly mutable: boolean;
}

export type IrClassValueBindingResolver = (identifier: ts.Identifier) => IrClassValueBinding | undefined;

function classForSymbol(
  symbol: ts.Symbol | undefined,
  context: IrPlanningIdentityContext,
): { readonly classId: IrClassId; readonly declaration: ts.ClassDeclaration | ts.ClassExpression } | undefined {
  if (!symbol) return undefined;
  const symbolDeclarations = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  if (
    symbolDeclarations.some(
      (declaration) =>
        declaration !== undefined &&
        !ts.isClassDeclaration(declaration) &&
        !ts.isClassExpression(declaration) &&
        !ts.isInterfaceDeclaration(declaration) &&
        !ts.isTypeAliasDeclaration(declaration) &&
        !ts.isModuleDeclaration(declaration),
    )
  )
    return undefined;
  const declarations = symbolDeclarations.filter(
    (declaration, index, all): declaration is ts.ClassDeclaration | ts.ClassExpression =>
      declaration !== undefined &&
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
      all.indexOf(declaration) === index,
  );
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  const classId = context.classIdByDeclaration.get(declaration);
  return classId !== undefined && context.declarationByClassId.get(classId) === declaration
    ? { classId, declaration }
    : undefined;
}

function requireClassResolutionSource(context: IrPlanningIdentityContext, sourceFile: ts.SourceFile): IrSourceId {
  const sourceId = requireIrPlanningSourceId(context, sourceFile);
  if (context.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return planningInvariant(
      "source-record-mismatch",
      `local-class source ${sourceFile.fileName} does not resolve back to the exact planning SourceFile`,
    );
  }
  return sourceId;
}

function assertLocalClassExpressionSource(
  context: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): void {
  const actual = expression.getSourceFile();
  requireClassResolutionSource(context, actual);
  if (actual !== sourceFile) {
    planningInvariant(
      "source-record-mismatch",
      `local-class expression source ${actual.fileName} is outside ${sourceFile.fileName}`,
    );
  }
}

/** Diagnostics-off symbols can hide collisions in one lexical statement list. */
function hasCompetingClassBinding(declaration: ts.ClassDeclaration): boolean {
  if (!declaration.name) return false;
  const name = declaration.name.text;
  const parent = declaration.parent;
  const scope = ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.parent : parent;
  if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isModuleBlock(scope) && !ts.isCaseBlock(scope)) return true;
  const bindsName = (binding: ts.BindingName): boolean => {
    for (const candidate of collectPatternBindingNames(binding)) if (candidate === name) return true;
    return false;
  };
  if (ts.isBlock(scope)) {
    const owner = scope.parent;
    if (isFunctionScopeBoundary(owner) && (owner as ts.SignatureDeclaration).parameters.some((p) => bindsName(p.name)))
      return true;
    if (ts.isCatchClause(owner) && owner.variableDeclaration && bindsName(owner.variableDeclaration.name)) return true;
  }
  const statements = ts.isCaseBlock(scope)
    ? scope.clauses.flatMap((clause) => [...clause.statements])
    : scope.statements;
  let conflict = false;
  const visit = (node: ts.Node, direct: boolean): void => {
    if (conflict || node === declaration) return;
    if (isFunctionScopeBoundary(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (direct && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
        conflict = true;
      return;
    }
    // A namespace may augment this class; its body has independent bindings.
    if (ts.isModuleDeclaration(node)) return;
    if (ts.isVariableDeclarationList(node)) {
      if (direct || (node.flags & ts.NodeFlags.BlockScoped) === 0)
        conflict = node.declarations.some((candidate) => bindsName(candidate.name));
      return;
    }
    if (direct && ts.isVariableStatement(node)) {
      visit(node.declarationList, true);
      return;
    }
    if (direct && ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const bindings = clause.namedBindings;
      conflict =
        clause.name?.text === name ||
        (bindings !== undefined &&
          (ts.isNamespaceImport(bindings)
            ? bindings.name.text === name
            : bindings.elements.some((e) => e.name.text === name)));
      return;
    }
    if (direct && (ts.isImportEqualsDeclaration(node) || ts.isEnumDeclaration(node))) {
      conflict = node.name.text === name;
      return;
    }
    forEachChild(node, (child) => visit(child, false));
  };
  for (const statement of statements) visit(statement, true);
  return conflict;
}

/** Resolve lexical class bindings without confusing them with instance types. */
export function makeIrClassValueBindingResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  context: IrPlanningIdentityContext,
): IrClassValueBindingResolver {
  const sourceId = requireClassResolutionSource(context, sourceFile);
  return (identifier) => {
    assertLocalClassExpressionSource(context, sourceFile, identifier);
    try {
      const identity = classForSymbol(checker.getSymbolAtLocation(identifier), context);
      if (!identity || identity.declaration.getSourceFile() !== sourceFile) return undefined;
      const { classId, declaration } = identity;
      if (ts.isClassDeclaration(declaration) && hasCompetingClassBinding(declaration)) return undefined;
      requireIrPlanningClassRecord(context, declaration);
      let inner = ts.isClassExpression(declaration);
      // The declaration name initializes the outer binding. Uses in the
      // definition (including nested closures) capture the inner class name.
      if (identifier !== declaration.name) {
        for (let parent: ts.Node | undefined = identifier.parent; parent; parent = parent.parent) {
          if (parent === declaration) {
            inner = true;
            break;
          }
        }
      }
      return Object.freeze({
        classId,
        sourceId,
        declaration,
        kind: inner ? "class-name" : "declaration",
        mutable: !inner,
      });
    } catch (error) {
      rethrowPlanningInvariant(error);
      return undefined;
    }
  };
}

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
  const sourceId = requireClassResolutionSource(identityContext, sourceFile);

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

  const projectedClassForSymbol = (symbol: ts.Symbol | undefined): ProjectedClass | undefined => {
    const identity = classForSymbol(symbol, identityContext);
    if (!identity) return undefined;
    const projected = projectedByClassId.get(identity.classId);
    return projected?.declaration === identity.declaration ? projected : undefined;
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
    assertLocalClassExpressionSource(identityContext, sourceFile, expression);
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
