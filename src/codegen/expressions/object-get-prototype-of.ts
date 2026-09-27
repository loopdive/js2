// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 Object.getPrototypeOf semantics that need compiler-owned intrinsic
 * identity rather than host inspection of opaque Wasm values.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitLazyNativeProtoGet } from "../native-proto.js";
import {
  ensureTypedArrayIntrinsicNativeProtoGlue,
  ensureTypedArrayViewNativeProtoGlue,
  isTypedArrayViewProtoName,
} from "../array-object-proto.js";
import { tryEnsureNativeProtoBrand } from "../property-access.js";
import { isGlobalBuiltinIdentifier } from "./calls.js";
import { emitThrowTypeError } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { integrityVarKey } from "../widened-var-key.js";
import { objectLiteralHasColonProto } from "../literals.js"; // (#5270 step 2)
import { sourceShadowsGlobalName } from "../source-function-members.js"; // (#5194 review F1)
import { allocLocal } from "../context/locals.js"; // (#6609)
import { popBody, pushBody } from "../context/bodies.js"; // (#6630 fallback)

const NATIVE_COLLECTION_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

const ES5_FUNCTION_PROTOTYPE_CTORS = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
]);

/**
 * Constructors `C` for which `Object.getPrototypeOf(C.prototype)` is exactly
 * `%Object.prototype%`.
 *
 * `Function.prototype` (§20.2.3) is the original member: a built-in function
 * object whose [[Prototype]] is `%Object.prototype%`, carrying no `$proto` link
 * the native `__getPrototypeOf` walk can follow — so that walk answered `null`.
 * `Promise.prototype` (§27.2.3.1, #5143) has the same shape: it lowers to a
 * `$NativeProto` struct whose `$parent` field is left null ("chain walk
 * deferred", `native-proto.ts`), so the query silently answered `null` too.
 *
 * Membership is per-constructor and deliberate: most builtin prototypes do NOT
 * root directly at `%Object.prototype%` (see the call site's comment).
 */
// (#5151) The four keyed-collection prototypes DO uniformly inherit directly
// from %Object.prototype% (§24.1.3/§24.2.3/§24.3.3/§24.4.3), so they join the
// rooted set (getPrototypeOf(Map.prototype) must answer %Object.prototype%,
// not the receiver's own brand page).
const OBJECT_ROOTED_PROTOTYPE_CTORS = new Set(["Function", "Promise", "Map", "Set", "WeakMap", "WeakSet"]);

const ES5_NATIVE_ERROR_CTORS = new Set([
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const ES5_OBJECT_PROTOTYPES = new Map([
  ["Array", "Array"],
  ["ReadonlyArray", "Array"],
  ["String", "String"],
  ["Boolean", "Boolean"],
  ["Number", "Number"],
  ["Date", "Date"],
  ["RegExp", "RegExp"],
  ["Error", "Error"],
  // (§20.5.6.4) Each NativeError has its OWN prototype object; collapsing them
  // onto `Error` made `Object.getPrototypeOf(new EvalError) === Error.prototype`
  // (test262 `NativeErrors/*/instance-proto.js`, `prototype.js`).
  ["EvalError", "EvalError"],
  ["RangeError", "RangeError"],
  ["ReferenceError", "ReferenceError"],
  ["SyntaxError", "SyntaxError"],
  ["TypeError", "TypeError"],
  ["URIError", "URIError"],
  ["IArguments", "Object"],
]);

/**
 * (#6651 cluster F, slice F2) Does this binding's DECLARATION give it a
 * prototype other than the implicit `%Object.prototype%`?
 *
 * The integrity arm in `tryCompileEs5GetPrototypeOfEarly` answers
 * `Object.getPrototypeOf(<integrity-marked id>)` with the compiler-owned
 * `%Object.prototype%` singleton, on the reasoning in its own comment: "closed
 * standalone plain objects keep their ordinary prototype implicit". That is
 * exact for `var o = {}` — and simply WRONG for a binding whose prototype was
 * chosen at creation. Measured on this branch's base, one module, standalone:
 *
 *     var proto = { tag: 1 };
 *     var a = Object.create(proto);
 *     Object.getPrototypeOf(a) === proto;   // true
 *     Object.preventExtensions(a);
 *     Object.getPrototypeOf(a) === proto;   // FALSE — answers %Object.prototype%
 *
 * The read before the integrity call is right and the read after is wrong,
 * because `ctx.nonExtensibleVars` is filled as statements are COMPILED, so the
 * mark only exists for later-compiled sites. The runtime link is untouched
 * throughout: the same query through a helper (`function gp(o) { return
 * Object.getPrototypeOf(o); }`) answers `proto` both before and after, and so
 * do `Reflect.getPrototypeOf(a)`, `proto.isPrototypeOf(a)` and an alias
 * `var z = a`. Only the folded spelling is wrong — a silent wrong answer, and
 * the one §10.5.1 step-10 SameValue comparison
 * `Proxy/getPrototypeOf/not-extensible-same-proto.js` depends on.
 *
 * So the arm is kept, narrowed to the carrier class it describes. A binding
 * whose initializer is `Object.create(…)` (including `Object.create(null)`,
 * whose prototype is explicitly null) or `Object.setPrototypeOf(o, p)` /
 * `Reflect.setPrototypeOf(o, p)` — both of which answer their receiver — or an
 * object literal with a colon-form `__proto__`, is excluded and falls through
 * to the ordinary path, whose generic `__getPrototypeOf` read is the answer the
 * probes above verified.
 *
 * Deliberately NOT widened past the declaration: a binding whose prototype is
 * written LATER by a `setPrototypeOf` STATEMENT keeps the fold, because
 * `Reflect/setPrototypeOf/return-false-*` asserts exactly this singleton after
 * a REFUSED set on a `var o = {}` carrier.
 */
function bindingHasExplicitPrototype(ctx: CodegenContext, id: ts.Identifier): boolean {
  const initializer = ctx.oracle.variableInitializerOf(id);
  if (initializer === undefined) return false;
  if (ts.isObjectLiteralExpression(initializer)) return objectLiteralHasColonProto(ctx, initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !ts.isIdentifier(initializer.expression.expression)
  ) {
    return false;
  }
  const namespace = initializer.expression.expression.text;
  const method = initializer.expression.name.text;
  if (namespace !== "Object" && namespace !== "Reflect") return false;
  if (method === "create") return namespace === "Object" && initializer.arguments.length >= 1;
  return method === "setPrototypeOf" && initializer.arguments.length >= 2;
}

function isTopLevelThis(expr: ts.Expression): boolean {
  if (expr.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let parent = expr.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
  }
  return true;
}

/**
 * Native standalone generator frames have a mutable per-instance prototype
 * view.  They are checker-typed as `Generator`, but unlike an ordinary closed
 * object their `[[Prototype]]` is not necessarily `%Object.prototype%` after
 * an integrity operation: `Object.preventExtensions(g)` must not erase the
 * factory-captured (or explicitly installed) link from a later
 * `Object.getPrototypeOf(g)` read.
 */
function isNativeGeneratorInstance(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!(ctx.standalone || ctx.wasi) || ctx.nativeGenerators.size === 0) return false;
  try {
    return ctx.checker.getTypeAtLocation(expr).getSymbol()?.name === "Generator";
  } catch {
    return false;
  }
}

/** Emit the identity-stable standalone prototype for a native collection. */
export function tryNativeCollectionGpo(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  argTsType: ts.Type,
): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  const collectionName = argTsType.getSymbol()?.name;
  if (collectionName === undefined || !NATIVE_COLLECTION_NAMES.has(collectionName)) return false;

  const argType = compileExpression(ctx, fctx, arg);
  if (argType) fctx.body.push({ op: "drop" });
  const brand = tryEnsureNativeProtoBrand(ctx, collectionName);
  if (brand === undefined || !emitLazyNativeProtoGet(ctx, fctx, brand)) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return true;
}

/**
 * Return true when an expression is a statically-known JSON object parse.
 *
 * The standalone JSON codec materialises parsed objects as ordinary open
 * objects, but their runtime `$Object` carrier intentionally keeps the
 * prototype link implicit. Recognising a literal object payload here lets
 * `Object.getPrototypeOf` expose the canonical `%Object.prototype%` value,
 * matching the ordinary-object result without changing `Object.create(null)`.
 * Only a literal whose first non-whitespace character is `{` is admitted:
 * arrays and primitive JSON payloads have different intrinsic prototypes.
 */
function isJsonObjectParseCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (
    !ts.isCallExpression(expr) ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== "parse" ||
    !ts.isIdentifier(expr.expression.expression) ||
    expr.expression.expression.text !== "JSON" ||
    !isGlobalBuiltinIdentifier(ctx, fctx, expr.expression.expression)
  ) {
    return false;
  }
  const source = expr.arguments[0];
  if (!source || !ts.isStringLiteralLike(source)) return false;
  return source.text.trim().startsWith("{");
}

/**
 * Emit the compiler-owned intrinsic prototype singleton rather than asking the
 * host MOP for the prototype of an opaque Wasm closure/struct.
 */
function emitEs5IntrinsicPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  builtinName: string,
): InnerResult {
  const builtin = ts.factory.createIdentifier(builtinName);
  const prototype = ts.factory.createPropertyAccessExpression(builtin, "prototype");
  (builtin as { parent?: ts.Node }).parent = prototype;
  (prototype as { parent?: ts.Node }).parent = anchor;
  ts.setTextRange(builtin, anchor);
  ts.setTextRange(prototype, anchor);
  return compileExpression(ctx, fctx, prototype, { kind: "externref" }) ?? { kind: "externref" };
}

function emitEs5IntrinsicConstructor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  builtinName: string,
): InnerResult {
  const builtin = ts.factory.createIdentifier(builtinName);
  (builtin as { parent?: ts.Node }).parent = anchor;
  ts.setTextRange(builtin, anchor);
  return compileExpression(ctx, fctx, builtin, { kind: "externref" }) ?? { kind: "externref" };
}

/**
 * Handle ES5 errors and intrinsic constructor/namespace relations before the
 * specialized generator, class, and typed-array getPrototypeOf cases.
 */
export function tryCompileEs5GetPrototypeOfEarly(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  if (expr.arguments.length === 0) {
    emitThrowTypeError(ctx, fctx, "Object.getPrototypeOf requires an object");
    return { kind: "externref" };
  }

  const arg0 = expr.arguments[0]!;
  if (
    arg0.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(arg0) &&
      arg0.text === "undefined" &&
      !fctx.localMap.has(arg0.text) &&
      !fctx.boxedCaptures?.has(arg0.text))
  ) {
    emitThrowTypeError(ctx, fctx, "Cannot convert undefined or null to object");
    return { kind: "externref" };
  }

  // Closed standalone plain objects keep their ordinary prototype implicit.
  // An integrity call marks the identifier, so preserve the argument read and
  // answer this exact query with the compiler-owned singleton.
  if (
    ctx.standalone &&
    ts.isIdentifier(arg0) &&
    ctx.nonExtensibleVars.has(integrityVarKey(ctx, arg0)) &&
    !isNativeGeneratorInstance(ctx, arg0) &&
    !bindingHasExplicitPrototype(ctx, arg0)
  ) {
    const argType = compileExpression(ctx, fctx, arg0);
    if (argType) fctx.body.push({ op: "drop" });
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }

  // (#6651 cluster F) A binding whose [[Prototype]] this module writes must be
  // READ, not folded — see `tryEmitDynamicProtoRuntimeRead`.
  const dynamicProtoRead = tryEmitDynamicProtoRuntimeRead(ctx, fctx, arg0);
  if (dynamicProtoRead) return dynamicProtoRead;

  if (ts.isIdentifier(arg0) && isGlobalBuiltinIdentifier(ctx, fctx, arg0)) {
    if (ES5_FUNCTION_PROTOTYPE_CTORS.has(arg0.text)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
    // (#4781/#5151) The ES2015 keyed-collection constructors are themselves
    // built-in function objects, so their [[Prototype]] is %Function.prototype%.
    // Keep these queries on the intrinsic path in both lanes; the native
    // collection path below models INSTANCES and must not answer for the
    // constructor object.
    if (NATIVE_COLLECTION_NAMES.has(arg0.text)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
    if (ES5_NATIVE_ERROR_CTORS.has(arg0.text)) {
      return emitEs5IntrinsicConstructor(ctx, fctx, expr, "Error");
    }
    if (arg0.text === "Math" || arg0.text === "JSON") {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
  }

  // (§20.2.3) `Object.getPrototypeOf(Function.prototype) === Object.prototype`.
  // %Function.prototype% is a built-in function object whose [[Prototype]] is
  // %Object.prototype%; it carries no `$proto` link the native `__getPrototypeOf`
  // walk can follow, so that walk answered `null` — a SILENT wrong answer that
  // also made `getPrototypeOf(Function.prototype) === getPrototypeOf([1,2])`
  // spuriously true (both null). `Object.prototype` is already the
  // identity-stable singleton this file emits for `Math`/`JSON`, so routing here
  // gives real `ref.eq` identity (test262 `Function/prototype/S15.3.4_A3_T1.js`).
  //
  // Deliberately narrow — see `OBJECT_ROOTED_PROTOTYPE_CTORS`. The other builtin
  // prototypes do NOT uniformly inherit from %Object.prototype%
  // (`Int8Array.prototype` → %TypedArray%.prototype, `TypeError.prototype` →
  // `Error.prototype`), and this hook runs BEFORE the typed-array / generator /
  // class getPrototypeOf arms — a blanket branch here would preempt them with a
  // wrong answer.
  if (
    ts.isPropertyAccessExpression(arg0) &&
    arg0.name.text === "prototype" &&
    ts.isIdentifier(arg0.expression) &&
    OBJECT_ROOTED_PROTOTYPE_CTORS.has(arg0.expression.text) &&
    isGlobalBuiltinIdentifier(ctx, fctx, arg0.expression)
  ) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  return null;
}

/**
 * Resolve ES5 primitive wrappers and ordinary value flows after more specific
 * getPrototypeOf cases have had the opportunity to claim the expression.
 */
export function tryCompileEs5GetPrototypeOfValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  const arg0 = expr.arguments[0]!;
  if (isJsonObjectParseCall(ctx, fctx, arg0)) {
    // Preserve JSON.parse validation and reviver side effects before replacing
    // only the prototype query with the canonical intrinsic singleton.
    const parsedType = compileExpression(ctx, fctx, arg0);
    if (parsedType) fctx.body.push({ op: "drop" });
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  // (§20.5.6.4) `<NativeError>.prototype`'s own [[Prototype]] IS `Error.prototype`.
  // The declared-name map below sees the type name `EvalError` for BOTH an
  // EvalError instance and `EvalError.prototype`, so without this arm the
  // per-NativeError rows would answer the receiver itself
  // (`NativeErrors/*/prototype/proto.js`).
  if (
    ts.isPropertyAccessExpression(arg0) &&
    arg0.name.text === "prototype" &&
    ts.isIdentifier(arg0.expression) &&
    ES5_NATIVE_ERROR_CTORS.has(arg0.expression.text) &&
    isGlobalBuiltinIdentifier(ctx, fctx, arg0.expression)
  ) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Error");
  }

  // (#5194 step 1) The TypedArray family, in TWO shapes that the declared-name
  // map below cannot tell apart — `Uint8Array.prototype` and
  // `new Uint8Array(0)` both have the TS type `Uint8Array`.
  //
  //   `getPrototypeOf(<View>.prototype)` → `%TypedArray%.prototype` (§23.2.7)
  //   `getPrototypeOf(<view instance>)`  → `<View>.prototype`      (§23.2.5.6)
  //
  // The instance arm MUST stay compile-time: a statically typed view lowers to
  // a packed carrier that several kinds share (`i8_byte` serves Int8Array,
  // Uint8Array and Uint8ClampedArray; `f64` serves Float64Array AND
  // `number[]`), so no runtime test can recover the kind. Dynamic views already
  // resolve at runtime through the `ta-dyn-mop.ts` `__getPrototypeOf` arm, and
  // both routes land on the same lazily-materialized glue singleton, so the
  // identity `getPrototypeOf(new Uint8Array(0)) === Uint8Array.prototype` holds
  // by `ref.eq` either way.
  if (ctx.standalone || ctx.wasi) {
    const protoOfName =
      ts.isPropertyAccessExpression(arg0) && arg0.name.text === "prototype" && ts.isIdentifier(arg0.expression)
        ? arg0.expression.text
        : undefined;
    // (#5194 review F1) `<View>.prototype` only denotes the intrinsic when the
    // identifier IS the global builtin. Without this gate a program with its own
    // `class Uint8Array { … }` had `Object.getPrototypeOf(Uint8Array.prototype)`
    // answer `%TypedArray%.prototype`. Same guard the NativeError arm above uses.
    if (
      protoOfName !== undefined &&
      isTypedArrayViewProtoName(protoOfName) &&
      ts.isPropertyAccessExpression(arg0) &&
      ts.isIdentifier(arg0.expression) &&
      isGlobalBuiltinIdentifier(ctx, fctx, arg0.expression)
    ) {
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) fctx.body.push({ op: "drop" });
      const intrinsicBrand = ensureTypedArrayIntrinsicNativeProtoGlue(ctx);
      if (intrinsicBrand !== undefined && emitLazyNativeProtoGet(ctx, fctx, intrinsicBrand)) {
        return { kind: "externref" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    // (#5194 review F1) The INSTANCE arm keys on the declared TYPE NAME, and a
    // user `class Uint8Array { … }` produces exactly the same name — there is no
    // identifier here to run `isGlobalBuiltinIdentifier` against, so the file's
    // module-level bindings are the check. Base answered the user class's
    // prototype correctly; the name-only test regressed it (and minted the whole
    // TypedArray proto graph into such a program: 405,180 -> 478,540 bytes).
    const viewName = ctx.oracle.declaredNameOf(arg0) ?? "";
    if (
      protoOfName === undefined &&
      isTypedArrayViewProtoName(viewName) &&
      !sourceShadowsGlobalName(expr.getSourceFile(), viewName)
    ) {
      // (#5194 review F3, DOCUMENTED RESIDUAL — measured, not assumed.) This
      // fold answers the DECLARED type's prototype, so a SUBCLASS instance in a
      // base-typed binding (`class Bytes extends Uint8Array {}`;
      // `const b: Uint8Array = new Bytes(2)`) reports `Uint8Array.prototype`
      // where the spec says `Bytes.prototype`. Declining the fold for any file
      // that subclasses the view was tried and REVERTED: it does not move the
      // work to a better answer, it moves it to a different wrong one — the
      // runtime arm cannot recover the kind from a statically typed carrier
      // (`i8_byte` serves Int8/Uint8/Uint8Clamped), so the ORDINARY
      // `Object.getPrototypeOf(new Uint8Array(1))` in the same file then
      // answered wrong too (measured: the focused control returned 2). Fixing
      // this needs a per-binding subclass fact, not a per-file one.
      const brand = ensureTypedArrayViewNativeProtoGlue(ctx, viewName);
      if (brand !== undefined) {
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) fctx.body.push({ op: "drop" });
        if (emitLazyNativeProtoGet(ctx, fctx, brand)) return { kind: "externref" };
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }
  }

  const staticType = ctx.oracle.staticJsTypeOf(arg0);
  if (staticType === "boolean") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Boolean");
  if (staticType === "string") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "String");
  if (staticType === "number") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Number");
  // (#5269 B-a) §7.1.18 ToObject(symbol) is a Symbol wrapper, whose
  // [[Prototype]] is `%Symbol.prototype%`. Without this arm the symbol fell to
  // the declared-name / signature probes below, answered `null`, and every
  // reflective read off the result (`Symbol.prototype[Symbol.toStringTag]`,
  // `Object.prototype.toString.call(…)`) then dereferenced a null.
  if (staticType === "symbol") return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Symbol");

  const knownPrototypeName = ES5_OBJECT_PROTOTYPES.get(ctx.oracle.declaredNameOf(arg0) ?? "");
  if (knownPrototypeName) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, knownPrototypeName);
  }
  if (ctx.oracle.signatureOf(arg0) !== undefined || ts.isFunctionExpression(arg0) || ts.isArrowFunction(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
  }
  if (ts.isArrayLiteralExpression(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Array");
  }
  // (#5270 step 2) A colon-form `__proto__` key REPLACES the literal's
  // [[Prototype]] during evaluation, so folding to `%Object.prototype%` here
  // would answer the wrong object (`__proto__-value-obj`, `-value-null`). Let
  // the runtime `__getPrototypeOf` read the field the literal actually wrote.
  if (ts.isObjectLiteralExpression(arg0) && !objectLiteralHasColonProto(ctx, arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  if (ts.isIdentifier(arg0)) {
    const initializer = ctx.oracle.variableInitializerOf(arg0);
    if (initializer && isJsonObjectParseCall(ctx, fctx, initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
    if (initializer && ts.isArrayLiteralExpression(initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Array");
    }
    if (initializer && ts.isObjectLiteralExpression(initializer) && !objectLiteralHasColonProto(ctx, initializer)) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
    }
    if (initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))) {
      return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
    }
  }
  if (isTopLevelThis(arg0)) {
    return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object");
  }
  return null;
}

/**
 * (#6609/#6625) `Object.getPrototypeOf(<value that is CALLABLE, or a CLASS
 * OBJECT, only at RUNTIME>)` → `%Function.prototype%` (§10.3.1: every
 * built-in function object's [[Prototype]] is %Function.prototype%; §15.7.14
 * step 4: an ordinary class with no heritage clause is the same).
 *
 * The arm above answers `Function` whenever the CHECKER can prove the argument
 * callable (`signatureOf`, a function expression, an arrow). A value that
 * arrives through an `any` binding — every member of a linked standalone
 * provider's namespace, by construction — carries no signature, so it fell to
 * the generic `__getPrototypeOf`, whose `$proto` walk only knows `$Object`
 * receivers. A closure carrier is not one, so the walk answered `null`:
 * `Object.getPrototypeOf(Temporal.PlainDate.compare)` was `null` where the spec
 * (and the other three assertions of test262's `builtin.js` rows, which already
 * pass) say `Function.prototype`. The class-VALUE case (`Object.getPrototypeOf
 * (Temporal.PlainDate)`) has the identical gap and the identical answer, so it
 * shares this arm rather than a separate one (#6625; originally split, folded
 * back after measuring that `tryEmitDynamicCallableGetPrototypeOf`'s "return
 * true whenever the runtime dispatch was emitted" contract means a SECOND,
 * sequential all-or-nothing arm can never run — the first arm's `if/else`
 * always wins the caller's early return, regardless of which side of it fires).
 *
 * TWO predicates, ORed, not one relaxed predicate: `__is_callable`, NOT
 * `__typeof_function`, and the difference is load-bearing across the link —
 * the boundary's `callable_kind` terminal sets bit 1 ([[Construct]]) for a
 * provider-owned INSTANCE as well, which is why `typeof <provider instance>`
 * currently answers `"function"` (a documented #5383 residual); `__is_callable`
 * masks bit 0 only, so an instance keeps its existing answer instead of
 * acquiring a wrong one. `__is_class_object` is a SEPARATE identity ladder
 * (never a `ref.test`: a class object and its own instances share one struct
 * type AND `__tag`, #3976, so only identity tells "this IS the class C" apart
 * from "this is merely an instance of C") — reusing `__is_callable`'s bit
 * scheme would have required overloading a bit that a provider-owned INSTANCE
 * already sets (same #5383 residual), silently claiming every foreign
 * instance too. Across a linked standalone provider each predicate independently
 * asks the owner (`standalone-link-boundary.ts`) for a BOOLEAN only — the VALUE
 * this function answers is always produced by compiling `Function.prototype`
 * HERE, on the caller's own side, so its identity matches the caller's own
 * later read of it (S22's rule).
 *
 * Class scope: base classes only (no `extends`). A class with a heritage
 * clause keeps today's answer (typically `null`) — DOCUMENTED RESIDUAL, not
 * reduced here; see plan/issues/6625-*.md.
 *
 * Standalone/WASI only; the JS-host lane's `__getPrototypeOf` import already
 * answers correctly and stays byte-identical. The argument is already compiled
 * and coerced to externref on the stack when this runs; returns true when it
 * consumed it.
 */
export function tryEmitDynamicCallableGetPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  if (ensureLateImport(ctx, "__is_callable", [{ kind: "externref" }], [{ kind: "i32" }]) === undefined) return false;
  if (ensureLateImport(ctx, "__is_class_object", [{ kind: "externref" }], [{ kind: "i32" }]) === undefined) {
    return false;
  }
  if (ensureLateImport(ctx, "__getPrototypeOf", [{ kind: "externref" }], [{ kind: "externref" }]) === undefined) {
    return false;
  }
  flushLateImportShifts(ctx, fctx);

  const valueLocal = allocLocal(fctx, `__gpo_dyn_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valueLocal });

  const isCallableIdx = ctx.funcMap.get("__is_callable");
  const isClassObjectIdx = ctx.funcMap.get("__is_class_object");
  const getPrototypeIdx = ctx.funcMap.get("__getPrototypeOf");
  if (isCallableIdx === undefined || isClassObjectIdx === undefined || getPrototypeIdx === undefined) {
    // Degrade to the pre-#6609 answer rather than to a broken call.
    fctx.body.push({ op: "local.get", index: valueLocal });
    return false;
  }

  // (#6630 fallback, 2026-09-17) %Function.prototype% is a lazily-materialised
  // singleton, and materialising it has a module-wide side effect the comment
  // this replaces called "free": it triggers `ensureObjectRuntime`'s bootstrap
  // (`emitFunctionPrototypeObjectSingleton` → `ensureObjectRuntime`), which
  // bakes `__extern_method_call`'s body — including its `.call`/`.apply`
  // dispatch — against whatever helpers are registered AT THAT MOMENT. A
  // pre-existing (merge-independent) defect in that bootstrap, #6630, means a
  // module that materialises %Function.prototype% BEFORE its first `.call`/
  // `.apply` on an ordinary closure can misdispatch that call at runtime
  // ("Function.prototype.call is not yet implemented in --target standalone").
  // #6609/#6625 previously materialised it EAGERLY for every dynamic
  // `Object.getPrototypeOf(<any-typed value>)`, regardless of whether the
  // value actually turned out to be callable — so a module doing nothing more
  // exotic than `Object.getPrototypeOf(<some object>)` followed by an ordinary
  // `fn.call(...)` could trip #6630 even though the getPrototypeOf receiver
  // was never callable (measured: `tests/issue-6484-iterator-prototypes
  // .test.ts`'s "%IteratorPrototype% is the shared parent" case regressed
  // exactly this way once #6629 restored this arm's reachability).
  //
  // Fix at the call site, not at #6630's architecture-level root cause (out of
  // scope here — see #6630): materialise %Function.prototype% LAZILY, inside
  // the `then:` arm, so it is only built (and #6630's bootstrap only triggers)
  // when `__is_callable`/`__is_class_object` have ALREADY proven the value is
  // one of the two cases that need it. A non-callable, non-class-object value
  // — the common case for a bare `Object.getPrototypeOf` probe — never
  // reaches `emitEs5IntrinsicPrototype` at all. #6609/#6625's own witnesses
  // (a genuinely callable/class-object receiver) still take the `then:` arm
  // and get the identical answer; only the ORDER changed (predicate first,
  // materialisation second), not the result.
  const savedThenBody = pushBody(fctx);
  const fnProtoType = emitEs5IntrinsicPrototype(ctx, fctx, anchor, "Function");
  if (fnProtoType !== null && typeof fnProtoType === "object" && fnProtoType.kind !== "externref") {
    coerceType(ctx, fctx, fnProtoType, { kind: "externref" });
  }
  const thenArm = fctx.body;
  popBody(fctx, savedThenBody);

  // Re-read every index AFTER building the then-arm: compiling
  // `Function.prototype` inside it may itself add a late import, which shifts
  // everything emitted before it (mirrors the eager version's own re-read).
  const isCallableIdxFinal = ctx.funcMap.get("__is_callable") ?? isCallableIdx;
  const isClassObjectIdxFinal = ctx.funcMap.get("__is_class_object") ?? isClassObjectIdx;
  const getPrototypeIdxFinal = ctx.funcMap.get("__getPrototypeOf") ?? getPrototypeIdx;
  fctx.body.push(
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: isCallableIdxFinal },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: isClassObjectIdxFinal },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: thenArm,
      else: [
        { op: "local.get", index: valueLocal },
        { op: "call", funcIdx: getPrototypeIdxFinal },
      ],
    },
  );
  return true;
}

function objectGetPrototypeOfSource(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ts.Expression | undefined {
  let current = expr;
  const seen = new Set<ts.Expression>();
  for (let depth = 0; depth < 4; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "getPrototypeOf" &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "Object" &&
      isGlobalBuiltinIdentifier(ctx, fctx, current.expression.expression)
    ) {
      return current.arguments[0];
    }
    if (!ts.isIdentifier(current)) return undefined;
    const initializer = ctx.oracle.variableInitializerOf(current);
    if (!initializer) return undefined;
    current = initializer;
  }
  return undefined;
}

function expressionsAreSameBinding(ctx: CodegenContext, left: ts.Expression, right: ts.Expression): boolean {
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text !== right.text) return false;
  return ctx.oracle.variableDeclarationOf(left) === ctx.oracle.variableDeclarationOf(right);
}

function isEmptyReconstructedConstructor(ctx: CodegenContext, expr: ts.NewExpression): boolean {
  const gate = ctx.fnctorEscapeGate;
  if (!gate?.approved.has(expr) || !ts.isIdentifier(expr.expression)) return false;
  return gate.ctorDeclByName.get(expr.expression.text)?.body?.statements.length === 0;
}

/**
 * (#6651 cluster F) Per-source-file set of identifier NAMES that appear as the
 * `[[Prototype]]`-mutation RECEIVER of a `{Object,Reflect}.setPrototypeOf(x, …)`
 * call or an `x.__proto__ = …` assignment.
 *
 * Why this is scanned here rather than read off `ctx.dynamicProtoLiteralNodes`,
 * which `scanForDynamicProto` already maintains: that set is populated by
 * `markReceiver`, whose FIRST branch is `ctx.oracle.typeFactOf(recv).kind ===
 * "class"` — and test262 rows are **JS**, where TypeScript's expando inference
 * gives `var o = {}` an anonymous type whose symbol carries the VARIABLE's
 * name, so the fact reads `{kind:"class", name:"o"}` and the function returns
 * before it ever records the literal. (Cluster B hit the identical trap from
 * the other side: a gate that admitted only `{kind:"object"}` compiled, fired
 * under a hand-written `.ts` probe, and never fired under the runner.)
 * Measured: for `var o = {}; Reflect.setPrototypeOf(o, proto)` the literal is
 * NOT in `dynamicProtoLiteralNodes`, yet the write lands — so that set is not
 * the fact this reader needs.
 *
 * Cached per `SourceFile`; the walk is structural and runs at most once.
 */
const dynamicProtoReceiverNamesBySource = new WeakMap<ts.SourceFile, Set<string>>();

function dynamicProtoReceiverNames(source: ts.SourceFile): Set<string> {
  const cached = dynamicProtoReceiverNamesBySource.get(source);
  if (cached) return cached;
  const names = new Set<string>();
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur = e;
    while (
      ts.isAsExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    }
    return cur;
  };
  const mark = (e: ts.Expression | undefined): void => {
    if (!e) return;
    const target = unwrap(e);
    if (ts.isIdentifier(target)) names.add(target.text);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.expression.name.text === "setPrototypeOf" &&
      node.arguments.length >= 1
    ) {
      mark(node.arguments[0]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === "__proto__"
    ) {
      mark(node.left.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  dynamicProtoReceiverNamesBySource.set(source, names);
  return names;
}

/**
 * (#6651 cluster F) `Object.getPrototypeOf(o)` where `o`'s prototype is written
 * somewhere in this module: read the field, do not fold.
 *
 * Several downstream arms answer this query from the binding's DECLARATION — an
 * object literal with no colon-form `__proto__` folds to `%Object.prototype%`,
 * and (in the JS shapes test262 is written in) the expando-inferred struct name
 * lands in `ctx.classSet`, so the class arm answers with the compile-time
 * prototype singleton instead. Both are exact for a literal whose prototype is
 * never written and UNSOUND for one whose prototype is written later. Measured
 * on this branch's base: `var o = {}; Reflect.setPrototypeOf(o, proto)` made the
 * inherited read `o.tag` resolve through `proto` — the WRITE was already
 * correct — while `Object.getPrototypeOf(o)` still answered `%Object.prototype%`.
 * One object, one link, two answers.
 *
 * This is the same unsoundness #5270 step 2 recognised for `{ __proto__: v }`;
 * the only difference is that the write is a statement rather than a property.
 *
 * It must ROUTE, not merely decline. A decline in the literal folds below falls
 * through to the class arm, which re-folds — measured: the decline alone moved
 * nothing for the JS shape. So this claims the expression here, ahead of every
 * fold, and emits the generic `__getPrototypeOf` read.
 *
 * Deliberately placed AFTER the integrity arm above: a `preventExtensions`-
 * marked receiver keeps the compiler-owned singleton (its `$proto` field is
 * never written, and `Reflect/setPrototypeOf/return-false-*` assert exactly
 * that answer after a REFUSED set).
 *
 * An unset `$proto` reads back as `%Object.prototype%` through this native, not
 * as `null` — verified with a probe before relying on it, because the whole
 * "refused set leaves Object.prototype" family depends on it.
 *
 * Standalone-gated: the fold is wrong in both lanes, but the host lane answers
 * this query through its own `__getPrototypeOf` import on a real JS object and
 * is not measured by this cluster.
 */
function tryEmitDynamicProtoRuntimeRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg0: ts.Expression,
): InnerResult | null {
  if (!(ctx.standalone || ctx.wasi) || !ts.isIdentifier(arg0)) return null;
  // Narrow on purpose: only a binding whose declaration is a plain object
  // literal. That is the one carrier whose runtime `__getPrototypeOf` answer is
  // verified equivalent to the fold it replaces (an unset `$proto` reads back
  // as `%Object.prototype%`); a name match alone would also claim arrays, class
  // instances and builtin carriers, whose folds are the only correct answer.
  const initializer = ctx.oracle.variableInitializerOf(arg0);
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return null;
  if (!dynamicProtoReceiverNames(arg0.getSourceFile()).has(arg0.text)) return null;
  const gptIdx = ensureLateImport(ctx, "__getPrototypeOf", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (gptIdx === undefined) return null;
  const argType = compileExpression(ctx, fctx, arg0);
  if (!argType) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__getPrototypeOf") ?? gptIdx });
  return { kind: "externref" };
}

function hasProvablyNonNullOrdinaryPrototype(ctx: CodegenContext, expr: ts.Expression): boolean {
  let current = expr;
  const seen = new Set<ts.Expression>();
  for (let depth = 0; depth < 4; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      isTopLevelThis(current) ||
      // (#5270 step 2) `{ __proto__: null }` is an object literal whose
      // prototype IS null — the one literal shape this fold must not claim.
      (ts.isObjectLiteralExpression(current) && !objectLiteralHasColonProto(ctx, current)) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return true;
    }
    if (ts.isNewExpression(current)) return isEmptyReconstructedConstructor(ctx, current);
    if (!ts.isIdentifier(current)) return false;
    const initializer = ctx.oracle.variableInitializerOf(current);
    if (!initializer) return false;
    current = initializer;
  }
  return false;
}

/**
 * Route calls on a getPrototypeOf result through the language-level prototype
 * walk. Statically fold only the direct-parent relation when the source cannot
 * have a null prototype.
 */
export function tryCompileGetPrototypeOfIsPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Expression,
): InnerResult | null {
  const source = objectGetPrototypeOfSource(ctx, fctx, receiver);
  if (!source || expr.arguments.length === 0) return null;

  if (expressionsAreSameBinding(ctx, source, expr.arguments[0]!) && hasProvablyNonNullOrdinaryPrototype(ctx, source)) {
    const receiverType = compileExpression(ctx, fctx, receiver);
    if (receiverType) fctx.body.push({ op: "drop" });
    const candidateType = compileExpression(ctx, fctx, expr.arguments[0]!);
    if (candidateType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32", boolean: true };
  }

  const protoIdx = ensureLateImport(
    ctx,
    "__isPrototypeOf",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const receiverType = compileExpression(ctx, fctx, receiver);
  if (receiverType && receiverType.kind !== "externref") {
    coerceType(ctx, fctx, receiverType, { kind: "externref" });
  }
  const candidateType = compileExpression(ctx, fctx, expr.arguments[0]!);
  if (candidateType && candidateType.kind !== "externref") {
    coerceType(ctx, fctx, candidateType, { kind: "externref" });
  }
  if (protoIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: protoIdx });
  } else {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 0 });
  }
  return { kind: "i32", boolean: true };
}
