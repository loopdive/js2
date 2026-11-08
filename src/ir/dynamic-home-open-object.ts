// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7335 (lever D, slice 1) — a script's top-level `var o = {}` as the IR's
 * `dynamic` script-var home. Where legacy keeps such a binding as the open
 * `$Object` in its externref slot (the selector's `isOpenObjectBinding`, #7128
 * S1), the module-binding resolver already reads that slot as `dynamic`
 * (`scriptVarHome`, #7132), so an IR unit and a legacy unit share one store
 * whoever runs the initializer. The selector hooks in `select.ts` admit the
 * initializer (the open carrier's `__new_plain_object`), a U1 define on the
 * binding from any unit, and `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)`
 * through the `dyn.own_property` provider.
 *
 * The binding qualifies only when every reference is one of the consumers the
 * dynamic operations serve ({@link isServedUse}); any other use, an alias
 * included, keeps the whole binding on legacy. An allow-list, because a
 * deny-list of the uses that miscompile has to anticipate every spelling of
 * them.
 */

import { bindingIsUniqueAndNeverWritten, isStoreTarget, outermostParenthesized } from "../shared/binding-writes.js";
import {
  sourceMayPatchPrototype,
  sourceNamesReflectiveRoute,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import { emptyObjectLiteralBinding, isOpenCarrierUse } from "./empty-object-literal.js";
import type { IrLegacyModuleBindingIdentity } from "./module-bindings.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/** What the selector answers about a binding. */
export interface DynamicHomeQuery {
  readonly resolve: ((id: ts.Identifier) => IrLegacyModuleBindingIdentity | undefined) | null;
  /** Legacy's answer (#7128 S1); present only on the lane whose IR lowers an open carrier. */
  readonly isOpenObjectBinding: ((decl: ts.VariableDeclaration) => boolean) | undefined;
  readonly isAmbientDefineProperty: (call: ts.CallExpression) => boolean;
}

/** `decl` is a dynamic-home open object that legacy keeps open in the slot the resolver reads as `dynamic`. */
export function isDeclaration(decl: ts.VariableDeclaration, query: DynamicHomeQuery): boolean {
  return (
    query.isOpenObjectBinding !== undefined &&
    isScriptEmptyLiteralVar(decl) &&
    everyUseIsServed(decl, query) &&
    query.isOpenObjectBinding(decl) &&
    query.resolve?.(decl.name as ts.Identifier)?.valueKind.kind === "dynamic"
  );
}

/** `id` reads a dynamic-home open object ({@link isDeclaration}). */
export function isReference(id: ts.Identifier, query: DynamicHomeQuery): boolean {
  const declaration = query.resolve?.(id)?.declaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration) && isDeclaration(declaration, query);
}

/** The `Object.prototype` own-property tests a dynamic-home open object answers through `dyn.own_property`. */
export type OwnPropertyMethod = "hasOwnProperty" | "propertyIsEnumerable";

/** `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)` on a dynamic-home open object. */
export function ownPropertyMethod(call: ts.CallExpression, query: DynamicHomeQuery): OwnPropertyMethod | undefined {
  const method = ownPropertyCallMethod(call);
  if (method === undefined) return undefined;
  const receiver = (call.expression as ts.PropertyAccessExpression).expression;
  return ts.isIdentifier(receiver) && isReference(receiver, query) ? method : undefined;
}

/** A top-level `var <id> = {}` of a script: unannotated, a plain identifier. */
function isScriptEmptyLiteralVar(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  return (
    decl.type === undefined &&
    ts.isIdentifier(decl.name) &&
    decl.initializer !== undefined &&
    ts.isObjectLiteralExpression(decl.initializer) &&
    decl.initializer.properties.length === 0 &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.BlockScoped) === 0 &&
    ts.isVariableStatement(list.parent) &&
    ts.isSourceFile(list.parent.parent) &&
    !ts.isExternalModule(list.parent.parent)
  );
}

const servedByDeclaration = new WeakMap<ts.VariableDeclaration, boolean>();

/**
 * The binding only ever holds the literal's object, `Object.prototype` is the
 * realm's own, and every reference is served:
 *   - declared once and never written in any spelling, with no `eval` or
 *     `with` (`bindingIsUniqueAndNeverWritten`), and no member of its name
 *     stored or defined (`this.o = v` writes a script `var`);
 *   - no patch of `Object.prototype` and no reflective route to a prototype
 *     (`Object.setPrototypeOf(o, …)`, `__proto__`, `Reflect`).
 */
function everyUseIsServed(decl: ts.VariableDeclaration, query: DynamicHomeQuery): boolean {
  let served = servedByDeclaration.get(decl);
  if (served === undefined) {
    const name = decl.name as ts.Identifier;
    const file = decl.getSourceFile();
    const binding = emptyObjectLiteralBinding(decl.initializer as ts.ObjectLiteralExpression, file);
    served =
      bindingIsUniqueAndNeverWritten(name, decl) &&
      !sourceWritesMemberNamed(file, name.text) &&
      !sourceMayPatchPrototype(file, "Object") &&
      !sourceNamesReflectiveRoute(file) &&
      binding !== undefined &&
      binding.references.every((reference) => isServedUse(reference, query));
    servedByDeclaration.set(decl, served);
  }
  return served;
}

/**
 * One reference the dynamic operations serve, judged on its outermost
 * parenthesized form:
 *   - `o.<key>` read, not called, where `Object.prototype` does not own `<key>` (the
 *     reader does not reach an inherited member: #7128's U2 key screen), or a
 *     plain `o.<key> = v` in `<module-init>` or a top-level function, whose
 *     code strictness `dyn.member_set` is told;
 *   - the target of a U1 define statement (`isOpenCarrierUse`);
 *   - the receiver of `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)`;
 *   - a strict `===` / `!==` operand, a `typeof` operand.
 * Anything else is not served: an alias, an element access, a loose `==`, a
 * condition, and a call argument, through which other code could install an
 * own `hasOwnProperty` under a key no scan sees (`g(o, "has" + "Own…")`).
 */
function isServedUse(reference: ts.Identifier, query: DynamicHomeQuery): boolean {
  const use = outermostParenthesized(reference);
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
    if (ts.isCallExpression(parent.parent) && ownPropertyCallMethod(parent.parent) !== undefined) return true;
    if (parent.questionDotToken !== undefined || OBJECT_PROTOTYPE_KEYS.has(parent.name.text)) return false;
    // `o.m()` / ``o.m`…` `` hands `o` to arbitrary code as `this`, which could install an own method.
    const member = outermostParenthesized(parent);
    const user = member.parent;
    if (
      (ts.isCallExpression(user) && user.expression === member) ||
      (ts.isTaggedTemplateExpression(user) && user.tag === member)
    )
      return false;
    if (!isStoreTarget(parent) && !ts.isDeleteExpression(user)) return true;
    return isPlainAssignmentTarget(parent) && writerKnowsItsStrictness(parent);
  }
  if (use === reference && isOpenCarrierUse(reference, query.isAmbientDefineProperty)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  }
  return ts.isTypeOfExpression(parent);
}

/** `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)` with one plain argument, the method never replaced. */
function ownPropertyCallMethod(call: ts.CallExpression): OwnPropertyMethod | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return undefined;
  const method = callee.name.text;
  if (method !== "hasOwnProperty" && method !== "propertyIsEnumerable") return undefined;
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return undefined;
  return methodIsOnlyRead(call.getSourceFile(), method) ? method : undefined;
}

const readOnlyMethodsByFile = new WeakMap<ts.SourceFile, ReadonlySet<OwnPropertyMethod>>();

/**
 * Every mention of `method` in the source is the name of a plain member read
 * (`Object.prototype.hasOwnProperty.call(…)`, `o.hasOwnProperty(k)`): no store,
 * delete or define of it (`sourceWritesMemberNamed`), and no other spelling
 * (`{ hasOwnProperty: f }`, `"hasOwnProperty"`) that could install one.
 */
function methodIsOnlyRead(file: ts.SourceFile, method: OwnPropertyMethod): boolean {
  let readOnly = readOnlyMethodsByFile.get(file);
  if (readOnly === undefined) {
    const mentioned = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) mentioned.add(node.text);
      else if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        mentioned.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const methods: OwnPropertyMethod[] = ["hasOwnProperty", "propertyIsEnumerable"];
    readOnly = new Set(methods.filter((name) => !mentioned.has(name) && !sourceWritesMemberNamed(file, name)));
    readOnlyMethodsByFile.set(file, readOnly);
  }
  return readOnly.has(method);
}

/** `target = v`: a plain assignment, not compound, logical or destructuring. */
function isPlainAssignmentTarget(target: ts.Expression): boolean {
  const user = outermostParenthesized(target).parent;
  return (
    ts.isBinaryExpression(user) &&
    user.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    user.left === outermostParenthesized(target)
  );
}

/** The write sits in `<module-init>` or a top-level function, the code whose strictness lowering is told. */
function writerKnowsItsStrictness(node: ts.Node): boolean {
  const owner = ts.findAncestor(node.parent, ts.isFunctionLike);
  return owner === undefined || (ts.isFunctionDeclaration(owner) && ts.isSourceFile(owner.parent));
}
