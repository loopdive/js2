// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * What a program does to the prototypes of `Array`, `Function`, `Object`,
 * `RegExp` and `String`, and to the global object, from one pure-AST walk over
 * every mention of them. The consumers ask these questions:
 *
 *   - {@link sourceWritesPrototype}: the legacy array-iteration brand (#1719,
 *     `sourceOverridesArrayIterator`) asks whether the program writes a member
 *     with `=`, deletes one, or passes the prototype to
 *     `Object.defineProperty`/`defineProperties`. Its byte-identity contract
 *     pins exactly that set.
 *   - {@link sourceMayPatchPrototype}: the IR's destructuring readers and its
 *     `String.prototype.<m>.call` borrow (#7106) assume the realm's own
 *     prototypes, so they ask the conservative question. A prototype
 *     (`Array.prototype`, `globalThis.Object.prototype`,
 *     …) may be patched unless every mention of it is the object of a plain
 *     member read (`Array.prototype.map.call(…)`). A stored-into member
 *     (compound, logical and destructuring targets included), a deleted one, a
 *     call with the prototype as `this` (`Object.prototype.__defineGetter__`)
 *     and any escape (`Reflect.set(Array.prototype, …)`, `Object.assign`,
 *     `Object.setPrototypeOf`, an alias, an operand) all count. So does any
 *     escape of the constructor itself (`var S = String; S.prototype.m = f`,
 *     `f(String)`, `String["prototype"]`): only a call, a `new`, a member
 *     read and a `typeof` / `instanceof` / equality operand are inert. A
 *     constructor reached as a member of any object (`globalThis["String"]`,
 *     `this.String`) is the constructor. A patch that
 *     never names the prototype (`%ArrayIteratorPrototype%` reached through
 *     `Object.getPrototypeOf`) is not seen by it; a consumer that must also
 *     exclude those routes asks {@link sourceNamesReflectiveRoute}, and
 *     {@link sourceWritesMemberNamed} for a member it reads by name.
 *   - {@link sourceMayWriteGlobalObject}: the always-`undefined` `var` proof
 *     asks whether a global `var` may be written as a property of the global
 *     object under a name the source does not spell: `this`, `globalThis`,
 *     `self`, `window` or `global` anywhere but an inert use (`this[k] = v`,
 *     `Object.assign(this, …)`).
 *   - {@link sourceRunsDynamicCode}: the same consumers ask whether code the
 *     walk cannot see may run (`eval`, `Function`, by any name route).
 *   - The IR's own-property tests (#7339) ask whether any object may carry an
 *     own member of a name: {@link sourceSpellsName} (the name spelled other
 *     than as a member read's name), {@link sourceMayWriteUnspelledMember} (a
 *     member installed under a name the source does not spell) and
 *     {@link sourceCreatePrototypes} (what every `Object.create` makes from).
 */
import { forEachChild, ts } from "../ts-api.js";
import { isUndeclaredInFile, isUnshadowedGlobalConstant } from "./ambient-intrinsics.js";
import { isBindingSiteName, isStoreTarget, skipOuterExpressions } from "./binding-writes.js";

export type PatchableIntrinsic = "Array" | "Boolean" | "Function" | "Number" | "Object" | "RegExp" | "String";

interface PrototypeUse {
  readonly writes: Set<PatchableIntrinsic>;
  readonly mayPatch: Set<PatchableIntrinsic>;
  /** Names the source stores into, deletes or defines on anything: `x.call = f`, `String = v`. */
  readonly writtenNames: Set<string>;
  /** The source names a {@link REFLECTIVE_NAMES} route or has a `with` statement. */
  reflective: boolean;
  /** The global object (`this`, `globalThis`, `self`, `window`, `global`) has a use other than an inert one. */
  globalObjectEscapes: boolean;
  /** `eval` or `Function` is read other than as an operand or for its `prototype`: code the walk cannot see may run. */
  dynamicCode: boolean;
  /** A member may be installed under a name the source does not spell ({@link installsUnspelledMember}). */
  unspelledWrite: boolean;
  /** Names spelled other than as a member read's name: string literals, bindings, keys, references. */
  readonly spelledNames: Set<string>;
  /** The prototype operand of every mention of `Object.create`; `null` where it is not called directly. */
  readonly createPrototypes: (ts.Expression | null)[];
}

const PATCHABLE: ReadonlySet<string> = new Set<PatchableIntrinsic>([
  "Array",
  "Boolean",
  "Function",
  "Number",
  "Object",
  "RegExp",
  "String",
]);

/** Names the global object goes by: the standard one and the hosts' (`$262.global` included). */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(["globalThis", "self", "window", "global"]);

/** Names that run source text as code. */
const DYNAMIC_CODE_NAMES: ReadonlySet<string> = new Set(["eval", "Function"]);

/**
 * Names that reach a prototype without spelling `X.prototype`:
 * `Object.getPrototypeOf(v)`, `v.__proto__`, `Reflect.set(…)`,
 * `v.constructor.prototype`. (#7106 lever O refuses the same names for
 * `Object`'s statics; the two lists merge into one helper.)
 */
const REFLECTIVE_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "getPrototypeOf",
  "setPrototypeOf",
  "__proto__",
  "Reflect",
]);

const cache = new WeakMap<ts.SourceFile, PrototypeUse>();

export function sourceWritesPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).writes.has(intrinsic);
}

export function sourceMayPatchPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).mayPatch.has(intrinsic);
}

/**
 * Whether the source names a route to a prototype that does not spell it: a
 * {@link REFLECTIVE_NAMES} name (an observed `constructor` aside) or `with`.
 */
export function sourceNamesReflectiveRoute(sourceFile: ts.SourceFile): boolean {
  return prototypeUse(sourceFile).reflective;
}

/** Whether the global object escapes, so a global property may be written under a computed name. */
export function sourceMayWriteGlobalObject(sourceFile: ts.SourceFile): boolean {
  return prototypeUse(sourceFile).globalObjectEscapes;
}

/** Whether the source may run code it does not spell: `eval` (direct or indirect) or `Function`, by any name route. */
export function sourceRunsDynamicCode(sourceFile: ts.SourceFile): boolean {
  return prototypeUse(sourceFile).dynamicCode;
}

/** Whether a member may be installed under a name the source does not spell ({@link installsUnspelledMember}). */
export function sourceMayWriteUnspelledMember(sourceFile: ts.SourceFile): boolean {
  return prototypeUse(sourceFile).unspelledWrite;
}

/** Whether the source spells `name` other than as a member read's name (`"hasOwnProperty"`, `{ hasOwnProperty: f }`). */
export function sourceSpellsName(sourceFile: ts.SourceFile, name: string): boolean {
  return prototypeUse(sourceFile).spelledNames.has(name);
}

/** The prototype operand of every mention of `Object.create`, in source order; `null` where it is not called directly. */
export function sourceCreatePrototypes(sourceFile: ts.SourceFile): readonly (ts.Expression | null)[] {
  return prototypeUse(sourceFile).createPrototypes;
}

/** Whether the source writes, deletes or defines a member or binding named `name` (`x.call = f`, `String = v`). */
export function sourceWritesMemberNamed(sourceFile: ts.SourceFile, name: string): boolean {
  return prototypeUse(sourceFile).writtenNames.has(name);
}

/**
 * (#7350) `identifier` reads the realm's own global of its name: nothing in
 * the file declares the name, nothing writes, deletes or defines a member or
 * binding of that name by a literal route (`Math = v`, `globalThis.Math = v`,
 * `delete globalThis.Math`). A write under a computed name is outside this
 * boundary, as for the object statics (#3776). A `with` body is not screened
 * here: no unit that contains or sits inside one is claimed by the IR, and the
 * elision consumer keeps its own file-wide `with` screen. Syntactic: dead-binding elision asks it before a checker
 * exists; a checker consumer also asks for the lib binding.
 */
export function isPristineIntrinsic(identifier: ts.Identifier): boolean {
  return isUndeclaredInFile(identifier) && !sourceWritesMemberNamed(identifier.getSourceFile(), identifier.text);
}

function prototypeUse(sourceFile: ts.SourceFile): PrototypeUse {
  let use = cache.get(sourceFile);
  if (!use) {
    use = {
      writes: new Set(),
      mayPatch: new Set(),
      writtenNames: new Set(),
      reflective: false,
      globalObjectEscapes: false,
      dynamicCode: false,
      unspelledWrite: false,
      spelledNames: new Set(),
      createPrototypes: [],
    };
    const found = use;
    const callbacks: { readonly intrinsic: PatchableIntrinsic; readonly method: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const owner = prototypeOwner(node);
        if (owner && !owner.qualified && isLegacyWrite(node)) found.writes.add(owner.intrinsic);
        if (owner && !isPlainMemberRead(node)) found.mayPatch.add(owner.intrinsic);
      }
      const name = referencedName(node);
      if (name !== undefined) {
        const reference = node as ts.Expression;
        if (PATCHABLE.has(name) && !isInertUse(reference)) {
          const method = name === "String" ? arrayCallbackMethod(reference) : undefined;
          if (method === undefined) found.mayPatch.add(name as PatchableIntrinsic);
          else callbacks.push({ intrinsic: "String", method });
        }
        if (GLOBAL_OBJECT_NAMES.has(name) && !isInertUse(reference)) found.globalObjectEscapes = true;
        if (DYNAMIC_CODE_NAMES.has(name) && !isPrototypeReadOrOperand(reference)) found.dynamicCode = true;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword && !isInertUse(node as ts.Expression))
        found.globalObjectEscapes = true;
      const written = writtenName(node);
      if (written !== undefined) found.writtenNames.add(written);
      found.unspelledWrite ||= installsUnspelledMember(node);
      if (ts.isStringLiteralLike(node) || (ts.isIdentifier(node) && !isMemberName(node))) {
        found.spelledNames.add(node.text);
      }
      const created = createdFrom(node);
      if (created !== undefined) found.createPrototypes.push(created);
      const text = nameText(node);
      if (
        ts.isWithStatement(node) ||
        (text !== undefined && REFLECTIVE_NAMES.has(text) && !isObservedConstructor(node))
      ) {
        found.reflective = true;
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
    // `String` handed to a realm array method as its callback is only called, unless that method may not be the realm's.
    const handedOn = (method: string): boolean =>
      found.mayPatch.has("Array") ||
      found.mayPatch.has("Function") ||
      found.writtenNames.has(method) ||
      found.writtenNames.has("call");
    for (const { intrinsic, method } of callbacks) if (handedOn(method)) found.mayPatch.add(intrinsic);
    cache.set(sourceFile, use);
  }
  return use;
}

/**
 * `Array` for `Array.prototype`, and for a member of that name on any object
 * (`globalThis.Array.prototype`, `this["Array"].prototype`); each other
 * patchable intrinsic likewise. `qualified` is anything but the bare name.
 */
function prototypeOwner(
  expression: ts.PropertyAccessExpression,
): { readonly intrinsic: PatchableIntrinsic; readonly qualified: boolean } | undefined {
  if (expression.name.text !== "prototype") return undefined;
  const name = referencedName(skipOuterExpressions(expression.expression));
  if (name === undefined || !PATCHABLE.has(name)) return undefined;
  return { intrinsic: name as PatchableIntrinsic, qualified: !ts.isIdentifier(expression.expression) };
}

/**
 * The name `node` reads: an identifier that reads a binding, or a member of
 * any object by a literal name (`o.String`, `o["String"]`). A global reached
 * through any object counts, since the walk cannot tell which object is the
 * global one.
 */
function referencedName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return isValueReference(node) ? node.text : undefined;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const key = skipOuterExpressions(node.argumentExpression);
  return ts.isStringLiteralLike(key) ? key.text : undefined;
}

/** An identifier that reads a binding: not a declared name, a member or property name, a label or a type. */
export function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (isBindingSiteName(identifier) || (parent as { readonly name?: ts.Node }).name === identifier) return false;
  return !(
    ts.isQualifiedName(parent) ||
    ts.isTypeNode(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  );
}

/** The `Array.prototype` methods whose first argument is a callback they only call (§23.1.3). */
const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
]);

/**
 * The method, when `reference` is the callback of a borrowed realm array
 * method, `Array.prototype.<m>.call(o, reference, …)` (assert.js maps with
 * `String`): the method only calls it, as `String(v)` would.
 */
function arrayCallbackMethod(reference: ts.Expression): string | undefined {
  const use = outermost(reference);
  const call = use.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== use) return undefined;
  const callee = skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
  const method = skipOuterExpressions(callee.expression);
  if (!ts.isPropertyAccessExpression(method) || !ARRAY_CALLBACK_METHODS.has(method.name.text)) return undefined;
  const prototype = skipOuterExpressions(method.expression);
  return ts.isPropertyAccessExpression(prototype) && prototypeOwner(prototype)?.intrinsic === "Array"
    ? method.name.text
    : undefined;
}

/** `Function.prototype…`, or a `typeof`, `instanceof` or equality operand: a read that runs no code. */
function isPrototypeReadOrOperand(reference: ts.Expression): boolean {
  const use = outermost(reference);
  const user = use.parent;
  if (ts.isPropertyAccessExpression(user) && user.expression === use && user.name.text === "prototype") return true;
  return isOperandUse(user);
}

/**
 * A use that neither stores nor hands the object on: the callee of a call or
 * `new`, the object of a member access (a computed key only as a literal other
 * than `"prototype"`), and a `typeof`, `instanceof` or equality operand.
 */
function isInertUse(reference: ts.Expression): boolean {
  const use = outermost(reference);
  const user = use.parent;
  if ((ts.isCallExpression(user) || ts.isNewExpression(user)) && user.expression === use) return true;
  if (ts.isPropertyAccessExpression(user) && user.expression === use) return true;
  if (ts.isElementAccessExpression(user) && user.expression === use) {
    const key = skipOuterExpressions(user.argumentExpression);
    return (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) && key.text !== "prototype";
  }
  return isOperandUse(user);
}

/** A `typeof`, `instanceof` or equality operand. */
function isOperandUse(user: ts.Node): boolean {
  if (ts.isTypeOfExpression(user)) return true;
  return (
    ts.isBinaryExpression(user) &&
    (user.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword || EQUALITY_OPERATORS.has(user.operatorToken.kind))
  );
}

/** The text of an identifier or a literal member key (`o["k"]`), if `node` is one. */
function nameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** The name `node` stores into, deletes or defines: `x.k = v`, `delete x.k`, `k = v`, `Object.defineProperty(x, "k", …)`. */
function writtenName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return isOwnWriteTarget(node) ? node.name.text : undefined;
  if (ts.isElementAccessExpression(node)) {
    return isOwnWriteTarget(node) ? nameText(skipOuterExpressions(node.argumentExpression)) : undefined;
  }
  if (ts.isIdentifier(node)) return isOwnWriteTarget(node) ? node.text : undefined;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const key = node.arguments[1];
  return node.expression.name.text === "defineProperty" && key !== undefined ? nameText(key) : undefined;
}

/** `node` is the name of a member read or write (`o.<name>`), not a spelling of the name itself. */
function isMemberName(node: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

/** The names that define a member by a key operand (`defineProperty`) or by a map's keys (`defineProperties`). */
const DEFINE_NAMES: ReadonlySet<string> = new Set(["defineProperty", "defineProperties"]);

/**
 * A member may be installed under a name the source does not spell:
 *   - a store `x[e] = v` or a computed literal key `{ [e]: v }` whose `e` is no
 *     constant;
 *   - `defineProperty` called directly (by any spelling the walk reads:
 *     `Object.defineProperty`, `Object["defineProperty"]`) with a key that is
 *     no constant, or reached any other way (an alias, `.call`, `.apply`), and
 *     `defineProperties` reached other than as a direct call;
 *   - a mention of a built-in that makes keys from data or an exotic object:
 *     `Proxy`, `fromEntries`, and `JSON` other than `typeof JSON` and
 *     `JSON.stringify` (assert.js's value formatter).
 */
function installsUnspelledMember(node: ts.Node): boolean {
  if (ts.isElementAccessExpression(node) && isStoreTarget(node)) return !isConstantKey(node.argumentExpression);
  if (ts.isComputedPropertyName(node)) return !isConstantKey(node.expression);
  const name = referencedName(node);
  if (name === undefined) return false;
  if (DEFINE_NAMES.has(name)) {
    const use = outermost(node as ts.Expression);
    const call = use.parent;
    if (!ts.isCallExpression(call) || call.expression !== use) return true;
    const key = call.arguments[1];
    return name === "defineProperty" && key !== undefined && !isConstantKey(key);
  }
  if (name === "Proxy" || name === "fromEntries") return true;
  if (name !== "JSON") return false;
  const use = outermost(node as ts.Expression);
  const user = use.parent;
  return !(
    ts.isTypeOfExpression(user) ||
    (ts.isPropertyAccessExpression(user) && user.expression === use && user.name.text === "stringify")
  );
}

/** What a mention of `Object.create` (by any spelling the walk reads) makes from: its prototype, `null` if not called. */
function createdFrom(node: ts.Node): ts.Expression | null | undefined {
  if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return undefined;
  if (referencedName(node) !== "create" || referencedName(skipOuterExpressions(node.expression)) !== "Object") {
    return undefined;
  }
  const use = outermost(node);
  const call = use.parent;
  return ts.isCallExpression(call) && call.expression === use ? (call.arguments[0] ?? null) : null;
}

/** A property key fixed by the source: a literal, a signed number, or the global `undefined` / `NaN` / `Infinity`. */
function isConstantKey(key: ts.Expression): boolean {
  const k = skipOuterExpressions(key);
  if (ts.isStringLiteralLike(k) || ts.isNumericLiteral(k) || isUnshadowedGlobalConstant(k)) return true;
  if (k.kind === ts.SyntaxKind.TrueKeyword || k.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (k.kind === ts.SyntaxKind.NullKeyword) return true;
  return (
    ts.isPrefixUnaryExpression(k) &&
    (k.operator === ts.SyntaxKind.MinusToken || k.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(k.operand)
  );
}

/** `target` is itself what a store or `delete` writes, not a member's object or name (`x` and `k` in `x.k = v`). */
function isOwnWriteTarget(target: ts.Expression): boolean {
  const use = outermost(target);
  if (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) return false;
  return isStoreTarget(target) || ts.isDeleteExpression(use.parent);
}

/**
 * `x.constructor` used only as an identity (`x.constructor !== C`) or for its
 * `name`, as assert.js's `assert.throws` reads it: neither reaches a prototype.
 */
function isObservedConstructor(name: ts.Node): boolean {
  const access = name.parent;
  if (!ts.isIdentifier(name) || name.text !== "constructor" || !ts.isPropertyAccessExpression(access)) return false;
  if (access.name !== name) return false;
  const use = outermost(access);
  const user = use.parent;
  if (ts.isBinaryExpression(user)) return EQUALITY_OPERATORS.has(user.operatorToken.kind);
  return (
    ts.isPropertyAccessExpression(user) &&
    user.expression === use &&
    user.name.text === "name" &&
    !isStoreTarget(user) &&
    !ts.isDeleteExpression(outermost(user).parent)
  );
}

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** `node` with the parentheses and type wrappers around it. */
function outermost(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isExpression(current.parent) && skipOuterExpressions(current.parent) !== current.parent) {
    current = current.parent;
  }
  return current;
}

/** The member access whose object is `prototype` (through wrappers), if any. */
function memberOn(prototype: ts.Expression): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  const object = outermost(prototype);
  const member = object.parent;
  return member &&
    (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
    member.expression === object
    ? member
    : undefined;
}

/** #1719's set: `<P>.k = v`, `delete <P>.k`, `Object.defineProperty(<P>, …)` / `defineProperties`. */
function isLegacyWrite(prototype: ts.PropertyAccessExpression): boolean {
  const member = memberOn(prototype);
  if (member) {
    const user = member.parent;
    if (ts.isBinaryExpression(user) && user.operatorToken.kind === ts.SyntaxKind.EqualsToken && user.left === member) {
      return true;
    }
    return ts.isDeleteExpression(outermost(member).parent);
  }
  const call = prototype.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== prototype) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
  );
}

/** The prototype is only the object of a member read: not stored into, deleted, or called on. */
function isPlainMemberRead(prototype: ts.PropertyAccessExpression): boolean {
  const member = memberOn(prototype);
  if (!member) return false;
  const user = member.parent;
  if (ts.isDeleteExpression(user)) return false;
  if (ts.isCallExpression(user) && user.expression === member) return false;
  if (ts.isTaggedTemplateExpression(user) && user.tag === member) return false;
  return !isStoreTarget(member);
}
