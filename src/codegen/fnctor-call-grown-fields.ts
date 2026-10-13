// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6973 stage 2) Fields a function constructor gains by delegating to another
 * constructor with `Parent.call(this, …)`.
 *
 * The ES5 inheritance idiom initializes an instance in TWO bodies:
 *
 * ```js
 * function BinaryConstraint(v1, v2, s) { this.v1 = v1; this.v2 = v2; this.direction = 0; … }
 * function EqualityConstraint(v1, v2, s) { EqualityConstraint.superConstructor.call(this, v1, v2, s); }
 * EqualityConstraint.inheritsFrom(BinaryConstraint);   // sets .superConstructor
 * ```
 *
 * `deriveFnctorFields` reads only `this.<f> = …` in the constructor's own body,
 * so `$__fnctor_EqualityConstraint` had no `v1`/`v2`/`direction` slots: every
 * such write went to the instance's expando `$bag` and every read hashed it
 * through `__extern_get`. In Octane deltablue those reads (`this.direction`,
 * `this.v1`, `this.v2` in `output()`/`input()`) were ~60 k of the ~83 k
 * `__extern_get` calls per rep.
 *
 * This module names the delegate's `this.<f>` fields so the caller can reserve
 * them as PRESENCE-TRACKED `externref` slots — exactly the treatment the
 * receiver-flow "flow-grown" fields already get. That is what makes a wrong or
 * partial resolution harmless: a reserved slot whose bit is never set reads as
 * an own-property miss and takes the dynamic path, the same answer as having no
 * slot at all. The resolution only decides which names get a fast slot.
 *
 * Callees resolved (anything else contributes nothing):
 *   - `F.call(this, …)` — `F` a top-level function declaration;
 *   - `G.p.call(this, …)` — `G.p` bound exactly once at top level, either by
 *     `G.p = F` or by `G.m(…, F, …)` where `m` is a method installed on
 *     `Object.prototype` / `Function.prototype` whose body does `this.p = <param>`
 *     (deltablue's `inheritsFrom`, Closure-style `inherits` helpers).
 * The delegate's own `.call(this, …)` statements are followed transitively.
 *
 * ## Where a struct slot would NOT be the bag's equal
 *
 * A fnctor slot's bit-clear read answers `undefined` without consulting the
 * prototype, `delete` does not clear the bit, and a slot that is never present
 * is still listed by own-key enumeration — gaps of the presence machinery that a
 * bag property does not have. So a name is reserved only when none of them can
 * be observed: it is never written onto a prototype or `defineProperty`'d, never
 * `delete`d, and is not an `Object.prototype` member; and a file that writes
 * properties under computed non-numeric keys, deletes computed keys, enumerates
 * own keys, or relinks prototypes reserves nothing at all.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Names a delegate's `this.<f>` write may never turn into a struct slot. */
const RESERVED = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);
/** Calls whose mere presence means a struct slot could be told apart from a bag entry. */
const BAIL_CALLS = new Set([
  "keys",
  "entries",
  "values",
  "assign",
  "getOwnPropertyNames",
  "getOwnPropertyDescriptors",
  "setPrototypeOf",
  "defineProperties",
  "create",
  "freeze",
  "seal",
  "preventExtensions",
  "ownKeys",
  "stringify",
]);
const MAX_DEPTH = 8;

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression;

interface FileFacts {
  /** A construct anywhere in the file that a struct slot cannot mirror (see the module note). */
  readonly bail: boolean;
  /** Names a prototype, a descriptor define or a `delete` may observe. */
  readonly unsafeNames: ReadonlySet<string>;
  readonly functions: ReadonlyMap<string, FnLike>;
  /** `G.p` → the function names it was bound to at top level. */
  readonly staticProps: ReadonlyMap<string, ReadonlySet<string>>;
}

const factsByFile = new WeakMap<ts.SourceFile, FileFacts>();

/** `function (…) { this.p = <param>; … }` → [p, paramIndex] pairs. */
function thisPropParamWrites(fn: FnLike): [string, number][] {
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined));
  const out: [string, number][] = [];
  for (const stmt of fn.body?.statements ?? []) {
    if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
    const { left, right, operatorToken } = stmt.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(right)) continue;
    if (!ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword) continue;
    const index = params.indexOf(right.text);
    if (index >= 0) out.push([left.name.text, index]);
  }
  return out;
}

/** `Object.prototype` / `Function.prototype` (the receivers every function inherits from). */
function isFunctionProtoHost(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "prototype" &&
    ts.isIdentifier(expr.expression) &&
    (expr.expression.text === "Object" || expr.expression.text === "Function")
  );
}

/** A method installed on a function-proto host: `name → function`. */
function hostMethod(stmt: ts.ExpressionStatement): [string, FnLike] | undefined {
  const e = stmt.expression;
  // Object.prototype.m = function (…) {…}
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const { left, right } = e;
    if (ts.isPropertyAccessExpression(left) && isFunctionProtoHost(left.expression) && ts.isFunctionExpression(right)) {
      return [left.name.text, right];
    }
    return undefined;
  }
  // Object.defineProperty(Object.prototype, "m", { value: function (…) {…} })
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === "Object" &&
    e.expression.name.text === "defineProperty" &&
    e.arguments.length === 3 &&
    isFunctionProtoHost(e.arguments[0]!) &&
    ts.isStringLiteral(e.arguments[1]!) &&
    ts.isObjectLiteralExpression(e.arguments[2]!)
  ) {
    for (const prop of (e.arguments[2] as ts.ObjectLiteralExpression).properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "value" &&
        ts.isFunctionExpression(prop.initializer)
      ) {
        return [(e.arguments[1] as ts.StringLiteral).text, prop.initializer];
      }
    }
  }
  return undefined;
}

/** The string a literal key names, if it is one. */
function literalKey(expr: ts.Expression): string | undefined {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : undefined;
}

/** Scan the whole file for the constructs listed in the module note. */
function safetyScan(ctx: CodegenContext, sf: ts.SourceFile): { bail: boolean; unsafeNames: Set<string> } {
  const unsafeNames = new Set<string>();
  let bail = false;
  const isNumeric = (e: ts.Expression): boolean => ts.isNumericLiteral(e) || ctx.oracle.typeFactOf(e).kind === "number";
  const visit = (node: ts.Node): void => {
    if (bail) return;
    if (ts.isForInStatement(node) || ts.isWithStatement(node)) bail = true;
    if (ts.isIdentifier(node) && node.text === "__proto__") bail = true;
    if (ts.isDeleteExpression(node)) {
      const target = node.expression;
      if (ts.isPropertyAccessExpression(target)) unsafeNames.add(target.name.text);
      else if (ts.isElementAccessExpression(target)) {
        const key = literalKey(target.argumentExpression);
        if (key !== undefined) unsafeNames.add(key);
        else if (!isNumeric(target.argumentExpression)) bail = true;
      } else bail = true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      // X.prototype.N = … / X.prototype = { N: … }
      if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression)) {
        if (left.expression.name.text === "prototype") unsafeNames.add(left.name.text);
      }
      if (
        ts.isPropertyAccessExpression(left) &&
        left.name.text === "prototype" &&
        ts.isObjectLiteralExpression(node.right)
      ) {
        for (const prop of node.right.properties) {
          if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)))
            unsafeNames.add(prop.name.text);
          else bail = true;
        }
      }
      if (ts.isElementAccessExpression(left)) {
        const key = literalKey(left.argumentExpression);
        if (key !== undefined) unsafeNames.add(key);
        else if (!isNumeric(left.argumentExpression)) bail = true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name === "defineProperty") {
        const key = node.arguments[1] && literalKey(node.arguments[1]);
        if (key !== undefined) unsafeNames.add(key);
        else bail = true;
      } else if (BAIL_CALLS.has(name)) bail = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { bail, unsafeNames };
}

function factsOf(ctx: CodegenContext, sf: ts.SourceFile): FileFacts {
  const cached = factsByFile.get(sf);
  if (cached) return cached;
  const { bail, unsafeNames } = safetyScan(ctx, sf);
  const functions = new Map<string, FnLike>();
  const setters = new Map<string, [string, number][]>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) functions.set(stmt.name.text, stmt);
    if (ts.isExpressionStatement(stmt)) {
      const method = hostMethod(stmt);
      if (method) setters.set(method[0], thisPropParamWrites(method[1]));
    }
  }
  const staticProps = new Map<string, Set<string>>();
  const bind = (owner: string, prop: string, fn: string): void => {
    const key = `${owner}.${prop}`;
    const set = staticProps.get(key) ?? new Set<string>();
    set.add(fn);
    staticProps.set(key, set);
  };
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const e = stmt.expression;
    // G.p = F
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(e.left) &&
      ts.isIdentifier(e.left.expression) &&
      ts.isIdentifier(e.right)
    ) {
      bind(e.left.expression.text, e.left.name.text, e.right.text);
    }
    // G.m(…, F, …) with m a this-prop setter
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression)
    ) {
      for (const [prop, index] of setters.get(e.expression.name.text) ?? []) {
        const arg = e.arguments[index];
        if (arg && ts.isIdentifier(arg)) bind(e.expression.expression.text, prop, arg.text);
      }
    }
  }
  const facts: FileFacts = { bail, unsafeNames, functions, staticProps };
  factsByFile.set(sf, facts);
  return facts;
}

/** The delegate a `<callee>.call(this, …)` names, when it resolves to exactly one function. */
function resolveDelegate(callee: ts.Expression, facts: FileFacts): FnLike | undefined {
  if (ts.isIdentifier(callee)) return facts.functions.get(callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const bound = facts.staticProps.get(`${callee.expression.text}.${callee.name.text}`);
    if (bound?.size !== 1) return undefined;
    return facts.functions.get([...bound][0]!);
  }
  return undefined;
}

/** Walk a body without entering nested functions (they bind their own `this`). */
function visitOwnThis(node: ts.Node, visit: (n: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child) && !ts.isArrowFunction(child)) return;
    visit(child);
    visitOwnThis(child, visit);
  });
}

/**
 * Field names `ctor` gains through `X.call(this, …)` delegation (see the module
 * note), excluding nothing the caller already has — the caller filters.
 */
export function callGrownFieldNames(ctx: CodegenContext, ctor: FnLike): string[] {
  if (!ctor.body) return [];
  const facts = factsOf(ctx, ctor.getSourceFile());
  if (facts.bail) return [];
  const names = new Set<string>();
  const seen = new Set<FnLike>([ctor]);
  const scan = (fn: FnLike, depth: number, collectOwn: boolean): void => {
    if (!fn.body) return;
    visitOwnThis(fn.body, (node) => {
      if (
        collectOwn &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !RESERVED.has(node.left.name.text) &&
        !facts.unsafeNames.has(node.left.name.text)
      ) {
        names.add(node.left.name.text);
      }
      if (
        depth < MAX_DEPTH &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "call" &&
        node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const delegate = resolveDelegate(node.expression.expression, facts);
        if (delegate && !seen.has(delegate)) {
          seen.add(delegate);
          scan(delegate, depth + 1, true);
        }
      }
    });
  };
  scan(ctor, 0, false);
  return [...names];
}
