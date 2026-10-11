// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { sourceBooleanAnyResult, assertSourceBooleanAnyReturns } from "../frontend/boolean-return-boundary.js";
import { preparedIrProgramCallableResults } from "./program-callable-contract.js";
import { prepareSourceClosureInvocations } from "./source-closure-invocation.js";
import type { TypedIrProgramInput } from "./program/input-contracts.js";
import type { TypeOracle } from "../checker/oracle.js";
import { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId, irSourceGlobalRef } from "./abi-bindings.js";
import { irUnitFuncRef, irUnitCallableBindingId } from "./callable-bindings.js";
import {
  lowerFunctionAstToIr,
  typeNodeToIr,
  type IrFromAstResolver,
  type IrFunctionSourceMapContext,
  type IrSourceMapNodeProjection,
} from "./from-ast.js";
import { buildIrUnitInventory, getIrInventoryScannerMetadata, type BuildIrUnitInventoryOptions } from "./identity.js";
import type { IrSourceId, IrUnitId } from "../shared/contracts/ir-identity.js";
import type {
  IrUnitInventory,
  IrPreparedSourceMap,
  IrSourceMapSource,
  IrSourceMapDerivedSource,
  IrSourceMapSpan,
  IrSourceMapTextProjection,
  IrSourceMapTextStage,
  IrSourceMapStageProducer,
} from "../shared/contracts/ir-unit-inventory.js";
import { assertPreparedSourceMap } from "./program/validation.js";
import { PositionMap } from "../position-map.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "./planning-identity.js";
import { buildIrProgramCallableBindingGraph } from "./program-callable-bindings.js";
import type { IrProgramCallableBindingRecord } from "./program/callable-bindings.js";
import { buildIrUnitTypeMap, lowerTypeToIrType } from "./propagate.js";
import { buildIrModuleInitPlan } from "./module-init-plan.js";
import type { IrModuleInitPlan } from "./program/startup.js";
import { makeModuleInitSynthetic } from "./module-init.js";
import { makeIrIdentityModuleBindingResolver, type IrModuleBindingIdentity } from "./module-bindings.js";
import type { IrDirectCallLoweringPlan, ModuleBindingGlobal } from "./ast-lowering-plans.js";
import type { PreparedIrFunction as IrFunction, PreparedIrModule as IrModule } from "./runtime/contracts/prepared.js";
import type { IrType } from "./core/types.js";
import { freezePreparedIrRuntimeValue, preparedIrDataMismatch } from "./program/data.js";
import { classifyIrFailure, IrUnsupportedError } from "./outcomes.js";
import type { ProgramAbiDerivedUnitRecord } from "./program/abi.js";
import { preparedIrProgramOwner } from "./program.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { PreparedIrProgramFailure } from "./program/prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import { unwrapPromiseTypeNode } from "./async-static.js";
import { postStartupCallableUnits } from "./program-startup-proof.js";
import { makeIrIdentityImportedFunctionResolver } from "./imported-functions.js";
import { makeIrPromiseDelayResolver } from "./promise-delay.js";
import { prepareOrdinaryObjectAccessResolver } from "../frontend/builtins/prepare-ordinary-object-access.js";
import { prepareNumberConversionResolver } from "../frontend/builtins/prepare-number-conversion.js";
import { prepareObjectCreateResolver } from "../frontend/builtins/prepare-object-create.js";
import { prepareNativeStringOutputResolver } from "../frontend/builtins/prepare-string-output.js";
import { prepareNativeAsyncSourceFamilies, type NativeAsyncSourceFamilies } from "./program-native-async-source.js";
import {
  collectIrPromiseDelayOwners,
  buildIrPromiseDelayLoweringPlans,
  validateNativePromiseDelaySupportByIdentity,
  type IrPromiseDelayLoweringPlan,
  type IrPromiseDelayLoweringPlans,
} from "./promise-delay-lowering.js";

/** Frontend references are authenticated before detached projection data is captured. */
export interface IrSourceMapCaptureRequest {
  readonly kind: "capture-source-map";
  readonly sources: readonly {
    readonly sourceFile: ts.SourceFile;
    readonly projection: IrSourceMapTextProjection;
  }[];
}

export type { IrSourceMapNodeProjection } from "./from-ast.js";

export interface IrPreparedSourceMapProjector {
  readonly sourceMap: IrPreparedSourceMap;
  project(node: ts.Node): IrSourceMapNodeProjection;
}

function sourceMapCaptureInvalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `source map capture: ${detail}`);
}

function sourceMapCaptureFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return sourceMapCaptureInvalid("requires a plain data record");
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
    return sourceMapCaptureInvalid("record fields differ from the closed capture contract");
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined)
      return sourceMapCaptureInvalid(`requires defined own data field ${field}`);
    result[field] = descriptor.value;
  }
  return result;
}

function sourceMapCaptureArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return sourceMapCaptureInvalid("requires an ordinary dense array");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
    return sourceMapCaptureInvalid("array has holes or extra properties");
  const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined)
      return sourceMapCaptureInvalid("array entries must be defined own data");
    entries.push(descriptor.value);
  }
  return entries;
}

function sourceMapCaptureString(value: unknown): string {
  if (typeof value !== "string") return sourceMapCaptureInvalid("text must be a primitive string");
  return value;
}

function sourceMapCaptureSpan(value: unknown, length: number): IrSourceMapSpan {
  const span = sourceMapCaptureFields(value, ["start", "end"]);
  const { start, end } = span;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > length
  )
    return sourceMapCaptureInvalid("invalid UTF-16 span");
  return { start, end };
}

function sourceMapCaptureStage(value: unknown): IrSourceMapTextStage {
  const stage = sourceMapCaptureFields(value, ["producer", "inputText", "outputText", "edits"]);
  const inputText = sourceMapCaptureString(stage.inputText);
  const outputText = sourceMapCaptureString(stage.outputText);
  const producers: readonly IrSourceMapStageProducer[] = [
    "define",
    "stdin-prelude",
    "iterator-prelude",
    "listformat-prelude",
    "cjs-rewrite",
    "eval-super-rewrite",
    "imports",
  ];
  const producer = producers.find((entry) => entry === stage.producer);
  if (!producer) return sourceMapCaptureInvalid("unknown stage producer");
  const edits = sourceMapCaptureArray(stage.edits).map((entry) => {
    const edit = sourceMapCaptureFields(entry, ["input", "removed", "inserted", "kind"]);
    const input = sourceMapCaptureSpan(edit.input, inputText.length);
    const removed = sourceMapCaptureString(edit.removed);
    const inserted = sourceMapCaptureString(edit.inserted);
    if (edit.kind !== (input.start === input.end ? "generated-insertion" : "replacement"))
      return sourceMapCaptureInvalid("edit kind differs from actual input interval");
    return { input, removed, inserted, kind: edit.kind };
  });
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    if (index > 0 && edit.input.start < edits[index - 1]!.input.end)
      return sourceMapCaptureInvalid("edits must be ordered and disjoint");
  }
  const actual = new PositionMap(
    edits.map((edit) => ({ origStart: edit.input.start, origEnd: edit.input.end, newLength: edit.inserted.length })),
  ).captureSourceMapStage(producer, inputText, outputText);
  if (JSON.stringify(actual.edits) !== JSON.stringify(edits))
    return sourceMapCaptureInvalid("stage edits contradict complete actual replay");
  return actual;
}

function sourceMapCaptureProjection(value: unknown): IrSourceMapTextProjection {
  const projection = sourceMapCaptureFields(value, ["originalText", "analyzedText", "stages"]);
  const originalText = sourceMapCaptureString(projection.originalText);
  const analyzedText = sourceMapCaptureString(projection.analyzedText);
  const stages = sourceMapCaptureArray(projection.stages).map(sourceMapCaptureStage);
  let text = originalText;
  for (const stage of stages) {
    if (stage.inputText !== text) return sourceMapCaptureInvalid("stage continuity differs from original input");
    text = stage.outputText;
  }
  if (text !== analyzedText) return sourceMapCaptureInvalid("complete replay differs from analyzed text");
  return { originalText, analyzedText, stages };
}

/** Requested-only finite SourceFile preflight before the semantic scanner or ancestor readers. */
function sourceMapPreflightSources(sourceFiles: readonly ts.SourceFile[]): void {
  const seen = new Set<ts.Node>();
  for (const candidate of sourceMapCaptureArray(sourceFiles)) {
    const sourceFile = candidate as ts.SourceFile;
    if (!sourceFile || sourceFile.kind !== ts.SyntaxKind.SourceFile || sourceFile.parent !== undefined)
      sourceMapCaptureInvalid("actual SourceFile root must have no parent");
    const visit = (node: ts.Node): void => {
      if (seen.has(node)) sourceMapCaptureInvalid("source tree contains repeated or cyclic nodes");
      seen.add(node);
      ts.forEachChild(node, (child) => {
        if (child.parent !== node) sourceMapCaptureInvalid("source tree child is detached from its actual parent");
        visit(child);
      });
    };
    visit(sourceFile);
  }
}

/** Authenticate each real planner occurrence against the same scanned source references. */
function sourceMapStartupOccurrences(
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  startup: readonly IrModuleInitPlan[],
): ReadonlyMap<ts.Node, IrSourceMapSpan> {
  const occurrences = new Map<ts.Node, IrSourceMapSpan>();
  const seenSources = new Set<IrSourceId>();
  const seenUnits = new Set<IrUnitId>();
  for (const plan of startup) {
    sourceMapCaptureFields(plan, [
      "sourceId",
      "unitId",
      "executable",
      "bindings",
      "liveSeeds",
      "evaluations",
      "exports",
      "invocation",
      "gaps",
    ]);
    const file = identity.sourceFileBySourceId.get(plan.sourceId);
    const unitId = file && identity.moduleInitUnitIdBySourceFile.get(file);
    if (
      !file ||
      seenSources.has(plan.sourceId) ||
      plan.unitId !== (unitId ?? null) ||
      (unitId !== undefined && seenUnits.has(unitId))
    )
      sourceMapCaptureInvalid("startup plan differs from actual unique source/module-init identity");
    seenSources.add(plan.sourceId);
    if (unitId !== undefined) seenUnits.add(unitId);
    const population = new Set(identity.moduleInitPopulationBySourceFile.get(file));
    const declarations = file.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
    sourceMapCaptureArray(plan.bindings);
    sourceMapCaptureArray(plan.evaluations);
    sourceMapCaptureArray(plan.gaps);
    if (plan.bindings.length !== declarations.length)
      sourceMapCaptureInvalid("startup binding census differs from actual top-level declarations");
    const bindingByDeclaration = new Map<ts.VariableDeclaration, IrModuleInitPlan["bindings"][number]>();
    for (const [index, binding] of plan.bindings.entries()) {
      sourceMapCaptureFields(binding, [
        "declarationOrdinal",
        "names",
        "declarationKind",
        "mutable",
        "initialization",
        "globalBindingId",
        "tdzBindingId",
        "start",
        "end",
      ]);
      const declaration = declarations[index]!;
      const statement = declaration.parent.parent;
      if (!ts.isVariableStatement(statement) || !population.has(statement))
        sourceMapCaptureInvalid("startup binding is not an actual module-init population declaration");
      const kind =
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
          ? "const"
          : (declaration.parent.flags & ts.NodeFlags.Let) !== 0
            ? "let"
            : "var";
      const identifier = ts.isIdentifier(declaration.name);
      const names = sourceMapCaptureArray(binding.names);
      const expectedNames: string[] = [];
      const collectNames = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) expectedNames.push(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) collectNames(element.name);
      };
      collectNames(declaration.name);
      if (
        binding.declarationOrdinal !== index ||
        binding.start !== declaration.getStart(file) ||
        binding.end !== declaration.end ||
        binding.declarationKind !== kind ||
        binding.mutable !== (kind !== "const") ||
        binding.initialization !== (kind === "var" ? "undefined-at-instantiation" : "tdz") ||
        names.length !== expectedNames.length ||
        names.some((name, ordinal) => name !== expectedNames[ordinal]) ||
        binding.globalBindingId !== (identifier ? irModuleGlobalBindingId(plan.sourceId, index) : null) ||
        binding.tdzBindingId !==
          (identifier && kind !== "var" ? irModuleTdzGlobalBindingId(plan.sourceId, index) : null)
      )
        sourceMapCaptureInvalid("startup binding differs from actual declaration/name/storage relation");
      bindingByDeclaration.set(declaration, binding);
      if (identifier && unitId !== undefined && plan.executable && plan.gaps.length === 0)
        occurrences.set(declaration, Object.freeze({ start: binding.start, end: binding.end }));
    }
    const expected = file.statements.flatMap((statement, statementOrdinal) => {
      if (ts.isVariableStatement(statement))
        return statement.declarationList.declarations.some((declaration) => declaration.initializer !== undefined)
          ? [
              {
                node: statement as ts.Node,
                statementOrdinal,
                nestedOrdinal: 0,
                kind: "variable-initializer",
                classId: null,
                legacyKind: "statement",
              },
            ]
          : [];
      if (ts.isClassDeclaration(statement)) {
        const nodes = statement.members.flatMap((member) => {
          const isStatic =
            ts.canHaveModifiers(member) &&
            (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
          if (ts.isClassStaticBlockDeclaration(member))
            return [{ node: member as ts.Node, kind: "class-static-block" }];
          return isStatic && ts.isPropertyDeclaration(member) && member.initializer
            ? [{ node: member.initializer as ts.Node, kind: "class-static-field" }]
            : [];
        });
        return nodes.map((row, nestedOrdinal) => ({
          ...row,
          statementOrdinal,
          nestedOrdinal,
          classId: identity.classIdByDeclaration.get(statement) ?? null,
          legacyKind: "static",
        }));
      }
      if (population.has(statement) || ts.isExportAssignment(statement))
        return [
          {
            node: statement as ts.Node,
            statementOrdinal,
            nestedOrdinal: 0,
            kind: ts.isExportAssignment(statement) ? "export-assignment" : "statement",
            classId: null,
            legacyKind: "statement",
          },
        ];
      return [];
    });
    if (expected.length !== plan.evaluations.length)
      sourceMapCaptureInvalid("startup evaluation census differs from actual source statements");
    for (const [index, evaluation] of plan.evaluations.entries()) {
      sourceMapCaptureFields(evaluation, [
        "key",
        "kind",
        "sourceOrdinal",
        "statementOrdinal",
        "nestedOrdinal",
        "start",
        "end",
        "classId",
        "bindingIds",
        "legacyKey",
      ]);
      const actual = expected[index]!;
      const start = actual.node.getStart(file),
        end = actual.node.end;
      const ids = sourceMapCaptureArray(evaluation.bindingIds);
      const expectedIds = ts.isVariableStatement(actual.node)
        ? actual.node.declarationList.declarations.flatMap((declaration) => {
            const id = bindingByDeclaration.get(declaration)!.globalBindingId;
            return id === null ? [] : [id];
          })
        : [];
      if (
        evaluation.key !== `${plan.sourceId}:eval:${index}` ||
        evaluation.sourceOrdinal !== index ||
        evaluation.statementOrdinal !== actual.statementOrdinal ||
        evaluation.nestedOrdinal !== actual.nestedOrdinal ||
        evaluation.kind !== actual.kind ||
        evaluation.classId !== actual.classId ||
        evaluation.start !== start ||
        evaluation.end !== end ||
        evaluation.legacyKey !== `${actual.legacyKind}:${start}:${end}` ||
        ids.length !== expectedIds.length ||
        ids.some((id, ordinal) => id !== expectedIds[ordinal])
      )
        sourceMapCaptureInvalid("startup evaluation differs from actual statement/kind/key/binding relation");
      if (
        unitId !== undefined &&
        plan.executable &&
        plan.gaps.length === 0 &&
        population.has(actual.node as ts.Statement) &&
        (actual.kind === "statement" || actual.kind === "variable-initializer")
      )
        occurrences.set(actual.node, Object.freeze({ start, end }));
    }
  }
  if (seenSources.size !== identity.sourceFileBySourceId.size)
    sourceMapCaptureInvalid("startup plan source census differs from actual scanner sources");
  return occurrences;
}

/** Validate only scanner-authentic tree references before any existing parent-chain lookup. */
function sourceMapPreflightScannerTree(inventory: IrUnitInventory): void {
  const scanner = getIrInventoryScannerMetadata(inventory);
  if (!scanner) sourceMapCaptureInvalid("requires the exact inventory returned by buildIrUnitInventory");
  const sources = new Map<ts.Node, ts.SourceFile>();
  for (const { sourceFile } of scanner.sources) {
    if (sourceFile.kind !== ts.SyntaxKind.SourceFile || sourceFile.parent !== undefined)
      sourceMapCaptureInvalid("actual SourceFile root must have no parent");
    const visit = (node: ts.Node): void => {
      if (sources.has(node)) sourceMapCaptureInvalid("scanner source tree contains repeated or cyclic nodes");
      sources.set(node, sourceFile);
      ts.forEachChild(node, (child) => {
        if (child.parent !== node) sourceMapCaptureInvalid("scanner tree child is detached from its actual parent");
        visit(child);
      });
    };
    visit(sourceFile);
  }
  for (const entry of [...scanner.units, ...scanner.classes]) {
    if (sources.get(entry.declaration) !== entry.sourceFile)
      sourceMapCaptureInvalid("scanner declaration is absent from its actual source traversal");
  }
}

function buildPreparedSourceMapCatalog(
  sourceFiles: readonly ts.SourceFile[],
  inventory: IrUnitInventory,
  request: IrSourceMapCaptureRequest,
  suppliedIdentity?: ReturnType<typeof buildIrPlanningIdentityContext>,
) {
  sourceMapPreflightScannerTree(inventory);
  const identity = suppliedIdentity ?? buildIrPlanningIdentityContext(inventory);
  const actualFiles = [...identity.sourceFileBySourceId.values()];
  if (actualFiles.some((file) => file.parent !== undefined))
    return sourceMapCaptureInvalid("actual SourceFile root must have no parent");
  const files = sourceMapCaptureArray(sourceFiles);
  if (
    files.length !== actualFiles.length ||
    new Set(files).size !== files.length ||
    files.some((file) => !actualFiles.some((actual) => actual === file))
  )
    return sourceMapCaptureInvalid("source reference census differs from authentic scanner population");
  const envelope = sourceMapCaptureFields(request, ["kind", "sources"]);
  if (envelope.kind !== "capture-source-map") return sourceMapCaptureInvalid("unknown request kind");
  const rows = sourceMapCaptureArray(envelope.sources);
  const projections = new Map<ts.SourceFile, IrSourceMapTextProjection>();
  for (const row of rows) {
    const fields = sourceMapCaptureFields(row, ["sourceFile", "projection"]);
    const file = actualFiles.find((entry) => entry === fields.sourceFile);
    if (!file || projections.has(file)) return sourceMapCaptureInvalid("foreign or duplicate source reference row");
    const projection = sourceMapCaptureProjection(fields.projection);
    if (file.text !== projection.analyzedText)
      return sourceMapCaptureInvalid("analyzed text differs from exact SourceFile");
    projections.set(file, projection);
  }
  if (projections.size !== actualFiles.length) return sourceMapCaptureInvalid("missing actual source reference row");
  const sources = inventory.sources.map((record): IrSourceMapSource => {
    const file = identity.sourceFileBySourceId.get(record.id);
    if (!file || identity.sourceIdBySourceFile.get(file) !== record.id || file.fileName !== record.originalFileName)
      return sourceMapCaptureInvalid("source record no longer resolves to actual scanner reference");
    return {
      sourceId: record.id,
      sourceKey: record.sourceKey,
      originalFileName: record.originalFileName,
      mapName: record.sourceKey,
      projection: projections.get(file)!,
    };
  });
  const sourceMap = freezePreparedIrRuntimeValue<IrPreparedSourceMap>({ schema: "prepared-ir-source-map-v1", sources });
  return { sourceMap, identity };
}

/** Catalog only: this does not authorize a requested-map source preparation. */
export function capturePreparedSourceMapInput(
  sourceFiles: readonly ts.SourceFile[],
  inventory: IrUnitInventory,
  request: IrSourceMapCaptureRequest,
): IrPreparedSourceMap {
  return buildPreparedSourceMapCatalog(sourceFiles, inventory, request).sourceMap;
}

type SourceMapNodeSnapshot = {
  readonly file: ts.SourceFile;
  readonly source: IrSourceMapSource;
  readonly parent: ts.Node | undefined;
  readonly pos: number;
  readonly end: number;
  readonly kind: ts.SyntaxKind;
  readonly span: IrSourceMapSpan;
  readonly donorUnitId?: IrUnitId;
  readonly donorSpan?: IrSourceMapSpan;
};

function sourceMapReverseNodeSpan(span: IrSourceMapSpan, stage: IrSourceMapTextStage) {
  let delta = 0;
  let start: number | undefined;
  let end: number | undefined;
  let rewritten = false;
  let crossed = false;
  for (let index = 0; index < stage.edits.length; index++) {
    const edit = stage.edits[index]!;
    const lo = edit.input.start + delta;
    const hi = lo + edit.inserted.length;
    const intersects = span.start < hi && span.end > lo;
    if (intersects && edit.kind === "generated-insertion") {
      if (span.start >= lo && span.end <= hi) return { kind: "generated" as const, editIndex: index };
      return { kind: "unmapped" as const };
    }
    if (intersects) {
      rewritten = true;
      crossed ||= span.start < lo || span.end > hi;
    }
    if (start === undefined && span.start < hi) start = span.start < lo ? span.start - delta : edit.input.start;
    if (end === undefined && span.end <= hi) end = span.end <= lo ? span.end - delta : edit.input.end;
    delta += edit.inserted.length - (edit.input.end - edit.input.start);
  }
  return {
    kind: "source" as const,
    span: { start: start ?? span.start - delta, end: end ?? span.end - delta },
    rewritten,
    crossed,
  };
}

function sourceMapOriginalSyntaxIndex(source: IrSourceMapSource): ReadonlySet<string> {
  const original = ts.createSourceFile(
    source.originalFileName,
    source.projection.originalText,
    ts.ScriptTarget.Latest,
    true,
  );
  const spans = new Set<string>();
  const visit = (node: ts.Node): void => {
    spans.add(`${node.kind}:${node.getStart(original)}:${node.getEnd()}`);
    ts.forEachChild(node, visit);
  };
  visit(original);
  return spans;
}

function sourceMapProjectCapturedNode(
  node: ts.Node,
  captured: SourceMapNodeSnapshot,
  originalSpans: ReadonlySet<string>,
): IrSourceMapNodeProjection {
  const { source, donorUnitId, span: analyzed, file } = captured;
  const unmapped = (detail: string): IrSourceMapNodeProjection => ({
    kind: "unmapped",
    sourceId: source.sourceId,
    ...(donorUnitId === undefined ? {} : { unitId: donorUnitId }),
    detail,
  });
  let original = analyzed;
  let rewritten = false;
  let crossed = false;
  for (let index = source.projection.stages.length - 1; index >= 0; index--) {
    const result = sourceMapReverseNodeSpan(original, source.projection.stages[index]!);
    if (result.kind === "generated")
      return freezePreparedIrRuntimeValue({
        kind: "generated-text",
        sourceId: source.sourceId,
        analyzed,
        stageIndex: index,
        editIndex: result.editIndex,
      });
    if (result.kind === "unmapped") return unmapped("node crosses generated insertion partitions");
    original = result.span;
    rewritten ||= result.rewritten;
    crossed ||= result.crossed;
  }
  if (crossed && !originalSpans.has(`${node.kind}:${original.start}:${original.end}`))
    return unmapped("crossed replacement has no contiguous original syntax relation");
  if (donorUnitId === undefined) return unmapped("node has no actual indexed declaration or module-init donor");
  if (!captured.donorSpan || analyzed.start < captured.donorSpan.start || analyzed.end > captured.donorSpan.end)
    return unmapped("node escapes the actual indexed donor declaration span");
  const position = file.getLineAndCharacterOfPosition(analyzed.start);
  return freezePreparedIrRuntimeValue({
    kind: "source",
    site: {
      line: position.line + 1,
      column: position.character,
      origin: {
        kind: "source",
        point: { sourceId: source.sourceId, donorUnitId, analyzed, original, mapping: rewritten ? "rewrite" : "exact" },
      },
    },
  });
}

function sourceMapDeclarationKindMatches(kind: IrUnitInventory["allUnits"][number]["kind"], node: ts.Node): boolean {
  switch (kind) {
    case "top-level-function":
    case "nested-function":
      return ts.isFunctionDeclaration(node);
    case "function-expression":
      return ts.isFunctionExpression(node);
    case "arrow-function":
      return ts.isArrowFunction(node);
    case "class-constructor":
      return ts.isConstructorDeclaration(node);
    case "class-implicit-constructor":
      return ts.isClassDeclaration(node) || ts.isClassExpression(node);
    case "class-instance-method":
    case "object-method":
      return ts.isMethodDeclaration(node);
    case "class-static-method":
      return (
        ts.isMethodDeclaration(node) ||
        (ts.isConstructorDeclaration(node) &&
          !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
      );
    case "class-instance-getter":
    case "class-static-getter":
    case "object-getter":
      return ts.isGetAccessorDeclaration(node);
    case "class-instance-setter":
    case "class-static-setter":
    case "object-setter":
      return ts.isSetAccessorDeclaration(node);
    case "class-instance-field-initializer":
    case "class-static-field-initializer":
      return ts.isPropertyDeclaration(node);
    case "class-static-block":
      return ts.isClassStaticBlockDeclaration(node);
    case "export-assignment":
      return ts.isExportAssignment(node);
    case "synthetic-support":
      return ts.isFunctionDeclaration(node);
    case "module-init":
      return false;
  }
}

function sourceMapBypassesDeclaration(declaration: ts.Node, descendant: ts.Node): boolean {
  if (
    (ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isSetAccessorDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    ts.isComputedPropertyName(declaration.name)
  ) {
    const name = declaration.name;
    return descendant !== declaration && descendant.pos >= name.pos && descendant.end <= name.end;
  }
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    if (
      (declaration.heritageClauses ?? []).some((clause) => descendant.pos >= clause.pos && descendant.end <= clause.end)
    )
      return true;
    return declaration.members.some(
      (member) =>
        member.name &&
        ts.isComputedPropertyName(member.name) &&
        descendant.pos >= member.name.pos &&
        descendant.end <= member.name.end,
    );
  }
  return false;
}

function sourceMapNodeDonor(
  node: ts.Node,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  population: ReadonlySet<ts.Node>,
  file: ts.SourceFile,
): IrUnitId | undefined {
  const ancestors = new Set<ts.Node>();
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
    if (ancestors.has(parent)) return sourceMapCaptureInvalid("cyclic node ancestry is not a source donor");
    ancestors.add(parent);
    const indexed = identity.unitIdByDeclaration.get(parent);
    if (indexed !== undefined && !sourceMapBypassesDeclaration(parent, node)) return indexed;
    if (population.has(parent)) return identity.moduleInitUnitIdBySourceFile.get(file);
  }
  return undefined;
}

function sourceMapVerifyLexicalOwners(identity: ReturnType<typeof buildIrPlanningIdentityContext>): void {
  for (const [unitId, declaration] of identity.declarationByUnitId) {
    const unit = identity.unitByUnitId.get(unitId)!;
    let actual: typeof unit.lexicalOwnerId = null;
    if (unit.kind === "class-implicit-constructor")
      actual = identity.classIdByDeclaration.get(declaration as ts.ClassDeclaration | ts.ClassExpression) ?? null;
    else
      for (let parent = declaration.parent; parent; parent = parent.parent) {
        const classId = identity.classIdByDeclaration.get(parent as ts.ClassDeclaration | ts.ClassExpression);
        const owner =
          classId ??
          (sourceMapBypassesDeclaration(parent, declaration) ? undefined : identity.unitIdByDeclaration.get(parent));
        if (owner !== undefined) {
          actual = owner;
          break;
        }
        const file = identity.sourceFileBySourceId.get(unit.sourceId)!;
        if (identity.moduleInitPopulationBySourceFile.get(file)?.some((statement) => statement === parent)) {
          actual = identity.moduleInitUnitIdBySourceFile.get(file) ?? null;
          break;
        }
      }
    if (actual !== unit.lexicalOwnerId)
      sourceMapCaptureInvalid("declaration lexical owner differs from authentic scanner chain");
  }
}

/** Request-local actual AST membership; foreign nodes and stale snapshots are invariant failures. */
export function createPreparedSourceMapProjector(
  sourceFiles: readonly ts.SourceFile[],
  inventory: IrUnitInventory,
  request: IrSourceMapCaptureRequest,
): IrPreparedSourceMapProjector {
  return createSourceMapProjector(inventory, buildPreparedSourceMapCatalog(sourceFiles, inventory, request));
}

/** Private real-preparation join; no caller-provided loose startup ranges. */
function createSourceMapProjector(
  inventory: IrUnitInventory,
  catalog: ReturnType<typeof buildPreparedSourceMapCatalog>,
  occurrences?: ReadonlyMap<ts.Node, IrSourceMapSpan>,
): IrPreparedSourceMapProjector {
  const { sourceMap, identity } = catalog;
  const snapshots = new Map<ts.Node, SourceMapNodeSnapshot>();
  const seenDeclarations = new Set<ts.Node>();
  const seenClasses = new Set<ts.Node>();
  const originalIndexes = new Map(
    sourceMap.sources.map((source) => [source.sourceId, sourceMapOriginalSyntaxIndex(source)]),
  );
  for (const source of sourceMap.sources) {
    const file = identity.sourceFileBySourceId.get(source.sourceId)!;
    const population = new Set<ts.Node>(identity.moduleInitPopulationBySourceFile.get(file));
    const visit = (node: ts.Node): void => {
      if (snapshots.has(node)) sourceMapCaptureInvalid("actual AST traversal contains a repeated or cyclic node");
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const classId = identity.classIdByDeclaration.get(node);
        const record = inventory.classes.find((entry) => entry.id === classId);
        if (classId !== undefined) {
          if (
            !record ||
            record.sourceId !== source.sourceId ||
            identity.declarationByClassId.get(classId) !== node ||
            record.declarationStart !== node.getStart(file) ||
            record.declarationEnd !== node.getEnd() ||
            record.declarationKind !== (ts.isClassDeclaration(node) ? "declaration" : "expression")
          )
            sourceMapCaptureInvalid("class declaration differs from authentic scanner bounds or kind");
          seenClasses.add(node);
        }
      }
      const indexed = identity.unitIdByDeclaration.get(node);
      if (indexed !== undefined) {
        const unit = identity.unitByUnitId.get(indexed);
        if (
          !unit ||
          unit.sourceId !== source.sourceId ||
          identity.declarationByUnitId.get(indexed) !== node ||
          !sourceMapDeclarationKindMatches(unit.kind, node) ||
          unit.declarationStart !== node.getStart(file) ||
          unit.declarationEnd !== node.getEnd()
        )
          sourceMapCaptureInvalid("declaration/source/unit bounds contradict authentic scanner association");
        seenDeclarations.add(node);
      }
      const donorUnitId = sourceMapNodeDonor(node, identity, population, file);
      const span = { start: node.getStart(file), end: node.getEnd() };
      let donorSpan =
        donorUnitId === undefined
          ? undefined
          : {
              start: identity.unitByUnitId.get(donorUnitId)!.declarationStart,
              end: identity.unitByUnitId.get(donorUnitId)!.declarationEnd,
            };
      if (occurrences && donorUnitId === identity.moduleInitUnitIdBySourceFile.get(file)) {
        for (let current: ts.Node | undefined = node; current; current = current.parent) {
          const occurrence = occurrences.get(current);
          if (occurrence && span.start >= occurrence.start && span.end <= occurrence.end) {
            donorSpan = occurrence;
            break;
          }
        }
      }
      if (span.start < 0 || span.end < span.start || span.end > file.text.length)
        sourceMapCaptureInvalid("actual traversal node has invalid source bounds");
      snapshots.set(node, {
        file,
        source,
        parent: node.parent,
        pos: node.pos,
        end: node.end,
        kind: node.kind,
        span,
        ...(donorUnitId === undefined
          ? {}
          : {
              donorUnitId,
              donorSpan,
            }),
      });
      ts.forEachChild(node, (child) => {
        if (child.parent !== node)
          return sourceMapCaptureInvalid("actual AST child is detached from its lexical parent");
        visit(child);
      });
    };
    visit(file);
  }
  for (const declaration of identity.declarationByUnitId.values()) {
    if (!seenDeclarations.has(declaration))
      return sourceMapCaptureInvalid("scanner declaration is absent from actual source traversal");
  }
  for (const declaration of identity.declarationByClassId.values()) {
    if (!seenClasses.has(declaration))
      sourceMapCaptureInvalid("scanner class declaration is absent from actual source traversal");
  }
  sourceMapVerifyLexicalOwners(identity);
  return Object.freeze({
    sourceMap,
    project(node: ts.Node): IrSourceMapNodeProjection {
      const captured = snapshots.get(node);
      if (!captured) return sourceMapCaptureInvalid("foreign or synthetic node is not in the captured AST traversal");
      if (
        captured.file.text !== captured.source.projection.analyzedText ||
        captured.file.fileName !== captured.source.originalFileName
      )
        return sourceMapCaptureInvalid("captured source text or filename changed");
      for (let current: ts.Node | undefined = node; current; current = snapshots.get(current)?.parent) {
        const snapshot = snapshots.get(current);
        if (
          !snapshot ||
          current.pos !== snapshot.pos ||
          current.end !== snapshot.end ||
          current.kind !== snapshot.kind ||
          current.parent !== snapshot.parent ||
          (snapshot.parent !== undefined &&
            ts.forEachChild(snapshot.parent, (child) => (child === current ? true : undefined)) !== true) ||
          current.getStart(captured.file) !== snapshot.span.start
        )
          return sourceMapCaptureInvalid("captured node or lexical donor chain changed");
      }
      return sourceMapProjectCapturedNode(node, captured, originalIndexes.get(captured.source.sourceId)!);
    },
  });
}

export interface IrProgramSourceInput {
  readonly sourceMap?: IrSourceMapCaptureRequest;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly entrySource: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly oracle?: TypeOracle;
  readonly inventoryOptions?: BuildIrUnitInventoryOptions;
  readonly policy: RuntimeManifestPolicy;
  readonly deferTopLevelInit: boolean;
  /**
   * Explicit frontend lowering selection; not provider availability or
   * permission to emit. Omission preserves historical source lowering.
   */
  readonly promiseDelayProjection?: "disabled" | "standalone-native";
  /** Explicit full-family logical lowering; never inferred from target or fast/default settings. */
  readonly asyncFamilyProjection?: "disabled" | "standalone-native";
  /** Explicit frontend string-number lowering; not provider availability or permission to emit. */
  readonly nativeStringValueProjection?: "standalone-native";
  /** Independent string-only console intents; no async family or runtime availability is implied. */
  readonly nativeStringOutputProjection?: "standalone-native";
}

/** Frontend-only carrier; declarations never cross into PreparedIrProgram. */
export interface IrProgramSourcePreparation {
  readonly kind: "prepared";
  readonly sourceMap?: IrPreparedSourceMap;
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly startup: readonly IrModuleInitPlan[];
  readonly callables: readonly IrProgramCallableBindingRecord[];
  readonly globals: readonly { readonly binding: ModuleBindingGlobal; readonly identity: IrModuleBindingIdentity }[];
  readonly allocations: AllocSiteRegistry;
}

/** Read only an explicitly selected own data field; never evaluate a getter. */
function sourceDataField<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor))
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `source capture requires own data field ${String(key)}`,
    );
  return descriptor.value;
}

/** Explicit frontend projection; capture all semantic fields jointly with allocations. */
export function captureTypedIrProgramInput(
  source: IrProgramSourcePreparation,
  runtimeSupport?: TypedIrProgramInput["runtimeSupport"],
): TypedIrProgramInput {
  const allocations = sourceDataField(source, "allocations");
  const inventory = sourceDataField(source, "inventory");
  const ir = sourceDataField(source, "ir");
  const derivedUnits = sourceDataField(source, "derivedUnits");
  const startup = sourceDataField(source, "startup");
  const callables = sourceDataField(source, "callables");
  const sourceGlobals = sourceDataField(source, "globals");
  const sourceMap = Object.hasOwn(source, "sourceMap") ? sourceDataField(source, "sourceMap") : undefined;
  if (Object.hasOwn(source, "sourceMap") && sourceMap === undefined)
    sourceMapCaptureInvalid("present source map must contain a catalog");
  if (!Array.isArray(sourceGlobals) || Object.getPrototypeOf(sourceGlobals) !== Array.prototype)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "source capture requires an ordinary globals array",
    );
  const length = sourceDataField(sourceGlobals, "length");
  for (const key of Reflect.ownKeys(sourceGlobals)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "source capture cannot omit extra globals array properties",
      );
  }
  const globals: TypedIrProgramInput["globals"][number][] = [];
  for (let index = 0; index < length; index++) {
    const entry = sourceDataField(sourceGlobals, index);
    const binding = sourceDataField(entry, "binding");
    const identity = sourceDataField(entry, "identity");
    globals.push({
      binding: {
        globalRef: sourceDataField(binding, "globalRef"),
        tdzGlobalRef: sourceDataField(binding, "tdzGlobalRef"),
        type: sourceDataField(binding, "type"),
      },
      identity: {
        sourceId: sourceDataField(identity, "sourceId"),
        storageOwnerUnitId: sourceDataField(identity, "storageOwnerUnitId"),
      },
    });
  }
  const captured = allocations.capturePreparationData({
    inventory,
    ir,
    derivedUnits,
    startup,
    callables,
    globals,
    ...(sourceMap === undefined ? {} : { sourceMap }),
    ...(runtimeSupport === undefined ? {} : { runtimeSupport }),
  });
  const typed: TypedIrProgramInput = {
    inventory: captured.data.inventory,
    ir: captured.data.ir,
    derivedUnits: captured.data.derivedUnits,
    startup: captured.data.startup,
    callables: captured.data.callables,
    globals: captured.data.globals,
    allocations: captured.allocations,
    ...(captured.data.sourceMap === undefined ? {} : { sourceMap: captured.data.sourceMap }),
    ...(captured.data.runtimeSupport === undefined ? {} : { runtimeSupport: captured.data.runtimeSupport }),
  };
  if (sourceMap !== undefined) assertPreparedSourceMap(typed);
  return typed;
}

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", detail);
}

function checkerScalar(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "val", val: { kind: "f64" } };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "val", val: { kind: "i32", boolean: true } };
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
  return undefined;
}

/** Shared logical callable conversion; this does not issue a physical carrier. */
function checkerCallableType(checker: ts.TypeChecker, input: ts.Type, where: string): IrType | null {
  const active = new Set<ts.Type>();
  const convert = (type: ts.Type): IrType | null => {
    if ((type.flags & ts.TypeFlags.Void) !== 0) return null;
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "val", val: { kind: "f64" } };
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "val", val: { kind: "i32", boolean: true } };
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
    if (active.has(type)) unsupported(`callable annotation in ${where} has a recursive anonymous contract`);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (signatures.length !== 1 || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length)
      unsupported(`callable annotation in ${where} requires one non-constructing call signature`);
    const signature = signatures[0]!;
    if (signature.typeParameters?.length || signature.thisParameter)
      unsupported(`callable annotation in ${where} has unsupported generic/this parameters`);
    active.add(type);
    try {
      const params = signature.parameters.map((symbol) => {
        const declaration = symbol.valueDeclaration;
        if (
          !declaration ||
          !ts.isParameter(declaration) ||
          !declaration.type ||
          declaration.dotDotDotToken ||
          declaration.questionToken ||
          declaration.initializer ||
          (symbol.flags & ts.SymbolFlags.Optional) !== 0
        )
          unsupported(`callable annotation in ${where} requires exact required parameter declarations`);
        const value = convert(checker.getTypeOfSymbolAtLocation(symbol, declaration));
        if (!value) unsupported(`callable annotation in ${where} cannot use a void parameter`);
        return value;
      });
      return {
        kind: "callable",
        signature: { params, returnType: convert(checker.getReturnTypeOfSignature(signature)) },
      };
    } finally {
      active.delete(type);
    }
  };
  return convert(input);
}

/** Checker-certified callable annotations; no physical carrier or provider is inferred. */
function checkerCallable(checker: ts.TypeChecker, node: ts.TypeNode, where: string): IrType | undefined {
  const declared = checker.getTypeFromTypeNode(node);
  if (!checker.getSignaturesOfType(declared, ts.SignatureKind.Call).length) return undefined;
  const result = checkerCallableType(checker, declared, where);
  const observed = checkerCallableType(checker, checker.getTypeAtLocation(node), where);
  if (!result || preparedIrDataMismatch(result, observed) !== undefined)
    unsupported(`callable annotation in ${where} disagrees with its checker contract`);
  return result;
}

/** Preserve a real inferred callable return instead of the scalar lattice's null fallback. */
function checkerInferredCallableResult(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  where: string,
): IrType | undefined {
  if (
    declaration.type ||
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return undefined;
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) return undefined;
  const type = checker.getReturnTypeOfSignature(signature);
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  if (!parts.some((part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call).length)) return undefined;
  if (type.isUnionOrIntersection()) unsupported(`inferred callable result in ${where} has an ambiguous contract`);
  const result = checkerCallableType(checker, type, where);
  if (result?.kind !== "callable") unsupported(`inferred callable result in ${where} lost its checker contract`);
  return result;
}

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

function hostPromiseFulfillment(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const ambient = checker.resolveName("Promise", undefined, ts.SymbolFlags.Type, false);
  if (
    !ambient?.declarations?.length ||
    !ambient.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  )
    return undefined;
  // Checking the resolved symbol admits aliases, but not source classes or structural thenables.
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.getSymbol() !== ambient) return undefined;
  const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
  return arguments_.length === 1 ? arguments_[0] : undefined;
}

/** Preserve logical any independently of a typed Promise's host callable carrier. */
function hostAsyncParameter(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): IrType | undefined {
  if (!parameter.type) return undefined;
  const declared = checker.getTypeFromTypeNode(parameter.type);
  if (declared === checker.getAnyType()) return checkerAny(checker, parameter.name);
  for (const type of [declared, checker.getTypeAtLocation(parameter.name)]) {
    const fulfillment = hostPromiseFulfillment(checker, type);
    if (!fulfillment || (fulfillment.flags & ts.TypeFlags.NumberLike) === 0) return undefined;
  }
  return { kind: "val", val: { kind: "externref" } };
}

function hostAsyncAnyResult(checker: ts.TypeChecker, declaration: ts.FunctionDeclaration): IrType | undefined {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) return undefined;
  if (hostPromiseFulfillment(checker, checker.getReturnTypeOfSignature(signature)) !== checker.getAnyType())
    return undefined;
  if (
    declaration.type &&
    hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== checker.getAnyType()
  )
    return undefined;
  return { kind: "dynamic" };
}

function storageType(identity: IrModuleBindingIdentity): IrType {
  const value = identity.valueKind;
  switch (value.kind) {
    case "f64":
      return { kind: "val", val: { kind: "f64" } };
    case "i32":
      return { kind: "val", val: { kind: "i32", boolean: true } };
    case "string":
      return { kind: "string" };
    case "dynamic":
      return { kind: "dynamic" };
    default:
      return unsupported(`whole-program source storage has no typed carrier for ${value.kind}`);
  }
}

/** Validate the explicit source request before inventory construction or source planning. */
function selectNativePromiseDelaySourceProjection(
  input: Pick<IrProgramSourceInput, "promiseDelayProjection" | "policy">,
): boolean {
  const projection = input.promiseDelayProjection;
  const nativeDelay = projection === "standalone-native";
  if (
    (projection !== undefined && projection !== "disabled" && !nativeDelay) ||
    (nativeDelay && (input.policy.backend !== "wasmgc" || input.policy.target !== "standalone"))
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "Promise-delay source projection requires an explicit standalone-native request with wasmgc:standalone policy",
    );
  return nativeDelay;
}

/** Validate full-family selection independently from delay selection and runtime availability. */
function selectNativeAsyncFamilyProjection(input: IrProgramSourceInput): boolean {
  const projection = input.asyncFamilyProjection;
  if (projection === undefined || projection === "disabled") return false;
  if (
    projection !== "standalone-native" ||
    input.promiseDelayProjection !== "standalone-native" ||
    input.policy.backend !== "wasmgc" ||
    input.policy.target !== "standalone"
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native async family source projection requires explicit native delay and wasmgc:standalone policy",
    );
  return true;
}

/** Resolve before source planning; never infer string-number lowering from the target. */
function selectNativeStringValueProjection(
  input: Pick<IrProgramSourceInput, "nativeStringValueProjection" | "policy">,
): boolean {
  const projection = input.nativeStringValueProjection;
  if (projection === undefined) return false;
  if (projection !== "standalone-native" || input.policy.backend !== "wasmgc" || input.policy.target !== "standalone")
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native string-value source projection requires an explicit standalone-native request with wasmgc:standalone policy",
    );
  return true;
}

function selectNativeStringOutputProjection(
  input: Pick<IrProgramSourceInput, "nativeStringOutputProjection" | "policy">,
): boolean {
  const nativeStringOutput = input.nativeStringOutputProjection !== undefined;
  if (
    nativeStringOutput &&
    (input.nativeStringOutputProjection !== "standalone-native" ||
      input.policy.backend !== "wasmgc" ||
      input.policy.target !== "standalone" ||
      input.policy.stringConst?.storage !== "native" ||
      input.policy.stringConcat?.concat !== "native")
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native string output projection requires explicit standalone WasmGC native string policies",
    );
  return nativeStringOutput;
}

/** Mutable diagnostic cursor shared by source planning and its validation helpers. */
interface SourceDiagnosticOwner {
  active: IrUnitId | undefined;
}

/** Frontend-only certificates and independent pre-lowering identity receipts. */
interface NativePromiseDelaySourcePlans {
  readonly promiseDelaysBySource: Map<ts.SourceFile, IrPromiseDelayLoweringPlans>;
  readonly promiseDelayPopulations: Map<
    ts.SourceFile,
    {
      readonly maps: IrPromiseDelayLoweringPlans;
      readonly constructions: readonly (readonly [ts.NewExpression, IrPromiseDelayLoweringPlan])[];
      readonly timers: readonly (readonly [ts.CallExpression, IrPromiseDelayLoweringPlan])[];
      readonly resolves: readonly (readonly [ts.CallExpression, IrPromiseDelayLoweringPlan])[];
      readonly support: ReturnType<typeof validateNativePromiseDelaySupportByIdentity>;
    }
  >;
  readonly certifiedDelays: Map<IrUnitId, IrPromiseDelayLoweringPlan>;
  readonly supportReceipts: Map<IrUnitId, readonly (readonly [string, unknown])[]>;
}

/** Certify exact native-delay owners and retain their original maps and support population. */
function prepareNativePromiseDelaySourcePlans(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  inventory: IrUnitInventory,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  delayPlans: NativePromiseDelaySourcePlans,
  diagnostic: SourceDiagnosticOwner,
): void {
  const { promiseDelaysBySource, promiseDelayPopulations, certifiedDelays, supportReceipts } = delayPlans;
  const delayResolver = makeIrPromiseDelayResolver(checker);
  for (const sourceFile of sourceFiles) {
    const sourceId = identity.sourceIdBySourceFile.get(sourceFile)!;
    const selected = new Set(
      inventory.terminalUnits
        .filter((unit) => {
          const declaration = identity.declarationByUnitId.get(unit.id);
          return (
            unit.sourceId === sourceId &&
            unit.kind !== "module-init" &&
            declaration !== undefined &&
            ts.isFunctionDeclaration(declaration) &&
            declaration.parent === sourceFile &&
            declaration.body !== undefined
          );
        })
        .map((unit) => unit.id),
    );
    diagnostic.active = selected.values().next().value ?? identity.moduleInitUnitIdBySourceFile.get(sourceFile);
    const owners = collectIrPromiseDelayOwners(sourceFile, selected, delayResolver, identity);
    const plans = buildIrPromiseDelayLoweringPlans(owners, selected, identity, "standalone-native");
    const support = validateNativePromiseDelaySupportByIdentity(sourceFile, identity, plans);
    promiseDelaysBySource.set(sourceFile, plans);
    // Snapshot the admitted population independently of the mutable maps
    // passed to lowering. Revalidating emptied maps alone proves nothing.
    promiseDelayPopulations.set(sourceFile, {
      maps: { constructions: plans.constructions, timers: plans.timers, resolves: plans.resolves },
      constructions: [...plans.constructions],
      timers: [...plans.timers],
      resolves: [...plans.resolves],
      support: [...support],
    });
    for (const plan of plans.constructions.values()) certifiedDelays.set(plan.ownerUnitId, plan);
    for (const unit of support) supportReceipts.set(unit.id, Object.entries(unit));
  }
}

/** Revalidate certificates after lowering, then reject semantic references to elided support. */
function validateNativePromiseDelaySourceLowering(
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  delayPlans: NativePromiseDelaySourcePlans,
  lowered: Omit<IrProgramSourcePreparation, "kind" | "inventory" | "ir"> & {
    readonly functions: readonly IrFunction[];
  },
  diagnostic: SourceDiagnosticOwner,
): void {
  const { promiseDelaysBySource, promiseDelayPopulations, certifiedDelays, supportReceipts } = delayPlans;
  const { functions, derivedUnits, callables, startup, globals, allocations } = lowered;
  for (const [source, plans] of promiseDelaysBySource) {
    const saved = promiseDelayPopulations.get(source)!;
    const requireRetainedPlans = <TNode extends ts.Node>(
      current: ReadonlyMap<TNode, IrPromiseDelayLoweringPlan>,
      original: ReadonlyMap<TNode, IrPromiseDelayLoweringPlan>,
      entries: readonly (readonly [TNode, IrPromiseDelayLoweringPlan])[],
    ): void => {
      diagnostic.active = entries[0]?.[1].ownerUnitId ?? identity.moduleInitUnitIdBySourceFile.get(source);
      if (current !== original || current.size !== entries.length)
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "certified Promise-delay plan population changed during lowering",
        );
      for (const [key, plan] of entries) {
        diagnostic.active = plan.ownerUnitId;
        if (current.get(key) !== plan)
          throw new PreparedIrProgramInvariantError(
            "invalid-prepared-data",
            "certified Promise-delay plan identity changed during lowering",
          );
      }
    };
    requireRetainedPlans(plans.constructions, saved.maps.constructions, saved.constructions);
    requireRetainedPlans(plans.timers, saved.maps.timers, saved.timers);
    requireRetainedPlans(plans.resolves, saved.maps.resolves, saved.resolves);
    const retainedSupport = validateNativePromiseDelaySupportByIdentity(source, identity, plans);
    if (
      retainedSupport.length !== saved.support.length ||
      retainedSupport.some((unit, index) => unit !== saved.support[index])
    )
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "certified Promise-delay support population changed during lowering",
      );
    for (const unit of retainedSupport) {
      diagnostic.active = unit.terminalOwnerId;
      const before = supportReceipts.get(unit.id);
      const after = Object.entries(unit);
      if (
        !before ||
        before.length !== after.length ||
        before.some(([key, value], index) => after[index]?.[0] !== key || after[index]?.[1] !== value)
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `native Promise-delay support ${unit.id} changed during lowering`,
        );
    }
  }
  const forbidden = new Set<string>(supportReceipts.keys());
  for (const plan of certifiedDelays.values()) {
    for (const target of [plan.executorTarget, plan.timerTarget]) {
      if (target.binding.kind === "unit") forbidden.add(target.binding.unitId);
    }
  }
  // Walk the complete graph (including nested/provider references), but only
  // interpret structural unit bindings and explicit ownership/provenance
  // positions as references. String constants and diagnostic names are data.
  const seen = new Set<object>();
  const reference = (value: unknown): void => {
    if (typeof value === "string" && forbidden.has(value))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `native Promise-delay retains a reference to elided support ${value}`,
      );
  };
  const inspect = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const fields = Object.getOwnPropertyDescriptors(value);
    const children: unknown[] = [];
    for (const key of Reflect.ownKeys(fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor))
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "native Promise-delay semantic graph contains an accessor",
        );
      children.push(descriptor.value);
    }
    if (fields.kind?.value === "unit") reference(fields.unitId?.value);
    if (fields.kind?.value === "async-function") reference(fields.ownerUnitId?.value);
    if (fields.kind?.value === "fnctor-shape") {
      reference(fields.constructorUnitId?.value);
      const constructorIdentity = fields.constructorIdentity?.value;
      if (constructorIdentity !== null && typeof constructorIdentity === "object")
        reference(Object.getOwnPropertyDescriptor(constructorIdentity, "unitId")?.value);
    }
    // IrClassMethodDescriptor.placement and IrDomCallbackAuthority are
    // typed ownership records, unlike the surrounding compatibility names.
    for (const [key, ownerKey] of [
      ["placement", "unitId"],
      ["domCallbackAuthority", "ownerUnitId"],
    ] as const) {
      const record = fields[key]?.value;
      if (record !== null && typeof record === "object")
        reference(Object.getOwnPropertyDescriptor(record, ownerKey)?.value);
    }
    if (value instanceof Map)
      for (const [key, item] of value) {
        inspect(key);
        inspect(item);
      }
    if (value instanceof Set) for (const item of value) inspect(item);
    for (const child of children) inspect(child);
  };
  for (const fn of functions) {
    diagnostic.active = fn.unitId;
    reference(fn.unitId);
    inspect(fn);
  }
  for (const unit of derivedUnits) {
    diagnostic.active = unit.terminalOwnerId ?? undefined;
    reference(unit.id);
    reference(unit.parentId);
    reference(unit.terminalOwnerId);
    if (certifiedDelays.has(unit.parentId))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `certified native Promise-delay ${unit.parentId} fabricated support provenance`,
      );
    inspect(unit);
  }
  for (const binding of callables) {
    diagnostic.active = binding.targetUnitId;
    reference(binding.targetUnitId);
  }
  for (const plan of startup) {
    diagnostic.active = plan.unitId ?? undefined;
    reference(plan.unitId);
    for (const seed of plan.liveSeeds) reference(seed.unitId);
  }
  for (const global of globals) {
    diagnostic.active = global.identity.storageOwnerUnitId;
    reference(global.identity.ownerUnitId);
    reference(global.identity.storageOwnerUnitId);
    reference(global.binding.ownerUnitId);
    inspect(global.binding);
  }
  diagnostic.active ??= certifiedDelays.keys().next().value;
  inspect(allocations.snapshot());
}

/** Keep callable carriers separate from semantic fulfillment signatures. */
function prepareSourceFunctionSignatures(
  checker: ts.TypeChecker,
  policy: RuntimeManifestPolicy,
  inventory: IrUnitInventory,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  types: ReturnType<typeof buildIrUnitTypeMap>,
  certifiedDelays: NativePromiseDelaySourcePlans["certifiedDelays"],
  nativeFamily: NativeAsyncSourceFamilies | undefined,
  signatures: Map<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>,
  bodyResults: Map<IrUnitId, IrType | null>,
  diagnostic: SourceDiagnosticOwner,
): void {
  for (const unit of inventory.terminalUnits) {
    diagnostic.active = unit.id;
    if (unit.kind === "module-init") continue;
    const declaration = identity.declarationByUnitId.get(unit.id);
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body)
      unsupported(`whole-program source producer has no body producer for ${unit.kind}`);
    const propagated = types.get(unit.id);
    const family = nativeFamily?.functions.get(unit.id);
    const isAsync = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const hostAsync = isAsync && policy.backend === "wasmgc" && policy.target === "host";
    const params =
      family?.params ??
      declaration.parameters.map((param, index) =>
        param.type
          ? ((hostAsync ? hostAsyncParameter(checker, param) : undefined) ??
            checkerCallable(checker, param.type, unit.displayName) ??
            typeNodeToIr(param.type, unit.displayName))
          : propagated?.params[index]
            ? lowerTypeToIrType(propagated.params[index]!)
            : checkerScalar(checker, param),
      );
    if (params.some((type) => !type)) unsupported(`function ${unit.displayName} has an unresolved parameter contract`);
    const returnNode = isAsync ? unwrapPromiseTypeNode(declaration.type) : declaration.type;
    const dynamicResult = hostAsync ? hostAsyncAnyResult(checker, declaration) : undefined;
    const result: IrType | null = certifiedDelays.has(unit.id)
      ? { kind: "extern", className: "Promise" }
      : family
        ? family.result
        : dynamicResult
          ? dynamicResult
          : returnNode?.kind === ts.SyntaxKind.VoidKeyword
            ? null
            : !isAsync &&
                returnNode &&
                ts.isTypeReferenceNode(returnNode) &&
                ts.isIdentifier(returnNode.typeName) &&
                returnNode.typeName.text === "Promise"
              ? { kind: "val", val: { kind: "externref" } }
              : returnNode
                ? (sourceBooleanAnyResult(checker, declaration) ??
                  checkerCallable(checker, returnNode, unit.displayName) ??
                  typeNodeToIr(returnNode, unit.displayName))
                : (checkerInferredCallableResult(checker, declaration, unit.displayName) ??
                  (propagated ? lowerTypeToIrType(propagated.returnType) : null));
    bodyResults.set(unit.id, result);
    const callableResults = preparedIrProgramCallableResults({
      funcKind: isAsync ? "async" : "regular",
      resultTypes: result ? [result] : [],
    });
    signatures.set(unit.id, { params: params as IrType[], returnType: callableResults[0] ?? null });
  }
}

/** Build each original source body once, before any backend context or allocator exists. */
/** Combine source-owned call/read plans; no physical provider is selected here. */
function prepareSourceBuiltinResolvers(
  input: IrProgramSourceInput,
  roots: ts.FunctionDeclaration | readonly ts.Statement[],
) {
  return {
    ...prepareNumberConversionResolver(input.checker, input.sourceFiles, roots),
    ...prepareOrdinaryObjectAccessResolver(input.checker, input.sourceFiles, roots),
    ...(input.policy.target === "standalone" && input.policy.backend === "wasmgc"
      ? prepareObjectCreateResolver(input.checker, input.sourceFiles, roots)
      : {}),
  };
}

/** Preserve exact original lifted provenance before admitting derived records. */
function appendLiftedSourceProvenance(
  provenanceRecords: ReturnType<typeof lowerFunctionAstToIr>["liftedUnitProvenance"],
  inventory: IrUnitInventory,
  unit: IrUnitInventory["terminalUnits"][number],
  derivedUnits: ProgramAbiDerivedUnitRecord[],
): void {
  for (const provenance of provenanceRecords) {
    if ("sourceUnit" in provenance) {
      const sourceUnit = inventory.allUnits.find((record) => record.id === provenance.id);
      if (
        !sourceUnit ||
        sourceUnit.sourceId !== unit.sourceId ||
        sourceUnit.lexicalOwnerId !== provenance.parentId ||
        sourceUnit.ordinal !== provenance.ordinal
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `lifted source ${provenance.id} contradicts the original inventory`,
        );
    } else derivedUnits.push({ ...provenance, sourceId: unit.sourceId, terminalOwnerId: unit.id });
  }
}

function selectSourceMapCapture(input: IrProgramSourceInput): IrSourceMapCaptureRequest | undefined {
  const mapDescriptor = Object.getOwnPropertyDescriptor(input, "sourceMap");
  if (mapDescriptor && !("value" in mapDescriptor)) sourceMapCaptureInvalid("source map request must be own data");
  const sourceMapRequest: IrSourceMapCaptureRequest | undefined = mapDescriptor?.value;
  if (mapDescriptor) {
    sourceMapCaptureFields(sourceMapRequest, ["kind", "sources"]);
    sourceMapPreflightSources(input.sourceFiles);
  }
  return sourceMapRequest;
}

function appendSourceMapDerivedRows(
  rows: Map<IrUnitId, IrSourceMapDerivedSource>,
  lowered: ReturnType<typeof lowerFunctionAstToIr>,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  unit: IrUnitInventory["terminalUnits"][number],
): void {
  for (const row of lowered.sourceMapDerivedSources ?? []) {
    const provenance = lowered.liftedUnitProvenance.find(
      (record) => record.id === row.unitId && !("sourceUnit" in record),
    );
    const donor = identity.unitByUnitId.get(row.donorUnitId);
    if (
      rows.has(row.unitId) ||
      !provenance ||
      !lowered.lifted.some((fn) => fn.unitId === row.unitId) ||
      !donor ||
      donor.sourceId !== unit.sourceId
    )
      sourceMapCaptureInvalid("derived source row differs from actual lifted original-declaration join");
    rows.set(row.unitId, row);
  }
}

function finishSourceMapCatalog(
  projector: ReturnType<typeof createSourceMapProjector>,
  rows: Map<IrUnitId, IrSourceMapDerivedSource>,
  derivedUnits: readonly ProgramAbiDerivedUnitRecord[],
): IrPreparedSourceMap {
  const ordered = derivedUnits.flatMap((record) => {
    const row = rows.get(record.id);
    return row === undefined ? [] : [row];
  });
  if (ordered.length !== rows.size) sourceMapCaptureInvalid("unused derived source row has no actual derived record");
  return freezePreparedIrRuntimeValue<IrPreparedSourceMap>({
    ...projector.sourceMap,
    ...(ordered.length === 0 ? {} : { derivedSources: ordered }),
  });
}

function prepareStartupDirectCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  startup: readonly IrModuleInitPlan[],
  signatures: ReadonlyMap<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>,
  directCalls: Map<ts.CallExpression, IrDirectCallLoweringPlan>,
  diagnostic: SourceDiagnosticOwner,
): void {
  const callableResolver = makeIrIdentityImportedFunctionResolver(checker, sourceFiles, identity);
  for (const plan of startup) {
    if (!plan.unitId) continue;
    diagnostic.active = plan.unitId;
    const ownerUnitId = plan.unitId;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const target =
          callableResolver.resolveImportedFunctionTarget(node.expression) ??
          callableResolver.resolveTopLevelFunctionValueTarget(node.expression);
        if (target) {
          const signature = signatures.get(target.targetUnitId);
          if (!signature) unsupported(`startup call ${target.targetUnitId} has no complete declared contract`);
          directCalls.set(node, {
            ownerUnitId,
            target: irUnitFuncRef({ unitId: target.targetUnitId, name: target.targetName }),
            signature,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of identity.moduleInitPopulationBySourceFile.get(
      identity.sourceFileBySourceId.get(plan.sourceId)!,
    ) ?? [])
      visit(statement);
  }
}

export function prepareIrProgramSources(
  input: IrProgramSourceInput,
): IrProgramSourcePreparation | PreparedIrProgramFailure {
  const sourceMapRequest = selectSourceMapCapture(input);
  const nativeDelay = selectNativePromiseDelaySourceProjection(input);
  const nativeAsyncFamily = selectNativeAsyncFamilyProjection(input);
  const nativeStringValues = selectNativeStringValueProjection(input);
  const nativeStringOutput = selectNativeStringOutputProjection(input);
  const inventory = buildIrUnitInventory(input.sourceFiles, {
    ...input.inventoryOptions,
    entrySource: input.entrySource,
    checker: input.checker,
  });
  if (sourceMapRequest !== undefined) sourceMapPreflightScannerTree(inventory);
  const identity = buildIrPlanningIdentityContext(inventory);
  const sourceFiles = inventory.sources.map((source) => identity.sourceFileBySourceId.get(source.id)!);
  const sourceMapCatalog =
    sourceMapRequest === undefined
      ? undefined
      : buildPreparedSourceMapCatalog(sourceFiles, inventory, sourceMapRequest, identity);
  const derivedSourceRows = sourceMapRequest === undefined ? undefined : new Map<IrUnitId, IrSourceMapDerivedSource>();
  const startup: IrModuleInitPlan[] = [];
  const allocations = new AllocSiteRegistry();
  const functions: IrFunction[] = [];
  const derivedUnits: ProgramAbiDerivedUnitRecord[] = [];
  const globals: IrProgramSourcePreparation["globals"][number][] = [];
  const globalByDeclaration = new Map<ts.Declaration, IrProgramSourcePreparation["globals"][number]>();
  const signatures = new Map<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>();
  const bodyResults = new Map<IrUnitId, IrType | null>();
  const delayPlans: NativePromiseDelaySourcePlans = {
    promiseDelaysBySource: new Map(),
    promiseDelayPopulations: new Map(),
    certifiedDelays: new Map(),
    supportReceipts: new Map(),
  };
  const { promiseDelaysBySource, certifiedDelays } = delayPlans;
  const diagnostic: SourceDiagnosticOwner = { active: undefined };
  try {
    const types = buildIrUnitTypeMap(sourceFiles, input.checker, identity);
    const callGraph = buildIrProgramCallableBindingGraph({
      checker: input.checker,
      sourceFiles,
      identityContext: identity,
    });
    const moduleResolver = makeIrIdentityModuleBindingResolver(
      input.checker,
      {
        numberStorage: "f64",
        allowHostExterns: input.policy.target === "host",
        allowBuiltinMapExtern: input.policy.target === "host" && input.policy.stringConst?.storage !== "native",
        allowNativeMapStorage: input.policy.stringConst?.storage === "native",
        oracle: input.oracle,
      },
      identity,
    );
    for (const sourceFile of sourceFiles) {
      diagnostic.active = identity.moduleInitUnitIdBySourceFile.get(sourceFile);
      startup.push(
        buildIrModuleInitPlan({
          sourceFile,
          checker: input.checker,
          identityContext: identity,
          target: input.policy.target === "strict-no-host" ? "standalone" : input.policy.target,
          deferTopLevelInit: input.deferTopLevelInit,
        }),
      );
    }
    const sourceMapProjector =
      sourceMapCatalog === undefined
        ? undefined
        : createSourceMapProjector(inventory, sourceMapCatalog, sourceMapStartupOccurrences(identity, startup));
    const sourceMapSources =
      sourceMapProjector === undefined
        ? undefined
        : new Map(sourceMapProjector.sourceMap.sources.map((row) => [row.sourceId, row]));
    const entryId = identity.sourceIdBySourceFile.get(input.entrySource)!;
    diagnostic.active = undefined;
    const postStartupUnits = postStartupCallableUnits(input.checker, identity, startup);
    const exportedBindings = new Set(
      startup
        .find((plan) => plan.sourceId === entryId)!
        .exports.flatMap((entry) => (entry.targetBindingId ? [entry.targetBindingId] : [])),
    );
    const exportedUnits = new Set(
      callGraph.records
        .filter((record) => record.sourceId === entryId && record.kind === "export-alias")
        .map((record) => record.targetUnitId),
    );
    for (const unit of inventory.terminalUnits)
      if (exportedBindings.has(irUnitCallableBindingId(unit.id))) exportedUnits.add(unit.id);
    if (nativeDelay)
      prepareNativePromiseDelaySourcePlans(input.checker, sourceFiles, inventory, identity, delayPlans, diagnostic);
    const nativeFamily = nativeAsyncFamily
      ? prepareNativeAsyncSourceFamilies({ checker: input.checker, identity, callGraph, certifiedDelays, diagnostic })
      : undefined;
    prepareSourceFunctionSignatures(
      input.checker,
      input.policy,
      inventory,
      identity,
      types,
      certifiedDelays,
      nativeFamily,
      signatures,
      bodyResults,
      diagnostic,
    );
    for (const source of sourceFiles) {
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          diagnostic.active = requireIrPlanningOwnerUnitId(identity, declaration);
          if (!ts.isIdentifier(declaration.name))
            unsupported("whole-program binding pattern requires the existing destructuring producer");
          const inspected = moduleResolver.inspectDirectBinding(declaration.name);
          if (inspected.kind !== "supported")
            unsupported(`module binding ${declaration.name.text} has no exact typed storage: ${inspected.kind}`);
          const global = inspected.identity;
          diagnostic.active = global.storageOwnerUnitId;
          const lexical = (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
          const binding: ModuleBindingGlobal = {
            ownerUnitId: global.ownerUnitId,
            globalRef: irSourceGlobalRef(global.globalBindingId, declaration.name.text),
            tdzGlobalRef: lexical ? irSourceGlobalRef(global.tdzBindingId, `${declaration.name.text}$tdz`) : null,
            globalName: declaration.name.text,
            tdzGlobalName: lexical ? `${declaration.name.text}$tdz` : null,
            type: storageType(global),
          };
          const entry = { binding, identity: global };
          globals.push(entry);
          globalByDeclaration.set(declaration, entry);
        }
      }
    }
    const closureInvocations = prepareSourceClosureInvocations(input.checker, sourceFiles);
    const closureCallableParameters = new Set(
      [...closureInvocations.values()].flatMap((plan) => plan.callbacks.map((row) => row.parameter.type)),
    );
    const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
    for (const use of callGraph.uses) {
      diagnostic.active = use.ownerUnitId;
      const signature = signatures.get(use.targetUnitId);
      const target = identity.terminalByUnitId.get(use.targetUnitId);
      if (!signature || !target) unsupported(`direct call ${use.bindingId} has no complete target contract`);
      directCalls.set(use.node, {
        ownerUnitId: use.ownerUnitId,
        target: irUnitFuncRef({ unitId: use.targetUnitId, name: target.displayName }),
        signature,
      });
    }
    prepareStartupDirectCalls(input.checker, sourceFiles, identity, startup, signatures, directCalls, diagnostic);
    for (const unit of inventory.terminalUnits) {
      diagnostic.active = unit.id;
      if (functions.some((fn) => fn.unitId === unit.id)) continue;
      const family = nativeFamily?.functions.get(unit.id);
      if (family) nativeFamily!.assertCurrent(unit.id);
      const resolveBinding = (node: ts.Identifier, writeValue?: ts.Expression): ModuleBindingGlobal | undefined => {
        let symbol = input.checker.getSymbolAtLocation(node);
        if (!symbol) return undefined;
        const imported = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
        if (imported) symbol = input.checker.getAliasedSymbol(symbol);
        const declaration = symbol.valueDeclaration;
        const global = declaration ? globalByDeclaration.get(declaration) : undefined;
        if (!global) return undefined;
        if (writeValue && (imported || !global.identity.mutable))
          unsupported(`write to immutable module binding ${node.text}`);
        return {
          ...global.binding,
          ownerUnitId: unit.id,
          ...(postStartupUnits.has(unit.id) ? { omitTdzReadCheck: true as const } : {}),
        };
      };
      const resolver: IrFromAstResolver = {
        sourceClosureInvocation: (expression) => closureInvocations.get(expression),
        sourceClosureCallableParameter: (node) => closureCallableParameters.has(node),
        resolveModuleBinding: resolveBinding,
        preparedAsyncAwaitSite: (awaitExpression) => {
          const host = input.policy.backend === "wasmgc" && input.policy.target === "host";
          const resultType =
            (host ? checkerAny(input.checker, awaitExpression) : undefined) ??
            checkerScalar(input.checker, awaitExpression);
          const operandType = (host ? checkerAny(input.checker, awaitExpression.expression) : undefined) ??
            checkerScalar(input.checker, awaitExpression.expression) ?? {
              kind: "val" as const,
              val: { kind: "externref" as const },
            };
          return resultType ? { resultType, operandType } : null;
        },
        ...family?.resolver,
      };
      const source = identity.sourceFileBySourceId.get(unit.sourceId)!;
      const moduleInit = unit.kind === "module-init";
      const declaration = moduleInit
        ? makeModuleInitSynthetic(identity.moduleInitPopulationBySourceFile.get(source) ?? [])
        : identity.declarationByUnitId.get(unit.id)!;
      if (!ts.isFunctionDeclaration(declaration)) unsupported(`missing declaration producer for ${unit.kind}`);
      Object.assign(
        resolver,
        prepareSourceBuiltinResolvers(
          input,
          moduleInit ? (identity.moduleInitPopulationBySourceFile.get(source) ?? []) : declaration,
        ),
      );
      const signature = signatures.get(unit.id);
      const lowered = lowerFunctionAstToIr(declaration, {
        booleanReturnBoundary: sourceBooleanAnyResult(input.checker, declaration) ? declaration : undefined,
        ownerUnitId: unit.id,
        ...(sourceMapProjector === undefined
          ? {}
          : {
              sourceMap: Object.freeze<IrFunctionSourceMapContext>({
                source: sourceMapSources!.get(unit.sourceId)!,
                donorUnitId: unit.id,
                project: sourceMapProjector.project,
              }),
            }),
        funcName: unit.displayName,
        exported: exportedUnits.has(unit.id),
        identityContext: identity,
        checker: input.checker,
        oracle: input.oracle,
        allocRegistry: allocations,
        directCalls,
        resolver:
          nativeStringOutput && !family
            ? { ...resolver, ...prepareNativeStringOutputResolver(input.checker, declaration) }
            : resolver,
        ...(nativeStringValues ? { stringNumericCoercion: "number-boundary" as const } : {}),
        numericThrow: "number-boundary",
        ...(nativeDelay ? { promiseDelays: promiseDelaysBySource.get(source) } : {}),
        ...(family ? { logicalVectorTypes: family.logicalVectorTypes } : {}),
        ...(moduleInit
          ? {
              moduleInitUnit: true,
              returnTypeOverride: null,
              moduleBindings: new Map(
                globals
                  .filter((global) => global.identity.sourceId === unit.sourceId)
                  .map((global) => [global.binding.globalName, { ...global.binding, ownerUnitId: unit.id }]),
              ),
            }
          : { paramTypeOverrides: signature!.params, returnTypeOverride: bodyResults.get(unit.id)! }),
        numericLocalScalarForDecl: (declaration) =>
          checkerScalar(input.checker, declaration)?.kind === "val" &&
          (input.checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.NumberLike) !== 0
            ? "number"
            : undefined,
      });
      assertSourceBooleanAnyReturns(input.checker, declaration, lowered.main);
      if (certifiedDelays.has(unit.id) && (lowered.lifted.length !== 0 || lowered.liftedUnitProvenance.length !== 0))
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `certified native Promise-delay ${unit.id} fabricated support bodies or provenance`,
        );
      functions.push(lowered.main, ...lowered.lifted);
      appendLiftedSourceProvenance(lowered.liftedUnitProvenance, inventory, unit, derivedUnits);
      if (derivedSourceRows !== undefined) appendSourceMapDerivedRows(derivedSourceRows, lowered, identity, unit);
    }
    nativeFamily?.assertCurrent();
    if (nativeDelay)
      validateNativePromiseDelaySourceLowering(
        identity,
        delayPlans,
        { functions, derivedUnits, callables: callGraph.records, startup, globals, allocations },
        diagnostic,
      );
    const sourceMap =
      sourceMapProjector === undefined
        ? undefined
        : finishSourceMapCatalog(sourceMapProjector, derivedSourceRows!, derivedUnits);
    const prepared: IrProgramSourcePreparation = {
      kind: "prepared",
      ...(sourceMap === undefined ? {} : { sourceMap }),
      inventory,
      ir: { functions },
      derivedUnits,
      startup,
      callables: callGraph.records,
      globals,
      allocations,
    };
    if (sourceMap !== undefined) assertPreparedSourceMap(prepared);
    return prepared;
  } catch (error) {
    const owner = diagnostic.active
      ? preparedIrProgramOwner({ inventory, derivedUnits }, diagnostic.active)
      : undefined;
    if (!owner)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `source preparation failed without an original owner: ${String(error)}`,
      );
    const { cause: _cause, ...failureDiagnostic } = classifyIrFailure(error, "build");
    return { ...failureDiagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile };
  }
}
