// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * TOP-LEVEL property writes whose receiver is a BUILTIN — the module-init
 * collection KEEP predicates, extracted from declarations.ts.
 *
 * ## The shared defect these guard against
 *
 * `collectDeclarations` keeps a top-level assignment statement only when its
 * assignment ROOT resolves to something it recognises (a module global, a
 * top-level function, `globalThis`, …). When the root is a builtin identifier
 * there is no such root, so the whole statement is dropped — it compiles to
 * NOTHING, silently. That elision family already has five recorded instances
 * (#2671 `Test262Error.thrower`, #2992 top-level `delete`, #3468 F1
 * `assert.sameValue`, #3592 `throw`, #4176 `<Builtin>.prototype.<name>`); the
 * two predicates here are its builtin-receiver members:
 *
 * | shape | issue |
 * | --- | --- |
 * | `<Builtin>.prototype.<name> = …` | #4176 |
 * | `<Namespace>.<name> = …`         | #4199 |
 *
 * (#4199) The second is one level shallower than the first and was extracted
 * here together with it, so declarations.ts carries one call instead of two
 * predicates plus two comment blocks.
 *
 * ## #4199: what was and was not broken
 *
 * The write ARM was never broken. `Math` as a bare value already resolves to
 * the identity-stable extensible `$Object` namespace singleton
 * (`emitBuiltinNamespaceObject`, #2907) and the ordinary property-write arm
 * stores into it via `__extern_set`. Measured:
 *
 * ```js
 * Math.value = "D";                                  // top level  → DROPPED
 * Object.defineProperty(obj, "p", Math); obj.p       // undefined  (want "D")
 *
 * function setup() { Math.value = "D"; } setup();    // in a body  → WORKS
 * Object.defineProperty(obj, "p", Math); obj.p       // "D"
 * ```
 *
 * So keeping the statement IS the whole fix.
 *
 * ## Why it matters: the §8.10.5 descriptor-carrier idiom
 *
 * ES5 `ToPropertyDescriptor` reads its fields off an arbitrary object, and a
 * large test262 family builds that object by hanging fields on a builtin:
 *
 * ```js
 * Math.configurable = true;
 * Object.defineProperty(obj, "property", Math);      // 15.2.3.6-3-91
 * ```
 *
 * Measured on `main` + #4177 (2026-08-07): of the 274 remaining ES5-standalone
 * descriptor-family failures, **38 use the `Math.`/`JSON.` expando idiom**
 * (19 + 19). A 14-carrier matrix showed 11 carriers ALREADY work — plain
 * objects, functions, arrays, `new String/Number/Boolean/Date/RegExp/Object`,
 * `arguments`, the global object — so the descriptor READ side is NOT the
 * defect and must not be rewritten. (`new Error()` instances are the third
 * failing carrier; that is #4098's instance-field storage, out of scope here.)
 *
 * ## #4199 scope — deliberately narrower than "any builtin receiver"
 *
 * **Namespaces**: only the three #2907 bare-value carriers whose
 * `SUPPORTED_STATIC_PROPS` list is EMPTY (`Math`, `JSON`, `Reflect`). Those are
 * pure namespace singletons — `isSupportedBuiltinStaticProperty` is false for
 * every member — so keeping a write cannot collide with a claimed
 * identifier-level fast path. `Array`/`Object` are excluded (they DO claim
 * static props, `isArray`/`keys`); the Error-family carriers are excluded
 * because they are CONSTRUCTORS whose `new`/`instanceof` forms resolve before
 * identifier resolution.
 *
 * **Property names**: only names NOT on the namespace's own static surface.
 * This is correctness in both directions, not timidity:
 *
 *  - `Math.PI = 3` — `Math.PI` is `{[[Writable]]: false}` (§21.3.1), so
 *    dropping that write is the SPEC-CORRECT outcome; keeping it would be a
 *    regression.
 *  - `JSON.stringify = fn` — the call site resolves statically through
 *    `BUILTIN_STATIC_METHOD_ARITY`, so a bag entry would be a SECOND storage
 *    the reader never consults. Silent divergence is worse than an honest
 *    no-op; patching builtin statics is separate, measured work (cf. the
 *    #2623 P-7b `Promise.resolve` arm, host/GC-only for the same reason).
 *
 * **Shadowing**: declines when a user binding shadows the name; those are
 * caught by the collection's own module-global / top-level-function arms.
 *
 * **Standalone only** — both predicates run behind a `ctx.standalone` gate, so
 * host/GC output stays byte-identical.
 */
import { ts } from "../ts-api.js";
import { isBrandedBuiltinName } from "./builtin-brands.js";
import { BUILTIN_STATIC_METHOD_ARITY } from "./builtin-fn-meta.js";

/**
 * (#4199) The #2907 bare-value namespace carriers with an EMPTY
 * supported-static-prop list. Keep in sync with `SUPPORTED_STATIC_PROPS` in
 * builtin-static-globals.ts — a name added there with a NON-empty list must
 * not be added here.
 */
const EXPANDO_NAMESPACES: ReadonlySet<string> = new Set(["Math", "JSON", "Reflect"]);

/**
 * (#4199) Own data properties of `Math` that the value-read path
 * constant-folds (`MATH_CONSTANT_PROPS`, builtin-value-read.ts). All are
 * non-writable per §21.3.1, so a write to one keeps its dropped lowering.
 */
const MATH_CONSTANTS: ReadonlySet<string> = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);

/** Strip parens / `as` / `!` / `<T>` wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The collection's view of which names a user binding has taken. */
export interface BuiltinWriteKeepCtx {
  readonly standalone?: boolean;
  readonly protoNamedDirty?: boolean;
  readonly protoIndexDirty?: boolean;
  readonly moduleGlobals: { has(name: string): boolean };
  readonly topLevelFunctionNames: { has(name: string): boolean };
  readonly classSet: { has(name: string): boolean };
}

/**
 * (#4176) Is this assignment LHS a write onto a branded builtin's `.prototype`
 * — `Function.prototype.value` / `Object.prototype["zzz"]` (member or element
 * form, unwrapped through parens/casts)? `F.prototype = …` (the whole reassign,
 * name === "prototype") is NOT matched — that stays owned by the #2660 S2
 * fnctor arm.
 */
export function isBuiltinProtoWriteTarget(left: ts.Expression): boolean {
  const lhs = unwrap(left);
  let receiver: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(lhs) && !ts.isPrivateIdentifier(lhs.name)) receiver = lhs.expression;
  else if (ts.isElementAccessExpression(lhs)) receiver = lhs.expression;
  if (!receiver) return false;
  const base = unwrap(receiver);
  return (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === "prototype" &&
    ts.isIdentifier(base.expression) &&
    isBrandedBuiltinName(base.expression.text)
  );
}

/** (#4199) Is `prop` on `ns`'s own static surface (so a write stays dropped)? */
function isOwnStaticSurface(ns: string, prop: string): boolean {
  if (BUILTIN_STATIC_METHOD_ARITY[ns]?.[prop] !== undefined) return true;
  return ns === "Math" && MATH_CONSTANTS.has(prop);
}

/**
 * (#4199) Is this assignment LHS a top-level EXPANDO write onto a builtin
 * namespace singleton (`Math.value = …` / `JSON["configurable"] = …`)? See the
 * module header for the scope argument; every case that must stay dropped
 * returns false.
 *
 * An element access with a NON-literal key (`Math[k] = v`) is declined: the
 * own-static-surface test cannot be decided at compile time, and admitting it
 * would let `Math["PI"] = 3` through by the back door.
 */
export function isBuiltinNamespaceExpandoWriteTarget(left: ts.Expression, ctx: BuiltinWriteKeepCtx): boolean {
  const lhs = unwrap(left);
  let receiver: ts.Expression;
  let propName: string;
  if (ts.isPropertyAccessExpression(lhs) && !ts.isPrivateIdentifier(lhs.name)) {
    receiver = lhs.expression;
    propName = lhs.name.text;
  } else if (ts.isElementAccessExpression(lhs)) {
    const key = unwrap(lhs.argumentExpression);
    if (!ts.isStringLiteralLike(key)) return false;
    receiver = lhs.expression;
    propName = key.text;
  } else {
    return false;
  }
  const base = unwrap(receiver);
  if (!ts.isIdentifier(base)) return false;
  const ns = base.text;
  if (!EXPANDO_NAMESPACES.has(ns)) return false;
  if (ctx.moduleGlobals.has(ns) || ctx.topLevelFunctionNames.has(ns) || ctx.classSet.has(ns)) return false;
  return !isOwnStaticSurface(ns, propName);
}

/**
 * The single entry point `collectDeclarations` calls: should this top-level
 * assignment statement be KEPT in `__module_init` because its receiver is a
 * builtin the generic root-identifier check cannot see? Standalone-only.
 */
export function shouldKeepBuiltinReceiverWrite(ctx: BuiltinWriteKeepCtx, left: ts.Expression): boolean {
  if (!ctx.standalone) return false;
  if ((ctx.protoNamedDirty || ctx.protoIndexDirty) && isBuiltinProtoWriteTarget(left)) return true;
  return isBuiltinNamespaceExpandoWriteTarget(left, ctx);
}
