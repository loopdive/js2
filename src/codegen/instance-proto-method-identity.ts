// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4481) `x.toString === X.prototype.toString` — the INSTANCE side of a
 * builtin prototype-method VALUE read, under `--target standalone`.
 *
 * ## What was actually wrong (measured, not inherited)
 *
 * The issue was filed as "both sides produce different carriers". The probe
 * matrix says otherwise. Measured on this branch's base (`0e47b7ae0`) with the
 * real `runTest262File` standalone lane, one module per cell:
 *
 * | cell                                  | `inst.m === Proto.m` | `Proto.m === Proto.m` | `typeof Proto.m` | `typeof inst.m` |
 * | ------------------------------------- | -------------------- | --------------------- | ---------------- | --------------- |
 * | Object/Array/Number/Boolean/String × `toString`/`valueOf`/`hasOwnProperty` | **false** | true | function | "function" |
 * | `Array.join`                          | **false**            | true                  | function         | "function"      |
 * | `Object.join` / `String.join`         | true (both absent)   | true                  | undefined        | undefined       |
 *
 * The PROTOTYPE side was already a per-(brand, member) singleton
 * (`pushBuiltinFnSingletonValueInstrs`, #2175 V2-S2) — self-stability holds in
 * every cell. The whole defect is the INSTANCE side, and it is not "a different
 * function object": `[].toString`, `({}).toString` and `"s".charAt` read as
 * **`undefined`**, and a raw-number receiver (`(5).toString`) reads as **null**.
 *
 * **`typeof` said `"function"` for a value that was `undefined`.** That column
 * is folded from the receiver's TS type, not from the emitted value, so the one
 * probe most likely to be reached for first REPORTS THE DEFECT AS FIXED. It is
 * the same masking trap #4234 recorded for `undefined === undefined`, one level
 * up, and it is why the rows above pair the identity check with an
 * `=== undefined` check rather than a `typeof` check. Left unfixed here (the
 * fold now happens to agree, because the value really is a function); recorded
 * as a residual on the issue.
 *
 * ## The fix
 *
 * Route the instance-side read through the SAME resolver the prototype-side
 * read uses — `resolveStandaloneProtoMemberValueClosure` (#2984's three-tier
 * own / inherited-from-`Object.prototype` / decline policy) — and emit it with
 * the SAME `pushBuiltinFnSingletonValueInstrs` singleton. Identity then holds
 * BY CONSTRUCTION rather than by two emitters happening to agree, which is
 * #4442's rule and the reason its two predecessors failed.
 *
 * The receiver's brand comes from `ctx.oracle.typeFactOf` (never the raw
 * checker), and only for the five shapes whose `[[Prototype]]` is a builtin
 * prototype with no user-authored link in between.
 *
 * ## Why this is a STATIC fold and not another `__extern_get` arm
 *
 * #4248 already added the runtime arm, and it is why `new Number(5).toString
 * === Number.prototype.toString` is true on base. It cannot reach these rows:
 * it keys on a `$Object` receiver carrying a `[[PrimitiveValue]]` slot, or on a
 * `$NativeProto` receiver. An array literal is a vec, a plain object literal is
 * a `$Object` with no such slot, and `(5)` is an i31/box — none of them are that
 * shape. Extending the runtime arm to a plain `$Object` additionally cannot be
 * done at the FRONT of `__extern_get` without breaking §7.3.2: the arm would
 * answer before the own-property and `$proto`-chain walk it must lose to.
 *
 * ## The two things this must not trade away
 *
 * 1. **Shadowing defeats the fold.** The gate is deliberately two-layer:
 *    the receiver's own STATIC shape must not declare the member, AND the
 *    module must not touch a property of that name ANYWHERE
 *    ({@link moduleTouchesPropName}) — assignment, `delete`, an object-literal
 *    or class member, a `defineProperty` key, or any prototype-relinking call.
 *    A fold that disagrees with runtime state is this campaign's documented bug
 *    class (#4460 folded `typeof`/`length` while the runtime value was null).
 *    Both layers DECLINE by falling through to the existing dynamic read, which
 *    is exactly the "absent-not-wrong" rule: the pre-#4481 answer is still
 *    available and still correct-or-absent.
 * 2. **Callability is unchanged.** The value handed back is the identical
 *    singleton the prototype-side read already hands back, so
 *    `var f = [].toString; f.call(a)` behaves exactly as
 *    `var f = Array.prototype.toString; f.call(a)` does — which for the members
 *    whose native body is not wired is the factory's catchable TypeError
 *    (`refusalBodyFallback`), i.e. strictly better than calling the `undefined`
 *    the base produced. The arm never fires in CALLEE position, so
 *    `arr.toString()` / `({}).toString()` keep their existing (working)
 *    lowerings byte-for-byte.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { BUILTIN_CTOR_NAMES, tryEnsureNativeProtoBrand } from "./builtin-value-read.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { resolveStandaloneProtoMemberValueClosure } from "./native-proto-value-read.js";
import { compileExpression, skipTransparentExpressions } from "./shared.js";

/**
 * Receiver TypeFact kind → the builtin whose `.prototype` supplies the member.
 *
 * Only the five ordinary-prototype shapes. Deliberately absent:
 *   - `class` — a class instance's prototype is user-authored and may shadow;
 *   - `function` — `Function.prototype`'s members are reached through the
 *     `<fn>.constructor` / closure-props path (#4442), not this arm;
 *   - `builtin` — a named builtin receiver (`Math`, a TypedArray view, …) has
 *     its own arms and its own brand rules;
 *   - `any` / `unknown` / `union` / `unresolvable` — cannot be certain about the
 *     receiver, so the arm must decline rather than answer (rule 4 of the
 *     campaign brief).
 */
function builtinOfReceiverFact(kind: string): string | undefined {
  switch (kind) {
    case "array":
    case "tuple":
      return "Array";
    case "number":
      return "Number";
    case "string":
      return "String";
    case "boolean":
      return "Boolean";
    case "object":
      return "Object";
    default:
      return undefined;
  }
}

/** Per-SourceFile cache of the module-wide touched-property-name set. */
const touchedPropCache = new WeakMap<ts.SourceFile, ReadonlySet<string> | "all">();
/** Per-SourceFile cache of identifier names that are assigned after their declaration. */
const reassignedNameCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * Identifier names this module ASSIGNS to (`a = …`, `a += …`, `a++`), i.e. the
 * bindings whose declaration initializer is not a proof of their value at a
 * later read.
 *
 * Needed only by the OBJECT arm, which proves its receiver's brand from the
 * initializer SYNTAX rather than from a TypeFact — see
 * {@link receiverIsPlainObjectLiteral}. `var a = {}; a = [1,2]; a.toString`
 * must not fold to `Object.prototype.toString`.
 */
function moduleReassignedNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = reassignedNameCache.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      names.add(node.left.text);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
      names.add(node.operand.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  reassignedNameCache.set(sourceFile, names);
  return names;
}

/**
 * Is `receiver` PROVABLY a plain object literal with no own `propName`?
 *
 * The oracle cannot answer this one with `typeFactOf`, and that is worth
 * recording because it cost a full measure-and-retry cycle: an anonymous object
 * literal type takes its symbol NAME from the variable it initializes, so
 * `var a = {}` reports `{ kind: "class", name: "a" }` — indistinguishable from a
 * real class instance, which this arm must keep declining. Measured directly:
 * with only the `kind === "object"` path, `valueOf`/`join`/`hasOwnProperty`
 * flipped for Array/Number/Boolean/String and every `Object.*` cell still
 * declined `fact-{"kind":"class","name":"a"}`.
 *
 * So the object receiver is proved SYNTACTICALLY instead, which is strictly
 * stronger than a type answer for the shadowing question — the literal's own
 * keys are right there:
 *
 *   - the receiver is an object literal, or an identifier whose variable
 *     initializer is one (`ctx.oracle.variableInitializerOf`, an AST query, so
 *     no `ts.Type` escapes and the oracle-ratchet gate is satisfied);
 *   - that identifier is never assigned elsewhere in the module;
 *   - the literal declares no `propName`, no computed key and no spread.
 */
function receiverIsPlainObjectLiteral(ctx: CodegenContext, rawReceiver: ts.Expression, propName: string): boolean {
  const receiver = skipTransparentExpressions(rawReceiver);
  let literal: ts.Expression | undefined;
  if (ts.isObjectLiteralExpression(receiver)) {
    literal = receiver;
  } else if (ts.isIdentifier(receiver)) {
    if (moduleReassignedNames(receiver.getSourceFile()).has(receiver.text)) return false;
    const init = ctx.oracle.variableInitializerOf(receiver);
    literal = init === undefined ? undefined : skipTransparentExpressions(init);
  }
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return false;
  for (const member of literal.properties) {
    if (ts.isSpreadAssignment(member)) return false;
    const name = declaredMemberName(member.name);
    if (name === undefined || name === propName) return false;
  }
  return true;
}

/** The member name a property-access / element-access expression names, if static. */
function staticMemberName(e: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(e) && !ts.isPrivateIdentifier(e.name)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  return undefined;
}

/** The name a class/object-literal member declares, if it is a static string key. */
function declaredMemberName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * Is `target` a write onto a USER constructor's `.prototype` — i.e. one that
 * provably cannot shadow anything for the five shapes this arm answers?
 *
 * This carve-out is not a nicety, it is what makes the arm reach ANY test262
 * file. `sta.js` — prepended to every single test in the corpus — contains
 *
 * ```js
 * Test262Error.prototype.toString = function () { … };
 * ```
 *
 * and without the carve-out that one line put `toString` in the module-wide
 * touched set for the WHOLE corpus, so the highest-value member of the whole
 * issue (`x.toString === X.prototype.toString`, the S11.1.4/S11.1.5 rows)
 * declined everywhere while `valueOf`/`join`/`hasOwnProperty` flipped. Measured:
 * `toString` false in all 20 cells with the blanket gate, true in 4 of 5 with
 * this carve-out.
 *
 * Soundness: an array literal, an object literal and a primitive have
 * `%Array.prototype%` / `%Object.prototype%` / `%<Wrapper>.prototype%` in their
 * [[Prototype]] chain and nothing else. A user constructor's `.prototype` object
 * is not on any of those chains, so a property installed there is invisible to
 * every receiver this arm accepts. The one way it could get onto such a chain —
 * an explicit relink — already forces the `"all"` verdict below.
 *
 * `<BuiltinCtor>.prototype.m = …` is deliberately NOT carved out: that write
 * DOES land on the chain.
 */
function isUserPrototypeWrite(target: ts.Expression): boolean {
  const receiver = ts.isPropertyAccessExpression(target)
    ? target.expression
    : ts.isElementAccessExpression(target)
      ? target.expression
      : undefined;
  if (receiver === undefined || !ts.isPropertyAccessExpression(receiver)) return false;
  if (receiver.name.text !== "prototype") return false;
  return ts.isIdentifier(receiver.expression) && !BUILTIN_CTOR_NAMES.has(receiver.expression.text);
}

/**
 * Every property NAME this module could give a receiver as an OWN property, or
 * `"all"` when the module does something that can relink a prototype chain and
 * therefore invalidates every fold at once.
 *
 * Conservative on purpose and by a wide margin — one `{ toString: … }` literal
 * anywhere disables the `toString` fold for the WHOLE module. That is the right
 * trade: the fold's only job is to make two spellings name one object, and
 * giving that up costs a `false` that was already `false` on base, whereas
 * folding past a shadow would produce a wrong `true`. The cost is bounded
 * because the target corpora (`language/expressions/{array,object}` S11.1.x)
 * are exactly the modules that touch nothing.
 *
 * `"all"` triggers on the prototype-relinking surface — a `__proto__` write,
 * `create` / `setPrototypeOf` / `defineProperties` under ANY receiver (matched
 * by method name, so `Reflect.setPrototypeOf` is covered too), and every
 * dynamic-key write/delete. After any of those a receiver's [[Prototype]] is no
 * longer statically the builtin prototype its TS type implies, or an own
 * property of an unknown name exists, so nothing is foldable for any brand.
 */
function moduleTouchedPropNames(sourceFile: ts.SourceFile): ReadonlySet<string> | "all" {
  const cached = touchedPropCache.get(sourceFile);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  let all = false;
  const RELINKERS = new Set(["create", "setPrototypeOf", "defineProperties"]);

  const walk = (node: ts.Node): void => {
    if (all) return;
    // `o.m = …` / `o["m"] = …` / compound assignment — an own property appears.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const name = staticMemberName(node.left as ts.Expression);
      if (name === "__proto__") {
        // §B.3.1 relink — the receiver's chain is no longer its TS type's.
        all = true;
        return;
      }
      if (name !== undefined) {
        if (!isUserPrototypeWrite(node.left as ts.Expression)) names.add(name);
      } else if (ts.isElementAccessExpression(node.left) || ts.isPropertyAccessExpression(node.left)) {
        // A dynamic-key write (`o[k] = v`) could name anything.
        all = true;
        return;
      }
    }
    if (ts.isDeleteExpression(node)) {
      const name = staticMemberName(node.expression);
      if (name !== undefined) {
        if (!isUserPrototypeWrite(node.expression)) names.add(name);
      } else if (ts.isElementAccessExpression(node.expression) || ts.isPropertyAccessExpression(node.expression)) {
        all = true;
        return;
      }
    }
    // Object-literal / class members: an own property with that name.
    if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        if (ts.isSpreadAssignment(member)) {
          all = true;
          return;
        }
        const name = declaredMemberName(member.name);
        if (name !== undefined) names.add(name);
        else all = true;
      }
    }
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        const name = declaredMemberName(member.name);
        if (name !== undefined) names.add(name);
      }
    }
    // `Object.defineProperty(o, "m", d)` and the prototype-relinking surface.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "defineProperty") {
        const key = node.arguments[1];
        if (key !== undefined && ts.isStringLiteralLike(key)) names.add(key.text);
        else all = true;
      } else if (RELINKERS.has(method)) {
        all = true;
        return;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  const result = all ? "all" : (names as ReadonlySet<string>);
  touchedPropCache.set(sourceFile, result);
  return result;
}

/** The module-wide shadow gate, by name. */
function moduleTouchesPropName(sourceFile: ts.SourceFile, propName: string): boolean {
  const touched = moduleTouchedPropNames(sourceFile);
  return touched === "all" || touched.has(propName);
}

/**
 * `<instance>.<builtinProtoMethod>` read as a VALUE → the identity-stable
 * per-(brand, member) singleton (§ the tables in the module header).
 *
 * Returns the pushed ValType, or `undefined` having pushed NOTHING when the arm
 * declines, so the caller can splice it unconditionally.
 */
export function tryEmitInstanceBuiltinProtoMethodValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(expr.name)) return undefined;

  // CALLEE position keeps its existing lowering — `arr.toString()` and
  // `({}).toString()` already work and are not this arm's business. Same for a
  // tagged template, whose tag is also invoked rather than read.
  const parent = expr.parent;
  if (
    (ts.isCallExpression(parent) && parent.expression === expr) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === expr) ||
    (ts.isNewExpression(parent) && parent.expression === expr)
  ) {
    return undefined;
  }

  // The `<Builtin>.prototype.<member>` spelling has its own arm
  // (`tryCompileStandaloneBuiltinProtoMemberRead`) and must keep it: its
  // receiver's TS type is `any[]` for `Array.prototype`, which would otherwise
  // classify here as an ARRAY instance.
  const receiver = expr.expression;
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "prototype") return undefined;

  // The syntactic object-literal proof runs FIRST: it is what actually carries
  // the `Object.prototype` cells, and it subsumes the shape gate for the
  // receivers it accepts (the literal's own keys are the shape).
  const fact = ctx.oracle.typeFactOf(receiver);
  let builtinName: string | undefined;
  if (receiverIsPlainObjectLiteral(ctx, receiver, propName)) {
    builtinName = "Object";
  } else {
    builtinName = builtinOfReceiverFact(fact.kind);
    // Static shadow layer for a shaped object type: an own declaration of the
    // member is not answerable from the prototype, and an UNSHAPED object type
    // is not answerable at all.
    if (fact.kind === "object") {
      const shape = fact.shape;
      if (shape === undefined) return undefined;
      if (shape.props.some((prop) => prop.name === propName)) return undefined;
    }
  }
  if (builtinName === undefined) return undefined;

  // Module-wide shadow layer (see `moduleTouchedPropNames`).
  if (moduleTouchesPropName(expr.getSourceFile(), propName)) return undefined;

  const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
  if (brand === undefined) return undefined;
  const resolved = resolveStandaloneProtoMemberValueClosure(ctx, brand, builtinName, propName);
  // Accessor members must be INVOKED on the instance, not returned as a value
  // (§22.2.6 and friends); that is a different question and this arm declines.
  if (!resolved || resolved.kind !== "method") return undefined;

  // Spec order: the receiver is evaluated for its side effects, then the
  // property is read. The value itself does not depend on the receiver.
  const objResult = compileExpression(ctx, fctx, receiver);
  if (objResult !== null) fctx.body.push({ op: "drop" });
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, resolved.closure));
  return resolved.closure.type;
}
