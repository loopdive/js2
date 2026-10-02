// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Standalone hoist of a CommonJS `require("x")` nested in a function body
// (#6666, jest mechanism #6725).
//
// Bundler output defers its dependencies into lazy getters (jest's
// `build/index.js`, every Babel/webpack `_interopRequireDefault` build):
//
//     function _jestConfig() {
//       const data = require("jest-config");
//       _jestConfig = function () { return data; };
//       return data;
//     }
//
// `rewriteCjsRequire` only links TOP-LEVEL `const X = require("Y")`, so this
// edge never enters the module graph and the `require` stays a free
// identifier. A `--target standalone` module has no host `require`, so the
// first call throws `ReferenceError: require is not defined` — for jest at
// module init, because its ESM wrapper (`build/index.mjs`) reads every
// re-exported getter while initializing.
//
// A Wasm module cannot load code lazily: every module it can ever run must be
// in the static graph. So this pass links the edge the only way available —
// it appends `const <id> = require("Y");` at the end of the file, which the
// existing CJS rewrite turns into an (evaluation-hoisted) `import <id> from
// "Y"`, and replaces the nested call with a read of `<id>`. The read is of the
// import's live binding, so a dependency that is still initializing when the
// getter is defined is observed in its final state when the getter runs.
//
// Positions are preserved exactly: the call text is overwritten by the
// identifier padded with spaces (newlines kept), and the declarations go after
// the last byte, so no PositionMap is needed downstream (as in #6663's fold).
//
// Narrow by construction; a call it cannot prove safe is left as it was:
//   - the call is `require(<string literal>)`, nested in a function-like body
//     (top-level shapes stay with `rewriteCjsRequire` / the #6663 env fold);
//   - the file declares no binding named `require` anywhere (an AMD
//     `define(function (require) {…})` wrapper or a local shim owns the name);
//   - the call is not inside any `try` block — the optional-dependency idiom
//     (`try { require("peer") } catch {}`) must not become a hard graph edge;
//   - the specifier is not a Node builtin (standalone has no host builtins, so
//     hoisting one would move a lazy failure to module init);
//   - the specifier resolves (`canResolve`) — an unresolvable lazy edge stays
//     lazy instead of failing the whole compile.
//   - Eager evaluation is the accepted cost: the dependency now initializes
//     before this module instead of on first call.

import { isNodeBuiltin } from "./import-resolver.js";
import { ts } from "./ts-api.js";

const REQUIRE_RE = /\brequire\s*\(/;

/** Declared names that make `require` a local binding instead of the CJS global. */
function declaresRequire(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const name = (node as { name?: ts.Node }).name;
    if (
      name !== undefined &&
      ts.isIdentifier(name) &&
      name.text === "require" &&
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isBindingElement(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Whether `node` sits inside a function-like body, and whether any enclosing `try` block covers it. */
function nestingOf(node: ts.Node): { inFunction: boolean; inTry: boolean } {
  let inFunction = false;
  let inTry = false;
  for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) inFunction = true;
    if (ts.isTryStatement(parent) && parent.tryBlock === child) inTry = true;
  }
  return { inFunction, inTry };
}

/** Overwrite `[start, end)` with `text`, padding with spaces and keeping every newline. */
function overwrite(chars: string[], start: number, end: number, text: string): void {
  for (let i = start, j = 0; i < end; i++) {
    const c = chars[i];
    if (c === "\n" || c === "\r") continue;
    chars[i] = j < text.length ? text[j++] : " ";
  }
}

/**
 * Link every provably-safe function-nested `require("Y")` into the static
 * module graph (see the file header). Identity when nothing qualifies.
 *
 * @param source - one module's source text (after the #6663 env fold)
 * @param canResolve - whether the resolver finds `specifier` from this file
 */
export function hoistStandaloneNestedRequires(source: string, canResolve: (specifier: string) => boolean): string {
  if (!REQUIRE_RE.test(source)) return source;
  const sf = ts.createSourceFile("__standalone_nested_require__.js", source, ts.ScriptTarget.Latest, true);
  if (declaresRequire(sf)) return source;

  const sites: { start: number; end: number; specifier: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      const specifier = node.arguments[0].text;
      const { inFunction, inTry } = nestingOf(node);
      if (inFunction && !inTry && specifier !== "" && !isNodeBuiltin(specifier) && canResolve(specifier)) {
        sites.push({ start: node.getStart(sf), end: node.end, specifier });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (sites.length === 0) return source;

  const bindings = new Map<string, string>();
  const chars = source.split(""); // UTF-16 units, matching TypeScript's offsets
  for (const site of sites) {
    let id = bindings.get(site.specifier);
    if (id === undefined) {
      id = `__cjs_nreq${bindings.size}`;
      // The id must fit in the call text it overwrites (`require("ab")` is 13
      // units); a too-short call is simply left unlinked.
      if (id.length > site.end - site.start) continue;
      bindings.set(site.specifier, id);
    }
    overwrite(chars, site.start, site.end, id);
  }
  let tail = "\n";
  for (const [specifier, id] of bindings) tail += `const ${id} = require(${JSON.stringify(specifier)});\n`;
  return chars.join("") + tail;
}
