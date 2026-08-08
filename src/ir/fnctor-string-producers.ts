// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's STRING-SUBSTRATE rules — the minimal slice of the
// "string-builtin" program the 2026-08-07 locals spec priced (§6/§8) that the
// `Parser.pos` pin census actually needs:
//
//   A. `String(x)` → string. `String` as a function call returns a primitive
//      string for EVERY input (a Symbol stringifies, no argument gives "");
//      the only non-string outcome is a throw from a user `toString`, and a
//      throw means no value flows — vacuously sound, the family's standing
//      argument. Guarded on `String` resolving to the host global: no in-file
//      declaration of the name and no in-file write to it.
//   B. `recv.indexOf(…)` / `recv.lastIndexOf(…)` / `recv.charCodeAt(…)` → f64
//      when `recv` evaluates to STRING. A primitive-string receiver dispatches
//      through String.prototype, and these three builtins return a Number on
//      every path (indexOf/lastIndexOf: an index or -1; charCodeAt: a code
//      unit or NaN). Argument coercion may run user code, but user code can
//      only THROW its way out — it cannot change the builtin's return type.
//      `search` is deliberately absent: `"s".search(x)` dispatches to
//      `x[Symbol.search]`, which is arbitrary user code with an arbitrary
//      return value. `codePointAt` is absent: it returns `undefined` out of
//      range, not NaN.
//   C. `recv.length` → f64 when `recv` evaluates to STRING.
//
// B and C additionally require that the METHOD NAME is never written as a
// property anywhere in the module: `String.prototype.indexOf = …` (or a
// literal-key defineProperty of it) would put user code behind the dispatch.
// `String.prototype` itself is non-writable/non-configurable, so replacing the
// whole prototype is not a shape this guard needs. Dynamic-key writes on
// untracked bases remain the family's DOCUMENTED GAP (the same one
// `fnctor-field-writes.ts` records for `copyNode`); a module containing `with`
// or a direct `eval` call declines everything — either can install a patch
// without leaving a syntactic occurrence.
//
// Why this is the cheap end of the "string builtins" program: rule A is what
// makes `this.input = String(input)` carry a STRING field fact, and rule B is
// what types `var end = this.input.indexOf("*/", …)` — together with the
// local-binding rule they retire the `this.pos = end + 2` pin (:5494). The
// full program (slice/charAt/match/…, `+`-concatenation) stays out per the
// locals spec §6: every extra method is another audited return-type contract,
// and none of them gates a measured pin.
//
// SATELLITE-ONLY: the always-on main-map path passes no extension (#1712
// byte-parity by construction).
import { forEachChild, ts } from "../ts-api.js";
import { resolveLiteralKeys, unwrap } from "./fnctor-graph-model.js";
import type { InferExtension, LatticeType } from "./propagate.js";

const F64: LatticeType = { kind: "f64" };
const STRING: LatticeType = { kind: "string" };

/** String.prototype members with an unconditional Number return. */
const NUMBER_RETURNING: ReadonlySet<string> = new Set(["indexOf", "lastIndexOf", "charCodeAt"]);

const ASSIGNMENT_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

interface FileGuards {
  /** `with` / direct `eval` present, or an unresolvable prototype patch shape. */
  readonly declineAll: boolean;
  /** Property names written (assign/compound/inc-dec/delete/defineProperty). */
  readonly writtenPropertyNames: ReadonlySet<string>;
  /** The global `String` is shadowed or written in-file. */
  readonly stringShadowed: boolean;
}

const guardsCache = new WeakMap<ts.SourceFile, FileGuards>();

function literalKeyText(e: ts.Expression): string | undefined {
  const k = unwrap(e);
  if (ts.isStringLiteral(k) || k.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (k as ts.StringLiteral).text;
  }
  return undefined;
}

function propertyWriteName(target: ts.Expression): string | undefined {
  const t = unwrap(target);
  if (ts.isPropertyAccessExpression(t)) return ts.isPrivateIdentifier(t.name) ? undefined : t.name.text;
  if (ts.isElementAccessExpression(t)) return literalKeyText(t.argumentExpression);
  return undefined;
}

function computeGuards(sf: ts.SourceFile): FileGuards {
  const cached = guardsCache.get(sf);
  if (cached) return cached;
  const written = new Set<string>();
  let declineAll = false;
  let stringShadowed = false;
  const notePropertyTarget = (target: ts.Expression): void => {
    const t = unwrap(target);
    if (!ts.isPropertyAccessExpression(t) && !ts.isElementAccessExpression(t)) return;
    const name = propertyWriteName(t);
    if (name !== undefined) written.add(name);
    // A dynamic-key write on an untracked base is the family's documented gap
    // — deliberately NOT a declineAll (measured on acorn: `copyNode`'s
    // `newNode[prop] = node[prop]` would zero the module otherwise).
  };
  const visit = (n: ts.Node): void => {
    if (ts.isWithStatement(n)) declineAll = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "eval") declineAll = true;
    if (ts.isBinaryExpression(n) && ASSIGNMENT_OPS.has(n.operatorToken.kind)) {
      notePropertyTarget(n.left);
      if (ts.isIdentifier(unwrap(n.left)) && (unwrap(n.left) as ts.Identifier).text === "String") stringShadowed = true;
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      notePropertyTarget(n.operand as ts.Expression);
    }
    if (ts.isDeleteExpression(n)) notePropertyTarget(n.expression);
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && !ts.isPrivateIdentifier(callee.name)) {
        const base = unwrap(callee.expression);
        const method = callee.name.text;
        if (ts.isIdentifier(base) && base.text === "Object") {
          if (method === "defineProperty" && n.arguments.length >= 2) {
            const key = literalKeyText(n.arguments[1]!);
            if (key !== undefined) written.add(key);
            else declineAll = true; // computed defineProperty key could name anything
          } else if (method === "defineProperties" && n.arguments.length >= 2) {
            // Same resolution the method-space scan uses: a literal descriptor
            // map (or a top-level once-declared var holding one — acorn's
            // `Object.defineProperties(Parser.prototype, prototypeAccessors)`)
            // names exactly its keys; anything else could define ANY name.
            const keys = resolveLiteralKeys(sf, n.arguments[1]!);
            if (keys !== undefined) for (const key of keys) written.add(key);
            else declineAll = true;
          }
        }
      }
    }
    if (
      (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isParameter(n)) &&
      n.name !== undefined &&
      ts.isIdentifier(n.name) &&
      n.name.text === "String"
    ) {
      stringShadowed = true;
    }
    if (ts.isImportSpecifier(n) || ts.isImportClause(n)) {
      const name = (n as { name?: ts.Identifier }).name;
      if (name !== undefined && name.text === "String") stringShadowed = true;
    }
    forEachChild(n, visit);
  };
  forEachChild(sf, visit);
  const guards: FileGuards = { declineAll, writtenPropertyNames: written, stringShadowed };
  guardsCache.set(sf, guards);
  return guards;
}

/**
 * Build the rules. `evaluate` must recurse through the composed extension —
 * the standing nesting caveat on `createI32ProducerExtension`.
 */
export function createStringProducerExtension(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType,
): InferExtension {
  const guards = computeGuards(sf);
  if (guards.declineAll) return { tryInfer: () => undefined };

  /** `String` in callee position resolves to the untouched host global. */
  const isHostStringCallee = (callee: ts.Expression): boolean => {
    const c = unwrap(callee);
    if (!ts.isIdentifier(c) || c.text !== "String" || guards.stringShadowed) return false;
    for (const d of checker.getSymbolAtLocation(c)?.getDeclarations() ?? []) {
      if (d.getSourceFile() === sf) return false;
    }
    return true;
  };

  return {
    tryInfer(expr, scope) {
      if (ts.isCallExpression(expr)) {
        if (isHostStringCallee(expr.expression)) return STRING;
        const callee = unwrap(expr.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          !ts.isPrivateIdentifier(callee.name) &&
          callee.questionDotToken === undefined &&
          NUMBER_RETURNING.has(callee.name.text) &&
          !guards.writtenPropertyNames.has(callee.name.text) &&
          evaluate(callee.expression, scope).kind === "string"
        ) {
          return F64;
        }
        return undefined;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        !ts.isPrivateIdentifier(expr.name) &&
        expr.questionDotToken === undefined &&
        expr.name.text === "length" &&
        !guards.writtenPropertyNames.has("length") &&
        evaluate(expr.expression, scope).kind === "string"
      ) {
        return F64;
      }
      return undefined;
    },
  };
}
