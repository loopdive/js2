// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Standalone `process.env` branch fold for the project resolver (#6663).
//
// A `--target standalone` module has no host `process`: codegen lowers every
// `process.env` read to a fresh, empty plain object (property-access-dispatch
// `__new_plain_object`, the react/redux NODE_ENV gate). So in that target
// `process.env.NODE_ENV` is `undefined` at run time, deterministically.
//
// The CommonJS entry of a large share of npm packages selects its build with a
// top-level
//
//     if (process.env.NODE_ENV === 'production') {
//       module.exports = require('./cjs/pkg.production.js');
//     } else {
//       module.exports = require('./cjs/pkg.development.js');
//     }
//
// Neither `require` is a top-level declaration, so `rewriteCjsRequire` cannot
// turn it into an import and `resolveAllImports` never adds either file to the
// graph. The compile succeeds and module init then calls an unbound `require`:
// `ReferenceError: require is not defined`, surfaced by the npm-compat harness
// as "uncaught Wasm-GC exception (non-stringifiable payload)" (react).
//
// This pass resolves such an `if` statically, using exactly the value the
// standalone program would observe (or an explicit `define` entry), and keeps
// only the taken arm. The taken arm's `module.exports = require(...)` is then an
// ordinary top-level statement the existing CJS rewrite links statically.
//
// Positions are preserved exactly: removed text is overwritten with spaces and
// every newline is kept, so no PositionMap is needed downstream.
//
// The fold is deliberately narrow; anything it cannot prove is left alone:
//   - only statements at the top level of the file (evaluated once, at init);
//   - the file must not bind `process` itself (declaration or import);
//   - the condition may only combine `process.env.NAME` / `process.env["NAME"]`
//     reads and string literals with `===`, `!==`, `==`, `!=`, `!`, `&&`, `||`
//     and parentheses — all side-effect free here;
//   - the dropped arm must not declare a `var` or a function (both would
//     outlive the arm and change the module scope);
//   - the kept block is unwrapped only when it declares no lexical binding.

import { ts } from "./ts-api.js";

const PROCESS_ENV_RE = /\bprocess\s*\.\s*env\b/;

/** `undefined` = the read is not provable; otherwise the observed value. */
type EnvValue = { value: string | undefined } | null;

/**
 * Fold top-level `if` statements whose condition depends only on
 * `process.env.*` reads, as a `--target standalone` program observes them.
 *
 * @param source - one module's source text
 * @param define - the compile's `define` map; a `process.env.NAME` key with a
 *   string-literal value overrides the standalone `undefined`
 */
export function foldStandaloneProcessEnvBranches(source: string, define?: Readonly<Record<string, string>>): string {
  if (!PROCESS_ENV_RE.test(source)) return source;
  const sf = ts.createSourceFile("__standalone_env_fold__.ts", source, ts.ScriptTarget.Latest, true);
  if (bindsProcess(sf)) return source;

  const blanks: Array<[number, number]> = [];
  const envRead = (expr: ts.Expression): EnvValue => {
    const name = processEnvKey(expr);
    if (name === undefined) return null;
    const defined = define?.[`process.env.${name}`];
    if (defined === undefined) return { value: undefined };
    const literal = parseStringLiteral(defined);
    return literal === null ? null : { value: literal };
  };
  const operand = (expr: ts.Expression): EnvValue => {
    const inner = skipParens(expr);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return { value: inner.text };
    return envRead(inner);
  };
  const evaluate = (expr: ts.Expression): boolean | undefined => {
    const e = skipParens(expr);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = evaluate(e.operand);
      return inner === undefined ? undefined : !inner;
    }
    if (!ts.isBinaryExpression(e)) return undefined;
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const left = evaluate(e.left);
      const right = evaluate(e.right);
      if (left === undefined || right === undefined) return undefined;
      return op === ts.SyntaxKind.AmpersandAmpersandToken ? left && right : left || right;
    }
    const equal =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
        ? true
        : op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
          ? false
          : undefined;
    if (equal === undefined) return undefined;
    // At least one side must be an env read; `"a" === "b"` is not ours to fold.
    if (processEnvKey(skipParens(e.left)) === undefined && processEnvKey(skipParens(e.right)) === undefined) {
      return undefined;
    }
    const left = operand(e.left);
    const right = operand(e.right);
    if (left === null || right === null) return undefined;
    // Both operands are string-or-undefined, so `==` and `===` agree.
    return (left.value === right.value) === equal;
  };

  const foldIf = (stmt: ts.IfStatement): void => {
    const taken = evaluate(stmt.expression);
    if (taken === undefined) return;
    const kept = taken ? stmt.thenStatement : stmt.elseStatement;
    const dropped = taken ? stmt.elseStatement : stmt.thenStatement;
    if (dropped && declaresHoistedBinding(dropped)) return;
    if (taken) {
      blanks.push([stmt.getStart(sf), stmt.thenStatement.getStart(sf)]);
      if (stmt.elseStatement) blanks.push([stmt.thenStatement.end, stmt.elseStatement.end]);
    } else {
      blanks.push([stmt.getStart(sf), stmt.elseStatement ? stmt.elseStatement.getStart(sf) : stmt.end]);
    }
    if (!kept) return;
    // A kept block is flattened only when that cannot change its lexical scope;
    // a kept `else if` becomes a top-level statement and is folded in turn.
    if (ts.isBlock(kept) && blockIsUnwrappable(kept)) {
      blanks.push([kept.getStart(sf), kept.getStart(sf) + 1]);
      blanks.push([kept.end - 1, kept.end]);
    } else if (ts.isIfStatement(kept)) {
      foldIf(kept);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isIfStatement(stmt)) foldIf(stmt);
  }
  if (blanks.length === 0) return source;

  const chars = source.split("");
  for (const [start, end] of blanks) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
}

function skipParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** `process.env.NAME` / `process.env["NAME"]` → `NAME`. */
function processEnvKey(expr: ts.Expression): string | undefined {
  let object: ts.Expression;
  let name: string;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    object = expr.expression;
    name = expr.name.text;
  } else if (
    ts.isElementAccessExpression(expr) &&
    (ts.isStringLiteral(expr.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expr.argumentExpression))
  ) {
    object = expr.expression;
    name = expr.argumentExpression.text;
  } else {
    return undefined;
  }
  object = skipParens(object);
  if (!ts.isPropertyAccessExpression(object) || object.name.text !== "env") return undefined;
  const root = skipParens(object.expression);
  return ts.isIdentifier(root) && root.text === "process" ? name : undefined;
}

/** A `define` value is a JS expression literal; only plain string literals fold. */
function parseStringLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (!/^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')$/.test(trimmed)) return null;
  const sf = ts.createSourceFile("__define__.ts", `(${trimmed})`, ts.ScriptTarget.Latest, false);
  const stmt = sf.statements[0];
  if (!stmt || !ts.isExpressionStatement(stmt)) return null;
  const expr = skipParens(stmt.expression);
  return ts.isStringLiteral(expr) ? expr.text : null;
}

/** True when the module scope itself binds `process`. */
function bindsProcess(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === "process") return true;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (bindingNames(decl.name).includes("process")) return true;
      }
    }
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === "process") found = true;
        else ts.forEachChild(node, visit);
      };
      visit(stmt);
      if (found) return true;
    }
  }
  // A `var process` nested in a top-level block is also a module binding.
  let nested = false;
  const visit = (node: ts.Node): void => {
    if (nested || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclaration(node) && bindingNames(node.name).includes("process")) nested = true;
    else ts.forEachChild(node, visit);
  };
  for (const stmt of sf.statements) if (!ts.isVariableStatement(stmt)) visit(stmt);
  return nested;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) out.push(...bindingNames(element.name));
  }
  return out;
}

/** A dropped arm may not carry a binding that outlives it (`var`, function). */
function declaresHoistedBinding(stmt: ts.Statement): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(stmt);
  return found;
}

/** A kept block may be flattened into the module scope only without lexical bindings. */
function blockIsUnwrappable(block: ts.Block): boolean {
  return block.statements.every(
    (stmt) =>
      !ts.isFunctionDeclaration(stmt) &&
      !ts.isClassDeclaration(stmt) &&
      !(ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0),
  );
}
