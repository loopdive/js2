// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3991) Static well-formedness classification for a property-descriptor
 * expression — the gate that decides whether `Object.defineProperties`' /
 * `Object.create`'s **static expansion** may own a descriptor, or whether the
 * call must fall through to the dynamic `__defineProperties` native.
 *
 * Extracted from `object-ops.ts` (#3991), for the same reason
 * `array-length-define.ts` was extracted in #3984: this is a self-contained
 * spec-classification decision whose correctness is entirely about
 * ToPropertyDescriptor (§6.2.5.6), and burying it as a closure inside a
 * 4,800-line god-file is precisely how its central claim went unexamined for so
 * long. Giving it a module keeps the god-file shrinking and puts the
 * spec reasoning where a reader looking for it will find it.
 *
 * ## The invariant this module exists to protect
 *
 * **A `true` answer is a PROMISE that the static expansion can fully model the
 * descriptor.** It is not a "probably fine" — the expansion has no fallback
 * once it has claimed a descriptor, and its failure mode is a *silent wrong
 * answer*, not a refusal.
 *
 * That invariant was violated for every non-object-literal descriptor. The old
 * code returned `true` for them, reasoning:
 *
 * > Identifier / call / property-access / etc — runtime-resolved but
 * > legitimately may be a valid object (as in `{property: Math}` or
 * > `{property: descObj}`). Expand statically; `Object.defineProperty` will
 * > handle validation at runtime via its own path.
 *
 * The final clause is false, for exactly the reason #3984 documented in the
 * same function: the expansion loop does **not** delegate to
 * `compileObjectDefineProperty`. It parses the descriptor's fields itself, and
 * every one of those parsers is guarded by `ts.isObjectLiteralExpression`. So a
 * non-literal descriptor was parsed as **nothing** — no value, no attributes —
 * and the property was defined with an **undefined value and default
 * attributes**. The classic test262 shape this breaks:
 *
 * ```js
 * var descObj = new Number(-9);          // or [], new Date(0), a user ctor, Math
 * descObj.get = function () { return "Number"; };
 * Object.defineProperties(obj, { property: descObj });
 * // obj.property was `undefined`
 * ```
 *
 * ## Why the dynamic path is the RIGHT destination, not a fallback
 *
 * `__defineProperties` already implements ToPropertyDescriptor correctly over
 * an **arbitrary** object — #3246 widened it past its old `ref.test $Object`
 * gate specifically so function / array / wrapper descriptors work — and reads
 * the fields with the accessor-aware, proto-walking `__extern_get`. It is the
 * only path that implements the spec algorithm at all. `{property: Math}` is
 * handled correctly there too: `Math` has no `value`/`get`/`set`/`writable`/…
 * own properties, so ToPropertyDescriptor yields an empty descriptor and
 * CompletePropertyDescriptor fills in `undefined` + all-false — which is what
 * the spec requires, and what the static path only reached by accident.
 */
import { ts } from "../ts-api.js";

/**
 * Is this descriptor expression statically a non-object primitive
 * (number / string / boolean / null / undefined)?
 *
 * When true, §6.2.5.5 (ES5 §8.10.5) step 1 requires a TypeError
 * "Property description must be an object" — thrown by ToPropertyDescriptor,
 * BEFORE any [[DefineOwnProperty]]. Detecting it at compile time lets the
 * caller emit the throw directly rather than relying on a runtime applier.
 *
 * (#4061) Moved here from `object-ops.ts`, where it was module-private and so
 * only `Object.defineProperty` could use it. `Object.create`'s own static
 * expansion (call-builtin-static.ts) needed the identical classification and,
 * lacking it, defined the property with a null value and default attributes
 * instead of throwing — `Object.create({}, {prop: null})`. The runtime applier
 * is NOT a fallback here: `__obj_define_from_desc` deliberately treats a
 * null/undefined descriptor as a lenient empty-descriptor no-op (see its
 * header), so a non-object descriptor that reaches it is silently swallowed.
 */
export function isStaticallyNonObjectDescExpr(descArg: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(descArg)) descArg = descArg.expression;
  if (
    ts.isNumericLiteral(descArg) ||
    ts.isStringLiteral(descArg) ||
    ts.isNoSubstitutionTemplateLiteral(descArg) ||
    descArg.kind === ts.SyntaxKind.TrueKeyword ||
    descArg.kind === ts.SyntaxKind.FalseKeyword ||
    descArg.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(descArg) && descArg.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(descArg) && ts.isNumericLiteral(descArg.operand)) return true;
  return false;
}

/**
 * The literal `get: null` / `set: null` field of an object-literal descriptor,
 * if present — a compile-time-provable ToPropertyDescriptor TypeError
 * (§6.2.5.6 steps 7.b / 8.b: the field is present, is not `undefined`, and is
 * not callable).
 *
 * (#4061) Extracted so `Object.create`'s static expansion can apply the same
 * eager throw that `Object.defineProperty` and `Object.defineProperties`
 * already do (#3116). Routing `null` to the runtime instead is unreliable: a
 * null struct field is indistinguishable from an absent/undefined one at the
 * wasm boundary (#2106), and `{get: undefined}` is a *valid* accessor
 * descriptor — so the runtime cannot tell the TypeError case from the legal
 * one. Returns the spec-facing noun for the message, matching the existing
 * two sites.
 */
export function literalNullAccessorField(descExpr: ts.Expression): "Getter" | "Setter" | undefined {
  if (!ts.isObjectLiteralExpression(descExpr)) return undefined;
  let found: "Getter" | "Setter" | undefined;
  for (const dp of descExpr.properties) {
    if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
    let init: ts.Expression = dp.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (init.kind !== ts.SyntaxKind.NullKeyword) continue;
    if (dp.name.text === "get") return "Getter";
    if (dp.name.text === "set" && found === undefined) found = "Setter";
  }
  return found;
}

/**
 * Does this object-literal descriptor carry a `get` or `set` field at all —
 * well-formed or not, property-assignment or method shorthand?
 *
 * (#4061) `Object.create`'s static expansion (call-builtin-static.ts) reads
 * `get`/`set` only to set the ACCESSOR flag bit and then calls
 * `__defineProperty_value` with a NULL value — it never compiles the accessor
 * function. So it cannot model ANY accessor descriptor, not merely a malformed
 * one. Measured on `14eaf9f87`, standalone:
 *
 * ```js
 * Object.create({}, {p: {get: function () { return 9; }}}).p   // → 0
 * Object.defineProperty(o, "p", {get: function () { return 9; }}), o.p  // → 9
 * ```
 *
 * Per this module's central invariant — a `true` answer is a PROMISE that the
 * static expansion can fully model the descriptor — every accessor descriptor
 * must therefore leave that expansion, well-formed or not. Nothing is lost:
 * the dynamic applier handles the legal case correctly and is the only path
 * that throws for the illegal ones.
 */
export function descriptorHasAccessorField(descExpr: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(descExpr)) return false;
  return descExpr.properties.some((p) => {
    if (!p.name || !ts.isIdentifier(p.name)) return false;
    if (!ts.isPropertyAssignment(p) && !ts.isMethodDeclaration(p) && !ts.isShorthandPropertyAssignment(p)) {
      return false;
    }
    return p.name.text === "get" || p.name.text === "set";
  });
}

/**
 * May the static expansion own this descriptor expression?
 *
 * Returns `false` — meaning "route the whole call to the dynamic runtime" — for
 * every shape the expansion cannot fully model:
 *
 *  - a **primitive literal** (`"s"`, `1`, `true`, `null`): spec-violating,
 *    ToPropertyDescriptor throws TypeError, and the dynamic path fires it
 *    uniformly. (`undefined` is also spec-violating but is deliberately left to
 *    the static path — its callees handle it.)
 *  - a **non-object-literal** expression (identifier / call / property access /
 *    `new`): the expansion parses no fields from it at all. See the module
 *    header — this is #3991.
 *  - an object literal **mixing data and accessor** fields: a
 *    ToPropertyDescriptor TypeError.
 *  - `get`/`set` that is `null` or `undefined` (#3116): `get: null` is a
 *    TypeError (present, not undefined, not callable) and `get: undefined` is a
 *    *valid accessor* descriptor, not a data property. The static expansion
 *    classified all three as "no accessor" and degraded the define to a plain
 *    value write, silently losing the throw / the accessor-ness.
 *  - `get`/`set` that is neither a function expression nor an identifier-like
 *    reference: not statically classifiable.
 */
export function isStaticDescWellFormed(descExpr: ts.Expression): boolean {
  if (
    ts.isStringLiteral(descExpr) ||
    ts.isNoSubstitutionTemplateLiteral(descExpr) ||
    ts.isNumericLiteral(descExpr) ||
    descExpr.kind === ts.SyntaxKind.TrueKeyword ||
    descExpr.kind === ts.SyntaxKind.FalseKeyword ||
    descExpr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  // (#3991) A non-literal descriptor is unmodellable here — the expansion's
  // field parsers all sit behind `ts.isObjectLiteralExpression`. Route it to
  // the dynamic ToPropertyDescriptor. See the module header.
  if (!ts.isObjectLiteralExpression(descExpr)) return false;

  let hasData = false;
  let hasAccessor = false;
  for (const dp of descExpr.properties) {
    if (ts.isMethodDeclaration(dp) && dp.name && ts.isIdentifier(dp.name)) {
      if (dp.name.text === "get" || dp.name.text === "set") hasAccessor = true;
      continue;
    }
    if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
    const k = dp.name.text;
    if (k === "value" || k === "writable") hasData = true;
    if (k === "get" || k === "set") {
      hasAccessor = true;
      const init = dp.initializer;
      const isFn = ts.isFunctionExpression(init) || ts.isArrowFunction(init);
      // (#3116) see the doc comment above.
      if (init.kind === ts.SyntaxKind.NullKeyword) return false;
      if (ts.isIdentifier(init) && init.text === "undefined") return false;
      const isIdLike =
        ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init);
      if (!isFn && !isIdLike) return false;
    }
  }
  if (hasData && hasAccessor) return false;
  return true;
}
