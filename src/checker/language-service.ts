// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { AnalyzeOptions, MultiTypedAST, TypedAST } from "./index.js";
import { filterRecognizedDenoStdioDiagnostics, getLibSourceFile, isKnownLibName } from "./index.js";
import {
  buildBareSpecifierLookup,
  multiFileScriptKind,
  normalizeMultiFileName,
  resolveMultiFileModule,
} from "./multi-file-paths.js";

// TypeScript explicitly supports one DocumentRegistry shared by many language
// services. SourceFile ASTs account for most language-service memory, and every
// compiler instance sees the same large immutable lib composite. User-document
// versions include a per-service namespace below, so two independent compilers
// using the same virtual filename can never alias different source text.
const SHARED_DOCUMENT_REGISTRY = ts.createDocumentRegistry(true, "/");
const SHARED_LIB_SNAPSHOTS = new Map<string, ts.IScriptSnapshot>();
let nextServiceId = 0;

/**
 * A versioned snapshot for the one mutable user source owned by an incremental
 * compiler instance.
 *
 * TypeScript's language service asks the new snapshot for a change range from
 * the previous one. Returning the exact common-prefix/common-suffix edit lets
 * it incrementally update the SourceFile instead of reparsing the whole file.
 * A filename or ScriptKind change deliberately disables that reuse.
 */
class SourceSnapshot implements ts.IScriptSnapshot {
  constructor(
    private readonly text: string,
    private readonly reuseKey: string,
  ) {}

  getText(start: number, end: number): string {
    return this.text.slice(start, end);
  }

  getLength(): number {
    return this.text.length;
  }

  getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange | undefined {
    if (!(oldSnapshot instanceof SourceSnapshot) || oldSnapshot.reuseKey !== this.reuseKey) {
      return undefined;
    }

    const oldText = oldSnapshot.text;
    if (oldText === this.text) {
      return ts.createTextChangeRange(ts.createTextSpan(0, 0), 0);
    }

    const sharedLength = Math.min(oldText.length, this.text.length);
    let prefix = 0;
    while (prefix < sharedLength && oldText.charCodeAt(prefix) === this.text.charCodeAt(prefix)) {
      prefix++;
    }

    let suffix = 0;
    const remainingOld = oldText.length - prefix;
    const remainingNew = this.text.length - prefix;
    const maxSuffix = Math.min(remainingOld, remainingNew);
    while (
      suffix < maxSuffix &&
      oldText.charCodeAt(oldText.length - suffix - 1) === this.text.charCodeAt(this.text.length - suffix - 1)
    ) {
      suffix++;
    }

    return ts.createTextChangeRange(
      ts.createTextSpan(prefix, oldText.length - prefix - suffix),
      this.text.length - prefix - suffix,
    );
  }
}

function scriptKindFor(fileName: string, forceTsGrammar: boolean): ts.ScriptKind {
  if (forceTsGrammar) return ts.ScriptKind.TS;
  const ext = fileName.match(/\.(tsx|jsx|ts|js|mjs|cjs)$/)?.[1];
  switch (ext) {
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "js":
    case "mjs":
    case "cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function virtualLibName(fileName: string): string | undefined {
  const normalized = fileName.replaceAll("\\", "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return isKnownLibName(baseName) ? baseName : undefined;
}

function canonicalVirtualFileName(fileName: string): string {
  const parts: string[] = [];
  for (const part of fileName.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Incremental compiler backed by TypeScript's versioned Language Service.
 *
 * The service owns one mutable source identity. Unchanged builds reuse the same
 * Program/checker and diagnostics; edited builds update the source snapshot and
 * let TypeScript retain unaffected bind/check state. Lib snapshots are immutable
 * and shared for the lifetime of the service.
 *
 * This intentionally does not pass a raw `oldProgram` between independent
 * `createProgram` calls. The language service owns invalidation through file,
 * project, ScriptKind, and compiler-option versions, preventing the stale-state
 * leakage previously seen in the test262 worker pool (#1119).
 */
export class IncrementalLanguageService {
  private readonly serviceId = ++nextServiceId;
  private currentSource = "";
  private currentSnapshot: SourceSnapshot | undefined;
  private fileName: string;
  private scriptKind: ts.ScriptKind;
  private sourceVersion = 0;
  private projectVersion = 0;
  private compilerOptions: ts.CompilerOptions;
  private compilerOptionsKey = "";
  private defaultLibName = "lib.d.ts";
  private readonly host: ts.LanguageServiceHost;
  private service: ts.LanguageService;
  private disposed = false;

  constructor(fileName = "input.ts") {
    this.fileName = fileName;
    this.scriptKind = scriptKindFor(fileName, false);
    const initialAllowJs = this.scriptKind === ts.ScriptKind.JS || this.scriptKind === ts.ScriptKind.JSX;
    this.compilerOptions = this.buildCompilerOptions(initialAllowJs);
    this.compilerOptionsKey = this.optionsKey(initialAllowJs, this.defaultLibName);

    this.host = {
      getCompilationSettings: () => this.compilerOptions,
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => [this.fileName],
      getScriptKind: (name: string) => (this.isCurrentFile(name) ? this.scriptKind : ts.ScriptKind.TS),
      getScriptVersion: (name: string) => (this.isCurrentFile(name) ? `${this.serviceId}:${this.sourceVersion}` : "0"),
      getScriptSnapshot: (name: string) => this.getScriptSnapshot(name),
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => this.defaultLibName,
      getNewLine: () => "\n",
      useCaseSensitiveFileNames: () => true,
      fileExists: (name: string) => this.isCurrentFile(name) || virtualLibName(name) !== undefined,
      readFile: (name: string) => this.readFile(name),
      readDirectory: () => [],
      getDirectories: () => [],
      directoryExists: () => true,
      realpath: (name: string) => name,
    };

    this.service = ts.createLanguageService(this.host, SHARED_DOCUMENT_REGISTRY);
  }

  /** Update the source snapshot for the next compilation. */
  updateSource(source: string, fileName?: string, forceTsGrammar = false): void {
    this.assertActive();
    const nextFileName = fileName ?? this.fileName;
    const nextScriptKind = scriptKindFor(nextFileName, forceTsGrammar);
    const changed =
      source !== this.currentSource || nextFileName !== this.fileName || nextScriptKind !== this.scriptKind;

    if (!changed && this.currentSnapshot) return;

    this.currentSource = source;
    this.fileName = nextFileName;
    this.scriptKind = nextScriptKind;
    this.sourceVersion++;
    this.projectVersion++;
    this.currentSnapshot = new SourceSnapshot(source, `${nextFileName}:${nextScriptKind}`);
  }

  /** Analyze using the persistent, versioned Program owned by the language service. */
  analyze(analyzeOptions?: AnalyzeOptions): TypedAST {
    this.assertActive();
    if (!this.currentSnapshot) {
      this.updateSource(this.currentSource, this.fileName);
    }

    const allowJs =
      analyzeOptions?.allowJs === true || this.scriptKind === ts.ScriptKind.JS || this.scriptKind === ts.ScriptKind.JSX;
    const nextDefaultLibName =
      analyzeOptions?.platform === "node" || analyzeOptions?.platform === "deno" ? "lib.no-dom.d.ts" : "lib.d.ts";
    const nextOptionsKey = this.optionsKey(allowJs, nextDefaultLibName);
    if (nextOptionsKey !== this.compilerOptionsKey) {
      this.compilerOptions = this.buildCompilerOptions(allowJs);
      this.defaultLibName = nextDefaultLibName;
      this.compilerOptionsKey = nextOptionsKey;
      this.projectVersion++;
      // `defaultLibName` is a host-level choice rather than a CompilerOptions
      // field. TypeScript does not include it in its project-structure reuse
      // key, so merely bumping getProjectVersion can leave the old ambient lib
      // attached. Recreate the service on any configuration change; source-only
      // edits stay on the fast incremental path.
      this.service.dispose();
      this.service = ts.createLanguageService(this.host, SHARED_DOCUMENT_REGISTRY);
    }

    const program = this.service.getProgram();
    if (!program) throw new Error("Incremental TypeScript language service did not create a Program");

    const sourceFile =
      program.getSourceFile(this.fileName) ??
      program.getSourceFiles().find((candidate) => this.isCurrentFile(candidate.fileName));
    if (!sourceFile) throw new Error(`Incremental TypeScript Program is missing source file '${this.fileName}'`);

    const checker = program.getTypeChecker();
    const syntacticDiagnostics = this.service.getSyntacticDiagnostics(sourceFile.fileName);
    const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as ts.Diagnostic[])
      : this.service.getSemanticDiagnostics(sourceFile.fileName);

    return {
      sourceFile,
      checker,
      program,
      diagnostics: [...syntacticDiagnostics, ...semanticDiagnostics],
      syntacticDiagnostics,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.service.dispose();
    this.currentSnapshot = undefined;
  }

  private buildCompilerOptions(allowJs: boolean): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
      ...(this.scriptKind === ts.ScriptKind.TSX || this.scriptKind === ts.ScriptKind.JSX
        ? { jsx: ts.JsxEmit.ReactJSX }
        : {}),
      ...(allowJs ? { allowJs: true, checkJs: true } : {}),
    };
  }

  private optionsKey(allowJs: boolean, defaultLibName: string): string {
    return `${allowJs ? "js" : "ts"}:${this.scriptKind}:${defaultLibName}`;
  }

  private isCurrentFile(name: string): boolean {
    if (name === this.fileName) return true;
    return canonicalVirtualFileName(name) === canonicalVirtualFileName(this.fileName);
  }

  private getScriptSnapshot(name: string): ts.IScriptSnapshot | undefined {
    if (this.isCurrentFile(name)) return this.currentSnapshot;

    const libName = virtualLibName(name);
    if (!libName) return undefined;
    const cached = SHARED_LIB_SNAPSHOTS.get(libName);
    if (cached) return cached;

    const sourceFile = getLibSourceFile(libName, this.compilerOptions.target ?? ts.ScriptTarget.ES2022);
    if (!sourceFile) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(sourceFile.text);
    SHARED_LIB_SNAPSHOTS.set(libName, snapshot);
    return snapshot;
  }

  private readFile(name: string): string | undefined {
    if (this.isCurrentFile(name)) return this.currentSource;
    const snapshot = this.getScriptSnapshot(name);
    return snapshot?.getText(0, snapshot.getLength());
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Incremental TypeScript language service has been disposed");
  }
}

interface ProjectDocument {
  readonly text: string;
  readonly snapshot: SourceSnapshot;
  readonly scriptKind: ts.ScriptKind;
  readonly version: number;
}

/**
 * Persistent Language Service for an in-memory multi-file project.
 *
 * Each virtual file has an independent version and snapshot. Replacing a
 * project graph therefore retains AST/checker state for unchanged dependencies
 * while precisely invalidating edited, added, removed, or renamed files.
 */
export class IncrementalProjectLanguageService {
  private readonly serviceId = ++nextServiceId;
  private documents = new Map<string, ProjectDocument>();
  private rootNames: string[] = [];
  private entryFile = "";
  private bareSpecifierLookup = new Map<string, string>();
  private specifierMapKey = "";
  private nextDocumentVersion = 0;
  private projectVersion = 0;
  private compilerOptions: ts.CompilerOptions = this.buildCompilerOptions(false, false);
  private compilerOptionsKey = "";
  private defaultLibName = "lib.d.ts";
  private readonly host: ts.LanguageServiceHost;
  private service: ts.LanguageService;
  private disposed = false;

  constructor() {
    this.host = {
      getCompilationSettings: () => this.compilerOptions,
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => this.rootNames,
      getScriptKind: (name: string) => this.documentFor(name)?.scriptKind ?? ts.ScriptKind.TS,
      getScriptVersion: (name: string) => {
        const document = this.documentFor(name);
        return document ? `${this.serviceId}:${document.version}` : "0";
      },
      getScriptSnapshot: (name: string) => this.getScriptSnapshot(name),
      getCurrentDirectory: () => "",
      getDefaultLibFileName: () => this.defaultLibName,
      getNewLine: () => "\n",
      useCaseSensitiveFileNames: () => true,
      fileExists: (name: string) => this.documentFor(name) !== undefined || virtualLibName(name) !== undefined,
      readFile: (name: string) => this.readFile(name),
      readDirectory: () => [],
      getDirectories: () => [],
      directoryExists: () => true,
      realpath: (name: string) => name,
      resolveModuleNameLiterals: (moduleLiterals, containingFile) =>
        moduleLiterals.map((literal) => ({
          resolvedModule: resolveMultiFileModule(
            literal.text,
            containingFile,
            this.documents,
            this.bareSpecifierLookup,
          ),
        })),
    };
    this.service = ts.createLanguageService(this.host, SHARED_DOCUMENT_REGISTRY);
  }

  /** Replace the visible project graph while retaining every unchanged document. */
  updateProject(files: Record<string, string>, entryFile: string, specifierMap?: Record<string, string>): void {
    this.assertActive();

    const normalizedSources = new Map<string, string>();
    for (const [name, source] of Object.entries(files)) {
      normalizedSources.set(normalizeMultiFileName(name), source);
    }
    const nextRootNames = Array.from(normalizedSources.keys());
    const nextEntryFile = normalizeMultiFileName(entryFile);
    if (!normalizedSources.has(nextEntryFile)) {
      throw new Error(`Incremental TypeScript project is missing entry file '${entryFile}'`);
    }

    const nextDocuments = new Map<string, ProjectDocument>();
    for (const [name, text] of normalizedSources) {
      const scriptKind = multiFileScriptKind(name);
      const previous = this.documents.get(name);
      if (previous && previous.text === text && previous.scriptKind === scriptKind) {
        nextDocuments.set(name, previous);
        continue;
      }

      nextDocuments.set(name, {
        text,
        scriptKind,
        version: ++this.nextDocumentVersion,
        snapshot: new SourceSnapshot(text, `${this.serviceId}:${name}:${scriptKind}`),
      });
    }

    const nextSpecifierMapKey = JSON.stringify(Object.entries(specifierMap ?? {}));
    const changed =
      nextEntryFile !== this.entryFile ||
      nextSpecifierMapKey !== this.specifierMapKey ||
      !sameStringArray(nextRootNames, this.rootNames) ||
      projectDocumentsChanged(nextDocuments, this.documents);

    this.documents = nextDocuments;
    this.rootNames = nextRootNames;
    this.entryFile = nextEntryFile;
    this.specifierMapKey = nextSpecifierMapKey;
    this.bareSpecifierLookup = buildBareSpecifierLookup(nextDocuments, specifierMap);
    if (changed) this.projectVersion++;
  }

  /** Analyze the current graph with precise per-file Language Service invalidation. */
  analyze(analyzeOptions?: AnalyzeOptions): MultiTypedAST {
    this.assertActive();
    if (this.documents.size === 0) {
      throw new Error("Incremental TypeScript project has no source files");
    }

    const allowJs = analyzeOptions?.allowJs === true;
    const hasJsx = this.rootNames.some((name) => {
      const kind = this.documents.get(name)?.scriptKind;
      return kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX;
    });
    const nextDefaultLibName =
      analyzeOptions?.platform === "node" || analyzeOptions?.platform === "deno" ? "lib.no-dom.d.ts" : "lib.d.ts";
    const nextOptionsKey = `${allowJs ? "js" : "ts"}:${hasJsx ? "jsx" : "plain"}:${nextDefaultLibName}`;
    if (nextOptionsKey !== this.compilerOptionsKey) {
      this.compilerOptions = this.buildCompilerOptions(allowJs, hasJsx);
      this.defaultLibName = nextDefaultLibName;
      this.compilerOptionsKey = nextOptionsKey;
      this.projectVersion++;
      this.service.dispose();
      this.service = ts.createLanguageService(this.host, SHARED_DOCUMENT_REGISTRY);
    }

    const program = this.service.getProgram();
    if (!program) throw new Error("Incremental TypeScript project service did not create a Program");

    const entrySourceFile = this.programSourceFile(program, this.entryFile);
    if (!entrySourceFile) {
      throw new Error(`Incremental TypeScript Program is missing entry file '${this.entryFile}'`);
    }

    const syntacticDiagnostics = program.getSyntacticDiagnostics();
    const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as ts.Diagnostic[])
      : program.getSemanticDiagnostics();
    const diagnostics = filterRecognizedDenoStdioDiagnostics([...syntacticDiagnostics, ...semanticDiagnostics]);

    return {
      sourceFiles: this.orderSourceFiles(program, entrySourceFile),
      entryFile: entrySourceFile,
      checker: program.getTypeChecker(),
      program,
      diagnostics,
      syntacticDiagnostics,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.service.dispose();
    this.documents.clear();
    this.rootNames = [];
  }

  private buildCompilerOptions(allowJs: boolean, hasJsx: boolean): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
      ...(hasJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      ...(allowJs ? { allowJs: true, checkJs: true } : {}),
    };
  }

  private documentFor(name: string): ProjectDocument | undefined {
    return this.documents.get(name) ?? this.documents.get(normalizeMultiFileName(name));
  }

  private getScriptSnapshot(name: string): ts.IScriptSnapshot | undefined {
    const document = this.documentFor(name);
    if (document) return document.snapshot;

    const libName = virtualLibName(name);
    if (!libName) return undefined;
    const cached = SHARED_LIB_SNAPSHOTS.get(libName);
    if (cached) return cached;

    const sourceFile = getLibSourceFile(libName, this.compilerOptions.target ?? ts.ScriptTarget.ES2022);
    if (!sourceFile) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(sourceFile.text);
    SHARED_LIB_SNAPSHOTS.set(libName, snapshot);
    return snapshot;
  }

  private readFile(name: string): string | undefined {
    const document = this.documentFor(name);
    if (document) return document.text;
    const snapshot = this.getScriptSnapshot(name);
    return snapshot?.getText(0, snapshot.getLength());
  }

  private programSourceFile(program: ts.Program, name: string): ts.SourceFile | undefined {
    return (
      program.getSourceFile(name) ??
      program
        .getSourceFiles()
        .find((sourceFile) => normalizeMultiFileName(sourceFile.fileName) === normalizeMultiFileName(name))
    );
  }

  private orderSourceFiles(program: ts.Program, entrySourceFile: ts.SourceFile): ts.SourceFile[] {
    const ordered: ts.SourceFile[] = [];
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const visit = (name: string): void => {
      const normalizedName = normalizeMultiFileName(name);
      if (visited.has(normalizedName) || onStack.has(normalizedName)) return;
      const sourceFile = this.programSourceFile(program, normalizedName);
      if (!sourceFile) return;

      onStack.add(normalizedName);
      for (const statement of sourceFile.statements) {
        const specifier =
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined;
        if (!specifier) continue;
        // Match analyzeMultiSource and the Program's custom virtual resolver
        // exactly, including canonical file: URL identities (#4377).
        const resolved = resolveMultiFileModule(
          specifier,
          normalizedName,
          this.documents,
          this.bareSpecifierLookup,
        )?.resolvedFileName;
        if (resolved && resolved !== normalizedName) visit(resolved);
      }
      visited.add(normalizedName);
      onStack.delete(normalizedName);
      if (sourceFile !== entrySourceFile) ordered.push(sourceFile);
    };

    visit(this.entryFile);
    ordered.push(entrySourceFile);
    for (const name of this.rootNames) {
      if (visited.has(name) || name === this.entryFile) continue;
      const sourceFile = this.programSourceFile(program, name);
      if (sourceFile && sourceFile !== entrySourceFile && !ordered.includes(sourceFile)) {
        ordered.splice(ordered.length - 1, 0, sourceFile);
      }
    }
    return ordered;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Incremental TypeScript project service has been disposed");
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function projectDocumentsChanged(
  left: ReadonlyMap<string, ProjectDocument>,
  right: ReadonlyMap<string, ProjectDocument>,
): boolean {
  if (left.size !== right.size) return true;
  for (const [name, document] of left) {
    if (right.get(name) !== document) return true;
  }
  return false;
}
