// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// CommonJS `require()` → ESM import rewrite (#1279).
//
// Phase 1: detect static top-level `X = require('Y')` declarations
// patterns at module top-level — including grouped `const a = require("a"),
// b = require("b")` declarations — and rewrite them to ESM `import`
// declarations. After rewrite, the existing import resolver
// (`resolveAllImports`), preprocessor (`preprocessImports`) and TypeScript-based
// multi-source analyzer all see them as regular ESM imports and link them
// correctly.
//
// We deliberately keep this conservative — only top-level declarations whose
// initializer is a direct call to `require` with a single string-literal
// argument. Mutable `var`/`let` bindings retain a real mutable declaration fed
// by a synthetic ESM import; they are not converted into immutable imports.
// Anything else (dynamic specifiers, nested scopes, `require(...).foo` chained
// access) is left untouched so we don't silently change semantics.

import { ts } from "./ts-api.js";
import { PositionMap } from "./position-map.js";
import { isNodeBuiltin } from "./import-resolver.js";

/** A single require() call rewrite plan. */
interface RequireRewrite {
  /** Position in the original source where the variable statement starts. */
  start: number;
  /** Position in the original source where the variable statement ends. */
  end: number;
  /** The replacement text (an ESM import declaration). */
  text: string;
}

export interface CjsRewriteOptions {
  platform?: "web" | "node" | "deno";
}

/**
 * Rewrite top-level `const X = require('Y')` and `const { ... } = require('Y')` patterns
 * to ESM `import` declarations.
 *
 * Returns the original source unchanged if no top-level require() calls are present.
 */
export function rewriteCjsRequire(source: string, options?: CjsRewriteOptions): string {
  return rewriteCjsRequireWithMap(source, options).source;
}

/**
 * #1928 — like {@link rewriteCjsRequire} but also returns a `PositionMap` from
 * the rewritten output back to the input, so diagnostics computed against the
 * rewritten source can report the user's original line numbers. `import`
 * declarations can be longer (and multi-line) than the `const … = require(…)`
 * they replace, shifting everything below.
 */
export function rewriteCjsRequireWithMap(
  source: string,
  options?: CjsRewriteOptions,
): { source: string; positionMap: PositionMap } {
  // Cheap pre-check: avoid parsing sources that contain neither side of the
  // CommonJS surface handled here.
  if (!source.includes("require(") && !/\bexports\b/.test(source)) {
    return { source, positionMap: PositionMap.identity() };
  }

  const sf = ts.createSourceFile("__cjs_rewrite__.ts", source, ts.ScriptTarget.Latest, true);
  const rewrites: RequireRewrite[] = [];

  for (const stmt of sf.statements) {
    const rewrite = tryRewriteStatement(stmt, sf);
    if (rewrite) rewrites.push(rewrite);
  }

  const wrapModuleExports = shouldWrapModuleExports(sf);
  const wrapBareExports = !wrapModuleExports && shouldWrapBareExports(sf, source);
  if (wrapModuleExports) {
    const rewriteModuleExportsReferences = (node: ts.Node): void => {
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
      ts.forEachChild(node, rewriteModuleExportsReferences);
    };
    rewriteModuleExportsReferences(sf);
  }
  const coveredByTopLevelRewrite = (node: ts.Node): boolean =>
    rewrites.some((rewrite) => node.getStart(sf) >= rewrite.start && node.end <= rewrite.end);
  const residualImports = new Map<string, string>();
  const collectResidualRequires = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !coveredByTopLevelRewrite(node)) {
      const moduleSpec = extractRequireSpecifier(node);
      if (moduleSpec !== null) {
        let temp = residualImports.get(moduleSpec);
        if (!temp) {
          temp = `__cjs_static_require_${residualImports.size}`;
          residualImports.set(moduleSpec, temp);
        }
        rewrites.push({
          start: node.getStart(sf),
          end: node.end,
          text: temp,
        });
        return;
      }
    }
    ts.forEachChild(node, collectResidualRequires);
  };
  const collectModuleResidualRequires = (node: ts.Node): void => {
    // A require nested in a callback is lazy, not a module-initialization
    // dependency. ESLint's built-in rule map contains hundreds of
    // `() => require("./rule")` loaders; eagerly importing those callbacks
    // expands a minimal Linter graph from tens of executable files to the
    // entire rule catalog. Preserve immediately-invoked function expressions,
    // whose requires do execute during module initialization. Named function
    // declarations remain traversed because CommonJS factories such as
    // debug's exported `setup()` are invoked by their importing module.
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const immediatelyInvoked = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!immediatelyInvoked) return;
    }
    // A caught require is conventionally optional (`try { require("colors") }
    // catch { ... }`). Leaving it in place lets the existing runtime catch path
    // select the fallback instead of eagerly adding and evaluating an optional
    // dependency module.
    if (ts.isTryStatement(node) && node.catchClause) {
      ts.forEachChild(node.catchClause, collectModuleResidualRequires);
      if (node.finallyBlock) ts.forEachChild(node.finallyBlock, collectModuleResidualRequires);
      return;
    }
    // Node/browser selector used by packages such as debug. In a Node/deno host
    // only the else implementation is part of the executable graph; the
    // browser branch retains its original require in an unreachable arm.
    if (
      ts.isIfStatement(node) &&
      (options?.platform === "node" || options?.platform === "deno") &&
      /\btypeof\s+process\b/.test(node.expression.getText(sf)) &&
      /\bprocess\.(?:type|browser|__nwjs)\b/.test(node.expression.getText(sf)) &&
      node.elseStatement
    ) {
      collectModuleResidualRequires(node.elseStatement);
      return;
    }
    if (ts.isCallExpression(node) && !coveredByTopLevelRewrite(node)) {
      const moduleSpec = extractRequireSpecifier(node);
      if (moduleSpec !== null) {
        let temp = residualImports.get(moduleSpec);
        if (!temp) {
          temp = `__cjs_static_require_${residualImports.size}`;
          residualImports.set(moduleSpec, temp);
        }
        rewrites.push({
          start: node.getStart(sf),
          end: node.end,
          text: temp,
        });
        return;
      }
    }
    ts.forEachChild(node, collectModuleResidualRequires);
  };
  // The nested form is needed by legacy UMD modules that mutate a free
  // `exports` object from inside an IIFE (notably esrecurse), and by
  // `module.exports` factories such as debug's common.js (`setup()` performs a
  // static `require("ms")` before the top-level factory call returns).
  // Scope this eager linking to sources that actually expose a CommonJS export;
  // ordinary files retain the conservative top-level declaration rewrite.
  if (wrapBareExports) collectResidualRequires(sf);
  if (wrapModuleExports) collectModuleResidualRequires(sf);

  if (rewrites.length === 0 && !wrapBareExports && !wrapModuleExports) {
    return { source, positionMap: PositionMap.identity() };
  }

  const requirePrelude = [...residualImports]
    .map(([spec, temp]) => `import ${temp} from ${JSON.stringify(spec)};`)
    .join("\n");
  const exportsPrelude = wrapModuleExports
    ? "/** @type {any} */ let __cjs_default_export = Object.create(Object.prototype);\n/** @type {any} */ const exports = __cjs_default_export;\n"
    : wrapBareExports
      ? "/** @type {any} */ const exports = {};\n"
      : "";
  const exportsFooter = wrapModuleExports
    ? "\nexport default __cjs_default_export;\n"
    : wrapBareExports
      ? "\nexport default exports;\n"
      : "";
  const modulePrelude = `${requirePrelude}${requirePrelude ? "\n" : ""}${exportsPrelude}`;

  const positionMap = new PositionMap([
    ...(modulePrelude ? [{ origStart: 0, origEnd: 0, newLength: modulePrelude.length }] : []),
    ...rewrites.map((r) => ({ origStart: r.start, origEnd: r.end, newLength: r.text.length })),
    ...(exportsFooter ? [{ origStart: source.length, origEnd: source.length, newLength: exportsFooter.length }] : []),
  ]);

  // Apply rewrites in reverse order so positions stay valid.
  rewrites.sort((a, b) => b.start - a.start);
  let result = source;
  for (const r of rewrites) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }
  if (wrapBareExports || wrapModuleExports) {
    result = modulePrelude + result + exportsFooter;
  } else if (modulePrelude) {
    result = modulePrelude + result;
  }
  return { source: result, positionMap };
}

/** True for a non-ESM source that mutates the ambient CommonJS `module.exports`. */
function shouldWrapModuleExports(sf: ts.SourceFile): boolean {
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
 * Legacy UMD/CommonJS modules such as estraverse mutate a free `exports`
 * object and return it from an IIFE, but never assign `module.exports`.
 * Static-require rewriting turns their consumers into default ESM imports, so
 * give that free object a module-local binding and a default export.
 */
function shouldWrapBareExports(sf: ts.SourceFile, source: string): boolean {
  if (source.includes("module.exports")) return false;
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

  // Do not shadow a real top-level declaration named `exports`.
  for (const stmt of sf.statements) {
    if (
      ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === "exports") ||
      (ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "exports",
        ))
    ) {
      return false;
    }
  }

  let hasFreeExportsReference = false;
  const visit = (node: ts.Node): void => {
    if (hasFreeExportsReference) return;
    if (ts.isIdentifier(node) && node.text === "exports") {
      const parent = node.parent;
      const isDeclarationName =
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent)) &&
          parent.name === node);
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node);
      if (!isDeclarationName && !isPropertyName) {
        hasFreeExportsReference = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hasFreeExportsReference;
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
    const declarationKind = flags & ts.NodeFlags.Let ? "let" : "var";
    const imports: string[] = [];
    const bindings: string[] = [];
    for (const [ordinal, decl] of stmt.declarationList.declarations.entries()) {
      if (!decl.initializer) return null;
      const moduleSpec = extractRequireSpecifier(decl.initializer);
      if (moduleSpec === null) return null;
      const temp = `__cjs_require_${Math.max(0, stmt.getStart(sf))}_${ordinal}`;
      imports.push(`import ${temp} from ${JSON.stringify(moduleSpec)};`);
      bindings.push(`${decl.name.getText(sf)} = ${temp}`);
    }
    if (imports.length === 0) return null;
    return {
      start: stmt.getStart(sf),
      end: stmt.end,
      text: `${imports.join("\n")}\n${declarationKind} ${bindings.join(", ")};`,
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

/** Render one static require declarator as an ESM import, or reject it. */
function tryRenderRequireImport(decl: ts.VariableDeclaration): string | null {
  if (!decl.initializer) return null;

  const moduleSpec = extractRequireSpecifier(decl.initializer);
  if (moduleSpec === null) {
    // `const X = require("<builtin>").prop` — bind the namespace, then read the
    // property from it, so the builtin registers as a host import.
    const chained = extractChainedBuiltinRequire(decl.initializer);
    if (chained !== null && ts.isIdentifier(decl.name)) {
      const ns = `__cjs_builtin_ns_${chained.moduleSpec.replace(/[^A-Za-z0-9_$]/g, "_")}_${Math.max(0, decl.pos)}`;
      return (
        `import * as ${ns} from ${JSON.stringify(chained.moduleSpec)};\n` +
        `const ${decl.name.text} = ${ns}.${chained.property};`
      );
    }
    return null;
  }

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
/**
 * Match `require("<node builtin>").<prop>` — a require in CHAINED position.
 *
 * `extractRequireSpecifier` only matches a bare `require(...)` call, so this
 * shape was left unrewritten. It then never reached the node-builtin import
 * collector (which scans for `import` declarations), so no `__node_<mod>` host
 * import was registered and the module resolved to an EMPTY synthesized
 * namespace. `util-deprecate/node.js` is exactly this file:
 *
 *   module.exports = require('util').deprecate;
 *
 * and it is reachable from ESLint's Linter graph, where the call then failed at
 * runtime with "deprecate is not a function" on a null-prototype empty object.
 *
 * Scoped deliberately to Node builtins: those are the specifiers whose runtime
 * value comes from the host rather than from a compiled module, so leaving them
 * unresolved is always wrong. Userland chained requires keep their existing
 * (unrewritten) behaviour.
 */
function extractChainedBuiltinRequire(expr: ts.Expression): { moduleSpec: string; property: string } | null {
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const moduleSpec = extractRequireSpecifier(expr.expression);
  if (moduleSpec === null) return null;
  if (!isNodeBuiltin(moduleSpec)) return null;
  return { moduleSpec, property: expr.name.text };
}

function extractRequireSpecifier(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "require") return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0];
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
  return arg.text;
}
