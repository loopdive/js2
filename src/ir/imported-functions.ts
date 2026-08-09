// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Checker-backed resolution for the deliberately narrow imported-function IR
// slice (#3214 A+B1).  This module is intentionally a leaf: it knows about
// TypeScript symbols/declarations, but not about selector or lowering state.
// Both the selector and the overlay planner consume the same resolver so a
// call cannot be selected under one alias interpretation and lowered under
// another.

import { ts } from "../ts-api.js";
import type { IrSourceId, IrUnitId } from "./identity.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";

export interface IrResolvedFunctionTarget {
  /** Canonical flat key used by the legacy declaration/funcMap pipeline. */
  readonly targetName: string;
  readonly declaration: ts.FunctionDeclaration;
}

export interface IrImportedFunctionResolver {
  /** Resolve only a default/named ESM import binding to a compiled function. */
  resolveImportedFunction(node: ts.Identifier): IrResolvedFunctionTarget | undefined;
  /** Resolve only a direct same-file top-level FunctionDeclaration value. */
  resolveTopLevelFunctionValue(node: ts.Identifier): IrResolvedFunctionTarget | undefined;
  /** True for every import binding, including deliberately unsupported forms. */
  isImportBinding(node: ts.Identifier): boolean;
}

export type IrImportedTargetLegacyProjection = "unambiguous" | "ambiguous";

/** Exact checker-selected target retained before the flat legacy-name seam. */
export interface IrIdentityResolvedFunctionTarget {
  readonly targetUnitId: IrUnitId;
  /** Compatibility label only; never semantic identity. */
  readonly targetName: string;
  readonly declaration: ts.FunctionDeclaration;
  readonly legacyProjection: IrImportedTargetLegacyProjection;
}

export interface IrIdentityImportedFunctionResolver {
  resolveImportedFunctionTarget(node: ts.Identifier): IrIdentityResolvedFunctionTarget | undefined;
  resolveTopLevelFunctionValueTarget(node: ts.Identifier): IrIdentityResolvedFunctionTarget | undefined;
  isImportBinding(node: ts.Identifier): boolean;
}

/** Refuse a flat-name projection without discarding the structural target. */
export function projectIrIdentityImportedTargetToLegacy(
  target: IrIdentityResolvedFunctionTarget,
): IrResolvedFunctionTarget | undefined {
  return target.legacyProjection === "unambiguous"
    ? { targetName: target.targetName, declaration: target.declaration }
    : undefined;
}

/** Explicit compatibility boundary for consumers that still require flat names. */
export function projectIrIdentityImportedFunctionResolverToLegacy(
  resolver: IrIdentityImportedFunctionResolver,
): IrImportedFunctionResolver {
  return {
    resolveImportedFunction(node) {
      const target = resolver.resolveImportedFunctionTarget(node);
      return target ? projectIrIdentityImportedTargetToLegacy(target) : undefined;
    },
    resolveTopLevelFunctionValue(node) {
      const target = resolver.resolveTopLevelFunctionValueTarget(node);
      return target ? projectIrIdentityImportedTargetToLegacy(target) : undefined;
    },
    isImportBinding: (node) => resolver.isImportBinding(node),
  };
}

function planningInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

interface ValidatedIdentitySources {
  readonly targetUnitIdByDeclaration: ReadonlyMap<ts.FunctionDeclaration, IrUnitId>;
  assertActiveSource(sourceFile: ts.SourceFile): void;
}

function validateIdentitySources(
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): ValidatedIdentitySources {
  const activeSourceIds = new Set<IrSourceId>();
  const activeSourceFiles = new Set<ts.SourceFile>();
  const sourceIdByFile = new Map<ts.SourceFile, IrSourceId>();
  const targetUnitIdByDeclaration = new Map<ts.FunctionDeclaration, IrUnitId>();
  const expectedTopLevelIdsBySourceId = new Map<IrSourceId, IrUnitId[]>();
  for (const unit of identityContext.inventory.allUnits) {
    // These are the two inventory-authored kinds used for executable
    // top-level FunctionDeclarations. Do not derive expected membership from
    // the mutable AST node's current body/parent fields.
    if (unit.kind !== "top-level-function" && !(unit.kind === "synthetic-support" && unit.lexicalOwnerId === null))
      continue;
    const ids = expectedTopLevelIdsBySourceId.get(unit.sourceId) ?? [];
    ids.push(unit.id);
    expectedTopLevelIdsBySourceId.set(unit.sourceId, ids);
  }

  const validateSourcePopulation = (sourceFile: ts.SourceFile, sourceId: IrSourceId): void => {
    const currentIds: IrUnitId[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement)) continue;
      const unitId = identityContext.unitIdByDeclaration.get(statement);
      if (!statement.body) {
        if (unitId !== undefined) {
          planningInvariant(
            "unit-record-mismatch",
            `imported-function unit ${unitId} no longer has its inventoried executable body`,
          );
        }
        continue;
      }
      const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
      if (
        unitId === undefined ||
        !unit ||
        unit.sourceId !== sourceId ||
        identityContext.declarationByUnitId.get(unitId) !== statement
      ) {
        planningInvariant(
          "missing-unit-declaration",
          `imported-function source ${sourceFile.fileName} contains an unindexed executable function`,
        );
      }
      currentIds.push(unitId);
      targetUnitIdByDeclaration.set(statement, unitId);
    }

    const expectedIds = expectedTopLevelIdsBySourceId.get(sourceId) ?? [];
    if (currentIds.length !== expectedIds.length || currentIds.some((unitId, index) => unitId !== expectedIds[index])) {
      planningInvariant(
        "unit-record-mismatch",
        `imported-function source ${sourceFile.fileName} no longer matches its authoritative function population`,
      );
    }
  };

  for (const sourceFile of sourceFiles) {
    const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
    if (
      activeSourceFiles.has(sourceFile) ||
      activeSourceIds.has(sourceId) ||
      identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile
    ) {
      planningInvariant(
        "duplicate-source-file",
        `imported-function source ${sourceFile.fileName} occurs more than once`,
      );
    }
    activeSourceFiles.add(sourceFile);
    activeSourceIds.add(sourceId);
    sourceIdByFile.set(sourceFile, sourceId);
    validateSourcePopulation(sourceFile, sourceId);
  }

  return {
    targetUnitIdByDeclaration,
    assertActiveSource(sourceFile) {
      const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
      if (!activeSourceFiles.has(sourceFile) || sourceIdByFile.get(sourceFile) !== sourceId) {
        planningInvariant(
          "source-record-mismatch",
          `source ${sourceFile.fileName} is outside the active imported-function population`,
        );
      }
    },
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

function canonicalTargetName(declaration: ts.FunctionDeclaration): string | undefined {
  if (declaration.name) return declaration.name.text;
  return hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ? "default" : undefined;
}

function importClauseOfSpecifier(specifier: ts.ImportSpecifier): ts.ImportClause | undefined {
  const named = specifier.parent;
  const clause = named.parent;
  return ts.isImportClause(clause) ? clause : undefined;
}

function isAnyImportDeclaration(node: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node)
  );
}

function isSupportedValueImportDeclaration(node: ts.Declaration): boolean {
  if (ts.isImportSpecifier(node)) {
    const clause = importClauseOfSpecifier(node);
    return node.isTypeOnly !== true && clause?.isTypeOnly !== true;
  }
  // The symbol for a default import is declared on its ImportClause.
  if (ts.isImportClause(node)) return !!node.name && node.isTypeOnly !== true;
  return false;
}

/**
 * Build one realm-wide resolver over the exact source set compileMulti will
 * emit.  Targets outside this set (package imports, declaration files, ambient
 * declarations) are external even when the TypeChecker can see their symbol.
 */
export function makeIrImportedFunctionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): IrImportedFunctionResolver;
export function makeIrImportedFunctionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): IrIdentityImportedFunctionResolver;
export function makeIrImportedFunctionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identityContext?: IrPlanningIdentityContext,
): IrImportedFunctionResolver | IrIdentityImportedFunctionResolver {
  const identitySources = identityContext ? validateIdentitySources(sourceFiles, identityContext) : undefined;
  const sourceSet = new Set(sourceFiles);

  // funcMap remains keyed by a flat canonical name.  More than one body with
  // the same key is therefore ambiguous for symbolic IR lowering, even when
  // TypeScript's module namespace would otherwise distinguish them.
  const canonicalNameCounts = new Map<string, number>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
      const name = canonicalTargetName(statement);
      if (name) canonicalNameCounts.set(name, (canonicalNameCounts.get(name) ?? 0) + 1);
    }
  }

  const deAlias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!symbol) return undefined;
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; depth < 32 && current.flags & ts.SymbolFlags.Alias; depth++) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      try {
        const next = checker.getAliasedSymbol(current);
        if (!next || next === current) return undefined;
        current = next;
      } catch {
        return undefined;
      }
    }
    return current.flags & ts.SymbolFlags.Alias ? undefined : current;
  };

  // Live/reassigned function bindings cannot be represented by a cached ref to
  // the original funcIdx.  Record canonical symbols, not text, so shadowed
  // locals and same-named declarations in different modules do not poison one
  // another.
  const reassigned = new Set<ts.Symbol>();
  const noteSymbolWrite = (candidate: ts.Symbol | undefined): void => {
    const symbol = deAlias(candidate);
    if (symbol && (symbol.declarations ?? []).some(ts.isFunctionDeclaration)) reassigned.add(symbol);
  };
  const noteWrite = (identifier: ts.Identifier): void => {
    try {
      noteSymbolWrite(checker.getSymbolAtLocation(identifier));
    } catch {
      // An unresolved write has no exact symbol that can safely be recorded.
    }
  };
  const scanAssignmentTargetWrites = (target: ts.Expression): void => {
    while (
      ts.isParenthesizedExpression(target) ||
      ts.isAsExpression(target) ||
      ts.isTypeAssertionExpression(target) ||
      ts.isSatisfiesExpression(target) ||
      ts.isNonNullExpression(target)
    ) {
      target = target.expression;
    }

    if (ts.isIdentifier(target)) {
      noteWrite(target);
      return;
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Destructuring defaults write only their left-hand target.  The default
      // expression is a read/evaluation and must not poison same-named symbols.
      scanAssignmentTargetWrites(target.left);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        scanAssignmentTargetWrites(ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          // getSymbolAtLocation(property.name) is the synthetic object-property
          // symbol; the checker API below returns the actual assignment target.
          try {
            noteSymbolWrite(checker.getShorthandAssignmentValueSymbol(property));
          } catch {
            // See noteWrite: an unresolved shorthand cannot certify a target.
          }
        } else if (ts.isPropertyAssignment(property)) {
          scanAssignmentTargetWrites(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          scanAssignmentTargetWrites(property.expression);
        }
      }
    }
    // Property/element accesses write a member, not an identifier binding.
  };
  const scanBindingNameWrites = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      noteWrite(name);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) scanBindingNameWrites(element.name);
    }
  };
  const scanWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      scanAssignmentTargetWrites(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      scanAssignmentTargetWrites(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        // A declaration usually introduces a distinct loop binding, but a
        // same-scope `var` may merge with and overwrite a function declaration.
        // Symbol comparison in noteWrite distinguishes those cases.
        for (const declaration of node.initializer.declarations) scanBindingNameWrites(declaration.name);
      } else {
        scanAssignmentTargetWrites(node.initializer);
      }
    }
    ts.forEachChild(node, scanWrites);
  };
  for (const sourceFile of sourceFiles) scanWrites(sourceFile);

  interface ResolvedTarget {
    readonly targetName: string;
    readonly declaration: ts.FunctionDeclaration;
    readonly legacyProjection: IrImportedTargetLegacyProjection;
  }

  const targetForSymbol = (symbol: ts.Symbol | undefined): ResolvedTarget | undefined => {
    const target = deAlias(symbol);
    if (!target || reassigned.has(target)) return undefined;
    const declarations = target.declarations ?? [];
    const functions = declarations.filter(ts.isFunctionDeclaration);
    // Overload sets and declaration merging are outside this exact slice.  A
    // single implementation plus one or more overload signatures is still an
    // overload set, so require exactly one FunctionDeclaration total.
    if (functions.length !== 1) return undefined;
    const declaration = functions[0]!;
    if (
      !declaration.body ||
      declaration.getSourceFile().isDeclarationFile ||
      !sourceSet.has(declaration.getSourceFile()) ||
      hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)
    ) {
      return undefined;
    }
    // A different valueDeclaration means the symbol is merged/ambiguous even
    // when only one FunctionDeclaration happened to appear in declarations.
    if (target.valueDeclaration && target.valueDeclaration !== declaration) return undefined;
    const targetName = canonicalTargetName(declaration);
    if (!targetName) return undefined;
    return {
      targetName,
      declaration,
      legacyProjection: canonicalNameCounts.get(targetName) === 1 ? "unambiguous" : "ambiguous",
    };
  };

  const symbolAt = (node: ts.Identifier): ts.Symbol | undefined => {
    try {
      return checker.getSymbolAtLocation(node);
    } catch {
      return undefined;
    }
  };

  const importDeclarations = (node: ts.Identifier): readonly ts.Declaration[] => symbolAt(node)?.declarations ?? [];

  const resolveImportedFunction = (node: ts.Identifier): ResolvedTarget | undefined => {
    const symbol = symbolAt(node);
    if (!symbol) return undefined;
    const declarations = symbol.declarations ?? [];
    // Namespace imports, import-equals, type-only imports, and identifiers
    // that merely happen to share an imported name are never direct-call
    // evidence.
    if (!declarations.some(isSupportedValueImportDeclaration)) return undefined;
    if (declarations.some((d) => isAnyImportDeclaration(d) && !isSupportedValueImportDeclaration(d))) {
      return undefined;
    }
    return targetForSymbol(symbol);
  };

  const resolveTopLevelFunctionValue = (node: ts.Identifier): ResolvedTarget | undefined => {
    const target = targetForSymbol(symbolAt(node));
    if (!target) return undefined;
    const sourceFile = node.getSourceFile();
    if (target.declaration.getSourceFile() !== sourceFile) return undefined;
    if (!sourceFile.statements.some((statement) => statement === target.declaration)) return undefined;
    return target;
  };

  if (identitySources) {
    const attachIdentity = (target: ResolvedTarget | undefined): IrIdentityResolvedFunctionTarget | undefined => {
      if (!target) return undefined;
      const targetSource = target.declaration.getSourceFile();
      identitySources.assertActiveSource(targetSource);
      // (#4028) `targetUnitIdByDeclaration` is populated ONLY from
      // `sourceFile.statements`, i.e. TOP-LEVEL FunctionDeclarations — that is
      // the population the unit inventory authors. `targetForSymbol`, however,
      // accepts any bodied non-ambient FunctionDeclaration in the source set,
      // including one NESTED inside a function expression. So a nested
      // declaration was admitted as a direct-call target that the inventory can
      // never own, and the missing lookup was reported as an invariant
      // violation that aborted the whole compile.
      //
      // `resolveTopLevelFunctionValue` already re-checks top-level membership
      // for its own path; the imported path did not. This restores the
      // symmetry at the identity boundary, where the inventory's scope is known.
      //
      // Real-world impact: `imurmurhash` declares `function MurmurHash3(…)`
      // inside an IIFE — the ordinary UMD shape — so ESLint's dependency graph
      // hard-failed with "imported target MurmurHash3 has no exact structural
      // unit identity".
      //
      // Out of the inventory's scope is NOT an invariant violation: returning
      // `undefined` means "not direct-call evidence", the same supported
      // outcome every other guard in this resolver produces, and the call
      // lowers through the ordinary (non-direct) path.
      const isTopLevelInSource = targetSource.statements.some((statement) => statement === target.declaration);
      if (!isTopLevelInSource) return undefined;
      const targetUnitId = identitySources.targetUnitIdByDeclaration.get(target.declaration);
      if (targetUnitId === undefined) {
        // A TOP-LEVEL declaration missing from the map is a genuine desync
        // between the inventory and the live AST — keep hard-failing that.
        return planningInvariant(
          "missing-planning-owner",
          `imported target ${target.targetName} has no exact structural unit identity`,
        );
      }
      return { targetUnitId, ...target };
    };

    return {
      resolveImportedFunctionTarget(node) {
        identitySources.assertActiveSource(node.getSourceFile());
        return attachIdentity(resolveImportedFunction(node));
      },
      resolveTopLevelFunctionValueTarget(node) {
        identitySources.assertActiveSource(node.getSourceFile());
        return attachIdentity(resolveTopLevelFunctionValue(node));
      },
      isImportBinding(node) {
        identitySources.assertActiveSource(node.getSourceFile());
        return importDeclarations(node).some(isAnyImportDeclaration);
      },
    };
  }

  const projectLegacy = (target: ResolvedTarget | undefined): IrResolvedFunctionTarget | undefined =>
    target?.legacyProjection === "unambiguous"
      ? { targetName: target.targetName, declaration: target.declaration }
      : undefined;
  return {
    resolveImportedFunction: (node) => projectLegacy(resolveImportedFunction(node)),
    resolveTopLevelFunctionValue: (node) => projectLegacy(resolveTopLevelFunctionValue(node)),
    isImportBinding(node) {
      return importDeclarations(node).some(isAnyImportDeclaration);
    },
  };
}

/** Explicit structural factory; the three-argument overload above is equivalent. */
export function makeIrIdentityImportedFunctionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): IrIdentityImportedFunctionResolver {
  return makeIrImportedFunctionResolver(checker, sourceFiles, identityContext);
}
