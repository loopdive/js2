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
import type {
  CompileOptions,
  CompileResult,
  LinkedModuleArtifact,
  LinkedProviderMetadata,
  PackageLinkPlan,
} from "./index.js";
import { compileMultiSource } from "./compiler.js";
import type { ProjectModuleResolutions } from "./checker/index.js";
import { getBarePackageName } from "./resolve.js";
import { getDefaultEnvironment } from "./env.js";
import { buildCompiledImports } from "./runtime.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "./emit/canonical-recgroup.js";
import {
  appendProviderManifest,
  decodeProviderManifest,
  providerArtifactHash,
  PROVIDER_COMPILER_ABI_VERSION,
  PROVIDER_MANIFEST_FORMAT_VERSION,
  PROVIDER_MANIFEST_SECTION_NAME,
  PROVIDER_LINKER_ABI_VERSION,
  type ProviderDependencyManifest,
  type ProviderManifestV1,
} from "./provider-manifest.js";

const LINKER_VERSION = PROVIDER_LINKER_ABI_VERSION;
// The generated entry facade is part of the provider ABI. Bump this when its
// source shape changes so an old provider cannot be reused with new wrappers.
const PROVIDER_FACADE_ABI_VERSION = 3;
const LINKED_DEFAULT_DECLARATION = "__js2wasm_default";

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
  /** Physical source file containing the declaration (aliases may cross files). */
  sourceFile: string;
  /** A missing/any/unknown annotation requires engine signature validation. */
  uncertain: boolean;
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
  requiresSignatureValidation: boolean;
}

interface ExternalBinding {
  importer: string;
  specifier: string;
  packageRoot: string;
  target: string;
  exportName: string;
  localName: string;
}

function linkedBindingLookupNames(binding: Pick<ExternalBinding, "exportName" | "localName">): string[] {
  if (binding.exportName !== "default") return [binding.exportName];
  // The declaration stub gives default imports a legal stable function name;
  // different codegen paths key the import by that declaration name or by the
  // source-level local alias. Keep all spellings pointed at one Wasm field.
  return ["default", LINKED_DEFAULT_DECLARATION, binding.localName];
}

interface CachedProvider {
  binary: Uint8Array;
  exports: string[];
  exportSignatures: Record<string, string>;
  manifest: ProviderManifestV1;
}

// The disk cache is the cross-process boundary; this in-process cache also
// makes repeated benchmark consumers in one worker provably compile each
// provider once even when their entry files live under different directories.
const memoryProviderCache = new Map<string, CachedProvider>();

/** @internal Test seam for exercising disk-cache recovery and tamper rejection. */
export function clearPackageProviderMemoryCacheForTests(): void {
  memoryProviderCache.clear();
}

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
  // A declaration-only facade cannot spell `declare function default`. Keep a
  // stable private name; buildDeclarationStub publishes that name and aliases
  // it to the default slot. The compiler's default-import path can then be
  // rewritten to the same deterministic local declaration when needed.
  if (exported.name === "default") {
    return `export declare function ${LINKED_DEFAULT_DECLARATION}${typeParameters}(${parameters}): ${returnType};`;
  }
  return `export declare function ${exported.name}${typeParameters}(${parameters}): ${returnType};`;
}

type BoundaryTypeState = "safe" | "uncertain" | "unsupported";

function primitiveTypeState(node: ts.TypeNode | undefined): BoundaryTypeState {
  // JS sources and explicit any/unknown declarations are provisionally
  // accepted. Their actual Wasm type is checked by the engine after the
  // provider and consumer binaries are connected.
  if (!node || node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
    return "uncertain";
  }
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return "safe";
    case ts.SyntaxKind.ParenthesizedType:
      return primitiveTypeState((node as ts.ParenthesizedTypeNode).type);
    case ts.SyntaxKind.LiteralType: {
      const literal = (node as ts.LiteralTypeNode).literal;
      return ts.isStringLiteral(literal) ||
        ts.isNumericLiteral(literal) ||
        literal.kind === ts.SyntaxKind.TrueKeyword ||
        literal.kind === ts.SyntaxKind.FalseKeyword
        ? "safe"
        : "unsupported";
    }
    default:
      return "unsupported";
  }
}

function primitiveFunctionState(declaration: ts.FunctionDeclaration): BoundaryTypeState {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return "unsupported";
  const states = [
    primitiveTypeState(declaration.type),
    ...declaration.parameters.map((parameter) => primitiveTypeState(parameter.type)),
  ];
  if (states.includes("unsupported")) return "unsupported";
  return states.includes("uncertain") ? "uncertain" : "safe";
}

type ExportResolution = { kind: "function"; exported: FunctionExport } | { kind: "unsupported"; reason: string };

interface PackageExportAnalysis {
  exports: Map<string, ExportResolution>;
  cycle?: boolean;
}

interface PackageExportAnalyzer {
  node: PackageNode;
  sourceByPhysical: Map<string, string>;
  physicalByKey: Map<string, string>;
  packageByFile: Map<string, string>;
  fileKeys: Map<string, string>;
  projectResolutions: ProjectModuleResolutions;
}

function unsupportedExport(reason: string): ExportResolution {
  return { kind: "unsupported", reason };
}

function cloneFunctionExport(exported: FunctionExport, name: string): FunctionExport {
  return { ...exported, name };
}

function localDeclarationMaps(
  fileName: string,
  sourceFile: ts.SourceFile,
): {
  functions: Map<string, ExportResolution>;
  values: Map<string, ExportResolution>;
  defaultExport?: ExportResolution;
} {
  const functions = new Map<string, ExportResolution>();
  const values = new Map<string, ExportResolution>();
  let defaultExport: ExportResolution | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) {
        const state = primitiveFunctionState(statement);
        functions.set(
          statement.name.text,
          state === "unsupported"
            ? unsupportedExport("package function has a non-primitive ABI signature")
            : {
                kind: "function",
                exported: {
                  name: statement.name.text,
                  declaration: statement,
                  sourceFile: fileName,
                  uncertain: state === "uncertain",
                },
              },
        );
      }
      if (isDefault(statement)) {
        const state = primitiveFunctionState(statement);
        defaultExport =
          state === "unsupported"
            ? unsupportedExport("default function has a non-primitive ABI signature")
            : {
                kind: "function",
                exported: {
                  name: "default",
                  declaration: statement,
                  sourceFile: fileName,
                  uncertain: state === "uncertain",
                },
              };
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        if (name) values.set(name, unsupportedExport("package exports a value boundary"));
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      if (statement.name) values.set(statement.name.text, unsupportedExport("package exports a class boundary"));
      if (isDefault(statement)) defaultExport = unsupportedExport("package exports a class boundary");
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      values.set(statement.name.text, unsupportedExport("package exports an enum boundary"));
    }
  }
  return { functions, values, defaultExport };
}

function packageResolvedTarget(
  analyzer: PackageExportAnalyzer,
  fileName: string,
  specifier: string,
): string | undefined {
  const key = analyzer.fileKeys.get(fileName);
  const targetKey = key ? analyzer.projectResolutions[key]?.[specifier] : undefined;
  if (!targetKey) return undefined;
  const target = analyzer.physicalByKey.get(targetKey);
  if (!target || analyzer.packageByFile.get(target) !== analyzer.node.root) return undefined;
  return target;
}

function resolveLocalExport(locals: ReturnType<typeof localDeclarationMaps>, name: string): ExportResolution {
  return (
    locals.functions.get(name) ?? locals.values.get(name) ?? unsupportedExport(`package export ${name} is not defined`)
  );
}

/**
 * Analyze a package's exact relative export graph. Unsupported declarations
 * are retained as named resolutions rather than poisoning the whole package;
 * only a binding that crosses the package boundary decides whether linking is
 * safe. This is what lets `export class Box` coexist with a linkable `add`.
 */
function analyzePackageExports(analyzer: PackageExportAnalyzer): PackageExportAnalysis {
  const cache = new Map<string, PackageExportAnalysis>();
  const visiting = new Set<string>();

  function analyzeFile(fileName: string): PackageExportAnalysis {
    const cached = cache.get(fileName);
    if (cached) return cached;
    if (visiting.has(fileName)) return { exports: new Map(), cycle: true };
    visiting.add(fileName);
    const source = analyzer.sourceByPhysical.get(fileName);
    if (source === undefined) {
      const missing = { exports: new Map<string, ExportResolution>(), cycle: true };
      visiting.delete(fileName);
      cache.set(fileName, missing);
      return missing;
    }
    const sourceFile = parseSource(fileName, source);
    const locals = localDeclarationMaps(fileName, sourceFile);
    const exports = new Map<string, ExportResolution>();
    const explicitExports = new Set<string>();
    let cycle = false;

    const publish = (name: string, resolution: ExportResolution, fromExportStar = false): void => {
      // Explicit exports win over `export *` collisions, matching ESM's
      // deterministic surface. A duplicate explicit export is conservatively
      // marked unsupported rather than selecting one arbitrarily.
      const previous = exports.get(name);
      if (!previous) {
        exports.set(name, resolution);
        if (!fromExportStar) explicitExports.add(name);
      } else if (fromExportStar && explicitExports.has(name)) {
        return;
      } else if (!fromExportStar && !explicitExports.has(name)) {
        exports.set(name, resolution);
        explicitExports.add(name);
      } else {
        const sameFunction =
          previous.kind === "function" &&
          resolution.kind === "function" &&
          previous.exported.sourceFile === resolution.exported.sourceFile &&
          previous.exported.declaration === resolution.exported.declaration;
        if (!sameFunction) exports.set(name, unsupportedExport(`ambiguous re-export ${name}`));
      }
    };

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        if (isDefault(statement)) {
          const resolution = locals.defaultExport ?? unsupportedExport("default function export is unavailable");
          publish("default", resolution);
        } else if (statement.name) {
          publish(
            statement.name.text,
            locals.functions.get(statement.name.text) ?? unsupportedExport("function export unavailable"),
          );
        }
        continue;
      }
      if (isExported(statement) && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            publish(
              declaration.name.text,
              locals.values.get(declaration.name.text) ?? unsupportedExport("value export unavailable"),
            );
          }
        }
        continue;
      }
      if (isExported(statement) && ts.isClassDeclaration(statement)) {
        const name = isDefault(statement) ? "default" : statement.name?.text;
        if (name) publish(name, unsupportedExport("package exports a class boundary"));
        continue;
      }
      if (isExported(statement) && ts.isEnumDeclaration(statement)) {
        publish(statement.name.text, unsupportedExport("package exports an enum boundary"));
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) {
          publish("default", unsupportedExport("CommonJS export assignment is not link-safe"));
        } else if (ts.isIdentifier(statement.expression)) {
          publish("default", resolveLocalExport(locals, statement.expression.text));
        } else {
          publish("default", unsupportedExport("default value expression is not link-safe"));
        }
        continue;
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (!statement.moduleSpecifier) {
        if (!clause || !ts.isNamedExports(clause)) continue;
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const sourceName = element.propertyName?.text ?? element.name.text;
          publish(element.name.text, resolveLocalExport(locals, sourceName));
        }
        continue;
      }
      const target = ts.isStringLiteral(statement.moduleSpecifier)
        ? packageResolvedTarget(analyzer, fileName, statement.moduleSpecifier.text)
        : undefined;
      if (!target) {
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (!element.isTypeOnly)
              publish(element.name.text, unsupportedExport("re-export target is outside package graph"));
          }
        } else if (clause && ts.isNamespaceExport(clause)) {
          publish(clause.name.text, unsupportedExport("namespace re-export is not link-safe"));
        }
        continue;
      }
      const targetAnalysis = analyzeFile(target);
      cycle ||= targetAnalysis.cycle === true;
      if (!clause) {
        for (const [name, resolution] of targetAnalysis.exports) {
          if (name !== "default") publish(name, resolution, true);
        }
      } else if (ts.isNamespaceExport(clause)) {
        publish(clause.name.text, unsupportedExport("namespace re-export is not link-safe"));
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const sourceName = element.propertyName?.text ?? element.name.text;
          publish(
            element.name.text,
            targetAnalysis.exports.get(sourceName) ??
              unsupportedExport(`re-exported export ${sourceName} is unavailable`),
          );
        }
      }
    }
    const analysis = { exports, ...(cycle ? { cycle: true } : {}) };
    visiting.delete(fileName);
    cache.set(fileName, analysis);
    return analysis;
  }

  return analyzeFile(analyzer.node.entry);
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

/**
 * The regular codegen path treats a declaration-file default import as a
 * module global rather than a callable function. Provider stubs expose a
 * stable named alias as well, so rewrite only linked default imports to that
 * alias while leaving the user's source untouched on the bundled fallback.
 */
function rewriteLinkedDefaultImports(fileName: string, source: string, linkedSpecifiers: ReadonlySet<string>): string {
  if (linkedSpecifiers.size === 0) return source;
  const sourceFile = parseSource(fileName, source);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    if (!statement.importClause.name || !linkedSpecifiers.has(statement.moduleSpecifier.text)) continue;
    const defaultName = statement.importClause.name.text;
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && !ts.isNamedImports(namedBindings)) continue;
    const named =
      namedBindings && ts.isNamedImports(namedBindings)
        ? namedBindings.elements.map((element) => element.getText(sourceFile))
        : [];
    const imports = [`${LINKED_DEFAULT_DECLARATION} as ${defaultName}`, ...named].join(", ");
    replacements.push({
      start: statement.getStart(sourceFile),
      end: statement.end,
      text: `import { ${imports} } from ${statement.moduleSpecifier.getText(sourceFile)};`,
    });
  }
  let rewritten = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.text}${rewritten.slice(replacement.end)}`;
  }
  return rewritten;
}

function declarationSourceFile(node: PackageNode, exported: FunctionExport): ts.SourceFile {
  const source = nodeSource(node, exported.sourceFile);
  return parseSource(exported.sourceFile, source);
}

function buildDeclarationStub(node: PackageNode): string {
  const declarations = Array.from(node.exports.values(), (exported) =>
    functionSignature(exported, declarationSourceFile(node, exported)),
  );
  if (node.exports.has("default")) declarations.push(`export { ${LINKED_DEFAULT_DECLARATION} as default };`);
  return `${declarations.join("\n")}\n`;
}

function exportSignaturesFor(node: PackageNode): Record<string, string> {
  return Object.fromEntries(
    Array.from(node.exports.values(), (exported) => [
      exported.name,
      functionSignature(exported, declarationSourceFile(node, exported)),
    ]),
  );
}

interface ProviderFacade {
  key: string;
  source: string;
}

function buildProviderFacade(node: PackageNode): ProviderFacade | undefined {
  const lines = [
    "// Generated by js2wasm package linker; the original package entry remains the source of truth.",
    "// Facade ABI: 1",
  ];
  const wrappers: string[] = [];
  const entrySpecifier = "./__js2wasm_provider_entry";
  const ordered = Array.from(node.exports.values()).sort((a, b) => a.name.localeCompare(b.name));
  for (const [index, exported] of ordered.entries()) {
    const sourceFile = declarationSourceFile(node, exported);
    const fn = exported.declaration;
    const params: string[] = [];
    const args: string[] = [];
    for (const parameter of fn.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.name.text === "this") return undefined;
      const parameterText = parameter.getText(sourceFile);
      params.push(parameterText);
      args.push(parameter.dotDotDotToken ? `...${parameter.name.text}` : parameter.name.text);
    }
    const sourceBinding = `__js2wasm_provider_source_${index}`;
    const wrapper = `__js2wasm_provider_export_${index}`;
    const importedName = exported.name === "default" ? "default" : exported.name;
    if (!/^[$A-Z_a-z][$\w]*$/.test(importedName)) return undefined;
    lines.push(`import { ${importedName} as ${sourceBinding} } from "${entrySpecifier}";`);
    const typeParameters = fn.typeParameters
      ? `<${fn.typeParameters.map((parameter) => parameter.getText(sourceFile)).join(", ")}>`
      : "";
    const returnType = fn.type?.getText(sourceFile) ?? "any";
    lines.push(
      `export function ${wrapper}${typeParameters}(${params.join(", ")}): ${returnType} { return ${sourceBinding}(${args.join(", ")}); }`,
    );
    wrappers.push(`export { ${wrapper} as ${exported.name === "default" ? "default" : exported.name} };`);
  }
  lines.push(...wrappers);
  return { key: "./__js2wasm_provider_facade.ts", source: `${lines.join("\n")}\n` };
}

function providerMetadata(result: CompileResult): LinkedProviderMetadata {
  return {
    imports: result.imports,
    stringPool: result.stringPool,
    targetProfile: result.targetProfile,
    adapterManifest: result.adapterManifest,
    capabilityRequirements: result.capabilityRequirements,
    capabilityProviderDiagnostics: result.capabilityProviderDiagnostics,
    exportBoundaryPolicies: result.exportBoundaryPolicies,
  };
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

function cachePaths(cacheDir: string, cacheKey: string): { wasm: string } {
  return { wasm: path.join(cacheDir, `${cacheKey}.wasm`) };
}

function cacheIndexPath(cacheDir: string, sourceFingerprint: string): string {
  return path.join(cacheDir, `${sourceFingerprint}.ref.json`);
}

interface ProviderCacheExpectation {
  sourceFingerprint: string;
  packageName: string;
  dependencies: readonly ProviderDependencyManifest[];
  exports: readonly string[];
  exportSignatures: Readonly<Record<string, string>>;
}

function manifestMatchesExpectation(manifest: ProviderManifestV1, expected: ProviderCacheExpectation): boolean {
  if (manifest.sourceFingerprint !== expected.sourceFingerprint || manifest.packageName !== expected.packageName)
    return false;
  if (
    manifest.exports.length !== expected.exports.length ||
    manifest.exports.some((name, i) => name !== expected.exports[i])
  ) {
    return false;
  }
  if (
    manifest.dependencies.length !== expected.dependencies.length ||
    manifest.dependencies.some((dependency, index) => {
      const candidate = expected.dependencies[index];
      return (
        !candidate ||
        dependency.packageName !== candidate.packageName ||
        dependency.cacheKey !== candidate.cacheKey ||
        dependency.namespace !== candidate.namespace
      );
    })
  ) {
    return false;
  }
  const expectedSignatures = expected.exportSignatures;
  const actualSignatureNames = Object.keys(manifest.exportSignatures);
  const expectedSignatureNames = Object.keys(expectedSignatures);
  return (
    actualSignatureNames.length === expectedSignatureNames.length &&
    expectedSignatureNames.every((name) => manifest.exportSignatures[name] === expectedSignatures[name])
  );
}

function decodeCachedProvider(binary: Uint8Array, fileKey: string): CachedProvider | undefined {
  try {
    // The custom section is the authority. A filename or optional JSON index
    // may only nominate a candidate; neither is trusted until the embedded
    // manifest, Wasm validator, and final-byte content hash agree.
    new WebAssembly.Module(wasmBytes(binary));
    const manifest = decodeProviderManifest(binary, {
      linkerAbiVersion: LINKER_VERSION,
      compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
      recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
    });
    const derivedKey = providerArtifactHash(binary, manifest);
    if (fileKey && derivedKey !== fileKey) return undefined;
    return {
      binary,
      exports: manifest.exports,
      exportSignatures: manifest.exportSignatures,
      manifest,
    };
  } catch {
    return undefined;
  }
}

function readCachedArtifact(
  cacheDir: string,
  expected: ProviderCacheExpectation,
): (CachedProvider & { cacheKey: string }) | undefined {
  const fs = getDefaultEnvironment().fs;
  const tryMemory = (): (CachedProvider & { cacheKey: string }) | undefined => {
    for (const [cacheKey, memory] of memoryProviderCache) {
      if (!manifestMatchesExpectation(memory.manifest, expected)) continue;
      if (providerArtifactHash(memory.binary, memory.manifest) !== cacheKey) continue;
      return { ...memory, cacheKey };
    }
    return undefined;
  };

  if (fs) {
    const indexedKeys: string[] = [];
    try {
      for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        const name = entry.name;
        if (!name.endsWith(".ref.json")) continue;
        try {
          const index = JSON.parse(fs.readFileSync(path.join(cacheDir, name), "utf8")) as {
            version?: string;
            cacheKey?: string;
            sourceFingerprint?: string;
          };
          if (
            index.version === LINKER_VERSION &&
            index.sourceFingerprint === expected.sourceFingerprint &&
            typeof index.cacheKey === "string"
          ) {
            indexedKeys.push(index.cacheKey);
          }
        } catch {
          // An optional index is never authoritative; malformed entries are
          // ignored and the Wasm directory scan below can still recover.
        }
      }
    } catch {
      // The cache directory may not exist yet.
    }

    const tried = new Set<string>();
    const tryDiskKey = (cacheKey: string): (CachedProvider & { cacheKey: string }) | undefined => {
      if (tried.has(cacheKey)) return undefined;
      tried.add(cacheKey);
      try {
        const binary = new Uint8Array(fs.readFileSync(cachePaths(cacheDir, cacheKey).wasm));
        const candidate = decodeCachedProvider(binary, cacheKey);
        if (!candidate || !manifestMatchesExpectation(candidate.manifest, expected)) return undefined;
        return { ...candidate, cacheKey };
      } catch {
        return undefined;
      }
    };

    for (const cacheKey of indexedKeys) {
      const candidate = tryDiskKey(cacheKey);
      if (candidate) return candidate;
    }

    // Sidecars are optional indexes. If one is absent, stale, or tampered,
    // recover by scanning provider Wasm files and trusting only their embedded
    // manifests and derived content hashes.
    try {
      for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        const name = entry.name;
        if (!name.endsWith(".wasm")) continue;
        const cacheKey = name.slice(0, -5);
        const candidate = tryDiskKey(cacheKey);
        if (candidate) return candidate;
      }
    } catch {
      // A missing/read-only cache is an optimization miss.
    }
  }

  // Browser embedders have no filesystem; Node also gets this fallback when a
  // cache directory is unavailable. Memory entries still carry decoded
  // manifests and are independently hash-checked above.
  return tryMemory();
}

function writeCachedArtifact(
  cacheDir: string,
  cacheKey: string,
  binary: Uint8Array,
  manifest: ProviderManifestV1,
): void {
  const fs = getDefaultEnvironment().fs;
  if (!fs) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const paths = cachePaths(cacheDir, cacheKey);
    fs.writeFileSync(paths.wasm, binary);
    // Optional lookup index only. Provider metadata, exports, signatures, and
    // all ABI checks come from the embedded custom section on cache load.
    fs.writeFileSync(
      cacheIndexPath(cacheDir, manifest.sourceFingerprint),
      JSON.stringify({ version: LINKER_VERSION, cacheKey, sourceFingerprint: manifest.sourceFingerprint }, null, 2),
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
 * Build the adapter imports from the provider's frozen metadata while doing
 * compile-time signature validation.  Reusing the root adapter here is
 * incorrect: a package may use a host helper (for example number formatting)
 * that the consumer does not import.  In that case the root env object has no
 * such field and validation would downgrade an otherwise link-safe graph to a
 * bundled build.  This function only constructs wrappers; deferred provider
 * initialization is deliberately not invoked by the validation path.
 */
function buildProviderValidationImports(artifact: LinkedModuleArtifact): WebAssembly.Imports {
  const metadata = artifact.providerMetadata;
  if (!metadata) throw new Error(`linked provider ${artifact.namespace} has no adapter metadata`);
  const providerResult = {
    binary: artifact.binary,
    wat: "",
    dts: "",
    importsHelper: "",
    success: true,
    errors: [],
    stringPool: metadata.stringPool,
    imports: metadata.imports,
    hasMain: false,
    hasTopLevelStatements: artifact.initExport !== undefined,
    targetProfile: metadata.targetProfile,
    adapterManifest: metadata.adapterManifest,
    capabilityRequirements: metadata.capabilityRequirements,
    capabilityProviderDiagnostics: metadata.capabilityProviderDiagnostics,
    exportBoundaryPolicies: metadata.exportBoundaryPolicies,
  } as CompileResult;
  const built = buildCompiledImports(providerResult);
  return {
    env: built.env,
    "wasm:js-string": built["wasm:js-string"],
    string_constants: built.string_constants,
    string_constants16: built.string_constants16,
  } as unknown as WebAssembly.Imports;
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
      const providerImports = buildProviderValidationImports(artifact);
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
        requiresSignatureValidation: false,
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
  // Analyze the package's complete relative export graph, then retain only
  // the names that an actual consumer imports. Unsupported values/classes in
  // an otherwise useful package are therefore harmless until requested.
  for (const node of packages.values()) {
    if (!sourceByPhysical.has(node.entry)) return makeFallback(`missing source for package ${node.name}`);
    (node as PackageNode & { sourceByFile?: Map<string, string> }).sourceByFile = sourceByPhysical;
    const analysis = analyzePackageExports({
      node,
      sourceByPhysical,
      physicalByKey,
      packageByFile,
      fileKeys: input.fileKeys,
      projectResolutions: input.projectResolutions,
    });
    if (analysis.cycle) return makeFallback(`${node.name}: cyclic relative export graph`);
    const requested = new Set(
      bindings.filter((binding) => binding.packageRoot === node.root).map((binding) => binding.exportName),
    );
    if (requested.size === 0) return makeFallback(`${node.name}: package has no named function boundary`);
    node.exports = new Map();
    for (const name of requested) {
      const resolution = analysis.exports.get(name);
      if (!resolution) return makeFallback(`${node.name} does not expose ${name}`);
      if (resolution.kind === "unsupported") return makeFallback(`${node.name}: ${resolution.reason}`);
      node.exports.set(name, cloneFunctionExport(resolution.exported, name));
    }
    node.requiresSignatureValidation = Array.from(node.exports.values()).some((entry) => entry.uncertain);
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
    const dependencyIdentities: ProviderDependencyManifest[] = Array.from(node.dependencies, (dependency) => {
      const dependencyNode = packages.get(dependency);
      const dependencyArtifact = artifactByRoot.get(dependency);
      const dependencyNamespace = namespaceByRoot.get(dependency);
      if (!dependencyNode || !dependencyArtifact || !dependencyNamespace) {
        return undefined;
      }
      return {
        packageName: dependencyNode.name,
        cacheKey: dependencyArtifact.cacheKey,
        namespace: dependencyNamespace,
      };
    }).filter((identity): identity is ProviderDependencyManifest => identity !== undefined);
    if (dependencyIdentities.length !== node.dependencies.size) {
      return makeFallback(`provider dependency was not built for ${node.name}`);
    }
    dependencyIdentities.sort(
      (a, b) => a.packageName.localeCompare(b.packageName) || a.cacheKey.localeCompare(b.cacheKey),
    );
    const sourceParts = node.files
      .slice()
      .sort()
      .map((file) => `${packageFileKey(node.root, file)}\n${sourceByPhysical.get(file) ?? ""}`);
    const exportNames = Array.from(node.exports.keys()).sort();
    const expectedSignatures = exportSignaturesFor(node);
    const sourceFingerprint = hashText([
      LINKER_VERSION,
      PROVIDER_COMPILER_ABI_VERSION,
      String(RUNTIME_RECGROUP_ABI_VERSION),
      node.name,
      ...sourceParts,
      ...dependencyIdentities.flatMap((dependency) => [dependency.packageName, dependency.cacheKey]),
      ...exportNames,
      String(PROVIDER_FACADE_ABI_VERSION),
      compilerOptionFingerprint(input.options),
    ]);

    const cached = readCachedArtifact(cacheDir, {
      sourceFingerprint,
      packageName: node.name,
      dependencies: dependencyIdentities,
      exports: exportNames,
      exportSignatures: expectedSignatures,
    });
    if (cached) {
      const cacheKey = cached.cacheKey;
      const namespace = providerNamespace(node, cacheKey);
      namespaceByRoot.set(node.root, namespace);
      cachedProviders++;
      artifactByRoot.set(node.root, {
        namespace,
        binary: cached.binary,
        cacheKey,
        dependencies: cached.manifest.dependencies.map((dependency) => dependency.namespace),
        exports: cached.manifest.exports,
        exportSignatures: cached.manifest.exportSignatures,
        packageName: node.name,
        cacheHit: true,
        stringPool: cached.manifest.stringPool,
        providerMetadata: cached.manifest.providerMetadata,
        initExport: cached.manifest.initExport,
      });
      continue;
    }

    const providerFiles: Record<string, string> = {};
    const providerResolutions: ProjectModuleResolutions = {};
    const providerKeyByPhysical = new Map<string, string>();
    for (const file of node.files) {
      const key = packageFileKey(node.root, file);
      providerKeyByPhysical.set(file, key);
      const linkedDefaultSpecifiers = new Set(
        bindings
          .filter((binding) => binding.importer === file && binding.exportName === "default")
          .map((binding) => binding.specifier),
      );
      providerFiles[key] = rewriteLinkedDefaultImports(file, sourceByPhysical.get(file)!, linkedDefaultSpecifiers);
    }
    const facade = buildProviderFacade(node);
    if (!facade) return makeFallback(`${node.name} export cannot be represented by the function facade`);
    const providerEntryKey = packageFileKey(node.root, node.entry);
    providerFiles[facade.key] = facade.source;
    providerResolutions[facade.key] = { "./__js2wasm_provider_entry": providerEntryKey };
    const dependencyBindings = new Map<string, { module: string; field: string }>();
    for (const binding of bindings.filter((candidate) => packageByFile.get(candidate.importer) === node.root)) {
      const dependencyNamespace = namespaceByRoot.get(binding.packageRoot);
      if (!dependencyNamespace) return makeFallback(`missing dependency namespace for ${node.name}`);
      for (const lookupName of linkedBindingLookupNames(binding)) {
        dependencyBindings.set(lookupName, { module: dependencyNamespace, field: binding.exportName });
      }
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
      // Provider module initialization is exported and invoked only after its
      // own host adapter has been wired to its own instance.
      deferTopLevelInit: true,
      link: [...new Set([...(input.options.link ?? []), ...Array.from(dependencyBindings.values(), (v) => v.module)])],
      linkedPackageBindings: dependencyBindings,
    };
    const providerResult = await compileMultiSource(
      providerFiles,
      facade.key,
      providerOptions,
      undefined,
      providerResolutions,
    );
    if (!providerResult.success) return makeFallback(`${node.name} provider compilation failed`);
    let providerExports: WebAssembly.ModuleExportDescriptor[];
    try {
      providerExports = WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes(providerResult.binary)));
    } catch {
      return makeFallback(`${node.name} provider emitted invalid Wasm`);
    }
    const actualFunctionNames = providerExports.filter((entry) => entry.kind === "function").map((entry) => entry.name);
    if (!exportNames.every((name) => actualFunctionNames.includes(name))) {
      return makeFallback(`${node.name} provider did not export its declared function boundary`);
    }
    const actualExportNames = exportNames.slice();
    const initExport = providerExports.some((entry) => entry.kind === "function" && entry.name === "__module_init")
      ? "__module_init"
      : undefined;
    // A provider must not run its initializer during validation and then run
    // it again (or never run it) during real linking.  The deferred export is
    // unavailable for WASI, whose startup contract is `_start`; retain the
    // safe bundled route for that target until provider startup can be wired
    // through its own lifecycle as well.
    if (providerResult.hasTopLevelStatements && !initExport) {
      return makeFallback(`${node.name} provider initialization cannot be deferred for this target`);
    }
    const allowedProviderModules = new Set([
      "env",
      "wasm:js-string",
      "string_constants",
      "string_constants16",
      ...(input.options.link ?? []),
      ...Array.from(dependencyBindings.values(), (binding) => binding.module),
    ]);
    const providerImportModules = new WebAssembly.Module(wasmBytes(providerResult.binary));
    const unsupportedImport = WebAssembly.Module.imports(providerImportModules).find(
      (entry) => !allowedProviderModules.has(entry.module),
    );
    if (unsupportedImport)
      return makeFallback(`${node.name} provider requires unsupported import ${unsupportedImport.module}`);
    const metadata = providerMetadata(providerResult);
    const rawManifest: ProviderManifestV1 = {
      section: PROVIDER_MANIFEST_SECTION_NAME,
      version: PROVIDER_MANIFEST_FORMAT_VERSION,
      compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
      linkerAbiVersion: LINKER_VERSION,
      recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
      sourceFingerprint,
      packageName: node.name,
      dependencies: dependencyIdentities,
      exports: actualExportNames,
      exportSignatures: expectedSignatures,
      ...(initExport === undefined ? {} : { initExport }),
      stringPool: providerResult.stringPool,
      providerMetadata: metadata,
    };
    let finalBinary: Uint8Array;
    let manifest: ProviderManifestV1;
    try {
      finalBinary = appendProviderManifest(providerResult.binary, rawManifest);
      manifest = decodeProviderManifest(finalBinary, {
        linkerAbiVersion: LINKER_VERSION,
        compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
        recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
      });
      // Custom sections are ignored by validation, so explicitly validate the
      // finalized bytes before making them visible as a provider artifact.
      new WebAssembly.Module(wasmBytes(finalBinary));
    } catch (error) {
      return makeFallback(
        `${node.name} provider manifest emission failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const cacheKey = providerArtifactHash(finalBinary, manifest);
    const namespace = providerNamespace(node, cacheKey);
    namespaceByRoot.set(node.root, namespace);
    compiledProviders++;
    memoryProviderCache.set(cacheKey, {
      binary: finalBinary,
      exports: manifest.exports,
      exportSignatures: manifest.exportSignatures,
      manifest,
    });
    writeCachedArtifact(cacheDir, cacheKey, finalBinary, manifest);
    artifactByRoot.set(node.root, {
      namespace,
      binary: finalBinary,
      cacheKey,
      dependencies: manifest.dependencies.map((dependency) => dependency.namespace),
      exports: manifest.exports,
      exportSignatures: manifest.exportSignatures,
      packageName: node.name,
      cacheHit: false,
      stringPool: manifest.stringPool,
      providerMetadata: manifest.providerMetadata,
      initExport: manifest.initExport,
    });
  }

  const rootBindings = new Map<string, { module: string; field: string }>();
  const rootFiles: Record<string, string> = {};
  for (const [physical, source] of sourceByPhysical) {
    if (packageByFile.has(physical)) continue;
    const key = input.fileKeys.get(physical);
    if (key) {
      const linkedDefaultSpecifiers = new Set(
        bindings
          .filter((binding) => binding.importer === physical && binding.exportName === "default")
          .map((binding) => binding.specifier),
      );
      rootFiles[key] = rewriteLinkedDefaultImports(physical, source, linkedDefaultSpecifiers);
    }
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
        const externalBinding: ExternalBinding = {
          importer,
          specifier,
          packageRoot: targetRoot,
          target,
          exportName: binding.exportName,
          localName: binding.localName,
        };
        for (const lookupName of linkedBindingLookupNames(externalBinding)) {
          const existing = rootBindings.get(lookupName);
          if (existing && existing.module !== namespace) {
            return makeFallback(`ambiguous root package export ${binding.exportName}`);
          }
          rootBindings.set(lookupName, { module: namespace, field: binding.exportName });
        }
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
  if (topo.order.some((node) => node.requiresSignatureValidation) && result.hasTopLevelStatements) {
    return makeFallback("inferred/any package signatures require side-effect-free engine validation");
  }
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
