// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "./abi-bindings.js";
import { irUnitCallableBindingId } from "./callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrClassId, type IrSourceId, type IrUnitId } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";

export type IrModuleInitTarget = "host" | "standalone" | "wasi";
export type IrModuleInitInvocationKind = "none" | "wasm-start" | "deferred-export" | "wasi-start-export";

export interface IrModuleInitInvocationPolicy {
  readonly target: IrModuleInitTarget;
  readonly kind: IrModuleInitInvocationKind;
  readonly exactlyOnce: true;
}

export type IrModuleBindingDeclarationKind = "var" | "let" | "const";

export interface IrModuleInitBindingIntent {
  readonly declarationOrdinal: number;
  readonly names: readonly string[];
  readonly declarationKind: IrModuleBindingDeclarationKind;
  readonly mutable: boolean;
  readonly initialization: "undefined-at-instantiation" | "tdz";
  readonly globalBindingId: IrBindingId | null;
  readonly tdzBindingId: IrBindingId | null;
  readonly start: number;
  readonly end: number;
}

export interface IrModuleInitLiveSeedIntent {
  readonly name: string;
  readonly unitId: IrUnitId;
  readonly callableBindingId: IrBindingId;
  readonly liveGlobalBindingId: IrBindingId;
  readonly declarationOrdinal: number;
  readonly legacyKey: string;
}

export type IrModuleInitEvaluationKind =
  | "statement"
  | "variable-initializer"
  | "export-assignment"
  | "class-static-field"
  | "class-static-block";

export interface IrModuleInitEvaluationEntry {
  readonly key: string;
  readonly kind: IrModuleInitEvaluationKind;
  readonly sourceOrdinal: number;
  readonly statementOrdinal: number;
  readonly nestedOrdinal: number;
  readonly start: number;
  readonly end: number;
  readonly classId: IrClassId | null;
  readonly bindingIds: readonly IrBindingId[];
  /** Exact legacy queue identity used only by the migration parity observer. */
  readonly legacyKey: string;
}

export interface IrModuleInitExportIntent {
  readonly externalName: string;
  readonly localName: string | null;
  readonly targetBindingId: IrBindingId | null;
  readonly start: number;
  readonly end: number;
}

export type IrModuleInitPlanGapCode =
  | "missing-module-init-unit"
  | "destructuring-binding-abi"
  | "unresolved-export-target";

export interface IrModuleInitPlanGap {
  readonly code: IrModuleInitPlanGapCode;
  readonly detail: string;
  readonly start: number;
  readonly end: number;
}

/** Immutable, backend-neutral semantic inventory for one source module. */
export interface IrModuleInitPlan {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId | null;
  readonly executable: boolean;
  readonly bindings: readonly IrModuleInitBindingIntent[];
  readonly liveSeeds: readonly IrModuleInitLiveSeedIntent[];
  readonly evaluations: readonly IrModuleInitEvaluationEntry[];
  readonly exports: readonly IrModuleInitExportIntent[];
  readonly invocation: IrModuleInitInvocationPolicy;
  readonly gaps: readonly IrModuleInitPlanGap[];
}

export type IrModuleInitPlanInvariantCode =
  | "source-record-mismatch"
  | "duplicate-binding"
  | "duplicate-live-seed"
  | "duplicate-evaluation"
  | "non-canonical-order"
  | "invalid-invocation"
  | "invalid-source-range";

export class IrModuleInitPlanInvariantError extends Error {
  constructor(
    readonly code: IrModuleInitPlanInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "IrModuleInitPlanInvariantError";
  }
}

export interface BuildIrModuleInitPlanInput {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly identityContext: IrPlanningIdentityContext;
  readonly target: IrModuleInitTarget;
  readonly deferTopLevelInit: boolean;
}

export interface LegacyModuleInitStaticEntry {
  readonly initializer?: ts.Expression;
  readonly staticBlock?: ts.ClassStaticBlockDeclaration;
}

export interface LegacyModuleInitObservationInput {
  readonly liveFunctionNames: Iterable<string>;
  readonly staticEntries: readonly LegacyModuleInitStaticEntry[];
  readonly moduleStatements: readonly ts.Statement[];
}

export interface IrModuleInitParityReport {
  readonly aligned: boolean;
  readonly plannedEntryCount: number;
  readonly legacyEntryCount: number;
  readonly missingFromLegacy: readonly string[];
  readonly extraInLegacy: readonly string[];
  readonly reordered: readonly { readonly planned: string; readonly observed: string }[];
  readonly plannedOrder: readonly string[];
  readonly legacyOrder: readonly string[];
}

export interface IrModuleInitPlanningEvidence {
  readonly plan: IrModuleInitPlan;
  readonly parity: IrModuleInitParityReport;
}

function sourceRange(node: ts.Node, sourceFile: ts.SourceFile): { readonly start: number; readonly end: number } {
  return { start: node.getStart(sourceFile), end: node.end };
}

function legacyNodeKey(kind: "statement" | "static", node: ts.Node, sourceFile: ts.SourceFile): string {
  const { start, end } = sourceRange(node, sourceFile);
  return `${kind}:${start}:${end}`;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

function declarationKind(list: ts.VariableDeclarationList): IrModuleBindingDeclarationKind {
  if ((list.flags & ts.NodeFlags.Const) !== 0) return "const";
  if ((list.flags & ts.NodeFlags.Let) !== 0) return "let";
  return "var";
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
  );
}

function invocationPolicy(
  executable: boolean,
  target: IrModuleInitTarget,
  deferTopLevelInit: boolean,
): IrModuleInitInvocationPolicy {
  const kind: IrModuleInitInvocationKind = !executable
    ? "none"
    : target === "wasi"
      ? "wasi-start-export"
      : deferTopLevelInit
        ? "deferred-export"
        : "wasm-start";
  return Object.freeze({ target, kind, exactlyOnce: true });
}

function collectReassignedTopLevelFunctions(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly ts.FunctionDeclaration[] {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined,
  );
  const reassigned = new Set<ts.FunctionDeclaration>();
  const declarationSet = new Set(declarations);
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      for (const declaration of symbol?.declarations ?? []) {
        if (ts.isFunctionDeclaration(declaration) && declarationSet.has(declaration)) reassigned.add(declaration);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations.filter((declaration) => reassigned.has(declaration));
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function pushExportIntent(
  exports: IrModuleInitExportIntent[],
  seen: Set<string>,
  intent: IrModuleInitExportIntent,
): void {
  const identity = `${intent.externalName}\u0000${intent.start}\u0000${intent.end}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  exports.push(frozen(intent));
}

/** Build the semantic plan directly from source and structural R1 identities. */
export function buildIrModuleInitPlan(input: BuildIrModuleInitPlanInput): IrModuleInitPlan {
  const { sourceFile, checker, identityContext } = input;
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (!sourceId || identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    throw new IrModuleInitPlanInvariantError(
      "source-record-mismatch",
      `module-init plan source ${sourceFile.fileName} is absent from the exact identity inventory`,
    );
  }

  const bindings: IrModuleInitBindingIntent[] = [];
  const liveSeeds: IrModuleInitLiveSeedIntent[] = [];
  const evaluations: IrModuleInitEvaluationEntry[] = [];
  const exports: IrModuleInitExportIntent[] = [];
  const gaps: IrModuleInitPlanGap[] = [];
  const targetBindingByName = new Map<string, IrBindingId>();
  const exported = new Set<string>();
  let declarationOrdinal = 0;
  let sourceOrdinal = 0;

  // Export declarations are order-independent (`export { value }` may appear
  // before `value`), so resolve their canonical local targets up front.
  let targetDeclarationOrdinal = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          targetBindingByName.set(declaration.name.text, irModuleGlobalBindingId(sourceId, targetDeclarationOrdinal));
        }
        targetDeclarationOrdinal++;
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      const unitId = identityContext.unitIdByDeclaration.get(statement);
      if (unitId) targetBindingByName.set(statement.name.text, irUnitCallableBindingId(unitId));
    }
  }

  for (let statementOrdinal = 0; statementOrdinal < sourceFile.statements.length; statementOrdinal++) {
    const statement = sourceFile.statements[statementOrdinal]!;
    if (ts.isVariableStatement(statement)) {
      const kind = declarationKind(statement.declarationList);
      const statementBindingIds: IrBindingId[] = [];
      for (const declaration of statement.declarationList.declarations) {
        const names = bindingNames(declaration.name);
        const identifier = ts.isIdentifier(declaration.name);
        const globalBindingId = identifier ? irModuleGlobalBindingId(sourceId, declarationOrdinal) : null;
        const tdzBindingId = identifier ? irModuleTdzGlobalBindingId(sourceId, declarationOrdinal) : null;
        if (identifier && globalBindingId) {
          statementBindingIds.push(globalBindingId);
        } else {
          const { start, end } = sourceRange(declaration, sourceFile);
          gaps.push(
            frozen({
              code: "destructuring-binding-abi" as const,
              detail: `top-level binding pattern ${names.join(", ")} has no one-to-one Program ABI slot`,
              start,
              end,
            }),
          );
        }
        const { start, end } = sourceRange(declaration, sourceFile);
        bindings.push(
          frozen({
            declarationOrdinal,
            names: Object.freeze(names),
            declarationKind: kind,
            mutable: kind !== "const",
            initialization: kind === "var" ? "undefined-at-instantiation" : "tdz",
            globalBindingId,
            tdzBindingId: kind === "var" ? null : tdzBindingId,
            start,
            end,
          }),
        );
        declarationOrdinal++;
      }
      if (statement.declarationList.declarations.some((declaration) => declaration.initializer !== undefined)) {
        const { start, end } = sourceRange(statement, sourceFile);
        evaluations.push(
          frozen({
            key: `${sourceId}:eval:${sourceOrdinal}`,
            kind: "variable-initializer" as const,
            sourceOrdinal: sourceOrdinal++,
            statementOrdinal,
            nestedOrdinal: 0,
            start,
            end,
            classId: null,
            bindingIds: Object.freeze(statementBindingIds),
            legacyKey: legacyNodeKey("statement", statement, sourceFile),
          }),
        );
      }
      if (hasExportModifier(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) {
            pushExportIntent(exports, exported, {
              externalName: name,
              localName: name,
              targetBindingId: targetBindingByName.get(name) ?? null,
              ...sourceRange(declaration, sourceFile),
            });
          }
        }
      }
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const classId = identityContext.classIdByDeclaration.get(statement) ?? null;
      let nestedOrdinal = 0;
      for (const member of statement.members) {
        const isStatic =
          ts.canHaveModifiers(member) &&
          (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
        const node = ts.isClassStaticBlockDeclaration(member)
          ? member
          : isStatic && ts.isPropertyDeclaration(member) && member.initializer
            ? member.initializer
            : undefined;
        if (!node) continue;
        const { start, end } = sourceRange(node, sourceFile);
        evaluations.push(
          frozen({
            key: `${sourceId}:eval:${sourceOrdinal}`,
            kind: ts.isClassStaticBlockDeclaration(member) ? "class-static-block" : "class-static-field",
            sourceOrdinal: sourceOrdinal++,
            statementOrdinal,
            nestedOrdinal: nestedOrdinal++,
            start,
            end,
            classId,
            bindingIds: Object.freeze([]),
            legacyKey: legacyNodeKey("static", node, sourceFile),
          }),
        );
      }
      if (hasExportModifier(statement) && statement.name) {
        const unitId = identityContext.unitIdByDeclaration.get(statement);
        pushExportIntent(exports, exported, {
          externalName: hasDefaultModifier(statement) ? "default" : statement.name.text,
          localName: statement.name.text,
          targetBindingId: unitId ? irUnitCallableBindingId(unitId) : null,
          ...sourceRange(statement, sourceFile),
        });
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      if (hasExportModifier(statement)) {
        const unitId = identityContext.unitIdByDeclaration.get(statement);
        const localName = statement.name?.text ?? null;
        pushExportIntent(exports, exported, {
          externalName: hasDefaultModifier(statement) ? "default" : (localName ?? "default"),
          localName,
          targetBindingId: unitId ? irUnitCallableBindingId(unitId) : null,
          ...sourceRange(statement, sourceFile),
        });
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = (element.propertyName ?? element.name).text;
          const targetBindingId = targetBindingByName.get(localName) ?? null;
          if (!targetBindingId) {
            const { start, end } = sourceRange(element, sourceFile);
            gaps.push(
              frozen({
                code: "unresolved-export-target" as const,
                detail: `export ${element.name.text} has no planned local binding target`,
                start,
                end,
              }),
            );
          }
          pushExportIntent(exports, exported, {
            externalName: element.name.text,
            localName,
            targetBindingId,
            ...sourceRange(element, sourceFile),
          });
        }
      }
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isEmptyStatement(statement)
    ) {
      continue;
    }

    const { start, end } = sourceRange(statement, sourceFile);
    const kind: IrModuleInitEvaluationKind = ts.isExportAssignment(statement) ? "export-assignment" : "statement";
    evaluations.push(
      frozen({
        key: `${sourceId}:eval:${sourceOrdinal}`,
        kind,
        sourceOrdinal: sourceOrdinal++,
        statementOrdinal,
        nestedOrdinal: 0,
        start,
        end,
        classId: null,
        bindingIds: Object.freeze([]),
        legacyKey: legacyNodeKey("statement", statement, sourceFile),
      }),
    );
    if (ts.isExportAssignment(statement)) {
      pushExportIntent(exports, exported, {
        externalName: "default",
        localName: null,
        targetBindingId: null,
        start,
        end,
      });
    }
  }

  const functions = sourceFile.statements.filter(ts.isFunctionDeclaration);
  for (const declaration of collectReassignedTopLevelFunctions(sourceFile, checker)) {
    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    if (!unitId || !declaration.name) continue;
    liveSeeds.push(
      frozen({
        name: declaration.name.text,
        unitId,
        callableBindingId: irUnitCallableBindingId(unitId),
        liveGlobalBindingId: createIrBindingId({ ownerId: unitId, domain: "global", role: "live-function" }),
        declarationOrdinal: functions.indexOf(declaration),
        legacyKey: `live:${declaration.name.text}`,
      }),
    );
  }

  const executable = liveSeeds.length > 0 || evaluations.length > 0;
  const unitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile) ?? null;
  if (executable && unitId === null) {
    gaps.push(
      frozen({
        code: "missing-module-init-unit" as const,
        detail: "executable top-level semantics have no source-owned module-init terminal",
        start: 0,
        end: sourceFile.end,
      }),
    );
  }
  const plan = frozen({
    sourceId,
    unitId,
    executable,
    bindings: Object.freeze(bindings),
    liveSeeds: Object.freeze(liveSeeds),
    evaluations: Object.freeze(evaluations),
    exports: Object.freeze(exports),
    invocation: invocationPolicy(executable, input.target, input.deferTopLevelInit),
    gaps: Object.freeze(gaps),
  });
  verifyIrModuleInitPlan(plan, sourceFile);
  return plan;
}

/** Fail closed on malformed or non-canonical plan data before any body uses it. */
export function verifyIrModuleInitPlan(plan: IrModuleInitPlan, sourceFile: ts.SourceFile): void {
  const bindingIds = new Set<IrBindingId>();
  for (const binding of plan.bindings) {
    if (binding.start < 0 || binding.end < binding.start || binding.end > sourceFile.end) {
      throw new IrModuleInitPlanInvariantError("invalid-source-range", "module binding has an invalid source range");
    }
    for (const bindingId of [binding.globalBindingId, binding.tdzBindingId]) {
      if (!bindingId) continue;
      if (bindingIds.has(bindingId)) {
        throw new IrModuleInitPlanInvariantError("duplicate-binding", `binding ${bindingId} occurs more than once`);
      }
      bindingIds.add(bindingId);
    }
  }
  const seedNames = new Set<string>();
  for (const seed of plan.liveSeeds) {
    if (seedNames.has(seed.name)) {
      throw new IrModuleInitPlanInvariantError("duplicate-live-seed", `live seed ${seed.name} occurs more than once`);
    }
    seedNames.add(seed.name);
  }
  const evaluationKeys = new Set<string>();
  for (let index = 0; index < plan.evaluations.length; index++) {
    const entry = plan.evaluations[index]!;
    if (entry.sourceOrdinal !== index) {
      throw new IrModuleInitPlanInvariantError(
        "non-canonical-order",
        `evaluation ${entry.key} has ordinal ${entry.sourceOrdinal}, expected ${index}`,
      );
    }
    if (entry.start < 0 || entry.end < entry.start || entry.end > sourceFile.end) {
      throw new IrModuleInitPlanInvariantError("invalid-source-range", `evaluation ${entry.key} has an invalid range`);
    }
    if (evaluationKeys.has(entry.key)) {
      throw new IrModuleInitPlanInvariantError("duplicate-evaluation", `evaluation ${entry.key} occurs more than once`);
    }
    evaluationKeys.add(entry.key);
  }
  if (plan.executable !== (plan.liveSeeds.length > 0 || plan.evaluations.length > 0)) {
    throw new IrModuleInitPlanInvariantError("invalid-invocation", "executable flag disagrees with planned entries");
  }
  if ((plan.invocation.kind === "none") !== !plan.executable || plan.invocation.exactlyOnce !== true) {
    throw new IrModuleInitPlanInvariantError("invalid-invocation", "module-init invocation policy is inconsistent");
  }
}

function duplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new IrModuleInitPlanInvariantError("duplicate-evaluation", `${label} contains duplicate queue identities`);
  }
}

interface QueueIdentityOccurrence {
  readonly key: string;
  readonly identity: string;
}

/**
 * Preserve queue multiplicity without treating a source-range collision as a
 * malformed semantic plan. The direct class-expression path may register the
 * same source initializer once per internal class owner. R4 must observe that
 * as extra legacy work; its read-only parity probe must not make otherwise
 * valid source fail compilation.
 */
function identifyQueueOccurrences(values: readonly string[]): readonly QueueIdentityOccurrence[] {
  const seen = new Map<string, number>();
  return values.map((key) => {
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return frozen({ key, identity: `${key}\u0000${occurrence}` });
  });
}

/** Compare the semantic order with the current direct-front-end queues. */
export function reconcileIrModuleInitPlan(
  plan: IrModuleInitPlan,
  sourceFile: ts.SourceFile,
  legacy: LegacyModuleInitObservationInput,
): IrModuleInitParityReport {
  const plannedOrder = [
    ...plan.liveSeeds.map((seed) => seed.legacyKey),
    ...plan.evaluations.map((entry) => entry.legacyKey),
  ];
  const legacyOrder = [
    ...[...legacy.liveFunctionNames].map((name) => `live:${name}`),
    ...legacy.staticEntries.flatMap((entry) => {
      const node = entry.staticBlock ?? entry.initializer;
      return node ? [legacyNodeKey("static", node, sourceFile)] : [];
    }),
    ...legacy.moduleStatements.map((statement) => legacyNodeKey("statement", statement, sourceFile)),
  ];
  duplicates(plannedOrder, "module-init plan");
  const plannedOccurrences = identifyQueueOccurrences(plannedOrder);
  const legacyOccurrences = identifyQueueOccurrences(legacyOrder);
  const plannedSet = new Set(plannedOccurrences.map((entry) => entry.identity));
  const legacySet = new Set(legacyOccurrences.map((entry) => entry.identity));
  const missingFromLegacy = plannedOccurrences
    .filter((entry) => !legacySet.has(entry.identity))
    .map((entry) => entry.key);
  const extraInLegacy = legacyOccurrences.filter((entry) => !plannedSet.has(entry.identity)).map((entry) => entry.key);
  const commonPlanned = plannedOccurrences.filter((entry) => legacySet.has(entry.identity));
  const commonLegacy = legacyOccurrences.filter((entry) => plannedSet.has(entry.identity));
  const reordered: { planned: string; observed: string }[] = [];
  for (let index = 0; index < Math.max(commonPlanned.length, commonLegacy.length); index++) {
    const planned = commonPlanned[index];
    const observed = commonLegacy[index];
    if (planned?.identity !== observed?.identity && planned !== undefined && observed !== undefined) {
      reordered.push(frozen({ planned: planned.key, observed: observed.key }));
    }
  }
  return frozen({
    aligned: missingFromLegacy.length === 0 && extraInLegacy.length === 0 && reordered.length === 0,
    plannedEntryCount: plannedOrder.length,
    legacyEntryCount: legacyOrder.length,
    missingFromLegacy: Object.freeze(missingFromLegacy),
    extraInLegacy: Object.freeze(extraInLegacy),
    reordered: Object.freeze(reordered),
    plannedOrder: Object.freeze(plannedOrder),
    legacyOrder: Object.freeze(legacyOrder),
  });
}
