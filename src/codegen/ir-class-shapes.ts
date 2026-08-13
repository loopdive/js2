// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { boundedPreparedNestedOrdinaryClassBindingName } from "../ir/class-accessor-safety.js";
import type { TypeOracle } from "../checker/oracle.js";
import { irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrClassId, IrSourceId, IrUnitKind } from "../ir/identity.js";
import type { IrClassShape, IrFuncRef } from "../ir/nodes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";

export interface IrClassShapeDeclaration {
  readonly classId: IrClassId;
  readonly legacyName: string;
  readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
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

/** Project one exact class-owned source callable into a symbolic IR target. */
export function projectIrClassCallableTarget(
  context: IrPlanningIdentityContext,
  classId: IrClassId,
  declaration: ts.Node,
  expectedKind: IrUnitKind,
  compatibilityName: string,
): IrFuncRef | undefined {
  const unitId = context.unitIdByDeclaration.get(declaration);
  const unit = unitId === undefined ? undefined : context.unitByUnitId.get(unitId);
  return unit &&
    unit.kind === expectedKind &&
    unit.lexicalOwnerId === classId &&
    context.declarationByUnitId.get(unit.id) === declaration
    ? irUnitFuncRef({ unitId: unit.id, name: compatibilityName })
    : undefined;
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
  declaration: ts.ClassDeclaration | ts.ClassExpression,
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
  const sourceId = requireExactSource(sourceFile, context);
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
  const selected = local.filter(({ legacyName }) => occurrences.get(legacyName) === 1);
  const selectedIds = new Set(selected.map(({ classId }) => classId));
  const nestedTerminalClassIds = new Set(
    context.inventory.terminalUnits
      .filter(
        (terminal) => terminal.observedKind === "class-member" && terminal.containingTerminalOwnerId !== undefined,
      )
      .map((terminal) => terminal.lexicalOwnerId as IrClassId),
  );
  for (const record of context.inventory.classes) {
    if (record.sourceId !== sourceId || !nestedTerminalClassIds.has(record.id)) {
      continue;
    }
    const declaration = context.declarationByClassId.get(record.id);
    if (!declaration || requireIrClassShapeClassId(declaration, context) !== record.id) {
      return invariant("class-record-mismatch", `nested class ${record.id} has no exact declaration`);
    }
    if (!selectedIds.has(record.id)) {
      selected.push({ classId: record.id, legacyName: record.displayName, declaration });
      selectedIds.add(record.id);
    }
  }
  return selected;
}

function hasModifier(
  node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> },
  kind: ts.SyntaxKind,
): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function hasFixedClassShapeParameters(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.every(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined &&
      parameter.initializer === undefined,
  );
}

/**
 * Order exact class-shape candidates so every acyclic, local class type used by
 * a shape position is projected before its consumer. TypeScript permits a type
 * annotation to reference a later declaration; the legacy struct registry is
 * already complete before IR planning, so source-order projection was an
 * accidental restriction rather than an ABI constraint.
 *
 * Dependencies are identity-based and local to the candidate population.
 * Cycles deliberately retain their original order. The descriptor builder
 * resolves them through preallocated exact class-shape cells; stable residue
 * order keeps planning deterministic without pretending a cycle is a DAG.
 */
export function orderIrClassShapeDeclarationsForProjection(
  oracle: TypeOracle,
  declarations: readonly IrClassShapeDeclaration[],
  context: IrPlanningIdentityContext,
): readonly IrClassShapeDeclaration[] {
  const byClassId = new Map(declarations.map((entry) => [entry.classId, entry] as const));
  const sourcePosition = new Map(declarations.map((entry, index) => [entry.classId, index] as const));
  const dependencies = new Map<IrClassId, Set<IrClassId>>();

  for (const entry of declarations) {
    const required = new Set<IrClassId>();
    const addTypeNode = (typeNode: ts.TypeNode | undefined): void => {
      if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return;
      const declaration = oracle
        .declarationsOf(typeNode.typeName)
        .find((candidate): candidate is ts.ClassDeclaration => ts.isClassDeclaration(candidate));
      const dependency = declaration === undefined ? undefined : context.classIdByDeclaration.get(declaration);
      if (dependency !== undefined && dependency !== entry.classId && byClassId.has(dependency)) {
        required.add(dependency);
      }
    };

    // A derived descriptor consumes its exact parent shape in addition to its
    // annotated member types. Keep the source-authoritative earlier-parent
    // policy in buildIrClassShapes, but order an admitted parent before its
    // child so implicit constructor forwarding never observes an unpopulated
    // provisional cell.
    const heritage = entry.declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
    const parentExpression = heritage?.types[0]?.expression;
    if (parentExpression) {
      const parentDeclarations = oracle.declarationsOf(parentExpression);
      if (parentDeclarations.length === 1) {
        const parentDeclaration = parentDeclarations[0];
        if (
          parentDeclaration &&
          (ts.isClassDeclaration(parentDeclaration) || ts.isClassExpression(parentDeclaration))
        ) {
          const dependency = context.classIdByDeclaration.get(parentDeclaration);
          if (dependency !== undefined && dependency !== entry.classId && byClassId.has(dependency)) {
            required.add(dependency);
          }
        }
      }
    }

    for (const member of entry.declaration.members) {
      if (ts.isConstructorDeclaration(member)) {
        if (hasFixedClassShapeParameters(member.parameters)) {
          for (const parameter of member.parameters) addTypeNode(parameter.type);
        }
        continue;
      }
      if (ts.isPropertyDeclaration(member)) {
        if (
          !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
          (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
        ) {
          addTypeNode(member.type);
        }
        continue;
      }
      if (ts.isMethodDeclaration(member)) {
        if (
          !ts.isIdentifier(member.name) ||
          member.asteriskToken ||
          hasModifier(member, ts.SyntaxKind.AbstractKeyword) ||
          !hasFixedClassShapeParameters(member.parameters)
        ) {
          continue;
        }
        for (const parameter of member.parameters) addTypeNode(parameter.type);
        addTypeNode(member.type);
        continue;
      }
      if (ts.isGetAccessorDeclaration(member)) {
        addTypeNode(member.type);
        continue;
      }
      if (ts.isSetAccessorDeclaration(member) && member.parameters.length === 1) {
        const parameter = member.parameters[0]!;
        if (hasFixedClassShapeParameters([parameter])) addTypeNode(parameter.type);
      }
    }
    dependencies.set(entry.classId, required);
  }

  const dependents = new Map<IrClassId, Set<IrClassId>>();
  const remaining = new Map<IrClassId, number>();
  for (const entry of declarations) {
    const required = dependencies.get(entry.classId) ?? new Set<IrClassId>();
    remaining.set(entry.classId, required.size);
    for (const dependency of required) {
      const consumers = dependents.get(dependency) ?? new Set<IrClassId>();
      consumers.add(entry.classId);
      dependents.set(dependency, consumers);
    }
  }

  const ready = declarations.filter((entry) => remaining.get(entry.classId) === 0);
  const ordered: IrClassShapeDeclaration[] = [];
  const emitted = new Set<IrClassId>();
  while (ready.length > 0) {
    ready.sort((left, right) => sourcePosition.get(left.classId)! - sourcePosition.get(right.classId)!);
    const entry = ready.shift()!;
    if (emitted.has(entry.classId)) continue;
    emitted.add(entry.classId);
    ordered.push(entry);
    for (const dependent of dependents.get(entry.classId) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(byClassId.get(dependent)!);
    }
  }

  // A non-empty residue is an exact class-type cycle. Retain its declaration
  // order so the existing shape builder refuses it without inventing mutable
  // placeholders or weakening prepare-before-emit immutability.
  for (const entry of declarations) {
    if (!emitted.has(entry.classId)) ordered.push(entry);
  }
  return ordered;
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
  // A bounded nested class expression keeps its synthetic legacy callable and
  // struct label, but source expressions address it through the exact const
  // binding. Publish that binding as a selector/lowerer alias only when it is
  // unique and cannot shadow an existing class label.
  const boundedExpressionAliases = new Map<string, IrClassShapeEntry[]>();
  for (const entry of byClassId.values()) {
    if (!ts.isClassExpression(entry.declaration)) continue;
    const bindingName = boundedPreparedNestedOrdinaryClassBindingName(entry.declaration);
    if (bindingName === undefined) continue;
    const candidates = boundedExpressionAliases.get(bindingName) ?? [];
    candidates.push(entry);
    boundedExpressionAliases.set(bindingName, candidates);
  }
  for (const [bindingName, candidates] of boundedExpressionAliases) {
    if (candidates.length === 1 && !legacyProjection.has(bindingName)) {
      legacyProjection.set(bindingName, candidates[0]!.shape);
    }
  }
  return { identityContext: context, byClassId, legacyProjection };
}
