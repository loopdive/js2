// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Detect bindings whose runtime values cross JavaScript representation domains.
 *
 * The TypeScript checker can keep the initializer's narrow type for JavaScript
 * sources even when a later assignment stores a different runtime kind. A Wasm
 * local cannot do that implicitly: an i32 boolean slot, for example, destroys a
 * later string assignment by coercing it to truthiness. Such bindings need the
 * boxed externref carrier.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { JsTag } from "../../checker/oracle.js";
import type { WidenedCarrierOracle } from "../../checker/usage-inference.js";
import type { ValType } from "../../ir/types.js";
import { annexBExistingVarUpdateNames } from "../annexb-cancel.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

function stripParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

function containingScope(decl: ts.VariableDeclaration): ts.Node {
  for (let node: ts.Node | undefined = decl.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) return node;
    if (ts.isSourceFile(node)) return node;
  }
  return decl.getSourceFile();
}

function carrierDomain(tag: JsTag): string {
  // Boolean and symbol both use i32 physically, but their boxing semantics are
  // distinct, so crossing between them still requires a dynamic carrier.
  return tag;
}

function literalPropertyNames(initializer: ts.ObjectLiteralExpression): Set<string> | null {
  const names = new Set<string>();
  for (const property of initializer.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    const name = property.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))) return null;
    names.add(name.text);
  }
  return names;
}

/**
 * A closed object local is widened by codegen when a later direct write adds a
 * property outside the literal's initial shape. Detect that before any nested
 * function signatures capture the local: changing the physical slot after a
 * lifted function has recorded `(ref $OldShape)` leaves a stale capture ABI and
 * turns the later externref value into an `illegal cast` during closure creation.
 *
 * The object itself may stay on the closed-struct path. Only its local carrier
 * is widened, so statically known consumers can recover the original struct by
 * casting the externref while the capture contract remains stable for the whole
 * enclosing activation.
 */
function bindingHasOutOfShapePropertyWrite(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return false;
  const initialProperties = literalPropertyNames(decl.initializer);
  if (!initialProperties) return false;

  const scope = containingScope(decl);
  let widens = false;
  const visit = (node: ts.Node): void => {
    if (widens) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      let receiver: ts.Expression = node.left.expression;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      if (
        ts.isIdentifier(receiver) &&
        ctx.oracle.variableDeclarationOf(receiver) === decl &&
        !initialProperties.has(node.left.name.text)
      ) {
        widens = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  return widens;
}

/**
 * (#4264) True when `node` sits inside the BODY of a `with` statement, without
 * crossing a function boundary first.
 *
 * The TypeScript checker gives identifiers inside a `with` body no resolvable
 * value declaration — by design, since §14.11's object Environment Record can
 * bind any name at runtime. That is correct for TYPE inference and fatal for
 * CARRIER inference: the walk below asks `variableDeclarationOf` whether an
 * assignment targets `decl`, gets `undefined` for every write inside a `with`,
 * and concludes the binding is single-domain. The slot then keeps the
 * initializer's narrow representation and the assignment is destroyed by
 * coercion — `var st = "parseInt"; with (o) { st = parseInt; }` stores a
 * function externref into a native-string slot and reads back `null`.
 *
 * The predicate is the gate for the name-match fallback: it fires only for
 * sources that actually contain a `with`, so a module without one takes the
 * identical analysis it did before.
 */
function isInsideWithBody(node: ts.Node): boolean {
  let prev: ts.Node | undefined;
  for (let cur: ts.Node | undefined = node; cur; prev = cur, cur = cur.parent) {
    if (prev !== undefined && ts.isWithStatement(cur) && cur.statement === prev) return true;
    if (ts.isFunctionLike(cur)) return false;
  }
  return false;
}

/**
 * (#4264) Does this assignment target `decl`? Normally the oracle answers, but
 * inside a `with` body it cannot (see {@link isInsideWithBody}). There, fall
 * back to a NAME match — and only when the oracle resolved NOTHING, so a genuine
 * inner shadow (which the oracle *does* resolve, to a different declaration)
 * still excludes the write.
 */
function assignmentTargetsDeclaration(
  ctx: CodegenContext,
  target: ts.Identifier,
  decl: ts.VariableDeclaration,
  declName: string,
): boolean {
  const resolved = ctx.oracle.variableDeclarationOf(target);
  if (resolved !== undefined) return resolved === decl;
  return target.text === declName && isInsideWithBody(target);
}

export function bindingHasMixedAssignmentCarrier(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  if (!decl.initializer) return false;

  if (bindingHasOutOfShapePropertyWrite(ctx, decl)) return true;

  const initialTag = ctx.oracle.staticJsTypeOf(decl.initializer);
  if (initialTag === "mixed") return false;
  const initialDomain = carrierDomain(initialTag);
  const declName = decl.name.text;
  const scope = containingScope(decl);
  // (#4131) An Annex B B.3.3 block/`if`/`case`-nested `function F` in this same
  // var scope is a HIDDEN cross-domain assignment to `F`: B.3.3.1 step 3.f writes
  // the function object into the existing var binding when the declaration is
  // evaluated. No `F = …` BinaryExpression exists for the walk below to see, so
  // without this the slot keeps the initializer's narrow representation
  // (`var f = 123` → f64) and the write-back is unrepresentable.
  if (initialDomain !== "function" && annexBExistingVarUpdateNames(scope).has(decl.name.text)) return true;
  let mixed = false;

  // (#4122) `"mixed"` is the oracle's answer for UNRESOLVABLE, not for "proven
  // to cross domains". Treating the two alike makes absence of evidence count
  // as evidence of mixing, which demoted every numeric accumulator fed by a
  // dynamically-dispatched call — `var s = 0; s = s + p.inc();`, the most
  // common shape in ordinary JS — to a boxed carrier, at ~3.5x on the `method`
  // axis.
  //
  // So an unresolvable assignment gets a second question: does the
  // whole-program fixpoint prove EVERY definition of this slot numeric? That
  // verdict is grounded (a slot needs one definition numeric without assuming
  // itself), self-reference-aware (the accumulator shape), and boolean-excluded,
  // so a `true` here means the f64 carrier is the correct representation, not
  // merely a cheaper guess. A resolved cross-domain assignment still demotes
  // regardless — that is #3961's hazard and it is untouched.
  const provenNumeric =
    process.env.JS2WASM_MIXED_CARRIER_NUMERIC !== "0" &&
    initialDomain === "number" &&
    ctx.numericLocalVerdict?.(decl.name, decl.name.text) === true;

  const visit = (node: ts.Node): void => {
    if (mixed) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = stripParens(node.left);
      if (
        ts.isIdentifier(target) &&
        target !== decl.name &&
        assignmentTargetsDeclaration(ctx, target, decl, declName)
      ) {
        const assignedTag = ctx.oracle.staticJsTypeOf(node.right);
        const unresolvable = assignedTag === "mixed";
        if (unresolvable ? !provenNumeric : carrierDomain(assignedTag) !== initialDomain) {
          mixed = true;
          return;
        }
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  return mixed;
}

/**
 * (#4121) Kill switch for the representation-keyed unboxing admission.
 * `JS2WASM_NUMERIC_ADMISSION=0` (also `off`, or an empty value) restores the
 * pre-#4121 behaviour exactly: the usage-inference candidate gate keys on the
 * checker's declared type alone, and a mixed-assignment-carrier demotion is
 * final. Default on — same convention as `JS2WASM_NUMERIC_LOCALS` /
 * `JS2WASM_NUMERIC_RETURNS`.
 */
export function numericAdmissionEnabled(): boolean {
  const value = process.env.JS2WASM_NUMERIC_ADMISSION;
  return value !== "0" && value !== "off" && value !== "";
}

/**
 * (#4121) The predicate `UsageInference` consults to admit a declared-SCALAR
 * binding whose slot codegen is nonetheless about to widen to a boxed carrier.
 *
 * Memoized per declaration: the underlying walk is scope-wide, and admission
 * now asks it once per declaration in a function on top of the existing
 * per-declaration slot-minting query.
 *
 * There is no re-entrancy here — `bindingHasMixedAssignmentCarrier` consults
 * the oracle and the whole-program numeric fixpoint, never `ctx.usageInference`.
 */
export function widenedCarrierOracleFor(ctx: CodegenContext): WidenedCarrierOracle {
  const memo = new WeakMap<ts.VariableDeclaration, boolean>();
  return (decl) => {
    if (!numericAdmissionEnabled()) return false;
    const cached = memo.get(decl);
    if (cached !== undefined) return cached;
    let widened = false;
    try {
      widened = bindingHasMixedAssignmentCarrier(ctx, decl);
    } catch {
      widened = false;
    }
    memo.set(decl, widened);
    return widened;
  };
}

/**
 * (#4121) Resolve the carrier for a binding codegen would demote to the boxed
 * externref slot because of a mixed assignment.
 *
 * A demotion is a statement about what codegen could not RULE OUT. A positive
 * unboxing proof is a statement about what it can RULE IN, and it outranks the
 * demotion: route 1 (#684) proves every USE applies ToNumber — so an f64 slot
 * is observationally identical even when a string is assigned to it — and
 * route 2 (#3765) proves every DEFINITION is a number, so no cross-domain
 * assignment exists at all. #3961's hazard (an i32 boolean slot silently
 * coercing a later string assignment to truthiness) is untouched: that slot is
 * i32, not f64, and neither route admits booleans.
 *
 * Returns the proven `f64` carrier, or `null` when the demotion stands.
 */
export function numericProofOverridesMixedCarrier(provenF64: ValType | null): ValType | null {
  return numericAdmissionEnabled() ? provenF64 : null;
}

export function effectiveLocalCarrier(fctx: FunctionContext, expression: ts.Expression, fallback: ValType): ValType {
  if (!ts.isIdentifier(expression)) return fallback;
  const localIdx = fctx.localMap.get(expression.text);
  return localIdx === undefined ? fallback : (getLocalType(fctx, localIdx) ?? fallback);
}
