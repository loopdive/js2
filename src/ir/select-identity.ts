// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts, forEachChild } from "../ts-api.js";
import type { IrClassId, IrSourceId, IrTerminalUnitRecord, IrUnitId, IrUnitRecord } from "./identity.js";
import { collectModuleInitPopulation } from "./module-init.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";
import type { IrUnitTypeMap, TypeMap, TypeMapEntry } from "./propagate.js";
import type { IrRecursiveTypeEvidence } from "./type-evidence.js";
import type { IrClassMethodDescriptor } from "./nodes.js";
import {
  boundedPreparedNestedOrdinaryClassBindingName,
  exactPreparedAccessorSyntaxKey,
  isBoundedPreparedAccessorClass,
  isBoundedPreparedNestedOrdinaryClass,
} from "./class-accessor-safety.js";
import {
  assessIrImplicitConstructorSubject,
  assessIrStructuralSelectorSubject,
  assessModuleInit,
  buildLocalCallGraph,
  classElementIsStatic,
  configureIrStructuralSelectorPredicates,
  extendsParentName,
  localClassHasKnownProjectionGap,
  phase1MemberName,
  referencesSuper,
  type IrFallback,
  type IrFallbackReason,
  type IrSelection,
  type IrSelectionOptions,
  type IrStructuralSelectorAccessorAbiEvidence,
} from "./select.js";

interface IrIdentityUnitLabel {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly legacyMatchName: string;
}

export interface IrIdentityFunctionUnit extends IrIdentityUnitLabel {
  readonly kind: "function";
}

export interface IrIdentityClassMemberUnit extends IrIdentityUnitLabel {
  readonly kind: "class-member";
  readonly classId: IrClassId;
}

export type IrIdentitySelectionUnit = IrIdentityFunctionUnit | IrIdentityClassMemberUnit;
export type IrIdentityFunctionClaim = IrIdentityFunctionUnit;
export type IrIdentityClassMemberClaim = IrIdentityClassMemberUnit;

interface IrIdentityFallbackBase extends IrIdentityUnitLabel {
  readonly reason: IrFallbackReason;
  readonly detail?: string;
}

export interface IrIdentityFunctionFallback extends IrIdentityFallbackBase {
  readonly kind: "function";
}

export interface IrIdentityClassMemberFallback extends IrIdentityFallbackBase {
  readonly kind: "class-member";
  readonly classId: IrClassId;
}

export type IrIdentityFallback = IrIdentityFunctionFallback | IrIdentityClassMemberFallback;

export interface IrIdentityModuleInitAssessment extends IrIdentityUnitLabel {
  readonly stmtCount: number;
  readonly reason: IrFallbackReason | null;
  readonly detail?: string;
}

export interface IrIdentitySelection {
  /** Complete function/member receiving population for ambiguity-safe projection. */
  readonly units: ReadonlyMap<IrUnitId, IrIdentitySelectionUnit>;
  readonly funcs: ReadonlyMap<IrUnitId, IrIdentityFunctionClaim>;
  readonly classMembers?: ReadonlyMap<IrUnitId, IrIdentityClassMemberClaim>;
  readonly fallbacks?: ReadonlyMap<IrUnitId, IrIdentityFallback>;
  readonly localCallees?: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>;
  readonly moduleInit?: IrIdentityModuleInitAssessment;
  /** Policy needed only while projecting back through the legacy name seam. */
  readonly legacyProjection?: {
    readonly includeEmptyModuleInit: boolean;
    readonly demoteOnLegacyCaller: boolean;
  };
}

export type IrIdentitySelectionOptions = Omit<IrSelectionOptions, "recursiveTypeEvidence"> & {
  readonly recursiveTypeEvidence?: IrRecursiveTypeEvidence;
  /** Exact allocator evidence required before a promoted nested accessor may claim its body slot. */
  readonly nestedClassMemberCallableAvailable?: (unitId: IrUnitId) => boolean;
};

export interface IrLegacySelectionProjection {
  readonly selection: IrSelection;
  readonly omittedUnitIds: ReadonlySet<IrUnitId>;
}

interface IndexedFunction {
  readonly unit: IrIdentityFunctionUnit;
  readonly declaration: ts.FunctionDeclaration;
}

interface IndexedClass {
  readonly classId: IrClassId;
  readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
}

interface ImplicitConstructorSelectionContext {
  readonly identityContext: IrPlanningIdentityContext;
  readonly options: IrIdentitySelectionOptions;
  readonly localClasses: ReadonlySet<string>;
  readonly trackFallbacks: boolean;
  readonly classClaims: Map<IrUnitId, IrIdentityClassMemberClaim>;
  readonly reasons: Map<IrUnitId, IrFallbackReason>;
  readonly details: Map<IrUnitId, string>;
}

function selectImplicitConstructorClaim(
  context: ImplicitConstructorSelectionContext,
  indexed: IndexedClass,
  nestedClass: boolean,
  sameNameCandidateCount: number,
): void {
  const { declaration, classId } = indexed;
  const unitId = context.identityContext.unitIdByDeclaration.get(declaration);
  const terminal = unitId ? context.identityContext.terminalByUnitId.get(unitId) : undefined;
  if (terminal?.kind !== "class-implicit-constructor") return;

  const unit = classMemberUnit(terminal, classId);
  const assessment = assessIrImplicitConstructorSubject(declaration, context.localClasses);
  const exactClassShape = context.options.projectedClassShapesById?.get(classId);
  const className = exactClassShape?.className ?? declaration.name?.text ?? "<anonymous>";
  const projectionGap = !nestedClass && localClassHasKnownProjectionGap(className);
  const hasParent = declaration.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
  const parentName = extendsParentName(declaration);
  const parentIsLocal = parentName !== null && context.localClasses.has(parentName);
  const topLevelSourceClass =
    !nestedClass && ts.isClassDeclaration(declaration) && declaration.parent === declaration.getSourceFile();
  const boundedNestedSourceClass = nestedClass && isBoundedPreparedNestedOrdinaryClass(declaration);
  if (
    (topLevelSourceClass || boundedNestedSourceClass) &&
    sameNameCandidateCount === 1 &&
    !projectionGap &&
    exactClassShape !== undefined &&
    (!hasParent || parentIsLocal) &&
    assessment.reason === null
  ) {
    context.classClaims.set(unit.unitId, unit);
    return;
  }
  if (!context.trackFallbacks) return;
  context.reasons.set(
    unit.unitId,
    assessment.reason ?? (projectionGap ? "class-projection-unsupported" : "class-member-unsupported"),
  );
  if (assessment.detail !== undefined) context.details.set(unit.unitId, assessment.detail);
}

function boundedNestedAccessorAbiEvidence(
  member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  descriptor: IrClassMethodDescriptor | undefined,
): IrStructuralSelectorAccessorAbiEvidence | undefined {
  if (!descriptor) return undefined;
  if (ts.isGetAccessorDeclaration(member)) {
    return descriptor.params.length === 0 && descriptor.returnType?.kind === "string"
      ? { params: [], returnType: "string" }
      : undefined;
  }
  return descriptor.params.length === 1 && descriptor.params[0]?.kind === "dynamic" && descriptor.returnType === null
    ? { params: ["dynamic"], returnType: "void" }
    : undefined;
}

function legacyCallerAbiIsProjectedForIdentity(
  options: IrIdentitySelectionOptions,
  functions: ReadonlyArray<IndexedFunction>,
  unitId: IrUnitId,
): boolean {
  const declaration = functions.find(({ unit }) => unit.unitId === unitId)?.declaration;
  return declaration !== undefined && options.legacyCallerAbiIsProjected?.(declaration) === true;
}

interface IdentityCallGraph {
  readonly callers: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>;
  readonly callees: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>;
  readonly hasExternalCall: ReadonlySet<IrUnitId>;
}

function selectorIdentityInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

function functionUnit(terminal: IrTerminalUnitRecord): IrIdentityFunctionUnit {
  return {
    kind: "function",
    unitId: terminal.id,
    displayName: terminal.displayName,
    legacyMatchName: terminal.legacyMatchName,
  };
}

function classMemberUnit(terminal: IrTerminalUnitRecord, classId: IrClassId): IrIdentityClassMemberUnit {
  return {
    kind: "class-member",
    unitId: terminal.id,
    classId,
    displayName: terminal.displayName,
    legacyMatchName: terminal.legacyMatchName,
  };
}

function requireSelectionDeclarationUnit(
  context: IrPlanningIdentityContext,
  sourceId: IrSourceId,
  declaration: ts.Node,
): IrUnitRecord {
  const unitId = context.unitIdByDeclaration.get(declaration);
  if (unitId === undefined) {
    return selectorIdentityInvariant(
      "missing-unit-declaration",
      `IR identity selector has no unit for declaration in ${declaration.getSourceFile().fileName}`,
    );
  }
  const unit = context.unitByUnitId.get(unitId);
  if (!unit || context.declarationByUnitId.get(unitId) !== declaration) {
    return selectorIdentityInvariant(
      "unit-record-mismatch",
      `IR identity selector declaration does not resolve back to exact unit ${unitId}`,
    );
  }
  if (unit.sourceId !== sourceId) {
    return selectorIdentityInvariant(
      "source-record-mismatch",
      `IR identity selector unit ${unitId} belongs to source ${unit.sourceId}, not ${sourceId}`,
    );
  }
  return unit;
}

function collectFunctions(
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  context: IrPlanningIdentityContext,
): readonly IndexedFunction[] {
  const functions: IndexedFunction[] = [];
  for (const declaration of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) continue;
    const unit = requireSelectionDeclarationUnit(context, sourceId, declaration);
    if (!unit.terminal && unit.terminalOwnerId === null) {
      if (context.terminalByUnitId.has(unit.id)) {
        selectorIdentityInvariant(
          "terminal-record-mismatch",
          `IR identity selector unowned support unit ${unit.id} appears in the terminal map`,
        );
      }
      continue;
    }
    const terminal = context.terminalByUnitId.get(unit.id);
    if (
      !unit.terminal ||
      !terminal ||
      terminal !== unit ||
      terminal.sourceId !== sourceId ||
      terminal.observedKind !== "function"
    ) {
      selectorIdentityInvariant(
        "terminal-record-mismatch",
        `IR identity selector unit ${unit.id} is not this source's exact function terminal`,
      );
    }
    functions.push({ unit: functionUnit(terminal), declaration });
  }
  const expected = context.inventory.terminalUnits.filter(
    (terminal) => terminal.sourceId === sourceId && terminal.observedKind === "function",
  );
  const actualIds = new Set(functions.map(({ unit }) => unit.unitId));
  for (const [index, terminal] of expected.entries()) {
    const declaration = context.declarationByUnitId.get(terminal.id);
    if (context.terminalByUnitId.get(terminal.id) !== terminal || context.unitByUnitId.get(terminal.id) !== terminal) {
      selectorIdentityInvariant(
        "terminal-record-mismatch",
        `IR identity selector function ${terminal.id} is not the authoritative terminal record`,
      );
    }
    if (
      functions[index]?.unit.unitId !== terminal.id ||
      !actualIds.has(terminal.id) ||
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      context.unitIdByDeclaration.get(declaration) !== terminal.id
    ) {
      selectorIdentityInvariant(
        "missing-unit-declaration",
        `IR identity selector function population is missing terminal ${terminal.id}`,
      );
    }
  }
  if (actualIds.size !== expected.length) {
    return selectorIdentityInvariant(
      "terminal-record-mismatch",
      `IR identity selector function population does not match source ${sourceId}`,
    );
  }
  return functions;
}

function collectClasses(
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  context: IrPlanningIdentityContext,
): readonly IndexedClass[] {
  const classes: IndexedClass[] = [];
  const records = new Map(context.inventory.classes.map((record) => [record.id, record]));
  for (const declaration of sourceFile.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    const classId = context.classIdByDeclaration.get(declaration);
    if (
      classId === undefined ||
      context.declarationByClassId.get(classId) !== declaration ||
      records.get(classId)?.sourceId !== sourceId
    ) {
      selectorIdentityInvariant(
        "missing-class-declaration",
        `IR identity selector has no exact class identity for ${declaration.name?.text ?? "<anonymous>"}`,
      );
    }
    classes.push({ classId, declaration });
  }
  const populatedClassIds = new Set(classes.map(({ classId }) => classId));
  const nestedClassIds = new Set(
    context.inventory.terminalUnits
      .filter(
        (terminal) =>
          terminal.sourceId === sourceId &&
          terminal.observedKind === "class-member" &&
          terminal.containingTerminalOwnerId !== undefined,
      )
      .map((terminal) => terminal.lexicalOwnerId as IrClassId),
  );
  for (const record of context.inventory.classes) {
    if (record.sourceId !== sourceId || !nestedClassIds.has(record.id) || populatedClassIds.has(record.id)) continue;
    const declaration = context.declarationByClassId.get(record.id);
    if (!declaration || context.classIdByDeclaration.get(declaration) !== record.id) {
      selectorIdentityInvariant(
        "missing-class-declaration",
        `IR identity selector has no exact nested class declaration for ${record.id}`,
      );
    }
    classes.push({ classId: record.id, declaration });
    populatedClassIds.add(record.id);
  }
  const expectedTopLevel = context.inventory.classes.filter((record) => {
    if (record.sourceId !== sourceId) return false;
    const declaration = context.declarationByClassId.get(record.id);
    return declaration?.parent === sourceFile && ts.isClassDeclaration(declaration);
  });
  const expectedIds = new Set([...expectedTopLevel.map(({ id }) => id), ...nestedClassIds]);
  if (classes.length !== expectedIds.size || classes.some(({ classId }) => !expectedIds.has(classId))) {
    return selectorIdentityInvariant(
      "missing-class-declaration",
      `IR identity selector class population does not match source ${sourceId}`,
    );
  }
  return classes;
}

function populateClassMemberUnits(
  sourceId: IrSourceId,
  classes: readonly IndexedClass[],
  context: IrPlanningIdentityContext,
  units: Map<IrUnitId, IrIdentitySelectionUnit>,
): void {
  const activeClassIds = new Set(classes.map(({ classId }) => classId));
  for (const terminal of context.inventory.terminalUnits) {
    if (terminal.sourceId !== sourceId || terminal.observedKind !== "class-member") continue;
    const classId = terminal.lexicalOwnerId as IrClassId | null;
    if (
      classId === null ||
      !activeClassIds.has(classId) ||
      context.terminalByUnitId.get(terminal.id) !== terminal ||
      context.unitByUnitId.get(terminal.id) !== terminal
    ) {
      selectorIdentityInvariant(
        "terminal-record-mismatch",
        `IR identity selector class-member ${terminal.id} has no exact source class owner`,
      );
    }
    const declaration = context.declarationByUnitId.get(terminal.id);
    if (!declaration || context.unitIdByDeclaration.get(declaration) !== terminal.id) {
      selectorIdentityInvariant(
        "missing-unit-declaration",
        `IR identity selector class-member ${terminal.id} has no exact declaration`,
      );
    }
    units.set(terminal.id, classMemberUnit(terminal, classId));
  }
}

function addNameIndex<K>(index: Map<string, K[]>, name: string, value: K): void {
  const values = index.get(name) ?? [];
  values.push(value);
  index.set(name, values);
}

function uniqueDeclarationsByName(
  functionsByName: ReadonlyMap<string, readonly IndexedFunction[]>,
): Map<string, ts.FunctionDeclaration> {
  return new Map(
    [...functionsByName]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([name, candidates]) => [name, candidates[0]!.declaration]),
  );
}

function uniqueClassDeclarationsByName(
  classesByName: ReadonlyMap<string, readonly IndexedClass[]>,
): Map<string, ts.ClassDeclaration | ts.ClassExpression> {
  return new Map(
    [...classesByName]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([name, candidates]) => [name, candidates[0]!.declaration]),
  );
}

function helperTypeMap(
  functionsByName: ReadonlyMap<string, readonly IndexedFunction[]>,
  structural: IrUnitTypeMap | undefined,
): TypeMap | undefined {
  if (!structural) return undefined;
  const projected = new Map<string, TypeMapEntry>();
  for (const [name, candidates] of functionsByName) {
    if (candidates.length !== 1) continue;
    const entry = structural.get(candidates[0]!.unit.unitId);
    if (entry) projected.set(name, entry);
  }
  return projected;
}

function exactSubjectTypeMap(
  helper: TypeMap | undefined,
  indexed: IndexedFunction,
  structural: IrUnitTypeMap | undefined,
): TypeMap | undefined {
  const name = indexed.declaration.name?.text;
  if (!name) return helper;
  const exact = structural?.get(indexed.unit.unitId);
  if (!helper && !exact) return undefined;
  const subject = new Map(helper);
  if (exact) subject.set(name, exact);
  else subject.delete(name);
  return subject;
}

function directIdentifierCallees(body: ts.Block): readonly string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.push(node.expression.text);
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return names;
}

function buildIdentityCallGraph(
  functions: readonly IndexedFunction[],
  functionsByName: ReadonlyMap<string, readonly IndexedFunction[]>,
  uniqueDeclarations: ReadonlyMap<string, ts.FunctionDeclaration>,
  localClasses: ReadonlySet<string>,
): IdentityCallGraph {
  const callers = new Map<IrUnitId, Set<IrUnitId>>();
  const callees = new Map<IrUnitId, Set<IrUnitId>>();
  const hasExternalCall = new Set<IrUnitId>();
  for (const { unit } of functions) {
    callers.set(unit.unitId, new Set());
    callees.set(unit.unitId, new Set());
  }

  const uniqueIdByName = new Map(
    [...functionsByName]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([name, candidates]) => [name, candidates[0]!.unit.unitId]),
  );
  const legacyGraph = buildLocalCallGraph(uniqueDeclarations, localClasses);
  for (const [callerName, targets] of legacyGraph.callees) {
    const callerId = uniqueIdByName.get(callerName);
    if (!callerId) continue;
    for (const targetName of targets) {
      const targetId = uniqueIdByName.get(targetName);
      if (targetId) callees.get(callerId)!.add(targetId);
    }
  }
  for (const callerName of legacyGraph.hasExternalCall) {
    const callerId = uniqueIdByName.get(callerName);
    if (callerId) hasExternalCall.add(callerId);
  }

  for (const indexed of functions) {
    const callerId = indexed.unit.unitId;
    const callerName = indexed.declaration.name?.text;
    const duplicateCaller = callerName !== undefined && (functionsByName.get(callerName)?.length ?? 0) > 1;
    for (const calleeName of directIdentifierCallees(indexed.declaration.body!)) {
      const targets = functionsByName.get(calleeName);
      if (targets) {
        for (const target of targets) callees.get(callerId)!.add(target.unit.unitId);
      } else if (duplicateCaller) {
        // The shared graph already classifies unique callers with its complete
        // import/closure/host rules. Duplicate callers have no name projection,
        // so an unknown direct target blocks them conservatively.
        hasExternalCall.add(callerId);
      }
    }
  }
  for (const [callerId, targets] of callees) {
    for (const targetId of targets) callers.get(targetId)!.add(callerId);
  }
  return { callers, callees, hasExternalCall };
}

function fallbackFor(unit: IrIdentitySelectionUnit, reason: IrFallbackReason, detail?: string): IrIdentityFallback {
  return { ...unit, reason, ...(detail === undefined ? {} : { detail }) };
}

function sourceHasModuleInitUnit(sourceFile: ts.SourceFile): boolean {
  if (collectModuleInitPopulation(sourceFile).length !== 0) return true;
  return sourceFile.statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.members.some(
        (member) =>
          ts.isClassStaticBlockDeclaration(member) ||
          (ts.isPropertyDeclaration(member) && member.initializer !== undefined && classElementIsStatic(member)),
      ),
  );
}

function requireProjectedUnit(
  structural: IrIdentitySelection,
  unitId: IrUnitId,
  candidate?: IrIdentitySelectionUnit,
): IrIdentitySelectionUnit {
  const unit = structural.units.get(unitId);
  if (
    !unit ||
    unit.unitId !== unitId ||
    (candidate !== undefined &&
      (candidate.unitId !== unitId ||
        candidate.kind !== unit.kind ||
        candidate.displayName !== unit.displayName ||
        candidate.legacyMatchName !== unit.legacyMatchName ||
        (candidate.kind === "class-member" && (unit.kind !== "class-member" || candidate.classId !== unit.classId))))
  ) {
    return selectorIdentityInvariant(
      "terminal-record-mismatch",
      `legacy selection projection has no exact population record for ${unitId}`,
    );
  }
  return unit;
}

function validateLegacyProjectionInput(structural: IrIdentitySelection): void {
  for (const [unitId, unit] of structural.units) requireProjectedUnit(structural, unitId, unit);
  for (const [unitId, claim] of structural.funcs) {
    const unit = requireProjectedUnit(structural, unitId, claim);
    if (unit.kind !== "function") {
      selectorIdentityInvariant("terminal-record-mismatch", `function claim ${unitId} is not a function unit`);
    }
  }
  for (const [unitId, claim] of structural.classMembers ?? []) {
    const unit = requireProjectedUnit(structural, unitId, claim);
    if (unit.kind !== "class-member") {
      selectorIdentityInvariant("terminal-record-mismatch", `class-member claim ${unitId} is not a member unit`);
    }
  }
  for (const [unitId, fallback] of structural.fallbacks ?? []) {
    requireProjectedUnit(structural, unitId, fallback);
  }
  for (const [callerId, calleeIds] of structural.localCallees ?? []) {
    if (requireProjectedUnit(structural, callerId).kind !== "function") {
      selectorIdentityInvariant("terminal-record-mismatch", `local caller ${callerId} is not a function unit`);
    }
    for (const calleeId of calleeIds) {
      if (requireProjectedUnit(structural, calleeId).kind !== "function") {
        selectorIdentityInvariant("terminal-record-mismatch", `local callee ${calleeId} is not a function unit`);
      }
    }
  }
}

/** Select one exact source using source-qualified unit and class identities. */
export function planIrCompilationByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  options?: IrIdentitySelectionOptions,
  typeMap?: IrUnitTypeMap,
): IrIdentitySelection {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return selectorIdentityInvariant(
      "source-record-mismatch",
      `IR identity selector source ${sourceId} does not resolve back to the exact SourceFile`,
    );
  }
  if (!options?.experimentalIR) return { units: new Map(), funcs: new Map() };

  const functions = collectFunctions(sourceFile, sourceId, identityContext);
  const functionsByName = new Map<string, IndexedFunction[]>();
  const units = new Map<IrUnitId, IrIdentitySelectionUnit>();
  for (const indexed of functions) {
    units.set(indexed.unit.unitId, indexed.unit);
    if (indexed.declaration.name) addNameIndex(functionsByName, indexed.declaration.name.text, indexed);
  }

  const classes = collectClasses(sourceFile, sourceId, identityContext);
  populateClassMemberUnits(sourceId, classes, identityContext, units);
  const classesByName = new Map<string, IndexedClass[]>();
  for (const indexed of classes) {
    if (
      indexed.declaration.parent === sourceFile &&
      ts.isClassDeclaration(indexed.declaration) &&
      indexed.declaration.name
    ) {
      addNameIndex(classesByName, indexed.declaration.name.text, indexed);
    }
  }

  const uniqueFunctions = uniqueDeclarationsByName(functionsByName);
  const projectedClassCandidates = new Map(classesByName);
  for (const candidate of classes) {
    if (candidate.declaration.parent === sourceFile) continue;
    const bindingName = boundedPreparedNestedOrdinaryClassBindingName(candidate.declaration);
    if (bindingName === undefined) continue;
    if (options.projectedClassShapesById?.has(candidate.classId) !== true) continue;
    addNameIndex(projectedClassCandidates, bindingName, candidate);
  }
  const uniqueClasses = uniqueClassDeclarationsByName(projectedClassCandidates);
  const localClasses = new Set(uniqueClasses.keys());
  const asyncUnitIds = new Set(
    functions
      .filter(
        ({ declaration }) =>
          !declaration.asteriskToken &&
          declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
      )
      .map(({ unit }) => unit.unitId),
  );
  const asyncNames = new Set(
    [...functionsByName]
      .filter(([, candidates]) => candidates.length === 1 && asyncUnitIds.has(candidates[0]!.unit.unitId))
      .map(([name]) => name),
  );
  const { recursiveTypeEvidence: _recursiveTypeEvidence, ...runtimeOptions } = options;
  configureIrStructuralSelectorPredicates(sourceFile, runtimeOptions, uniqueClasses, uniqueFunctions, asyncNames);
  const trackFallbacks = options.trackFallbacks === true;
  const reasons = new Map<IrUnitId, IrFallbackReason>();
  const details = new Map<IrUnitId, string>();
  const helperTypes = helperTypeMap(functionsByName, typeMap);
  const individuallyClaimed = new Map<IrUnitId, IrIdentityFunctionClaim>();
  for (const indexed of functions) {
    if (!indexed.declaration.name) {
      if (trackFallbacks) reasons.set(indexed.unit.unitId, "unnamed");
      continue;
    }
    const recursive = options.recursiveTypeEvidence?.decisions.get(indexed.unit.unitId);
    const assessment =
      recursive?.accepted === false
        ? { reason: "recursive-type-evidence" as const, detail: recursive.detail }
        : assessIrStructuralSelectorSubject(
            indexed.declaration,
            exactSubjectTypeMap(helperTypes, indexed, typeMap),
            localClasses,
          );
    if (assessment.reason === null) individuallyClaimed.set(indexed.unit.unitId, indexed.unit);
    else if (trackFallbacks) {
      reasons.set(indexed.unit.unitId, assessment.reason);
      if (assessment.detail !== undefined) details.set(indexed.unit.unitId, assessment.detail);
    }
  }
  const classClaims = new Map<IrUnitId, IrIdentityClassMemberClaim>();
  const implicitSelection = { identityContext, options, localClasses, trackFallbacks, classClaims, reasons, details };
  const nestedClasses = classes.filter(({ classId }) =>
    identityContext.inventory.terminalUnits.some(
      (terminal) => terminal.lexicalOwnerId === classId && terminal.containingTerminalOwnerId !== undefined,
    ),
  );
  const classGroups: readonly (readonly IndexedClass[])[] = [
    ...classesByName.values(),
    ...nestedClasses.map((candidate) => [candidate] as const),
  ];
  for (const candidates of classGroups) {
    for (const { classId, declaration } of candidates) {
      const nestedClass = nestedClasses.some((candidate) => candidate.classId === classId);
      const exactClassShape = options.projectedClassShapesById?.get(classId);
      const className = exactClassShape?.className ?? declaration.name?.text ?? "<anonymous>";
      const ambiguousClassName = !nestedClass && candidates.length !== 1;
      const projectionGap = !nestedClass && localClassHasKnownProjectionGap(className);
      const hasParent = declaration.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
      const parentName = extendsParentName(declaration);
      const parentIsLocal = parentName !== null && localClasses.has(parentName);
      const boundedAccessorClass = isBoundedPreparedAccessorClass(declaration);
      const boundedNestedOrdinaryClass = nestedClass && isBoundedPreparedNestedOrdinaryClass(declaration);
      const boundedTopLevelAccessorClass =
        !nestedClass && ts.isClassDeclaration(declaration) && declaration.parent === sourceFile && boundedAccessorClass;
      // (#3522) Arms the accessor-only WRITEBACK contract (exact syntax-key
      // descriptors + `boundedNestedAccessorAbiEvidence`: string getters,
      // `dynamic` setters). Naming that family explicitly is behaviour-
      // preserving — before accessors joined the ordinary family, a nested
      // class reaching this loop WITH an accessor was necessarily accessor-only
      // — and routes an accessor on a bounded nested ORDINARY class down the
      // ordinary descriptor-by-name-and-kind path proven at top level instead.
      const exactAccessorClass = (nestedClass && boundedAccessorClass) || boundedTopLevelAccessorClass;
      selectImplicitConstructorClaim(implicitSelection, { classId, declaration }, nestedClass, candidates.length);
      const markBoundedClassFallback = (): void => {
        if (!trackFallbacks) return;
        for (const member of declaration.members) {
          if (
            (!ts.isConstructorDeclaration(member) &&
              !ts.isMethodDeclaration(member) &&
              !ts.isGetAccessorDeclaration(member) &&
              !ts.isSetAccessorDeclaration(member)) ||
            !member.body
          ) {
            continue;
          }
          const unitId = identityContext.unitIdByDeclaration.get(member);
          if (unitId !== undefined && identityContext.terminalByUnitId.has(unitId)) {
            reasons.set(unitId, "class-member-unsupported");
          }
        }
      };
      if (nestedClass && !boundedAccessorClass && !boundedNestedOrdinaryClass) {
        markBoundedClassFallback();
        continue;
      }
      const exactAccessorDescriptors = new Map<
        ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
        IrClassMethodDescriptor
      >();
      if (exactAccessorClass) {
        const occupiedAccessorSlots = new Set<string>();
        const accessorPlacementByKey = new Map<string, boolean>();
        let hasAccessorSlotCollision = false;
        let hasAccessorPlacementCollision = false;
        let hasUnsafeComputedKey = false;
        for (const member of declaration.members) {
          if (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue;
          const unitId = identityContext.unitIdByDeclaration.get(member);
          const descriptorKind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
          const descriptors =
            unitId === undefined
              ? []
              : (exactClassShape?.methods.filter(
                  (candidate) =>
                    candidate.placement?.classId === classId &&
                    candidate.placement.unitId === unitId &&
                    candidate.placement.staticClassMember === classElementIsStatic(member) &&
                    candidate.memberKind === descriptorKind &&
                    candidate.target?.binding.kind === "unit" &&
                    candidate.target.binding.unitId === unitId,
                ) ?? []);
          const descriptor = descriptors.length === 1 ? descriptors[0] : undefined;
          const syntaxKey = exactPreparedAccessorSyntaxKey(member.name);
          if (!descriptor || syntaxKey === undefined || descriptor.name !== syntaxKey) {
            hasUnsafeComputedKey = true;
            continue;
          }
          exactAccessorDescriptors.set(member, descriptor);
          // The legacy callable slot omits static/instance from its physical
          // spelling. A second accessor with the same kind + semantic key can
          // therefore overwrite the first exact UnitId even when their static
          // flags differ. Reject the whole bounded class before any claim.
          const slot = `${descriptor.memberKind}:${descriptor.name}`;
          if (occupiedAccessorSlots.has(slot)) hasAccessorSlotCollision = true;
          occupiedAccessorSlots.add(slot);
          // Placement evidence is keyed by class + semantic property name in
          // the transitional accessor registries. Even when getter/setter
          // callable names differ, admitting the same key on both the instance
          // and static sides would let one placement classify the other's
          // dispatch. Reject the whole exact class before claiming either body.
          const staticPlacement = classElementIsStatic(member);
          const priorPlacement = accessorPlacementByKey.get(descriptor.name);
          if (priorPlacement !== undefined && priorPlacement !== staticPlacement) {
            hasAccessorPlacementCollision = true;
          }
          accessorPlacementByKey.set(descriptor.name, staticPlacement);
        }
        if (hasAccessorSlotCollision || hasAccessorPlacementCollision || hasUnsafeComputedKey) {
          markBoundedClassFallback();
          continue;
        }
      }
      const pendingBoundedClassClaims = new Map<IrUnitId, IrIdentityClassMemberClaim>();
      for (const member of declaration.members) {
        if (
          (!ts.isConstructorDeclaration(member) &&
            !ts.isMethodDeclaration(member) &&
            !ts.isGetAccessorDeclaration(member) &&
            !ts.isSetAccessorDeclaration(member)) ||
          !member.body
        ) {
          continue;
        }
        const inventoryUnit = requireSelectionDeclarationUnit(identityContext, sourceId, member);
        const terminal = identityContext.terminalByUnitId.get(inventoryUnit.id);
        if (
          !inventoryUnit.terminal ||
          !terminal ||
          terminal !== inventoryUnit ||
          terminal.observedKind !== "class-member" ||
          terminal.lexicalOwnerId !== classId
        ) {
          return selectorIdentityInvariant(
            "terminal-record-mismatch",
            `IR identity selector unit ${inventoryUnit.id} is not an exact member of class ${classId}`,
          );
        }
        const unit = classMemberUnit(terminal, classId);
        const populated = units.get(unit.unitId);
        if (!populated || populated.kind !== "class-member" || populated.classId !== classId) {
          return selectorIdentityInvariant(
            "terminal-record-mismatch",
            `IR identity selector member ${unit.unitId} disagrees with the terminal population`,
          );
        }

        if (ambiguousClassName) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-member-unsupported");
          continue;
        }

        if (ts.isMethodDeclaration(member) && (!member.name || phase1MemberName(member.name) === null)) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-method");
          continue;
        }
        if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          if (
            !member.name ||
            (!exactAccessorClass && (phase1MemberName(member.name) === null || classElementIsStatic(member)))
          ) {
            if (trackFallbacks) reasons.set(unit.unitId, "class-method");
            continue;
          }
        }

        const isStaticMethod = ts.isMethodDeclaration(member) && classElementIsStatic(member);
        let exactMemberDescriptor: IrClassMethodDescriptor | undefined;
        if (
          (options.projectedClassShapes || options.projectedClassShapesById) &&
          !ts.isConstructorDeclaration(member)
        ) {
          const descriptorName = member.name ? phase1MemberName(member.name) : null;
          const descriptorKind = ts.isMethodDeclaration(member)
            ? isStaticMethod
              ? "static"
              : "method"
            : ts.isGetAccessorDeclaration(member)
              ? "getter"
              : "setter";
          const exactAccessorMember =
            exactAccessorClass && (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member));
          const descriptors = exactAccessorMember
            ? exactAccessorDescriptors.get(member as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration)
              ? [exactAccessorDescriptors.get(member as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration)!]
              : []
            : descriptorName === null
              ? []
              : ((exactClassShape ?? options.projectedClassShapes?.get(className))?.methods.filter(
                  (candidate) =>
                    candidate.name === descriptorName &&
                    (candidate.memberKind ?? "method") === descriptorKind &&
                    (!nestedClass || candidate.placement?.classId === classId),
                ) ?? []);
          exactMemberDescriptor = descriptors.length === 1 ? descriptors[0] : undefined;
          if (!exactMemberDescriptor) {
            if (trackFallbacks) reasons.set(unit.unitId, "class-member-unsupported");
            continue;
          }
        }
        if (projectionGap && !isStaticMethod) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-projection-unsupported");
          continue;
        }
        const claimableUnderParent = isStaticMethod ? !referencesSuper(member) : parentIsLocal;
        if (hasParent && !claimableUnderParent) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-method");
          continue;
        }
        const exactAccessorEvidence =
          exactAccessorClass && (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
            ? boundedNestedAccessorAbiEvidence(member, exactMemberDescriptor)
            : undefined;
        if (
          nestedClass &&
          (boundedNestedOrdinaryClass || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
          options.nestedClassMemberCallableAvailable?.(unit.unitId) !== true
        ) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-member-unsupported");
          continue;
        }
        if (
          exactAccessorClass &&
          (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
          !exactAccessorEvidence
        ) {
          if (trackFallbacks) reasons.set(unit.unitId, "class-member-unsupported");
          continue;
        }
        const assessment = assessIrStructuralSelectorSubject(
          member,
          helperTypes,
          localClasses,
          true,
          exactAccessorEvidence,
        );
        if (assessment.reason === null) {
          if (boundedAccessorClass || boundedNestedOrdinaryClass) pendingBoundedClassClaims.set(unit.unitId, unit);
          else classClaims.set(unit.unitId, unit);
        } else if (trackFallbacks) {
          reasons.set(unit.unitId, assessment.reason);
          if (assessment.detail !== undefined) details.set(unit.unitId, assessment.detail);
        }
      }
      if (boundedAccessorClass || boundedNestedOrdinaryClass) {
        // The atom is exactly the body-bearing callables the admitting
        // predicate counted. (#3522) The ordinary family now owns its
        // accessors too; counting only ctor+methods would leave every accessor
        // claim pending, withdrawing the whole class on arrival.
        const expectedCount = declaration.members.filter((member) => {
          const isAccessor = ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
          const isOrdinary = ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member);
          if (!isAccessor && !isOrdinary) return false;
          if (member.body === undefined) return false;
          return boundedAccessorClass ? isAccessor : true;
        }).length;
        if (pendingBoundedClassClaims.size === expectedCount) {
          for (const [unitId, claim] of pendingBoundedClassClaims) classClaims.set(unitId, claim);
        } else {
          markBoundedClassFallback();
        }
      }
    }
  }

  // Ordinary nested classes are one ownership atom with their containing
  // function. Unlike the accessor-only writeback family, their constructor,
  // methods, and every call site share one exact class-layout/callable graph.
  // If any body rejects—or the enclosing function itself rejects—withdraw the
  // complete class plus owner before lowering can observe a mixed component.
  for (const { classId, declaration } of classes) {
    if (!isBoundedPreparedNestedOrdinaryClass(declaration)) continue;
    const terminals = identityContext.inventory.terminalUnits.filter(
      (terminal) =>
        terminal.lexicalOwnerId === classId &&
        terminal.observedKind === "class-member" &&
        terminal.containingTerminalOwnerId !== undefined,
    );
    if (terminals.length === 0) continue;
    const ownerUnitId = terminals[0]!.containingTerminalOwnerId!;
    const exactOwner = terminals.every((terminal) => terminal.containingTerminalOwnerId === ownerUnitId);
    const allMembersClaimed = exactOwner && terminals.every((terminal) => classClaims.has(terminal.id));
    const ownerClaimed = individuallyClaimed.has(ownerUnitId);
    if (allMembersClaimed && ownerClaimed) continue;
    for (const terminal of terminals) {
      classClaims.delete(terminal.id);
      if (trackFallbacks) reasons.set(terminal.id, "class-member-unsupported");
    }
    if (!allMembersClaimed && ownerClaimed) {
      individuallyClaimed.delete(ownerUnitId);
      if (trackFallbacks) reasons.set(ownerUnitId, "class-member-unsupported");
    }
  }

  const claimed = new Map(individuallyClaimed);
  const demoteOnLegacyCaller = options.jsHostExterns !== true;
  let localCallees: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>> | undefined;
  if (individuallyClaimed.size > 0) {
    const graph = buildIdentityCallGraph(functions, functionsByName, uniqueFunctions, localClasses);
    localCallees = graph.callees;
    for (const unitId of [...claimed.keys()]) {
      if (!graph.hasExternalCall.has(unitId)) continue;
      claimed.delete(unitId);
      if (trackFallbacks) reasons.set(unitId, "external-call");
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const unitId of [...claimed.keys()]) {
        const legacyCallerAbiIsProjected = legacyCallerAbiIsProjectedForIdentity(options, functions, unitId);
        const unsafeCaller =
          demoteOnLegacyCaller &&
          !legacyCallerAbiIsProjected &&
          [...(graph.callers.get(unitId) ?? [])].some((caller) => !claimed.has(caller));
        const unsafeCallee = [...(graph.callees.get(unitId) ?? [])].some((callee) => !claimed.has(callee));
        if (!unsafeCaller && !unsafeCallee) continue;
        claimed.delete(unitId);
        if (trackFallbacks) reasons.set(unitId, "call-graph-closure");
        changed = true;
      }
    }
  }

  const moduleInitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  const inventoryModuleInits = identityContext.inventory.terminalUnits.filter(
    (terminal) => terminal.sourceId === sourceId && terminal.observedKind === "module-init",
  );
  if (
    inventoryModuleInits.length > 1 ||
    (moduleInitId === undefined &&
      (inventoryModuleInits.length !== 0 ||
        sourceHasModuleInitUnit(sourceFile) ||
        identityContext.moduleInitUnitIdBySourceId.has(sourceId))) ||
    (inventoryModuleInits.length === 1 && !sourceHasModuleInitUnit(sourceFile)) ||
    (moduleInitId !== undefined &&
      (inventoryModuleInits.length !== 1 ||
        inventoryModuleInits[0]!.id !== moduleInitId ||
        identityContext.moduleInitUnitIdBySourceId.get(sourceId) !== moduleInitId))
  ) {
    return selectorIdentityInvariant(
      "invalid-module-init",
      `IR identity selector has no exact source-owned module-init population for ${sourceId}`,
    );
  }
  let moduleInit: IrIdentityModuleInitAssessment | undefined;
  if (moduleInitId) {
    const terminal = identityContext.terminalByUnitId.get(moduleInitId);
    if (
      !terminal ||
      terminal !== inventoryModuleInits[0] ||
      identityContext.unitByUnitId.get(moduleInitId) !== terminal ||
      terminal.sourceId !== sourceId ||
      terminal.observedKind !== "module-init"
    ) {
      return selectorIdentityInvariant(
        "invalid-module-init",
        `IR identity selector module-init ${moduleInitId} is not source-owned`,
      );
    }
    const claimedNames = new Set<string>();
    for (const [name, candidates] of functionsByName) {
      if (candidates.length === 1 && claimed.has(candidates[0]!.unit.unitId)) claimedNames.add(name);
    }
    const assessment = assessModuleInit(sourceFile, claimedNames, uniqueFunctions, localClasses);
    moduleInit = {
      unitId: moduleInitId,
      displayName: terminal.displayName,
      legacyMatchName: terminal.legacyMatchName,
      ...assessment,
    };
  }

  const fallbacks = trackFallbacks
    ? new Map(
        [...reasons].map(([unitId, reason]) => {
          const unit = units.get(unitId);
          if (!unit) {
            return selectorIdentityInvariant(
              "terminal-record-mismatch",
              `IR identity selector fallback ${unitId} has no population record`,
            );
          }
          return [unitId, fallbackFor(unit, reason, details.get(unitId))] as const;
        }),
      )
    : undefined;
  return {
    units,
    funcs: claimed,
    ...(classClaims.size ? { classMembers: classClaims } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(localCallees ? { localCallees } : {}),
    ...(moduleInit ? { moduleInit } : {}),
    legacyProjection: { includeEmptyModuleInit: true, demoteOnLegacyCaller },
  };
}

/** Project structural decisions only through unambiguous legacy name namespaces. */
export function projectIrSelectionToLegacy(structural: IrIdentitySelection): IrLegacySelectionProjection {
  validateLegacyProjectionInput(structural);
  const occupantsByName = new Map<string, IrIdentitySelectionUnit[]>();
  for (const unit of structural.units.values()) addNameIndex(occupantsByName, unit.legacyMatchName, unit);
  const omittedUnitIds = new Set<IrUnitId>();
  for (const occupants of occupantsByName.values()) {
    if (occupants.length > 1) for (const occupant of occupants) omittedUnitIds.add(occupant.unitId);
  }
  if (structural.localCallees) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [caller, callees] of structural.localCallees) {
        if (!omittedUnitIds.has(caller) && [...callees].some((callee) => omittedUnitIds.has(callee))) {
          omittedUnitIds.add(caller);
          changed = true;
        }
        if (structural.legacyProjection?.demoteOnLegacyCaller !== true || !omittedUnitIds.has(caller)) continue;
        for (const callee of callees) {
          if (omittedUnitIds.has(callee)) continue;
          omittedUnitIds.add(callee);
          changed = true;
        }
      }
    }
  }

  const funcs = new Set<string>();
  for (const claim of structural.funcs.values()) {
    if (!omittedUnitIds.has(claim.unitId)) funcs.add(claim.legacyMatchName);
  }
  const classMembers = new Set<string>();
  for (const claim of structural.classMembers?.values() ?? []) {
    if (!omittedUnitIds.has(claim.unitId)) classMembers.add(claim.legacyMatchName);
  }
  const classMemberUnitIds = new Set(
    [...(structural.classMembers?.keys() ?? [])].filter((unitId) => !omittedUnitIds.has(unitId)),
  );

  const fallbacks: IrFallback[] | undefined = structural.fallbacks ? [] : undefined;
  if (fallbacks) {
    const emittedNames = new Set<string>();
    for (const fallback of structural.fallbacks!.values()) {
      if (omittedUnitIds.has(fallback.unitId)) continue;
      fallbacks.push({ name: fallback.legacyMatchName, reason: fallback.reason, detail: fallback.detail });
      emittedNames.add(fallback.legacyMatchName);
    }
    for (const [name, occupants] of occupantsByName) {
      if (!occupants.some((occupant) => omittedUnitIds.has(occupant.unitId)) || emittedNames.has(name)) continue;
      const ownFallbacks = occupants
        .map((occupant) => structural.fallbacks!.get(occupant.unitId))
        .filter((fallback): fallback is IrIdentityFallback => fallback !== undefined);
      const reasons = new Set(ownFallbacks.map((fallback) => fallback.reason));
      const reason =
        ownFallbacks.length === occupants.length && reasons.size === 1
          ? ownFallbacks[0]!.reason
          : occupants.every((occupant) => occupant.kind === "class-member")
            ? "class-member-unsupported"
            : "call-resolution-unsupported";
      fallbacks.push({ name, reason });
      emittedNames.add(name);
    }
    for (const unitId of omittedUnitIds) {
      const unit = structural.units.get(unitId);
      if (!unit || emittedNames.has(unit.legacyMatchName)) continue;
      fallbacks.push({
        name: unit.legacyMatchName,
        reason: unit.kind === "class-member" ? "class-member-unsupported" : "call-resolution-unsupported",
      });
      emittedNames.add(unit.legacyMatchName);
    }
  }

  let localCallees: Map<string, ReadonlySet<string>> | undefined;
  if (structural.localCallees) {
    localCallees = new Map();
    for (const [callerId, calleeIds] of structural.localCallees) {
      const caller = structural.units.get(callerId);
      if (!caller || omittedUnitIds.has(callerId)) continue;
      const names = new Set<string>();
      for (const calleeId of calleeIds) {
        const callee = structural.units.get(calleeId);
        if (callee && !omittedUnitIds.has(calleeId)) names.add(callee.legacyMatchName);
      }
      localCallees.set(caller.legacyMatchName, names);
    }
  }

  const moduleInit = structural.moduleInit
    ? {
        stmtCount: structural.moduleInit.stmtCount,
        reason: structural.moduleInit.reason,
        ...(structural.moduleInit.detail === undefined ? {} : { detail: structural.moduleInit.detail }),
      }
    : structural.legacyProjection?.includeEmptyModuleInit
      ? { stmtCount: 0, reason: null }
      : undefined;

  return {
    selection: {
      funcs,
      ...(classMembers.size ? { classMembers } : {}),
      ...(classMemberUnitIds.size ? { classMemberUnitIds } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(localCallees ? { localCallees } : {}),
      ...(moduleInit ? { moduleInit } : {}),
    },
    omittedUnitIds,
  };
}
