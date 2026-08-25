// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4482) Source-level "did this module install its own `<name>` slot?" scans.
 *
 * These sit next to — not inside — `calls.ts`'s `sourceHasMethodReassignment`
 * (#1397) because they answer the same question at two DIFFERENT precisions,
 * and which precision an arm needs depends on which direction it is gating:
 *
 * | predicate | precision | correct for |
 * | --- | --- | --- |
 * | `sourceHasMethodReassignment` (#1397, `calls.ts`) | whole file, assignment only | admitting a dynamic exit |
 * | `sourceHasMethodOverride` | whole file, assignment ∪ `defineProperty` | admitting a dynamic exit |
 * | `sourceOverridesMethodOnReceiver` | this binding, assignment ∪ `defineProperty` | DECLINING a static arm |
 *
 * The distinction is load-bearing and is the campaign's absent-not-wrong rule
 * applied to a compile-time scan: over-admitting a dynamic exit costs a fast
 * path, while over-declining a static arm produces a WRONG answer for a
 * receiver that never acquired the slot.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { sourceHasMethodReassignment } from "./calls.js";

/**
 * (#4482) True when the source installs `<name>` on some object by a route
 * `sourceHasMethodReassignment` cannot see: `Object.defineProperty(X, "<name>",
 * …)` or `Object.defineProperties(X, { <name>: … })`.
 *
 * §15.x.4 "is not generic" test262 rows come in pairs — one block transfers the
 * intrinsic by ASSIGNMENT (`s.valueOf = Number.prototype.valueOf`), the other by
 * `Object.defineProperty`. The assignment half is already gated by #1397; the
 * defineProperty half was invisible, so a static arm kept answering a value
 * where the transferred method must throw (measured 2026-08-15:
 * `Number/prototype/{toString,valueOf}/…_T03`).
 *
 * Same conservative scan discipline as `sourceHasMethodReassignment`: the whole
 * SourceFile, any receiver expression, cached per `(sourceFile, name)`. A false
 * positive only costs a static fast path on that member name.
 */
const _definePropertyCache = new WeakMap<ts.SourceFile, Map<string, boolean>>();
function sourceHasDefinePropertyOverride(anchor: ts.Node, methodName: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  let perFile = _definePropertyCache.get(sf);
  if (perFile === undefined) {
    perFile = new Map<string, boolean>();
    _definePropertyCache.set(sf, perFile);
  }
  const cached = perFile.get(methodName);
  if (cached !== undefined) return cached;

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression.name.text;
      if (callee === "defineProperty" && node.arguments.length >= 2) {
        const key = node.arguments[1];
        if (key !== undefined && ts.isStringLiteralLike(key) && key.text === methodName) {
          found = true;
          return;
        }
      }
      if (callee === "defineProperties" && node.arguments.length >= 2) {
        const descs = node.arguments[1];
        if (descs !== undefined && ts.isObjectLiteralExpression(descs)) {
          for (const p of descs.properties) {
            const n = p.name;
            if (n === undefined) continue;
            if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === methodName) {
              found = true;
              return;
            }
          }
        }
      }
    }
    forEachChild(node, visit);
  }
  visit(sf);
  perFile.set(methodName, found);
  return found;
}

/**
 * (#4482) `sourceHasMethodReassignment` ∪ `sourceHasDefinePropertyOverride` —
 * "the source installs an own `<methodName>` slot somewhere, by either route".
 *
 * This is the predicate a static builtin-method arm should consult before
 * answering from the receiver's STATIC type: once a program can install its own
 * `<name>`, the arm's answer is only correct if nothing overrode it, which the
 * arm cannot know. Declining routes the call to the reflective dispatch, whose
 * bodies already carry the §15.x.4 brand preamble (verified 2026-08-15: the
 * expando-named half of every one of these rows — `s.myValueOf = …` — already
 * throws a real `TypeError`, so only the interception is missing).
 */
export function sourceHasMethodOverride(ctx: CodegenContext, anchor: ts.Node, methodName: string): boolean {
  return sourceHasMethodReassignment(ctx, anchor, methodName) || sourceHasDefinePropertyOverride(anchor, methodName);
}

/**
 * True when this source mutates the exact ambient
 * `<builtin>.prototype.<methodName>` property.  This is intentionally more
 * precise than the historical whole-file reassignment scan: the Test262
 * harness commonly assigns `Test262Error.prototype.toString`, which must not
 * disable an unrelated Number/Boolean prototype fast path, while a direct
 * `Number.prototype.toString = …` write must.
 */
const _builtinPrototypeOverrideCache = new WeakMap<ts.SourceFile, Map<string, boolean>>();
export function sourceOverridesBuiltinPrototypeMember(
  ctx: CodegenContext,
  anchor: ts.Node,
  builtinName: string,
  methodName: string,
): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  const key = `${builtinName}.prototype.${methodName}`;
  let perFile = _builtinPrototypeOverrideCache.get(sf);
  if (perFile === undefined) {
    perFile = new Map<string, boolean>();
    _builtinPrototypeOverrideCache.set(sf, perFile);
  }
  const cached = perFile.get(key);
  if (cached !== undefined) return cached;

  const isAmbientBuiltin = (id: ts.Identifier): boolean => {
    const declaration = ctx.oracle.valueDeclarationOf(id);
    return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
  };
  const isTarget = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === methodName &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "prototype" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === builtinName &&
    isAmbientBuiltin(node.expression.expression);

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isTarget(node.left)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (
        callee.name.text === "defineProperty" &&
        node.arguments.length >= 2 &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        isAmbientBuiltin(callee.expression) &&
        isTarget(node.arguments[0]!) &&
        ts.isStringLiteralLike(node.arguments[1]!) &&
        node.arguments[1]!.text === methodName
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(sf);
  perFile.set(key, found);
  return found;
}

/**
 * (#4482) The RECEIVER-PRECISE form of {@link sourceHasMethodOverride}: the
 * source installs `<methodName>` **on the same identifier** this call reads —
 * `d.valueOf = …` or `Object.defineProperty(d, "valueOf", …)` for a call
 * `d.valueOf()`.
 *
 * The conservative whole-file scan is the right admission test for an arm that
 * sits AFTER every static arm has declined (nothing is lost by over-admitting
 * there). It is the WRONG test for gating a static arm OFF, because declining
 * on an unrelated `x.valueOf = …` elsewhere in the file would drop a correct
 * native answer for a receiver that never had an own slot — a wrong answer on a
 * maybe, which the campaign's absent-not-wrong rule forbids. Matching the
 * receiver identifier keeps the decline to bindings that provably acquire the
 * slot, so a module that does not override on THAT binding compiles unchanged.
 *
 * Non-identifier receivers answer `false` (nothing to match), which is the
 * conservative direction: the static arm stays.
 */
export function sourceOverridesMethodOnReceiver(
  recvExpr: ts.Expression,
  methodName: string,
  // (#4482) Optional: enables the CONSTRUCTED-INSTANCE half below, which needs
  // to resolve `a` in `a.toString()` back to its `new A(…)` initializer. Absent
  // ctx keeps the pre-existing binding-only behaviour exactly.
  ctx?: CodegenContext,
): boolean {
  if (!ts.isIdentifier(recvExpr)) return false;
  const recvName = recvExpr.text;
  const sf = recvExpr.getSourceFile();
  if (!sf) return false;

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name) &&
      node.left.name.text === methodName &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === recvName
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2
    ) {
      const target = node.arguments[0];
      const key = node.arguments[1];
      if (
        target !== undefined &&
        key !== undefined &&
        ts.isIdentifier(target) &&
        target.text === recvName &&
        ts.isStringLiteralLike(key) &&
        key.text === methodName
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }
  visit(sf);
  if (found) return true;
  return constructedInstanceInstallsMethod(recvExpr, methodName, ctx);
}

/**
 * (#4482) The CONSTRUCTED-INSTANCE half of {@link sourceOverridesMethodOnReceiver}.
 *
 * A binding initialized from `new A(…)` acquires whatever `A`'s constructor
 * installs on `this`, and the binding-name scan above cannot see it — the
 * assignment's receiver is `this`, not the binding. So
 *
 *     function A(v){ this.value = v;
 *                    this.toString = function(){ return this.value + ""; } }
 *     new A(7).toString();      // must be "7"; answered "[object Object]"
 *
 * kept the static `Object.prototype.toString` arm and never saw the own slot —
 * while `String(a)` and `"" + a` (which go through the reflective dispatcher)
 * already answered `"7"`. Declining routes the direct call to that same
 * dispatcher.
 *
 * Receiver-precise like its caller: the binding must resolve to ONE variable
 * declaration whose initializer is `new <Id>(…)`, and the installing write must
 * be DIRECTLY in that constructor's body (not inside a nested function, whose
 * `this` is a different binding). A constructor that installs nothing keeps the
 * static arm, so a module without this pattern compiles byte-identically.
 */
function constructedInstanceInstallsMethod(
  recvExpr: ts.Identifier,
  methodName: string,
  ctx: CodegenContext | undefined,
): boolean {
  if (ctx === undefined) return false;
  const binding = ctx.oracle.valueDeclarationOf(recvExpr);
  if (binding === undefined || !ts.isVariableDeclaration(binding) || binding.initializer === undefined) return false;
  const init = binding.initializer;
  if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) return false;
  const ctorDecl = ctx.oracle.valueDeclarationOf(init.expression);
  if (ctorDecl === undefined) return false;
  const body = ts.isFunctionDeclaration(ctorDecl)
    ? ctorDecl.body
    : ts.isVariableDeclaration(ctorDecl) &&
        ctorDecl.initializer !== undefined &&
        (ts.isFunctionExpression(ctorDecl.initializer) || ts.isArrowFunction(ctorDecl.initializer))
      ? (ctorDecl.initializer.body as ts.Node | undefined)
      : undefined;
  if (body === undefined || !ts.isBlock(body)) return false;

  let installs = false;
  function visit(node: ts.Node): void {
    if (installs) return;
    // `this` inside a nested function is NOT the instance under construction.
    if (node !== body && ts.isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === methodName &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      installs = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  if (installs) return true;
  return ctorPrototypeInstallsMethod(init.expression, methodName);
}

/**
 * (#2875 b2) The PROTOTYPE-INSTALLED half of {@link constructedInstanceInstallsMethod}.
 *
 * `constructedInstanceInstallsMethod` only sees slots the constructor writes on
 * `this`. The other ES5 way to give an instance a `toString` is the prototype:
 *
 *     function F(v){ this.value = v; }
 *     F.prototype.toString = function(){ return this.value + ""; };
 *     new F(7).toString();          // must be "7"
 *
 * — and that write's receiver is `F.prototype`, which neither the binding scan
 * nor the `this` scan matches. So the caller kept the static
 * `Object.prototype.toString` arm and answered "[object Object]".
 *
 * Matches a WHOLE-property write `<Ctor>.prototype.<methodName> = …` anywhere
 * in the constructor's file. Deliberately not receiver-precise beyond the
 * constructor identity: the prototype object is shared by every instance of
 * `F`, so one such write shadows the inherited member for all of them.
 */
function ctorPrototypeInstallsMethod(ctorId: ts.Identifier, methodName: string): boolean {
  const sf = ctorId.getSourceFile();
  if (!sf) return false;
  let installs = false;
  function visit(node: ts.Node): void {
    if (installs) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === methodName &&
      ts.isPropertyAccessExpression(node.left.expression) &&
      node.left.expression.name.text === "prototype" &&
      ts.isIdentifier(node.left.expression.expression) &&
      node.left.expression.expression.text === ctorId.text
    ) {
      installs = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(sf);
  return installs;
}
