// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Namespace-import lowering for the multi-file compile paths.
 *
 * `import * as ns from "./mod.js"` had no binding at all on `compileMulti` /
 * `compileProject`: the alias pass in `generateMultiModule` deliberately skips
 * namespace imports ("resolves to a module object, not a single binding"), so
 * `ns` reached codegen unbound and every `ns.member(...)` lowered to a dynamic
 * `__extern_method_call` on a `ref.null extern` receiver — a runtime
 * "Cannot read properties of null". Named imports of the very same module link
 * fine, because the alias pass copies the target's `funcMap`/`moduleGlobals`
 * entry onto the local name.
 *
 * So this pass rewrites the namespace form into the named form that already
 * works, but only when the module is part of the compiled graph:
 *
 *   import * as cookie from "./index.js";   →   /* padded to same length *\/
 *   cookie.parseCookie(str)                 →   cookie$parseCookie(str)
 *   …and, appended at end of file:
 *   import { parseCookie as cookie$parseCookie } from "./index.js";
 *
 * An external/host specifier (`node:*`, a bare package left out of the graph)
 * is untouched — that is the module-object-handle work in #4422, and binding it
 * to a named import here would only move the failure.
 *
 * ## Offset stability
 *
 * Like `foldGroundCallsInMulti`, every in-place replacement is exactly the same
 * byte length as the text it replaces (`ns.member` → `ns$member` + padding
 * spaces; the import statement → a same-length block comment), and the
 * generated named imports are APPENDED after the original end of file. No
 * pre-existing source offset moves, so diagnostics and source maps need no new
 * position-map segment.
 */
import {
  type ProjectModuleResolutions,
  buildBareSpecifierLookup,
  buildProjectModuleResolutionLookup,
  multiFileScriptKind,
  normalizeMultiFileName,
  resolveMultiFileModule,
} from "./checker/multi-file-paths.js";
import { ts } from "./ts-api.js";

/** Bounded `export * from` chain depth while collecting a module's exports. */
const MAX_STAR_EXPORT_DEPTH = 8;

/** One `ns.member` → `ns$member` substitution, in original-source offsets. */
interface MemberReplacement {
  start: number;
  end: number;
  alias: string;
}

/** A namespace import that survived every gate and will be lowered. */
interface NamespacePlan {
  /** `import * as ns …` statement range, replaced by a same-length comment. */
  statementStart: number;
  statementEnd: number;
  /** Module specifier text, reused verbatim by the generated named import. */
  specifier: string;
  /** `member` → alias local name. */
  aliases: Map<string, string>;
  replacements: MemberReplacement[];
}

function collectIdentifierTexts(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
  return names;
}

/**
 * Every name the file binds somewhere OTHER than the namespace imports
 * themselves. A namespace whose name is rebound anywhere in the file is left
 * alone: `ns.member` inside a scope where `ns` is a local would otherwise be
 * rewritten to the module's export, silently changing what the code reads.
 */
function collectShadowingNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      bindingNames(node.name, names);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      names.add(node.name.text);
    } else if (node.kind === ts.SyntaxKind.CatchClause) {
      const variable = (node as ts.CatchClause).variableDeclaration;
      if (variable) bindingNames(variable.name, names);
    } else if (ts.isImportClause(node) && node.name) {
      names.add(node.name.text);
    } else if (ts.isImportSpecifier(node)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
  return names;
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
  );
}

/**
 * The export names a module provides, or `undefined` when the set cannot be
 * established (an unresolvable `export * from`, or a module whose exports are
 * not statically visible). Callers treat "unknown" as "do not rewrite" — a
 * named import of a member the module does not export would turn today's
 * silent null into a hard resolution error.
 */
function collectExportNames(
  fileKey: string,
  parse: (key: string) => ts.SourceFile | undefined,
  resolve: (specifier: string, importer: string) => string | undefined,
  depth: number,
  seen: Set<string>,
): Set<string> | undefined {
  if (depth > MAX_STAR_EXPORT_DEPTH || seen.has(fileKey)) return undefined;
  seen.add(fileKey);
  const sourceFile = parse(fileKey);
  if (!sourceFile) return undefined;

  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) names.add(element.name.text);
        continue;
      }
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        names.add(stmt.exportClause.name.text);
        continue;
      }
      // `export * from "…"` — follow it, or give up on the whole set.
      const specifier =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
      const target = specifier === undefined ? undefined : resolve(specifier, fileKey);
      if (target === undefined) return undefined;
      const nested = collectExportNames(target, parse, resolve, depth + 1, seen);
      if (nested === undefined) return undefined;
      for (const name of nested) names.add(name);
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      names.add("default");
      continue;
    }
    if (!hasExportModifier(stmt)) continue;
    if (hasDefaultModifier(stmt)) names.add("default");
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) bindingNames(decl.name, names);
      continue;
    }
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name !== undefined &&
      ts.isIdentifier(stmt.name)
    ) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/**
 * Pick a same-length local name for `ns.member`. `$` keeps the byte count
 * identical to the `.` it replaces, which is what makes the whole rewrite
 * offset-preserving; `_` is the fallback when `$` would shadow a real binding.
 */
function chooseAlias(namespaceName: string, member: string, taken: ReadonlySet<string>): string | undefined {
  for (const separator of ["$", "_"]) {
    const candidate = `${namespaceName}${separator}${member}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
}

/** Same-length block comment standing in for a rewritten import statement. */
function commentFiller(width: number): string | undefined {
  if (width < 4) return undefined;
  return `/*${" ".repeat(width - 4)}*/`;
}

function planFile(
  sourceFile: ts.SourceFile,
  fileKey: string,
  resolve: (specifier: string, importer: string) => string | undefined,
  exportsOf: (key: string) => Set<string> | undefined,
): NamespacePlan[] {
  const declared = new Map<string, ts.ImportDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const namedBindings = stmt.importClause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) declared.set(namedBindings.name.text, stmt);
  }
  if (declared.size === 0) return [];

  const members = new Map<string, Map<string, MemberReplacement[]>>();
  const rejected = new Set<string>();
  const shadowing = collectShadowingNames(sourceFile);
  for (const name of declared.keys()) {
    members.set(name, new Map());
    if (shadowing.has(name)) rejected.add(name);
  }

  const noteUse = (namespaceName: string, member: string, node: ts.Node): void => {
    const perMember = members.get(namespaceName)!;
    const list = perMember.get(member) ?? [];
    list.push({ start: node.getStart(sourceFile), end: node.end, alias: "" });
    perMember.set(member, list);
  };

  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && declared.has(node.text)) {
      const parent = node.parent;
      if (parent !== undefined && ts.isNamespaceImport(parent) && parent.name === node) {
        // The declaration itself.
      } else if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (ts.isIdentifier(parent.name)) noteUse(node.text, parent.name.text, parent);
        else rejected.add(node.text);
      } else if (parent !== undefined && ts.isQualifiedName(parent) && parent.left === node) {
        noteUse(node.text, parent.right.text, parent);
      } else {
        // `ns` used as a value (passed, re-exported, `ns[key]`, `typeof ns`).
        // Only a real module object satisfies those; leave the import alone.
        rejected.add(node.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);

  const taken = collectIdentifierTexts(sourceFile);
  const plans: NamespacePlan[] = [];
  for (const [namespaceName, stmt] of declared) {
    if (rejected.has(namespaceName)) continue;
    const perMember = members.get(namespaceName)!;
    if (perMember.size === 0) continue;
    const specifier = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
    if (specifier === undefined) continue;
    const target = resolve(specifier, fileKey);
    if (target === undefined) continue; // external/host module — #4422 territory.
    const exported = exportsOf(target);
    if (exported === undefined) continue;

    const statementStart = stmt.getStart(sourceFile);
    const statementEnd = stmt.end;
    if (commentFiller(statementEnd - statementStart) === undefined) continue;
    if (sourceFile.text.slice(statementStart, statementEnd).includes("*/")) continue;

    const aliases = new Map<string, string>();
    const replacements: MemberReplacement[] = [];
    let usable = true;
    for (const [member, uses] of perMember) {
      if (!exported.has(member)) {
        usable = false;
        break;
      }
      const alias = chooseAlias(namespaceName, member, taken);
      if (alias === undefined) {
        usable = false;
        break;
      }
      taken.add(alias);
      aliases.set(member, alias);
      for (const use of uses) {
        if (use.end - use.start < alias.length) {
          usable = false;
          break;
        }
        replacements.push({ ...use, alias });
      }
      if (!usable) break;
    }
    if (!usable) continue;
    plans.push({
      statementStart,
      statementEnd,
      specifier,
      aliases,
      replacements,
    });
  }
  return plans;
}

function applyPlans(source: string, plans: readonly NamespacePlan[]): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  for (const plan of plans) {
    edits.push({
      start: plan.statementStart,
      end: plan.statementEnd,
      text: commentFiller(plan.statementEnd - plan.statementStart)!,
    });
    for (const replacement of plan.replacements) {
      edits.push({
        start: replacement.start,
        end: replacement.end,
        text: replacement.alias.padEnd(replacement.end - replacement.start),
      });
    }
    const clause = [...plan.aliases].map(([member, alias]) => `${member} as ${alias}`).join(", ");
    appended.push(`import { ${clause} } from ${JSON.stringify(plan.specifier)};`);
  }
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return `${out}\n${appended.join("\n")}\n`;
}

/**
 * Lower every in-graph `import * as ns` in a multi-file program to the named
 * imports the linker already resolves. Files without such an import — the
 * overwhelming majority — are returned untouched and are never even parsed.
 */
export function rewriteMultiNamespaceImports(
  files: Record<string, string>,
  projectResolutions?: ProjectModuleResolutions,
  specifierMap?: Record<string, string>,
): Record<string, string> {
  const candidates = Object.entries(files).filter(([, source]) => /import\s*\*\s*as\s/.test(source));
  if (candidates.length === 0) return files;

  const normalized = new Map<string, string>();
  const keyOfNormalized = new Map<string, string>();
  for (const [key, source] of Object.entries(files)) {
    const normalizedKey = normalizeMultiFileName(key);
    normalized.set(normalizedKey, source);
    keyOfNormalized.set(normalizedKey, key);
  }
  const bareSpecifierLookup = buildBareSpecifierLookup(normalized, specifierMap);
  const projectResolutionLookup = buildProjectModuleResolutionLookup(projectResolutions);

  const parsed = new Map<string, ts.SourceFile | undefined>();
  const parse = (key: string): ts.SourceFile | undefined => {
    if (parsed.has(key)) return parsed.get(key);
    const source = normalized.get(key);
    const sourceFile =
      source === undefined
        ? undefined
        : ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true, multiFileScriptKind(key));
    parsed.set(key, sourceFile);
    return sourceFile;
  };
  const resolve = (specifier: string, importer: string): string | undefined =>
    resolveMultiFileModule(specifier, importer, normalized, bareSpecifierLookup, projectResolutionLookup)
      ?.resolvedFileName;
  const exportCache = new Map<string, Set<string> | undefined>();
  const exportsOf = (key: string): Set<string> | undefined => {
    if (exportCache.has(key)) return exportCache.get(key);
    const names = collectExportNames(key, parse, resolve, 0, new Set());
    exportCache.set(key, names);
    return names;
  };

  const rewritten: Record<string, string> = { ...files };
  let changed = false;
  for (const [key] of candidates) {
    const normalizedKey = normalizeMultiFileName(key);
    const sourceFile = parse(normalizedKey);
    if (!sourceFile) continue;
    const plans = planFile(sourceFile, normalizedKey, resolve, exportsOf);
    if (plans.length === 0) continue;
    rewritten[key] = applyPlans(sourceFile.text, plans);
    changed = true;
  }
  return changed ? rewritten : files;
}
