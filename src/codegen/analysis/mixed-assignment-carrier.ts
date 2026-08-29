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
import { initializerMayProduceHostCallable } from "./host-callable-initializer.js";

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

interface AssignmentFact {
  /** Identifier on the left, retained for the declaration-name self guard. */
  target: ts.Identifier;
  /** RHS is deliberately retained as syntax, not a phase-sensitive type verdict. */
  value: ts.Expression;
  /** Source-walk order, so resolved and `with` fallback facts can be merged exactly. */
  order: number;
}

interface ScopeCarrierFacts {
  assignmentsByDeclaration: WeakMap<ts.VariableDeclaration, AssignmentFact[]>;
  unresolvedWithAssignmentsByName: Map<string, AssignmentFact[]>;
  propertyWritesByDeclaration: WeakMap<ts.VariableDeclaration, Set<string>>;
}

/**
 * Per-(codegen context, var scope) syntax index shared by every carrier query.
 *
 * A large bundled factory can declare hundreds of locals in one scope. Walking
 * its entire AST once for every declaration made hoisting quadratic (the
 * TypeScript 5.9 bundle has 928 outer vars and over a million nodes once nested
 * bodies are included). Keep only declaration-identity facts here; the
 * phase-sensitive numeric and static-type verdicts remain query-time work.
 */
const scopeCarrierFactsByContext = new WeakMap<CodegenContext, WeakMap<ts.Node, ScopeCarrierFacts>>();

function pushWeakFact<K extends object>(map: WeakMap<K, AssignmentFact[]>, key: K, fact: AssignmentFact): void {
  const facts = map.get(key);
  if (facts) facts.push(fact);
  else map.set(key, [fact]);
}

function pushNamedFact(map: Map<string, AssignmentFact[]>, name: string, fact: AssignmentFact): void {
  const facts = map.get(name);
  if (facts) facts.push(fact);
  else map.set(name, [fact]);
}

function scopeCarrierFacts(ctx: CodegenContext, scope: ts.Node): ScopeCarrierFacts {
  let byScope = scopeCarrierFactsByContext.get(ctx);
  if (!byScope) {
    byScope = new WeakMap();
    scopeCarrierFactsByContext.set(ctx, byScope);
  }
  const cached = byScope.get(scope);
  if (cached) return cached;

  const facts: ScopeCarrierFacts = {
    assignmentsByDeclaration: new WeakMap(),
    unresolvedWithAssignmentsByName: new Map(),
    propertyWritesByDeclaration: new WeakMap(),
  };
  let order = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = stripParens(node.left);
      if (ts.isIdentifier(target)) {
        const resolved = ctx.oracle.variableDeclarationOf(target);
        const fact: AssignmentFact = { target, value: node.right, order: order++ };
        if (resolved !== undefined) {
          pushWeakFact(facts.assignmentsByDeclaration, resolved, fact);
        } else if (isInsideWithBody(target)) {
          // The checker intentionally resolves no identifier inside a `with`
          // body. Preserve the existing tightly-bounded name fallback.
          pushNamedFact(facts.unresolvedWithAssignmentsByName, target.text, fact);
        }
      } else if (ts.isPropertyAccessExpression(node.left)) {
        // Keep the old out-of-shape predicate exact: it accepted parentheses
        // around the receiver, but not around the entire assignment target.
        const propertyTarget = node.left;
        const receiver = stripParens(propertyTarget.expression);
        if (ts.isIdentifier(receiver)) {
          const resolved = ctx.oracle.variableDeclarationOf(receiver);
          if (resolved !== undefined) {
            let names = facts.propertyWritesByDeclaration.get(resolved);
            if (!names) {
              names = new Set();
              facts.propertyWritesByDeclaration.set(resolved, names);
            }
            names.add(propertyTarget.name.text);
          }
        }
      }
    }
    // Deliberately cross nested function boundaries. An inner closure can
    // assign to or grow a captured outer binding, changing its required ABI.
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  byScope.set(scope, facts);
  return facts;
}

/**
 * True when Annex B will write a block-level function object into this
 * existing `var` binding while evaluating the enclosing var scope. That write
 * is implicit in the AST, so the binding must remain boxed even when usage
 * inference proves all visible uses numeric.
 */
export function bindingHasAnnexBExistingVarUpdate(decl: ts.VariableDeclaration): boolean {
  return ts.isIdentifier(decl.name) && annexBExistingVarUpdateNames(containingScope(decl)).has(decl.name.text);
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
  const writtenProperties = scopeCarrierFacts(ctx, scope).propertyWritesByDeclaration.get(decl);
  if (!writtenProperties) return false;
  for (const name of writtenProperties) {
    if (!initialProperties.has(name)) return true;
  }
  return false;
}

/**
 * True when an initialized binding can receive a genuine JavaScript function
 * externref, either initially or through a later simple assignment.
 *
 * A host function and a compiled closure share JavaScript's `function` type but
 * not a Wasm representation.  This proof therefore complements the JsTag
 * comparison below: both values report the same tag even though a closure-ref
 * slot would null the host value during coercion.
 */
export function bindingMayReceiveHostCallable(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer || ctx.standalone || ctx.wasi) return false;
  if (initializerMayProduceHostCallable(ctx, decl.initializer)) return true;

  const facts = scopeCarrierFacts(ctx, containingScope(decl));
  const resolved = facts.assignmentsByDeclaration.get(decl) ?? [];
  const unresolvedWith = facts.unresolvedWithAssignmentsByName.get(decl.name.text) ?? [];
  return [...resolved, ...unresolvedWith].some(
    (fact) => fact.target !== decl.name && initializerMayProduceHostCallable(ctx, fact.value),
  );
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
 * Decide whether the initialized binding must use a carrier that can represent
 * assignments from more than one JavaScript domain. The scope index preserves
 * exact declaration identity; only oracle-unresolved targets inside a `with`
 * body use the narrowly bounded name fallback described above.
 */
export function bindingHasMixedAssignmentCarrier(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  if (!decl.initializer) return false;

  if (bindingHasOutOfShapePropertyWrite(ctx, decl)) return true;
  if (bindingMayReceiveHostCallable(ctx, decl)) return true;

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
  if (initialDomain !== "function" && bindingHasAnnexBExistingVarUpdate(decl)) return true;
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

  const indexed = scopeCarrierFacts(ctx, scope);
  const resolvedFacts = indexed.assignmentsByDeclaration.get(decl) ?? [];
  const unresolvedWithFacts = indexed.unresolvedWithAssignmentsByName.get(declName) ?? [];
  // The two tables are separately keyed to preserve exact declaration identity
  // and the bounded `with` fallback. Merge by walk order so query-time oracle
  // calls retain the old traversal's short-circuit order.
  let resolvedIndex = 0;
  let unresolvedIndex = 0;
  while (resolvedIndex < resolvedFacts.length || unresolvedIndex < unresolvedWithFacts.length) {
    const resolvedFact = resolvedFacts[resolvedIndex];
    const unresolvedFact = unresolvedWithFacts[unresolvedIndex];
    const fact =
      unresolvedFact === undefined || (resolvedFact !== undefined && resolvedFact.order < unresolvedFact.order)
        ? resolvedFacts[resolvedIndex++]!
        : unresolvedWithFacts[unresolvedIndex++]!;
    if (fact.target === decl.name) continue;
    const assignedTag = ctx.oracle.staticJsTypeOf(fact.value);
    const unresolvable = assignedTag === "mixed";
    if (unresolvable ? !provenNumeric : carrierDomain(assignedTag) !== initialDomain) {
      mixed = true;
      break;
    }
  }
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
