// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 Capability C — checker-backed module-binding identity shared by the
// selector and AST→IR builder. This module is deliberately leaf-shaped so the
// fallback gate can import it without pulling in codegen/index.ts.

import { isExternalDeclaredClass } from "../checker/type-mapper.js";
import { TsCheckerOracle, type TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";
import * as bindingValue from "./module-binding-value-kinds.js";
import { updateRetypesModuleBinding } from "./update-retyped-bindings.js";
import {
  boundedPreparedNestedOrdinaryClassBindingName,
  isBoundedPreparedAccessorClass,
  isBoundedPreparedNestedOrdinaryClass,
} from "./class-accessor-safety.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "./abi-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId } from "./identity.js";
import type { IrClassShape } from "./nodes.js";
import { makeFnctorArrayMethodPlan, type IrFnctorArrayMethodPlan } from "./fnctor-array-method.js";
export type { IrFnctorArrayMethodPlan } from "./fnctor-array-method.js";
import { heterogeneousAssignmentRetypesModuleBinding } from "./heterogeneous-module-bindings.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";

export type IrPrimitiveExpressionFamily = "number" | "boolean" | "string";
export type IrDeclaredPrimitiveExpressionFamily = IrPrimitiveExpressionFamily | "primitive-union";

export type IrLegacyLocalClassExpressionResolver = (expression: ts.Expression) => string | undefined;

/** Exact local-class evidence retained across the legacy class-name seam. */
export interface IrLocalClassExpressionIdentity {
  readonly classId: IrClassId;
  readonly legacyName: string;
}

export type IrLocalClassExpressionResolver = (expression: ts.Expression) => IrLocalClassExpressionIdentity | undefined;

function planningInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

function rethrowPlanningInvariant(error: unknown): void {
  if (error instanceof IrPlanningIdentityInvariantError) throw error;
}

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
): IrLocalClassExpressionResolver;
export function makeIrLocalClassExpressionResolver(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  projectedShapes: ReadonlyMap<string, IrClassShape>,
  identityContext?: IrPlanningIdentityContext,
): IrLegacyLocalClassExpressionResolver | IrLocalClassExpressionResolver {
  if (identityContext) {
    return makeIrIdentityLocalClassExpressionResolver(checker, sourceFile, projectedShapes, identityContext);
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
    if (statement.parent !== sourceFile && !isBoundedPreparedNestedOrdinaryClass(statement)) continue;
    const legacyName =
      statement.parent === sourceFile && ts.isClassDeclaration(statement)
        ? statement.name?.text
        : boundedPreparedNestedOrdinaryClassBindingName(statement);
    if (legacyName === undefined) continue;
    const shape = projectedShapes.get(legacyName);
    if (!shape || shape.classId !== record.id) continue;
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

/**
 * Build a checker-backed Array/tuple predicate for selector-only method
 * routing. The IR front-end currently lowers vec `.push(...)`, but not the
 * wider Array prototype surface. Keeping this proof separate from primitive
 * classification lets local classes with methods such as `indexOf` retain
 * ordinary class dispatch while real arrays reject before claim.
 */
export function makeIrArrayExpressionPredicate(checker: ts.TypeChecker): (expr: ts.Expression) => boolean {
  return (expr) => {
    try {
      const type = checker.getTypeAtLocation(unwrapParens(expr));
      if (type.isUnion()) {
        const members = type.types.filter(
          (member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) === 0,
        );
        return (
          members.length > 0 && members.every((member) => checker.isArrayType(member) || checker.isTupleType(member))
        );
      }
      return checker.isArrayType(type) || checker.isTupleType(type);
    } catch {
      return false;
    }
  };
}

/**
 * Build a checker-backed proof that an expression has the ambient lib
 * `RegExp` type. Host-free backends use this only to keep RegExp prototype
 * calls on the native legacy path; user classes that happen to be named
 * `RegExp` must retain normal IR class dispatch.
 */
export function makeIrRegExpExpressionPredicate(checker: ts.TypeChecker): (expr: ts.Expression) => boolean {
  const isAmbientRegExp = (type: ts.Type): boolean => {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol?.getName() !== "RegExp") return false;
    const declarations = symbol.getDeclarations() ?? [];
    return (
      declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
    );
  };

  return (expr) => {
    try {
      const type = checker.getTypeAtLocation(unwrapParens(expr));
      if (type.isUnion()) {
        const members = type.types.filter(
          (member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) === 0,
        );
        return members.length > 0 && members.every(isAmbientRegExp);
      }
      return isAmbientRegExp(type);
    } catch {
      return false;
    }
  };
}

/**
 * Build a checker-only ambient-binding predicate. Unlike the full module
 * binding resolver, this exposes no source storage capability, so backends
 * without module-global lowering can still distinguish the real lib `Math`
 * object from a source declaration or parameter with the same name.
 */
export function makeIrAmbientBindingPredicate(checker: ts.TypeChecker): (node: ts.Identifier) => boolean {
  return (node) => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      return (
        symbol !== undefined &&
        [symbol.valueDeclaration, ...(symbol.declarations ?? [])].some(
          (declaration) => declaration?.getSourceFile().isDeclarationFile === true,
        )
      );
    } catch {
      return false;
    }
  };
}

/**
 * Classify the receiver's declared checker surface for builtin-name routing.
 * This is intentionally distinct from the provenance-safe classifier below:
 * an invalid `const x: string = 1` must still be recognised as a primitive
 * builtin receiver and rejected before claim, while class/extern receivers
 * with the same method name keep ordinary dispatch. Mixed or nullable unions
 * containing a primitive get a sentinel family so they reject conservatively;
 * `any` and `unknown` remain unproven.
 */
export function makeIrDeclaredPrimitiveExpressionClassifier(
  checker: ts.TypeChecker,
): (expr: ts.Expression) => IrDeclaredPrimitiveExpressionFamily | undefined {
  const classifyType = (type: ts.Type): IrDeclaredPrimitiveExpressionFamily | undefined => {
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return undefined;
    if (type.isUnion()) {
      const families = new Set<IrPrimitiveExpressionFamily>();
      let sawNonPrimitive = false;
      let sawNullish = false;
      for (const member of type.types) {
        if ((member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0) {
          sawNullish = true;
          continue;
        }
        const family = classifyType(member);
        if (family === "primitive-union") {
          sawNonPrimitive = true;
        } else if (family !== undefined) {
          families.add(family);
        } else {
          sawNonPrimitive = true;
        }
      }
      if (families.size === 0) return undefined;
      if (families.size !== 1 || sawNonPrimitive || sawNullish) return "primitive-union";
      return families.values().next().value;
    }
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    return undefined;
  };

  return (expr) => {
    try {
      return classifyType(checker.getTypeAtLocation(unwrapParens(expr)));
    } catch {
      return undefined;
    }
  };
}

/**
 * Build a provenance-safe primitive classifier for coercion-sensitive
 * builtin acceptance. This follows local initializers and ignores type
 * assertions, so diagnostics-off annotations cannot masquerade as runtime
 * evidence. Use makeIrDeclaredPrimitiveExpressionClassifier for routing.
 */
export function makeIrPrimitiveExpressionClassifier(
  checker: ts.TypeChecker,
): (expr: ts.Expression) => IrPrimitiveExpressionFamily | undefined {
  const classifyType = (type: ts.Type): IrPrimitiveExpressionFamily | undefined => {
    if (type.isUnion()) {
      const families = type.types.map(classifyType);
      const first = families[0];
      return first !== undefined && families.every((family) => family === first) ? first : undefined;
    }
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    return undefined;
  };

  const classifyExpression = (
    expr: ts.Expression,
    seen: Set<ts.VariableDeclaration>,
  ): IrPrimitiveExpressionFamily | undefined => {
    try {
      const candidate = unwrapParens(expr);
      // A type assertion is not runtime evidence. Follow the represented
      // value so diagnostics-off inputs such as `"x" as number` cannot make
      // a coercion-sensitive builtin claim the function.
      if (
        ts.isAsExpression(candidate) ||
        ts.isTypeAssertionExpression(candidate) ||
        ts.isSatisfiesExpression(candidate) ||
        ts.isNonNullExpression(candidate)
      ) {
        return classifyExpression(candidate.expression, seen);
      }
      const family = classifyType(checker.getTypeAtLocation(candidate));
      if (family === undefined || !ts.isIdentifier(candidate)) return family;

      const symbol = checker.getSymbolAtLocation(candidate);
      const declaration = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].find(
        (node): node is ts.VariableDeclaration =>
          node !== undefined && ts.isVariableDeclaration(node) && node.getSourceFile() === candidate.getSourceFile(),
      );
      if (!declaration) return family; // parameters and checker-owned nonlocals
      if (!declaration.initializer || seen.has(declaration)) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(declaration);
      return classifyExpression(declaration.initializer, nextSeen) === family ? family : undefined;
    } catch {
      return undefined;
    }
  };

  return (expr) => classifyExpression(expr, new Set());
}

export type IrModuleBindingValueKind = bindingValue.IrModuleBindingValueKind;
export { isIrModuleMapValueKind, isIrModuleReferenceValueKind } from "./module-binding-value-kinds.js";

/** Name-compatible binding evidence used only by the pre-R1 planning seam. */
export interface IrLegacyModuleBindingIdentity {
  /** The checker-resolved top-level declaration. Node identity is the key. */
  readonly declaration: ts.VariableDeclaration;
  readonly mutable: boolean;
  readonly valueKind: IrModuleBindingValueKind;
}

/** Exact binding evidence for one AST use site and its terminal owner. */
export interface IrModuleBindingIdentity extends IrLegacyModuleBindingIdentity {
  readonly ownerUnitId: IrUnitId;
  /** Module-init terminal that owns the declaration's persistent storage. */
  readonly storageOwnerUnitId: IrUnitId;
  /** Stable across every use site of the exact source declaration. */
  readonly globalBindingId: IrBindingId;
  /** Separate storage identity for the declaration's TDZ state. */
  readonly tdzBindingId: IrBindingId;
  readonly sourceId: IrSourceId;
  /** Top-level declaration order within the exact source. */
  readonly declarationOrdinal: number;
}

/**
 * Structural module-binding result used at the integration boundary.
 *
 * The selector-facing resolver remains conservative (`undefined` means do
 * not claim), but module-init integration must distinguish an ordinary source
 * capability gap from a broken checker/selection promise. In particular, a
 * real top-level lexical with an unsupported representation is expected; a
 * node that is no longer the direct declaration the selector assessed is an
 * invariant.
 */
export type IrLegacyModuleBindingInspection =
  | { readonly kind: "supported"; readonly identity: IrLegacyModuleBindingIdentity }
  | { readonly kind: "unsupported"; readonly declaration: ts.VariableDeclaration }
  | { readonly kind: "not-direct" };

export type IrModuleBindingInspection =
  | { readonly kind: "supported"; readonly identity: IrModuleBindingIdentity }
  | { readonly kind: "unsupported"; readonly declaration: ts.VariableDeclaration }
  | { readonly kind: "not-direct" };

/**
 * Exact top-level native RegExp carrier that can be consumed by the standalone
 * IR bridge. The binding stays outside the general module-value projection:
 * only `.test(subject)` receives this proof, and the real legacy-allocated
 * externref global remains the receiver at runtime.
 */
export interface IrStaticRegExpTestPlan {
  readonly declaration: ts.VariableDeclaration;
  readonly pattern: string;
  readonly flags: string;
  /** Structural fields are present on the identity-aware production resolver. */
  readonly globalBindingId?: IrBindingId;
  readonly storageOwnerUnitId?: IrUnitId;
  readonly sourceId?: IrSourceId;
  readonly declarationOrdinal?: number;
}

export interface IrStaticNumericArrayPlan {
  readonly declaration: ts.VariableDeclaration;
  readonly globalBindingId?: IrBindingId;
  readonly storageOwnerUnitId?: IrUnitId;
  readonly sourceId?: IrSourceId;
  readonly declarationOrdinal?: number;
}

/**
 * Exact retained function-object receiver plus one directly assigned method.
 *
 * This is intentionally not a direct-call plan: lowering must still perform a
 * live receiver-preserving method dispatch so `Parser.parse` observes
 * `this === Parser` and later property writes remain visible.
 */
export interface IrRetainedFunctionMethodPlan {
  readonly receiverDeclaration: ts.VariableDeclaration;
  readonly receiverTarget: ts.FunctionExpression;
  readonly methodTarget: ts.FunctionExpression;
  readonly receiverName: string;
  readonly methodName: string;
  readonly arity: number;
  /** Structural fields are present on the identity-aware production resolver. */
  readonly receiverUnitId?: IrUnitId;
  readonly methodUnitId?: IrUnitId;
  readonly receiverGlobalBindingId?: IrBindingId;
  readonly receiverStorageOwnerUnitId?: IrUnitId;
  readonly receiverSourceId?: IrSourceId;
  readonly receiverDeclarationOrdinal?: number;
}

/** One exact `.call(thisArg, ...args)` reference to a stable source function. */
export interface IrStableFunctionCallSite {
  readonly call: ts.CallExpression;
  readonly receiver: ts.Expression;
  readonly arguments: readonly ts.Expression[];
}

/**
 * Checker-backed proof that a top-level FunctionDeclaration is referenced
 * only through fixed-arity `.call(thisArg, ...args)` sites.
 *
 * The selector consumes this proof to expose the declaration's ambient
 * `this` as the non-fast dynamic carrier. Lowering still owns the executable
 * receiver bridge; this record carries only exact source identity and the
 * complete, stable call-site population.
 */
export interface IrStableFunctionCallPlan {
  readonly declaration: ts.FunctionDeclaration;
  readonly signature: ts.Signature;
  readonly targetName: string;
  /** Source parameter count, excluding the leading `.call` receiver. */
  readonly arity: number;
  readonly callSites: readonly IrStableFunctionCallSite[];
  /** Structural fields are present on the identity-aware production resolver. */
  readonly targetUnitId?: IrUnitId;
  readonly sourceId?: IrSourceId;
}

interface IrModuleBindingResolverSurface<TIdentity, TInspection> {
  (node: ts.Identifier, writeValue?: ts.Expression): TIdentity | undefined;
  /**
   * Inspect the exact source declaration without swallowing checker failures.
   * Integration uses this after a module-init claim, where an unexpected
   * checker throw is an Invariant rather than an Unsupported capability.
   */
  readonly inspectDirectBinding: (node: ts.Identifier, writeValue?: ts.Expression) => TInspection;
  /** True for any checker-owned top-level lexical, including unsupported reps. */
  readonly isDirectModuleBinding: (node: ts.Identifier) => boolean;
  /** True when the identifier resolves to an ambient declaration-file symbol. */
  readonly isAmbientBinding: (node: ts.Identifier) => boolean;
  /** Resolve a local variable use to its exact declaration for alias tracking. */
  readonly localVariableDeclaration: (node: ts.Identifier) => ts.VariableDeclaration | undefined;
  /** Resolve any same-source local value use to its exact lexical declaration. */
  readonly localValueDeclaration: (node: ts.Identifier) => ts.Declaration | undefined;
  /** Module extern arguments must keep their exact branded parameter ABI. */
  readonly externCallArgumentsMatch: (call: ts.CallExpression | ts.NewExpression) => boolean;
  /** True when a value can cross an extern member boundary without GC-ref boxing. */
  readonly externValueIsPassable: (value: ts.Expression) => boolean;
  /** Checker-backed scalar result family for provenance-preserving consumers. */
  readonly scalarExpressionFamily: (expr: ts.Expression) => "f64" | "boolean" | undefined;
  /** True when f64 `.toString()` lowers through the host string import. */
  readonly supportsHostNumberToString: boolean;
  /** Prove an initializer/RHS matches the binding's actual IR representation. */
  readonly bindingValueMatches: (node: ts.Identifier, value: ts.Expression) => boolean;
  /**
   * Prove an exact source-owned static RegExp carrier for standalone `.test`.
   * General RegExp values remain unsupported module bindings.
   */
  readonly staticRegExpTestPlan: (node: ts.Expression) => IrStaticRegExpTestPlan | undefined;
  /** Exact stable top-level numeric array used at a direct-call vec boundary. */
  readonly staticNumericArrayPlan: (node: ts.Expression) => IrStaticNumericArrayPlan | undefined;
  /** Exact retained function-object method call whose receiver must stay live. */
  readonly retainedFunctionMethodPlan: (call: ts.CallExpression) => IrRetainedFunctionMethodPlan | undefined;
  /** Exact inherited Array HOF call on a stable user-constructor instance. */
  readonly fnctorArrayMethodPlan: (call: ts.CallExpression) => IrFnctorArrayMethodPlan | undefined;
  /**
   * Exact top-level function whose complete reference population is
   * fixed-arity `.call(thisArg, ...args)`. Accepts either the declaration or
   * one of its certified call expressions.
   */
  readonly stableFunctionCallPlan: (
    node: ts.FunctionDeclaration | ts.CallExpression,
  ) => IrStableFunctionCallPlan | undefined;
}

export interface IrLegacyModuleBindingResolver extends IrModuleBindingResolverSurface<
  IrLegacyModuleBindingIdentity,
  IrLegacyModuleBindingInspection
> {}

export interface IrModuleBindingResolver extends IrModuleBindingResolverSurface<
  IrModuleBindingIdentity,
  IrModuleBindingInspection
> {}

export interface IrModuleBindingResolverOptions {
  /** Actual legacy storage choice for an ordinary TS `number`. */
  readonly numberStorage: "f64" | "i32";
  /** Extern-class globals exist only on the JS-host lane. */
  readonly allowHostExterns: boolean;
  readonly resolveCapabilityExternBinding?: bindingValue.IrModuleCapabilityExternResolver;
  /**
   * Builtin Map uses an externref slot only in host-string mode. Native-string
   * lanes store it as `(ref null $Map)`, outside this capability's surface.
   */
  readonly allowBuiltinMapExtern: boolean;
  /**
   * (#4461) The complementary capability: native-string / standalone lanes
   * store a builtin `Map` in the WasmGC `$Map` struct (#1103a). Exactly one of
   * this and {@link allowBuiltinMapExtern} may be true — they are the two
   * carriers of the same source binding, and admitting both would let the
   * selector claim a representation the active backend cannot lower.
   */
  readonly allowNativeMapStorage?: boolean;
  /** Provisional selector-only access to the bounded top-level accessor family. */
  readonly allowBoundedTopLevelAccessorSelectionCandidates?: boolean;
  /** Whole-program fnctor gate proof for one-write intrinsic Array prototypes. */
  readonly stableFnctorArrayPrototypeNames?: ReadonlySet<string>;
  /** Oracle shared with legacy module-global allocation when one is active. */
  readonly oracle?: TypeOracle;
}

const selectedTopLevelAccessorUnitIdsByContext = new WeakMap<IrPlanningIdentityContext, ReadonlySet<IrUnitId>>();

/** Scope exact selected accessor ownership across one synchronous prepared lowering pass. */
export function withSelectedTopLevelAccessorUnitIds<T>(
  identityContext: IrPlanningIdentityContext,
  unitIds: ReadonlySet<IrUnitId>,
  run: () => T,
): T {
  const previous = selectedTopLevelAccessorUnitIdsByContext.get(identityContext);
  selectedTopLevelAccessorUnitIdsByContext.set(identityContext, new Set(unitIds));
  try {
    return run();
  } finally {
    if (previous) selectedTopLevelAccessorUnitIdsByContext.set(identityContext, previous);
    else selectedTopLevelAccessorUnitIdsByContext.delete(identityContext);
  }
}

// Builtins which are deliberately excluded by isExternalDeclaredClass but are
// registered in the legacy extern-class table on the JS-host lane. This keeps
// the already-landed #2856 C3 const-Map read path intact.
const MODULE_EXTERN_BUILTINS = new Set(["Map"]);
const NON_F64_NATIVE_NUMBER_ALIASES = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "f32"]);

// ── (#4218 Phase 1) Binding queries through the oracle ────────────────
//
// The binding-resolution helpers below used to call
// `checker.getSymbolAtLocation` directly — the single largest remaining
// TS5-checker consumer after the lib-walk removal (~20k calls/corpus run).
// They now go through the `TypeOracle` surface (`valueDeclarationOf` /
// `declarationsOf`, added by #4218 P1): under the `checker` backend the
// memoized `TsCheckerOracle` answers (same checker, per-node cache); under
// the `inhouse` backend the binder answers with no checker at all.
// Mirrors the `UpdateRetypeQuerySource` pattern in update-retyped-bindings.ts.
type BindingQuerySource = ts.TypeChecker | Pick<TypeOracle, "valueDeclarationOf" | "declarationsOf">;

const checkerBindingOracles = new WeakMap<ts.TypeChecker, TsCheckerOracle>();

function bindingOracle(source: BindingQuerySource): Pick<TypeOracle, "valueDeclarationOf" | "declarationsOf"> {
  if ("valueDeclarationOf" in source && "declarationsOf" in source) return source;
  let oracle = checkerBindingOracles.get(source);
  if (!oracle) {
    oracle = new TsCheckerOracle(source);
    checkerBindingOracles.set(source, oracle);
  }
  return oracle;
}

/** Ordered declaration candidates: value declaration first, then the full
 * merged list — the exact priority the raw
 * `[symbol.valueDeclaration, ...symbol.declarations]` idiom encoded. */
function bindingDeclarationCandidates(
  node: ts.Identifier,
  source: BindingQuerySource,
): readonly (ts.Declaration | undefined)[] {
  const oracle = bindingOracle(source);
  return [oracle.valueDeclarationOf(node), ...oracle.declarationsOf(node)];
}

function uniqueTopLevelVariableDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | undefined {
  const sourceFile = node.getSourceFile();
  const candidates = bindingDeclarationCandidates(node, checker);
  if (candidates.length === 0) return undefined;
  const directDeclarations = new Set<ts.VariableDeclaration>();
  for (const candidate of candidates) {
    if (!candidate || !ts.isVariableDeclaration(candidate)) continue;
    if (candidate.getSourceFile() !== sourceFile) continue;
    if (!ts.isIdentifier(candidate.name)) continue;
    const list = candidate.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile) continue;
    directDeclarations.add(candidate);
  }
  if (directDeclarations.size !== 1) return undefined;
  return [...directDeclarations][0]!;
}

function directTopLevelDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const declaration = uniqueTopLevelVariableDeclaration(node, checker);
  if (!declaration) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = bindingDeclarationCandidates(node, checker);
  if (candidates.length === 0) return undefined;
  const list = declaration.parent as ts.VariableDeclarationList;
  if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return declaration;

  // #2949 Acorn follow-up — a unique top-level `var` in an ES module has one
  // checker identity and one legacy `__mod_*` slot, so scalar reads/writes can
  // share that slot with IR just like `let`. Reject scripts and merged/repeated
  // declarations: their hoisting/global-alias rules are wider than this exact
  // source-owned capability.
  if (!ts.isExternalModule(sourceFile)) return undefined;
  const declaredType = checker.getTypeAtLocation(declaration.name);
  if (
    (declaredType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) === 0 &&
    !updateRetypesModuleBinding(checker, declaration)
  ) {
    return undefined;
  }
  const sameSourceDeclarations = new Set(
    candidates.filter(
      (candidate): candidate is ts.Declaration =>
        candidate !== undefined && candidate.getSourceFile() === sourceFile && !ts.isExportSpecifier(candidate),
    ),
  );
  return sameSourceDeclarations.size === 1 && sameSourceDeclarations.has(declaration) ? declaration : undefined;
}

function localVariableDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const sourceFile = node.getSourceFile();
  const candidates = bindingDeclarationCandidates(node, checker);
  return candidates.find(
    (candidate): candidate is ts.VariableDeclaration =>
      candidate !== undefined && ts.isVariableDeclaration(candidate) && candidate.getSourceFile() === sourceFile,
  );
}

function localValueDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.Declaration | undefined {
  const sourceFile = node.getSourceFile();
  const candidates = bindingDeclarationCandidates(node, checker);
  return candidates.find(
    (
      candidate,
    ): candidate is ts.VariableDeclaration | ts.BindingElement | ts.ParameterDeclaration | ts.FunctionDeclaration =>
      candidate !== undefined &&
      candidate.getSourceFile() === sourceFile &&
      (ts.isVariableDeclaration(candidate) ||
        ts.isBindingElement(candidate) ||
        ts.isParameter(candidate) ||
        ts.isFunctionDeclaration(candidate)),
  );
}

function scalarKind(type: ts.Type, options: IrModuleBindingResolverOptions): IrModuleBindingValueKind | undefined {
  const alias = type.aliasSymbol?.name;
  if (alias === "f64" && (type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return { kind: "f64" };
  }
  if (alias && NON_F64_NATIVE_NUMBER_ALIASES.has(alias) && (type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return undefined;
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return { kind: "i32", semantic: "boolean" };
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    // IR's semantic `number` remains f64. Fast mode stores ordinary numbers
    // as i32 in the legacy ABI, so claiming here would create f64/i32 body,
    // return, and module-init mismatches. Explicit f64 aliases were handled
    // above; numeric i32 aliases are not inferred because the checker erases
    // their storage-significant alias at this lookup site.
    return options.numberStorage === "f64" ? { kind: "f64" } : undefined;
  }
  return undefined;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function externClassNameForType(
  type: ts.Type,
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): string | undefined {
  const nonNull = checker.getNonNullableType(type);
  const className = nonNull.getSymbol()?.name ?? nonNull.aliasSymbol?.name;
  if (!className) return undefined;
  const builtinExtern =
    MODULE_EXTERN_BUILTINS.has(className) &&
    options.allowBuiltinMapExtern &&
    (nonNull.getSymbol()?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  if (MODULE_EXTERN_BUILTINS.has(className)) return builtinExtern ? className : undefined;
  return isExternalDeclaredClass(nonNull, checker) ? className : undefined;
}

/**
 * (#4461) Prove a declared type is the ambient lib `Map`, the one builtin whose
 * host-free carrier is the native `$Map` struct.
 *
 * The proof is deliberately the same shape as `externClassNameForType`'s
 * builtin arm — ambient (declaration-file) declarations only — so a user class
 * named `Map` keeps ordinary class dispatch instead of acquiring collection
 * storage by spelling. A nullable annotation is rejected outright: the legacy
 * slot is `(ref null $Map)` but the IR has no null-carrying native-map value,
 * so a source that can hold `null` must stay on the direct path.
 */
function isNativeMapStorageType(
  type: ts.Type,
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): boolean {
  if (options.allowNativeMapStorage !== true) return false;
  if (type.isUnion()) return false;
  const nonNull = checker.getNonNullableType(type);
  if (nonNull !== type) return false;
  const symbol = nonNull.getSymbol() ?? nonNull.aliasSymbol;
  if (symbol?.name !== "Map") return false;
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

/**
 * (#4461) The one initializer shape a native-`$Map` module binding admits:
 * `new Map()` / `new Map<K, V>()` against the ambient constructor, zero
 * runtime arguments. `new Map(iterable)` needs the `__map_new_from_arr`
 * drive that this storage slice does not lower, so it is refused before claim.
 */
function isNativeMapConstruction(checker: ts.TypeChecker, value: ts.Expression): boolean {
  const candidate = unwrapParens(value);
  if (!ts.isNewExpression(candidate)) return false;
  if (!ts.isIdentifier(candidate.expression) || candidate.expression.text !== "Map") return false;
  if ((candidate.arguments?.length ?? 0) !== 0) return false;
  try {
    const declaration = checker.getResolvedSignature(candidate)?.getDeclaration();
    return declaration?.getSourceFile().isDeclarationFile === true;
  } catch {
    return false;
  }
}

/**
 * Prove the narrow same-file extern factory used by the calendar example.
 *
 * A source function's return annotation alone is not provenance: with
 * semantic diagnostics skipped, `function fake(): HTMLElement { return 1 as
 * any; }` still has an extern-looking call type. Require a direct call to the
 * exact top-level FunctionDeclaration, an explicit extern return annotation,
 * one final return, and a return source that is independently known to be a
 * host extern. A returned local must be a top-level `const` in the factory so
 * its initializer remains the value actually returned.
 */
function sameFileExternFactoryCallIsProven(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  options: IrModuleBindingResolverOptions,
  seen: Set<ts.Node>,
): boolean {
  if (
    call.questionDotToken ||
    call.typeArguments?.length ||
    !ts.isIdentifier(call.expression) ||
    call.arguments.some(ts.isSpreadElement)
  ) {
    return false;
  }
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.getDeclaration();
  if (
    !signature ||
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    !declaration.name ||
    !declaration.body ||
    !declaration.type ||
    declaration.parent !== call.getSourceFile() ||
    declaration.getSourceFile() !== call.getSourceFile() ||
    declaration.asteriskToken ||
    declaration.typeParameters?.length ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    seen.has(declaration)
  ) {
    return false;
  }

  const calleeSymbol = checker.getSymbolAtLocation(call.expression);
  if (
    calleeSymbol?.valueDeclaration !== declaration &&
    !(calleeSymbol?.declarations ?? []).some((candidate) => candidate === declaration)
  ) {
    return false;
  }

  const annotatedReturn = checker.getTypeFromTypeNode(declaration.type);
  if (
    annotatedReturn.isUnion() &&
    annotatedReturn.types.some((member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0)
  ) {
    return false;
  }
  if (!externClassNameForType(annotatedReturn, checker, options)) return false;
  const statements = declaration.body.statements;
  const finalStatement = statements[statements.length - 1];
  if (!finalStatement || !ts.isReturnStatement(finalStatement) || !finalStatement.expression) return false;

  let earlierReturn = false;
  const findEarlierReturn = (node: ts.Node): void => {
    if (earlierReturn) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      earlierReturn = true;
      return;
    }
    node.forEachChild(findEarlierReturn);
  };
  for (const statement of statements.slice(0, -1)) findEarlierReturn(statement);
  if (earlierReturn) return false;

  const returned = unwrapParens(finalStatement.expression);
  let source = returned;
  if (ts.isIdentifier(returned)) {
    const symbol = checker.getSymbolAtLocation(returned);
    const variable = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].find(
      (candidate): candidate is ts.VariableDeclaration =>
        candidate !== undefined &&
        ts.isVariableDeclaration(candidate) &&
        ts.isVariableStatement(candidate.parent.parent) &&
        candidate.parent.parent.parent === declaration.body,
    );
    if (
      !variable?.initializer ||
      !ts.isVariableDeclarationList(variable.parent) ||
      (variable.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return false;
    }

    // `const` is the provenance anchor, but diagnostics-off sources can still
    // contain illegal writes. Reject those explicitly rather than trusting
    // the checker diagnostic to have stopped compilation. Nested functions
    // are also outside this exact factory shape because they could mutate a
    // captured binding before the final return.
    let bindingMayChange = false;
    const isReturnedBinding = (node: ts.Identifier): boolean => checker.getSymbolAtLocation(node) === symbol;
    const assignmentTargetWritesBinding = (target: ts.Expression): boolean => {
      const candidate = unwrapParens(target);
      if (ts.isIdentifier(candidate)) return isReturnedBinding(candidate);
      if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return assignmentTargetWritesBinding(candidate.left);
      }
      if (ts.isArrayLiteralExpression(candidate)) {
        return candidate.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) &&
            assignmentTargetWritesBinding(ts.isSpreadElement(element) ? element.expression : element),
        );
      }
      if (ts.isObjectLiteralExpression(candidate)) {
        return candidate.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) return isReturnedBinding(property.name);
          if (ts.isPropertyAssignment(property)) return assignmentTargetWritesBinding(property.initializer);
          if (ts.isSpreadAssignment(property)) return assignmentTargetWritesBinding(property.expression);
          return false;
        });
      }
      return false;
    };
    const visitForWrites = (node: ts.Node): void => {
      if (bindingMayChange) return;
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        bindingMayChange = true;
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (
          operator >= ts.SyntaxKind.FirstAssignment &&
          operator <= ts.SyntaxKind.LastAssignment &&
          assignmentTargetWritesBinding(node.left)
        ) {
          bindingMayChange = true;
          return;
        }
      }
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if (
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
          ts.isIdentifier(node.operand) &&
          isReturnedBinding(node.operand)
        ) {
          bindingMayChange = true;
          return;
        }
      }
      if (
        (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        assignmentTargetWritesBinding(node.initializer)
      ) {
        bindingMayChange = true;
        return;
      }
      node.forEachChild(visitForWrites);
    };
    for (const statement of statements.slice(0, -1)) visitForWrites(statement);
    if (bindingMayChange) return false;
    source = unwrapParens(variable.initializer);
  }

  // A parameter merely moves the provenance obligation to the call site.
  // This narrow proof intentionally does not perform interprocedural argument
  // substitution, so reject direct/aliased parameter forwarding instead of
  // trusting an extern-looking annotation under diagnostics-off compilation.
  const forwardsParameter = (candidate: ts.Expression, seenVariables = new Set<ts.VariableDeclaration>()): boolean => {
    const value = unwrapParens(candidate);
    if (
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isNonNullExpression(value)
    ) {
      return forwardsParameter(value.expression, seenVariables);
    }
    if (!ts.isIdentifier(value)) return false;
    const symbol = checker.getSymbolAtLocation(value);
    const declarations = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].filter(
      (node): node is ts.Declaration => node !== undefined,
    );
    if (declarations.some(ts.isParameter)) return true;
    const variable = declarations.find(ts.isVariableDeclaration);
    if (!variable?.initializer || seenVariables.has(variable)) return false;
    const nextSeen = new Set(seenVariables);
    nextSeen.add(variable);
    return forwardsParameter(variable.initializer, nextSeen);
  };
  if (forwardsParameter(source)) return false;

  try {
    if (!checker.isTypeAssignableTo(checker.getTypeAtLocation(source), annotatedReturn)) return false;
  } catch {
    return false;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(declaration);
  return externValueSourceIsProven(checker, source, options, nextSeen);
}

function externValueSourceIsProven(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  options: IrModuleBindingResolverOptions,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParens(expr);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (seen.has(value) || moduleExternValueNeedsLegacy(value)) return false;
  seen.add(value);
  if (!externClassNameForType(checker.getTypeAtLocation(value), checker, options)) return false;
  if (ts.isObjectLiteralExpression(value)) return false;
  if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) {
    return externValueSourceIsProven(checker, value.expression, options, seen);
  }
  if (ts.isIdentifier(value)) {
    if (directTopLevelDeclaration(value, checker)) return true;
    const symbol = checker.getSymbolAtLocation(value);
    const declarations = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])].filter(
      (declaration): declaration is ts.Declaration => declaration !== undefined,
    );
    if (declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile)) return true;
    const parameter = declarations.find(ts.isParameter);
    if (parameter) return true;
    const variable = declarations.find(ts.isVariableDeclaration);
    return variable?.initializer ? externValueSourceIsProven(checker, variable.initializer, options, seen) : false;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const symbol = checker.getSymbolAtLocation(value.name);
    return (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  }
  if (ts.isCallExpression(value)) {
    const signatureDeclaration = checker.getResolvedSignature(value)?.getDeclaration();
    if (signatureDeclaration?.getSourceFile().isDeclarationFile === true) return true;
    return sameFileExternFactoryCallIsProven(checker, value, options, seen);
  }
  if (ts.isNewExpression(value)) {
    return checker.getResolvedSignature(value)?.getDeclaration()?.getSourceFile().isDeclarationFile === true;
  }
  return false;
}

function externValueIsPassable(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  options: IrModuleBindingResolverOptions,
): boolean {
  const value = unwrapParens(expr);
  // Without the resolved legacy ValType, null is ambiguous: externref accepts
  // it, while nullable scalar declarations still use f64/i32 and reject it.
  if (value.kind === ts.SyntaxKind.NullKeyword) return false;
  const type = checker.getTypeAtLocation(value);
  if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike)) !== 0) {
    return true;
  }
  if (!externClassNameForType(type, checker, options)) return false;
  return externValueSourceIsProven(checker, value, options);
}

function callReceiverIsModuleExtern(
  call: ts.CallExpression,
  resolve: (node: ts.Identifier) => IrLegacyModuleBindingIdentity | undefined,
): boolean {
  const visit = (expr: ts.Expression): boolean => {
    const candidate = unwrapParens(expr);
    if (ts.isIdentifier(candidate)) {
      const valueKind = resolve(candidate)?.valueKind;
      return valueKind !== undefined && bindingValue.isIrModuleReferenceValueKind(valueKind);
    }
    if (ts.isPropertyAccessExpression(candidate)) return visit(candidate.expression);
    if (ts.isCallExpression(candidate)) return visit(candidate.expression);
    return false;
  };
  return ts.isPropertyAccessExpression(call.expression) && visit(call.expression.expression);
}

/**
 * Extern-valued conditionals and short-circuit expressions need control-flow
 * lowering that can preserve the branded externref on every arm. Capability C
 * deliberately leaves those shapes on the legacy path instead of accepting
 * them through checker assignability and failing after the IR claim.
 */
export function moduleExternValueNeedsLegacy(expr: ts.Expression): boolean {
  let needsLegacy = false;
  const visit = (node: ts.Node): void => {
    if (needsLegacy) return;
    if (
      ts.isConditionalExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      needsLegacy = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(unwrapParens(expr));
  return needsLegacy;
}

function writeValueMatches(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  targetType: ts.Type,
  targetKind: IrModuleBindingValueKind,
  value: ts.Expression,
  options: IrModuleBindingResolverOptions,
  classifyPrimitiveExpression: (expr: ts.Expression) => IrPrimitiveExpressionFamily | undefined,
): boolean {
  const valueExpr = unwrapParens(value);
  if (targetKind.kind === "dynamic") {
    // The current IR boxing producer accepts exactly the three primitive
    // families. Object/wrapper initializers still receive the same widened
    // compatibility slot but cause module-init selection to demote until IR
    // has an object-to-dynamic materializer.
    return classifyPrimitiveExpression(valueExpr) !== undefined;
  }
  if (targetKind.kind === "native-map") {
    // The native `$Map` carrier has exactly one producer in this slice.
    return isNativeMapConstruction(checker, valueExpr);
  }
  if (bindingValue.isCapabilityExternKind(targetKind))
    return bindingValue.capabilityExternWriteMatches(
      options.resolveCapabilityExternBinding,
      declaration,
      valueExpr,
      targetKind,
    );
  if (targetKind.kind === "extern") {
    if (moduleExternValueNeedsLegacy(valueExpr)) return false;
    if (valueExpr.kind === ts.SyntaxKind.NullKeyword) return true;
    try {
      return (
        externValueSourceIsProven(checker, valueExpr, options) &&
        checker.isTypeAssignableTo(checker.getTypeAtLocation(valueExpr), targetType)
      );
    } catch {
      return false;
    }
  }
  let scalarShapeIsLowerable = true;
  const checkScalarShape = (node: ts.Node): void => {
    if (!scalarShapeIsLowerable) return;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operandType = checker.getTypeAtLocation(unwrapParens(node.operand));
      if ((operandType.flags & ts.TypeFlags.BooleanLike) === 0) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    if (ts.isConditionalExpression(node)) {
      const conditionType = checker.getTypeAtLocation(unwrapParens(node.condition));
      if ((conditionType.flags & ts.TypeFlags.BooleanLike) === 0) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const leftType = checker.getTypeAtLocation(unwrapParens(node.left));
        const rightType = checker.getTypeAtLocation(unwrapParens(node.right));
        if ((leftType.flags & ts.TypeFlags.BooleanLike) === 0 || (rightType.flags & ts.TypeFlags.BooleanLike) === 0) {
          scalarShapeIsLowerable = false;
          return;
        }
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken) {
        const leftType = checker.getTypeAtLocation(unwrapParens(node.left));
        if ((leftType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0) {
          scalarShapeIsLowerable = false;
          return;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiverType = checker.getTypeAtLocation(unwrapParens(node.expression.expression));
      const receiverIsNumber = (receiverType.flags & ts.TypeFlags.NumberLike) !== 0;
      const receiverIsBoolean = (receiverType.flags & ts.TypeFlags.BooleanLike) !== 0;
      const supportedNumberString =
        receiverIsNumber &&
        !receiverIsBoolean &&
        node.expression.name.text === "toString" &&
        node.arguments.length === 0 &&
        node.questionDotToken === undefined &&
        node.expression.questionDotToken === undefined;
      if ((receiverIsNumber || receiverIsBoolean) && !supportedNumberString) {
        scalarShapeIsLowerable = false;
        return;
      }
    }
    node.forEachChild(checkScalarShape);
  };
  checkScalarShape(valueExpr);
  if (!scalarShapeIsLowerable) return false;
  const valueKind = scalarKind(checker.getTypeAtLocation(valueExpr), options);
  if (!valueKind || valueKind.kind !== targetKind.kind) return false;
  return targetKind.kind !== "i32" || (valueKind.kind === "i32" && valueKind.semantic === targetKind.semantic);
}

function exactTopLevelVariableDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  const declarations = new Set(
    candidates.filter(
      (candidate): candidate is ts.VariableDeclaration =>
        candidate !== undefined &&
        ts.isVariableDeclaration(candidate) &&
        candidate.getSourceFile() === sourceFile &&
        ts.isIdentifier(candidate.name) &&
        ts.isVariableDeclarationList(candidate.parent) &&
        ts.isVariableStatement(candidate.parent.parent) &&
        candidate.parent.parent.parent === sourceFile,
    ),
  );
  return declarations.size === 1 ? [...declarations][0] : undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function identifierIsWritten(node: ts.Identifier): boolean {
  let target: ts.Node = node;
  let parent = target.parent;
  while (
    (ts.isParenthesizedExpression(parent) && parent.expression === target) ||
    (ts.isArrayLiteralExpression(parent) && parent.elements.includes(target as ts.Expression)) ||
    (ts.isObjectLiteralExpression(parent) && parent.properties.includes(target as ts.ObjectLiteralElementLike)) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === target) ||
    (ts.isSpreadElement(parent) && parent.expression === target) ||
    (ts.isSpreadAssignment(parent) && parent.expression === target)
  ) {
    target = parent;
    parent = target.parent;
  }
  if (ts.isBinaryExpression(parent) && parent.left === target && isAssignmentOperator(parent.operatorToken.kind)) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === target;
}

function isVarModuleDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
  );
}

function sourceBindingIsStable(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol && identifierIsWritten(node)) {
      stable = false;
      return;
    }
    node.forEachChild(visit);
  };
  declaration.getSourceFile().forEachChild(visit);
  return stable;
}

function matchingRetainedMethodAssignment(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  receiverSymbol: ts.Symbol,
  methodName: string,
): ts.BinaryExpression | undefined {
  const writes: ts.BinaryExpression[] = [];
  let unsupportedWrite = false;
  const visit = (node: ts.Node): void => {
    if (unsupportedWrite) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.name.text === methodName &&
      checker.getSymbolAtLocation(node.expression) === receiverSymbol
    ) {
      const parent = node.parent;
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        writes.push(parent);
      } else if (
        (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) ||
        ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isDeleteExpression(parent) && parent.expression === node)
      ) {
        unsupportedWrite = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (unsupportedWrite || writes.length !== 1) return undefined;
  const assignment = writes[0]!;
  return ts.isExpressionStatement(assignment.parent) && assignment.parent.parent === sourceFile
    ? assignment
    : undefined;
}

/**
 * Prove that a retained-call argument can cross the receiver-first dynamic
 * dispatcher bridge without a build-time representation guess.
 *
 * Dynamic values pass through, numbers and strings have canonical boxes, and
 * reference values use the established externalization path. Boolean values
 * deliberately remain excluded: their i32 carrier is ambiguous at this seam
 * unless the lowerer also receives an exact boolean-brand proof.
 */
function retainedMethodArgumentIsBridgeable(checker: ts.TypeChecker, argument: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(unwrapParens(argument));
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike)) !== 0) return true;
  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0) return true;
  return false;
}

function makeRetainedFunctionMethodPlan(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): IrRetainedFunctionMethodPlan | undefined {
  if (
    call.questionDotToken ||
    call.typeArguments?.length ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    !ts.isIdentifier(call.expression.name) ||
    call.arguments.some(ts.isSpreadElement)
  ) {
    return undefined;
  }
  if (call.arguments.some((argument) => !retainedMethodArgumentIsBridgeable(checker, argument))) {
    return undefined;
  }
  const receiver = call.expression.expression;
  const receiverDeclaration = exactTopLevelVariableDeclaration(receiver, checker);
  const receiverTarget = receiverDeclaration?.initializer ? unwrapParens(receiverDeclaration.initializer) : undefined;
  if (
    !receiverDeclaration ||
    !receiverTarget ||
    !ts.isFunctionExpression(receiverTarget) ||
    !isVarModuleDeclaration(receiverDeclaration) ||
    !sourceBindingIsStable(checker, receiverDeclaration)
  ) {
    return undefined;
  }
  const receiverSymbol = checker.getSymbolAtLocation(receiver);
  if (!receiverSymbol || checker.getSymbolAtLocation(receiverDeclaration.name) !== receiverSymbol) return undefined;
  const methodName = call.expression.name.text;
  const assignment = matchingRetainedMethodAssignment(
    checker,
    receiverDeclaration.getSourceFile(),
    receiverSymbol,
    methodName,
  );
  const methodTarget = assignment ? unwrapParens(assignment.right) : undefined;
  if (
    !methodTarget ||
    !ts.isFunctionExpression(methodTarget) ||
    methodTarget.asteriskToken ||
    methodTarget.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    methodTarget.typeParameters?.length ||
    call.arguments.length !== methodTarget.parameters.length ||
    methodTarget.parameters.some(
      (parameter) =>
        !ts.isIdentifier(parameter.name) ||
        parameter.dotDotDotToken !== undefined ||
        parameter.questionToken !== undefined ||
        parameter.initializer !== undefined,
    )
  ) {
    return undefined;
  }
  return {
    receiverDeclaration,
    receiverTarget,
    methodTarget,
    receiverName: receiver.text,
    methodName,
    arity: call.arguments.length,
  };
}

function exactTopLevelFunctionDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const declarations = new Set(
    [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
      (candidate): candidate is ts.FunctionDeclaration =>
        candidate !== undefined &&
        ts.isFunctionDeclaration(candidate) &&
        candidate.getSourceFile() === sourceFile &&
        candidate.parent === sourceFile &&
        candidate.name !== undefined,
    ),
  );
  if (declarations.size !== 1) return undefined;
  const declaration = [...declarations][0]!;
  return checker.getSymbolAtLocation(declaration.name!) === symbol ? declaration : undefined;
}

function stableCallReceiverIsAdmissible(receiver: ts.Expression): boolean {
  // The executable #3796 bridge currently proves only Acorn's exact live
  // receiver carrier. Do not use checker nullability here: allowJs/strict:false
  // and unresolved type parameters can erase the evidence needed to
  // distinguish a live receiver from the unbound/null sentinel.
  return unwrapParens(receiver).kind === ts.SyntaxKind.ThisKeyword;
}

function containsOptionalChainSegment(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAccessExpression(candidate) ||
        ts.isElementAccessExpression(candidate) ||
        ts.isCallExpression(candidate)) &&
      candidate.questionDotToken !== undefined
    ) {
      found = true;
      return;
    }
    candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

function sourceModuleExportsSymbol(sourceFile: ts.SourceFile, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return true;
  try {
    return checker.getExportsOfModule(moduleSymbol).some((exported) => {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      return target === symbol;
    });
  } catch {
    // Export identity is part of the closed-world proof. A checker failure
    // cannot safely be interpreted as "module-private".
    return true;
  }
}

function stableCallSiteForReference(
  reference: ts.Identifier,
  declaration: ts.FunctionDeclaration,
): IrStableFunctionCallSite | undefined {
  const access = reference.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== reference ||
    access.questionDotToken !== undefined ||
    access.name.text !== "call"
  ) {
    return undefined;
  }
  const call = access.parent;
  if (
    !ts.isCallExpression(call) ||
    call.expression !== access ||
    call.questionDotToken !== undefined ||
    call.typeArguments?.length ||
    call.arguments.length !== declaration.parameters.length + 1 ||
    call.arguments.some(ts.isSpreadElement) ||
    containsOptionalChainSegment(call)
  ) {
    return undefined;
  }
  const receiver = call.arguments[0]!;
  if (!stableCallReceiverIsAdmissible(receiver)) return undefined;
  return { call, receiver, arguments: call.arguments.slice(1) };
}

function targetThisUsesOnlyDynamicMemberRoots(declaration: ts.FunctionDeclaration): boolean {
  const body = declaration.body;
  if (!body || containsOptionalChainSegment(body)) return false;
  let sawThis = false;
  let supported = true;
  const visit = (node: ts.Node): void => {
    if (!supported) return;
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      sawThis = true;
      const parent = node.parent;
      const memberRootIsRead = (access: ts.Expression): boolean => {
        const use = access.parent;
        if (ts.isBinaryExpression(use) && use.left === access && isAssignmentOperator(use.operatorToken.kind)) {
          return false;
        }
        if (
          (ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) &&
          use.operand === access &&
          (use.operator === ts.SyntaxKind.PlusPlusToken || use.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          return false;
        }
        return !(ts.isDeleteExpression(use) && use.expression === access);
      };
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        memberRootIsRead(parent)
      ) {
        return;
      }
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined &&
        memberRootIsRead(parent) &&
        (ts.isStringLiteralLike(unwrapParens(parent.argumentExpression)) ||
          ts.isNumericLiteral(unwrapParens(parent.argumentExpression)))
      ) {
        return;
      }
      supported = false;
      return;
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return sawThis && supported;
}

function makeStableFunctionCallPlan(
  checker: ts.TypeChecker,
  node: ts.FunctionDeclaration | ts.CallExpression,
  cache: Map<ts.FunctionDeclaration, IrStableFunctionCallPlan | null>,
): IrStableFunctionCallPlan | undefined {
  const targetIdentifier = ts.isFunctionDeclaration(node)
    ? node.name
    : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      ? node.expression.expression
      : undefined;
  if (!targetIdentifier) return undefined;
  const declaration = exactTopLevelFunctionDeclaration(targetIdentifier, checker);
  const sourceFile = declaration?.getSourceFile();
  const declarationSymbol = declaration?.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
  if (
    !declaration ||
    !sourceFile ||
    !declarationSymbol ||
    // A source-local scan is whole-program proof only for a module-private
    // declaration. Global scripts and exported declarations can acquire
    // references from other files that are absent from this traversal.
    !ts.isExternalModule(sourceFile) ||
    declaration.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) ||
    sourceModuleExportsSymbol(sourceFile, declarationSymbol, checker) ||
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.typeParameters?.length ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.parameters.length !== 4 ||
    declaration.parameters.some(
      (parameter) =>
        !ts.isIdentifier(parameter.name) ||
        parameter.name.text === "this" ||
        parameter.dotDotDotToken !== undefined ||
        parameter.questionToken !== undefined ||
        parameter.initializer !== undefined,
    ) ||
    !targetThisUsesOnlyDynamicMemberRoots(declaration)
  ) {
    return undefined;
  }
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature || signature.getParameters().length !== declaration.parameters.length) return undefined;

  let plan = cache.get(declaration);
  if (plan === null) return undefined;
  if (plan === undefined) {
    const symbol = checker.getSymbolAtLocation(declaration.name!);
    if (!symbol) {
      cache.set(declaration, null);
      return undefined;
    }
    const callSites: IrStableFunctionCallSite[] = [];
    let stable = true;
    const visit = (candidate: ts.Node): void => {
      if (!stable) return;
      if (
        ts.isIdentifier(candidate) &&
        candidate !== declaration.name &&
        checker.getSymbolAtLocation(candidate) === symbol
      ) {
        const callSite = stableCallSiteForReference(candidate, declaration);
        if (!callSite) {
          stable = false;
          return;
        }
        callSites.push(callSite);
      }
      candidate.forEachChild(visit);
    };
    declaration.getSourceFile().forEachChild(visit);
    plan =
      stable && callSites.length > 0
        ? {
            declaration,
            signature,
            targetName: declaration.name!.text,
            arity: declaration.parameters.length,
            callSites,
          }
        : null;
    cache.set(declaration, plan);
  }
  if (!plan) return undefined;
  return ts.isCallExpression(node) && !plan.callSites.some((site) => site.call === node) ? undefined : plan;
}

function staticStringFromExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen: Set<ts.VariableDeclaration>,
): string | undefined {
  const value = unwrapParens(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringFromExpression(checker, value.left, new Set(seen));
    if (left === undefined) return undefined;
    const right = staticStringFromExpression(checker, value.right, new Set(seen));
    return right === undefined ? undefined : left + right;
  }
  if (!ts.isIdentifier(value)) return undefined;
  const declaration = exactTopLevelVariableDeclaration(value, checker);
  if (!declaration?.initializer || seen.has(declaration) || !sourceBindingIsStable(checker, declaration)) {
    return undefined;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(declaration);
  return staticStringFromExpression(checker, declaration.initializer, nextSeen);
}

function staticRegExpInitializer(
  checker: ts.TypeChecker,
  initializer: ts.Expression,
): { readonly pattern: string; readonly flags: string } | undefined {
  const value = unwrapParens(initializer);
  if (value.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    const text = value.getText();
    const lastSlash = text.lastIndexOf("/");
    if (lastSlash <= 0) return undefined;
    return { pattern: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
  }
  if (!ts.isNewExpression(value) && !ts.isCallExpression(value)) return undefined;
  if (!ts.isIdentifier(value.expression) || value.expression.text !== "RegExp") return undefined;
  const constructorSymbol = checker.getSymbolAtLocation(value.expression);
  if (
    constructorSymbol &&
    (constructorSymbol.declarations ?? []).some((declaration) => !declaration.getSourceFile().isDeclarationFile)
  ) {
    return undefined;
  }
  const args = value.arguments ?? [];
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) return undefined;
  const pattern = staticStringFromExpression(checker, args[0]!, new Set());
  if (pattern === undefined) return undefined;
  const flags = args[1] === undefined ? "" : staticStringFromExpression(checker, args[1], new Set());
  if (flags === undefined || flags.includes("g") || flags.includes("y")) return undefined;
  return { pattern, flags };
}

function makeStaticRegExpTestPlan(checker: ts.TypeChecker, node: ts.Expression): IrStaticRegExpTestPlan | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = exactTopLevelVariableDeclaration(node, checker);
  if (
    !declaration?.initializer ||
    !isVarModuleDeclaration(declaration) ||
    !sourceBindingIsStable(checker, declaration)
  ) {
    return undefined;
  }
  const initializer = staticRegExpInitializer(checker, declaration.initializer);
  return initializer ? { declaration, ...initializer } : undefined;
}

function makeStaticNumericArrayPlan(
  checker: ts.TypeChecker,
  node: ts.Expression,
): IrStaticNumericArrayPlan | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = exactTopLevelVariableDeclaration(node, checker);
  if (
    !declaration?.initializer ||
    !isVarModuleDeclaration(declaration) ||
    !ts.isArrayLiteralExpression(unwrapParens(declaration.initializer)) ||
    !sourceBindingIsStable(checker, declaration)
  ) {
    return undefined;
  }
  const type = checker.getTypeAtLocation(declaration.name);
  const element = type.getNumberIndexType();
  return element && (element.flags & ts.TypeFlags.NumberLike) !== 0 ? { declaration } : undefined;
}

export function makeIrLegacyModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): IrLegacyModuleBindingResolver {
  const isAmbientBinding = makeIrAmbientBindingPredicate(checker);
  const classifyPrimitiveExpression = makeIrPrimitiveExpressionClassifier(checker);
  const resolveCapabilityExtern = options.resolveCapabilityExternBinding;
  const stableFunctionCallPlans = new Map<ts.FunctionDeclaration, IrStableFunctionCallPlan | null>();
  const inspectDirectBinding = (node: ts.Identifier, writeValue?: ts.Expression): IrLegacyModuleBindingInspection => {
    const declaration = directTopLevelDeclaration(node, checker);
    if (!declaration) return { kind: "not-direct" };
    const list = declaration.parent as ts.VariableDeclarationList;
    const statement = list.parent;
    // Ambient declarations establish a real checker identity but allocate no
    // legacy `__mod_*` slot. Keep them visible to isDirectModuleBinding below
    // so leaked flat scope names cannot impersonate them, while declining
    // them as supported storage here.
    if (
      declaration.getSourceFile().isDeclarationFile ||
      (ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
    ) {
      return { kind: "unsupported", declaration };
    }
    const isModuleVar = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
    const mutable = isModuleVar || (list.flags & ts.NodeFlags.Let) !== 0;
    if (writeValue !== undefined && !mutable) return { kind: "unsupported", declaration };

    // #4204/#4206 — direct codegen widens this binding's compatibility slot
    // to externref. IR cannot yet own the corresponding general dynamic
    // assignment/read boundaries, so reject before claim instead of resolving
    // the same slot as f64/i32 and tripping the Program ABI invariant later.
    if (heterogeneousAssignmentRetypesModuleBinding(options.oracle ?? checker, declaration)) {
      return { kind: "unsupported", declaration };
    }

    const declaredType = checker.getTypeAtLocation(declaration.name);
    // #4208 S2 — a non-fast update target whose initializer representation
    // cannot hold the Number written by `++` / `--` uses the IR dynamic
    // carrier. Fast mode has a `$AnyValue` dynamic carrier while compatibility
    // allocation currently widens these globals to externref, so it stays on
    // direct codegen until that ABI is unified.
    let valueKind =
      options.numberStorage === "f64" && updateRetypesModuleBinding(checker, declaration)
        ? ({ kind: "dynamic" } as const)
        : scalarKind(declaredType, options);
    if (!valueKind && !isModuleVar && options.allowHostExterns) {
      const className = externClassNameForType(declaredType, checker, options);
      if (className) {
        valueKind = { kind: "extern", className };
      }
    }
    if (!valueKind && !isModuleVar)
      valueKind = bindingValue.resolveCapabilityExternKind(resolveCapabilityExtern, declaration, writeValue);
    // (#4461) Host-free carrier for the same builtin. Deliberately NOT folded
    // into the arm above: `allowHostExterns` is false on this lane, and the
    // resulting storage is the native `$Map` struct rather than an externref.
    if (!valueKind && !isModuleVar && isNativeMapStorageType(declaredType, checker, options)) {
      valueKind = { kind: "native-map", className: "Map" } as const;
    }
    if (!valueKind) return { kind: "unsupported", declaration };
    if (
      writeValue !== undefined &&
      !writeValueMatches(
        checker,
        declaration,
        declaredType,
        valueKind,
        writeValue,
        options,
        classifyPrimitiveExpression,
      )
    ) {
      return { kind: "unsupported", declaration };
    }
    return { kind: "supported", identity: { declaration, mutable, valueKind } };
  };
  const resolve = (node: ts.Identifier, writeValue?: ts.Expression): IrLegacyModuleBindingIdentity | undefined => {
    try {
      const inspected = inspectDirectBinding(node, writeValue);
      return inspected.kind === "supported" ? inspected.identity : undefined;
    } catch {
      return undefined;
    }
  };
  return Object.assign(resolve, {
    inspectDirectBinding,
    isDirectModuleBinding(node: ts.Identifier): boolean {
      try {
        return directTopLevelDeclaration(node, checker) !== undefined;
      } catch {
        return false;
      }
    },
    isAmbientBinding(node: ts.Identifier): boolean {
      return isAmbientBinding(node);
    },
    localVariableDeclaration(node: ts.Identifier): ts.VariableDeclaration | undefined {
      try {
        return localVariableDeclaration(node, checker);
      } catch {
        return undefined;
      }
    },
    localValueDeclaration(node: ts.Identifier): ts.Declaration | undefined {
      try {
        return localValueDeclaration(node, checker);
      } catch {
        return undefined;
      }
    },
    externCallArgumentsMatch(call: ts.CallExpression | ts.NewExpression): boolean {
      try {
        const containsModuleExtern = (node: ts.Node): boolean => {
          let found = false;
          const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (ts.isIdentifier(candidate)) {
              const candidateKind = resolve(candidate)?.valueKind;
              if (candidateKind !== undefined && bindingValue.isIrModuleReferenceValueKind(candidateKind)) {
                found = true;
                return;
              }
            }
            candidate.forEachChild(visit);
          };
          visit(node);
          return found;
        };
        const callArguments = call.arguments ?? [];
        const signature = checker.getResolvedSignature(call);
        const moduleExternReceiver = ts.isCallExpression(call) && callReceiverIsModuleExtern(call, resolve);
        if (!signature) return !moduleExternReceiver && !callArguments.some(containsModuleExtern);
        const parameters = signature.getParameters();
        const argumentMatches = (rawArgument: ts.Expression, parameterIndex: number): boolean => {
          const argument = unwrapParens(rawArgument);
          if (moduleExternReceiver && !externValueIsPassable(checker, argument, options)) return false;
          if (!ts.isIdentifier(argument)) return !containsModuleExtern(argument);
          const binding = resolve(argument);
          // (#4461) A native `$Map` binding has no cross-boundary parameter
          // ABI at all — the struct reference cannot be branded against a
          // declared parameter class the way an externref handle can — so it
          // is refused as an argument outright rather than brand-matched.
          if (!binding) return true;
          const bindingKind = binding.valueKind;
          if (bindingKind.kind === "native-map") return false;
          const bindingClassName = bindingValue.externBoundaryClassName(bindingKind);
          if (bindingClassName === undefined) return true;
          const parameter = parameters[parameterIndex];
          const parameterDeclaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
          if (
            !parameter ||
            !parameterDeclaration ||
            (ts.isParameter(parameterDeclaration) && parameterDeclaration.dotDotDotToken)
          ) {
            return false;
          }
          const parameterType = checker.getNonNullableType(
            checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
          );
          const parameterClassName = parameterType.getSymbol()?.name ?? parameterType.aliasSymbol?.name;
          return parameterClassName === bindingClassName;
        };
        let parameterIndex = 0;
        for (const rawArgument of callArguments) {
          if (ts.isSpreadElement(rawArgument)) {
            const spreadSource = unwrapParens(rawArgument.expression);
            if (!ts.isArrayLiteralExpression(spreadSource)) return false;
            for (const element of spreadSource.elements) {
              if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return false;
              if (!argumentMatches(element, parameterIndex)) return false;
              parameterIndex++;
            }
            continue;
          }
          if (!argumentMatches(rawArgument, parameterIndex)) return false;
          parameterIndex++;
        }
        return true;
      } catch {
        return false;
      }
    },
    externValueIsPassable(value: ts.Expression): boolean {
      try {
        return externValueIsPassable(checker, value, options);
      } catch {
        return false;
      }
    },
    scalarExpressionFamily(expr: ts.Expression): "f64" | "boolean" | undefined {
      try {
        const type = checker.getTypeAtLocation(unwrapParens(expr));
        if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
        if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "f64";
        return undefined;
      } catch {
        return undefined;
      }
    },
    supportsHostNumberToString: options.allowHostExterns,
    bindingValueMatches(node: ts.Identifier, value: ts.Expression): boolean {
      try {
        const identity = resolve(node);
        if (!identity) return false;
        const declaredType = checker.getTypeAtLocation(identity.declaration.name);
        return writeValueMatches(
          checker,
          identity.declaration,
          declaredType,
          identity.valueKind,
          value,
          options,
          classifyPrimitiveExpression,
        );
      } catch {
        return false;
      }
    },
    staticRegExpTestPlan(node: ts.Expression): IrStaticRegExpTestPlan | undefined {
      try {
        return makeStaticRegExpTestPlan(checker, node);
      } catch {
        return undefined;
      }
    },
    staticNumericArrayPlan(node: ts.Expression): IrStaticNumericArrayPlan | undefined {
      try {
        return makeStaticNumericArrayPlan(checker, node);
      } catch {
        return undefined;
      }
    },
    retainedFunctionMethodPlan(call: ts.CallExpression): IrRetainedFunctionMethodPlan | undefined {
      try {
        return makeRetainedFunctionMethodPlan(checker, call);
      } catch {
        return undefined;
      }
    },
    fnctorArrayMethodPlan(call: ts.CallExpression): IrFnctorArrayMethodPlan | undefined {
      try {
        return makeFnctorArrayMethodPlan(checker, call, options.stableFnctorArrayPrototypeNames);
      } catch {
        return undefined;
      }
    },
    stableFunctionCallPlan(node: ts.FunctionDeclaration | ts.CallExpression): IrStableFunctionCallPlan | undefined {
      if (options.numberStorage !== "f64") return undefined;
      try {
        return makeStableFunctionCallPlan(checker, node, stableFunctionCallPlans);
      } catch {
        return undefined;
      }
    },
  });
}

export function makeIrModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): IrLegacyModuleBindingResolver;
export function makeIrModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
  identityContext: IrPlanningIdentityContext,
): IrModuleBindingResolver;
export function makeIrModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
  identityContext?: IrPlanningIdentityContext,
): IrLegacyModuleBindingResolver | IrModuleBindingResolver {
  const legacy = makeIrLegacyModuleBindingResolver(checker, options);
  if (!identityContext) return legacy;

  const ownerAt = (node: ts.Node): IrUnitId => requireIrPlanningOwnerUnitId(identityContext, node);
  const bindingLocation = (
    declaration: ts.VariableDeclaration,
  ): Pick<
    IrModuleBindingIdentity,
    "globalBindingId" | "tdzBindingId" | "storageOwnerUnitId" | "sourceId" | "declarationOrdinal"
  > => {
    const sourceFile = declaration.getSourceFile();
    const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
    if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
      return planningInvariant(
        "source-record-mismatch",
        `module binding source ${sourceFile.fileName} does not resolve back to the exact planning SourceFile`,
      );
    }
    let declarationOrdinal = 0;
    let found = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const candidate of statement.declarationList.declarations) {
        if (candidate === declaration) {
          found = true;
          break;
        }
        declarationOrdinal++;
      }
      if (found) break;
    }
    if (!found) {
      return planningInvariant(
        "source-record-mismatch",
        `module binding declaration is not in the exact top-level population of ${sourceFile.fileName}`,
      );
    }
    return {
      globalBindingId: irModuleGlobalBindingId(sourceId, declarationOrdinal),
      tdzBindingId: irModuleTdzGlobalBindingId(sourceId, declarationOrdinal),
      storageOwnerUnitId: requireIrPlanningOwnerUnitId(identityContext, declaration),
      sourceId,
      declarationOrdinal,
    };
  };
  const bindingIdentity = (
    identity: IrLegacyModuleBindingIdentity,
  ): Pick<
    IrModuleBindingIdentity,
    "globalBindingId" | "tdzBindingId" | "storageOwnerUnitId" | "sourceId" | "declarationOrdinal"
  > => bindingLocation(identity.declaration);
  const nestedAccessorDynamicBinding = (
    ownerUnitId: IrUnitId,
    node: ts.Identifier,
    inspected: IrLegacyModuleBindingInspection,
    writeValue?: ts.Expression,
  ): IrLegacyModuleBindingIdentity | undefined => {
    if (inspected.kind === "supported") return undefined;
    const owner = identityContext.terminalByUnitId.get(ownerUnitId);
    const ownerDeclaration = identityContext.declarationByUnitId.get(ownerUnitId);
    const ownerClass = ownerDeclaration?.parent;
    const boundedTopLevelAccessor =
      owner?.containingTerminalOwnerId === undefined &&
      ownerClass !== undefined &&
      (ts.isClassDeclaration(ownerClass) || ts.isClassExpression(ownerClass)) &&
      isBoundedPreparedAccessorClass(ownerClass);
    const boundedSelectionCandidate =
      options.allowBoundedTopLevelAccessorSelectionCandidates === true && boundedTopLevelAccessor;
    const exactSelectedTopLevelAccessor =
      boundedTopLevelAccessor &&
      selectedTopLevelAccessorUnitIdsByContext.get(identityContext)?.has(ownerUnitId) === true;
    const declaration =
      inspected.kind === "unsupported" ? inspected.declaration : uniqueTopLevelVariableDeclaration(node, checker);
    if (
      (owner?.containingTerminalOwnerId === undefined &&
        !boundedSelectionCandidate &&
        !exactSelectedTopLevelAccessor) ||
      !ownerDeclaration ||
      !ts.isSetAccessorDeclaration(ownerDeclaration) ||
      ownerDeclaration.parameters.length !== 1 ||
      !ts.isIdentifier(ownerDeclaration.parameters[0]!.name) ||
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer !== undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return undefined;
    }
    const declaredType = checker.getTypeAtLocation(declaration.name);
    if ((declaredType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return undefined;
    if (writeValue !== undefined) {
      if (!ts.isIdentifier(writeValue)) return undefined;
      const parameterName = ownerDeclaration.parameters[0]!.name as ts.Identifier;
      if (checker.getSymbolAtLocation(writeValue) !== checker.getSymbolAtLocation(parameterName)) return undefined;
    }
    return { declaration, mutable: true, valueKind: { kind: "dynamic" } };
  };
  const inspectDirectBinding = (node: ts.Identifier, writeValue?: ts.Expression): IrModuleBindingInspection => {
    const ownerUnitId = ownerAt(node);
    const inspected = legacy.inspectDirectBinding(node, writeValue);
    const identity =
      inspected.kind === "supported"
        ? inspected.identity
        : nestedAccessorDynamicBinding(ownerUnitId, node, inspected, writeValue);
    if (identity) {
      return { kind: "supported", identity: { ...identity, ownerUnitId, ...bindingIdentity(identity) } };
    }
    return inspected.kind === "unsupported" ? inspected : { kind: "not-direct" };
  };
  const resolve = (node: ts.Identifier, writeValue?: ts.Expression): IrModuleBindingIdentity | undefined => {
    try {
      const inspected = inspectDirectBinding(node, writeValue);
      return inspected.kind === "supported" ? inspected.identity : undefined;
    } catch (error) {
      rethrowPlanningInvariant(error);
      return undefined;
    }
  };

  return Object.assign(resolve, {
    inspectDirectBinding,
    isDirectModuleBinding(node: ts.Identifier): boolean {
      ownerAt(node);
      return legacy.isDirectModuleBinding(node);
    },
    isAmbientBinding(node: ts.Identifier): boolean {
      ownerAt(node);
      return legacy.isAmbientBinding(node);
    },
    localVariableDeclaration(node: ts.Identifier): ts.VariableDeclaration | undefined {
      ownerAt(node);
      return legacy.localVariableDeclaration(node);
    },
    localValueDeclaration(node: ts.Identifier): ts.Declaration | undefined {
      ownerAt(node);
      return legacy.localValueDeclaration(node);
    },
    externCallArgumentsMatch(call: ts.CallExpression | ts.NewExpression): boolean {
      ownerAt(call);
      return legacy.externCallArgumentsMatch(call);
    },
    externValueIsPassable(value: ts.Expression): boolean {
      ownerAt(value);
      return legacy.externValueIsPassable(value);
    },
    scalarExpressionFamily(expr: ts.Expression): "f64" | "boolean" | undefined {
      ownerAt(expr);
      return legacy.scalarExpressionFamily(expr);
    },
    supportsHostNumberToString: legacy.supportsHostNumberToString,
    bindingValueMatches(node: ts.Identifier, value: ts.Expression): boolean {
      ownerAt(node);
      return legacy.bindingValueMatches(node, value);
    },
    staticRegExpTestPlan(node: ts.Expression): IrStaticRegExpTestPlan | undefined {
      ownerAt(node);
      const plan = legacy.staticRegExpTestPlan(node);
      return plan ? { ...plan, ...bindingLocation(plan.declaration) } : undefined;
    },
    staticNumericArrayPlan(node: ts.Expression): IrStaticNumericArrayPlan | undefined {
      ownerAt(node);
      const plan = legacy.staticNumericArrayPlan(node);
      return plan ? { ...plan, ...bindingLocation(plan.declaration) } : undefined;
    },
    retainedFunctionMethodPlan(call: ts.CallExpression): IrRetainedFunctionMethodPlan | undefined {
      ownerAt(call);
      const plan = legacy.retainedFunctionMethodPlan(call);
      if (!plan) return undefined;
      const receiverUnitId = identityContext.unitIdByDeclaration.get(plan.receiverTarget);
      const methodUnitId = identityContext.unitIdByDeclaration.get(plan.methodTarget);
      if (
        receiverUnitId === undefined ||
        methodUnitId === undefined ||
        identityContext.declarationByUnitId.get(receiverUnitId) !== plan.receiverTarget ||
        identityContext.declarationByUnitId.get(methodUnitId) !== plan.methodTarget
      ) {
        return planningInvariant(
          "missing-unit-declaration",
          `retained ${plan.receiverName}.${plan.methodName} call has no exact function-expression identity`,
        );
      }
      const receiverLocation = bindingLocation(plan.receiverDeclaration);
      return {
        ...plan,
        receiverUnitId,
        methodUnitId,
        receiverGlobalBindingId: receiverLocation.globalBindingId,
        receiverStorageOwnerUnitId: receiverLocation.storageOwnerUnitId,
        receiverSourceId: receiverLocation.sourceId,
        receiverDeclarationOrdinal: receiverLocation.declarationOrdinal,
      };
    },
    fnctorArrayMethodPlan(call: ts.CallExpression): IrFnctorArrayMethodPlan | undefined {
      ownerAt(call);
      const plan = legacy.fnctorArrayMethodPlan(call);
      if (!plan) return undefined;
      const receiverLocation = bindingLocation(plan.receiverDeclaration);
      return {
        ...plan,
        receiverGlobalBindingId: receiverLocation.globalBindingId,
        receiverStorageOwnerUnitId: receiverLocation.storageOwnerUnitId,
        receiverSourceId: receiverLocation.sourceId,
        receiverDeclarationOrdinal: receiverLocation.declarationOrdinal,
      };
    },
    stableFunctionCallPlan(node: ts.FunctionDeclaration | ts.CallExpression): IrStableFunctionCallPlan | undefined {
      ownerAt(node);
      const plan = legacy.stableFunctionCallPlan(node);
      if (!plan) return undefined;
      for (const site of plan.callSites) ownerAt(site.call);
      const targetUnitId = identityContext.unitIdByDeclaration.get(plan.declaration);
      if (targetUnitId === undefined || identityContext.declarationByUnitId.get(targetUnitId) !== plan.declaration) {
        return planningInvariant(
          "missing-unit-declaration",
          `stable .call target ${plan.targetName} has no exact function-declaration identity`,
        );
      }
      const sourceId = requireIrPlanningSourceId(identityContext, plan.declaration.getSourceFile());
      return { ...plan, targetUnitId, sourceId };
    },
  });
}

/** Explicit structural factory; the three-argument overload above is equivalent. */
export function makeIrIdentityModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
  identityContext: IrPlanningIdentityContext,
): IrModuleBindingResolver {
  return makeIrModuleBindingResolver(checker, options, identityContext);
}

/** Drop the owner sidecar only at a deliberately name-era compatibility boundary. */
export function projectIrModuleBindingIdentityToLegacy(
  identity: IrModuleBindingIdentity,
): IrLegacyModuleBindingIdentity {
  return {
    declaration: identity.declaration,
    mutable: identity.mutable,
    valueKind: identity.valueKind,
  };
}

/** Explicit compatibility adapter for selector/integration consumers not yet owner-aware. */
export function projectIrModuleBindingResolverToLegacy(
  resolver: IrModuleBindingResolver,
): IrLegacyModuleBindingResolver {
  const inspectDirectBinding = (node: ts.Identifier, writeValue?: ts.Expression): IrLegacyModuleBindingInspection => {
    const inspected = resolver.inspectDirectBinding(node, writeValue);
    return inspected.kind === "supported"
      ? { kind: "supported", identity: projectIrModuleBindingIdentityToLegacy(inspected.identity) }
      : inspected;
  };
  const resolve = (node: ts.Identifier, writeValue?: ts.Expression): IrLegacyModuleBindingIdentity | undefined => {
    const identity = resolver(node, writeValue);
    return identity ? projectIrModuleBindingIdentityToLegacy(identity) : undefined;
  };
  return Object.assign(resolve, {
    inspectDirectBinding,
    isDirectModuleBinding: (node: ts.Identifier) => resolver.isDirectModuleBinding(node),
    isAmbientBinding: (node: ts.Identifier) => resolver.isAmbientBinding(node),
    localVariableDeclaration: (node: ts.Identifier) => resolver.localVariableDeclaration(node),
    localValueDeclaration: (node: ts.Identifier) => resolver.localValueDeclaration(node),
    externCallArgumentsMatch: (call: ts.CallExpression | ts.NewExpression) => resolver.externCallArgumentsMatch(call),
    externValueIsPassable: (value: ts.Expression) => resolver.externValueIsPassable(value),
    scalarExpressionFamily: (expr: ts.Expression) => resolver.scalarExpressionFamily(expr),
    supportsHostNumberToString: resolver.supportsHostNumberToString,
    bindingValueMatches: (node: ts.Identifier, value: ts.Expression) => resolver.bindingValueMatches(node, value),
    staticRegExpTestPlan: (node: ts.Expression) => resolver.staticRegExpTestPlan(node),
    staticNumericArrayPlan: (node: ts.Expression) => resolver.staticNumericArrayPlan(node),
    retainedFunctionMethodPlan: (call: ts.CallExpression) => resolver.retainedFunctionMethodPlan(call),
    fnctorArrayMethodPlan: (call: ts.CallExpression) => resolver.fnctorArrayMethodPlan(call),
    stableFunctionCallPlan: (node: ts.FunctionDeclaration | ts.CallExpression) => {
      const plan = resolver.stableFunctionCallPlan(node);
      if (!plan) return undefined;
      return {
        declaration: plan.declaration,
        signature: plan.signature,
        targetName: plan.targetName,
        arity: plan.arity,
        callSites: plan.callSites,
      };
    },
  });
}
