// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S2) A literal-bound object that is WRITTEN through a reflective
 * builtin must be an OPEN `$Object`, not a closed struct.
 *
 * `var o = {a: 1}` with a concrete contextual type lowers to a closed WasmGC
 * struct whose `a` slot is an f64. Every reflective builtin that later writes
 * `o` runs a native (`__extern_set_strict`, `__reflect_set`,
 * `__delete_property`, …) that handles that struct only partially — and no
 * native arm can make it correct, because the struct cannot hold a string in an
 * f64 field, cannot tombstone a deleted slot, and has no identity-keyed
 * integrity bits. Measured on main (standalone, p2b/p20/r1/r5):
 *
 * ```js
 * var t = {a: 1}; Object.assign(t, {a: "c"});   t.a        // NaN      (spec "c")
 * var o = {p: 43}; Reflect.set(o, "p", 42);     o.p        // 43       (spec 42, and `true`)
 * var o = {prop: 42}; Reflect.deleteProperty(o, "prop");
 *                                               o.hasOwnProperty("prop") // true (spec false)
 * ```
 *
 * Representation is the only lever, so this module adds reasons to the
 * standalone `mopSet` of the non-empty-literal pass (object-shape-widening's
 * #2992 S6 arm). A marked binding is routed to the recursive `$Object` builder
 * (`growableObjectLiteralVars`) and its checker type refuses struct
 * resolution, so every storage slot and every consumer rides the dynamic
 * `$Object` arms — the same discipline the delete / accessor-define reasons use.
 *
 * NARROW on purpose (ES5 is a completed edition): only a WRITE through a
 * reflective builtin whose FIRST argument is the binding counts —
 * `Object.assign(o, …)` (the target; a SOURCE is only read) and
 * `Reflect.{set, deleteProperty, defineProperty, setPrototypeOf,
 * preventExtensions}(o, …)`. A read (`Object.keys(o)`, `o.hasOwnProperty(k)`,
 * `Object.getOwnPropertyDescriptor(o, k)`, `Reflect.get/has/ownKeys`) already
 * works on the struct and does NOT flip the representation.
 */
import { ts } from "../../ts-api.js";

const REFLECT_WRITERS = new Set(["set", "deleteProperty", "defineProperty", "setPrototypeOf", "preventExtensions"]);

function stripped(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** Is `call` a direct `Object.assign(…)` / `Reflect.<writer>(…)` call? */
export function isReflectiveWriterCall(call: ts.CallExpression): boolean {
  const callee = stripped(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const ns = callee.expression.text;
  const member = callee.name.text;
  return (ns === "Object" && member === "assign") || (ns === "Reflect" && REFLECT_WRITERS.has(member));
}

/**
 * (#6651 U3) Is `n` a `new Proxy(…)` / `Proxy.revocable(…)` construction?
 *
 * Its FIRST argument becomes [[ProxyTarget]], and every trap-absent internal
 * method (§10.5.10 step 7 `target.[[Delete]](P)`, §10.5.6 step 7
 * `target.[[DefineOwnProperty]]`, §10.5.7 has, §10.5.9 set) reaches it through
 * the dynamic natives — the same reflective-write channel as `Reflect.*`. A
 * closed struct target cannot be tombstoned and re-defined (`delete p.attr`
 * then `Object.defineProperty(target, "attr", {configurable: false})` left
 * the delete marker in force, so `Reflect.deleteProperty(p, "attr")` answered
 * `true`), and a statically-typed `"attr" in target` read the struct slot after
 * the proxy deleted it.
 */
function isProxyConstruction(n: ts.Node): n is ts.NewExpression | ts.CallExpression {
  if (ts.isNewExpression(n)) {
    const callee = stripped(n.expression);
    return ts.isIdentifier(callee) && callee.text === "Proxy";
  }
  if (ts.isCallExpression(n)) {
    const callee = stripped(n.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Proxy" &&
      callee.name.text === "revocable"
    );
  }
  return false;
}

/**
 * Poison `varName` in `poisonSet` when it is the FIRST argument of a
 * reflective writer call — or the target of a Proxy construction (#6651 U3) —
 * anywhere under `node`.
 */
export function markStandaloneReflectiveWriteTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.arguments.length > 0 && isReflectiveWriterCall(n)) {
      const first = stripped(n.arguments[0]!);
      if (ts.isIdentifier(first) && first.text === varName) poisonSet.add(varName);
    }
    if (isProxyConstruction(n) && n.arguments !== undefined && n.arguments.length > 0) {
      const first = stripped(n.arguments[0]!);
      if (ts.isIdentifier(first) && first.text === varName) poisonSet.add(varName);
    }
    // (#6770 S5) `o.__proto__ = p` is [[SetPrototypeOf]] through the inherited
    // Annex B accessor, not a field add — a widened closed struct stored `p` in
    // a `__proto__` FIELD and the prototype never moved.
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.name) &&
      n.left.name.text === "__proto__" &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === varName
    ) {
      poisonSet.add(varName);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

const INTEGRITY_METHODS = new Set(["freeze", "seal", "preventExtensions"]);

/**
 * The inline object-literal argument of `Object.{freeze, seal,
 * preventExtensions}(<literal>)`, else `undefined`.
 *
 * `var t = Object.freeze({foo: 1})` froze a closed struct whose integrity bit
 * lives only in the compile-time name set, so every RUNTIME writer
 * (`Object.assign(t, …)`, `Reflect.set(t, …)`) wrote straight through it
 * (p2b bits 64/512), and an accessor literal's setter was skipped (bit 2048).
 * Such a literal is built as the `$Object` whose integrity flags every native
 * honours, and the receiving binding keeps that externref.
 */
export function integrityCallLiteralArg(expr: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const call = stripped(expr);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) return undefined;
  const callee = stripped(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !INTEGRITY_METHODS.has(callee.name.text)
  ) {
    return undefined;
  }
  const arg = stripped(call.arguments[0]!);
  return ts.isObjectLiteralExpression(arg) && arg.properties.length > 0 ? arg : undefined;
}

/** Standalone: an unannotated binding initialized by such a call stays externref. */
export function integrityLiteralResultNeedsExternref(
  standalone: boolean,
  initializer: ts.Expression | undefined,
): boolean {
  return standalone && initializer !== undefined && integrityCallLiteralArg(initializer) !== undefined;
}

/**
 * The consumer-safety guard's carve-out: `id` as an argument of a reflective
 * writer is not a concrete-struct consumer (`Reflect.set(target: object, …)`
 * is typed `object`; `Object.assign<T>` binds `T` to the literal type, which
 * LOOKS concrete but is exactly what the `$Object` rep serves).
 */
export function isReflectiveWriterCallArg(id: ts.Identifier): boolean {
  const call = id.parent;
  if (isProxyConstruction(call) && call.arguments?.[0] === id) return true; // (#6651 U3) `new Proxy<T>(target: T, …)`
  return ts.isCallExpression(call) && call.arguments.includes(id) && isReflectiveWriterCall(call);
}
