// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import * as path from "path";
import { ts } from "./ts-api.js";
import type { CompileOptions } from "./index.js";
import { rewriteCjsRequire } from "./cjs-rewrite.js";
import { getDefaultEnvironment } from "./env.js";
import { resolveConsumerDrivenImports } from "./resolve/consumer-driven-barrels.js";

export interface ModuleResolutionDiagnostic {
  message: string;
  file: string;
  line: number;
  column: number;
  severity: "error";
}

// Filesystem access goes through the environment adapter (#1096).
// This module no longer probes `typeof window` / `typeof process` directly
// and no longer uses top-level `await` — `getDefaultEnvironment()` is fully
// synchronous, which lets embedders import the resolver without forcing the
// whole module graph through async initialization.
function getFs(): typeof import("node:fs") | null {
  return getDefaultEnvironment().fs;
}

/**
 * Module resolver that uses TypeScript's built-in `ts.resolveModuleName()`
 * to resolve bare specifiers (e.g., "lodash") and relative specifiers
 * (e.g., "./utils") to actual file paths on disk.
 */
export class ModuleResolver {
  private compilerOptions: ts.CompilerOptions;
  private host: ts.ModuleResolutionHost;
  private externals: Set<string>;
  private extensions: string[];
  private resolveCache = new Map<string, string | null>();
  private resolvedImports = new Map<string, Map<string, string>>();
  private staticJsonSources = new Map<string, string>();
  private diagnostics: ModuleResolutionDiagnostic[] = [];
  /** Whether pure barrels may be expanded from their consumers' named demand. */
  readonly consumerDrivenBarrels: boolean;

  /**
   * Create a resolver rooted at a directory.
   *
   * @param rootDir - Directory that bare and relative specifiers resolve against.
   * @param options - Compile options; reads `externals` and `resolve.*`.
   */
  constructor(
    private rootDir: string,
    options?: CompileOptions,
  ) {
    this.externals = new Set(options?.externals ?? []);
    this.extensions = options?.resolve?.extensions ?? [".ts", ".tsx", ".d.ts"];
    this.consumerDrivenBarrels = options?.resolve?.consumerDrivenBarrels === true;

    // Build compiler options for TS resolver
    const moduleDirs = options?.resolve?.modules ?? ["node_modules"];
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      allowJs: options?.allowJs === true,
      checkJs: options?.allowJs === true,
      baseUrl: rootDir,
      rootDir,
      // Allow TS to find types in the specified module directories
      typeRoots: moduleDirs.map((d) => (path.isAbsolute(d) ? d : path.resolve(rootDir, d))),
      // Try to load tsconfig.json paths if available
      ...this.loadTsconfigPaths(),
    };

    this.host = {
      fileExists: (fileName) => {
        try {
          return getFs()!.statSync(fileName).isFile();
        } catch {
          return false;
        }
      },
      readFile: (fileName) => {
        try {
          return getFs()!.readFileSync(fileName, "utf-8");
        } catch {
          return undefined;
        }
      },
      directoryExists: (dirName) => {
        try {
          return getFs()!.statSync(dirName).isDirectory();
        } catch {
          return false;
        }
      },
      getCurrentDirectory: () => rootDir,
      getDirectories: (dirPath) => {
        try {
          return getFs()!
            .readdirSync(dirPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          return [];
        }
      },
      realpath: (p) => {
        try {
          return getFs()!.realpathSync(p);
        } catch {
          return p;
        }
      },
    };
  }

  /**
   * Try to load tsconfig.json paths configuration from the root directory.
   */
  private loadTsconfigPaths(): Partial<ts.CompilerOptions> {
    const tsconfigPath = path.join(this.rootDir, "tsconfig.json");
    try {
      if (!getFs()!.statSync(tsconfigPath).isFile()) return {};
    } catch {
      return {};
    }

    const configFile = ts.readConfigFile(tsconfigPath, (p) => getFs()!.readFileSync(p, "utf-8"));
    if (configFile.error || !configFile.config) return {};

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.rootDir);
    const result: Partial<ts.CompilerOptions> = {};
    if (parsed.options.paths) {
      result.paths = parsed.options.paths;
    }
    if (parsed.options.baseUrl) {
      result.baseUrl = parsed.options.baseUrl;
    }
    return result;
  }

  /**
   * Resolve a module specifier to a file path.
   *
   * @param specifier - The import specifier (e.g., "lodash", "./utils")
   * @param containingFile - The file that contains the import statement
   * @returns The resolved file path, or null if the module is external or not found
   */
  resolve(specifier: string, containingFile: string): string | null {
    // Check if the package is in the externals list
    const pkgName = getBarePackageName(specifier);
    if (pkgName && this.externals.has(pkgName)) {
      return null;
    }

    // Resolve from the importer's physical location. Package managers such as
    // pnpm expose packages through symlinks, but a dependency's private
    // node_modules tree lives beside the physical package in the store. Node
    // resolves from that physical context; using the logical symlink path makes
    // sibling dependencies such as eslint-scope disappear (#3654).
    const resolutionContainingFile = this.host.realpath?.(containingFile) ?? containingFile;

    // Build a cache key from the canonical importer identity.
    const cacheKey = `${resolutionContainingFile}::${specifier}`;
    if (this.resolveCache.has(cacheKey)) {
      return this.resolveCache.get(cacheKey)!;
    }

    // Static relative JSON requires are compile-time modules, not filesystem
    // capabilities exposed to Wasm. Handle them before TypeScript's script
    // resolver, which intentionally ignores JSON without resolveJsonModule.
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".json")) {
      const resolvedJson = this.resolveStaticJson(specifier, resolutionContainingFile);
      this.resolveCache.set(cacheKey, resolvedJson);
      if (resolvedJson !== null) {
        this.recordResolvedImport(resolutionContainingFile, specifier, resolvedJson);
      }
      return resolvedJson;
    }

    // Use TypeScript's module resolution
    const result = ts.resolveModuleName(specifier, resolutionContainingFile, this.compilerOptions, this.host);

    let resolved: string | null = null;
    if (result.resolvedModule) {
      resolved = result.resolvedModule.resolvedFileName;
      // Normalize the path
      resolved = this.host.realpath?.(path.resolve(resolved)) ?? path.resolve(resolved);

      // An explicit relative JavaScript import names the runtime body, even when
      // TypeScript redirects that specifier to a sibling declaration file for
      // type checking.  Packages such as Moment ship `moment.js` beside
      // `moment.d.ts`; following TS's declaration substitution here caused the
      // graph walker to compile only the ambient signature and bind the import
      // to null.  Keep TypeScript's normal extension substitution when the
      // requested body does not exist (for the common `./source.js` ->
      // `./source.ts` authoring pattern), but prefer the exact executable file
      // whenever it is present on disk.
      if (
        !pkgName &&
        (specifier.startsWith("./") || specifier.startsWith("../") || path.isAbsolute(specifier)) &&
        /\.[cm]?js$/i.test(specifier) &&
        /\.d\.[cm]?ts$/i.test(resolved)
      ) {
        const requestedBody = path.resolve(path.dirname(resolutionContainingFile), specifier);
        if (this.tryStatFile(requestedBody)) {
          resolved = this.host.realpath?.(requestedBody) ?? requestedBody;
        }
      }

      // TypeScript's standard resolver prefers `.d.ts` declarations over
      // implementation bodies in two cases relevant to js2wasm:
      //   1. `@types/<pkg>` declaration packages distinct from the impl
      //      package (see issue #1060).
      //   2. Self-typed packages with a `types` condition in `exports`
      //      (e.g. ESLint's `{"types": "./lib/types/index.d.ts",
      //      "default": "./lib/api.js"}`) — see issue #1559.
      // For js2wasm's multi-file compile path we need the implementation
      // body, not just the type signatures — otherwise the import site
      // compiles to a stub that never calls the real function. When we
      // detect a `.d.ts` resolution for a bare-package specifier, try to
      // locate the matching `.js` / `.mjs` / `.cjs` / `.ts` body in a
      // sibling `node_modules/<pkg>/<subpath>` and return that instead.
      // If no implementation body is found (declaration-only package),
      // the `.d.ts` is kept and codegen falls back to extern stubs.
      if (pkgName && (/[/\\]@types[/\\]/.test(resolved) || /\.d\.[cm]?ts$/.test(resolved))) {
        const implPath = this.findImplementationBody(pkgName, specifier, resolutionContainingFile);
        if (implPath) {
          resolved = this.host.realpath?.(implPath) ?? implPath;
        }
      }
    }

    this.resolveCache.set(cacheKey, resolved);
    if (resolved !== null) {
      this.recordResolvedImport(resolutionContainingFile, specifier, resolved);
    }
    return resolved;
  }

  private recordResolvedImport(containingFile: string, specifier: string, resolved: string): void {
    let imports = this.resolvedImports.get(containingFile);
    if (!imports) {
      imports = new Map();
      this.resolvedImports.set(containingFile, imports);
    }
    imports.set(specifier, resolved);
  }

  private resolveStaticJson(specifier: string, containingFile: string): string | null {
    const jsonPath = this.canonicalize(path.resolve(path.dirname(containingFile), specifier));
    let raw: string;
    try {
      raw = getFs()!.readFileSync(jsonPath, "utf-8");
    } catch {
      this.diagnostics.push({
        message:
          `Static JSON require '${specifier}' from '${containingFile}' could not read ` +
          `'${jsonPath}': file not found`,
        file: containingFile,
        line: 1,
        column: 1,
        severity: "error",
      });
      return null;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.diagnostics.push({
        message:
          `Static JSON require '${specifier}' from '${containingFile}' could not parse ` + `'${jsonPath}': ${detail}`,
        file: containingFile,
        line: 1,
        column: 1,
        severity: "error",
      });
      return null;
    }

    const binding = `__js2wasm_json_module_value_${this.staticJsonSources.size}`;
    this.staticJsonSources.set(jsonPath, `const ${binding} = ${JSON.stringify(value)};\nexport default ${binding};\n`);
    return jsonPath;
  }

  /** Return the physical identity used for package-resolution and graph de-duplication. */
  canonicalize(filePath: string): string {
    const absolute = path.resolve(filePath);
    return this.host.realpath?.(absolute) ?? absolute;
  }

  /**
   * Return the resolved import edges recorded while walking one source file.
   * compileProject threads these exact edges into its virtual TypeScript host
   * instead of asking the in-memory host to rediscover pnpm's filesystem.
   */
  getResolvedImports(containingFile: string): ReadonlyMap<string, string> {
    return this.resolvedImports.get(this.canonicalize(containingFile)) ?? new Map();
  }

  /** Return the synthesized JavaScript module for a parsed static JSON file. */
  getStaticJsonSource(filePath: string): string | undefined {
    return this.staticJsonSources.get(this.canonicalize(filePath));
  }

  /** Return source-qualified resolver failures collected during graph expansion. */
  getDiagnostics(): readonly ModuleResolutionDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * When `ts.resolveModuleName` returned a file under `@types/<pkg>/`,
   * attempt to find the matching real implementation body in a sibling
   * `node_modules/<pkg>/` directory and return its absolute path, or null
   * if no implementation file can be located.
   *
   * Handles both standard npm layouts (`node_modules/<pkg>/...`) and pnpm
   * layouts (where `@types/<pkg>` lives under `.pnpm/` but the real package
   * is still hoisted to the top-level `node_modules/<pkg>`). The search
   * walks up from `containingFile` through parent directories looking for
   * each candidate — this matches Node's own module resolution walk.
   */
  private findImplementationBody(pkgName: string, specifier: string, containingFile: string): string | null {
    const fs = getFs();
    if (!fs) return null;

    // Extract the subpath within the package. For "lodash-es/identity.js",
    // pkgName="lodash-es" and subpath="identity.js". For scoped packages
    // like "@scope/pkg/sub", pkgName="@scope/pkg" and subpath="sub".
    const afterPkg = specifier.slice(pkgName.length).replace(/^\//, "");

    // Candidate extensions to probe when the specifier has no extension,
    // or when the specifier's .js needs to be mapped to a real file on
    // disk (some packages ship source as .ts/.mjs alongside .d.ts stubs).
    const probeExtensions = ["", ".js", ".mjs", ".cjs", ".ts"];

    // Walk up from the containing file's directory looking for a
    // `node_modules/<pkgName>/<subpath>` match. This mirrors Node's module
    // resolution and correctly handles pnpm / workspace layouts where
    // `@types/<pkg>` and `<pkg>` may be hoisted to different levels.
    let dir = path.dirname(containingFile);
    const root = path.parse(dir).root;
    const seenDirs = new Set<string>();
    while (!seenDirs.has(dir)) {
      seenDirs.add(dir);
      const pkgRoot = path.join(dir, "node_modules", pkgName);
      if (this.tryStatDir(pkgRoot)) {
        const found = this.probeImplementationPath(pkgRoot, afterPkg, probeExtensions);
        if (found) return found;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Fall back to rootDir/node_modules/<pkg> in case the containing file
    // lives outside the normal project tree (e.g. synthetic test inputs).
    const rootPkg = path.join(this.rootDir, "node_modules", pkgName);
    if (this.tryStatDir(rootPkg)) {
      const found = this.probeImplementationPath(rootPkg, afterPkg, probeExtensions);
      if (found) return found;
    }
    return null;
  }

  /** True if `p` exists and is a directory. */
  private tryStatDir(p: string): boolean {
    const fs = getFs();
    if (!fs) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** True if `p` exists and is a file. */
  private tryStatFile(p: string): boolean {
    const fs = getFs();
    if (!fs) return false;
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Given a package root (e.g. `.../node_modules/lodash-es`) and a subpath
   * from a specifier (e.g. `identity.js` or `identity` or ``), attempt to
   * locate the implementation file on disk using the probe extensions.
   */
  private probeImplementationPath(pkgRoot: string, afterPkg: string, exts: readonly string[]): string | null {
    // Bare specifier (no subpath): read package.json `main` / `module`.
    if (afterPkg === "") {
      const pkgJsonPath = path.join(pkgRoot, "package.json");
      if (this.tryStatFile(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(getFs()!.readFileSync(pkgJsonPath, "utf-8"));
          const mainField: string | undefined = pkg.module ?? pkg.main;
          if (typeof mainField === "string" && mainField.length > 0) {
            const mainPath = path.resolve(pkgRoot, mainField);
            if (this.tryStatFile(mainPath)) return mainPath;
            for (const ext of exts) {
              if (ext === "") continue;
              const withExt = mainPath + ext;
              if (this.tryStatFile(withExt)) return withExt;
            }
          }
        } catch {
          // Malformed package.json — fall through to index probes
        }
      }
      // Fall back to index.{js,mjs,cjs,ts}
      for (const ext of exts) {
        if (ext === "") continue;
        const indexPath = path.join(pkgRoot, "index" + ext);
        if (this.tryStatFile(indexPath)) return indexPath;
      }
      return null;
    }

    // Subpath specifier: try the exact path first, then strip `.d.ts` or
    // probe additional extensions.
    const direct = path.join(pkgRoot, afterPkg);
    if (this.tryStatFile(direct)) return direct;

    // If the specifier ended in `.js` but only a `.ts` body exists on disk,
    // swap the extension.
    if (afterPkg.endsWith(".js")) {
      const asTs = path.join(pkgRoot, afterPkg.slice(0, -3) + ".ts");
      if (this.tryStatFile(asTs)) return asTs;
      const asMjs = path.join(pkgRoot, afterPkg.slice(0, -3) + ".mjs");
      if (this.tryStatFile(asMjs)) return asMjs;
    }

    // No extension on the specifier: probe each candidate.
    if (!/\.[a-zA-Z0-9]+$/.test(afterPkg)) {
      for (const ext of exts) {
        if (ext === "") continue;
        const withExt = path.join(pkgRoot, afterPkg + ext);
        if (this.tryStatFile(withExt)) return withExt;
      }
    }
    return null;
  }

  /**
   * Check if a specifier refers to an external package.
   */
  isExternal(specifier: string): boolean {
    const pkgName = getBarePackageName(specifier);
    return pkgName !== null && this.externals.has(pkgName);
  }
}

/**
 * Extract the bare package name from a specifier.
 * Returns null for relative/absolute paths.
 *
 * Examples:
 * - "lodash" → "lodash"
 * - "lodash/fp" → "lodash"
 * - "@scope/pkg" → "@scope/pkg"
 * - "@scope/pkg/sub" → "@scope/pkg"
 * - "./utils" → null
 * - "/absolute/path" → null
 */
export function getBarePackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }

  if (specifier.startsWith("@")) {
    // Scoped package: @scope/pkg or @scope/pkg/sub
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return specifier;
  }

  // Regular package: pkg or pkg/sub
  const slashIdx = specifier.indexOf("/");
  if (slashIdx === -1) return specifier;
  return specifier.slice(0, slashIdx);
}

/**
 * Recursively resolve all imports starting from an entry file,
 * building a complete dependency graph.
 *
 * Files are returned in topological order (deps first, importers last,
 * entry last). This is essential for module-init code generation:
 * top-level statements that depend on imported variables must run
 * after their dependencies' top-level statements (#1109).
 *
 * Cycles are tolerated — when re-entering a node we drop the back-edge
 * and continue the post-order walk. The result mirrors ES module
 * evaluation order: each module's body runs after its imports' bodies,
 * with cycles broken by the first-seen position.
 *
 * @returns A map of file paths to source contents (including the entry file)
 */
export function resolveAllImports(entryFile: string, resolver: ModuleResolver): Map<string, string> {
  if (resolver.consumerDrivenBarrels) {
    return resolveConsumerDrivenImports(entryFile, resolver, (filePath) => {
      const synthesized = resolver.getStaticJsonSource(filePath);
      if (synthesized !== undefined) return synthesized;
      try {
        return getFs()!.readFileSync(filePath, "utf-8");
      } catch {
        return undefined;
      }
    });
  }

  const resolved = new Map<string, string>();
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function visit(filePath: string): void {
    const canonicalPath = resolver.canonicalize(filePath);
    if (visited.has(canonicalPath) || onStack.has(canonicalPath)) return;
    onStack.add(canonicalPath);

    let content = resolver.getStaticJsonSource(canonicalPath);
    if (content === undefined) {
      try {
        content = getFs()!.readFileSync(canonicalPath, "utf-8");
      } catch {
        // File not found — skip (TS will report errors)
        onStack.delete(canonicalPath);
        return;
      }
    }

    // Rewrite CJS `const X = require('Y')` to ESM `import X from 'Y'` so the
    // dependency-walk below picks up CommonJS modules' transitive deps the same
    // way it picks up ESM ones (#1279).
    content = rewriteCjsRequire(content);

    // Parse to find import specifiers
    const sf = ts.createSourceFile(
      canonicalPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      canonicalPath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : /\.[cm]?js$/.test(canonicalPath)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
    );

    // Visit dependencies first (post-order DFS) so their content lands
    // in `resolved` before this file's content. This produces a true
    // topological order: deps before importers, entry last.
    const resolveAndVisit = (specifier: string): void => {
      const resolvedPath = resolver.resolve(specifier, canonicalPath);
      if (resolvedPath) visit(resolvedPath);
    };
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        resolveAndVisit(stmt.moduleSpecifier.text);
      }
      // Also handle export ... from "..."
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        resolveAndVisit(stmt.moduleSpecifier.text);
      }

      // Some CommonJS bindings wrap a static require call, e.g.
      // `const debug = require("debug")("namespace")`. That shape cannot be
      // rewritten into a semantics-equivalent import declaration, but its
      // package edge is still static and must participate in resolution.
      if (ts.isVariableStatement(stmt)) {
        const scanRequire = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            node.arguments.length === 1 &&
            (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
          ) {
            resolveAndVisit(node.arguments[0].text);
            return;
          }
          ts.forEachChild(node, scanRequire);
        };
        for (const declaration of stmt.declarationList.declarations) {
          if (declaration.initializer) scanRequire(declaration.initializer);
        }
      }
    }

    // TypeScript's JSDoc imports are checker-visible module edges but are not
    // ordinary ImportDeclarations. ESLint uses both `import("...")` typedefs
    // and the `@import { T } from "..."` form for declaration-only packages.
    const jsdocSpecifiers = new Set<string>();
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      const comment = scanner.getTokenText();
      for (const match of comment.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        jsdocSpecifiers.add(match[1]);
      }
      for (const match of comment.matchAll(/@import[^\r\n]*?\bfrom\s+["']([^"']+)["']/g)) {
        jsdocSpecifiers.add(match[1]);
      }
    }
    for (const specifier of jsdocSpecifiers) resolveAndVisit(specifier);

    visited.add(canonicalPath);
    onStack.delete(canonicalPath);
    resolved.set(canonicalPath, content);
  }

  visit(path.resolve(entryFile));
  return resolved;
}
