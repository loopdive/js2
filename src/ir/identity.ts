// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CompilerSourceOrigin, CompilerSourceProducer } from "../position-map.js";
import { isBoundedPreparedNestedOrdinaryClass } from "./class-accessor-safety.js";
import { collectModuleInitPopulation, MODULE_INIT_UNIT_NAME } from "./module-init.js";
import type { IrPreparationFailure } from "./outcomes.js";

declare const irSourceIdBrand: unique symbol;
declare const irUnitIdBrand: unique symbol;
declare const irClassIdBrand: unique symbol;
declare const irBindingIdBrand: unique symbol;

/** Canonical, program-relative identity for one compiler input source. */
export type IrSourceId = string & { readonly [irSourceIdBrand]: "IrSourceId" };
/** Canonical identity for one executable source or synthetic unit. */
export type IrUnitId = string & { readonly [irUnitIdBrand]: "IrUnitId" };
/** Canonical identity for one class declaration or expression. */
export type IrClassId = string & { readonly [irClassIdBrand]: "IrClassId" };
/** Canonical identity for one program ABI intention. */
export type IrBindingId = string & { readonly [irBindingIdBrand]: "IrBindingId" };

export type IrLexicalOwnerId = IrUnitId | IrClassId;
export type IrSourceKind = "entry" | "source" | "library" | "synthetic";

/** Structural function identity plus its temporary compatibility/reference label. */
export interface IrFunctionIdentity {
  readonly unitId: IrUnitId;
  readonly name: string;
}

export interface IrLiftedFunctionArtifactIdentity extends IrFunctionIdentity {
  readonly parentId: IrUnitId;
  readonly role: "lifted-closure";
  readonly ordinal: number;
  /** Present when the lifted artifact is an inventoried source body, not a pass-created unit. */
  readonly sourceUnit?: true;
}

export interface IrLiftedFunctionArtifactOwner {
  readonly ownerUnitId: IrUnitId;
  readonly liftedCounter: { value: number };
}

/** Exact producer-side provenance for one pass-created executable unit. */
export interface IrSyntheticUnitProvenance {
  readonly id: IrUnitId;
  readonly parentId: IrUnitId;
  readonly role: IrSyntheticUnitRole;
  readonly ordinal: number;
}

/** Exact lowering-side provenance for an inventoried nested source body. */
export interface IrLiftedSourceUnitProvenance {
  readonly id: IrUnitId;
  readonly parentId: IrUnitId;
  readonly role: "lifted-closure";
  readonly ordinal: number;
  readonly sourceUnit: true;
}

export type IrDerivedUnitProvenance = IrSyntheticUnitProvenance | IrLiftedSourceUnitProvenance;

/** Closed role families for compiler/pass-created executable units. */
export type IrSyntheticUnitRole =
  | `compiler-unit:${CompilerSourceProducer}:${string}`
  | `stdlib-selfhost:${string}`
  | "ir-async-state"
  | "lifted-closure"
  | "monomorphization-clone";
/** Compiler-created class roles live in a namespace separate from source classes. */
export type IrSyntheticClassRole = `compiler-class:${CompilerSourceProducer}:${string}`;

export type IrUnitKind =
  | "top-level-function"
  | "nested-function"
  | "function-expression"
  | "arrow-function"
  | "class-constructor"
  | "class-implicit-constructor"
  | "class-instance-method"
  | "class-static-method"
  | "class-instance-getter"
  | "class-static-getter"
  | "class-instance-setter"
  | "class-static-setter"
  | "class-instance-field-initializer"
  | "class-static-field-initializer"
  | "class-static-block"
  | "object-method"
  | "object-getter"
  | "object-setter"
  | "export-assignment"
  | "module-init"
  | "synthetic-support";

export type IrTerminalObservedKind = "function" | "class-member" | "module-init";
export type IrUnownedUnitReason = "no-r0-attempt-root";

export interface IrSourceRecord {
  readonly id: IrSourceId;
  readonly kind: IrSourceKind;
  /** Dependency-first order with canonical tie-breaking, never caller Map order. */
  readonly order: number;
  /** Normalized program-relative key. Absolute checkout roots are removed. */
  readonly sourceKey: string;
  /** Diagnostic label only; it is deliberately not part of semantic lookup. */
  readonly displayName: string;
  /** Original TypeScript filename, retained only to join compiler-owned ASTs. */
  readonly originalFileName: string;
}

export interface IrClassRecord {
  readonly id: IrClassId;
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly declarationKind: "declaration" | "expression";
  readonly ordinal: number;
  /** Present only when the class identity is derived from a compiler role. */
  readonly syntheticRole?: IrSyntheticClassRole;
  readonly displayName: string;
  readonly line: number;
  readonly column: number;
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

interface IrUnitRecordBase {
  readonly id: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly kind: IrUnitKind;
  /** Declaration ordinal within the structural owner and unit kind. */
  readonly ordinal: number;
  /** Present only when the unit identity is derived from a compiler/pass role. */
  readonly syntheticRole?: IrSyntheticUnitRole;
  /** Diagnostic label only. It is never used to encode the identity. */
  readonly displayName: string;
  readonly line: number;
  readonly column: number;
  /** Source-relative declaration span for validated AST→identity joins. */
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

export interface IrOwnedSupportUnitRecord extends IrUnitRecordBase {
  readonly terminal: false;
  readonly terminalOwnerId: IrUnitId;
  readonly unownedReason?: never;
}

export interface IrUnownedSupportUnitRecord extends IrUnitRecordBase {
  readonly terminal: false;
  readonly terminalOwnerId: null;
  readonly unownedReason: IrUnownedUnitReason;
}

/** Exact structural counterpart of one existing R0 terminal outcome row. */
export interface IrTerminalUnitRecord extends IrUnitRecordBase {
  readonly terminal: true;
  readonly terminalOwnerId: IrUnitId;
  /**
   * Exact enclosing executable when a bounded nested body is promoted to its
   * own terminal. This is a component edge only: ownership and outcome
   * routing remain keyed by this terminal's own id.
   */
  readonly containingTerminalOwnerId?: IrUnitId;
  readonly unownedReason?: never;
  readonly observedKind: IrTerminalObservedKind;
  readonly legacyKey: string;
  readonly legacyMatchName: string;
  readonly legacyOrdinal: number;
  readonly staticClassMember: boolean;
  readonly legacyBodyAvailable: boolean;
  readonly directFailure?: IrPreparationFailure;
}

export type IrUnitRecord = IrTerminalUnitRecord | IrOwnedSupportUnitRecord | IrUnownedSupportUnitRecord;

export interface IrUnitInventory {
  readonly sources: readonly IrSourceRecord[];
  readonly classes: readonly IrClassRecord[];
  /** Exhaustive source-AST/compiler-prelude population for the R1a boundary. */
  readonly allUnits: readonly IrUnitRecord[];
  /** Exact R0 attempt-root population; no support unit manufactures a row. */
  readonly terminalUnits: readonly IrTerminalUnitRecord[];
}

export interface BuildIrUnitInventoryOptions {
  /** Marks the entry explicitly without deriving it from caller insertion order. */
  readonly entrySource?: ts.SourceFile | string;
  /** Compiler-owned provenance; user spellings never classify a node as injected. */
  readonly compilerOriginAt?: (sourceFile: ts.SourceFile, offset: number) => CompilerSourceOrigin | undefined;
  /** Exact dependency edges when a compiler driver already resolved the graph. */
  readonly resolvedDependencies?: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
  /** Optional checker used to resolve module edges before the syntactic fallback. */
  readonly checker?: ts.TypeChecker;
  /** Pre-transform ordinal anchors for same-span retained source units. */
  readonly canonicalUnitOrdinalAt?: (
    sourceFile: ts.SourceFile,
    declarationStart: number,
    declarationEnd: number,
    kind: IrUnitKind,
  ) => number | undefined;
  /** Pre-transform ordinal anchors for same-span retained source classes. */
  readonly canonicalClassOrdinalAt?: (
    sourceFile: ts.SourceFile,
    declarationStart: number,
    declarationEnd: number,
    declarationKind: "declaration" | "expression",
  ) => number | undefined;
}

export interface CreateIrSourceIdInput {
  readonly kind: IrSourceKind;
  readonly order: number;
  readonly sourceKey: string;
}

export interface CreateIrUnitIdInput {
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly kind: IrUnitKind;
  readonly ordinal: number;
}

export interface CreateDerivedIrUnitIdInput {
  readonly parentId: IrSourceId | IrLexicalOwnerId;
  readonly role: IrSyntheticUnitRole;
  readonly ordinal: number;
}

export interface CreateIrClassIdInput {
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly declarationKind: "declaration" | "expression";
  readonly ordinal: number;
}

export interface CreateDerivedIrClassIdInput {
  readonly parentId: IrSourceId | IrLexicalOwnerId;
  readonly role: IrSyntheticClassRole;
  readonly ordinal: number;
}

export interface CreateIrBindingIdInput {
  readonly ownerId: IrSourceId | IrUnitId | IrClassId;
  readonly domain: "callable" | "global" | "type" | "export" | "class" | "support";
  readonly role: string;
  readonly ordinal?: number;
}

const identityComponent = (value: string): string => encodeURIComponent(value);
const ownerComponent = (owner: IrLexicalOwnerId | null): string => (owner === null ? "root" : identityComponent(owner));
const compareCanonicalText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const canonicalNumber = (value: number, label: string): string => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value.toString(10).padStart(16, "0");
};

export function createIrSourceId(input: CreateIrSourceIdInput): IrSourceId {
  return `ir-source:v1:${canonicalNumber(input.order, "source order")}:${input.kind}:${identityComponent(input.sourceKey)}` as IrSourceId;
}

export function createIrUnitId(input: CreateIrUnitIdInput): IrUnitId {
  return `ir-unit:v1:${identityComponent(input.sourceId)}:${ownerComponent(input.lexicalOwnerId)}:${input.kind}:${canonicalNumber(input.ordinal, "unit ordinal")}` as IrUnitId;
}

/** Derive a unit identity from semantic compiler role, never a display label. */
export function createDerivedIrUnitId(input: CreateDerivedIrUnitIdInput): IrUnitId {
  return `ir-unit:v1:derived:${identityComponent(input.parentId)}:${identityComponent(input.role)}:${canonicalNumber(input.ordinal, "derived unit ordinal")}` as IrUnitId;
}

/** Allocate a lifted artifact's label and structural identity from one ordinal. */
export function allocateLiftedFunctionArtifact(
  owner: IrLiftedFunctionArtifactOwner,
  displayNameForOrdinal: (ordinal: number) => string,
): IrLiftedFunctionArtifactIdentity {
  const ordinal = owner.liftedCounter.value++;
  return {
    unitId: createDerivedIrUnitId({ parentId: owner.ownerUnitId, role: "lifted-closure", ordinal }),
    name: displayNameForOrdinal(ordinal),
    parentId: owner.ownerUnitId,
    role: "lifted-closure",
    ordinal,
  };
}

export function createIrClassId(input: CreateIrClassIdInput): IrClassId {
  return `ir-class:v1:${identityComponent(input.sourceId)}:${ownerComponent(input.lexicalOwnerId)}:${input.declarationKind}:${canonicalNumber(input.ordinal, "class ordinal")}` as IrClassId;
}

/** Derive a compiler-created class identity from its parent and semantic role. */
export function createDerivedIrClassId(input: CreateDerivedIrClassIdInput): IrClassId {
  return `ir-class:v1:derived:${identityComponent(input.parentId)}:${identityComponent(input.role)}:${canonicalNumber(input.ordinal, "derived class ordinal")}` as IrClassId;
}

export function createIrBindingId(input: CreateIrBindingIdInput): IrBindingId {
  return `ir-binding:v1:${input.domain}:${identityComponent(input.ownerId)}:${identityComponent(input.role)}:${canonicalNumber(input.ordinal ?? 0, "binding ordinal")}` as IrBindingId;
}

export function compareIrIdentity(a: IrSourceId | IrUnitId | IrClassId | IrBindingId, b: typeof a): number {
  return compareCanonicalText(a, b);
}

function normalizePathKey(fileName: string): string {
  const slash = fileName.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const prefix = slash.match(/^[A-Za-z]:\//)?.[0] ?? (slash.startsWith("/") ? "/" : "");
  const body = prefix === "/" ? slash.slice(1) : prefix ? slash.slice(prefix.length) : slash;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join("/")}` || ".";
}

function pathParts(fileName: string): string[] {
  return normalizePathKey(fileName)
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean);
}

function commonDirectoryLength(fileNames: readonly string[]): number {
  if (fileNames.length === 0) return 0;
  const directories = fileNames.map((name) => pathParts(name).slice(0, -1));
  let length = directories[0]!.length;
  for (const directory of directories.slice(1)) {
    length = Math.min(length, directory.length);
    for (let i = 0; i < length; i++) {
      if (directories[0]![i] !== directory[i]) {
        length = i;
        break;
      }
    }
  }
  return length;
}

function minimalUniquePathSuffix(fileName: string, peers: readonly string[]): string {
  const parts = pathParts(fileName);
  for (let length = 1; length <= parts.length; length++) {
    const suffix = parts.slice(-length);
    const matches = peers.filter((peer) => {
      const peerParts = pathParts(peer);
      return suffix.every((part, index) => peerParts[peerParts.length - suffix.length + index] === part);
    });
    if (matches.length === 1) return suffix.join("/");
  }
  return parts.join("/") || normalizePathKey(fileName);
}

function isSyntheticFileName(fileName: string): boolean {
  return /^<.*>$/.test(fileName) || /^__.*__$/.test(fileName);
}

function sourceKind(sourceFile: ts.SourceFile, entry: ts.SourceFile | string | undefined): IrSourceKind {
  if (
    entry === sourceFile ||
    (typeof entry === "string" && normalizePathKey(entry) === normalizePathKey(sourceFile.fileName))
  ) {
    return "entry";
  }
  if (sourceFile.isDeclarationFile) return "library";
  if (isSyntheticFileName(sourceFile.fileName)) return "synthetic";
  return "source";
}

function sourceKeys(
  sourceFiles: readonly ts.SourceFile[],
  entry: ts.SourceFile | string | undefined,
): { sourceFile: ts.SourceFile; kind: IrSourceKind; sourceKey: string }[] {
  const classified = sourceFiles.map((sourceFile) => ({ sourceFile, kind: sourceKind(sourceFile, entry) }));
  const projectNames = classified
    .filter(({ sourceFile, kind }) => kind !== "library" && !isSyntheticFileName(sourceFile.fileName))
    .map(({ sourceFile }) => sourceFile.fileName);
  const libraryNames = classified.filter(({ kind }) => kind === "library").map(({ sourceFile }) => sourceFile.fileName);
  const commonLength = commonDirectoryLength(projectNames);
  const keyed = classified.map(({ sourceFile, kind }) => {
    const parts = pathParts(sourceFile.fileName);
    const sourceKey =
      kind === "library"
        ? `@library/${minimalUniquePathSuffix(sourceFile.fileName, libraryNames)}`
        : isSyntheticFileName(sourceFile.fileName)
          ? normalizePathKey(sourceFile.fileName)
          : parts.slice(commonLength).join("/") || parts.at(-1) || normalizePathKey(sourceFile.fileName);
    return { sourceFile, kind, sourceKey };
  });
  const byKey = new Map<string, string>();
  for (const { sourceFile, sourceKey } of keyed) {
    const previous = byKey.get(sourceKey);
    if (previous !== undefined) {
      throw new Error(`duplicate canonical IR source key ${sourceKey}: ${previous} and ${sourceFile.fileName}`);
    }
    byKey.set(sourceKey, sourceFile.fileName);
  }
  return keyed;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

function stripSourceExtension(fileName: string): string {
  for (const extension of SOURCE_EXTENSIONS) {
    if (fileName.endsWith(extension)) return fileName.slice(0, -extension.length);
  }
  return fileName;
}

function relativeModuleKey(fromSourceKey: string, specifier: string): string {
  const directory = fromSourceKey.includes("/") ? fromSourceKey.slice(0, fromSourceKey.lastIndexOf("/")) : ".";
  return normalizePathKey(`${directory}/${specifier}`).replace(/^\.\//, "");
}

function sourceDependencies<T extends { sourceFile: ts.SourceFile; sourceKey: string }>(
  source: T,
  byKey: ReadonlyMap<string, T>,
  bySourceFile: ReadonlyMap<ts.SourceFile, T>,
  options: BuildIrUnitInventoryOptions,
): readonly T[] {
  const dependencies = new Set<T>();
  if (options.resolvedDependencies?.has(source.sourceFile)) {
    for (const dependencyFile of options.resolvedDependencies.get(source.sourceFile) ?? []) {
      const dependency = bySourceFile.get(dependencyFile);
      if (dependency && dependency !== source) dependencies.add(dependency);
    }
    return [...dependencies].sort((a, b) => compareCanonicalText(a.sourceKey, b.sourceKey));
  }

  const resolve = (moduleSpecifier: ts.StringLiteral): void => {
    const checkerSymbol = options.checker?.getSymbolAtLocation(moduleSpecifier);
    if (checkerSymbol) {
      const symbol =
        (checkerSymbol.flags & ts.SymbolFlags.Alias) !== 0
          ? options.checker!.getAliasedSymbol(checkerSymbol)
          : checkerSymbol;
      const resolved = symbol.declarations
        ?.map((declaration) => bySourceFile.get(declaration.getSourceFile()))
        .find((candidate): candidate is T => candidate !== undefined && candidate !== source);
      if (resolved) {
        dependencies.add(resolved);
      }
      // A checker-resolved declaration outside this inventory is still an
      // authoritative external edge. Do not rebind it by filename heuristics.
      return;
    }

    const specifier = moduleSpecifier.text;
    const base = specifier.startsWith(".")
      ? relativeModuleKey(source.sourceKey, specifier)
      : normalizePathKey(specifier).replace(/^\.\//, "");
    const extensionless = stripSourceExtension(base);
    const candidates = [
      base,
      extensionless,
      ...SOURCE_EXTENSIONS.map((extension) => `${extensionless}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => `${extensionless}/index${extension}`),
    ];
    for (const candidate of candidates) {
      const dependency = byKey.get(candidate);
      if (dependency && dependency !== source) {
        dependencies.add(dependency);
        return;
      }
    }
  };
  for (const statement of source.sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      resolve(statement.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      resolve(statement.moduleReference.expression);
    }
  }
  return [...dependencies].sort((a, b) => compareCanonicalText(a.sourceKey, b.sourceKey));
}

/** Dependency-first SCC order; canonical source-key order breaks every tie. */
function orderSourceKeys<T extends { sourceFile: ts.SourceFile; sourceKey: string; kind: IrSourceKind }>(
  keyed: readonly T[],
  options: BuildIrUnitInventoryOptions,
): T[] {
  const compareSource = (a: T, b: T): number =>
    compareCanonicalText(a.sourceKey, b.sourceKey) || compareCanonicalText(a.kind, b.kind);
  const lexical = [...keyed].sort(compareSource);
  const byKey = new Map(lexical.map((source) => [source.sourceKey, source]));
  const bySourceFile = new Map(lexical.map((source) => [source.sourceFile, source]));
  const edges = new Map(lexical.map((source) => [source, sourceDependencies(source, byKey, bySourceFile, options)]));
  const indices = new Map<T, number>();
  const lowLinks = new Map<T, number>();
  const stack: T[] = [];
  const onStack = new Set<T>();
  const components: T[][] = [];
  let nextIndex = 0;

  const connect = (source: T): void => {
    const index = nextIndex++;
    indices.set(source, index);
    lowLinks.set(source, index);
    stack.push(source);
    onStack.add(source);

    for (const dependency of edges.get(source) ?? []) {
      if (!indices.has(dependency)) {
        connect(dependency);
        lowLinks.set(source, Math.min(lowLinks.get(source)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(source, Math.min(lowLinks.get(source)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(source) !== indices.get(source)) return;
    const component: T[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === source) break;
    }
    components.push(component.sort(compareSource));
  };
  for (const source of lexical) if (!indices.has(source)) connect(source);
  return components.flat();
}

function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

function hasDeclareModifier(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const modifiers = (current as { modifiers?: readonly ts.Node[] }).modifiers;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return node.getSourceFile().isDeclarationFile;
}

function decoratorExpressions(node: ts.Node): readonly ts.Expression[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node)?.map((decorator) => decorator.expression) ?? []) : [];
}

function memberBaseName(name: ts.PropertyName | undefined): string {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
  return "<computed>";
}

function classMemberLegacyName(className: string, member: ts.ClassElement): string | null {
  if (ts.isConstructorDeclaration(member)) return `${className}_new`;
  if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) {
    return null;
  }
  const base = memberBaseName(member.name);
  if (ts.isGetAccessorDeclaration(member)) return `${className}_get_${base}`;
  if (ts.isSetAccessorDeclaration(member)) return `${className}_set_${base}`;
  return `${className}_${base}`;
}

function functionDisplayName(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): string {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text ?? "<anonymous-function>";
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return memberBaseName(parent.name);
  return "<arrow>";
}

function objectMemberDisplayName(
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): string {
  const base = memberBaseName(node.name);
  if (ts.isGetAccessorDeclaration(node)) return `get ${base}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${base}`;
  return base;
}

const compilerUnitRole = (origin: CompilerSourceOrigin): IrSyntheticUnitRole =>
  `compiler-unit:${origin.producer}:${origin.role}`;
const compilerClassRole = (origin: CompilerSourceOrigin): IrSyntheticClassRole =>
  `compiler-class:${origin.producer}:${origin.role}`;

/** @internal Exact AST records retained outside serializable identity values. */
export interface IrInventoryScannerMetadata {
  readonly sources: readonly {
    readonly sourceFile: ts.SourceFile;
    readonly record: IrSourceRecord;
  }[];
  readonly units: readonly {
    readonly sourceFile: ts.SourceFile;
    readonly declaration: ts.Node;
    readonly record: IrUnitRecord;
  }[];
  readonly classes: readonly {
    readonly sourceFile: ts.SourceFile;
    readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
    readonly record: IrClassRecord;
  }[];
}

/** AST nodes stay outside the serializable identity records. */
const scannerMetadataByInventory = new WeakMap<IrUnitInventory, IrInventoryScannerMetadata>();

/** @internal Planning must consume metadata for this exact inventory object. */
export function getIrInventoryScannerMetadata(inventory: IrUnitInventory): IrInventoryScannerMetadata | undefined {
  return scannerMetadataByInventory.get(inventory);
}

class SourceInventoryBuilder {
  readonly classes: IrClassRecord[] = [];
  readonly allUnits: IrUnitRecord[] = [];
  readonly terminalUnits: IrTerminalUnitRecord[] = [];
  readonly unitDeclarations: IrInventoryScannerMetadata["units"][number][] = [];
  readonly classDeclarations: IrInventoryScannerMetadata["classes"][number][] = [];

  private readonly unitOrdinals = new Map<string, number>();
  private readonly classOrdinals = new Map<string, number>();
  private readonly derivedUnitOrdinals = new Map<string, number>();
  private readonly derivedClassOrdinals = new Map<string, number>();
  private readonly legacyOrdinals = new Map<string, number>();
  private anonymousDefaultClass = 0;
  private unnamedFunction = 0;

  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly source: IrSourceRecord,
    private readonly options: BuildIrUnitInventoryOptions,
  ) {}

  build(): void {
    const modulePopulation = collectModuleInitPopulation(this.sourceFile);
    let firstStaticInitialization: ts.Node | undefined;
    const deferredModuleInitScans: ((moduleOwner: IrUnitId) => void)[] = [];

    for (const statement of this.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.body) continue;
        const compilerOrigin = this.compilerOrigin(statement);
        if (compilerOrigin) {
          const role = compilerUnitRole(compilerOrigin);
          const timerSynthetic = compilerOrigin.producer === "timer-shim";
          if (timerSynthetic) {
            const unit = this.addSupportUnit(
              "synthetic-support",
              null,
              null,
              statement,
              statement.name?.text ?? "<timer-shim>",
              role,
            );
            this.scanCallable(statement, unit.id, null);
          } else {
            const terminal = this.addTerminalUnit(
              "synthetic-support",
              null,
              statement,
              statement.name?.text ?? `<unnamed:${this.unnamedFunction++}>`,
              "function",
              false,
              undefined,
              true,
              role,
            );
            this.scanCallable(statement, terminal.id, terminal.id);
          }
        } else {
          const terminal = this.addTerminalUnit(
            "top-level-function",
            null,
            statement,
            statement.name?.text ?? `<unnamed:${this.unnamedFunction++}>`,
            "function",
          );
          this.scanCallable(statement, terminal.id, terminal.id);
        }
        continue;
      }
      if (ts.isClassDeclaration(statement)) {
        const result = this.processClass(statement, null, null, true, this.compilerOrigin(statement));
        if (result.firstStaticInitialization && firstStaticInitialization === undefined) {
          firstStaticInitialization = result.firstStaticInitialization;
        }
        deferredModuleInitScans.push(...result.deferredModuleInitScans);
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        const unit = this.addSupportUnit("export-assignment", null, null, statement, "<export-assignment>");
        this.scanNode(statement.expression, unit.id, null);
      }
    }

    if (modulePopulation.length > 0 || firstStaticInitialization) {
      const anchor = modulePopulation[0] ?? firstStaticInitialization ?? this.sourceFile;
      const terminal = this.addTerminalUnit(
        "module-init",
        null,
        anchor,
        MODULE_INIT_UNIT_NAME,
        "module-init",
        false,
        firstStaticInitialization
          ? {
              kind: "unsupported",
              code: "static-class-initialization",
              stage: "select",
              detail: "class static initialization is still emitted by the direct module-init path",
            }
          : undefined,
      );
      for (const statement of modulePopulation) this.scanNode(statement, terminal.id, terminal.id);
      for (const scan of deferredModuleInitScans) scan(terminal.id);
    }
  }

  private ownerKey(owner: IrLexicalOwnerId | null): string {
    return owner ?? "<root>";
  }

  private compilerOrigin(node: ts.Node): CompilerSourceOrigin | undefined {
    return this.options.compilerOriginAt?.(this.sourceFile, node.getStart(this.sourceFile));
  }

  private nextUnitOrdinal(owner: IrLexicalOwnerId | null, kind: IrUnitKind, node: ts.Node): number {
    const key = `${this.ownerKey(owner)}\u0000${kind}`;
    const canonical = this.options.canonicalUnitOrdinalAt?.(
      this.sourceFile,
      node.getStart(this.sourceFile),
      node.end,
      kind,
    );
    if (canonical !== undefined) {
      if (!Number.isSafeInteger(canonical) || canonical < 0) {
        throw new RangeError(`canonical unit ordinal must be a non-negative safe integer, received ${canonical}`);
      }
      this.unitOrdinals.set(key, Math.max(this.unitOrdinals.get(key) ?? 0, canonical + 1));
      return canonical;
    }
    const ordinal = this.unitOrdinals.get(key) ?? 0;
    this.unitOrdinals.set(key, ordinal + 1);
    return ordinal;
  }

  private nextDerivedUnitOrdinal(parentId: IrSourceId | IrLexicalOwnerId, role: IrSyntheticUnitRole): number {
    const key = `${parentId}\u0000${role}`;
    const ordinal = this.derivedUnitOrdinals.get(key) ?? 0;
    this.derivedUnitOrdinals.set(key, ordinal + 1);
    return ordinal;
  }

  private nextClassOrdinal(
    owner: IrLexicalOwnerId | null,
    declarationKind: "declaration" | "expression",
    node: ts.ClassDeclaration | ts.ClassExpression,
  ): number {
    const key = `${this.ownerKey(owner)}\u0000${declarationKind}`;
    const canonical = this.options.canonicalClassOrdinalAt?.(
      this.sourceFile,
      node.getStart(this.sourceFile),
      node.end,
      declarationKind,
    );
    if (canonical !== undefined) {
      if (!Number.isSafeInteger(canonical) || canonical < 0) {
        throw new RangeError(`canonical class ordinal must be a non-negative safe integer, received ${canonical}`);
      }
      this.classOrdinals.set(key, Math.max(this.classOrdinals.get(key) ?? 0, canonical + 1));
      return canonical;
    }
    const ordinal = this.classOrdinals.get(key) ?? 0;
    this.classOrdinals.set(key, ordinal + 1);
    return ordinal;
  }

  private nextDerivedClassOrdinal(parentId: IrSourceId | IrLexicalOwnerId, role: IrSyntheticClassRole): number {
    const key = `${parentId}\u0000${role}`;
    const ordinal = this.derivedClassOrdinals.get(key) ?? 0;
    this.derivedClassOrdinals.set(key, ordinal + 1);
    return ordinal;
  }

  private position(node: ts.Node): {
    line: number;
    column: number;
    declarationStart: number;
    declarationEnd: number;
  } {
    const declarationStart = node.getStart(this.sourceFile);
    const position = this.sourceFile.getLineAndCharacterOfPosition(declarationStart);
    return {
      line: position.line + 1,
      column: position.character + 1,
      declarationStart,
      declarationEnd: node.end,
    };
  }

  private addClass(
    node: ts.ClassDeclaration | ts.ClassExpression,
    lexicalOwnerId: IrLexicalOwnerId | null,
    displayName: string,
    syntheticRole?: IrSyntheticClassRole,
  ): IrClassRecord {
    const effectiveSyntheticRole =
      syntheticRole ??
      (() => {
        const origin = this.compilerOrigin(node);
        return origin ? compilerClassRole(origin) : undefined;
      })();
    const declarationKind = ts.isClassDeclaration(node) ? "declaration" : "expression";
    const parentId = lexicalOwnerId ?? this.source.id;
    const ordinal = effectiveSyntheticRole
      ? this.nextDerivedClassOrdinal(parentId, effectiveSyntheticRole)
      : this.nextClassOrdinal(lexicalOwnerId, declarationKind, node);
    const record: IrClassRecord = Object.freeze({
      id: effectiveSyntheticRole
        ? createDerivedIrClassId({ parentId, role: effectiveSyntheticRole, ordinal })
        : createIrClassId({ sourceId: this.source.id, lexicalOwnerId, declarationKind, ordinal }),
      sourceId: this.source.id,
      lexicalOwnerId,
      declarationKind,
      ordinal,
      ...(effectiveSyntheticRole ? { syntheticRole: effectiveSyntheticRole } : {}),
      displayName,
      ...this.position(node),
    });
    this.classes.push(record);
    this.classDeclarations.push({ sourceFile: this.sourceFile, declaration: node, record });
    return record;
  }

  private addTerminalUnit(
    kind: IrUnitKind,
    lexicalOwnerId: IrLexicalOwnerId | null,
    node: ts.Node,
    legacyMatchName: string,
    observedKind: IrTerminalObservedKind,
    staticClassMember = false,
    directFailure?: IrPreparationFailure,
    legacyBodyAvailable = true,
    syntheticRole?: IrSyntheticUnitRole,
    containingTerminalOwnerId?: IrUnitId,
  ): IrTerminalUnitRecord {
    const effectiveSyntheticRole =
      syntheticRole ??
      (() => {
        const origin = this.compilerOrigin(node);
        return origin ? compilerUnitRole(origin) : undefined;
      })();
    const parentId = lexicalOwnerId ?? this.source.id;
    const ordinal = effectiveSyntheticRole
      ? this.nextDerivedUnitOrdinal(parentId, effectiveSyntheticRole)
      : this.nextUnitOrdinal(lexicalOwnerId, kind, node);
    const id = effectiveSyntheticRole
      ? createDerivedIrUnitId({ parentId, role: effectiveSyntheticRole, ordinal })
      : createIrUnitId({ sourceId: this.source.id, lexicalOwnerId, kind, ordinal });
    const legacyOrdinalKey = `${observedKind}\u0000${legacyMatchName}`;
    const legacyOrdinal = this.legacyOrdinals.get(legacyOrdinalKey) ?? 0;
    this.legacyOrdinals.set(legacyOrdinalKey, legacyOrdinal + 1);
    const record: IrTerminalUnitRecord = Object.freeze({
      id,
      sourceId: this.source.id,
      lexicalOwnerId,
      kind,
      ordinal,
      ...(effectiveSyntheticRole ? { syntheticRole: effectiveSyntheticRole } : {}),
      displayName: legacyMatchName,
      ...this.position(node),
      terminal: true,
      terminalOwnerId: id,
      ...(containingTerminalOwnerId ? { containingTerminalOwnerId } : {}),
      observedKind,
      legacyKey: `${this.sourceFile.fileName}::${observedKind}::${legacyMatchName}#${legacyOrdinal}`,
      legacyMatchName,
      legacyOrdinal,
      staticClassMember,
      legacyBodyAvailable,
      ...(directFailure ? { directFailure } : {}),
    });
    this.allUnits.push(record);
    this.terminalUnits.push(record);
    if (record.kind !== "module-init") {
      this.unitDeclarations.push({ sourceFile: this.sourceFile, declaration: node, record });
    }
    return record;
  }

  private addSupportUnit(
    kind: IrUnitKind,
    lexicalOwnerId: IrLexicalOwnerId | null,
    terminalOwnerId: IrUnitId | null,
    node: ts.Node,
    displayName: string,
    syntheticRole?: IrSyntheticUnitRole,
  ): IrOwnedSupportUnitRecord | IrUnownedSupportUnitRecord {
    const effectiveSyntheticRole =
      syntheticRole ??
      (() => {
        const origin = this.compilerOrigin(node);
        return origin ? compilerUnitRole(origin) : undefined;
      })();
    const parentId = lexicalOwnerId ?? this.source.id;
    const ordinal = effectiveSyntheticRole
      ? this.nextDerivedUnitOrdinal(parentId, effectiveSyntheticRole)
      : this.nextUnitOrdinal(lexicalOwnerId, kind, node);
    const base = {
      id: effectiveSyntheticRole
        ? createDerivedIrUnitId({ parentId, role: effectiveSyntheticRole, ordinal })
        : createIrUnitId({ sourceId: this.source.id, lexicalOwnerId, kind, ordinal }),
      sourceId: this.source.id,
      lexicalOwnerId,
      kind,
      ordinal,
      ...(effectiveSyntheticRole ? { syntheticRole: effectiveSyntheticRole } : {}),
      displayName,
      ...this.position(node),
      terminal: false as const,
    };
    const record = Object.freeze(
      terminalOwnerId === null
        ? { ...base, terminalOwnerId: null, unownedReason: "no-r0-attempt-root" as const }
        : { ...base, terminalOwnerId },
    );
    this.allUnits.push(record);
    this.unitDeclarations.push({ sourceFile: this.sourceFile, declaration: node, record });
    return record;
  }

  private classMemberKind(
    member: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  ): IrUnitKind {
    const placement = hasStaticModifier(member) ? "static" : "instance";
    if (ts.isGetAccessorDeclaration(member)) return `class-${placement}-getter`;
    if (ts.isSetAccessorDeclaration(member)) return `class-${placement}-setter`;
    return `class-${placement}-method`;
  }

  private processClass(
    node: ts.ClassDeclaration | ts.ClassExpression,
    lexicalOwnerId: IrLexicalOwnerId | null,
    inheritedTerminalOwnerId: IrUnitId | null,
    topLevelDeclaration: boolean,
    compilerOrigin?: CompilerSourceOrigin,
  ): {
    firstStaticInitialization?: ts.Node;
    deferredModuleInitScans: ((moduleOwner: IrUnitId) => void)[];
  } {
    const isAnonymousTopLevel = topLevelDeclaration && !node.name;
    const displayName =
      node.name?.text ??
      (topLevelDeclaration ? `<anonymous-default-class:${this.anonymousDefaultClass++}>` : "<anonymous-class>");
    const classRecord = this.addClass(
      node,
      lexicalOwnerId,
      displayName,
      compilerOrigin ? compilerClassRole(compilerOrigin) : undefined,
    );
    const directNestedClass =
      !topLevelDeclaration && inheritedTerminalOwnerId !== null && lexicalOwnerId === inheritedTerminalOwnerId;
    const deferredModuleInitScans: ((moduleOwner: IrUnitId) => void)[] = [];
    const definitionExpressions: ts.Expression[] = [...decoratorExpressions(node)];
    for (const clause of node.heritageClauses ?? []) {
      for (const heritageType of clause.types) definitionExpressions.push(heritageType.expression);
    }
    for (const member of node.members) {
      definitionExpressions.push(...decoratorExpressions(member));
      if (
        ts.isConstructorDeclaration(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        for (const parameter of member.parameters) definitionExpressions.push(...decoratorExpressions(parameter));
      }
      if (member.name && ts.isComputedPropertyName(member.name)) definitionExpressions.push(member.name.expression);
    }
    const scanDefinitionExpressions = (terminalOwnerId: IrUnitId | null): void => {
      for (const expression of definitionExpressions) this.scanNode(expression, classRecord.id, terminalOwnerId);
    };
    if (topLevelDeclaration) scanDefinitionExpressions(null);
    else scanDefinitionExpressions(inheritedTerminalOwnerId);
    const anonymousFailure: IrPreparationFailure | undefined = isAnonymousTopLevel
      ? {
          kind: "unsupported",
          code: "anonymous-class",
          stage: "select",
          detail: `${displayName} has no stable direct-codegen class identity for IR patching`,
        }
      : undefined;
    let explicitConstructor: IrUnitRecord | undefined;
    let hasExecutableConstructor = false;
    let firstInstanceInitializer: ts.PropertyDeclaration | undefined;
    let firstStaticInitialization: ts.Node | undefined;
    const instanceInitializers: ts.PropertyDeclaration[] = [];

    for (const member of node.members) {
      const isStatic = hasStaticModifier(member);
      const memberCompilerOrigin = this.compilerOrigin(member) ?? compilerOrigin;
      const memberSyntheticRole = memberCompilerOrigin ? compilerUnitRole(memberCompilerOrigin) : undefined;
      if (ts.isClassStaticBlockDeclaration(member)) {
        firstStaticInitialization ??= member;
        const scan = (terminalOwnerId: IrUnitId | null): void => {
          const unit = this.addSupportUnit(
            "class-static-block",
            classRecord.id,
            terminalOwnerId,
            member,
            `${displayName}.<static-block>`,
            memberSyntheticRole,
          );
          this.scanNode(member.body, unit.id, terminalOwnerId);
        };
        if (topLevelDeclaration) deferredModuleInitScans.push((moduleOwner) => scan(moduleOwner));
        else scan(inheritedTerminalOwnerId);
        continue;
      }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        if (isStatic) {
          firstStaticInitialization ??= member;
          const scan = (terminalOwnerId: IrUnitId | null): void => {
            const unit = this.addSupportUnit(
              "class-static-field-initializer",
              classRecord.id,
              terminalOwnerId,
              member,
              `${displayName}.${memberBaseName(member.name)}`,
              memberSyntheticRole,
            );
            this.scanNode(member.initializer!, unit.id, terminalOwnerId);
          };
          if (topLevelDeclaration) deferredModuleInitScans.push((moduleOwner) => scan(moduleOwner));
          else scan(inheritedTerminalOwnerId);
        } else {
          firstInstanceInitializer ??= member;
          instanceInitializers.push(member);
        }
        continue;
      }

      const legacyName = classMemberLegacyName(displayName, member);
      if (legacyName === null) continue;
      const functionalMember = member as
        | ts.ConstructorDeclaration
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration;
      if (!functionalMember.body) continue;
      if (ts.isConstructorDeclaration(functionalMember)) hasExecutableConstructor = true;
      const promoteNestedAccessor =
        directNestedClass &&
        (ts.isGetAccessorDeclaration(functionalMember) || ts.isSetAccessorDeclaration(functionalMember));
      const promoteNestedOrdinary =
        directNestedClass &&
        isBoundedPreparedNestedOrdinaryClass(node) &&
        (ts.isConstructorDeclaration(functionalMember) || ts.isMethodDeclaration(functionalMember));
      const promoteNestedMember = promoteNestedAccessor || promoteNestedOrdinary;

      const unit =
        topLevelDeclaration || promoteNestedMember
          ? this.addTerminalUnit(
              ts.isConstructorDeclaration(functionalMember)
                ? "class-constructor"
                : this.classMemberKind(functionalMember),
              classRecord.id,
              member,
              promoteNestedMember
                ? `${legacyName}@nested:${classRecord.declarationStart}:${member.getStart(this.sourceFile)}`
                : legacyName,
              "class-member",
              isStatic,
              anonymousFailure,
              true,
              memberSyntheticRole,
              promoteNestedMember ? (inheritedTerminalOwnerId ?? undefined) : undefined,
            )
          : this.addSupportUnit(
              ts.isConstructorDeclaration(functionalMember)
                ? "class-constructor"
                : this.classMemberKind(functionalMember),
              classRecord.id,
              inheritedTerminalOwnerId,
              member,
              legacyName,
              memberSyntheticRole,
            );
      if (ts.isConstructorDeclaration(functionalMember)) explicitConstructor = unit;
      this.scanCallable(
        functionalMember,
        unit.id,
        topLevelDeclaration || promoteNestedMember ? unit.id : inheritedTerminalOwnerId,
      );
    }

    const promoteNestedImplicitInitializer =
      directNestedClass && !hasExecutableConstructor && isBoundedPreparedNestedOrdinaryClass(node);
    if (!hasExecutableConstructor && firstInstanceInitializer) {
      explicitConstructor =
        topLevelDeclaration || promoteNestedImplicitInitializer
          ? this.addTerminalUnit(
              "class-implicit-constructor",
              classRecord.id,
              node,
              promoteNestedImplicitInitializer
                ? `${displayName}_new@nested:${classRecord.declarationStart}:${node.getStart(this.sourceFile)}`
                : `${displayName}_new`,
              "class-member",
              false,
              undefined,
              true,
              compilerOrigin ? compilerUnitRole(compilerOrigin) : undefined,
              promoteNestedImplicitInitializer ? (inheritedTerminalOwnerId ?? undefined) : undefined,
            )
          : this.addSupportUnit(
              "class-implicit-constructor",
              classRecord.id,
              inheritedTerminalOwnerId,
              node,
              `${displayName}_new`,
              compilerOrigin ? compilerUnitRole(compilerOrigin) : undefined,
            );
    } else if (!hasExecutableConstructor && !hasDeclareModifier(node)) {
      explicitConstructor = this.addSupportUnit(
        "class-implicit-constructor",
        classRecord.id,
        topLevelDeclaration ? null : inheritedTerminalOwnerId,
        node,
        `${displayName}_new`,
        compilerOrigin ? compilerUnitRole(compilerOrigin) : undefined,
      );
    }

    const instanceTerminalOwner =
      topLevelDeclaration || promoteNestedImplicitInitializer
        ? (explicitConstructor?.id ?? null)
        : inheritedTerminalOwnerId;
    for (const field of instanceInitializers) {
      const fieldCompilerOrigin = this.compilerOrigin(field) ?? compilerOrigin;
      const unit = this.addSupportUnit(
        "class-instance-field-initializer",
        classRecord.id,
        instanceTerminalOwner,
        field,
        `${displayName}.${memberBaseName(field.name)}`,
        fieldCompilerOrigin ? compilerUnitRole(fieldCompilerOrigin) : undefined,
      );
      this.scanNode(field.initializer!, unit.id, instanceTerminalOwner);
    }

    return {
      ...(firstStaticInitialization ? { firstStaticInitialization } : {}),
      deferredModuleInitScans,
    };
  }

  private scanCallable(
    node:
      | ts.FunctionDeclaration
      | ts.FunctionExpression
      | ts.ArrowFunction
      | ts.ConstructorDeclaration
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
    lexicalOwnerId: IrUnitId,
    terminalOwnerId: IrUnitId | null,
  ): void {
    for (const parameter of node.parameters) {
      this.scanNode(parameter.name, lexicalOwnerId, terminalOwnerId);
      if (parameter.initializer) this.scanNode(parameter.initializer, lexicalOwnerId, terminalOwnerId);
    }
    if (node.body) this.scanNode(node.body, lexicalOwnerId, terminalOwnerId);
  }

  private scanNode(node: ts.Node, lexicalOwnerId: IrLexicalOwnerId, terminalOwnerId: IrUnitId | null): void {
    const visit = (child: ts.Node): void => {
      if (ts.isClassDeclaration(child) || ts.isClassExpression(child)) {
        this.processClass(child, lexicalOwnerId, terminalOwnerId, false, this.compilerOrigin(child));
        return;
      }
      if (ts.isFunctionDeclaration(child) && child.body) {
        const unit = this.addSupportUnit(
          "nested-function",
          lexicalOwnerId,
          terminalOwnerId,
          child,
          functionDisplayName(child),
        );
        this.scanCallable(child, unit.id, terminalOwnerId);
        return;
      }
      if (ts.isFunctionExpression(child) && child.body) {
        const unit = this.addSupportUnit(
          "function-expression",
          lexicalOwnerId,
          terminalOwnerId,
          child,
          functionDisplayName(child),
        );
        this.scanCallable(child, unit.id, terminalOwnerId);
        return;
      }
      if (ts.isArrowFunction(child)) {
        const unit = this.addSupportUnit(
          "arrow-function",
          lexicalOwnerId,
          terminalOwnerId,
          child,
          functionDisplayName(child),
        );
        this.scanCallable(child, unit.id, terminalOwnerId);
        return;
      }
      if (
        (ts.isMethodDeclaration(child) || ts.isGetAccessorDeclaration(child) || ts.isSetAccessorDeclaration(child)) &&
        ts.isObjectLiteralExpression(child.parent) &&
        child.body
      ) {
        if (ts.isComputedPropertyName(child.name)) {
          this.scanNode(child.name.expression, lexicalOwnerId, terminalOwnerId);
        }
        const kind = ts.isGetAccessorDeclaration(child)
          ? "object-getter"
          : ts.isSetAccessorDeclaration(child)
            ? "object-setter"
            : "object-method";
        const unit = this.addSupportUnit(kind, lexicalOwnerId, terminalOwnerId, child, objectMemberDisplayName(child));
        this.scanCallable(child, unit.id, terminalOwnerId);
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
}

/**
 * Build the deterministic source-AST/compiler-prelude inventory without
 * changing compiler selection, preparation, allocation, or body routing.
 */
export function buildIrUnitInventory(
  sourceFiles: readonly ts.SourceFile[],
  options: BuildIrUnitInventoryOptions = {},
): IrUnitInventory {
  const keyed = orderSourceKeys(sourceKeys(sourceFiles, options.entrySource), options);
  const sources: IrSourceRecord[] = keyed.map(({ sourceFile, kind, sourceKey }, order) =>
    Object.freeze({
      id: createIrSourceId({ kind, order, sourceKey }),
      kind,
      order,
      sourceKey,
      displayName: sourceFile.fileName,
      originalFileName: sourceFile.fileName,
    }),
  );
  const classes: IrClassRecord[] = [];
  const allUnits: IrUnitRecord[] = [];
  const terminalUnits: IrTerminalUnitRecord[] = [];
  const scannedUnits: IrInventoryScannerMetadata["units"][number][] = [];
  const scannedClasses: IrInventoryScannerMetadata["classes"][number][] = [];
  for (let index = 0; index < keyed.length; index++) {
    const builder = new SourceInventoryBuilder(keyed[index]!.sourceFile, sources[index]!, options);
    builder.build();
    classes.push(...builder.classes);
    allUnits.push(...builder.allUnits);
    terminalUnits.push(...builder.terminalUnits);
    scannedUnits.push(...builder.unitDeclarations);
    scannedClasses.push(...builder.classDeclarations);
  }
  const inventory: IrUnitInventory = Object.freeze({
    sources: Object.freeze(sources),
    classes: Object.freeze(classes),
    allUnits: Object.freeze(allUnits),
    terminalUnits: Object.freeze(terminalUnits),
  });
  scannerMetadataByInventory.set(
    inventory,
    Object.freeze({
      sources: Object.freeze(
        keyed.map(({ sourceFile }, index) => Object.freeze({ sourceFile, record: sources[index]! })),
      ),
      units: Object.freeze(scannedUnits.map((entry) => Object.freeze(entry))),
      classes: Object.freeze(scannedClasses.map((entry) => Object.freeze(entry))),
    }),
  );
  return inventory;
}

/** Exact source join used by codegen; original filenames remain observational. */
export function terminalIrUnitsForSource(
  inventory: IrUnitInventory,
  sourceFile: ts.SourceFile | string,
): readonly IrTerminalUnitRecord[] {
  const fileName = typeof sourceFile === "string" ? sourceFile : sourceFile.fileName;
  const source = inventory.sources.find((record) => record.originalFileName === fileName);
  return source ? inventory.terminalUnits.filter((unit) => unit.sourceId === source.id) : [];
}

/**
 * Build the validated AST-declaration join R2 can thread into declaration
 * collection. No display-name lookup participates in this map.
 */
export function indexIrTerminalDeclarations(
  sourceFile: ts.SourceFile,
  inventory: IrUnitInventory,
): ReadonlyMap<ts.Node, IrUnitId> {
  const scanned = getIrInventoryScannerMetadata(inventory);
  if (!scanned) throw new Error("terminal declaration index requires the exact built IR inventory");
  const scannedSource = scanned.sources.find((entry) => entry.sourceFile === sourceFile);
  if (!scannedSource || scannedSource.record.originalFileName !== sourceFile.fileName) {
    throw new Error(`source ${sourceFile.fileName} does not match the exact built IR inventory`);
  }
  const terminals = inventory.terminalUnits.filter((unit) => unit.sourceId === scannedSource.record.id);
  if (terminals.length === 0) return new Map();
  const declarationByRecord = new Map<IrUnitRecord, ts.Node>();
  for (const entry of scanned.units) {
    if (declarationByRecord.has(entry.record)) {
      throw new Error(`unit ${entry.record.id} maps to multiple exact AST declarations`);
    }
    declarationByRecord.set(entry.record, entry.declaration);
  }
  const result = new Map<ts.Node, IrUnitId>();
  for (const terminal of terminals) {
    if (terminal.observedKind === "module-init") {
      if (result.has(sourceFile)) throw new Error(`duplicate module-init identity for ${sourceFile.fileName}`);
      result.set(sourceFile, terminal.id);
      continue;
    }
    const declaration = declarationByRecord.get(terminal);
    if (!declaration || declaration.getSourceFile() !== sourceFile) {
      throw new Error(`terminal identity ${terminal.id} has no exact AST declaration match in ${sourceFile.fileName}`);
    }
    if (result.has(declaration))
      throw new Error(`AST declaration maps to multiple terminal identities in ${sourceFile.fileName}`);
    result.set(declaration, terminal.id);
  }
  if (result.size !== terminals.length) {
    throw new Error(
      `terminal declaration index mismatch for ${sourceFile.fileName}: ${result.size} declarations for ${terminals.length} units`,
    );
  }
  return result;
}
