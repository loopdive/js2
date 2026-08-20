// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// CommonJS `require()` → ESM import rewrite (#1279).
//
// Phase 1: detect static top-level `X = require('Y')` declarations — including
// grouped `const a = require("a"),
// b = require("b")` declarations — and rewrite them to ESM `import`
// declarations. After rewrite, the existing import resolver
// (`resolveAllImports`), preprocessor (`preprocessImports`) and TypeScript-based
// multi-source analyzer all see them as regular ESM imports and link them
// correctly.
//
// We deliberately keep this conservative — only top-level declarations whose
// initializer is a direct call to `require` with a single string-literal argument.
// A `var`/`let` binding is rewritten only when a source-wide conservative scan
// proves it is never reassigned; otherwise it remains CommonJS so an immutable
// ESM binding cannot change its semantics. Anything else (dynamic specifiers,
// nested scopes, default-value destructuring, `require(...).foo` chained
// access) is left untouched.

import { ts } from "./ts-api.js";
import { PositionMap } from "./position-map.js";
import { isNodeBuiltin, normalizeNodeBuiltin } from "./import-resolver.js";

/** A single require() call rewrite plan. */
interface RequireRewrite {
  /** Position in the original source where the variable statement starts. */
  start: number;
  /** Position in the original source where the variable statement ends. */
  end: number;
  /** The replacement text (an ESM import declaration). */
  text: string;
}

/**
 * Rewrite top-level `const X = require('Y')` and `const { ... } = require('Y')` patterns
 * to ESM `import` declarations.
 *
 * Returns the original source unchanged if no top-level require() calls are present.
 */
export function rewriteCjsRequire(source: string): string {
  return rewriteCjsRequireWithMap(source).source;
}

/**
 * #1928 — like {@link rewriteCjsRequire} but also returns a `PositionMap` from
 * the rewritten output back to the input, so diagnostics computed against the
 * rewritten source can report the user's original line numbers. `import`
 * declarations can be longer (and multi-line) than the `const … = require(…)`
 * they replace, shifting everything below.
 */
export function rewriteCjsRequireWithMap(source: string): { source: string; positionMap: PositionMap } {
  // Cheap pre-check: dependency leaves may have no `require()` calls but still
  // need their `module.exports` value surfaced for a rewritten importer.
  if (!source.includes("require(") && !source.includes("module.exports")) {
    return { source, positionMap: PositionMap.identity() };
  }

  const sf = ts.createSourceFile("__cjs_rewrite__.ts", source, ts.ScriptTarget.Latest, true);
  const rewrites: RequireRewrite[] = [];

  for (const stmt of sf.statements) {
    const rewrite = tryRewriteStatement(stmt, sf);
    if (rewrite) rewrites.push(rewrite);
  }

  // A static require rewrite turns a CommonJS file into an ESM file. Surface
  // its `module.exports` value explicitly before that happens, including
  // assignment expressions nested in a UMD wrapper. Otherwise TypeScript no
  // longer exposes a default-export symbol for the rewritten dependency and
  // importers silently receive null.
  const wrapModuleExports = shouldWrapModuleExports(sf);
  if (wrapModuleExports) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "module" &&
        node.name.text === "exports"
      ) {
        rewrites.push({
          start: node.getStart(sf),
          end: node.end,
          text: "__cjs_default_export",
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  if (rewrites.length === 0 && !wrapModuleExports) {
    return { source, positionMap: PositionMap.identity() };
  }

  const modulePrelude = wrapModuleExports
    ? "/** @type {any} */ let __cjs_default_export = Object.create(Object.prototype);\n" +
      "/** @type {any} */ const exports = __cjs_default_export;\n" +
      "/** @type {any} */ const module = {};\n"
    : "";
  const moduleFooter = wrapModuleExports ? "\nexport default __cjs_default_export;\n" : "";

  const positionMap = new PositionMap([
    ...(modulePrelude ? [{ origStart: 0, origEnd: 0, newLength: modulePrelude.length }] : []),
    ...rewrites.map((r) => ({ origStart: r.start, origEnd: r.end, newLength: r.text.length })),
    ...(moduleFooter ? [{ origStart: source.length, origEnd: source.length, newLength: moduleFooter.length }] : []),
  ]);

  // Apply rewrites in reverse order so positions stay valid.
  rewrites.sort((a, b) => b.start - a.start);
  let result = source;
  for (const r of rewrites) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }
  result = modulePrelude + result + moduleFooter;
  return { source: result, positionMap };
}

/** True for a script that mutates the ambient CommonJS `module.exports`. */
function shouldWrapModuleExports(sf: ts.SourceFile): boolean {
  // A genuine ESM source owns its module surface already. Rewriting an
  // incidental `module.exports` reference there would invent a second default
  // export and can change user-defined `module` semantics.
  if (
    sf.statements.some(
      (stmt) =>
        ts.isImportDeclaration(stmt) ||
        ts.isImportEqualsDeclaration(stmt) ||
        ts.isExportAssignment(stmt) ||
        ts.isExportDeclaration(stmt) ||
        (ts.canHaveModifiers(stmt) &&
          (ts.getModifiers(stmt)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)),
    )
  ) {
    return false;
  }

  // Do not shadow a real top-level binding named `module`.
  for (const stmt of sf.statements) {
    if (
      ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === "module") ||
      (ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "module",
        ))
    ) {
      return false;
    }
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      node.name.text === "exports"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Inspect a top-level statement and, if it is a recognized CJS require() pattern,
 * return a rewrite plan that replaces it with an ESM import declaration.
 */
function tryRewriteStatement(stmt: ts.Statement, sf: ts.SourceFile): RequireRewrite | null {
  if (!ts.isVariableStatement(stmt)) return null;
  const flags = stmt.declarationList.flags & ts.NodeFlags.BlockScoped;
  const isConst = (flags & ts.NodeFlags.Const) !== 0;

  if (!isConst) {
    const imports: string[] = [];
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || bindingIsReassigned(sf, decl)) return null;
      const rendered = tryRenderRequireImport(decl);
      if (rendered === null) return null;
      imports.push(rendered);
    }
    if (imports.length === 0) return null;
    return {
      start: stmt.getStart(sf),
      end: stmt.end,
      text: imports.join("\n"),
    };
  }

  const imports: string[] = [];
  for (const decl of stmt.declarationList.declarations) {
    const importText = tryRenderRequireImport(decl);
    // Keep the rewrite atomic. Mixing a rewritten import with a residual
    // declarator would change declaration order and binding semantics.
    if (importText === null) return null;
    imports.push(importText);
  }
  if (imports.length === 0) return null;
  return { start: stmt.getStart(sf), end: stmt.end, text: imports.join("\n") };
}

/**
 * Prove that changing a mutable CommonJS require binding into an ESM import is
 * representation-safe. The scan deliberately over-approximates writes: a
 * same-named shadowed local may make us decline a valid rewrite, but can never
 * make us freeze a genuinely reassigned binding.
 */
function bindingIsReassigned(sf: ts.SourceFile, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return true;
  const name = declaration.name.text;
  let reassigned = false;
  const contains = (root: ts.Node, candidate: ts.Node): boolean =>
    candidate.pos >= root.pos && candidate.end <= root.end;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === name) {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (
          ts.isBinaryExpression(parent) &&
          contains(parent.left, node) &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          reassigned = true;
          return;
        }
        if (
          (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          contains(parent.operand, node) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          reassigned = true;
          return;
        }
        if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && contains(parent.initializer, node)) {
          reassigned = true;
          return;
        }
        if (ts.isStatement(parent) || ts.isSourceFile(parent)) break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reassigned;
}

/** Render one static require declarator as an ESM import, or reject it. */
function tryRenderRequireImport(decl: ts.VariableDeclaration): string | null {
  if (!decl.initializer) return null;

  const rawModuleSpec = extractRequireSpecifier(decl.initializer);
  if (rawModuleSpec === null) return null;
  // `compileProject` keeps ESM imports in the TypeScript graph instead of
  // running the single-file import preprocessor. Mark bare Node builtins with
  // the explicit `node:` scheme so the shared ambient Node surface can provide
  // typed class exports (notably `events.EventEmitter`) to that graph. The
  // runtime resolves `node:x` and `x` identically; relative/package specifiers
  // remain byte-for-byte unchanged.
  const moduleSpec =
    isNodeBuiltin(rawModuleSpec) && !rawModuleSpec.startsWith("node:")
      ? `node:${normalizeNodeBuiltin(rawModuleSpec)}`
      : rawModuleSpec;

  // Now look at the binding pattern to decide between default-import and named-import.
  if (ts.isIdentifier(decl.name)) {
    // const X = require('Y') → import X from 'Y'
    return `import ${decl.name.text} from ${JSON.stringify(moduleSpec)};`;
  }

  if (ts.isObjectBindingPattern(decl.name)) {
    // const { a, b: c } = require('Y') → import { a, b as c } from 'Y'
    // We only support the simple cases — no default values, no rest patterns,
    // no nested destructuring. Anything more complex bails out and the original
    // statement is preserved.
    const named: string[] = [];
    for (const el of decl.name.elements) {
      // Rest element: `const { ...rest } = require(...)` — not expressible in ESM.
      if (el.dotDotDotToken) return null;
      // Default initializer: `const { a = 1 } = require(...)` — not expressible.
      if (el.initializer) return null;
      // The binding target must be a plain identifier.
      if (!ts.isIdentifier(el.name)) return null;
      const localName = el.name.text;
      // `propertyName` is set when the source uses `b: c` aliasing.
      if (el.propertyName) {
        if (!ts.isIdentifier(el.propertyName)) return null;
        // ESM import binding names must be valid JS identifiers; computed keys would
        // not parse anyway because we already require an identifier propertyName.
        named.push(`${el.propertyName.text} as ${localName}`);
      } else {
        named.push(localName);
      }
    }
    if (named.length === 0) {
      // Empty destructuring is legal but pointless; treat as a side-effect import.
      return `import ${JSON.stringify(moduleSpec)};`;
    }
    return `import { ${named.join(", ")} } from ${JSON.stringify(moduleSpec)};`;
  }

  // Array destructuring or other patterns — leave alone.
  return null;
}

/**
 * If `expr` is `require('literal')`, return the literal string. Otherwise null.
 */
function extractRequireSpecifier(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "require") return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0];
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
  return arg.text;
}
