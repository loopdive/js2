// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrClassId, IrSourceId } from "../ir/identity.js";
import type { IrClassShape } from "../ir/nodes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";

export interface IrClassShapeDeclaration {
  readonly classId: IrClassId;
  readonly legacyName: string;
  readonly declaration: ts.ClassDeclaration;
}

export interface IrClassShapeEntry extends IrClassShapeDeclaration {
  readonly shape: IrClassShape;
}

export interface IrClassShapeLookup {
  readonly identityContext: IrPlanningIdentityContext;
  readonly byClassId: ReadonlyMap<IrClassId, IrClassShapeEntry>;
}

/** Exact registry plus the deliberately lossy adapter for name-keyed legacy APIs. */
export interface IrClassShapeSidecar extends IrClassShapeLookup {
  readonly legacyProjection: ReadonlyMap<string, IrClassShape>;
}

function invariant(code: "source-record-mismatch" | "class-record-mismatch", detail: string): never {
  throw new IrPlanningIdentityInvariantError(code, `IR class-shape identity: ${detail}`);
}

function requireExactSource(sourceFile: ts.SourceFile, context: IrPlanningIdentityContext): IrSourceId {
  const sourceId = requireIrPlanningSourceId(context, sourceFile);
  const record = context.inventory.sources.find((candidate) => candidate.id === sourceId);
  if (
    context.sourceFileBySourceId.get(sourceId) !== sourceFile ||
    !record ||
    record.originalFileName !== sourceFile.fileName
  ) {
    return invariant(
      "source-record-mismatch",
      `source ${sourceFile.fileName} does not resolve bidirectionally to ${sourceId}`,
    );
  }
  return sourceId;
}

/** Validate one declaration against the authoritative bidirectional class population. */
export function requireIrClassShapeClassId(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  context: IrPlanningIdentityContext,
): IrClassId {
  const sourceFile = declaration.getSourceFile();
  const sourceId = context.sourceIdBySourceFile.get(sourceFile);
  if (sourceId === undefined || context.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return invariant("source-record-mismatch", `class declaration comes from stale source ${sourceFile.fileName}`);
  }
  const classId = context.classIdByDeclaration.get(declaration);
  const record = context.inventory.classes.find((candidate) => candidate.id === classId);
  if (
    classId === undefined ||
    context.declarationByClassId.get(classId) !== declaration ||
    !record ||
    record.sourceId !== sourceId ||
    record.declarationKind !== (ts.isClassDeclaration(declaration) ? "declaration" : "expression") ||
    record.declarationStart !== declaration.getStart(sourceFile) ||
    record.declarationEnd !== declaration.end
  ) {
    return invariant(
      "class-record-mismatch",
      `class ${declaration.name?.text ?? "<anonymous>"} is not its exact authoritative declaration`,
    );
  }
  return classId;
}

function isStalePlanningSource(sourceFile: ts.SourceFile, context: IrPlanningIdentityContext): boolean {
  return context.inventory.sources.some((record) => record.originalFileName === sourceFile.fileName);
}

function classIdForSymbolDeclaration(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  context: IrPlanningIdentityContext,
): IrClassId | undefined {
  const sourceFile = declaration.getSourceFile();
  if (!context.sourceIdBySourceFile.has(sourceFile)) {
    if (isStalePlanningSource(sourceFile, context)) {
      return invariant("source-record-mismatch", `checker resolved a stale class source ${sourceFile.fileName}`);
    }
    return undefined;
  }
  return requireIrClassShapeClassId(declaration, context);
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exactClassIdFromSymbols(
  checker: ts.TypeChecker,
  symbols: readonly (ts.Symbol | undefined)[],
  context: IrPlanningIdentityContext,
): IrClassId | undefined {
  const classIds = new Set<IrClassId>();
  const seenSymbols = new Set<ts.Symbol>();
  for (const candidate of symbols) {
    if (!candidate) continue;
    const symbol = canonicalSymbol(checker, candidate);
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) continue;
      const classId = classIdForSymbolDeclaration(declaration, context);
      if (classId !== undefined) classIds.add(classId);
    }
  }
  return classIds.size === 1 ? classIds.values().next().value : undefined;
}

/** Resolve a TypeReference through checker declarations, never through its spelling. */
export function resolveIrClassTypeReferenceId(
  checker: ts.TypeChecker,
  node: ts.TypeReferenceNode,
  context: IrPlanningIdentityContext,
): IrClassId | undefined {
  const type = checker.getTypeFromTypeNode(node);
  return exactClassIdFromSymbols(
    checker,
    [checker.getSymbolAtLocation(node.typeName), type.aliasSymbol, type.getSymbol()],
    context,
  );
}

/** Resolve a checker Type through its exact class declaration(s). */
export function resolveIrClassTypeId(
  checker: ts.TypeChecker,
  type: ts.Type,
  context: IrPlanningIdentityContext,
): IrClassId | undefined {
  return exactClassIdFromSymbols(checker, [type.aliasSymbol, type.getSymbol()], context);
}

/** `null` means no extends clause; `undefined` means an unsupported/non-class parent. */
export function resolveIrParentClassId(
  checker: ts.TypeChecker,
  declaration: ts.ClassDeclaration,
  context: IrPlanningIdentityContext,
): IrClassId | null | undefined {
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = heritage?.types[0]?.expression;
  if (!expression) return null;
  const type = checker.getTypeAtLocation(expression);
  return exactClassIdFromSymbols(
    checker,
    [checker.getSymbolAtLocation(expression), type.aliasSymbol, type.getSymbol()],
    context,
  );
}

export function resolveIrClassShapeFromTypeReference(
  checker: ts.TypeChecker,
  node: ts.TypeReferenceNode,
  lookup: IrClassShapeLookup,
): IrClassShapeEntry | undefined {
  const classId = resolveIrClassTypeReferenceId(checker, node, lookup.identityContext);
  return classId === undefined ? undefined : lookup.byClassId.get(classId);
}

export function resolveIrClassShapeFromType(
  checker: ts.TypeChecker,
  type: ts.Type,
  lookup: IrClassShapeLookup,
): IrClassShapeEntry | undefined {
  const classId = resolveIrClassTypeId(checker, type, lookup.identityContext);
  return classId === undefined ? undefined : lookup.byClassId.get(classId);
}

/**
 * Collect eligible top-level declarations in source order. Any legacy label
 * repeated in any tracked source is omitted: the name-keyed registries cannot
 * prove which declaration their value describes.
 */
export function collectIrClassShapeDeclarations(
  sourceFile: ts.SourceFile,
  context: IrPlanningIdentityContext,
): readonly IrClassShapeDeclaration[] {
  requireExactSource(sourceFile, context);
  const occurrences = new Map<string, number>();
  const local: IrClassShapeDeclaration[] = [];
  const authoritativeBySource = new Map<ts.SourceFile, ts.ClassDeclaration[]>();
  for (const record of context.inventory.classes) {
    if (record.declarationKind !== "declaration" || record.lexicalOwnerId !== null) continue;
    const declaration = context.declarationByClassId.get(record.id);
    if (!declaration || !ts.isClassDeclaration(declaration) || !declaration.name) continue;
    const trackedSource = context.sourceFileBySourceId.get(record.sourceId);
    const legacyName = declaration.name.text;
    if (
      !trackedSource ||
      declaration.parent !== trackedSource ||
      requireIrClassShapeClassId(declaration, context) !== record.id ||
      record.displayName !== legacyName
    ) {
      return invariant("class-record-mismatch", `class ${record.id} is not its exact top-level declaration`);
    }
    const authoritative = authoritativeBySource.get(trackedSource) ?? [];
    authoritative.push(declaration);
    authoritativeBySource.set(trackedSource, authoritative);
    occurrences.set(legacyName, (occurrences.get(legacyName) ?? 0) + 1);
    if (trackedSource === sourceFile) local.push({ classId: record.id, legacyName, declaration });
  }
  for (const sourceRecord of context.inventory.sources) {
    const trackedSource = context.sourceFileBySourceId.get(sourceRecord.id);
    if (!trackedSource) {
      return invariant("source-record-mismatch", `source ${sourceRecord.id} has no authoritative AST`);
    }
    const current = trackedSource.statements.filter(
      (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name !== undefined,
    );
    const authoritative = authoritativeBySource.get(trackedSource) ?? [];
    if (
      current.length !== authoritative.length ||
      current.some((declaration, index) => declaration !== authoritative[index])
    ) {
      return invariant(
        "class-record-mismatch",
        `source ${sourceRecord.id} no longer retains its exact top-level class population`,
      );
    }
  }
  return local.filter(({ legacyName }) => occurrences.get(legacyName) === 1);
}

/** Create the only name-keyed class-shape view, omitting every ambiguous label. */
export function createIrClassShapeSidecar(
  entries: ReadonlyMap<IrClassId, IrClassShapeEntry>,
  context: IrPlanningIdentityContext,
): IrClassShapeSidecar {
  const byClassId = new Map<IrClassId, IrClassShapeEntry>();
  const occurrences = new Map<string, number>();
  for (const [classId, entry] of entries) {
    const exactId = requireIrClassShapeClassId(entry.declaration, context);
    if (
      classId !== entry.classId ||
      classId !== exactId ||
      entry.shape.classId !== classId ||
      entry.shape.className !== entry.legacyName
    ) {
      invariant("class-record-mismatch", `class-shape entry ${classId} has a stale identity projection`);
    }
    byClassId.set(classId, entry);
    occurrences.set(entry.legacyName, (occurrences.get(entry.legacyName) ?? 0) + 1);
  }
  const legacyProjection = new Map<string, IrClassShape>();
  for (const entry of byClassId.values()) {
    if (occurrences.get(entry.legacyName) === 1) legacyProjection.set(entry.legacyName, entry.shape);
  }
  return { identityContext: context, byClassId, legacyProjection };
}
