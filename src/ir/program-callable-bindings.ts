// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Checker-owned whole-program callable binding identity for the M1A
// cross-source prepared-component slice.  This module deliberately has no
// codegen, Wasm, or CodegenContext dependency: the graph is built once from
// the authoritative source/unit inventory and is consumed by later planning
// layers as an immutable projection.

import { ts } from "../ts-api.js";
import { irUnitCallableBindingId } from "./callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId, type IrUnitId } from "./identity.js";
import type { IrTerminalUnitRecord } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";

export type IrProgramCallableBindingKind = "source" | "import-alias" | "export-alias";

/** One exact source or module-boundary callable identity. */
export interface IrProgramCallableBindingRecord {
  readonly bindingId: IrBindingId;
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
  /** Stable ordinal among the source's callable bindings of this graph kind. */
  readonly bindingOrdinal: number;
  readonly kind: IrProgramCallableBindingKind;
  readonly localName: string;
  readonly targetBindingId: IrBindingId;
  readonly canonicalBindingId: IrBindingId;
  readonly targetUnitId: IrUnitId;
}

/** One direct fixed-target call admitted by the whole-program graph. */
export interface IrProgramCallableUse {
  readonly sourceId: IrSourceId;
  readonly ownerUnitId: IrUnitId;
  readonly node: ts.CallExpression;
  readonly bindingId: IrBindingId;
  readonly canonicalBindingId: IrBindingId;
  readonly targetUnitId: IrUnitId;
}

export interface IrProgramCallableBindingGraph {
  readonly schema: "ir-program-callable-binding-graph-v1";
  readonly sourceIds: readonly IrSourceId[];
  readonly records: readonly IrProgramCallableBindingRecord[];
  readonly uses: readonly IrProgramCallableUse[];
  resolveCall(call: ts.CallExpression, ownerUnitId: IrUnitId): IrProgramCallableUse | undefined;
}

export interface BuildIrProgramCallableBindingGraphInput {
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly identityContext: IrPlanningIdentityContext;
}

export type IrProgramCallableBindingInvariantCode =
  | "source-set-mismatch"
  | "source-record-mismatch"
  | "unit-record-mismatch"
  | "duplicate-binding"
  | "alias-cycle"
  | "dangling-alias"
  | "binding-target-mismatch";

/** A typed failure for corruption of the frozen checker/identity join. */
export class IrProgramCallableBindingInvariantError extends Error {
  constructor(
    readonly code: IrProgramCallableBindingInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "IrProgramCallableBindingInvariantError";
  }
}

interface SourceCallable {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly declaration: ts.FunctionDeclaration;
  readonly terminal: IrTerminalUnitRecord;
  readonly record: IrProgramCallableBindingRecord;
}

interface AliasDraft {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly kind: "import-alias" | "export-alias";
  readonly declaration: ts.Node;
  readonly localNode?: ts.Identifier;
  readonly localName: string;
  readonly declarationOrdinal: number;
  readonly syntaxStart: number;
  readonly tieBreak: string;
  readonly targetSymbol?: ts.Symbol;
  readonly targetModuleFile?: ts.SourceFile;
  readonly targetModuleExportName?: string;
  readonly fromExportStar: boolean;
  bindingOrdinal?: number;
  bindingId?: IrBindingId;
}

interface ResolvedAlias {
  readonly draft: AliasDraft;
  readonly target: SourceCallable;
  readonly targetBindingId: IrBindingId;
  readonly canonicalBindingId: IrBindingId;
  readonly targetUnitId: IrUnitId;
  readonly record: IrProgramCallableBindingRecord;
}

interface NamespaceImportInfo {
  readonly declaration: ts.NamespaceImport;
  readonly sourceFile: ts.SourceFile | undefined;
  readonly sourceId: IrSourceId | undefined;
}

function invariant(code: IrProgramCallableBindingInvariantCode, message: string): never {
  throw new IrProgramCallableBindingInvariantError(code, message);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

function compareAliasDraft(a: AliasDraft, b: AliasDraft): number {
  const sourceOrder =
    a.sourceFile.fileName < b.sourceFile.fileName ? -1 : a.sourceFile.fileName > b.sourceFile.fileName ? 1 : 0;
  if (sourceOrder !== 0) return sourceOrder;
  if (a.syntaxStart !== b.syntaxStart) return a.syntaxStart - b.syntaxStart;
  const kindOrder = a.kind === b.kind ? 0 : a.kind === "import-alias" ? -1 : 1;
  if (kindOrder !== 0) return kindOrder;
  return a.tieBreak < b.tieBreak ? -1 : a.tieBreak > b.tieBreak ? 1 : 0;
}

function activeSourceFileForModule(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression | undefined,
  sourceFiles: ReadonlySet<ts.SourceFile>,
): ts.SourceFile | undefined {
  if (!moduleSpecifier) return undefined;
  const moduleSymbol = symbolAt(checker, moduleSpecifier);
  if (!moduleSymbol) return undefined;
  const declarations = [moduleSymbol.valueDeclaration, ...(moduleSymbol.declarations ?? [])].filter(
    (declaration, index, all): declaration is ts.SourceFile =>
      declaration !== undefined && ts.isSourceFile(declaration) && all.indexOf(declaration) === index,
  );
  return declarations.find((declaration) => sourceFiles.has(declaration));
}

function moduleExports(checker: ts.TypeChecker, moduleSpecifier: ts.Expression | undefined): readonly ts.Symbol[] {
  if (!moduleSpecifier) return [];
  const moduleSymbol = symbolAt(checker, moduleSpecifier);
  if (!moduleSymbol) return [];
  try {
    return checker.getExportsOfModule(moduleSymbol);
  } catch {
    return [];
  }
}

function isValueImportDeclaration(node: ts.Declaration): boolean {
  if (ts.isImportSpecifier(node)) {
    const namedImports = node.parent;
    const clause = namedImports.parent;
    return !node.isTypeOnly && ts.isNamedImports(namedImports) && ts.isImportClause(clause) && !clause.isTypeOnly;
  }
  if (ts.isImportClause(node)) return !!node.name && !node.isTypeOnly;
  if (ts.isNamespaceImport(node)) {
    const clause = node.parent;
    return ts.isImportClause(clause) && !clause.isTypeOnly;
  }
  return false;
}

function isImportBindingDeclaration(node: ts.Declaration): boolean {
  return ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

interface CallableGraphSourceMaps {
  readonly sourceFileBySourceId: Map<IrSourceId, ts.SourceFile>;
  readonly sourceIdBySourceFile: Map<ts.SourceFile, IrSourceId>;
}

interface CallableGraphPopulation {
  readonly sourceRecordsByUnitId: Map<IrUnitId, IrProgramCallableBindingRecord>;
  readonly callableByDeclaration: Map<ts.FunctionDeclaration, SourceCallable>;
  readonly callableByUnitId: Map<IrUnitId, SourceCallable>;
  readonly sourceFunctionSymbols: Map<ts.Symbol, SourceCallable>;
}

interface CallableGraphAliasCollection {
  readonly aliasDrafts: AliasDraft[];
  readonly namespaceImports: Map<ts.NamespaceImport, NamespaceImportInfo>;
}

interface CallableGraphAliasIndex {
  readonly finalRecords: IrProgramCallableBindingRecord[];
  readonly finalChooseExportAlias: (
    sourceId: IrSourceId | undefined,
    name: string | undefined,
  ) => ResolvedAlias | undefined;
  readonly finalImportRecordByDeclaration: Map<ts.Declaration, IrProgramCallableBindingRecord>;
  readonly finalImportRecordByLocalNode: Map<ts.Identifier, IrProgramCallableBindingRecord>;
}

interface CallableGraphUseIndex {
  readonly uses: IrProgramCallableUse[];
  readonly useByOwner: Map<IrUnitId, WeakMap<ts.CallExpression, IrProgramCallableUse>>;
}

function buildCallableGraphSourceMaps(
  input: BuildIrProgramCallableBindingGraphInput,
  sourceFiles: ReadonlySet<ts.SourceFile>,
): CallableGraphSourceMaps {
  const inventorySources = input.identityContext.inventory.sources;
  if (sourceFiles.size !== input.sourceFiles.length || sourceFiles.size !== inventorySources.length) {
    return invariant(
      "source-set-mismatch",
      "callable graph received " +
        input.sourceFiles.length +
        " source files for " +
        inventorySources.length +
        " inventory sources",
    );
  }

  const sourceFileBySourceId = new Map<IrSourceId, ts.SourceFile>();
  const sourceIdBySourceFile = new Map<ts.SourceFile, IrSourceId>();
  for (const source of inventorySources) {
    const sourceFile = input.identityContext.sourceFileBySourceId.get(source.id);
    if (
      !sourceFile ||
      !sourceFiles.has(sourceFile) ||
      input.identityContext.sourceIdBySourceFile.get(sourceFile) !== source.id
    ) {
      return invariant(
        "source-record-mismatch",
        "callable graph source " + source.id + " does not join to the exact active SourceFile",
      );
    }
    sourceFileBySourceId.set(source.id, sourceFile);
    sourceIdBySourceFile.set(sourceFile, source.id);
  }
  for (const sourceFile of input.sourceFiles) {
    const sourceId = input.identityContext.sourceIdBySourceFile.get(sourceFile);
    if (!sourceId || sourceFileBySourceId.get(sourceId) !== sourceFile) {
      return invariant(
        "source-set-mismatch",
        "callable graph SourceFile " + sourceFile.fileName + " is outside the authoritative source set",
      );
    }
  }
  return { sourceFileBySourceId, sourceIdBySourceFile };
}

function makeCallableGraphDeAlias(checker: ts.TypeChecker): (symbol: ts.Symbol | undefined) => ts.Symbol | undefined {
  return (symbol) => {
    if (!symbol) return undefined;
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; depth < 64 && (current.flags & ts.SymbolFlags.Alias) !== 0; depth++) {
      if (seen.has(current)) return invariant("alias-cycle", "checker returned a cyclic callable alias chain");
      seen.add(current);
      let next: ts.Symbol | undefined;
      try {
        next = checker.getAliasedSymbol(current);
      } catch {
        return undefined;
      }
      if (!next || next === current) return undefined;
      current = next;
    }
    if ((current.flags & ts.SymbolFlags.Alias) !== 0) {
      return invariant("alias-cycle", "checker returned an overlong callable alias chain");
    }
    return current;
  };
}

function collectCallableGraphPopulation(
  input: BuildIrProgramCallableBindingGraphInput,
  maps: CallableGraphSourceMaps,
  deAlias: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined,
): CallableGraphPopulation {
  const { checker, identityContext } = input;
  const sourceRecordsByUnitId = new Map<IrUnitId, IrProgramCallableBindingRecord>();
  const callableByDeclaration = new Map<ts.FunctionDeclaration, SourceCallable>();
  const callableByUnitId = new Map<IrUnitId, SourceCallable>();
  const sourceFunctionSymbols = new Map<ts.Symbol, SourceCallable>();

  for (const source of identityContext.inventory.sources) {
    const sourceFile = maps.sourceFileBySourceId.get(source.id)!;
    for (let statementIndex = 0; statementIndex < sourceFile.statements.length; statementIndex++) {
      const statement = sourceFile.statements[statementIndex]!;
      if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
      const unitId = identityContext.unitIdByDeclaration.get(statement);
      if (unitId === undefined) {
        return invariant(
          "unit-record-mismatch",
          "top-level function at " +
            sourceFile.fileName +
            ":" +
            statement.getStart(sourceFile) +
            " has no inventory unit",
        );
      }
      const unit = identityContext.unitByUnitId.get(unitId);
      const terminal = identityContext.terminalByUnitId.get(unitId);
      if (
        !unit ||
        !terminal ||
        identityContext.declarationByUnitId.get(unitId) !== statement ||
        unit.sourceId !== source.id ||
        unit.kind !== "top-level-function" ||
        !unit.terminal ||
        unit.terminalOwnerId !== unitId ||
        terminal !== unit
      ) {
        if (unit && unit.sourceId === source.id && identityContext.declarationByUnitId.get(unitId) === statement)
          continue;
        return invariant(
          "unit-record-mismatch",
          "top-level function at " +
            sourceFile.fileName +
            ":" +
            statement.getStart(sourceFile) +
            " has a wrong unit join",
        );
      }
      const localName =
        statement.name?.text ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : "<anonymous>");
      const bindingId = irUnitCallableBindingId(unitId);
      if (sourceRecordsByUnitId.has(unitId)) {
        return invariant("duplicate-binding", "source callable unit " + unitId + " was recorded more than once");
      }
      const record = Object.freeze({
        bindingId,
        sourceId: source.id,
        declarationOrdinal: statementIndex,
        bindingOrdinal: statementIndex,
        kind: "source" as const,
        localName,
        targetBindingId: bindingId,
        canonicalBindingId: bindingId,
        targetUnitId: unitId,
      });
      const callable: SourceCallable = Object.freeze({
        sourceId: source.id,
        unitId,
        declaration: statement,
        terminal,
        record,
      });
      sourceRecordsByUnitId.set(unitId, record);
      callableByDeclaration.set(statement, callable);
      callableByUnitId.set(unitId, callable);

      const declarationSymbol = symbolAt(checker, statement.name ?? statement);
      const deAliasedDeclarationSymbol = deAlias(declarationSymbol);
      if (deAliasedDeclarationSymbol) sourceFunctionSymbols.set(deAliasedDeclarationSymbol, callable);
    }
  }
  return { sourceRecordsByUnitId, callableByDeclaration, callableByUnitId, sourceFunctionSymbols };
}

function collectMutableCallableSymbols(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  sourceFunctionSymbols: ReadonlyMap<ts.Symbol, SourceCallable>,
  deAlias: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined,
): Set<ts.Symbol> {
  const mutableFunctionSymbols = new Set<ts.Symbol>();
  const noteSymbolWrite = (node: ts.Identifier): void => {
    const target = deAlias(symbolAt(checker, node));
    if (target && sourceFunctionSymbols.has(target)) mutableFunctionSymbols.add(target);
  };
  const scanAssignmentTargetWrites = (rawTarget: ts.Expression): void => {
    let target = rawTarget;
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
      noteSymbolWrite(target);
      return;
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
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
          try {
            const shorthand = checker.getShorthandAssignmentValueSymbol(property);
            const resolved = deAlias(shorthand);
            if (resolved && sourceFunctionSymbols.has(resolved)) mutableFunctionSymbols.add(resolved);
          } catch {
            // An unresolved shorthand cannot certify a source binding write.
          }
        } else if (ts.isPropertyAssignment(property)) {
          scanAssignmentTargetWrites(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          scanAssignmentTargetWrites(property.expression);
        }
      }
    }
  };
  const scanBindingNameWrites = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      noteSymbolWrite(name);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) scanBindingNameWrites(element.name);
    }
  };
  const scanWrites = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      scanAssignmentTargetWrites(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      scanAssignmentTargetWrites(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) scanBindingNameWrites(declaration.name);
      } else {
        scanAssignmentTargetWrites(node.initializer);
      }
    }
    ts.forEachChild(node, scanWrites);
  };
  for (const sourceFile of sourceFiles) scanWrites(sourceFile);
  return mutableFunctionSymbols;
}

function makeCallableForSymbol(
  deAlias: (symbol: ts.Symbol | undefined) => ts.Symbol | undefined,
  callableByDeclaration: ReadonlyMap<ts.FunctionDeclaration, SourceCallable>,
  sourceFileBySourceId: ReadonlyMap<IrSourceId, ts.SourceFile>,
  mutableFunctionSymbols: ReadonlySet<ts.Symbol>,
): (symbol: ts.Symbol | undefined) => SourceCallable | undefined {
  return (symbol) => {
    const targetSymbol = deAlias(symbol);
    if (!targetSymbol) return undefined;
    const declarations = (targetSymbol.declarations ?? []).filter(ts.isFunctionDeclaration);
    if (declarations.length !== 1) return undefined;
    const declaration = declarations[0]!;
    const callable = callableByDeclaration.get(declaration);
    if (!callable || !declaration.body || declaration.getSourceFile() !== sourceFileBySourceId.get(callable.sourceId)) {
      return undefined;
    }
    if (targetSymbol.valueDeclaration && targetSymbol.valueDeclaration !== declaration) return undefined;
    if (mutableFunctionSymbols.has(targetSymbol)) return undefined;
    return callable;
  };
}

function collectCallableAliasDrafts(
  input: BuildIrProgramCallableBindingGraphInput,
  maps: CallableGraphSourceMaps,
  checker: ts.TypeChecker,
  callableByDeclaration: ReadonlyMap<ts.FunctionDeclaration, SourceCallable>,
): CallableGraphAliasCollection {
  const sourceFiles = new Set(input.sourceFiles);
  const aliasDrafts: AliasDraft[] = [];
  const namespaceImports = new Map<ts.NamespaceImport, NamespaceImportInfo>();
  const addAliasDraft = (draft: AliasDraft): void => {
    aliasDrafts.push(draft);
  };

  for (const source of input.identityContext.inventory.sources) {
    const sourceFile = maps.sourceFileBySourceId.get(source.id)!;
    for (let statementIndex = 0; statementIndex < sourceFile.statements.length; statementIndex++) {
      const statement = sourceFile.statements[statementIndex]!;

      if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
        const clause = statement.importClause;
        const moduleFile = activeSourceFileForModule(checker, statement.moduleSpecifier, sourceFiles);
        if (clause.name && !clause.isTypeOnly) {
          addAliasDraft({
            sourceFile,
            sourceId: source.id,
            kind: "import-alias",
            declaration: clause,
            localNode: clause.name,
            localName: clause.name.text,
            declarationOrdinal: statementIndex,
            syntaxStart: clause.name.getStart(sourceFile),
            tieBreak: "import-default:" + clause.name.text,
            targetSymbol: symbolAt(checker, clause.name),
            targetModuleFile: moduleFile,
            targetModuleExportName: "default",
            fromExportStar: false,
          });
        }
        if (
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          !clause.namedBindings.parent.isTypeOnly
        ) {
          for (const specifier of clause.namedBindings.elements) {
            if (specifier.isTypeOnly) continue;
            const importedName = specifier.propertyName?.text ?? specifier.name.text;
            addAliasDraft({
              sourceFile,
              sourceId: source.id,
              kind: "import-alias",
              declaration: specifier,
              localNode: specifier.name,
              localName: specifier.name.text,
              declarationOrdinal: statementIndex,
              syntaxStart: specifier.getStart(sourceFile),
              tieBreak: "import-named:" + importedName + ":" + specifier.name.text,
              targetSymbol: symbolAt(checker, specifier.name),
              targetModuleFile: moduleFile,
              targetModuleExportName: importedName,
              fromExportStar: false,
            });
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          namespaceImports.set(clause.namedBindings, {
            declaration: clause.namedBindings,
            sourceFile: moduleFile,
            sourceId: moduleFile ? maps.sourceIdBySourceFile.get(moduleFile) : undefined,
          });
        }
      }

      if (
        ts.isFunctionDeclaration(statement) &&
        statement.body &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        const exportedName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name?.text;
        const target = callableByDeclaration.get(statement);
        if (exportedName && target) {
          addAliasDraft({
            sourceFile,
            sourceId: source.id,
            kind: "export-alias",
            declaration: statement,
            localName: exportedName,
            declarationOrdinal: statementIndex,
            syntaxStart: statement.getStart(sourceFile),
            tieBreak: "export-function:" + exportedName,
            targetSymbol: symbolAt(checker, statement.name ?? statement),
            targetModuleExportName: undefined,
            fromExportStar: false,
          });
        }
      }

      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause) {
        if (ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) {
            const exportedName = specifier.name.text;
            const localName = (specifier.propertyName ?? specifier.name).text;
            addAliasDraft({
              sourceFile,
              sourceId: source.id,
              kind: "export-alias",
              declaration: specifier,
              localName: exportedName,
              declarationOrdinal: statementIndex,
              syntaxStart: specifier.getStart(sourceFile),
              tieBreak: "export-named:" + exportedName + ":" + localName,
              targetSymbol: symbolAt(checker, specifier.propertyName ?? specifier.name),
              targetModuleFile: statement.moduleSpecifier
                ? activeSourceFileForModule(checker, statement.moduleSpecifier, sourceFiles)
                : undefined,
              targetModuleExportName: statement.moduleSpecifier ? localName : undefined,
              fromExportStar: false,
            });
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        !statement.exportClause
      ) {
        const moduleFile = activeSourceFileForModule(checker, statement.moduleSpecifier, sourceFiles);
        const moduleSourceId = moduleFile ? maps.sourceIdBySourceFile.get(moduleFile) : undefined;
        const exports = moduleExports(checker, statement.moduleSpecifier)
          .filter((exported) => exported.name !== "default")
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const exported of exports) {
          addAliasDraft({
            sourceFile,
            sourceId: source.id,
            kind: "export-alias",
            declaration: statement,
            localName: exported.name,
            declarationOrdinal: statementIndex,
            syntaxStart: statement.getStart(sourceFile),
            tieBreak: "export-star:" + exported.name,
            targetSymbol: exported,
            targetModuleFile: moduleFile,
            targetModuleExportName: moduleSourceId ? exported.name : undefined,
            fromExportStar: true,
          });
        }
      }

      if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
        addAliasDraft({
          sourceFile,
          sourceId: source.id,
          kind: "export-alias",
          declaration: statement,
          localName: "default",
          declarationOrdinal: statementIndex,
          syntaxStart: statement.getStart(sourceFile),
          tieBreak: "export-assignment:default",
          targetSymbol: symbolAt(checker, statement.expression),
          fromExportStar: false,
        });
      }
    }
  }
  return { aliasDrafts, namespaceImports };
}

function resolveCallableAliasDrafts(
  aliasDrafts: readonly AliasDraft[],
  callableForSymbol: (symbol: ts.Symbol | undefined) => SourceCallable | undefined,
): ResolvedAlias[] {
  const draftsBySourceAndKind = new Map<string, AliasDraft[]>();
  for (const draft of aliasDrafts) {
    const key = draft.sourceId + "\u0000" + draft.kind;
    const entries = draftsBySourceAndKind.get(key) ?? [];
    entries.push(draft);
    draftsBySourceAndKind.set(key, entries);
  }
  for (const drafts of draftsBySourceAndKind.values()) {
    drafts.sort((a, b) => {
      const sourceOrder =
        a.sourceFile.fileName < b.sourceFile.fileName ? -1 : a.sourceFile.fileName > b.sourceFile.fileName ? 1 : 0;
      if (sourceOrder !== 0) return sourceOrder;
      if (a.syntaxStart !== b.syntaxStart) return a.syntaxStart - b.syntaxStart;
      return a.tieBreak < b.tieBreak ? -1 : a.tieBreak > b.tieBreak ? 1 : 0;
    });
    const role = drafts[0]?.kind === "import-alias" ? "module-import-callable" : "module-export-callable";
    drafts.forEach((draft, ordinal) => {
      draft.bindingOrdinal = ordinal;
      draft.bindingId = createIrBindingId({
        ownerId: draft.sourceId,
        domain: "callable",
        role,
        ordinal,
      });
    });
  }

  const resolvedAliases: ResolvedAlias[] = [];
  for (const draft of aliasDrafts) {
    const target = callableForSymbol(draft.targetSymbol);
    if (!target) continue;
    const targetBindingId = target.record.bindingId;
    const canonicalBindingId = target.record.canonicalBindingId;
    const record = Object.freeze({
      bindingId: draft.bindingId!,
      sourceId: draft.sourceId,
      declarationOrdinal: draft.declarationOrdinal,
      bindingOrdinal: draft.bindingOrdinal!,
      kind: draft.kind,
      localName: draft.localName,
      targetBindingId,
      canonicalBindingId,
      targetUnitId: target.unitId,
    });
    resolvedAliases.push({
      draft,
      target,
      targetBindingId,
      canonicalBindingId,
      targetUnitId: target.unitId,
      record,
    });
  }
  return resolvedAliases;
}

function buildCallableAliasIndex(
  resolvedAliases: readonly ResolvedAlias[],
  sourceRecordsByUnitId: ReadonlyMap<IrUnitId, IrProgramCallableBindingRecord>,
  sourceIdBySourceFile: ReadonlyMap<ts.SourceFile, IrSourceId>,
): CallableGraphAliasIndex {
  const finalModuleExportsBySourceId = new Map<IrSourceId, Map<string, ResolvedAlias[]>>();
  for (const resolved of resolvedAliases) {
    if (resolved.draft.kind !== "export-alias") continue;
    const byName = finalModuleExportsBySourceId.get(resolved.draft.sourceId) ?? new Map<string, ResolvedAlias[]>();
    const candidates = byName.get(resolved.draft.localName) ?? [];
    candidates.push(resolved);
    byName.set(resolved.draft.localName, candidates);
    finalModuleExportsBySourceId.set(resolved.draft.sourceId, byName);
  }
  const finalChooseExportAlias = (
    sourceId: IrSourceId | undefined,
    name: string | undefined,
  ): ResolvedAlias | undefined => {
    if (!sourceId || !name) return undefined;
    const candidates = finalModuleExportsBySourceId.get(sourceId)?.get(name) ?? [];
    if (candidates.length === 0) return undefined;
    const canonicalIds = new Set(candidates.map((candidate) => candidate.canonicalBindingId));
    if (canonicalIds.size !== 1) return undefined;
    return [...candidates].sort((a, b) => {
      if (a.draft.fromExportStar !== b.draft.fromExportStar) return a.draft.fromExportStar ? 1 : -1;
      return compareAliasDraft(a.draft, b.draft);
    })[0];
  };

  const finalRecords: IrProgramCallableBindingRecord[] = [...sourceRecordsByUnitId.values()];
  const finalImportRecordByDeclaration = new Map<ts.Declaration, IrProgramCallableBindingRecord>();
  const finalImportRecordByLocalNode = new Map<ts.Identifier, IrProgramCallableBindingRecord>();
  for (const resolved of resolvedAliases) {
    const targetModuleSourceId = resolved.draft.targetModuleFile
      ? sourceIdBySourceFile.get(resolved.draft.targetModuleFile)
      : undefined;
    const upstream = finalChooseExportAlias(targetModuleSourceId, resolved.draft.targetModuleExportName);
    const targetBindingId = upstream?.record.bindingId ?? resolved.target.record.bindingId;
    const finalRecord = Object.freeze({ ...resolved.record, targetBindingId });
    finalRecords.push(finalRecord);
    if (resolved.draft.kind === "import-alias") {
      finalImportRecordByDeclaration.set(resolved.draft.declaration as ts.Declaration, finalRecord);
      if (resolved.draft.localNode) finalImportRecordByLocalNode.set(resolved.draft.localNode, finalRecord);
    }
  }
  return {
    finalRecords,
    finalChooseExportAlias,
    finalImportRecordByDeclaration,
    finalImportRecordByLocalNode,
  };
}

function collectCallableGraphUses(
  input: BuildIrProgramCallableBindingGraphInput,
  maps: CallableGraphSourceMaps,
  callableByUnitId: ReadonlyMap<IrUnitId, SourceCallable>,
  callableForSymbol: (symbol: ts.Symbol | undefined) => SourceCallable | undefined,
  aliasIndex: CallableGraphAliasIndex,
  namespaceImports: ReadonlyMap<ts.NamespaceImport, NamespaceImportInfo>,
): CallableGraphUseIndex {
  const { checker, identityContext } = input;
  const namespaceInfoByDeclaration = new Map<ts.NamespaceImport, NamespaceImportInfo>(namespaceImports);
  const namespaceInfoForIdentifier = (identifier: ts.Identifier): NamespaceImportInfo | undefined => {
    const symbol = symbolAt(checker, identifier);
    const declaration = symbol?.declarations?.find(ts.isNamespaceImport);
    return declaration ? namespaceInfoByDeclaration.get(declaration) : undefined;
  };
  const directImportRecordForIdentifier = (identifier: ts.Identifier): IrProgramCallableBindingRecord | undefined => {
    const direct = aliasIndex.finalImportRecordByLocalNode.get(identifier);
    if (direct) return direct;
    const symbol = symbolAt(checker, identifier);
    const declaration = symbol?.declarations?.find((candidate) => isValueImportDeclaration(candidate));
    return declaration ? aliasIndex.finalImportRecordByDeclaration.get(declaration) : undefined;
  };
  const bindingForCall = (call: ts.CallExpression): IrProgramCallableBindingRecord | undefined => {
    if (call.questionDotToken) return undefined;
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      const imported = directImportRecordForIdentifier(callee);
      if (imported) return imported;
      const symbol = symbolAt(checker, callee);
      if (symbol?.declarations?.some(isImportBindingDeclaration)) return undefined;
      const target = callableForSymbol(symbol);
      return target?.record;
    }
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || ts.isPrivateIdentifier(callee.name)) {
      return undefined;
    }
    if (!ts.isIdentifier(callee.expression)) return undefined;
    const namespace = namespaceInfoForIdentifier(callee.expression);
    if (!namespace?.sourceId) return undefined;
    return aliasIndex.finalChooseExportAlias(namespace.sourceId, callee.name.text)?.record;
  };

  const uses: IrProgramCallableUse[] = [];
  const useByOwner = new Map<IrUnitId, WeakMap<ts.CallExpression, IrProgramCallableUse>>();
  const sourceOrder = new Map<IrSourceId, number>(
    identityContext.inventory.sources.map((source, index) => [source.id, index]),
  );
  const visitCalls = (root: SourceCallable): void => {
    const visit = (node: ts.Node): void => {
      if (node !== root.declaration && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const binding = bindingForCall(node);
        if (binding) {
          const use: IrProgramCallableUse = Object.freeze({
            sourceId: root.sourceId,
            ownerUnitId: root.unitId,
            node,
            bindingId: binding.bindingId,
            canonicalBindingId: binding.canonicalBindingId,
            targetUnitId: binding.targetUnitId,
          });
          uses.push(use);
          const ownerMap = useByOwner.get(root.unitId) ?? new WeakMap<ts.CallExpression, IrProgramCallableUse>();
          ownerMap.set(node, use);
          useByOwner.set(root.unitId, ownerMap);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root.declaration);
  };

  for (const source of identityContext.inventory.sources) {
    const callables = [...callableByUnitId.values()]
      .filter((callable) => callable.sourceId === source.id)
      .sort(
        (a, b) =>
          a.declaration.getStart(maps.sourceFileBySourceId.get(source.id)!) -
          b.declaration.getStart(maps.sourceFileBySourceId.get(source.id)!),
      );
    for (const callable of callables) visitCalls(callable);
  }
  uses.sort((a, b) => {
    const sourceDelta = (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0);
    if (sourceDelta !== 0) return sourceDelta;
    const ownerDelta = a.ownerUnitId < b.ownerUnitId ? -1 : a.ownerUnitId > b.ownerUnitId ? 1 : 0;
    if (ownerDelta !== 0) return ownerDelta;
    return a.node.getStart() - b.node.getStart();
  });
  return { uses, useByOwner };
}

function finalizeCallableGraph(
  input: BuildIrProgramCallableBindingGraphInput,
  finalRecords: readonly IrProgramCallableBindingRecord[],
  useIndex: CallableGraphUseIndex,
): IrProgramCallableBindingGraph {
  const sourceOrder = new Map<IrSourceId, number>(
    input.identityContext.inventory.sources.map((source, index) => [source.id, index]),
  );
  const recordOrder = new Set<IrBindingId>();
  const orderedRecords = finalRecords
    .filter((record) => {
      if (recordOrder.has(record.bindingId)) return false;
      recordOrder.add(record.bindingId);
      return true;
    })
    .sort((a, b) => {
      const sourceDelta = (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0);
      if (sourceDelta !== 0) return sourceDelta;
      if (a.kind !== b.kind) return a.kind === "source" ? -1 : 1;
      if (a.declarationOrdinal !== b.declarationOrdinal) return a.declarationOrdinal - b.declarationOrdinal;
      return a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0;
    });
  const frozenRecords = Object.freeze(orderedRecords.map((record) => Object.freeze(record)));
  const frozenUses = Object.freeze(useIndex.uses.map((use) => Object.freeze(use)));
  const sourceIds = Object.freeze(input.identityContext.inventory.sources.map((source) => source.id));
  return Object.freeze({
    schema: "ir-program-callable-binding-graph-v1",
    sourceIds,
    records: frozenRecords,
    uses: frozenUses,
    resolveCall(call: ts.CallExpression, ownerUnitId: IrUnitId): IrProgramCallableUse | undefined {
      return useIndex.useByOwner.get(ownerUnitId)?.get(call);
    },
  });
}

/** Build a structural, immutable callable graph for one exact source census. */
export function buildIrProgramCallableBindingGraph(
  input: BuildIrProgramCallableBindingGraphInput,
): IrProgramCallableBindingGraph {
  const sourceFiles = new Set(input.sourceFiles);
  const maps = buildCallableGraphSourceMaps(input, sourceFiles);
  const deAlias = makeCallableGraphDeAlias(input.checker);
  const population = collectCallableGraphPopulation(input, maps, deAlias);
  const mutableFunctionSymbols = collectMutableCallableSymbols(
    input.checker,
    input.sourceFiles,
    population.sourceFunctionSymbols,
    deAlias,
  );
  const callableForSymbol = makeCallableForSymbol(
    deAlias,
    population.callableByDeclaration,
    maps.sourceFileBySourceId,
    mutableFunctionSymbols,
  );
  const aliasCollection = collectCallableAliasDrafts(input, maps, input.checker, population.callableByDeclaration);
  const resolvedAliases = resolveCallableAliasDrafts(aliasCollection.aliasDrafts, callableForSymbol);
  const aliasIndex = buildCallableAliasIndex(
    resolvedAliases,
    population.sourceRecordsByUnitId,
    maps.sourceIdBySourceFile,
  );
  const useIndex = collectCallableGraphUses(
    input,
    maps,
    population.callableByUnitId,
    callableForSymbol,
    aliasIndex,
    aliasCollection.namespaceImports,
  );
  return finalizeCallableGraph(input, aliasIndex.finalRecords, useIndex);
}
