// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import * as path from "path";
import { rewriteCjsRequire } from "../cjs-rewrite.js";
import { ts } from "../ts-api.js";

type Demand = Set<string> | null;

interface ResolverLike {
  canonicalize(filePath: string): string;
  resolve(specifier: string, containingFile: string): string | null;
}

interface ModuleInfo {
  path: string;
  baseContent: string;
  baseSourceFile: ts.SourceFile;
  content: string;
  sourceFile: ts.SourceFile;
  pureBarrel: boolean;
}

interface ExportSurface {
  names: Set<string>;
  complete: boolean;
}

interface ImportBinding {
  specifier: string;
  demand: Demand;
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function mergeDemand(current: Demand | undefined, incoming: Demand): { demand: Demand; changed: boolean } {
  if (current === null) return { demand: null, changed: false };
  if (incoming === null) return { demand: null, changed: current !== null };
  if (current === undefined) return { demand: new Set(incoming), changed: true };
  let changed = false;
  const merged = new Set(current);
  for (const name of incoming) {
    if (!merged.has(name)) {
      merged.add(name);
      changed = true;
    }
  }
  return { demand: merged, changed };
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) => modifier.kind === kind) ?? false
  );
}

function directExportNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  if (ts.isExportAssignment(statement)) {
    if (!statement.isExportEquals) names.add("default");
    return names;
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
      names.add(statement.exportClause.name.text);
    }
    return names;
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return names;
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    names.add("default");
    return names;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    if (ts.isIdentifier(statement.name) || ts.isStringLiteral(statement.name)) names.add(statement.name.text);
    return names;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
  }
  return names;
}

function isPureBarrel(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.every((statement) => {
    if (ts.isExportDeclaration(statement)) return true;
    // A side-effect-only import is observable and therefore disqualifies the
    // module. Binding imports are allowed because a pure barrel can re-export
    // an imported namespace or binding (`import * as x; export { x }`).
    return ts.isImportDeclaration(statement) && statement.importClause !== undefined;
  });
}

function namespaceImportDemand(
  sourceFile: ts.SourceFile,
  declaration: ts.ImportDeclaration,
  localName: string,
): Demand {
  const names = new Set<string>();
  let dynamicUse = false;
  const visit = (node: ts.Node): void => {
    if (dynamicUse || node === declaration) return;
    if (ts.isIdentifier(node) && node.text === localName) {
      let expression: ts.Expression = node;
      while (
        (ts.isParenthesizedExpression(expression.parent) ||
          ts.isAsExpression(expression.parent) ||
          ts.isTypeAssertionExpression(expression.parent) ||
          ts.isNonNullExpression(expression.parent) ||
          ts.isSatisfiesExpression(expression.parent)) &&
        expression.parent.expression === expression
      ) {
        expression = expression.parent;
      }
      const parent = expression.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
        names.add(parent.name.text);
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === expression) {
        const key = parent.argumentExpression;
        if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          names.add(key.text);
          return;
        }
        dynamicUse = true;
        return;
      }
      if (ts.isQualifiedName(parent) && parent.left === node) {
        names.add(parent.right.text);
        return;
      }
      // Passing the namespace as a value, dynamically indexing it, or
      // shadowing its name makes the requested export surface unknowable.
      dynamicUse = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dynamicUse ? null : names;
}

function namedImportBindingDemand(
  sourceFile: ts.SourceFile,
  declaration: ts.ImportDeclaration,
  localName: string,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  let wholeBinding = false;
  const visit = (node: ts.Node): void => {
    if (wholeBinding || node === declaration) return;
    if (ts.isIdentifier(node) && node.text === localName) {
      let expression: ts.Node = node;
      while (
        (ts.isParenthesizedExpression(expression.parent) ||
          ts.isAsExpression(expression.parent) ||
          ts.isTypeAssertionExpression(expression.parent) ||
          ts.isNonNullExpression(expression.parent) ||
          ts.isSatisfiesExpression(expression.parent)) &&
        expression.parent.expression === expression
      ) {
        expression = expression.parent;
      }
      const parent = expression.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
        names.add(`${importedName}.${parent.name.text}`);
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === expression) {
        const key = parent.argumentExpression;
        if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          names.add(`${importedName}.${key.text}`);
          return;
        }
      } else if (ts.isQualifiedName(parent) && parent.left === node) {
        names.add(`${importedName}.${parent.right.text}`);
        return;
      }
      wholeBinding = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return wholeBinding ? new Set([importedName]) : names;
}

function importDemand(statement: ts.ImportDeclaration, sourceFile: ts.SourceFile): Demand {
  const clause = statement.importClause;
  if (!clause) return null;
  const names = new Set<string>();
  if (clause.name) names.add("default");
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      return namespaceImportDemand(sourceFile, statement, clause.namedBindings.name.text);
    }
    for (const element of clause.namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      for (const name of namedImportBindingDemand(sourceFile, statement, element.name.text, importedName)) {
        names.add(name);
      }
    }
  }
  return names;
}

function namespaceMemberNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    if (ts.isIdentifier(statement.name) || ts.isStringLiteral(statement.name)) names.add(statement.name.text);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
  }
  return names;
}

function blankPreservingLines(source: string): string {
  return source.replace(/[^\r\n]/g, " ");
}

function preserveLineCount(original: string, replacement: string): string {
  const originalBreaks = original.match(/\r\n|\r|\n/g) ?? [];
  const replacementBreaks = replacement.match(/\r\n|\r|\n/g)?.length ?? 0;
  return replacement + originalBreaks.slice(replacementBreaks).join("");
}

function importedBindingIsUsed(
  sourceFile: ts.SourceFile,
  declaration: ts.ImportDeclaration,
  localName: string,
): boolean {
  let used = false;
  const visit = (node: ts.Node): void => {
    if (used || node === declaration) return;
    if (ts.isIdentifier(node) && node.text === localName) {
      used = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return used;
}

function pruneUnusedImports(source: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    const defaultName =
      clause.name && importedBindingIsUsed(sourceFile, statement, clause.name.text) ? clause.name.text : undefined;
    let namedText: string | undefined;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      if (importedBindingIsUsed(sourceFile, statement, clause.namedBindings.name.text)) {
        namedText = `* as ${clause.namedBindings.name.text}`;
      }
    } else if (clause.namedBindings) {
      const elements = clause.namedBindings.elements.filter((element) =>
        importedBindingIsUsed(sourceFile, statement, element.name.text),
      );
      if (elements.length > 0) {
        namedText = `{ ${elements
          .map((element) => {
            const imported = element.propertyName ? `${element.propertyName.text} as ` : "";
            return `${element.isTypeOnly ? "type " : ""}${imported}${element.name.text}`;
          })
          .join(", ")} }`;
      }
    }
    const bindings = [defaultName, namedText].filter((part): part is string => part !== undefined);
    const start = statement.getStart(sourceFile);
    const end = statement.getEnd();
    if (bindings.length === 0) {
      replacements.push({ start, end, text: blankPreservingLines(source.slice(start, end)) });
      continue;
    }
    const moduleText = statement.moduleSpecifier.getText(sourceFile);
    const suffix = source.slice(statement.moduleSpecifier.end, end);
    const replacement = `import ${clause.isTypeOnly ? "type " : ""}${bindings.join(", ")} from ${moduleText}${suffix}`;
    replacements.push({
      start,
      end,
      text: preserveLineCount(source.slice(start, end), replacement),
    });
  }
  let rewritten = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  return rewritten;
}

function specializeNamespaceBody(
  source: string,
  sourceFile: ts.SourceFile,
  declaration: ts.ModuleDeclaration,
  roots: ReadonlySet<string>,
): string {
  if (!declaration.body || !ts.isModuleBlock(declaration.body)) return source;
  const ownerByName = new Map<string, ts.Statement>();
  const removable = new Set<ts.Statement>();
  for (const statement of declaration.body.statements) {
    const names = namespaceMemberNames(statement);
    if (names.size === 0) continue;
    for (const name of names) ownerByName.set(name, statement);
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      removable.add(statement);
    }
  }
  const live = new Set<ts.Statement>();
  const queue: ts.Statement[] = [];
  for (const root of roots) {
    const statement = ownerByName.get(root);
    if (statement && !live.has(statement)) {
      live.add(statement);
      queue.push(statement);
    }
  }
  while (queue.length > 0) {
    const statement = queue.shift()!;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const dependency = ownerByName.get(node.text);
        if (dependency && !live.has(dependency)) {
          live.add(dependency);
          queue.push(dependency);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  let specialized = source;
  const dead = Array.from(removable).filter((statement) => !live.has(statement));
  for (const statement of dead.sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))) {
    const start = statement.getStart(sourceFile);
    const end = statement.getEnd();
    specialized =
      specialized.slice(0, start) + blankPreservingLines(specialized.slice(start, end)) + specialized.slice(end);
  }
  return specialized;
}

function baseModuleView(info: ModuleInfo): ModuleInfo {
  if (info.content === info.baseContent && info.sourceFile === info.baseSourceFile) return info;
  return { ...info, content: info.baseContent, sourceFile: info.baseSourceFile };
}

function specializeModuleForDemand(info: ModuleInfo, demand: ReadonlySet<string>): ModuleInfo {
  const ownerByName = new Map<string, Set<ts.Statement>>();
  const removable = new Set<ts.Statement>();
  for (const statement of info.baseSourceFile.statements) {
    for (const name of namespaceMemberNames(statement)) {
      let owners = ownerByName.get(name);
      if (!owners) {
        owners = new Set();
        ownerByName.set(name, owners);
      }
      owners.add(statement);
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      removable.add(statement);
    }
  }

  // `export { local as public }` exposes the local declaration under another
  // name. Thread external demand back to the declaration owner.
  for (const statement of info.baseSourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const localName = (element.propertyName ?? element.name).text;
      const owners = ownerByName.get(localName);
      if (owners) ownerByName.set(element.name.text, owners);
    }
  }

  const live = new Set<ts.Statement>();
  const queue: ts.Statement[] = [];
  const namespaceRoots = new Map<ts.ModuleDeclaration, Set<string>>();
  const wholeNamespaces = new Set<ts.ModuleDeclaration>();
  const mark = (statement: ts.Statement): void => {
    if (live.has(statement)) return;
    live.add(statement);
    queue.push(statement);
  };
  const noteNamespaceUse = (statement: ts.Statement, path: string | null): void => {
    if (!ts.isModuleDeclaration(statement)) return;
    if (path === null) {
      wholeNamespaces.add(statement);
      return;
    }
    let roots = namespaceRoots.get(statement);
    if (!roots) {
      roots = new Set();
      namespaceRoots.set(statement, roots);
    }
    roots.add(path.split(".", 1)[0]);
  };

  let foundExternalRoot = false;
  for (const requested of demand) {
    const [topLevelName, ...memberPath] = requested.split(".");
    const owners = ownerByName.get(topLevelName);
    if (!owners) continue;
    foundExternalRoot = true;
    for (const owner of owners) {
      mark(owner);
      noteNamespaceUse(owner, memberPath.length > 0 ? memberPath.join(".") : null);
    }
  }
  if (!foundExternalRoot) return baseModuleView(info);

  // Observable non-declaration module-initialization statements stay roots.
  // Imports and re-exports are handled separately by graph expansion; the
  // opt-in mode's contract lets unreachable declaration bodies be omitted.
  for (const statement of info.baseSourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isEmptyStatement(statement) ||
      removable.has(statement)
    ) {
      continue;
    }
    mark(statement);
  }

  while (queue.length > 0) {
    const statement = queue.shift()!;
    if (ts.isModuleDeclaration(statement) && namespaceRoots.has(statement) && !wholeNamespaces.has(statement)) {
      // The namespace member pass below traces only the demanded member roots.
      // Walking the unspecialized namespace here would make any internal
      // `Namespace[key]` access look like a dynamic use of the whole namespace
      // and defeat the specialization before it runs.
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const owners = ownerByName.get(node.text);
        if (owners) {
          const isDeclarationName =
            owners.has(statement) &&
            (ts.isFunctionDeclaration(statement) ||
              ts.isClassDeclaration(statement) ||
              ts.isInterfaceDeclaration(statement) ||
              ts.isTypeAliasDeclaration(statement) ||
              ts.isEnumDeclaration(statement) ||
              ts.isModuleDeclaration(statement)) &&
            statement.name === node;
          const isPropertyName =
            (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
            (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
            (ts.isMethodDeclaration(node.parent) && node.parent.name === node);
          if (!isDeclarationName && !isPropertyName) {
            for (const owner of owners) {
              mark(owner);
              if (ts.isModuleDeclaration(owner)) {
                if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
                  noteNamespaceUse(owner, node.parent.name.text);
                } else if (ts.isQualifiedName(node.parent) && node.parent.left === node) {
                  noteNamespaceUse(owner, node.parent.right.text);
                } else {
                  noteNamespaceUse(owner, null);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }

  let content = info.baseContent;
  for (const [namespace, roots] of namespaceRoots) {
    if (!wholeNamespaces.has(namespace) && live.has(namespace) && roots.size > 0) {
      content = specializeNamespaceBody(content, info.baseSourceFile, namespace, roots);
    }
  }
  const dead = Array.from(removable).filter((statement) => !live.has(statement));
  for (const statement of dead.sort(
    (left, right) => right.getStart(info.baseSourceFile) - left.getStart(info.baseSourceFile),
  )) {
    const start = statement.getStart(info.baseSourceFile);
    const end = statement.getEnd();
    content = content.slice(0, start) + blankPreservingLines(content.slice(start, end)) + content.slice(end);
  }
  content = pruneUnusedImports(content, info.path);
  if (content === info.content) return info;
  return {
    ...info,
    content,
    sourceFile: ts.createSourceFile(info.path, content, ts.ScriptTarget.Latest, true, scriptKind(info.path)),
  };
}

function localImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { specifier, demand: new Set(["default"]) });
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, { specifier, demand: null });
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      bindings.set(element.name.text, {
        specifier,
        demand: new Set([(element.propertyName ?? element.name).text]),
      });
    }
  }
  return bindings;
}

function staticRequireSpecifiers(statement: ts.Statement): Set<string> {
  const specifiers = new Set<string>();
  if (!ts.isVariableStatement(statement)) return specifiers;
  const scan = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      specifiers.add(node.arguments[0].text);
      return;
    }
    ts.forEachChild(node, scan);
  };
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.initializer) scan(declaration.initializer);
  }
  return specifiers;
}

function jsdocImportSpecifiers(content: string): Set<string> {
  const specifiers = new Set<string>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    for (const match of comment.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]);
    for (const match of comment.matchAll(/@import[^\r\n]*?\bfrom\s+["']([^"']+)["']/g)) specifiers.add(match[1]);
  }
  return specifiers;
}

/**
 * Resolve a module graph while expanding declaration-free barrels from the
 * exact named bindings requested by their consumers.
 *
 * The caller opts into the assumption that unused import/re-export targets and
 * unreachable declaration bodies are side-effect-free. Unknown export
 * surfaces and dynamic namespace consumers are retained instead of guessed
 * away.
 */
export function resolveConsumerDrivenImports(
  entryFile: string,
  resolver: ResolverLike,
  readSource: (filePath: string) => string | undefined,
): Map<string, string> {
  const modules = new Map<string, ModuleInfo>();
  const demands = new Map<string, Demand>();
  const selectedEdges = new Map<string, Map<string, Demand>>();
  const exportSurfaceCache = new Map<string, ExportSurface>();
  const exportSurfaceStack = new Set<string>();
  const queue: string[] = [];

  const load = (filePath: string): ModuleInfo | undefined => {
    const canonicalPath = resolver.canonicalize(filePath);
    const cached = modules.get(canonicalPath);
    if (cached) return cached;
    const original = readSource(canonicalPath);
    if (original === undefined) return undefined;
    const content = rewriteCjsRequire(original);
    const sourceFile = ts.createSourceFile(
      canonicalPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(canonicalPath),
    );
    const info = {
      path: canonicalPath,
      baseContent: content,
      baseSourceFile: sourceFile,
      content,
      sourceFile,
      pureBarrel: isPureBarrel(sourceFile),
    };
    modules.set(canonicalPath, info);
    return info;
  };

  const exportSurface = (filePath: string): ExportSurface => {
    const canonicalPath = resolver.canonicalize(filePath);
    const cached = exportSurfaceCache.get(canonicalPath);
    if (cached) return cached;
    if (exportSurfaceStack.has(canonicalPath)) return { names: new Set(), complete: false };
    const info = load(canonicalPath);
    if (!info) return { names: new Set(), complete: false };
    exportSurfaceStack.add(canonicalPath);
    const names = new Set<string>();
    let complete = true;
    for (const statement of info.baseSourceFile.statements) {
      for (const name of directExportNames(statement)) names.add(name);
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause !== undefined ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = resolver.resolve(statement.moduleSpecifier.text, canonicalPath);
      if (!target) {
        complete = false;
        continue;
      }
      const nested = exportSurface(target);
      for (const name of nested.names) if (name !== "default") names.add(name);
      complete &&= nested.complete;
    }
    exportSurfaceStack.delete(canonicalPath);
    const surface = { names, complete };
    exportSurfaceCache.set(canonicalPath, surface);
    return surface;
  };

  const enqueue = (filePath: string, incoming: Demand): void => {
    const canonicalPath = resolver.canonicalize(filePath);
    const merged = mergeDemand(demands.get(canonicalPath), incoming);
    if (!merged.changed) return;
    demands.set(canonicalPath, merged.demand);
    queue.push(canonicalPath);
  };

  const addEdge = (from: string, specifier: string, demand: Demand): void => {
    const target = resolver.resolve(specifier, from);
    if (!target) return;
    const canonicalTarget = resolver.canonicalize(target);
    let edges = selectedEdges.get(from);
    if (!edges) {
      edges = new Map();
      selectedEdges.set(from, edges);
    }
    const merged = mergeDemand(edges.get(canonicalTarget), demand);
    edges.set(canonicalTarget, merged.demand);
    enqueue(canonicalTarget, demand);
  };

  const expandWholeModule = (info: ModuleInfo): void => {
    for (const statement of info.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        addEdge(info.path, statement.moduleSpecifier.text, importDemand(statement, info.sourceFile));
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        // A non-barrel re-export is evaluated for its side effects regardless
        // of which binding the current consumer reads.
        addEdge(info.path, statement.moduleSpecifier.text, null);
      }
      for (const specifier of staticRequireSpecifiers(statement)) addEdge(info.path, specifier, null);
    }
    for (const specifier of jsdocImportSpecifiers(info.content)) addEdge(info.path, specifier, null);
  };

  const expandBarrel = (info: ModuleInfo, demand: Set<string>): void => {
    const importedLocals = localImportBindings(info.sourceFile);
    const remapDemand = (exportedName: string, sourceName = exportedName): Set<string> => {
      const remapped = new Set<string>();
      const prefix = `${exportedName}.`;
      for (const requested of demand) {
        if (requested === exportedName) remapped.add(sourceName);
        else if (requested.startsWith(prefix)) remapped.add(`${sourceName}${requested.slice(exportedName.length)}`);
      }
      return remapped;
    };
    const importedDemand = (localName: string, requested: ReadonlySet<string>, binding: ImportBinding): Demand => {
      if (binding.demand === null) return null;
      const importedName = binding.demand.values().next().value;
      if (importedName === undefined) return new Set();
      const prefix = `${localName}.`;
      return new Set(
        Array.from(requested, (name) =>
          name === localName
            ? importedName
            : name.startsWith(prefix)
              ? `${importedName}${name.slice(localName.length)}`
              : name,
        ),
      );
    };
    for (const statement of info.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const moduleSpecifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const sourceName = (element.propertyName ?? element.name).text;
          const requested = remapDemand(element.name.text, sourceName);
          if (requested.size === 0) continue;
          if (moduleSpecifier) {
            addEdge(info.path, moduleSpecifier, requested);
          } else {
            const imported = importedLocals.get(sourceName);
            if (imported) {
              addEdge(info.path, imported.specifier, importedDemand(sourceName, requested, imported));
            }
          }
        }
        continue;
      }
      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        if (moduleSpecifier) {
          const namespaceName = statement.exportClause.name.text;
          const requested = remapDemand(namespaceName);
          if (requested.has(namespaceName)) addEdge(info.path, moduleSpecifier, null);
          else if (requested.size > 0) {
            addEdge(
              info.path,
              moduleSpecifier,
              new Set(Array.from(requested, (name) => name.slice(namespaceName.length + 1))),
            );
          }
        }
        continue;
      }
      if (!moduleSpecifier) continue;
      const target = resolver.resolve(moduleSpecifier, info.path);
      if (!target) continue;
      const surface = exportSurface(target);
      const required = new Set<string>();
      for (const name of demand) {
        const topLevelName = name.split(".", 1)[0];
        if (topLevelName !== "default" && surface.names.has(topLevelName)) required.add(name);
      }
      if (required.size > 0) {
        addEdge(info.path, moduleSpecifier, required);
      } else if (!surface.complete) {
        // Unknown/cyclic export surfaces must be retained. Passing the original
        // demand lets a nested pure barrel continue narrowing if it can.
        addEdge(info.path, moduleSpecifier, demand);
      }
    }
  };

  enqueue(path.resolve(entryFile), null);
  while (queue.length > 0) {
    const filePath = queue.shift()!;
    const loaded = load(filePath);
    if (!loaded) continue;
    const demand = demands.get(loaded.path);
    if (demand === undefined) continue;
    const info =
      demand === null ? baseModuleView(loaded) : loaded.pureBarrel ? loaded : specializeModuleForDemand(loaded, demand);
    modules.set(info.path, info);
    if (demand === null || !info.pureBarrel) expandWholeModule(info);
    else expandBarrel(info, demand);
  }

  const resolved = new Map<string, string>();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order = (filePath: string): void => {
    const canonicalPath = resolver.canonicalize(filePath);
    if (visited.has(canonicalPath) || onStack.has(canonicalPath)) return;
    const info = modules.get(canonicalPath);
    if (!info || !demands.has(canonicalPath)) return;
    onStack.add(canonicalPath);
    for (const target of selectedEdges.get(canonicalPath)?.keys() ?? []) order(target);
    onStack.delete(canonicalPath);
    visited.add(canonicalPath);
    resolved.set(canonicalPath, info.content);
  };
  order(path.resolve(entryFile));
  return resolved;
}
