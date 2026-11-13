// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The two selector arms for an empty object literal `{}`. Each requires the
 * literal to initialize an un-annotated identifier binding and classifies every
 * reference to that binding:
 *
 *   - #4471 INERT: no reference at all. The literal lowers to a zero-field
 *     `object.new`.
 *   - #7128 S1 OPEN CARRIER: every reference is a U1 define or a U2 read (see
 *     `isOpenCarrierUse`). The literal lowers to legacy's open-hash `$Object`
 *     (`__new_plain_object`, raw externref), which a define can extend and a
 *     later `o.k` can read; an IR `object.new` could serve neither.
 */

import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import {
  sourceMayWriteGlobalObject,
  sourceRunsDynamicCode,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import { isPrimitiveLiteral } from "./descriptor-literal.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/** An empty object value in either spelling. */
export type EmptyObjectExpression = ts.ObjectLiteralExpression | ts.NewExpression;

/**
 * Where an admitted empty object value lives: #7128's function-local binding
 * holds the raw externref, #7280's dynamic-home script slot holds it boxed onto
 * the dynamic carrier.
 */
export type OpenCarrierHome = "binding" | "dynamic-home";

/**
 * (#7341) `new Object(…)` reaches the realm's `Object`: only lib declarations
 * bind the name and nothing in the file declares it (a script's
 * `function Object() {}` merges with the lib one, so the checker alone cannot
 * tell), nor writes it (`Object = f`, `this.Object = f`), nor can write it
 * unseen (the global object escaping, or dynamic code).
 */
export function isRealmObjectConstruction(
  expr: ts.NewExpression,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): boolean {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "Object" || !isUnshadowedLibBinding(callee, isLibOnlyBinding)) {
    return false;
  }
  const file = expr.getSourceFile();
  return !sourceWritesMemberNamed(file, "Object") && !sourceMayWriteGlobalObject(file) && !sourceRunsDynamicCode(file);
}

/**
 * `{}`, or (#7341) `new Object()` / `new Object` on the realm's `Object`: the
 * same fresh ordinary object (§20.1.1.1 step 3 without a value), which legacy
 * builds with the same `__new_plain_object` call.
 */
export function isEmptyObjectExpression(
  expr: ts.Expression,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): expr is EmptyObjectExpression {
  if (ts.isObjectLiteralExpression(expr)) return expr.properties.length === 0;
  return (
    ts.isNewExpression(expr) && hasNoConstructorArguments(expr) && isRealmObjectConstruction(expr, isLibOnlyBinding)
  );
}

/** `new C()` or `new C`: no argument. */
export function hasNoConstructorArguments(expr: ts.NewExpression): boolean {
  return (expr.arguments?.length ?? 0) === 0;
}

export interface EmptyObjectBinding {
  readonly value: EmptyObjectExpression;
  readonly decl: ts.VariableDeclaration;
  readonly name: ts.Identifier;
  readonly references: readonly ts.Identifier[];
}

/**
 * The binding an empty object value initializes, with every reference to it in
 * `owner` (its projection owner), or undefined.
 *
 * The binding must be a plain, UN-ANNOTATED identifier. An annotation is
 * disqualifying on its own: `any` / `object` / `{}` each pick a different
 * legacy representation for `{}` (an open `$Object` externref built by
 * `__new_plain_object`, or a struct WIDENED with the fields a later expando
 * write adds — see `compileWidenedEmptyObject` in codegen/literals.ts).
 *
 * #4471 — the INERT arm admits the binding only when it is UNREFERENCED. A
 * fieldless `object.new` is itself fine (measured 2026-08-15: it registers as an
 * ordinary struct, emits, instantiates, and matches legacy); the constraint is
 * downstream. The measured failing uses are property read/write (incl. through
 * an `as any` escape), flow into a `dynamic` (`any`) parameter, `typeof`,
 * array-literal element, conditional-expression test, and a `{}` return
 * TypeNode (which `IrType.object` cannot express at all). The 2026-08-15
 * battery tried to admit a whitelist of "obviously inert" reference forms and
 * every candidate leaked: `if (o)` lowered and matched legacy, but
 * `if (o) {…} else {…}` demoted with "if condition must be bool" — the IR has no
 * `ToBoolean` for a ref — and `o ? a : b` demoted too. Neither truthiness nor an
 * alias (`const p = o`, whose own uses no arm tracks) is safe, so the honest
 * inert rule is zero references.
 *
 * References are matched by TEXT, not by symbol, over the WHOLE owner, nested
 * functions included: a capture by an inner closure, a same-named property key
 * or a shadowing binding all count. That over-approximates, which is the safe
 * direction — it can only refuse to claim.
 */
export function emptyObjectBinding(
  expr: EmptyObjectExpression,
  owner: ts.Node | undefined,
): EmptyObjectBinding | undefined {
  const decl = expr.parent;
  if (owner === undefined || !ts.isVariableDeclaration(decl) || decl.initializer !== expr) return undefined;
  if (decl.type !== undefined || !ts.isIdentifier(decl.name)) return undefined;
  const name = decl.name;
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === name.text && node !== name) references.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return { value: expr, decl, name, references };
}

/**
 * #7128 S1 — is `reference` an open-carrier use?
 *
 *   - U1: the target of an `Object.defineProperty` STATEMENT (its result would
 *     alias the carrier) that `isLiteralDefine` says the lane lowers with
 *     literal keys and descriptors (`definesLiteralsOnly`, `descriptor-literal.ts`);
 *   - U2: a named read `o.k` whose key `Object.prototype` does not own and
 *     whose consumer is `isProvenReadConsumer`'s strict comparison. The IR reader
 *     (`__dyn_member_get`) answers undefined for an inherited key, where legacy
 *     and node see the `Object.prototype` method.
 *
 * Any other reference — a write, a method call, passing `o` on, an alias — keeps
 * the literal on legacy. This test is per reference and owner-blind: a read
 * inside a nested function passes it, and the capture is refused instead by the
 * selector's free-variable scope check.
 */
export function isOpenCarrierUse(
  reference: ts.Identifier,
  isLiteralDefine: (call: ts.CallExpression) => boolean,
): boolean {
  const parent = reference.parent;
  if (ts.isCallExpression(parent)) {
    return parent.arguments[0] === reference && ts.isExpressionStatement(parent.parent) && isLiteralDefine(parent);
  }
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    parent.questionDotToken === undefined &&
    ts.isIdentifier(parent.name) &&
    !OBJECT_PROTOTYPE_KEYS.has(parent.name.text) &&
    isProvenReadConsumer(parent)
  );
}

/**
 * The one consumer a U2 read `o.k` is proven for — consumed DIRECTLY, never
 * passed on: one side of a strict `===`/`!==` whose other side is a primitive
 * literal, `null` or the global `undefined`. Everything else stays on legacy, which is
 * correct by construction:
 *   - an alias (`var y = o.k`, `y = o.k`, `return`, `throw`) hands the value to
 *     the dynamic-value scan, whose own gaps (`y.z` must throw on undefined,
 *     `y?.z`) then miscompile;
 *   - arithmetic, relational and loose-equality operands demote after the claim
 *     for some operand kinds (`o.k - "2"`, `o.k == null`), as does `+` — an
 *     untracked gap that predates S1, named in
 *     plan/issues/7128-ir-standalone-define-property-open-object-carrier.md
 *     ("Corrections to the design", item 5);
 *   - ToBoolean, member, element and non-null consumers.
 * Three review rounds on PR #6957 each found a new failing shape in a wider
 * rule; this one is the set they proved exact.
 */
function isProvenReadConsumer(read: ts.PropertyAccessExpression): boolean {
  const consumer = read.parent;
  if (!ts.isBinaryExpression(consumer)) return false;
  const op = consumer.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false;
  const other = consumer.left === read ? consumer.right : consumer.left;
  return (
    isPrimitiveLiteral(other) ||
    other.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(other) && other.text === "undefined" && !declaresUndefined(read.getSourceFile()))
  );
}

/**
 * Is `undefined` possibly a source binding anywhere in `file`? Against a
 * shadowing `var undefined = {}` the comparison is not with the carrier's
 * undefined, and the lowering demotes after the claim. Matched by syntax: an
 * `undefined` identifier in any `name` slot counts, a property name included,
 * which can only refuse.
 */
function declaresUndefined(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined" && (node.parent as { readonly name?: ts.Node }).name === node) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const inKeysByUnit = new WeakMap<ts.Node, boolean>();

/**
 * Every `in` under the enclosing unit of `expr` (its function, or the source
 * file for `<module-init>`), nested functions included, has a string-literal
 * key that `%Object.prototype%` does not own: an own-key probe, which the
 * native `in` answers for a fresh open `$Object` exactly as legacy does. The
 * IR's native `in` (`__extern_has`) does not reach that object's implicit
 * `%Object.prototype%` terminal, while legacy's fixed-name helper answers it
 * for exactly the receivers it knows to be one (#7142 review). Read wherever
 * the IR builds such an object: the #7280 carrier, `Object.create`'s result.
 */
export function unitInKeysAreOwnOnly(expr: ts.Node): boolean {
  let unit: ts.Node = expr.getSourceFile();
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      unit = node;
      break;
    }
  }
  let answer = inKeysByUnit.get(unit);
  if (answer === undefined) {
    answer = true;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        !(ts.isStringLiteral(node.left) && !OBJECT_PROTOTYPE_KEYS.has(node.left.text))
      ) {
        answer = false;
      }
      if (answer) ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
    inKeysByUnit.set(unit, answer);
  }
  return answer;
}
