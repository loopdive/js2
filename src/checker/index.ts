// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import {
  buildBareSpecifierLookup,
  buildProjectModuleResolutionLookup,
  multiFileScriptKind,
  normalizeMultiFileName,
  resolveMultiFileModule,
  type ProjectModuleResolutions,
} from "./multi-file-paths.js";
import { getDefaultEnvironment } from "../env.js";
import { DTS_ENTRY_DECLS_NAME } from "./dts-entrypoint-seeds.js";
import { buildModuleDecls } from "./node-capability-map.js";
import { traceTs5Checker } from "./ts5-trace.js";
import { nodeBuiltinClassStub } from "../import-resolver.js";

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

/**
 * Pre-seed the TypeScript lib files (e.g. `lib.d.ts`) the checker uses, so
 * environments without filesystem access can still type-check. Merges into any
 * previously registered lib files.
 */
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
  // #2528 — both composites (DOM and DOM-free) are derived from the bundled
  // sub-libs, so invalidate both when preloading replaces any sub-lib.
  for (const composite of ["lib.d.ts", "lib.no-dom.d.ts"]) {
    Reflect.deleteProperty(LIB_FILES, composite);
    for (const key of Array.from(LIB_SOURCE_FILES.keys())) {
      if (key.startsWith(`${composite}:`)) {
        LIB_SOURCE_FILES.delete(key);
      }
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
/**
 * #2528 — the default-lib composite file names. The DOM-bearing composite keeps
 * the historical `lib.d.ts` name (so `--platform web` and the unset default are
 * byte-identical to today); the DOM-free composite gets a distinct name so a
 * single process can compile both web and node programs without the global
 * `LIB_FILES` / `LIB_SOURCE_FILES` caches cross-contaminating.
 */
const DOM_LIB_NAME = "lib.d.ts";
const DOM_FREE_LIB_NAME = "lib.no-dom.d.ts";

/**
 * The ES base sub-libs shared by BOTH the web (DOM) and node (DOM-free)
 * composites. We list the sub-files (e.g. lib.es2015.collection.d.ts) rather
 * than the umbrella files (lib.es2015.d.ts) because umbrella files only contain
 * /// <reference lib="..."> directives which are NOT resolved when the content
 * is concatenated into a single source file.
 */
const ES_BASE_LIB_NAMES = [
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
  // ArrayBuffer resize/transfer + maxByteLength/resizable/detached. Keeping the
  // checker aware of these built-ins is semantic, not merely diagnostic: the
  // return type of `buffer.transfer()` must remain ArrayBuffer so downstream
  // native buffer getters and TypedArray-on-buffer construction stay on their
  // canonical typed paths instead of widening to the generic `any` MOP.
  "lib.es2024.arraybuffer.d.ts",
  "lib.es2024.collection.d.ts",
  // ES2024 String.prototype.isWellFormed / toWellFormed (#3068) — required so
  // the checker types these methods' results as boolean/string (else `X === y`
  // on an `any` result silently picks reference equality).
  "lib.es2024.string.d.ts",
  // ESNext — Set methods (union, intersection, difference, etc.)
  "lib.esnext.collection.d.ts",
  // ESNext — DisposableStack / AsyncDisposableStack (#1036)
  "lib.esnext.disposable.d.ts",
];

function getLibSource(name: string): string | undefined {
  if (name in LIB_FILES) return LIB_FILES[name];

  // Composite lib.d.ts: concatenate all needed lib files directly.
  //
  // #2528 — there are TWO composites that share the ES base sub-libs and differ
  // only in whether `lib.dom.d.ts` is appended:
  //   - `lib.d.ts` (DOM_LIB_NAME)   → ES base + DOM (the historical default;
  //                                   web/browser ambient surface — `window`,
  //                                   `document`, … in scope).
  //   - `lib.no-dom.d.ts`           → ES base, NO DOM (the `--platform node`
  //     (DOM_FREE_LIB_NAME)           ambient surface — DOM-only globals are NOT
  //                                   in scope, so `window.stop` in a node host
  //                                   is a clear type error).
  // The two are distinct cache keys / default-lib names so a single process can
  // compile both web and node programs without cross-contamination.
  if (name === DOM_LIB_NAME || name === DOM_FREE_LIB_NAME) {
    const withDom = name === DOM_LIB_NAME;
    const libNames = [
      ...ES_BASE_LIB_NAMES,
      // DOM (decorators loaded via /// <reference> in lib.es5.d.ts).
      // Dropped for the DOM-free (node) composite.
      ...(withDom ? ["lib.dom.d.ts"] : []),
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
  return (
    name === DOM_LIB_NAME ||
    name === DOM_FREE_LIB_NAME ||
    TS_LIB_NAMES.has(name) ||
    (name.startsWith("lib.") && name.endsWith(".d.ts"))
  );
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
  /**
   * Host environment scoping the AMBIENT global surface (#2528/#2645), unified
   * under `--target {web,node,deno}` (#2736; `--platform` is a deprecated
   * alias). Orthogonal to the backend `target` (`gc`/`wasi`/…): this selects
   * which globals are in scope at type-check time.
   *
   *   - `"web"`         → the DOM ambient surface (`window`, `document`, DOM
   *                       types). Byte-identical to the historical default.
   *   - `"node"`/`"deno"` → the DOM-free ambient surface (DOM-only globals are
   *                       NOT in scope, so `window.stop` is a clear type error)
   *                       AND implies the Node-emulation injection path
   *                       (`emulateNode`), so `process` & friends type-check
   *                       without @types/node. (Real `@types/node`/Deno-lib
   *                       loading is a later #2698 slice; `deno` currently routes
   *                       through the same node-emulation/no-DOM surface.)
   *
   * `undefined` (unset) preserves today's behaviour exactly: the DOM composite
   * is loaded and `emulateNode` is driven solely by its own option. This keeps
   * the common (web/test262) path byte-neutral. See `buildNodeEnvDtsForSource`
   * + the `emulateNode ||= platform ∈ {node,deno}` composition in #2645/#2736.
   */
  platform?: "web" | "node" | "deno";
  /**
   * (#743) Source text of the entry's sibling `.d.ts` declaration file, added
   * to the Program as an extra root under the synthetic name
   * `DTS_ENTRY_DECLS_NAME` so exported-entrypoint parameter seeds can be
   * collected from checker-owned declarations. The extra root contributes NO
   * user-visible diagnostics (its own diagnostics are filtered — a shipped
   * declaration file must never block compiling the package). Only supplied
   * when `JS2WASM_DTS_ENTRYPOINT_SEEDS` (ON by default since 2026-08-08) has
   * resolved a declaration source;
   * absent → byte-identical behavior.
   */
  entryDeclarationsText?: string;
  /**
   * Force TypeScript GRAMMAR for the parse even when the input file is named
   * `.js`/`.mjs`/`.cjs` (#2752). When the compiler prepends an injected source
   * prelude that is written in TypeScript — currently the `process.stdin`
   * Readable prelude (`src/process-stdin-prelude.ts`), which carries the
   * nullable/union types codegen relies on (`read(size?): string | null`) — the
   * combined unit must be parsed under the TS grammar, or the loose-JS grammar
   * checker hard-rejects the prelude's TS syntax with TS8009/8010/8017 ("X can
   * only be used in TypeScript files") and compilation fails before codegen.
   * This flag flips ONLY the `ScriptKind` (TS vs JS) for the parse; the
   * `isJs`-derived semantics (`strict: false`, `allowJs`+`checkJs`) stay
   * derived from the filename, so the user's `.js` code keeps its lenient
   * checking while the prelude's TS syntax is accepted and its types stay
   * load-bearing. Scoped to the prelude-injection path only — byte-neutral for
   * every program that does not trigger a TS prelude injection.
   */
  forceTsGrammar?: boolean;
  /**
   * #4452 — tsconfig discovery for the on-disk `analyzeFiles` path.
   *
   *   - `undefined` (default) — find the nearest `tsconfig.json` walking up
   *     from the entry file and use its `compilerOptions` as the BASE. If no
   *     config is reachable, the legacy hardcoded option set is used.
   *   - `string` — path to a specific config file to use instead of searching.
   *     A path that cannot be read is a hard error (the caller asked for it
   *     explicitly, so silently ignoring it would hide a config mistake).
   *   - `false` — force the legacy hardcoded options even when a config IS
   *     reachable (escape hatch / A-B comparison).
   *
   * Only consumed by `analyzeFiles`; the in-memory paths have no project on
   * disk to read.
   */
  tsconfig?: string | false;
}

/**
 * #2645/#2736 — resolve the EFFECTIVE node-emulation decision from the two
 * composing inputs: the explicit `emulateNode` option (#2603) and the host axis
 * (`--target node`/`deno`, formerly `--platform`). A node/deno host implies the
 * node-emulation injection path so the ambient global surface and the importable
 * `node:<mod>` capability gate agree on one target model. The per-member
 * `providersFor` gate stays the authority for importable members; this only sets
 * the ambient default.
 */
function resolveEmulateNode(analyzeOptions?: AnalyzeOptions): boolean {
  return (
    analyzeOptions?.emulateNode === true || analyzeOptions?.platform === "node" || analyzeOptions?.platform === "deno"
  );
}

/**
 * #2528/#2736 — select the default-lib composite name for the chosen host. Unset
 * host → the historical DOM composite (byte-neutral). `--target node`/`deno`
 * drops the DOM ambient surface; `--target web` keeps it explicitly.
 */
function defaultLibNameForPlatform(analyzeOptions?: AnalyzeOptions): string {
  return analyzeOptions?.platform === "node" || analyzeOptions?.platform === "deno" ? DOM_FREE_LIB_NAME : DOM_LIB_NAME;
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

// The `process` member surface that node-fs-api.ts actually lowers. Shared
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

// #1044 / #1793 — the global `Buffer` ambient surface. `Buffer` is a Node
// GLOBAL (not just an export of `require("buffer")`); #1793 registered it in
// BUILTIN_CLASS_NAMES so `Buffer.from` / `alloc` / `concat` and the prototype
// methods lower syntactically in codegen regardless of typing. But WITHOUT an
// ambient declaration the checker emits a spurious "Cannot find name 'Buffer'"
// (TS2304/TS2580) for the common global form under `--emulate node`. This
// injection (gated behind `--emulate node`, like `process`/`Deno` — so the
// common web/test262 path stays byte-neutral) silences that diagnostic and
// lets `Buffer.*` type-check as a Uint8Array subtype. Covers the #1793 Tier 0
// surface (utf-8 + byte-array); the full encoding matrix is a follow-up.
const BUFFER_INTERFACE_DECLS = `interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  write(str: string, encoding?: string): number;
  equals(other: Uint8Array): boolean;
  readUInt8(offset?: number): number;
  readUInt16LE(offset?: number): number;
  readUInt16BE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
}
interface BufferConstructor {
  from(str: string, encoding?: string): Buffer;
  from(data: ArrayLike<number> | ArrayBufferLike): Buffer;
  from(data: Uint8Array): Buffer;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  alloc(size: number, fill?: string | number, encoding?: string): Buffer;
  allocUnsafe(size: number): Buffer;
  isBuffer(obj: unknown): boolean;
  byteLength(str: string, encoding?: string): number;
}`;

interface NodeEmuUsage {
  /** node:<mod> -> set of imported member names ("" sentinel = default/namespace import). */
  modules: Map<string, Set<string>>;
  /** A bare global `process` is referenced (NOT via a `node:process` import). */
  bareProcess: boolean;
  /** A bare global `Buffer` is referenced (NOT bound by an import). */
  bareBuffer: boolean;
  /** Node's legacy `global` alias is referenced. */
  bareGlobal: boolean;
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
  // #1044 — a local `Buffer` binding from ANY import (`import { Buffer } from
  // "node:buffer"`, a default/namespace named `Buffer`, etc.) means `Buffer`
  // is the import symbol, not the ambient global — suppress the global inject.
  let bindsBufferLocal = false;

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
      // #1044 — record a local `Buffer` binding from ANY module (node: or bare).
      const importClause = node.importClause;
      if (importClause) {
        if (importClause.name?.text === "Buffer") bindsBufferLocal = true;
        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            if (importClause.namedBindings.name.text === "Buffer") bindsBufferLocal = true;
          } else {
            for (const el of importClause.namedBindings.elements) {
              if (el.name.text === "Buffer") bindsBufferLocal = true;
            }
          }
        }
      }
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

  // #1044 — a bare global `Buffer` reference (NOT bound by an import). `Buffer`
  // is lowered syntactically in codegen (#1793) regardless of typing; the
  // ambient declaration only silences the "Cannot find name 'Buffer'"
  // diagnostic. Same regex-approximation + dup-identifier fallback as `process`.
  const bareBuffer = !bindsBufferLocal && /\bBuffer\b/.test(source);

  // #3995 — Node exposes `global` as a legacy alias of `globalThis`. Keep the
  // ambient declaration import-scoped like process/Buffer so unrelated source
  // does not gain another synthetic root.
  const bareGlobal = /\bglobal\b/.test(source);

  return { modules, bareProcess, bareBuffer, bareGlobal };
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

  // #1044 — bare ambient global `Buffer` (Node global, lowered syntactically by
  // #1793). Silences the "Cannot find name 'Buffer'" diagnostic and types
  // `Buffer.*` as a Uint8Array subtype under `--emulate node`.
  if (usage.bareBuffer) {
    parts.push(BUFFER_INTERFACE_DECLS);
    parts.push(`declare var Buffer: BufferConstructor;`);
  }

  if (usage.bareGlobal) {
    parts.push(`declare var global: typeof globalThis;`);
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
    // #1794/#4534 — Keep known Node class exports as real ambient classes in
    // the synthetic graph declaration. The single-source preprocessor has
    // always injected this shape; multi-file projects used to receive only an
    // `export const X: any`, so a class such as jsdom's
    // `VirtualConsole extends EventEmitter` lost its host heritage and its
    // inherited methods. The namespace declaration is collected by codegen;
    // the module re-export preserves the importer's checker type.
    const builtinModuleName = mod.startsWith("node:") ? mod.slice(5) : mod;
    const classNames = [...members].filter((name) => nodeBuiltinClassStub(builtinModuleName, name) !== null);
    if (classNames.length > 0) {
      const emittedStubs = new Set<string>();
      for (const className of classNames) {
        const stub = nodeBuiltinClassStub(builtinModuleName, className);
        if (stub && !emittedStubs.has(stub)) {
          parts.push(stub);
          emittedStubs.add(stub);
        }
      }
      const lines: string[] = [`declare module "${mod}" {`];
      for (const className of classNames) {
        lines.push(`  export const ${className}: typeof ${builtinModuleName}.${className};`);
      }
      lines.push(`}`);
      parts.push(lines.join("\n"));
      continue;
    }

    // #2634 — `node:fs` (and any other capability-mapped `node:<mod>`): drive
    // the importable surface + types from the capability map
    // (`node-capability-map.ts`), which mirrors the REAL `@types/node`
    // signatures — every overload, the precise `NodeJS.ArrayBufferView` buffer
    // type — instead of the old collapsed/approximate hand-roll. Faithful
    // OVERLOADS are bodiless `export function` declarations; those are illegal
    // in a `.ts`/`.js` (non-declaration) file (TS8017) but LEGAL here because
    // this synthetic surface is a `.d.ts`-typed source (NODE_ENV_DTS_NAME ends
    // in `.d.ts`, so `isDeclarationFile` is true). The user's import site only
    // *references* the names, so TS8017 never fires there (#2631 / #1768
    // transpiled-host case stays green — verified by the allowJs `.js` host
    // test). Any imported member outside the map stays permissive `any`.
    const capLines = buildModuleDecls(mod, members);
    if (capLines) {
      const named = [...members].filter((m) => m !== "");
      const hasDefaultOrNs = members.has("");
      const lines: string[] = [`declare module "${mod}" {`, ...capLines];
      if (hasDefaultOrNs || named.length === 0) {
        lines.push(`  const _default: any;`);
        lines.push(`  export default _default;`);
      }
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

function diagnosticMentionsInjectedGlobal(d: ts.Diagnostic): boolean {
  const text = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
  // A dup-identifier on any injected ambient global (`process`, `Deno`, or
  // `Buffer`) means the user declared it themselves — rebuild without the
  // injection.
  return text.includes("'process'") || text.includes("'Deno'") || text.includes("'Buffer'");
}

// #2684 — ambient `Deno` namespace typing, injected import-scoped when the
// source references `Deno`. Declares ONLY the synchronous stdio surface js2wasm
// lowers (`Deno.stdin.readSync` / `Deno.{stdout,stderr}.writeSync`), mirroring the
// bare-`process` injection in buildNodeEnvDts. Type-level only — codegen lowers
// the member-call shape syntactically regardless (deno-api.ts). Faithful Deno
// signatures: `readSync` returns `number | null` (null at EOF); `writeSync`
// returns `number` (bytes written). Injected independently of `--emulate node`
// (Deno is its own runtime; a Deno program should not need the Node flag).
const DENO_STDIO_DECLS = `interface Deno_ReaderSync {
  readSync(p: Uint8Array): number | null;
}
interface Deno_WriterSync {
  writeSync(p: Uint8Array): number;
}
declare namespace Deno {
  const stdin: Deno_ReaderSync;
  const stdout: Deno_WriterSync;
  const stderr: Deno_WriterSync;
}
`;

/**
 * #2684 — build the import-scoped ambient `Deno` `.d.ts` for `source`, or
 * `undefined` when the program does not reference `Deno`. The reference is
 * approximated by a word-boundary regex, exactly like the bare-`process`
 * detection in `scanNodeEmuUsage`; a user that declares its own `Deno` triggers
 * the dup-identifier rebuild-without-injection fallback.
 */
export function buildDenoEnvDtsForSource(source: string): string | undefined {
  return /\bDeno\b/.test(source) ? DENO_STDIO_DECLS : undefined;
}

/** The `Deno` stdio streams js2wasm natively lowers (deno-api.ts). */
const DENO_STDIO_STREAMS = new Set(["stdin", "stdout", "stderr"]);

/** Innermost AST node whose span contains `pos` (used to inspect a diagnostic site). */
function findNodeAtPosition(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  function recurse(node: ts.Node): ts.Node | undefined {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return undefined;
    return ts.forEachChild(node, recurse) ?? node;
  }
  return recurse(sf);
}

/**
 * #2815 — js2wasm natively recognizes the ambient `Deno.{stdin,stdout,stderr}`
 * synchronous-stdio surface and lowers it to WASI fd IO (src/codegen/deno-api.ts),
 * so the checker's TS2304 "Cannot find name 'Deno'" on that recognized shape is
 * pure noise — the same class as the `process` TS2580 that loopdive/js2wasm#389 asked
 * about (downgraded in #1951/#2603) and the ambient `Deno` d.ts the single-source
 * path injects (#2684). The multi-file paths (analyzeMultiSource / analyzeFiles)
 * don't inject that d.ts, so the warning still leaks for a real Deno program that
 * imports a shared core (the reporter's exact case).
 *
 * Returns true ONLY when the flagged `Deno` identifier is the root object of a
 * recognized `Deno.{stdin,stdout,stderr}` property access — so a genuinely-unknown
 * reference (a bare `Deno`, or `Deno.notAThing`) still surfaces its TS2304. This
 * is the scoped suppression #2815 asks for, NOT a blanket identifier silence.
 */
function isRecognizedDenoStdioNotFound(diag: ts.Diagnostic): boolean {
  if (diag.code !== 2304) return false;
  const text = typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText;
  if (!text.includes("'Deno'")) return false;
  const sf = diag.file;
  if (!sf || diag.start === undefined) return false;
  const node = findNodeAtPosition(sf, diag.start);
  if (!node || !ts.isIdentifier(node) || node.text !== "Deno") return false;
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    DENO_STDIO_STREAMS.has(parent.name.text)
  );
}

/**
 * #2815 — drop the benign TS2304 "Cannot find name 'Deno'" diagnostics that flag
 * the natively-lowered `Deno.{stdin,stdout,stderr}` stdio surface. Used by the
 * multi-file analyze paths, which (unlike the single-source path, #2684) do not
 * inject the ambient `Deno` d.ts. Path-agnostic and precisely scoped via
 * `isRecognizedDenoStdioNotFound`; leaves every other diagnostic untouched.
 */
export function filterRecognizedDenoStdioDiagnostics(diagnostics: ts.Diagnostic[]): ts.Diagnostic[] {
  if (!diagnostics.some(isRecognizedDenoStdioNotFound)) return diagnostics;
  return diagnostics.filter((d) => !isRecognizedDenoStdioNotFound(d));
}

/**
 * Parse and type-check a TS or JS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(source: string, fileName = "input.ts", analyzeOptions?: AnalyzeOptions): TypedAST {
  const ext = fileName.match(/\.(tsx|jsx|ts|js|mjs|cjs)$/)?.[1] ?? "ts";
  const isJsx = ext === "tsx" || ext === "jsx";
  const isJs = ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs";
  // #2752 — when a TS source prelude was injected ahead of a `.js`-named user
  // file, force the TS grammar for the parse so the prelude's TS syntax
  // (type annotations, `private`, signature declarations) is not rejected with
  // TS8009/8010/8017. This overrides ONLY the ScriptKind; `isJs` (and thus the
  // `strict: false` + `allowJs`/`checkJs` semantics below) stay derived from
  // the filename, so the user's `.js` code keeps its lenient checking.
  const scriptKind = analyzeOptions?.forceTsGrammar
    ? ts.ScriptKind.TS
    : ext === "tsx"
      ? ts.ScriptKind.TSX
      : ext === "jsx"
        ? ts.ScriptKind.JSX
        : isJs
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const useAllowJs = isJs || analyzeOptions?.allowJs === true;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // #2750 S1 — single-file `.js` now gets the FULL sound `strict` umbrella,
    // matching both multi-file blocks (`analyzeMultipleFiles`/`analyzeFiles` at
    // :1011/:1103, which set `strict: true` unconditionally). Previously
    // `strict: !isJs` gave a single-file `.js` ONLY the pinned `strictNullChecks`
    // (#2748 C), leaving `strictFunctionTypes`/`strictPropertyInitialization`/
    // `useUnknownInCatchVariables`/… OFF — a latent single-file-vs-multi-file
    // inconsistency. Sound flags keep type-directed codegen accurate.
    strict: true,
    // `strictNullChecks` is already implied by `strict: true`; kept explicit as
    // the soundness-critical guard the #2748 C fix established (a `T|null`
    // collapse changes the Wasm value-representation and folds null/undefined
    // guards — the #2748 infinite-loop miscompile).
    strictNullChecks: true,
    // BOUNDARY (#2750 Prong 1): `noImplicitAny` stays OFF for `.js` — rejecting
    // untyped JS is NOT the goal; the dynamic/`any`/externref path handles it.
    // This override MUST come after `strict: true` (which would enable it).
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
  // #2645 — `--platform node` implies emulation, so the ambient surface and the
  // capability gate share one target model (see `resolveEmulateNode`).
  // A concrete `node:` import is itself sufficient evidence that the source
  // needs the import-scoped Node declarations. This mirrors the single-file
  // preprocessor's auto-detection and is especially important for multi-file
  // CJS graphs, whose rewritten imports otherwise reach codegen without the
  // typed extern-class stubs.
  const emulateNode = resolveEmulateNode(analyzeOptions) || /\bnode:[A-Za-z0-9_./-]+\b/.test(source);
  const nodeEnvDtsSource = emulateNode ? buildNodeEnvDtsForSource(source, scriptKind) : undefined;
  // #2684 — the ambient `Deno` typing is injected independently of `--emulate
  // node` (Deno is its own runtime). Both synthetic surfaces share the single
  // NODE_ENV_DTS_NAME root; concatenate whichever the source touches.
  const denoEnvDtsSource = buildDenoEnvDtsForSource(source);
  const nodeEnvDtsCombined =
    nodeEnvDtsSource !== undefined || denoEnvDtsSource !== undefined
      ? (nodeEnvDtsSource ?? "") + (denoEnvDtsSource ?? "")
      : undefined;
  const injectNodeEnv = nodeEnvDtsCombined !== undefined;

  // #2528 — pick the ambient lib composite for the chosen platform. Unset
  // platform → the DOM composite (byte-neutral with today); `--platform node`
  // drops the DOM ambient surface.
  const defaultLibName = defaultLibNameForPlatform(analyzeOptions);

  // (#743) Optional extra root: the entry's shipped sibling `.d.ts` (flag-gated
  // upstream — undefined means byte-identical behavior). See AnalyzeOptions.
  const entryDeclsText = analyzeOptions?.entryDeclarationsText;

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true, scriptKind);
      }
      if (injectNodeEnv && name === NODE_ENV_DTS_NAME) {
        return ts.createSourceFile(name, nodeEnvDtsCombined, languageVersion, true, ts.ScriptKind.TS);
      }
      if (entryDeclsText !== undefined && name === DTS_ENTRY_DECLS_NAME) {
        return ts.createSourceFile(name, entryDeclsText, languageVersion, true, ts.ScriptKind.TS);
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    getDefaultLibFileName: () => defaultLibName,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) =>
      name === fileName ||
      (injectNodeEnv && name === NODE_ENV_DTS_NAME) ||
      (entryDeclsText !== undefined && name === DTS_ENTRY_DECLS_NAME) ||
      isKnownLibName(name),
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
    if (entryDeclsText !== undefined) rootNames.push(DTS_ENTRY_DECLS_NAME);
    const prog = ts.createProgram(rootNames, compilerOptions, compilerHost);
    // (#743) The shipped declaration root's own diagnostics never surface: it
    // exists purely as a seed source and must not block compiling the package.
    const dropEntryDecls = (diags: readonly ts.Diagnostic[]): readonly ts.Diagnostic[] =>
      entryDeclsText === undefined ? diags : diags.filter((d) => d.file?.fileName !== DTS_ENTRY_DECLS_NAME);
    const syn = dropEntryDecls(prog.getSyntacticDiagnostics());
    const sem = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as readonly ts.Diagnostic[])
      : dropEntryDecls(prog.getSemanticDiagnostics());
    return { prog, syn, sem };
  }

  let { prog: program, syn: syntacticDiagnostics, sem: semanticDiagnostics } = buildProgram(injectNodeEnv);

  if (
    injectNodeEnv &&
    semanticDiagnostics.some((d) => DUP_IDENTIFIER_CODES.has(d.code) && diagnosticMentionsInjectedGlobal(d))
  ) {
    ({ prog: program, syn: syntacticDiagnostics, sem: semanticDiagnostics } = buildProgram(false));
  }

  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: traceTs5Checker(program.getTypeChecker()),
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
  /** Exact per-importer edges captured by compileProject's filesystem resolver. */
  projectResolutions?: ProjectModuleResolutions,
): MultiTypedAST {
  const normalizedFiles = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    normalizedFiles.set(normalizeMultiFileName(name), content);
  }

  // Multi-file package graphs retain their real Node import declarations.
  // Give the checker the same import-scoped ambient module surface as the
  // single-file path while codegen passes those modules through to the Node
  // host. Building once from the joined graph avoids duplicate ambient
  // declarations when many dependencies import the same builtin (#3654).
  const normalizedSourceText = Array.from(normalizedFiles.values()).join("\n");
  const emulateNode = resolveEmulateNode(analyzeOptions) || /\bnode:[A-Za-z0-9_./-]+\b/.test(normalizedSourceText);
  if (emulateNode) {
    const nodeEnvDts = buildNodeEnvDtsForSource(normalizedSourceText, ts.ScriptKind.JS);
    if (nodeEnvDts !== undefined) {
      normalizedFiles.set(NODE_ENV_DTS_NAME, nodeEnvDts);
    }
  }

  const normalizedEntry = normalizeMultiFileName(entryFile);
  const rootNames = Array.from(normalizedFiles.keys());

  const bareSpecifierLookup = buildBareSpecifierLookup(normalizedFiles, specifierMap);
  const projectResolutionLookup = buildProjectModuleResolutionLookup(projectResolutions);

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      const userContent = normalizedFiles.get(name);
      if (userContent !== undefined) {
        return ts.createSourceFile(name, userContent, languageVersion, true, multiFileScriptKind(name));
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    // #2528 — select the DOM-free composite under `--platform node`.
    getDefaultLibFileName: () => defaultLibNameForPlatform(analyzeOptions),
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
      return moduleLiterals.map((literal) => ({
        resolvedModule: resolveMultiFileModule(
          literal.text,
          containingFile,
          normalizedFiles,
          bareSpecifierLookup,
          projectResolutionLookup,
        ),
      }));
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
  // #2815 — drop the benign "Cannot find name 'Deno'" on the natively-lowered
  // Deno stdio surface (this path injects no ambient `Deno` d.ts, unlike #2684).
  const diagnostics = filterRecognizedDenoStdioDiagnostics([...syntacticDiagnostics, ...semanticDiagnostics]);

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
        const resolved = resolveMultiFileModule(
          spec,
          name,
          normalizedFiles,
          bareSpecifierLookup,
          projectResolutionLookup,
        )?.resolvedFileName;
        if (resolved && resolved !== name) visit(resolved);
      }
      visited.add(name);
      onStack.delete(name);
      if (sf !== entrySourceFile && name !== NODE_ENV_DTS_NAME) userSourceFiles.push(sf);
    };
    // Entry-anchored DFS; only files reachable from entry are emitted.
    visit(normalizedEntry);
    userSourceFiles.push(entrySourceFile);
    // Append any additional user files that weren't reached via the entry's import graph
    // (the previous behaviour was to emit every rootName, so we keep that for safety).
    for (const name of rootNames) {
      if (visited.has(name) || name === normalizedEntry) continue;
      if (name === NODE_ENV_DTS_NAME) continue;
      const sf = program.getSourceFile(name);
      if (sf && sf !== entrySourceFile && !userSourceFiles.includes(sf)) {
        userSourceFiles.splice(userSourceFiles.length - 1, 0, sf);
      }
    }
  }

  return {
    sourceFiles: userSourceFiles,
    entryFile: entrySourceFile,
    checker: traceTs5Checker(program.getTypeChecker()),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/**
 * #4452 — emit-shaping options dropped from a project's `compilerOptions`
 * before they reach `ts.createProgram`. `analyzeFiles` builds a TYPE-ONLY
 * program (`noEmit: true`, `program.emit()` is never called), so every one of
 * these is inert at best; `composite` / `incremental` / `tsBuildInfoFile` are
 * worse than inert because TypeScript raises config-level complaints about
 * them under `noEmit` and can touch the filesystem for a build it will never
 * run. Dropping them keeps a real project's tsconfig usable as-is.
 */
const EMIT_ONLY_COMPILER_OPTIONS = [
  "outDir",
  "outFile",
  "declaration",
  "declarationDir",
  "declarationMap",
  "emitDeclarationOnly",
  "sourceMap",
  "inlineSourceMap",
  "inlineSources",
  "composite",
  "incremental",
  "tsBuildInfoFile",
] as const;

/**
 * #4452 — resolve the project `compilerOptions` for `analyzeFiles`.
 *
 * Returns `undefined` when the legacy hardcoded options should be used: the
 * caller passed `tsconfig: false`, there is no filesystem host (browser
 * bundle), or no `tsconfig.json` is reachable from the entry file. An
 * EXPLICIT `tsconfig` path that cannot be read throws instead of falling back
 * — the caller named it, so a typo must not silently degrade to a different
 * option set.
 */
function resolveProjectCompilerOptions(
  resolvedEntry: string,
  tsconfigOption: string | false | undefined,
): ts.CompilerOptions | undefined {
  if (tsconfigOption === false) return undefined;
  const sys = ts.sys;
  if (!sys) return undefined; // no disk host — legacy options
  const pathMod = require("node:path") as typeof import("node:path");

  let configPath: string | undefined;
  if (typeof tsconfigOption === "string") {
    configPath = pathMod.resolve(tsconfigOption);
    if (!sys.fileExists(configPath)) {
      throw new Error(`tsconfig not found: ${configPath}`);
    }
  } else {
    configPath = ts.findConfigFile(pathMod.dirname(resolvedEntry), (f) => sys.fileExists(f), "tsconfig.json");
    if (!configPath) return undefined;
  }

  const read = ts.readConfigFile(configPath, (f) => sys.readFile(f));
  if (read.error || !read.config) {
    if (typeof tsconfigOption === "string") {
      const detail = read.error ? ts.flattenDiagnosticMessageText(read.error.messageText, " ") : "empty config";
      throw new Error(`tsconfig could not be read: ${configPath} — ${detail}`);
    }
    // A broken config found by SEARCH is not the caller's stated intent; fall
    // back rather than refusing to compile a file that merely lives near it.
    return undefined;
  }

  // `parseJsonConfigFileContent` resolves `extends`, path-valued options
  // (`rootDir`, `paths`, `typeRoots`, …) against the config's directory and
  // maps the string enums onto their `ts.*Kind` values. We take only
  // `.options`; the program's roots stay entry-anchored, so `include` /
  // `exclude` / `files` are deliberately ignored.
  const parsed = ts.parseJsonConfigFileContent(read.config, sys, pathMod.dirname(configPath), undefined, configPath);
  const options: ts.CompilerOptions = { ...parsed.options };
  for (const key of EMIT_ONLY_COMPILER_OPTIONS) delete options[key];
  return options;
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

  // #4452 — the BASE options are the project's own, when a `tsconfig.json` is
  // reachable from the entry. Hardcoding a single option set here made the
  // compiler disagree with `tsc` about the very sources it was compiling:
  // `rootDir: dirname(entry)` rejected any cross-directory import
  // ("File 'x' is not under 'rootDir'"), `Node10` without interop rejected
  // CJS default imports, and `strict` WITHOUT `noImplicitAny` disabled TS's
  // evolving-array/object inference — which is what produced the
  // "not assignable to parameter of type 'never'" /
  // "Property 'x' does not exist on type '{}'" cluster on code that
  // type-checks clean under its own tsconfig.
  const projectOptions = resolveProjectCompilerOptions(resolvedEntry, analyzeOptions?.tsconfig);
  const baseOptions: ts.CompilerOptions = projectOptions ?? {
    // ---- legacy defaults: no project config in scope --------------------
    // Load-bearing for arbitrary input outside a TS project (playground /
    // dogfood paths compile a lone file that has no tsconfig above it).
    // Unchanged from the pre-#4452 behavior, deliberately, so that path is
    // byte-neutral.
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    // Lenient on purpose: with no config we do not know the author's intent
    // and js2wasm's codegen tolerates implicit `any`. When a tsconfig IS in
    // scope, the project's own strictness governs instead.
    noImplicitAny: false,
    rootDir: pathMod.dirname(resolvedEntry),
  };

  const compilerOptions: ts.CompilerOptions = {
    ...baseOptions,
    // ---- pipeline-required overrides, applied over ANY base -------------
    // Type-only program: js2wasm emits wasm itself and never calls
    // `program.emit()`, so a project's emit settings must not write anything.
    noEmit: true,
    // Enable JSX parsing when the entry file is .tsx/.jsx (#1531) — but only
    // if the config did not already choose a `jsx` mode, so a project that
    // selected `preserve`/`react` keeps its choice.
    ...(entryIsJsx && baseOptions.jsx === undefined ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  };

  if (analyzeOptions?.allowJs) {
    // The caller states the graph contains JS; this outranks the config.
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram([resolvedEntry], compilerOptions);
  const checker = traceTs5Checker(program.getTypeChecker());

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
    ? ([] as ts.Diagnostic[])
    : program.getSemanticDiagnostics();
  // #2815 — drop the benign "Cannot find name 'Deno'" on the natively-lowered
  // Deno stdio surface (this path injects no ambient `Deno` d.ts, unlike #2684).
  const diagnostics = filterRecognizedDenoStdioDiagnostics([...syntacticDiagnostics, ...semanticDiagnostics]);

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

export { IncrementalLanguageService, IncrementalProjectLanguageService } from "./language-service.js";
export type { ProjectModuleResolutions } from "./multi-file-paths.js";
