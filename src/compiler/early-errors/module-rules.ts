// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Module / source-file level ES early-error rules (#1931): default-export of a
// declaration, duplicate export names, module-item position, reserved
// yield/await identifiers, HTML close comments, and duplicate class
// constructors. Extracted verbatim from detectEarlyErrors; the only change is
// threading an EarlyErrorContext and importing the shared predicate helpers.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";
import { findInnermostNodeAtPosition, isStrictMode } from "./predicates.js";

/**
 * `export default const/var/let` — always a SyntaxError.
 * ES spec: ExportDeclaration : export default HoistableDeclaration |
 *          export default ClassDeclaration | export default [LAE] AssignmentExpression ;
 * VariableStatement and LexicalDeclaration are not valid after export default.
 */
export function checkExportDefaultDeclaration(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // TS models `export default expr` as ExportAssignment.
      // But `export default const x = 1` is parsed differently — TS may parse it
      // as ExportAssignment with the expression being an error node.
      // Check the raw source for the pattern.
      const start = stmt.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 30);
      if (/^export\s+default\s+(?:const|let|var)\b/.test(rawText)) {
        ctx.addError(stmt, "A default export may not be a variable/lexical declaration");
      }
    }
  }
}

/**
 * Duplicate export names (source-file level check).
 * ES spec: It is a Syntax Error if ExportedNames contains any duplicate entries.
 */
export function checkDuplicateExportNames(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  const exportedNames = new Map<string, ts.Node>();
  // TypeScript overload signatures are erased and therefore do not each add
  // an ECMAScript runtime export. Only the same-name body-bearing
  // implementation contributes the exported name (#4267).
  const overloadImplementations = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      overloadImplementations.add(statement.name.text);
    }
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const exportedAs = spec.name.text;
          if (exportedNames.has(exportedAs)) {
            ctx.addError(spec, `Duplicate export name '${exportedAs}'`);
          } else {
            exportedNames.set(exportedAs, spec);
          }
        }
      }
      // export * as name — adds 'name' to exported names
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        const exportedAs = stmt.exportClause.name.text;
        if (exportedNames.has(exportedAs)) {
          ctx.addError(stmt.exportClause, `Duplicate export name '${exportedAs}'`);
        } else {
          exportedNames.set(exportedAs, stmt.exportClause);
        }
      }
    }
    if (ts.isExportAssignment(stmt)) {
      if (exportedNames.has("default")) {
        ctx.addError(stmt, "Duplicate export name 'default'");
      } else {
        exportedNames.set("default", stmt);
      }
    }
    // export function/class/variable declarations contribute to exported names
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (!stmt.body && overloadImplementations.has(stmt.name.text)) continue;
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : stmt.name.text;
      if (exportedNames.has(name)) {
        ctx.addError(stmt.name, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name);
      }
    }
    if (
      ts.isClassDeclaration(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : (stmt.name?.text ?? "default");
      if (exportedNames.has(name)) {
        ctx.addError(stmt.name ?? stmt, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name ?? stmt);
      }
    }
    if (
      ts.isVariableStatement(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          if (exportedNames.has(decl.name.text)) {
            ctx.addError(decl.name, `Duplicate export name '${decl.name.text}'`);
          } else {
            exportedNames.set(decl.name.text, decl.name);
          }
        }
      }
    }
  }
}

/**
 * Detect the test262-runner wrapTest sentinel — `export function test(): number`.
 * The wrapper buries the original test body inside that function, so legitimately
 * top-level import/export and bare yield/await end up nested. The module-item and
 * reserved-identifier checks skip wrapped sources.
 */
function isWrapTestSource(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (s) =>
      ts.isFunctionDeclaration(s) &&
      s.name?.text === "test" &&
      ts.canHaveModifiers(s) &&
      ts.getModifiers(s as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      s.type &&
      s.type.kind === ts.SyntaxKind.NumberKeyword,
  );
}

/**
 * Import/Export declaration position (ES static semantics).
 * ImportDeclaration / ExportDeclaration / ExportAssignment are ModuleItems —
 * they may only appear at the top level of a Module.
 */
export function checkModuleItemPosition(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  const walk = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      if (node.parent && !ts.isSourceFile(node.parent)) {
        const kind = ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ? "import" : "export";
        ctx.addError(node, `${kind} declarations may only appear at the top level of a module`);
        return;
      }
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Reserved words `yield` / `await` used as an identifier.
 * `yield` is reserved in strict-mode code and inside generator bodies;
 * `await` is reserved in module code and inside async function bodies.
 */
export function checkReservedIdentifiers(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (isWrapTestSource(sourceFile)) return;
  const sourceFileIsModule = ts.isExternalModule(sourceFile);
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "yield" || node.text === "await")) {
      // Skip cases where the identifier is a member / property name or
      // import / export name — those are IdentifierName positions and are
      // always allowed.
      const parent = node.parent;
      if (parent) {
        if (
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
          (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
          (ts.isExportSpecifier(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.name === node)
        ) {
          return; // property / import / export name position — allowed
        }
      }

      const name = node.text;
      if (name === "yield") {
        // Reserved in strict mode or inside any enclosing generator.
        let reserved = isStrictMode(node) || sourceFileIsModule;
        if (!reserved) {
          let c: ts.Node | undefined = node.parent;
          while (c) {
            if (
              (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isMethodDeclaration(c)) &&
              c.asteriskToken
            ) {
              reserved = true;
              break;
            }
            c = c.parent;
          }
        }
        if (reserved) {
          ctx.addError(node, "'yield' is a reserved word and may not be used as an identifier in strict mode");
        }
      } else if (name === "await") {
        // ES spec §13.2.5.1: `await` is reserved at module top level
        // ([+Await] goal) and inside async function bodies. A non-async
        // function body uses [~Await], so `await` is a valid identifier
        // there even within a module. Walk up to the nearest function
        // boundary to determine the context.
        let reserved = false;
        let c: ts.Node | undefined = node.parent;
        while (c) {
          if (ts.isArrowFunction(c)) {
            // Arrow functions inherit [+Await] from their enclosing context —
            // they do NOT reset it. If async, mark reserved and stop.
            // If non-async, keep walking outward.
            if (c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
              reserved = true;
              break;
            }
            // non-async arrow: continue to enclosing scope
          } else if (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isMethodDeclaration(c)) {
            // Non-arrow function boundary resets [Await] context.
            // Exception: if 'await' is the BindingIdentifier (name) of THIS
            // function, it's evaluated in the ENCLOSING scope's [Await] context,
            // not the function's own body. Keep walking up. (#1068)
            if ((c as any).name === node) {
              c = c.parent;
              continue;
            }
            reserved = !!c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
            break;
          }
          c = c.parent;
        }
        // No enclosing function — module top level is [+Await]
        if (!c && sourceFileIsModule) {
          reserved = true;
        }
        if (reserved) {
          ctx.addError(
            node,
            "'await' is a reserved word and may not be used as an identifier in module code or async functions",
          );
        }
      }
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * HTML close comment (-->) in module code.
 * HTML-like comments are allowed in scripts but not in modules.
 */
export function checkHtmlCloseComment(ctx: EarlyErrorContext): void {
  const { sourceFile } = ctx;
  if (!ts.isExternalModule(sourceFile)) return;
  for (const line of sourceFile.text.split(/\r?\n/u)) {
    if (/^\s*(?:;+\s*)?-->/.test(line)) {
      const offset = sourceFile.text.indexOf(line);
      const lineNode = findInnermostNodeAtPosition(sourceFile, offset);
      ctx.addError(lineNode, "HTML close comments are not allowed in module code");
      break;
    }
  }
}

/**
 * Duplicate class constructors.
 * ES spec: It is a Syntax Error if PrototypePropertyNameList of ClassElementList
 * contains more than one occurrence of "constructor".
 */
export function checkDuplicateConstructors(ctx: EarlyErrorContext): void {
  const checkClass = (classNode: ts.ClassDeclaration | ts.ClassExpression): void => {
    let ctorCount = 0;
    for (const member of classNode.members) {
      if (ts.isConstructorDeclaration(member)) {
        // Only count constructors with a body (declarations without bodies are overloads)
        if (member.body) {
          ctorCount++;
          if (ctorCount > 1) {
            ctx.addError(member, "A class may only have one constructor");
            break;
          }
        }
      }
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      checkClass(node);
    }
    forEachChild(node, walk);
  };
  walk(ctx.sourceFile);
}
