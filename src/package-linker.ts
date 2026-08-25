// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Project-level npm package linker (#2527).
 *
 * This module deliberately sits above the regular multi-file compiler.  The
 * checker still sees a complete graph while we plan it, but each supported
 * bare-package component is then compiled from its own source map into a real
 * Wasm binary.  The application graph receives declaration-only stubs and
 * imports the provider exports by namespace.  A source cache is never used as
 * a substitute for a provider binary.
 */

import * as path from "path";
import { createHash } from "node:crypto";
import { ts } from "./ts-api.js";
import type { CompileOptions, CompileResult, LinkedModuleArtifact, PackageLinkPlan } from "./index.js";
import { compileMultiSource } from "./compiler.js";
import type { ProjectModuleResolutions } from "./checker/index.js";
import { getBarePackageName } from "./resolve.js";
import { getDefaultEnvironment } from "./env.js";
import { buildCompiledImports } from "./runtime.js";
import { buildStringConstants, buildStringConstants16 } from "./runtime/string-constants.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "./emit/canonical-recgroup.js";

const LINKER_VERSION = "npm-link-v1";

export interface PackageLinkInput {
  allFiles: Map<string, string>;
  fileKeys: Map<string, string>;
  entryKey: string;
  resolvedEntry: string;
  rootDir: string;
  projectResolutions: ProjectModuleResolutions;
  options: CompileOptions;
}

export type PackageLinkAttempt =
  | { kind: "none" }
  | { kind: "fallback"; plan: PackageLinkPlan }
  | { kind: "separate"; result: CompileResult; artifacts: LinkedModuleArtifact[]; plan: PackageLinkPlan };

interface FunctionExport {
  name: string;
  declaration: ts.FunctionDeclaration;
}

interface PackageNode {
  root: string;
  name: string;
  files: string[];
  entry: string;
  exports: Map<string, FunctionExport>;
  dependencies: Set<string>;
  dependencyTargets: Map<string, string>;
  externalImporters: string[];
  entryTargets: Set<string>;
}

interface ExternalBinding {
  importer: string;
  specifier: string;
  packageRoot: string;
  target: string;
  exportName: string;
  localName: string;
}

interface CachedProvider {
  binary: Uint8Array;
  exports: string[];
  exportSignatures: Record<string, string>;
  stringPool?: string[];
}

// The disk cache is the cross-process boundary; this in-process cache also
// makes repeated benchmark consumers in one worker provably compile each
// provider once even when their entry files live under different directories.
const memoryProviderCache = new Map<string, CachedProvider>();

function wasmBytes(binary: Uint8Array): BufferSource {
  return binary as unknown as BufferSource;
}

function hashText(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function compilerOptionFingerprint(options: CompileOptions): string {
  return JSON.stringify({
    target: options.target ?? "gc",
    fast: options.fast === true,
    nativeStrings: options.nativeStrings === true,
    utf8Storage: options.utf8Storage === true,
    semanticProviders: options.semanticProviders ?? "auto",
    hostBridge: options.hostBridge ?? "auto",
    honestAnyBoxing: options.honestAnyBoxing === true,
    unionAnyRep: options.unionAnyRep === true,
    undefinedSingleton: options.undefinedSingleton === true,
    tag5ValueEqClassifier: options.tag5ValueEqClassifier === true,
    runtimeRecGroupAbi: RUNTIME_RECGROUP_ABI_VERSION,
  });
}

function normalizePhysical(fileName: string): string {
  return path.resolve(fileName);
}

/** Return the nearest node_modules package root for a physical source path. */
function packageRootFor(fileName: string): string | undefined {
  const normalized = normalizePhysical(fileName);
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const after = normalized.slice(markerIndex + marker.length);
  const segments = after.split(path.sep).filter(Boolean);
  if (segments.length === 0) return undefined;
  const packageSegments = segments[0].startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return path.join(normalized.slice(0, markerIndex + marker.length), ...packageSegments);
}

function packageNameForRoot(root: string): string {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = root.lastIndexOf(marker);
  return index < 0 ? path.basename(root) : path.relative(root.slice(0, index + marker.length), root);
}

function isExported(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: readonly ts.Node[] }).modifiers;
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefault(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: readonly ts.Node[] }).modifiers;
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function parseSource(fileName: string, source: string): ts.SourceFile {
  const scriptKind = /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, scriptKind);
}

function functionSignature(exported: FunctionExport, sourceFile: ts.SourceFile): string {
  const fn = exported.declaration;
  const typeParameters = fn.typeParameters ? `<${fn.typeParameters.map((p) => p.getText(sourceFile)).join(", ")}>` : "";
  const parameters = fn.parameters
    .map((parameter) => {
      const name = parameter.name.getText(sourceFile);
      const optional = parameter.questionToken ? "?" : "";
      const rest = parameter.dotDotDotToken ? "..." : "";
      const type = parameter.type?.getText(sourceFile) ?? "any";
      return `${rest}${name}${optional}: ${type}`;
    })
    .join(", ");
  const returnType = fn.type?.getText(sourceFile) ?? "any";
  return `export declare function ${exported.name}${typeParameters}(${parameters}): ${returnType};`;
}

function isPrimitiveTypeNode(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return true;
    case ts.SyntaxKind.ParenthesizedType:
      return isPrimitiveTypeNode((node as ts.ParenthesizedTypeNode).type);
    case ts.SyntaxKind.LiteralType: {
      const literal = (node as ts.LiteralTypeNode).literal;
      return (
        ts.isStringLiteral(literal) ||
        ts.isNumericLiteral(literal) ||
        literal.kind === ts.SyntaxKind.TrueKeyword ||
        literal.kind === ts.SyntaxKind.FalseKeyword
      );
    }
    default:
      return false;
  }
}

function isPrimitiveFunction(declaration: ts.FunctionDeclaration): boolean {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return false;
  if (!isPrimitiveTypeNode(declaration.type)) return false;
  return declaration.parameters.every((parameter) => isPrimitiveTypeNode(parameter.type));
}

/**
 * Find the directly declared function exports of a package entry.  Re-exported
 * functions and value/class exports are intentionally rejected in this ABI
 * slice: silently dropping a value at a Wasm boundary is worse than choosing
 * the documented monolithic fallback.
 */
function inspectFunctionExports(
  fileName: string,
  source: string,
): { exports?: Map<string, FunctionExport>; reason?: string } {
  const sourceFile = parseSource(fileName, source);
  const exports = new Map<string, FunctionExport>();
  let sawRuntimeExport = false;
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      if (isDefault(statement)) return { reason: "default package exports are not yet link-safe" };
      if (!isPrimitiveFunction(statement)) return { reason: "package function has a non-primitive ABI signature" };
      exports.set(statement.name.text, { name: statement.name.text, declaration: statement });
      sawRuntimeExport = true;
      continue;
    }
    if (!isExported(statement)) continue;
    if (
      ts.isVariableStatement(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      (ts.isExportAssignment(statement) && !ts.isIdentifier(statement.expression))
    ) {
      return { reason: "package exports a value, class, enum, or expression boundary" };
    }
    if (ts.isExportDeclaration(statement)) {
      return { reason: "re-exported package entrypoints are not yet link-safe" };
    }
    // Interfaces and type aliases have no runtime boundary and are harmless.
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      return { reason: "unsupported runtime package export declaration" };
    }
  }
  if (!sawRuntimeExport) return { reason: "package entry has no directly exported functions" };
  return { exports };
}

function importBindings(
  sourceFile: ts.SourceFile,
  specifier: string,
):
  | { bindings: Array<{ exportName: string; localName: string }>; unsupported?: undefined }
  | { bindings?: undefined; unsupported: string } {
  const bindings: Array<{ exportName: string; localName: string }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue;
    const clause = statement.importClause;
    if (!clause) continue; // side-effect imports are permitted; provider init runs on instantiation.
    if (clause.name) bindings.push({ exportName: "default", localName: clause.name.text });
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      return { unsupported: `namespace import from ${specifier}` };
    }
    for (const element of clause.namedBindings.elements) {
      const exportName = element.propertyName?.text ?? element.name.text;
      bindings.push({ exportName, localName: element.name.text });
    }
  }
  return { bindings };
}

function buildDeclarationStub(node: PackageNode): string {
  const source = nodeSource(node, node.entry);
  const sourceFile = parseSource(node.entry, source);
  return Array.from(node.exports.values(), (exported) => functionSignature(exported, sourceFile)).join("\n") + "\n";
}

function exportSignaturesFor(node: PackageNode): Record<string, string> {
  const source = nodeSource(node, node.entry);
  const sourceFile = parseSource(node.entry, source);
  return Object.fromEntries(
    Array.from(node.exports.values(), (exported) => [exported.name, functionSignature(exported, sourceFile)]),
  );
}

function nodeSource(node: PackageNode, fileName: string): string {
  // Filled by the caller through the temporary source map property below.
  return (node as PackageNode & { sourceByFile?: Map<string, string> }).sourceByFile?.get(fileName) ?? "";
}

function providerNamespace(node: PackageNode, cacheKey: string): string {
  return `js2wasm:npm:${node.name}:${cacheKey.slice(0, 16)}`;
}

function packageFileKey(root: string, fileName: string): string {
  const relative = path.relative(root, fileName).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function packageKeyToPhysical(root: string, key: string): string {
  return normalizePhysical(path.join(root, key.replace(/^\.\//, "")));
}

function cachePaths(cacheDir: string, cacheKey: string): { wasm: string; json: string } {
  return {
    wasm: path.join(cacheDir, `${cacheKey}.wasm`),
    json: path.join(cacheDir, `${cacheKey}.json`),
  };
}

function readCachedArtifact(
  cacheDir: string,
  cacheKey: string,
):
  | {
      binary: Uint8Array;
      exports: string[];
      exportSignatures: Record<string, string>;
      stringPool?: string[];
    }
  | undefined {
  const memory = memoryProviderCache.get(cacheKey);
  if (memory) {
    return {
      binary: memory.binary,
      exports: memory.exports,
      exportSignatures: memory.exportSignatures,
      stringPool: memory.stringPool,
    };
  }
  const fs = getDefaultEnvironment().fs;
  if (!fs) return undefined;
  const paths = cachePaths(cacheDir, cacheKey);
  try {
    const metadata = JSON.parse(fs.readFileSync(paths.json, "utf8")) as {
      version?: string;
      exports?: string[];
      stringPool?: string[];
      exportSignatures?: Record<string, string>;
    };
    if (metadata.version !== LINKER_VERSION || !Array.isArray(metadata.exports)) return undefined;
    const binary = new Uint8Array(fs.readFileSync(paths.wasm));
    // Do not trust stale or manually edited cache entries.
    new WebAssembly.Module(wasmBytes(binary));
    return {
      binary,
      exports: metadata.exports.filter((name): name is string => typeof name === "string"),
      exportSignatures:
        metadata.exportSignatures && typeof metadata.exportSignatures === "object" ? metadata.exportSignatures : {},
      stringPool: Array.isArray(metadata.stringPool)
        ? metadata.stringPool.filter((value): value is string => typeof value === "string")
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeCachedArtifact(
  cacheDir: string,
  cacheKey: string,
  binary: Uint8Array,
  exports: string[],
  exportSignatures: Record<string, string>,
  stringPool: readonly string[],
): void {
  const fs = getDefaultEnvironment().fs;
  if (!fs) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const paths = cachePaths(cacheDir, cacheKey);
    fs.writeFileSync(paths.wasm, binary);
    fs.writeFileSync(
      paths.json,
      JSON.stringify({ version: LINKER_VERSION, exports, exportSignatures, stringPool }, null, 2),
    );
  } catch {
    // A read-only cache is an optimization miss, never a compilation failure.
  }
}

function makeFallback(reason: string): PackageLinkAttempt {
  return {
    kind: "fallback",
    plan: {
      mode: "bundled",
      version: 1,
      fallbackReason: reason,
      namespaces: [],
      compiledProviders: 0,
      cachedProviders: 0,
    },
  };
}

/**
 * Let the engine perform the final function-type check for every provider
 * import/export edge. The generated declaration stub and provider source share
 * the same manifest signature; instantiation catches any backend type drift
 * (including f64/i32/ref mismatches) before the linked result is published.
 */
function validateLinkedSignatures(
  result: CompileResult,
  artifacts: readonly LinkedModuleArtifact[],
): string | undefined {
  if (result.hasTopLevelStatements || artifacts.length === 0) return undefined;
  try {
    const built = buildCompiledImports(result);
    const baseImports: WebAssembly.Imports = {
      env: built.env,
      "wasm:js-string": built["wasm:js-string"],
      string_constants: built.string_constants,
      string_constants16: built.string_constants16,
    } as unknown as WebAssembly.Imports;
    const providerExports = new Map<string, WebAssembly.Exports>();
    for (const artifact of artifacts) {
      const providerImports: WebAssembly.Imports = { ...baseImports };
      if (artifact.stringPool) {
        providerImports.string_constants = buildStringConstants(artifact.stringPool);
        providerImports.string_constants16 = buildStringConstants16(artifact.stringPool);
      }
      for (const dependency of artifact.dependencies) {
        const dependencyExports = providerExports.get(dependency);
        if (!dependencyExports) return `missing provider dependency ${dependency}`;
        providerImports[dependency] = dependencyExports;
      }
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes(artifact.binary)), providerImports);
      providerExports.set(artifact.namespace, instance.exports);
    }
    const rootImports: WebAssembly.Imports = { ...baseImports };
    for (const artifact of artifacts) {
      const exports = providerExports.get(artifact.namespace);
      if (!exports) return `missing provider ${artifact.namespace}`;
      rootImports[artifact.namespace] = exports;
    }
    new WebAssembly.Instance(new WebAssembly.Module(wasmBytes(result.binary)), rootImports);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function topoPackages(packages: Map<string, PackageNode>): { order?: PackageNode[]; reason?: string } {
  const state = new Map<string, 0 | 1 | 2>();
  const order: PackageNode[] = [];
  function visit(root: string): boolean {
    const mark = state.get(root) ?? 0;
    if (mark === 1) return false;
    if (mark === 2) return true;
    state.set(root, 1);
    const node = packages.get(root);
    if (!node) return false;
    for (const dependency of node.dependencies) {
      if (!visit(dependency)) return false;
    }
    state.set(root, 2);
    order.push(node);
    return true;
  }
  for (const root of packages.keys()) {
    if (!visit(root)) return { reason: "cyclic npm package dependency graph" };
  }
  return { order };
}

/**
 * Attempt separate npm package compilation. The caller owns the bundled
 * fallback so that the existing compileProject route remains byte-stable for
 * unsupported graphs.
 */
export async function compileLinkedProject(input: PackageLinkInput): Promise<PackageLinkAttempt> {
  if (input.options.packageLinking === false) return { kind: "none" };

  const physicalByKey = new Map<string, string>();
  const sourceByPhysical = new Map<string, string>();
  for (const [physical, source] of input.allFiles) {
    const canonical = normalizePhysical(physical);
    sourceByPhysical.set(canonical, source);
    const key = input.fileKeys.get(physical) ?? input.fileKeys.get(canonical);
    if (key) physicalByKey.set(key, canonical);
  }
  const packageByFile = new Map<string, string>();
  const packages = new Map<string, PackageNode>();
  for (const physical of sourceByPhysical.keys()) {
    const root = packageRootFor(physical);
    if (!root) continue;
    packageByFile.set(physical, root);
    let node = packages.get(root);
    if (!node) {
      node = {
        root,
        name: packageNameForRoot(root),
        files: [],
        entry: physical,
        exports: new Map(),
        dependencies: new Set(),
        dependencyTargets: new Map(),
        externalImporters: [],
        entryTargets: new Set(),
      };
      packages.set(root, node);
    }
    node.files.push(physical);
  }
  if (packages.size === 0) return { kind: "none" };

  const bindings: ExternalBinding[] = [];
  for (const [importerKey, resolution] of Object.entries(input.projectResolutions)) {
    const importer = physicalByKey.get(importerKey);
    if (!importer) continue;
    const importerRoot = packageByFile.get(importer);
    for (const [specifier, targetKey] of Object.entries(resolution)) {
      const packageName = getBarePackageName(specifier);
      if (!packageName) continue;
      const target = physicalByKey.get(targetKey);
      if (!target) return makeFallback(`unresolved package target for ${specifier}`);
      const targetRoot = packageByFile.get(target);
      if (!targetRoot) return makeFallback(`package ${packageName} resolved outside node_modules`);
      const targetNode = packages.get(targetRoot);
      if (!targetNode) return makeFallback(`missing package node for ${packageName}`);
      if (importerRoot !== targetRoot) {
        targetNode.entryTargets.add(target);
        if (targetNode.entryTargets.size > 1)
          return makeFallback(`package ${packageName} has multiple entrypoint targets`);
        targetNode.entry = target;
      }
      if (importerRoot === targetRoot) continue;
      targetNode.externalImporters.push(importer);
      if (importerRoot) {
        const importerNode = packages.get(importerRoot);
        if (!importerNode) return makeFallback(`missing importer package for ${specifier}`);
        importerNode.dependencies.add(targetRoot);
        importerNode.dependencyTargets.set(packageName, targetRoot);
      }
      const source = sourceByPhysical.get(importer);
      if (!source) return makeFallback(`missing source for package importer ${importer}`);
      const sourceFile = parseSource(importer, source);
      const parsed = importBindings(sourceFile, specifier);
      if (parsed.unsupported) return makeFallback(parsed.unsupported);
      for (const binding of parsed.bindings ?? []) {
        bindings.push({
          importer,
          specifier,
          packageRoot: targetRoot,
          target,
          exportName: binding.exportName,
          localName: binding.localName,
        });
      }
    }
  }
  // A package only reached through a side-effect import still needs a stable
  // entry, and a missing entry cannot be instantiated safely.
  for (const node of packages.values()) {
    if (!sourceByPhysical.has(node.entry)) return makeFallback(`missing source for package ${node.name}`);
    const inspected = inspectFunctionExports(node.entry, sourceByPhysical.get(node.entry)!);
    if (!inspected.exports) return makeFallback(`${node.name}: ${inspected.reason ?? "unsupported exports"}`);
    node.exports = inspected.exports;
    (node as PackageNode & { sourceByFile?: Map<string, string> }).sourceByFile = sourceByPhysical;
  }
  const topo = topoPackages(packages);
  if (!topo.order) return makeFallback(topo.reason ?? "cyclic npm package dependency graph");

  // The first provider ABI is intentionally named-function-only. Reject name
  // collisions within one consumer module rather than mapping one local import
  // to the wrong provider (the old externals path silently did exactly that).
  const collisionCheck = new Map<string, string>();
  for (const binding of bindings) {
    const owner = packageByFile.get(binding.importer) ?? "<root>";
    const key = `${owner}:${binding.exportName}`;
    const previous = collisionCheck.get(key);
    if (previous && previous !== binding.packageRoot) {
      return makeFallback(`ambiguous imported export ${binding.exportName} in ${owner}`);
    }
    collisionCheck.set(key, binding.packageRoot);
    const targetNode = packages.get(binding.packageRoot)!;
    if (!targetNode.exports.has(binding.exportName)) {
      return makeFallback(`${targetNode.name} does not expose link-safe function ${binding.exportName}`);
    }
  }

  const cacheDir = input.options.packageCacheDir ?? path.join(input.rootDir, ".js2wasm-cache", "npm-modules");
  const namespaceByRoot = new Map<string, string>();
  const artifactByRoot = new Map<string, LinkedModuleArtifact>();
  let compiledProviders = 0;
  let cachedProviders = 0;

  // Resolve one package at a time in dependency order. Dependencies are
  // declaration-stubbed inside the provider and linked by the same namespace
  // metadata as the application root.
  for (const node of topo.order) {
    const dependencyKeys = Array.from(
      node.dependencies,
      (dependency) => artifactByRoot.get(dependency)?.cacheKey ?? "",
    );
    if (dependencyKeys.some((key) => !key)) return makeFallback(`provider dependency was not built for ${node.name}`);
    const sourceParts = node.files
      .slice()
      .sort()
      .map((file) => `${packageFileKey(node.root, file)}\n${sourceByPhysical.get(file) ?? ""}`);
    const exportNames = Array.from(node.exports.keys()).sort();
    const cacheKey = hashText([
      LINKER_VERSION,
      node.name,
      ...sourceParts,
      ...dependencyKeys,
      ...exportNames,
      compilerOptionFingerprint(input.options),
    ]);
    const namespace = providerNamespace(node, cacheKey);
    namespaceByRoot.set(node.root, namespace);
    const expectedSignatures = exportSignaturesFor(node);

    const cached = readCachedArtifact(cacheDir, cacheKey);
    if (
      cached &&
      exportNames.every((name) => cached.exports.includes(name)) &&
      exportNames.every((name) => cached.exportSignatures[name] === expectedSignatures[name])
    ) {
      cachedProviders++;
      artifactByRoot.set(node.root, {
        namespace,
        binary: cached.binary,
        cacheKey,
        dependencies: Array.from(node.dependencies, (dependency) => namespaceByRoot.get(dependency)!).filter(Boolean),
        exports: cached.exports,
        exportSignatures: cached.exportSignatures,
        packageName: node.name,
        cacheHit: true,
        stringPool: cached.stringPool,
      });
      continue;
    }

    const providerFiles: Record<string, string> = {};
    const providerResolutions: ProjectModuleResolutions = {};
    const providerKeyByPhysical = new Map<string, string>();
    for (const file of node.files) {
      const key = packageFileKey(node.root, file);
      providerKeyByPhysical.set(file, key);
      providerFiles[key] = sourceByPhysical.get(file)!;
    }
    const dependencyBindings = new Map<string, { module: string; field: string }>();
    for (const binding of bindings.filter((candidate) => packageByFile.get(candidate.importer) === node.root)) {
      const dependencyNamespace = namespaceByRoot.get(binding.packageRoot);
      if (!dependencyNamespace) return makeFallback(`missing dependency namespace for ${node.name}`);
      dependencyBindings.set(binding.exportName, { module: dependencyNamespace, field: binding.exportName });
    }
    // Preserve relative edges inside the provider and replace bare dependency
    // edges with declaration-only stubs. The original resolver map is exact,
    // including pnpm's nested node_modules paths.
    for (const file of node.files) {
      const originalKey = input.fileKeys.get(file);
      if (!originalKey) continue;
      const resolutions = input.projectResolutions[originalKey];
      if (!resolutions) continue;
      const providerKey = providerKeyByPhysical.get(file)!;
      for (const [specifier, targetKey] of Object.entries(resolutions)) {
        const target = physicalByKey.get(targetKey);
        if (!target) continue;
        const targetRoot = packageByFile.get(target);
        if (!targetRoot) {
          providerResolutions[providerKey] ??= {};
          providerResolutions[providerKey][specifier] = targetKey;
          continue;
        }
        if (targetRoot === node.root) {
          providerResolutions[providerKey] ??= {};
          providerResolutions[providerKey][specifier] = providerKeyByPhysical.get(target)!;
        } else {
          const depNode = packages.get(targetRoot)!;
          const stubKey = `./__js2wasm_linked_${hashText([depNode.name, targetRoot]).slice(0, 12)}.d.ts`;
          providerFiles[stubKey] = buildDeclarationStub(depNode);
          providerResolutions[providerKey] ??= {};
          providerResolutions[providerKey][specifier] = stubKey;
        }
      }
    }
    const providerOptions: CompileOptions = {
      ...input.options,
      packageLinking: false,
      packageCacheDir: undefined,
      link: [...new Set([...(input.options.link ?? []), ...Array.from(dependencyBindings.values(), (v) => v.module)])],
      linkedPackageBindings: dependencyBindings,
    };
    const providerResult = await compileMultiSource(
      providerFiles,
      packageFileKey(node.root, node.entry),
      providerOptions,
      undefined,
      providerResolutions,
    );
    if (!providerResult.success) return makeFallback(`${node.name} provider compilation failed`);
    if (providerResult.hasTopLevelStatements) {
      return makeFallback(`${node.name} provider has unsupported top-level initialization`);
    }
    let providerExports: WebAssembly.ModuleExportDescriptor[];
    try {
      providerExports = WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes(providerResult.binary)));
    } catch {
      return makeFallback(`${node.name} provider emitted invalid Wasm`);
    }
    const actualExportNames = providerExports.filter((entry) => entry.kind === "function").map((entry) => entry.name);
    if (!exportNames.every((name) => actualExportNames.includes(name))) {
      return makeFallback(`${node.name} provider did not export its declared function boundary`);
    }
    const allowedProviderModules = new Set([
      ...(input.options.link ?? []),
      ...Array.from(dependencyBindings.values(), (binding) => binding.module),
    ]);
    const providerImportModules = new WebAssembly.Module(wasmBytes(providerResult.binary));
    const unsupportedImport = WebAssembly.Module.imports(providerImportModules).find(
      (entry) => !allowedProviderModules.has(entry.module),
    );
    if (unsupportedImport) {
      // Host calls need a lifecycle-aware adapter. Provider-owned string globals
      // are structural data and can be rebuilt from the artifact string pool.
      if (
        unsupportedImport &&
        unsupportedImport.module !== "string_constants" &&
        unsupportedImport.module !== "string_constants16"
      ) {
        return makeFallback(`${node.name} provider requires unsupported import ${unsupportedImport.module}`);
      }
    }
    compiledProviders++;
    memoryProviderCache.set(cacheKey, {
      binary: providerResult.binary,
      exports: actualExportNames,
      exportSignatures: expectedSignatures,
      stringPool: providerResult.stringPool,
    });
    writeCachedArtifact(
      cacheDir,
      cacheKey,
      providerResult.binary,
      actualExportNames,
      expectedSignatures,
      providerResult.stringPool,
    );
    artifactByRoot.set(node.root, {
      namespace,
      binary: providerResult.binary,
      cacheKey,
      dependencies: Array.from(node.dependencies, (dependency) => namespaceByRoot.get(dependency)!).filter(Boolean),
      exports: actualExportNames,
      exportSignatures: expectedSignatures,
      packageName: node.name,
      cacheHit: false,
      stringPool: providerResult.stringPool,
    });
  }

  const rootBindings = new Map<string, { module: string; field: string }>();
  const rootFiles: Record<string, string> = {};
  for (const [physical, source] of sourceByPhysical) {
    if (packageByFile.has(physical)) continue;
    const key = input.fileKeys.get(physical);
    if (key) rootFiles[key] = source;
  }
  const rootResolutions: ProjectModuleResolutions = {};
  for (const [importerKey, resolution] of Object.entries(input.projectResolutions)) {
    const importer = physicalByKey.get(importerKey);
    if (!importer || packageByFile.has(importer)) continue;
    const rewritten: Record<string, string> = {};
    for (const [specifier, targetKey] of Object.entries(resolution)) {
      const target = physicalByKey.get(targetKey);
      if (!target) continue;
      const targetRoot = packageByFile.get(target);
      if (!targetRoot) {
        rewritten[specifier] = targetKey;
        continue;
      }
      const targetNode = packages.get(targetRoot)!;
      const stubKey = `./__js2wasm_linked_${hashText([targetNode.name, targetRoot]).slice(0, 12)}.d.ts`;
      rootFiles[stubKey] = buildDeclarationStub(targetNode);
      rewritten[specifier] = stubKey;
      const source = sourceByPhysical.get(importer);
      if (!source) continue;
      const parsed = importBindings(parseSource(importer, source), specifier);
      if (parsed.unsupported) return makeFallback(parsed.unsupported);
      const namespace = namespaceByRoot.get(targetRoot);
      if (!namespace) return makeFallback(`missing root provider namespace for ${targetNode.name}`);
      for (const binding of parsed.bindings ?? []) {
        if (!targetNode.exports.has(binding.exportName)) {
          return makeFallback(`${targetNode.name} does not expose ${binding.exportName}`);
        }
        const existing = rootBindings.get(binding.exportName);
        if (existing && existing.module !== namespace) {
          return makeFallback(`ambiguous root package export ${binding.exportName}`);
        }
        rootBindings.set(binding.exportName, { module: namespace, field: binding.exportName });
      }
    }
    if (Object.keys(rewritten).length > 0) rootResolutions[importerKey] = rewritten;
  }

  const rootOptions: CompileOptions = {
    ...input.options,
    packageLinking: false,
    packageCacheDir: undefined,
    link: [...new Set([...(input.options.link ?? []), ...Array.from(rootBindings.values(), (v) => v.module)])],
    linkedPackageBindings: rootBindings,
  };
  const result = await compileMultiSource(rootFiles, input.entryKey, rootOptions, undefined, rootResolutions);
  if (!result.success) return makeFallback("linked root compilation failed; using bundled project");
  const artifacts = topo.order.map((node) => artifactByRoot.get(node.root)!).filter(Boolean);
  const signatureFailure = validateLinkedSignatures(result, artifacts);
  if (signatureFailure) return makeFallback(`linked signature validation failed: ${signatureFailure}`);
  const plan: PackageLinkPlan = {
    mode: "separate",
    version: 1,
    namespaces: artifacts.map((artifact) => artifact.namespace),
    compiledProviders,
    cachedProviders,
  };
  return { kind: "separate", result, artifacts, plan };
}
