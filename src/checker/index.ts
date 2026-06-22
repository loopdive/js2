// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { getDefaultEnvironment } from "../env.js";

// All Node builtin access goes through the environment adapter (#1096).
// This module no longer probes `typeof window` / `typeof process` directly
// and no longer uses top-level `await` to load `node:fs`, `node:path`,
// `node:module`, `node:url` — `getDefaultEnvironment()` is fully synchronous,
// which lets embedders import the checker without forcing the whole module
// graph through async initialization.

type TsLibGlobal = {
  __js2wasmTsLibFiles?: Record<string, string>;
  __ts2wasmTsLibFiles?: Record<string, string>;
};

function getBundledLibFiles(): Record<string, string> | undefined {
  const globalObject = globalThis as TsLibGlobal;
  const files = globalObject.__js2wasmTsLibFiles ?? globalObject.__ts2wasmTsLibFiles;
  return files && typeof files === "object" ? (files as Record<string, string>) : undefined;
}

export function preloadLibFiles(files: Record<string, string>): void {
  const globalObject = globalThis as TsLibGlobal;
  globalObject.__js2wasmTsLibFiles = {
    ...(globalObject.__js2wasmTsLibFiles ?? globalObject.__ts2wasmTsLibFiles ?? {}),
    ...files,
  };

  for (const name of Object.keys(files)) {
    Reflect.deleteProperty(LIB_FILES, name);
    for (const key of Array.from(LIB_SOURCE_FILES.keys())) {
      if (key.startsWith(`${name}:`)) {
        LIB_SOURCE_FILES.delete(key);
      }
    }
  }
  Reflect.deleteProperty(LIB_FILES, "lib.d.ts");
  for (const key of Array.from(LIB_SOURCE_FILES.keys())) {
    if (key.startsWith("lib.d.ts:")) {
      LIB_SOURCE_FILES.delete(key);
    }
  }
}

function getPath() {
  return getDefaultEnvironment().path;
}
function dirname(p: string) {
  return getPath()?.dirname(p) ?? "";
}
function join(...args: string[]) {
  return getPath()?.join(...args) ?? args.join("/");
}

function getReadFileSync() {
  return getDefaultEnvironment().fs?.readFileSync ?? null;
}
function getCreateRequire() {
  return getDefaultEnvironment().module?.createRequire ?? null;
}
function getFileURLToPath() {
  return getDefaultEnvironment().url?.fileURLToPath ?? null;
}
// Custom type declarations not found in TS lib files
// All lib types now loaded from the typescript package at runtime.
// No custom lib imports needed — lib: ["es2021", "dom"] in compilerOptions
// handles everything including Generator, Iterator, Map, Set, etc.

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

// ── Lazy lib file resolution ────────────────────────────────────────────────

/** Resolved directory containing TypeScript lib .d.ts files (cached) */
let _tsLibDir: string | undefined;
function getTsLibDir(): string {
  if (_tsLibDir === undefined) {
    try {
      // Use createRequire to resolve the typescript package location
      // This works in both CJS and ESM contexts
      const cr = getCreateRequire();
      const fup = getFileURLToPath();
      if (!cr || !fup) throw new Error("Node.js modules not available");
      const esmRequire = cr(typeof __filename !== "undefined" ? __filename : fup(import.meta.url));
      _tsLibDir = dirname(esmRequire.resolve("typescript/lib/lib.d.ts"));
    } catch {
      try {
        // Fallback: try CJS require
        _tsLibDir = dirname(require.resolve("typescript/lib/lib.d.ts"));
      } catch {
        _tsLibDir = "";
      }
    }
  }
  return _tsLibDir;
}

/**
 * Read a lib .d.ts file from the installed typescript package at runtime.
 * Returns empty string if the file cannot be found (e.g. browser environment).
 */
function readLibFile(name: string): string {
  const bundled = getBundledLibFiles()?.[name];
  if (typeof bundled === "string" && bundled.length > 0) {
    return bundled;
  }
  try {
    const rfs = getReadFileSync();
    if (!rfs) return "";
    return rfs(join(getTsLibDir(), name), "utf-8");
  } catch {
    return "";
  }
}

/** Lazily-populated cache of lib file contents */
const LIB_FILES: Record<string, string> = {};

/** Names of lib files that TS ships and we serve at runtime */
const TS_LIB_NAMES = new Set([
  "lib.es5.d.ts",
  "lib.dom.d.ts",
  "lib.decorators.d.ts",
  "lib.decorators.legacy.d.ts",
  "lib.es2015.d.ts",
  "lib.es2015.core.d.ts",
  "lib.es2015.collection.d.ts",
  "lib.es2015.generator.d.ts",
  "lib.es2015.iterable.d.ts",
  "lib.es2015.promise.d.ts",
  "lib.es2015.proxy.d.ts",
  "lib.es2015.reflect.d.ts",
  "lib.es2015.symbol.d.ts",
  "lib.es2015.symbol.wellknown.d.ts",
  "lib.es2021.d.ts",
  "lib.es2021.promise.d.ts",
  "lib.es2021.string.d.ts",
  "lib.es2021.weakref.d.ts",
]);

/**
 * Get the contents of a lib file by name. Reads from the typescript package
 * on first access, then caches. Custom declarations (generators, es2015,
 * es2021) are always available; standard TS libs are loaded from disk.
 */
function getLibSource(name: string): string | undefined {
  if (name in LIB_FILES) return LIB_FILES[name];

  // Composite lib.d.ts: concatenate all needed lib files directly.
  // We must include the sub-files (e.g. lib.es2015.collection.d.ts) rather than
  // the umbrella files (lib.es2015.d.ts) because umbrella files only contain
  // /// <reference lib="..."> directives which are NOT resolved when the content
  // is concatenated into a single source file.
  if (name === "lib.d.ts") {
    const libNames = [
      // ES5 base
      "lib.es5.d.ts",
      // ES2015 sub-libs (from lib.es2015.d.ts references)
      "lib.es2015.core.d.ts",
      "lib.es2015.collection.d.ts",
      "lib.es2015.generator.d.ts",
      "lib.es2015.iterable.d.ts",
      "lib.es2015.promise.d.ts",
      "lib.es2015.proxy.d.ts",
      "lib.es2015.reflect.d.ts",
      "lib.es2015.symbol.d.ts",
      "lib.es2015.symbol.wellknown.d.ts",
      // ES2016
      "lib.es2016.array.include.d.ts",
      "lib.es2016.intl.d.ts",
      // ES2017
      "lib.es2017.object.d.ts",
      "lib.es2017.string.d.ts",
      "lib.es2017.intl.d.ts",
      "lib.es2017.typedarrays.d.ts",
      "lib.es2017.date.d.ts",
      "lib.es2017.sharedmemory.d.ts",
      // ES2018
      "lib.es2018.asyncgenerator.d.ts",
      "lib.es2018.asynciterable.d.ts",
      "lib.es2018.intl.d.ts",
      "lib.es2018.promise.d.ts",
      "lib.es2018.regexp.d.ts",
      // ES2019
      "lib.es2019.array.d.ts",
      "lib.es2019.intl.d.ts",
      "lib.es2019.object.d.ts",
      "lib.es2019.string.d.ts",
      "lib.es2019.symbol.d.ts",
      // ES2020
      "lib.es2020.bigint.d.ts",
      "lib.es2020.date.d.ts",
      "lib.es2020.intl.d.ts",
      "lib.es2020.number.d.ts",
      "lib.es2020.promise.d.ts",
      "lib.es2020.sharedmemory.d.ts",
      "lib.es2020.string.d.ts",
      "lib.es2020.symbol.wellknown.d.ts",
      // ES2021
      "lib.es2021.intl.d.ts",
      "lib.es2021.promise.d.ts",
      "lib.es2021.string.d.ts",
      "lib.es2021.weakref.d.ts",
      // ES2022
      "lib.es2022.array.d.ts",
      "lib.es2022.error.d.ts",
      "lib.es2022.intl.d.ts",
      "lib.es2022.object.d.ts",
      "lib.es2022.regexp.d.ts",
      "lib.es2022.string.d.ts",
      // ES2023
      "lib.es2023.array.d.ts",
      "lib.es2023.collection.d.ts",
      "lib.es2023.intl.d.ts",
      // ES2024
      "lib.es2024.collection.d.ts",
      // ESNext — Set methods (union, intersection, difference, etc.)
      "lib.esnext.collection.d.ts",
      // ESNext — DisposableStack / AsyncDisposableStack (#1036)
      "lib.esnext.disposable.d.ts",
      // DOM (decorators loaded via /// <reference> in lib.es5.d.ts)
      "lib.dom.d.ts",
    ];
    const parts = libNames.map((n) => getLibSource(n) ?? "");
    const content = parts.join("\n");
    LIB_FILES[name] = content;
    return content;
  }

  // Any lib.*.d.ts file — read from typescript package
  if (name.startsWith("lib.") && name.endsWith(".d.ts")) {
    const content = readLibFile(name);
    if (content) {
      LIB_FILES[name] = content;
      return content;
    }
    return undefined;
  }

  return undefined;
}

/** Check if a file name is a known lib file */
export function isKnownLibName(name: string): boolean {
  return name === "lib.d.ts" || TS_LIB_NAMES.has(name) || (name.startsWith("lib.") && name.endsWith(".d.ts"));
}

/** Pre-parsed lib SourceFiles — cached to avoid re-parsing on every compile */
const LIB_SOURCE_FILES = new Map<string, ts.SourceFile>();
export function getLibSourceFile(
  name: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  const content = getLibSource(name);
  if (content === undefined) return undefined;
  const key = `${name}:${JSON.stringify(languageVersion)}`;
  let sf = LIB_SOURCE_FILES.get(key);
  if (!sf) {
    sf = ts.createSourceFile(name, content, languageVersion);
    LIB_SOURCE_FILES.set(key, sf);
  }
  return sf;
}

export interface AnalyzeOptions {
  /** Allow JavaScript source files (enables allowJs + checkJs in TS compiler) */
  allowJs?: boolean;
  /** Skip semantic diagnostics collection (faster — checker still available for type queries) */
  skipSemanticDiagnostics?: boolean;
  /**
   * Node API emulation (#2603), opt-in via `--emulate node`. Serves a synthetic
   * ambient `process` declaration so the checker resolves the Node globals
   * js2wasm lowers (process.std{in,out,err}, argv, env, exit) without the user
   * installing @types/node — eliminating the repeated TS2580 "Cannot find name
   * 'process'" warnings. Type-level only; does not change emitted wasm (codegen
   * lowers `process.*` syntactically regardless). Falls back to no injection if
   * the user already declares `process`, so it never creates a dup-identifier error.
   */
  emulateNode?: boolean;
}

/**
 * ES spec early error diagnostic codes that should NOT be suppressed
 * even when skipSemanticDiagnostics is true. These correspond to
 * SyntaxError/ReferenceError conditions mandated by the spec.
 */
const ES_EARLY_ERROR_CODES = new Set([
  1100, // 'this' cannot be used as a parameter
  1102, // delete of unqualified identifier in strict mode
  1103, // delete target must be a property reference
  1210, // Invalid use of 'arguments' in class field initializer
  1211, // Class declaration without 'default' must have a name
  1213, // Identifier expected; 'X' is a reserved word in strict mode
  1214, // Identifier expected
  1359, // Identifier expected; 'yield' is a reserved keyword
  1360, // Identifier expected; 'await' is a reserved keyword
  2300, // Duplicate identifier
  2480, // 'import()' expression is not callable with this argument
  18050, // A rest element cannot have an initializer
]);

// #2603 / #2624: Node API emulation surface, injected when `--emulate node`
// (or the `node:`-import auto-detect) is on. Served as a synthetic root .d.ts so
// the checker resolves the emulated Node globals/modules (no TS2580 / TS2307)
// without the user installing @types/node. Type-level only — codegen lowers
// `process.*` and the IO calls syntactically regardless of this file.
//
// #2624 makes the injection **import-scoped, not blanket**: the .d.ts is built
// DYNAMICALLY from the source (see `buildNodeEnvDts`) so it declares ONLY the
// Node surface the program actually touches. A `node:fs`-only program does NOT
// get an ambient `process` global; a bare `process` reference does NOT pull in
// unrelated `node:*` module typings. This keeps the injected surface minimal
// (goal: "type-checks, no TS2580/TS2307", nothing more) and mirrors the
// per-module runtime-shim design (one shim per imported module).
const NODE_ENV_DTS_NAME = "__js2wasm_node_env.d.ts";

// The `process` member surface that node-process-api.ts actually lowers. Shared
// between the bare ambient global (`declare var process`) and a `node:process`
// default/namespace/named import.
const PROCESS_INTERFACE_DECLS = `interface NodeJS_WritableStream {
  write(chunk: Uint8Array | ArrayBuffer | string): boolean;
  once(event: string, listener: (...args: any[]) => void): void;
}
interface NodeJS_ReadableStream {
  read(buffer?: Uint8Array, offset?: number): number;
}
interface NodeJS_Process {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  exit(code?: number): never;
  readonly stdin: NodeJS_ReadableStream;
  readonly stdout: NodeJS_WritableStream;
  readonly stderr: NodeJS_WritableStream;
}`;

interface NodeEmuUsage {
  /** node:<mod> -> set of imported member names ("" sentinel = default/namespace import). */
  modules: Map<string, Set<string>>;
  /** A bare global `process` is referenced (NOT via a `node:process` import). */
  bareProcess: boolean;
}

/**
 * Scan the source for the Node surface it touches: `import … from "node:<mod>"`
 * (named / default / namespace), `require("node:<mod>")`, plus a bare global
 * `process` reference. Cheap — a single `ts.createSourceFile` parse, no
 * type-checking. The result drives the import-scoped .d.ts in `buildNodeEnvDts`.
 */
function scanNodeEmuUsage(source: string, scriptKind: ts.ScriptKind): NodeEmuUsage {
  const modules = new Map<string, Set<string>>();
  let importsNodeProcess = false;

  const sf = ts.createSourceFile("__scan__.ts", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);

  const recordModule = (mod: string, members: Iterable<string>): void => {
    let set = modules.get(mod);
    if (!set) {
      set = new Set<string>();
      modules.set(mod, set);
    }
    for (const m of members) set.add(m);
  };

  // 1. `import … from "node:<mod>"` (named / default / namespace).
  // 2. `import "node:<mod>"` (side-effect; record the module, no members).
  // 3. `require("node:<mod>")` (CommonJS — record the module, members unknown).
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith("node:")) {
        const members: string[] = [];
        const clause = node.importClause;
        if (clause) {
          // default import: `import fs from "node:fs"`
          if (clause.name) members.push("");
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              // `import * as fs from "node:fs"` — namespace; whole module surface.
              members.push("");
            } else {
              // `import { a, b as c } from "node:fs"` — record the LOCAL names.
              for (const el of clause.namedBindings.elements) members.push(el.name.text);
            }
          }
        }
        if (spec === "node:process") importsNodeProcess = true;
        recordModule(spec, members);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith("node:")
    ) {
      const spec = node.arguments[0].text;
      if (spec === "node:process") importsNodeProcess = true;
      recordModule(spec, [""]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // A bare global `process` reference: we approximate "referenced" by a regex on
  // the source, unless the program imports `node:process` (in which case
  // `process` is the import binding, not the global). A precise binding analysis
  // is overkill for a type-level emulation hint, and the dup-identifier fallback
  // covers any user that declares its own `process`.
  const bareProcess = !importsNodeProcess && /\bprocess\b/.test(source);

  return { modules, bareProcess };
}

/**
 * Build the import-scoped Node emulation `.d.ts` for `source`. Declares ONLY the
 * surface the program touches:
 *   - bare global `process` → the `process` interfaces + `declare var process`;
 *   - `import … from "node:process"` → the `process` interfaces + a typed
 *     `node:process` module (export-assignment of the process value);
 *   - other `node:<mod>` imports → a permissive `declare module` declaring just
 *     the imported member names (`export const <name>: any`) + a default, so
 *     they type-check.
 * Returns `undefined` when there's nothing to inject (no Node surface touched),
 * so the caller can skip injection entirely (no empty synthetic root).
 */
function buildNodeEnvDts(usage: NodeEmuUsage): string | undefined {
  const parts: string[] = [];
  let processInterfacesEmitted = false;

  const emitProcessInterfaces = (): void => {
    if (!processInterfacesEmitted) {
      parts.push(PROCESS_INTERFACE_DECLS);
      processInterfacesEmitted = true;
    }
  };

  // Bare ambient global `process`.
  if (usage.bareProcess) {
    emitProcessInterfaces();
    parts.push(`declare var process: NodeJS_Process;`);
  }

  // `node:<mod>` modules, each scoped to its imported members.
  for (const [mod, members] of usage.modules) {
    if (mod === "node:process") {
      emitProcessInterfaces();
      // Default / namespace / named import of the process module. We expose the
      // `NodeJS_Process` value as BOTH a default export and named re-exports of
      // its members, so `import process from "node:process"`, `import * as
      // process`, and `import { stdout } from "node:process"` all resolve under
      // the checker's ESNext module mode (no `esModuleInterop` needed).
      const lines: string[] = [`declare module "node:process" {`, `  const process: NodeJS_Process;`];
      lines.push(`  export default process;`);
      lines.push(`  export const argv: string[];`);
      lines.push(`  export const env: Record<string, string | undefined>;`);
      lines.push(`  export const platform: string;`);
      lines.push(`  export function exit(code?: number): never;`);
      lines.push(`  export const stdin: NodeJS_ReadableStream;`);
      lines.push(`  export const stdout: NodeJS_WritableStream;`);
      lines.push(`  export const stderr: NodeJS_WritableStream;`);
      lines.push(`}`);
      parts.push(lines.join("\n"));
      continue;
    }
    // Other modules: permissive, just enough that the imported names resolve.
    const named = [...members].filter((m) => m !== "");
    const hasDefaultOrNs = members.has("");
    const lines: string[] = [`declare module "${mod}" {`];
    for (const name of named) lines.push(`  export const ${name}: any;`);
    if (hasDefaultOrNs || named.length === 0) {
      // Default/namespace import, or a side-effect/require import: give the whole
      // module an `any` shape so `import fs from "node:fs"` / `import * as fs`
      // resolve without enumerating members.
      lines.push(`  const _default: any;`);
      lines.push(`  export default _default;`);
    }
    lines.push(`}`);
    parts.push(lines.join("\n"));
  }

  if (parts.length === 0) return undefined;
  return parts.join("\n") + "\n";
}

/**
 * #2624 — compose `scanNodeEmuUsage` + `buildNodeEnvDts` for a source. Exported
 * so tests can assert the EXACT import-scoped surface that emulation injects
 * (e.g. that a `node:fs`-only program does not declare the `process` global).
 * Returns `undefined` when the program touches no Node surface.
 */
export function buildNodeEnvDtsForSource(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): string | undefined {
  return buildNodeEnvDts(scanNodeEmuUsage(source, scriptKind));
}

/** Diagnostic codes for a duplicate `process` declaration (user declared it themselves). */
const DUP_IDENTIFIER_CODES = new Set([
  2300, // Duplicate identifier 'X'
  2403, // Subsequent variable declarations must have the same type
  2451, // Cannot redeclare block-scoped variable 'X'
]);

function diagnosticMentionsProcess(d: ts.Diagnostic): boolean {
  const text = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
  return text.includes("'process'");
}

/**
 * Parse and type-check a TS or JS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(source: string, fileName = "input.ts", analyzeOptions?: AnalyzeOptions): TypedAST {
  const ext = fileName.match(/\.(tsx|jsx|ts|js|mjs|cjs)$/)?.[1] ?? "ts";
  const isJsx = ext === "tsx" || ext === "jsx";
  const isJs = ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs";
  const scriptKind =
    ext === "tsx" ? ts.ScriptKind.TSX : ext === "jsx" ? ts.ScriptKind.JSX : isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const useAllowJs = isJs || analyzeOptions?.allowJs === true;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: !isJs,
    noImplicitAny: false,
    noEmit: true,
    // Enable JSX parsing for .tsx/.jsx files. ReactJSX desugars JSX to
    // _jsx(tag, props) calls before codegen sees the AST — existing
    // call-expression codegen handles them as extern calls. See #1531.
    ...(isJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  };

  // #2624: when emulation is on, build the injected Node `.d.ts` DYNAMICALLY from
  // the source so it declares only the Node surface the program touches (see
  // `buildNodeEnvDts`). If the program touches no Node surface, there is nothing
  // to inject and `injectNodeEnv` stays false (no empty synthetic root).
  const nodeEnvDtsSource =
    analyzeOptions?.emulateNode === true ? buildNodeEnvDtsForSource(source, scriptKind) : undefined;
  const injectNodeEnv = nodeEnvDtsSource !== undefined;

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true, scriptKind);
      }
      if (injectNodeEnv && name === NODE_ENV_DTS_NAME) {
        return ts.createSourceFile(name, nodeEnvDtsSource, languageVersion, true, ts.ScriptKind.TS);
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName || (injectNodeEnv && name === NODE_ENV_DTS_NAME) || isKnownLibName(name),
    readFile: () => undefined,
    getDirectories: () => [],
    directoryExists: () => true,
  };

  if (useAllowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  // Build the program. When Node emulation is on (#2603/#2624) add the
  // import-scoped synthetic Node `.d.ts` as an extra root so the checker resolves
  // the emulated Node globals/modules. If the user already declares `process`,
  // that injection collides — detect the duplicate-identifier diagnostic and
  // rebuild without it, so we never turn a benign warning into a hard error.
  function buildProgram(withNodeEnv: boolean) {
    const rootNames = withNodeEnv ? [fileName, NODE_ENV_DTS_NAME] : [fileName];
    const prog = ts.createProgram(rootNames, compilerOptions, compilerHost);
    const syn = prog.getSyntacticDiagnostics();
    const sem = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as readonly ts.Diagnostic[])
      : prog.getSemanticDiagnostics();
    return { prog, syn, sem };
  }

  let { prog: program, syn: syntacticDiagnostics, sem: semanticDiagnostics } = buildProgram(injectNodeEnv);

  if (
    injectNodeEnv &&
    semanticDiagnostics.some((d) => DUP_IDENTIFIER_CODES.has(d.code) && diagnosticMentionsProcess(d))
  ) {
    ({ prog: program, syn: syntacticDiagnostics, sem: semanticDiagnostics } = buildProgram(false));
  }

  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/** Result of multi-file analysis */
export interface MultiTypedAST {
  /** All user source files (in dependency order, entry file last) */
  sourceFiles: ts.SourceFile[];
  /** The entry source file */
  entryFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

/** Script-file extensions we recognize in the multi-source pipeline. */
const KNOWN_SCRIPT_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

function stripKnownExt(name: string): string {
  for (const ext of KNOWN_SCRIPT_EXTS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

function hasKnownExt(name: string): boolean {
  return KNOWN_SCRIPT_EXTS.some((ext) => name.endsWith(ext));
}

function scriptKindFor(name: string): ts.ScriptKind {
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (name.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function tsExtensionFor(name: string): ts.Extension {
  if (name.endsWith(".tsx")) return ts.Extension.Tsx;
  if (name.endsWith(".jsx")) return ts.Extension.Jsx;
  if (name.endsWith(".js")) return ts.Extension.Js;
  if (name.endsWith(".mjs")) return ts.Extension.Mjs;
  if (name.endsWith(".cjs")) return ts.Extension.Cjs;
  return ts.Extension.Ts;
}

/**
 * Normalize a file path to a canonical form used as key in our in-memory file map.
 * Strips leading "./", resolves ".." segments, preserves any known script extension,
 * and defaults to ".ts" when no extension is present.
 */
function normalizeFileName(name: string): string {
  let normalized = name.startsWith("./") ? name.slice(2) : name;
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  // Resolve ".." path segments (e.g., "link/../emit/foo" → "emit/foo")
  const parts = normalized.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  normalized = resolved.join("/");
  // Preserve explicit script extensions (.js/.mjs/.cjs/.jsx/.tsx/.ts); otherwise default to .ts
  if (!hasKnownExt(normalized)) {
    normalized = `${normalized}.ts`;
  }
  return normalized;
}

/**
 * Locate a file in the normalizedFiles map, probing for alternate extensions.
 * Accepts e.g. "a" (user wrote `import "./a"`) and finds "a.js" / "a.ts" / "a/index.js".
 */
function probeFileKey(resolved: string, files: Map<string, string>): string | undefined {
  if (files.has(resolved)) return resolved;
  // Swap the trailing extension (e.g. normalized "a.ts" but file is "a.js")
  if (hasKnownExt(resolved)) {
    const stem = stripKnownExt(resolved);
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const cand = stem + ext;
      if (cand !== resolved && files.has(cand)) return cand;
    }
    // Also try <stem>/index.<ext>
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const cand = `${stem}/index${ext}`;
      if (files.has(cand)) return cand;
    }
  } else {
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const cand = resolved + ext;
      if (files.has(cand)) return cand;
    }
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const cand = `${resolved}/index${ext}`;
      if (files.has(cand)) return cand;
    }
  }
  return undefined;
}

/**
 * Parse and type-check multiple TS source files.
 * In-memory CompilerHost — no filesystem needed.
 * The TypeScript compiler handles cross-file imports natively.
 */
export function analyzeMultiSource(
  files: Record<string, string>,
  entryFile: string,
  /** Optional mapping from bare specifiers to file keys (e.g. { "lodash": "lodash/index.ts" }) */
  specifierMap?: Record<string, string>,
  /** Compiler options (allowJs, skipSemanticDiagnostics, ...) */
  analyzeOptions?: AnalyzeOptions,
): MultiTypedAST {
  const normalizedFiles = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    normalizedFiles.set(normalizeFileName(name), content);
  }
  const normalizedEntry = normalizeFileName(entryFile);
  const rootNames = Array.from(normalizedFiles.keys());

  // Build a bare-specifier-to-normalized-file lookup.
  // Explicit specifierMap entries take priority, then we auto-derive
  // mappings from file keys (e.g. "utils.ts" -> bare specifier "utils").
  const bareSpecifierLookup = new Map<string, string>();
  for (const normalized of normalizedFiles.keys()) {
    // "foo/bar.ts" -> bare specifiers "foo/bar" and "bar"
    const withoutExt = stripKnownExt(normalized);
    bareSpecifierLookup.set(withoutExt, normalized);
    // Also register the exact extension form so `import "foo/bar.js"` works.
    if (!bareSpecifierLookup.has(normalized)) {
      bareSpecifierLookup.set(normalized, normalized);
    }
    const basename = withoutExt.split("/").pop()!;
    if (basename && !bareSpecifierLookup.has(basename)) {
      bareSpecifierLookup.set(basename, normalized);
    }
    // Also support "foo/index.ts" -> bare specifier "foo"
    if (basename === "index") {
      const dir = withoutExt.replace(/\/index$/, "");
      if (dir && !bareSpecifierLookup.has(dir)) {
        bareSpecifierLookup.set(dir, normalized);
      }
    }
  }
  // Explicit specifierMap overrides auto-derived entries
  if (specifierMap) {
    for (const [specifier, fileKey] of Object.entries(specifierMap)) {
      bareSpecifierLookup.set(specifier, normalizeFileName(fileKey));
    }
  }

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      const userContent = normalizedFiles.get(name);
      if (userContent !== undefined) {
        return ts.createSourceFile(name, userContent, languageVersion, true, scriptKindFor(name));
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => normalizedFiles.has(name) || isKnownLibName(name),
    readFile: (name) => normalizedFiles.get(name),
    getDirectories: () => [],
    directoryExists: () => true,
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((literal) => {
        const moduleName = literal.text;
        // Resolve relative paths against the containing file's directory
        let resolved: string;
        if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
          const containingDir = containingFile.replace(/[^/]*$/, "");
          resolved = normalizeFileName(containingDir + moduleName);
        } else {
          // Bare specifier: check the lookup map first, then fall back to normalizeFileName
          resolved = bareSpecifierLookup.get(moduleName) ?? normalizeFileName(moduleName);
        }
        const key = probeFileKey(resolved, normalizedFiles) ?? resolved;
        if (normalizedFiles.has(key)) {
          return {
            resolvedModule: {
              resolvedFileName: key,
              isExternalLibraryImport: false,
              extension: tsExtensionFor(key),
            },
          };
        }
        return { resolvedModule: undefined };
      });
    },
  };

  const hasJsxFile = rootNames.some((n) => n.endsWith(".tsx") || n.endsWith(".jsx"));
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    // Enable JSX parsing when any input file is .tsx/.jsx (#1531).
    ...(hasJsxFile ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  };
  if (analyzeOptions?.allowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram(rootNames, compilerOptions, compilerHost);

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
    ? ([] as ts.Diagnostic[])
    : program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  const entrySourceFile = program.getSourceFile(normalizedEntry)!;

  // Order source files topologically: dependencies before importers, entry last.
  // ES module evaluation runs each module's body after its imports' bodies, and
  // we concatenate top-level statements into a single `__module_init` — so
  // dependency files must appear earlier in `sourceFiles` than their importers
  // (#1109). Cycles are tolerated by dropping back-edges (first-seen wins).
  const userSourceFiles: ts.SourceFile[] = [];
  {
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name) || onStack.has(name)) return;
      const sf = program.getSourceFile(name);
      if (!sf) return;
      onStack.add(name);
      for (const stmt of sf.statements) {
        const spec =
          (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
          stmt.moduleSpecifier &&
          ts.isStringLiteral(stmt.moduleSpecifier)
            ? stmt.moduleSpecifier.text
            : undefined;
        if (!spec) continue;
        // Re-use the same resolver the program used so cycles are treated identically.
        const resolved = ts.resolveModuleName(spec, name, compilerOptions, compilerHost).resolvedModule
          ?.resolvedFileName;
        if (resolved && resolved !== name) visit(resolved);
      }
      visited.add(name);
      onStack.delete(name);
      if (sf !== entrySourceFile) userSourceFiles.push(sf);
    };
    // Entry-anchored DFS; only files reachable from entry are emitted.
    visit(normalizedEntry);
    userSourceFiles.push(entrySourceFile);
    // Append any additional user files that weren't reached via the entry's import graph
    // (the previous behaviour was to emit every rootName, so we keep that for safety).
    for (const name of rootNames) {
      if (visited.has(name) || name === normalizedEntry) continue;
      const sf = program.getSourceFile(name);
      if (sf && sf !== entrySourceFile && !userSourceFiles.includes(sf)) {
        userSourceFiles.splice(userSourceFiles.length - 1, 0, sf);
      }
    }
  }

  return {
    sourceFiles: userSourceFiles,
    entryFile: entrySourceFile,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/**
 * Analyze a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via its standard module resolution.
 *
 * Returns a MultiTypedAST suitable for generateMultiModule().
 */
export function analyzeFiles(entryPath: string, analyzeOptions?: AnalyzeOptions): MultiTypedAST {
  const pathMod = require("node:path") as typeof import("node:path");
  const resolvedEntry = pathMod.resolve(entryPath);

  const entryIsJsx = resolvedEntry.endsWith(".tsx") || resolvedEntry.endsWith(".jsx");
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    rootDir: pathMod.dirname(resolvedEntry),
    // Enable JSX parsing when the entry file is .tsx/.jsx (#1531).
    ...(entryIsJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  };

  if (analyzeOptions?.allowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram([resolvedEntry], compilerOptions);
  const checker = program.getTypeChecker();

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
    ? ([] as ts.Diagnostic[])
    : program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  const entrySourceFile = program.getSourceFile(resolvedEntry);
  if (!entrySourceFile) {
    throw new Error(`Entry file not found: ${resolvedEntry}`);
  }

  // Collect user source files (skip lib files and node_modules)
  const userSourceFiles: ts.SourceFile[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName === resolvedEntry) continue; // entry goes last
    if (sf.isDeclarationFile) continue;
    if (sf.fileName.includes("node_modules")) continue;
    userSourceFiles.push(sf);
  }
  // Entry file goes last (dependency order: deps before entry)
  userSourceFiles.push(entrySourceFile);

  return {
    sourceFiles: userSourceFiles,
    entryFile: entrySourceFile,
    checker,
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

export { IncrementalLanguageService } from "./language-service.js";
