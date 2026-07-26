// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 Capability C — checker-backed module-binding identity shared by the
// selector and AST→IR builder. This module is deliberately leaf-shaped so the
// fallback gate can import it without pulling in codegen/index.ts.

import { isExternalDeclaredClass } from "../checker/type-mapper.js";
import { ts } from "../ts-api.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "./abi-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId } from "./identity.js";
import type { IrClassShape } from "./nodes.js";
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
    readonly declaration: ts.ClassDeclaration;
    readonly symbol: ts.Symbol;
  }

  const projectedByClassId = new Map<IrClassId, ProjectedClass>();
  const declarationCounts = new Map<ts.ClassDeclaration, number>();
  const symbolCounts = new Map<ts.Symbol, number>();
  const candidates: ProjectedClass[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const legacyName = statement.name.text;
    const shape = projectedShapes.get(legacyName);
    if (!shape || shape.className !== legacyName) continue;
    const classId = identityContext.classIdByDeclaration.get(statement);
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
    const symbol = checker.getSymbolAtLocation(statement.name);
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

export type IrModuleBindingValueKind =
  | { readonly kind: "f64" }
  | { readonly kind: "i32"; readonly semantic: "boolean" }
  | { readonly kind: "extern"; readonly className: string };

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
  /**
   * Builtin Map uses an externref slot only in host-string mode. Native-string
   * lanes store it as `(ref null $Map)`, outside this capability's surface.
   */
  readonly allowBuiltinMapExtern: boolean;
}

// Builtins which are deliberately excluded by isExternalDeclaredClass but are
// registered in the legacy extern-class table on the JS-host lane. This keeps
// the already-landed #2856 C3 const-Map read path intact.
const MODULE_EXTERN_BUILTINS = new Set(["Map"]);
const NON_F64_NATIVE_NUMBER_ALIASES = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "f32"]);

function directTopLevelDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  for (const candidate of candidates) {
    if (!candidate || !ts.isVariableDeclaration(candidate)) continue;
    if (candidate.getSourceFile() !== sourceFile) continue;
    if (!ts.isIdentifier(candidate.name)) continue;
    const list = candidate.parent;
    if (!ts.isVariableDeclarationList(list)) continue;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile) continue;
    // Capability C is intentionally lexical-binding-only. Module `var`
    // hoisting has wider aliasing rules and stays on the legacy path.
    if (!(list.flags & ts.NodeFlags.Let) && !(list.flags & ts.NodeFlags.Const)) continue;
    return candidate;
  }
  return undefined;
}

function localVariableDeclaration(node: ts.Identifier, checker: ts.TypeChecker): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const candidates = [symbol.valueDeclaration, ...(symbol.declarations ?? [])];
  return candidates.find(
    (candidate): candidate is ts.VariableDeclaration =>
      candidate !== undefined && ts.isVariableDeclaration(candidate) && candidate.getSourceFile() === sourceFile,
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
    if (ts.isIdentifier(candidate)) return resolve(candidate)?.valueKind.kind === "extern";
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
  targetType: ts.Type,
  targetKind: IrModuleBindingValueKind,
  value: ts.Expression,
  options: IrModuleBindingResolverOptions,
): boolean {
  const valueExpr = unwrapParens(value);
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

export function makeIrLegacyModuleBindingResolver(
  checker: ts.TypeChecker,
  options: IrModuleBindingResolverOptions,
): IrLegacyModuleBindingResolver {
  const isAmbientBinding = makeIrAmbientBindingPredicate(checker);
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
    const mutable = (list.flags & ts.NodeFlags.Let) !== 0;
    if (writeValue !== undefined && !mutable) return { kind: "unsupported", declaration };

    const declaredType = checker.getTypeAtLocation(declaration.name);
    let valueKind = scalarKind(declaredType, options);
    if (!valueKind && options.allowHostExterns) {
      const className = externClassNameForType(declaredType, checker, options);
      if (className) {
        valueKind = { kind: "extern", className };
      }
    }
    if (!valueKind) return { kind: "unsupported", declaration };
    if (writeValue !== undefined && !writeValueMatches(checker, declaredType, valueKind, writeValue, options)) {
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
    externCallArgumentsMatch(call: ts.CallExpression | ts.NewExpression): boolean {
      try {
        const containsModuleExtern = (node: ts.Node): boolean => {
          let found = false;
          const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (ts.isIdentifier(candidate) && resolve(candidate)?.valueKind.kind === "extern") {
              found = true;
              return;
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
          if (binding?.valueKind.kind !== "extern") return true;
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
          return parameterClassName === binding.valueKind.className;
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
        return writeValueMatches(checker, declaredType, identity.valueKind, value, options);
      } catch {
        return false;
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
  const bindingIdentity = (
    identity: IrLegacyModuleBindingIdentity,
  ): Pick<IrModuleBindingIdentity, "globalBindingId" | "tdzBindingId" | "sourceId" | "declarationOrdinal"> => {
    const sourceFile = identity.declaration.getSourceFile();
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
      for (const declaration of statement.declarationList.declarations) {
        if (declaration === identity.declaration) {
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
      sourceId,
      declarationOrdinal,
    };
  };
  const inspectDirectBinding = (node: ts.Identifier, writeValue?: ts.Expression): IrModuleBindingInspection => {
    const ownerUnitId = ownerAt(node);
    const inspected = legacy.inspectDirectBinding(node, writeValue);
    return inspected.kind === "supported"
      ? {
          kind: "supported",
          identity: { ...inspected.identity, ownerUnitId, ...bindingIdentity(inspected.identity) },
        }
      : inspected;
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
    externCallArgumentsMatch: (call: ts.CallExpression | ts.NewExpression) => resolver.externCallArgumentsMatch(call),
    externValueIsPassable: (value: ts.Expression) => resolver.externValueIsPassable(value),
    scalarExpressionFamily: (expr: ts.Expression) => resolver.scalarExpressionFamily(expr),
    supportsHostNumberToString: resolver.supportsHostNumberToString,
    bindingValueMatches: (node: ts.Identifier, value: ts.Expression) => resolver.bindingValueMatches(node, value),
  });
}
