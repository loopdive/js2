import { isBigIntType, isBooleanType, isStringType, isSymbolType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * String operations extracted from expressions.ts.
 * Handles string literals, templates, tagged templates, string binary ops,
 * and native string method calls.
 */
import { ts } from "../ts-api.js";
import { emitIsUndefinedSingletonExternAt, isAnyValue, undefinedSingletonActive } from "./any-helpers.js";
import { compileNumericBinaryOp } from "./binary-ops.js";
import { callableToStringLiteral } from "./callable-to-string.js";
import { reserveClosedMethodDispatch } from "./closed-method-dispatch.js";
import { getClosureFuncSelfTypeIdx } from "./closures.js";
import { redundantFlattenCall } from "./lazy-str-flatten.js"; // (#4157)
import { compileAndEmitToString, emitToString } from "./coercion-engine.js";
import { registerStringHelperEmitters } from "./string-emitter-registry.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext, HoistedCharRead } from "./context/types.js";
import { emitThrowTypeError, getFuncParamTypes, noJsHost, usesNativeJsErrors } from "./expressions/helpers.js";
import { addStringImports, flatStringType, nativeStringType, resolveIdentifierType, resolveWasmType } from "./index.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringExternBridge,
  hostStringBridgeUsable,
  nativeStringLiteralInstrs,
  nativeStringTypeNullable,
  stringConstantExternrefInstrs,
  tryCompileNativeVecConcatOperand,
} from "./native-strings.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { htmlWrapperFor } from "./html-wrapper-native.js"; // (#4445) shared with the reflective body
import { emitFlattenWithInlineFlatFastPath } from "./string-materialize.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { collectConcatOperands, ensureNativeBatchedConcat } from "./native-batched-concat.js";
import {
  emitStandaloneRegExpToStringFromExpr,
  isStaticallyUndefinedExpr,
  tryCompileStandaloneStringMatch,
  tryCompileStandaloneStringMatchAll,
  tryCompileStandaloneStringReplace,
  tryCompileStandaloneStringSearch,
  tryCompileStandaloneStringSplit,
} from "./regexp-standalone.js";
import { tryCompileStandaloneSplitSeparator, tryCompileStandaloneStringValueReplace } from "./string-search-value.js";
import { addStringConstantGlobal, ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { resolveStrictConstant, staticStringLength } from "./analysis/static-string-constants.js";
import { staticConstStringValues } from "./analysis/static-string-values.js";
import { staticIntegerRange } from "../ir/analysis/static-numeric-range.js";
import { emitDerivedNativeCharCodeRead, selectProvenAsciiCaseHelper } from "./derived-ascii-case.js";
import { tryEmitStaticI32Expression } from "./i32-static-range-expr.js";
import { tryEmitStaticNeedleIndexOf } from "./static-needle-indexof.js";
import {
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { compileExpression, ensureLateImport, flushLateImportShifts, registerCompileStringLiteral } from "./shared.js";
import {
  coerceType,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
  tryStructToString,
} from "./type-coercion.js";

/**
 * (#2176) Type of a value expression for stringification decisions, preferring
 * the user's own declaration when a bare identifier collides with an ambient
 * lib global. In script mode `const name = …` does not shadow lib.dom's
 * `var name: string`, so `getTypeAtLocation` on a `` `${name}` `` /`"x" + name`
 * operand returns the ambient type (`void`), which mis-fires the
 * undefined/void stringification branch and drops the real value. For a bare
 * identifier, route through `resolveIdentifierType`; everything else is
 * unchanged.
 */
function valueExprTsType(ctx: CodegenContext, node: ts.Expression): ts.Type {
  return ts.isIdentifier(node) ? resolveIdentifierType(ctx, node) : ctx.checker.getTypeAtLocation(node);
}

/** A const local initialized by substring is already a FlatString slice view. */
function isKnownFlatSubstringResult(ctx: CodegenContext, expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = ctx.checker.getSymbolAtLocation(current);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
  const initializer = declaration.initializer;
  return (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.name.text === "substring"
  );
}

/**
 * (#2124) An explicit `undefined` (or `void 0`) passed for an optional string
 * index arg is spec-equivalent to omitting it — the method applies its own
 * default (substring/slice/endsWith end → length, lastIndexOf from → length).
 * But compiling it through the i32 arg path coerces NaN/undefined → 0, which is
 * wrong. Detect the statically-undefined forms so callers can treat the arg as
 * absent. Unwraps paren/as/!-assertion wrappers.
 */
export function isStaticUndefinedArg(arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  let cur: ts.Expression = arg;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion).expression;
  }
  return (
    (ts.isIdentifier(cur) && cur.text === "undefined") ||
    (ts.isVoidExpression(cur) && ts.isNumericLiteral(cur.expression))
  );
}

// ── Guarded funcref cast (ref.test before ref.cast to avoid illegal cast traps) ──
function emitGuardedFuncRefCast(fctx: FunctionContext, funcTypeIdx: number): void {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, {
    kind: "funcref",
  } as ValType);
  fctx.body.push({ op: "local.tee", index: tmpFunc });
  fctx.body.push({ op: "ref.test", typeIdx: funcTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: {
      kind: "val",
      type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType,
    },
    then: [
      { op: "local.get", index: tmpFunc },
      { op: "ref.cast_null", typeIdx: funcTypeIdx },
    ],
    else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
  });
}

function emitNativeStringRefFromExternref(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
}

/**
 * (#3912) Marshal a NATIVE string ref on the stack into a REAL JS string
 * externref, for handing to a JS-host import.
 *
 * ## Why `coerceType(..., externref)` is NOT this
 *
 * `coerceType` lowers a GC ref to externref with `extern.convert_any`, which
 * only *widens the reference* — the host still receives the opaque WasmGC
 * `$NativeString` struct, not a string. `parseInt` then does `ToString` on it
 * and gets `"[object Object]"`-ish behaviour; V8 actually throws
 * `Cannot convert object to primitive value`, and `Number(...)` silently
 * returns `NaN`. Only `__str_to_extern` (which copies the code units out
 * through `__str_to_mem`) produces a genuine JS string.
 *
 * `__str_flatten` first, because a `$ConsString` rope has no contiguous
 * backing array for `__str_to_extern` to copy.
 *
 * This is the exact sequence `console.log`'s string arm and the
 * `string_<method>` host-method bridge already use; it is factored out here so
 * the remaining native→host argument sites can share one spelling.
 *
 * Returns false (emitting nothing) when the bridge is unavailable, so callers
 * can fall back rather than emit an invalid module.
 */
export function emitNativeStringToHostExternref(ctx: CodegenContext, fctx: FunctionContext): boolean {
  // (#3912 follow-up) The bridge needs `env.__str_{from,to}_mem` /
  // `__str_extern_len`. Under `strictNoHostImports` those are DROPPED after
  // being baked into helper bodies → `unresolved call target`, and under
  // wasi/standalone there is no host at all. Decline so the caller keeps its
  // previous lowering instead of producing an unbuildable module.
  if (!hostStringBridgeUsable(ctx)) return false;
  ensureNativeStringExternBridge(ctx);
  flushLateImportShifts(ctx, fctx);
  const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern");
  if (toExternIdx === undefined) return false;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx !== undefined) fctx.body.push({ op: "call", funcIdx: flattenIdx });
  fctx.body.push({ op: "call", funcIdx: toExternIdx });
  return true;
}

/**
 * (#3912) The exact inverse: marshal a REAL JS-host string externref on the
 * stack into a native `$AnyString` ref, for a value that a JS-host import just
 * returned.
 *
 * ## When to use this, and when NOT to
 *
 * Use it when the externref provably came from a **host import** (`JSON_stringify`,
 * the `string_<method>` bridge). Do NOT use it on an externref that came from
 * the **native** number formatter — under native strings `number_toString`
 * returns an `$AnyString` merely widened by `extern.convert_any`, and
 * `__str_from_extern` reads it as a JS string and silently yields the EMPTY
 * string. That confusion is the second half of #3912 (`` `v${3}` `` → `"v"`);
 * the native-formatter case wants `emitNativeStringRefFromExternref` instead.
 *
 * The distinction is provenance, not ValType — both are `externref` — so it can
 * only be made at the producing call site. That is why both directions are
 * emitted next to the call that creates the value.
 *
 * Returns false (emitting nothing) when the bridge is unavailable.
 */
export function emitHostExternrefToNativeString(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  // (#3912 follow-up) See `emitNativeStringToHostExternref` — same three host
  // imports, same strict-mode drop. Decline rather than emit an unbuildable
  // module; the caller then reports the value as a plain `externref`, exactly
  // as it did before #3912.
  if (!hostStringBridgeUsable(ctx)) return null;
  ensureNativeStringExternBridge(ctx);
  flushLateImportShifts(ctx, fctx);
  const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
  if (fromExternIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: fromExternIdx });
  return nativeStringType(ctx);
}

/**
 * #1470 — Compile a `+`-concat operand and coerce its result to a native
 * `ref $AnyString` so it can feed `__str_concat` directly. Used by the
 * nativeStrings concat path (`compileStringBinaryOp`), which otherwise pushed
 * the raw operand value (f64 / i32 / object ref) and produced an invalid module
 * because `__str_concat` expects `ref $AnyString` on both args.
 *
 * Coercion by result kind:
 *   - native string ref (string-typed)      → passthrough
 *   - f64 / i32 / i64 number                 → number_toString + ref-from-extern
 *   - i32 boolean                            → "true"/"false" native literal
 *   - null / undefined externref (static)    → "null"/"undefined" native literal
 *   - object / any ref (`ref`/`ref_null`)    → $__any_to_string dispatch helper
 *
 * Returns true when the operand was compiled and left a `ref $AnyString` on the
 * stack; false when the caller should fall back to its own handling.
 */

function compileNativeConcatOperand(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  // Precondition: caller has established `noJsHost(ctx)` (WASI / --target
  // standalone). There, `number_toString` is the pure-Wasm helper whose
  // externref result wraps a native `$AnyString` (so `any.convert_extern` +
  // `ref.cast $AnyString` is valid), and dynamic refs route through the
  // in-module `$__any_to_string` dispatcher. No JS-host bridge is involved.
  const tsType = valueExprTsType(ctx, operand); // #2176 ambient-shadow safe
  const opType = compileExpression(ctx, fctx, operand);
  if (!opType) {
    // void result → "undefined"
    compileStringLiteral(ctx, fctx, "undefined", operand);
    return true;
  }

  // #1917 NOTE: this native (standalone) `+`-concat operand cascade is
  // DELIBERATELY NOT migrated to the single coercion engine. The engine's
  // `emitToString` number arm runs `emitNativeStringRefFromExternref`
  // (`any.convert_extern`) on its scalar input; when `number_toString` is NOT
  // registered (e.g. a `String(x)` result that returned a bare f64 reached the
  // concat operand — the #1960 standalone S9.8.1 regression), that emits
  // `any.convert_extern` on a bare f64 → INVALID Wasm, whereas the cascade below
  // gates the numeric arm on `toStrIdx !== undefined` and DECLINES (returns
  // false → legacy `compileExpression(value, nativeStringType)`), which stays
  // valid. Folding this site needs the engine to model that decline exactly; it
  // is a tracked follow-up increment. The HOST concat/template ToString sites
  // ARE migrated (js-host-only, standalone-gate-proven safe).

  // Already a native string operand (string-typed ref) — pass straight through.
  // (#745 S3) EXCEPT an `$AnyValue` carrier: a `number|string` union local
  // narrowed to `string` still compiles to `ref_null $AnyValue` under
  // `unionAnyRep`; passing it through made the caller `ref.cast $AnyString`
  // an incompatible struct (an always-trapping nullref cast). Fall to the
  // dynamic-ref arm below, whose `$__any_to_string` extracts the tag-5
  // payload (and stringifies any other tag).
  if ((opType.kind === "ref" || opType.kind === "ref_null") && isStringType(tsType) && !isAnyValue(opType, ctx)) {
    return true;
  }

  const toStrIdx = ctx.funcMap.get("number_toString");

  // (#4414) `|| opType.boolean` — the static type alone misses a devirtualized
  // prototype-method call: `p.eat(5)` on an untyped constructor is `any` to the
  // checker, but the direct-call trampoline returns the callee's BRANDED i32
  // (`{kind:"i32", boolean:true}`). Without the brand check the value fell into
  // the numeric arm below and `("" + p.eat(5))` printed "1", not "true". The
  // binary-op concat path already checks the brand; this cascade and the
  // template-span path did not.
  if (opType.kind === "i32" && (isBooleanType(tsType) || opType.boolean === true)) {
    // Boolean → "true"/"false" native literal selected at runtime.
    const trueInstrs = nativeStringLiteralInstrs(ctx, "true");
    const falseInstrs = nativeStringLiteralInstrs(ctx, "false");
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: trueInstrs,
      else: falseInstrs,
    });
    return true;
  }

  if ((opType.kind === "f64" || opType.kind === "i32" || opType.kind === "i64") && toStrIdx !== undefined) {
    if (opType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (opType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
    fctx.body.push({ op: "call", funcIdx: toStrIdx });
    emitNativeStringRefFromExternref(ctx, fctx);
    return true;
  }

  // (#4265) §13.15.3 ToPrimitive of a CALLABLE reaches Function.prototype.toString
  // (§20.2.3.5), never Object.prototype.toString — so a function operand must
  // never stringify as "[object Object]". Placed before BOTH dynamic arms
  // because a callable arrives either as an externref (host object, Proxy) or as
  // a closure struct ref. See callable-to-string.ts for the spec argument.
  if (opType.kind === "externref" || opType.kind === "ref" || opType.kind === "ref_null") {
    const callableText = callableToStringLiteral(tsType);
    if (callableText !== undefined) {
      fctx.body.push({ op: "drop" });
      compileStringLiteral(ctx, fctx, callableText, operand);
      return true;
    }
  }

  if (opType.kind === "externref") {
    // Statically null / undefined → direct native literal (avoids a host call).
    const isNull = (tsType.flags & ts.TypeFlags.Null) !== 0;
    const isUndef = (tsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (isNull) {
      fctx.body.push({ op: "drop" });
      compileStringLiteral(ctx, fctx, "null", operand);
      return true;
    }
    if (isUndef) {
      fctx.body.push({ op: "drop" });
      compileStringLiteral(ctx, fctx, "undefined", operand);
      return true;
    }
    // Dynamic externref (boxed string / any / $Object) → runtime ToString.
    // For standalone $Object values this routes through native
    // OrdinaryToPrimitive("string") before the native-string concat helper.
    const dynToStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (dynToStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: dynToStrIdx });
    }
    emitNativeStringRefFromExternref(ctx, fctx);
    return true;
  }

  if (opType.kind === "ref" || opType.kind === "ref_null") {
    // #2007 — a statically-known vec (array) operand stringifies via
    // Array.prototype.join semantics ("1,2"), not the `$__any_to_string`
    // "[object Object]" fallthrough. The concrete vec type is known here, so
    // emit the join lowering inline (index-shift-safe — see #1448).
    if (tryCompileNativeVecConcatOperand(ctx, fctx, opType)) {
      return true;
    }
    // #1806 Phase 1 (string-hint): when the operand is a compile-time-resolvable
    // object struct with its own `@@toPrimitive`/`toString`, dispatch that method
    // (OrdinaryToPrimitive, hint "string") instead of `$__any_to_string`, which
    // can only yield "[object Object]" for a struct it cannot introspect.
    if (tryStructToString(ctx, fctx, opType)) {
      return true;
    }
    // Object / array / any-boxed ref → $__any_to_string. The helper accepts
    // anyref (the supertype), so the struct ref is already assignable.
    const anyToStrIdx = ensureAnyToStringHelper(ctx);
    fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
    return true;
  }

  // Unknown kind — leave on stack for the caller. (Should not happen for `+`.)
  return false;
}

/**
 * Unwrap parenthesised / `as` / `!` / `<T>` wrappers to reach the underlying
 * expression — mirrors {@link isStaticUndefinedArg}. Used by the IsRegExp
 * static fold so `(/./ as any)`-style casts don't hide a RegExp literal.
 */
function unwrapArgExpr(arg: ts.Expression): ts.Expression {
  let cur: ts.Expression = arg;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion).expression;
  }
  return cur;
}

/**
 * #2598 — Static IsRegExp (§22.1.3.{6,7,21}) for the `includes`/`startsWith`/
 * `endsWith` search argument. Returns true when the argument is *statically* a
 * RegExp (so the caller emits an unconditional `throw TypeError`):
 *   - a RegExp literal (`/foo/`),
 *   - `new RegExp(...)`,
 *   - an expression whose static TS type is `RegExp`.
 * The dynamic `Symbol.match`-presence form (an `any`/object arg that turns out
 * to be a RegExp at runtime) is out of scope for this slice — the test262
 * reachable set is the static literal form. (#2580 M2 covers `any` receivers.)
 */
function argIsStaticRegExp(ctx: CodegenContext, arg: ts.Expression): boolean {
  const inner = unwrapArgExpr(arg);
  if (ts.isRegularExpressionLiteral(inner)) return true;
  if (ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "RegExp") {
    return true;
  }
  // Type-based: a variable / call statically typed `RegExp`.
  try {
    const t = ctx.checker.getTypeAtLocation(inner);
    const sym = t.getSymbol() ?? t.aliasSymbol;
    if (sym?.getName() === "RegExp") return true;
  } catch {
    /* type unavailable — fall through to "not static RegExp" */
  }
  return false;
}

/**
 * #2598/#2599 — Coerce a String.prototype search/concat ARGUMENT to a native
 * `ref $AnyString` via ToString (§7.1.17), reusing the existing native-string
 * coercion engine ({@link compileNativeConcatOperand}, the same path `+`-concat
 * uses) — NOT a new coercion site (respects the #2108 drift gate).
 *
 * Standalone / WASI (`noJsHost`) only: there the engine turns a number/boolean/
 * null/undefined/object argument into a native string instead of feeding a
 * mistyped ref to `__str_flatten`/`__str_concat` (which null-derefs). Symbol
 * args throw a TypeError per §7.1.17. In the legacy JS-host `nativeStrings`
 * mode the old `compileExpression(value, nativeStringType)` behaviour is kept
 * byte-identical (these issues are scoped to standalone).
 *
 * Leaves exactly one `ref $AnyString` on the stack.
 */
export function emitArgAsNativeString(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): void {
  if (noJsHost(ctx)) {
    // §7.1.17 ToString(Symbol) throws. Guard before the engine (which would
    // otherwise route a symbol through `$__any_to_string`).
    if (tryThrowOnSymbolStringCoercion(ctx, fctx, value)) {
      // After the unreachable throw the stack is polymorphic, but downstream
      // code expects a native-string ref; push a null sentinel of that type.
      fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
      return;
    }
    // A static / backend-created RegExp argument (`indexOf(/./)` — no IsRegExp
    // guard) stringifies to its `RegExp.prototype.toString` source form
    // ("/" + source + "/" + flags), NOT the `$__any_to_string` "[object Object]"
    // fallthrough (#2161, same path the `+`/template engine uses). For the
    // IsRegExp-throwing methods the caller has already thrown before this point.
    const reStr = emitStandaloneRegExpToStringFromExpr(ctx, fctx, value);
    if (reStr !== undefined && reStr !== null) return;
    // The engine's f64/i32/i64 number arm needs `number_toString` in funcMap.
    // Unlike the `+`-concat path, the string-method pre-pass does not flag a
    // search/concat argument as needing it, so register it on demand here
    // (idempotent — guarded by `funcMap.has`). Mirrors the numeric-`join` path.
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    if (compileNativeConcatOperand(ctx, fctx, value)) return;
    // Engine declined (unexpected shape) — fall through to the legacy coercion.
  }
  compileExpression(ctx, fctx, value, nativeStringType(ctx));
}

/**
 * (#3254) The reachable-set members of a receiver's TS type — the union
 * constituents, or `[t]` for a non-union. Used to decide whether a borrowed
 * `String.prototype.<m>.call(this)` receiver could be `null`/`undefined` (and so
 * needs the §22.1.3 `RequireObjectCoercible` runtime throw) vs is definitely a
 * coercible primitive/object (ToString directly).
 */
function receiverTypeCouldBeNullish(t: ts.Type): boolean {
  const F = ts.TypeFlags;
  const NULLISH = F.Null | F.Undefined | F.Void | F.Any | F.Unknown;
  const members = t.isUnion() ? t.types : [t];
  return members.some((m) => (m.flags & NULLISH) !== 0);
}

/**
 * (#3254) Coerce a **borrowed** `String.prototype.<m>.call(thisArg, …)` receiver
 * to a native `ref $AnyString`, implementing the §22.1.3 method preamble
 * `? RequireObjectCoercible(this)` then `S = ? ToString(this)`:
 *
 *   - `null` / `undefined` (static, or the runtime `$undefined` singleton / a
 *     null externref) → **throw TypeError** (RequireObjectCoercible). This is
 *     what the ~76 `assert.throws(TypeError, …)` trim-family tests assert, and
 *     the shared this-coercion site feeds EVERY `STANDALONE_STR_PROTO_METHODS`
 *     entry (charAt / indexOf / slice / toUpperCase / …), so the fix generalises
 *     beyond trim.
 *   - everything else → `ToString(this)` via the type-aware native coercion
 *     engine ({@link emitArgAsNativeString} / {@link compileNativeConcatOperand}):
 *     boolean → `"true"`/`"false"`, number → its decimal form, object → its own
 *     `toString()` (OrdinaryToPrimitive, hint string, which may itself throw),
 *     string → passthrough.
 *
 * Root cause it fixes: the standalone borrowed-method dispatch (calls.ts) used
 * to synthesise `recv.<m>()` and lean on `compileNativeStringMethodCall`'s
 * default `emitReceiver`, which only handled a string-typed / object-struct
 * receiver — a boolean/number `this` fell through to the `$__any_to_string`
 * `"[object Object]"` terminal, and `undefined` (the non-null tag-1 singleton)
 * silently coerced instead of throwing. The reflective closure body
 * (`emitStringTrimMemberBody`) already did ROC+ToString, but the `.call()` fast
 * path bypasses it.
 *
 * Standalone / WASI only (the caller is `ctx.standalone`-gated). Leaves exactly
 * one `ref $AnyString` on the stack.
 */
export function emitBorrowedStringReceiverToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverArg: ts.Expression,
  method: string,
): ValType | null {
  const roMsg = `String.prototype.${method} called on null or undefined`;
  const tsType = valueExprTsType(ctx, receiverArg);

  // Definitely-coercible receiver (boolean / number / string / object / bigint —
  // never null|undefined|any|unknown) → ToString directly, no ROC guard needed.
  if (!receiverTypeCouldBeNullish(tsType)) {
    emitArgAsNativeString(ctx, fctx, receiverArg);
    return nativeStringType(ctx);
  }

  // Receiver could be null/undefined (static `null`/`undefined`, or a dynamic
  // `any`/nullish-union) → evaluate ONCE to an externref, RequireObjectCoercible
  // (throw on null OR the `$undefined` singleton), then ToString via the pure
  // in-module `$__any_to_string` dispatcher (host-free; handles boxed
  // string/number/boolean and objects).
  const recvExtern = allocLocal(fctx, `__borrow_this_${fctx.locals.length}`, { kind: "externref" });
  const rt = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (rt && rt.kind !== "externref") {
    coerceType(ctx, fctx, rt, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: recvExtern });

  // nullish = ref.is_null(recv)  [∨ isUndefinedSingleton(recv) when the regime
  // is active — undefined is then a NON-null tag-1 box that ref.is_null misses].
  fctx.body.push({ op: "local.get", index: recvExtern });
  fctx.body.push({ op: "ref.is_null" });
  if (undefinedSingletonActive(ctx)) {
    const scratchAny = allocLocal(fctx, `__borrow_this_any_${fctx.locals.length}`, { kind: "anyref" });
    if (emitIsUndefinedSingletonExternAt(ctx, fctx, recvExtern, scratchAny)) {
      fctx.body.push({ op: "i32.or" });
    }
  }
  const throwInstrs: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwInstrs, roMsg);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });

  // S = ToString(this)
  fctx.body.push({ op: "local.get", index: recvExtern });
  fctx.body.push({ op: "any.convert_extern" });
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
  return nativeStringType(ctx);
}

// ── String operations ─────────────────────────────────────────────────

export function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
): ValType | null {
  // Fast mode: materialize as NativeString GC struct inline
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeStringLiteral(ctx, fctx, value);
  }

  // Use importedStringConstants: string literals are global imports
  const globalIdx = ctx.stringGlobalMap.get(value);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
    return { kind: "externref" };
  }

  // Late registration: string was not collected in first pass — register on demand
  addStringImports(ctx);
  addStringConstantGlobal(ctx, value);
  const lateGlobalIdx = ctx.stringGlobalMap.get(value);
  if (lateGlobalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: lateGlobalIdx });
    return { kind: "externref" } as ValType;
  }

  // Truly unreachable — all paths above should succeed
  reportError(ctx, node!, `String literal not registered: "${value}"`);
  return null;
}

/**
 * Materialize a string literal as a NativeString GC struct in fast mode.
 * Emits array.new_fixed with the WTF-16 code units, then struct.new.
 */
export function compileNativeStringLiteral(ctx: CodegenContext, fctx: FunctionContext, value: string): ValType {
  // (#3673) Interned: one immutable module global per distinct literal,
  // materialized once at instantiation; the site is a single `global.get`.
  // See `nativeStringLiteralInstrs` for the rationale + the oversized-literal
  // inline fallback.
  fctx.body.push(...nativeStringLiteralInstrs(ctx, value));
  return nativeStringType(ctx);
}

/**
 * (#2515 S0) Push a literal string constant onto the stack as an externref-typed
 * value, sentinel-safe across both host and standalone/nativeStrings modes.
 *
 * Root cause this fixes: several stringify sites materialised a fixed word
 * (`"null"`/`"undefined"`) by calling `addStringConstantGlobal(ctx, word)` and
 * then emitting `global.get ctx.stringGlobalMap.get(word)!`. In standalone /
 * `nativeStrings` mode `addStringConstantGlobal` stores the documented `-1`
 * sentinel ("no host `string_constants` global — materialize inline", see
 * registry/imports.ts) rather than a real global index, so the non-null
 * assertion happily baked `global.get -1` into the body. That `-1` later
 * tripped the always-on #2043 emit-time index validator with
 * `global index out of range — -1`, failing binary emit for the whole module
 * (the #2515 S0 / #2029 late-import-index-shift residual cluster).
 *
 * Routing through `compileStringLiteral` is correct in BOTH modes: in
 * standalone it takes the `nativeStrings && nativeStrTypeIdx >= 0` fast path and
 * builds a `$NativeString` GC struct inline (no global, no host import); in
 * host mode it resolves/registers the real `string_constants` global and emits
 * the `global.get`. Either way the value left on the stack is concat-ready
 * externref-or-native-string, matching what the old `global.get` produced.
 */
function pushStringConstant(ctx: CodegenContext, fctx: FunctionContext, word: string): void {
  compileStringLiteral(ctx, fctx, word);
}

export function compileTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  // Fast mode: use native string concat
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeTemplateExpression(ctx, fctx, expr);
  }

  // §13.2.8.6 / ToString(Symbol) throws — a Symbol substitution in a template
  // literal must throw TypeError rather than stringify the internal id.
  for (const span of expr.templateSpans) {
    if (tryThrowOnSymbolStringCoercion(ctx, fctx, span.expression)) {
      return { kind: "externref" };
    }
  }

  // Ensure string imports (concat, etc.) are available — template literals need concat
  addStringImports(ctx);

  const concatIdx = ctx.jsStringImports.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) return null;

  // Start with the head text (may be empty string "")
  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  } else {
    // Empty head — we'll start from the first span's expression
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    // Compile the substitution expression and coerce to string if needed.
    // Mirrors the binary `+` concat path (compileStringBinaryExpression) so
    // booleans stringify to "true"/"false" (#2005) and null/undefined spans
    // produce "null"/"undefined" rather than tripping the js-string concat
    // cast (#2006).
    // #2176: a bare-identifier span (`` `${name}` ``) whose name collides with
    // an ambient lib global (e.g. lib.dom's `var name: string`) resolves, in
    // script mode, to the ambient symbol (`void`), which would mis-fire the
    // undefined/void branch below and drop the real value. valueExprTsType
    // re-derives from the user binding when it shadows the ambient.
    const spanTsType = valueExprTsType(ctx, span.expression);
    // #1931: `undefined`/`null` literals lower to a type-default scalar (i32 0)
    // rather than an externref, so detect them by static type before codegen
    // and substitute the spec stringification instead of running the scalar
    // through number_toString (which would print "0").
    const spanIsUndefType = (spanTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    const spanIsNullType = (spanTsType.flags & ts.TypeFlags.Null) !== 0;
    const spanType = compileExpression(ctx, fctx, span.expression);
    if ((spanIsUndefType || spanIsNullType) && spanType && spanType.kind !== "externref") {
      // Scalar-lowered null/undefined → drop the placeholder value and push the
      // matching string constant (#2005 undefined, #2006 null). This stays in
      // the caller: the engine classifies by ValType + TS type and would
      // otherwise stringify the scalar (i32 0) as "0". (#2515 S0) sentinel-safe.
      fctx.body.push({ op: "drop" });
      const word = spanIsNullType ? "null" : "undefined";
      pushStringConstant(ctx, fctx, word);
    } else {
      // #1917 — template spans apply ToString proper (hint "string": a ref
      // operand walks @@toPrimitive("string")/toString). The single coercion
      // engine owns the bool/number/i64/externref-null-undef/opaque-extern/ref
      // cascade that was hand-rolled here.
      emitToString(ctx, fctx, spanType, spanTsType, "string");
    }

    // If we had a head (or previous spans), concat with accumulated string
    if (i === 0 && !expr.head.text) {
      // No head — the expression result IS the accumulated string so far
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    // Append the span's literal text (the part after ${...} up to next ${ or backtick)
    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return { kind: "externref" };
}

/**
 * Compile a template expression in fast mode, using native string concat.
 * Number substitutions are converted via number_toString (returns externref)
 * then marshaled to native string.
 */
export function compileNativeTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  // §13.2.8.6 / ToString(Symbol) throws — see compileTemplateExpression.
  for (const span of expr.templateSpans) {
    if (tryThrowOnSymbolStringCoercion(ctx, fctx, span.expression)) {
      return nativeStringType(ctx);
    }
  }

  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  const standaloneNativeStrings = noJsHost(ctx);
  // #1618/#1759: the extern bridge (__str_to_extern/__str_from_extern) is
  // JS-host-only — it marshals via __str_to_mem/__str_from_mem host imports
  // that don't exist under --target wasi/standalone, where they collapse to
  // bogus indices and produce an invalid module. Only emit it when the template
  // actually needs externref marshaling AND a JS host is available. In
  // WASI/standalone, numeric substitutions use the native number_toString
  // helper and convert its internally-created externref back to ref $AnyString
  // with Wasm reference conversions, not host imports.
  const hasNonStringSpan = expr.templateSpans.some((s) => !isStringType(ctx.checker.getTypeAtLocation(s.expression)));
  if (hasNonStringSpan && !standaloneNativeStrings) {
    ensureNativeStringExternBridge(ctx);
    flushLateImportShifts(ctx, fctx);
  }
  const fromExternIdx = standaloneNativeStrings ? undefined : ctx.nativeStrHelpers.get("__str_from_extern");
  if (concatIdx === undefined) return null;

  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    const spanNativeTsType = valueExprTsType(ctx, span.expression); // #2176 ambient-shadow safe
    // #1931: `undefined`/`null` lower to a type-default scalar (i32 0), so
    // resolve them from the static type before codegen and emit the spec
    // stringification rather than "0" (parallels the JS-host path).
    const spanNativeIsUndef = (spanNativeTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    const spanNativeIsNull = (spanNativeTsType.flags & ts.TypeFlags.Null) !== 0;

    // #2161 — a static / backend-created RegExp substitution stringifies via its
    // native RegExp.prototype.toString (§22.2.6.14 → "/" + source + "/" + flags),
    // not the `$__any_to_string` "[object Object]" fallthrough below. The core
    // compiles the receiver itself and leaves a native string ref on the stack,
    // so route through it BEFORE compileExpression and skip the type cascade.
    if (standaloneNativeStrings) {
      const reStr = emitStandaloneRegExpToStringFromExpr(ctx, fctx, span.expression);
      if (reStr !== undefined && reStr !== null) {
        if (i === 0 && !expr.head.text) {
          // no head — first span result is the running accumulator
        } else {
          fctx.body.push({ op: "call", funcIdx: concatIdx });
        }
        if (span.literal.text) {
          compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
          fctx.body.push({ op: "call", funcIdx: concatIdx });
        }
        continue;
      }
    }

    const spanType = compileExpression(ctx, fctx, span.expression);
    const spanIsScalarNullish = (spanNativeIsUndef || spanNativeIsNull) && spanType && spanType.kind !== "externref";
    // (#4414) brand check mirrors the binary-op concat path — see
    // compileNativeConcatOperand.
    const spanIsBool =
      spanType && spanType.kind === "i32" && (isBooleanType(spanNativeTsType) || spanType.boolean === true);
    if (spanIsScalarNullish) {
      // Scalar-lowered null/undefined → drop the placeholder, build the native
      // string constant inline (#2005/#2006). Leaves the native string ref on
      // the stack for the shared concat tail below.
      fctx.body.push({ op: "drop" });
      compileStringLiteral(ctx, fctx, spanNativeIsNull ? "null" : "undefined", span.expression);
    } else if (spanIsBool) {
      // boolean i32 → native "true"/"false" (#2005)
      emitBoolToString(ctx, fctx);
    }
    const spanIsString =
      !spanIsScalarNullish &&
      !spanIsBool &&
      spanType &&
      (spanType.kind === "ref" || spanType.kind === "ref_null") &&
      isStringType(spanNativeTsType); // #2176 ambient-shadow safe
    if (spanIsScalarNullish || spanIsBool) {
      // value already on stack — fall through to the concat tail
    } else if (spanIsString) {
      // #1618: a string-typed substitution is ALREADY a native string ref
      // (AnyString / NativeString). Concat it directly — do NOT round-trip
      // through externref via __str_to_extern/__str_from_extern. That bridge is
      // JS-host-only (__str_to_mem / __str_from_mem imports) and produces an
      // invalid module under --target wasi/standalone, where those host imports
      // don't exist and collapse to bogus function indices. __str_concat accepts
      // the AnyString supertype, so a ref_null is fine to pass straight through.
      // (No marshaling instructions emitted — value stays on the stack.)
    } else if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      // (#3912) This and the i32/i64 arms unbox UNCONDITIONALLY — never via
      // `standaloneNativeStrings`. `__str_from_extern` marshals a genuine
      // JS-host string through `__str_from_mem`, but since #3912 keys the
      // formatter's provider on `ctx.nativeStrings`, `number_toString` is
      // NATIVE in every mode this function runs in: its externref is an
      // `$AnyString` merely widened by `extern.convert_any`. The host bridge
      // silently yields EMPTY for that box — which is how `` `v${3}` ``
      // evaluated to "v". The right question is not "is a JS host available?"
      // but "did this externref come from the native formatter?", and here it
      // always did. The dynamic-externref / struct arms below KEEP the bridge:
      // those really do carry host strings.
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      emitNativeStringRefFromExternref(ctx, fctx);
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      // (#3912) native-formatter box — see the f64 arm above.
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      emitNativeStringRefFromExternref(ctx, fctx);
    } else if (spanType && spanType.kind === "i64" && toStrIdx !== undefined) {
      // (#3912) native-formatter box — see the f64 arm above.
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      emitNativeStringRefFromExternref(ctx, fctx);
    } else if (spanType && (spanType.kind === "f64" || spanType.kind === "i32" || spanType.kind === "i64")) {
      reportError(ctx, span.expression, "Template literal numeric substitution requires number_toString");
      fctx.body.push({ op: "drop" });
      compileStringLiteral(ctx, fctx, "", span.expression);
    } else if (spanType && spanType.kind === "externref") {
      // #1470 — `any`-typed substitution lowers to externref. In standalone /
      // WASI mode route it through the pure-Wasm `$__any_to_string` dispatch
      // helper (bridge externref→anyref first). In JS-host mode coerce to an
      // externref string via the @@toPrimitive("string") walker as before.
      if (standaloneNativeStrings) {
        const isNull = (spanNativeTsType.flags & ts.TypeFlags.Null) !== 0; // #2176 ambient-shadow safe
        const isUndef = (spanNativeTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
        if (isNull) {
          fctx.body.push({ op: "drop" });
          compileStringLiteral(ctx, fctx, "null", span.expression);
        } else if (isUndef) {
          fctx.body.push({ op: "drop" });
          compileStringLiteral(ctx, fctx, "undefined", span.expression);
        } else {
          const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (toStrIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: toStrIdx });
          }
          emitNativeStringRefFromExternref(ctx, fctx);
        }
      } else {
        coerceType(ctx, fctx, spanType, { kind: "externref" }, "string");
        if (fromExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: fromExternIdx });
        }
      }
    } else if (spanType && (spanType.kind === "ref" || spanType.kind === "ref_null")) {
      if (standaloneNativeStrings) {
        // #2007 — a vec (array) substitution stringifies via join semantics
        // ("1,2") rather than the `$__any_to_string` "[object Object]"
        // fallthrough. Concrete vec type is known here; emit the join lowering
        // inline (index-shift-safe — see #1448).
        if (tryCompileNativeVecConcatOperand(ctx, fctx, spanType)) {
          // joined native string is on the stack — fall through to concat tail
        } else if (!tryStructToString(ctx, fctx, spanType)) {
          // #1806 Phase 1 (string-hint): compile-time-resolvable object struct →
          // dispatch its own `@@toPrimitive`/`toString` (OrdinaryToPrimitive, hint
          // "string"). Falls through to `$__any_to_string` only when no static
          // method exists (e.g. eqref-stored closure) — which yields AnyString
          // passthrough / AnyValue tag dispatch / "[object Object]" as before.
          const anyToStrIdx = ensureAnyToStringHelper(ctx);
          fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
        }
      } else {
        // Struct ref → externref: use coerceType which checks @@toPrimitive("string") first
        coerceType(ctx, fctx, spanType, { kind: "externref" }, "string");
      }
      if (!standaloneNativeStrings && fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    }
    // ref $NativeString is already the right type

    if (i === 0 && !expr.head.text) {
      // No head — expression result is accumulated string
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return nativeStringType(ctx);
}

// ── Tagged template expressions ──────────────────────────────────────

/** Is `tag` syntactically the builtin `String.raw`? (#2008) */
function isStringRawTag(tag: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === "String" &&
    tag.name.text === "raw"
  );
}

/**
 * Lower `String.raw`tmpl`` to the RAW parts interleaved with the stringified
 * substitutions, as a plain in-module string concat (#2008). The raw parts are
 * compile-time string literals, so no template struct read or host bridge is
 * needed — this works in both JS-host and standalone/native-strings modes.
 */
function compileStringRaw(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TaggedTemplateExpression,
  rawParts: readonly string[],
  substitutions: readonly ts.Expression[],
): ValType | null {
  addStringImports(ctx);

  // (#2160) Native-strings (standalone / WASI) path. The generic host-concat
  // loop below mixes representations here: a numeric substitution leaves an f64
  // / a `number_toString` externref that the native accumulator (a `ref
  // $AnyString` from `compileStringLiteral`) cannot concat — producing
  // `any.convert_extern expected externref, found f64` (an INVALID standalone
  // binary for `String.raw\`a${1}b\``). Mirror `compileTemplateExpression`'s
  // native branch: coerce EVERY operand to `ref $AnyString` via the proven
  // `compileNativeConcatOperand` helper and concat with native `__str_concat`.
  // The no-substitution case already worked via the generic template-vec fix;
  // this fixes the WITH-substitution case. (My prior #1812 added this branch
  // but was closed as superseded after only the no-subst case was probed.)
  if (noJsHost(ctx) && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const nativeConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
    if (nativeConcatIdx === undefined) {
      reportError(ctx, expr, "String.raw: native string concat helper unavailable");
      return null;
    }
    compileNativeStringLiteral(ctx, fctx, rawParts[0] ?? "");
    for (let i = 0; i < substitutions.length; i++) {
      // Stringify + native-coerce the substitution to `ref $AnyString`, concat.
      if (!compileNativeConcatOperand(ctx, fctx, substitutions[i]!)) {
        compileNativeStringLiteral(ctx, fctx, "undefined");
      }
      fctx.body.push({ op: "call", funcIdx: nativeConcatIdx });
      // Append the following raw part.
      compileNativeStringLiteral(ctx, fctx, rawParts[i + 1] ?? "");
      fctx.body.push({ op: "call", funcIdx: nativeConcatIdx });
    }
    return nativeStringType(ctx);
  }

  const concatIdx = ctx.jsStringImports.get("concat") ?? ctx.nativeStrHelpers.get("__str_concat");
  if (concatIdx === undefined) {
    reportError(ctx, expr, "String.raw: string concat helper unavailable");
    return null;
  }
  const toStrIdx = ctx.funcMap.get("number_toString");

  // rawParts has length substitutions.length + 1: raw0 sub0 raw1 sub1 ... rawN.
  // Start the accumulator with raw0.
  compileStringLiteral(ctx, fctx, rawParts[0] ?? "", expr);

  for (let i = 0; i < substitutions.length; i++) {
    const sub = substitutions[i]!;
    const subTsType = valueExprTsType(ctx, sub); // #2176 ambient-shadow safe
    const subIsUndef = (subTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    const subIsNull = (subTsType.flags & ts.TypeFlags.Null) !== 0;
    const subType = compileExpression(ctx, fctx, sub);

    if ((subIsUndef || subIsNull) && subType && subType.kind !== "externref") {
      fctx.body.push({ op: "drop" });
      const word = subIsNull ? "null" : "undefined";
      pushStringConstant(ctx, fctx, word);
    } else if (subType && subType.kind === "i32" && isBooleanType(subTsType)) {
      emitBoolToString(ctx, fctx);
    } else if (subType && subType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (subType && subType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (subType && subType.kind === "i64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (subType && subType.kind === "externref") {
      if (subIsNull) {
        fctx.body.push({ op: "drop" });
        pushStringConstant(ctx, fctx, "null");
      } else if (subIsUndef) {
        fctx.body.push({ op: "drop" });
        pushStringConstant(ctx, fctx, "undefined");
      } else if (!isStringType(subTsType)) {
        const externToStrIdx = ensureLateImport(
          ctx,
          "__extern_toString",
          [{ kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        const finalIdx = ctx.funcMap.get("__extern_toString") ?? externToStrIdx;
        if (finalIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalIdx });
      }
    } else if (subType && (subType.kind === "ref" || subType.kind === "ref_null")) {
      coerceType(ctx, fctx, subType, { kind: "externref" }, "string");
    }
    // Accumulator + stringified substitution.
    fctx.body.push({ op: "call", funcIdx: concatIdx });

    // Append the following raw part.
    compileStringLiteral(ctx, fctx, rawParts[i + 1] ?? "", expr);
    fctx.body.push({ op: "call", funcIdx: concatIdx });
  }

  return { kind: "externref" };
}

/**
 * Compile a tagged template expression: tag`hello ${x} world`
 * Desugars to: tag(["hello ", " world"], x)
 *
 * Implementation: build a WasmGC externref array (vec struct) of string parts,
 * then call the tag function with the array as first arg and substitutions
 * as remaining args. NO host imports needed.
 */
export function compileTaggedTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TaggedTemplateExpression,
): ValType | null {
  // Extract string parts (cooked + raw) and substitution expressions from the template
  const stringParts: string[] = [];
  const rawParts: string[] = [];
  const substitutions: ts.Expression[] = [];

  if (ts.isNoSubstitutionTemplateLiteral(expr.template)) {
    // tag`just a string` — one string part, no substitutions
    stringParts.push(expr.template.text);
    rawParts.push((expr.template as any).rawText ?? expr.template.text);
  } else {
    // TemplateExpression: head + spans
    const tmpl = expr.template as ts.TemplateExpression;
    stringParts.push(tmpl.head.text);
    rawParts.push((tmpl.head as any).rawText ?? tmpl.head.text);
    for (const span of tmpl.templateSpans) {
      substitutions.push(span.expression);
      stringParts.push(span.literal.text);
      rawParts.push((span.literal as any).rawText ?? span.literal.text);
    }
  }

  // Build the strings array as a WasmGC template vec (vec + raw field)
  // Per spec, template objects are cached per call site — the same source location
  // must yield the same template object on every call. We use a module global
  // (initialized to ref.null) per call site; on first call we create the array
  // and store it in the global, on subsequent calls we load the cached value.
  const elemKind = "externref";
  const elemWasm: ValType = { kind: "externref" };
  const baseVecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, baseVecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, "Tagged template: invalid vec type for strings array");
    return null;
  }

  // Register the template vec type (vec struct + raw field)
  const templateVecTypeIdx = getOrRegisterTemplateVecType(ctx);

  // Allocate a module global to cache this call site's template object
  const cacheId = ctx.templateCacheCounter++;
  const cacheGlobalType: ValType = {
    kind: "ref_null",
    typeIdx: templateVecTypeIdx,
  };
  const cacheGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__tt_cache_${cacheId}`,
    type: cacheGlobalType,
    mutable: true,
    init: [{ op: "ref.null", typeIdx: templateVecTypeIdx }],
  });

  // Store the strings vec in a local so we can push it as an argument later
  const stringsVecType: ValType = {
    kind: "ref_null",
    typeIdx: templateVecTypeIdx,
  };
  const stringsLocal = allocLocal(fctx, `__tt_strings_${fctx.locals.length}`, stringsVecType);

  // Build the "then" body (cache miss: create and store the template array)
  // Use savedBody pattern so compileStringLiteral pushes into a separate array
  const savedBody = pushBody(fctx);

  // The strings array element type is `externref` (line above). In nativeStrings
  // mode `compileStringLiteral` materializes a `(ref $NativeString)` struct, NOT
  // an externref — pushing that struct straight into the externref-typed
  // `array.new_fixed` emits an invalid module ("array.new_fixed[0] expected
  // externref, found struct.new of (ref $NativeString)"). Bridge each native
  // string element to externref with `extern.convert_any` so the element type
  // matches. (Host-string mode already returns externref, so this is a no-op
  // there.) Surfaced by `const r = tag\`a${1}b\`;` under --target standalone.
  const pushStringElem = (text: string): void => {
    compileStringLiteral(ctx, fctx, text, expr);
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      fctx.body.push({ op: "extern.convert_any" });
    }
  };

  // First: build the raw strings array as a regular vec
  for (const raw of rawParts) {
    pushStringElem(raw);
  }
  fctx.body.push({
    op: "array.new_fixed",
    typeIdx: arrTypeIdx,
    length: rawParts.length,
  });
  const tmpRawData = allocLocal(fctx, `__tt_raw_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: tmpRawData });
  fctx.body.push({ op: "i32.const", value: rawParts.length });
  fctx.body.push({ op: "local.get", index: tmpRawData });
  fctx.body.push({ op: "struct.new", typeIdx: baseVecTypeIdx });
  const tmpRawVec = allocLocal(fctx, `__tt_raw_vec_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: baseVecTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: tmpRawVec });

  // Second: build the cooked strings array
  for (const str of stringParts) {
    pushStringElem(str);
  }
  fctx.body.push({
    op: "array.new_fixed",
    typeIdx: arrTypeIdx,
    length: stringParts.length,
  });
  const tmpData = allocLocal(fctx, `__tt_arr_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: tmpData });

  // Create the template vec struct: { length, data, raw }
  fctx.body.push({ op: "i32.const", value: stringParts.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "local.get", index: tmpRawVec });
  fctx.body.push({ op: "struct.new", typeIdx: templateVecTypeIdx });
  fctx.body.push({ op: "global.set", index: cacheGlobalIdx });
  const thenBody = fctx.body;
  fctx.body = savedBody;

  // Check if cache global is null (first call at this site)
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenBody,
  });

  // Load cached template object into the local
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "local.set", index: stringsLocal });

  // `String.raw` is a builtin whose result is the RAW (uncooked) parts
  // interleaved with the stringified substitutions. Lower it in-module rather
  // than routing the template struct through the `__tagged_template` host
  // bridge, which can't index a WasmGC struct from JS (#2008). The raw parts
  // are known at compile time, so this "compiles away" to a plain concat.
  if (isStringRawTag(expr.tag)) {
    return compileStringRaw(ctx, fctx, expr, rawParts, substitutions);
  }

  // Now compile the call to the tag function.
  // The tag function receives (stringsArray, ...substitutions).
  // We handle three cases: known function, closure, or fallback.

  if (ts.isIdentifier(expr.tag)) {
    const tagName = expr.tag.text;

    // Case 1: tag is a closure variable
    const closureInfo = ctx.closureMap.get(tagName);
    if (closureInfo) {
      const localIdx = fctx.localMap.get(tagName);
      if (localIdx === undefined) {
        reportError(ctx, expr, `Tagged template: closure variable '${tagName}' not found`);
        return null;
      }

      // Push closure ref as self param
      fctx.body.push({ op: "local.get", index: localIdx });

      // Push strings array as first argument (coerce to expected param type)
      const paramType0 = closureInfo.paramTypes[0];
      fctx.body.push({ op: "local.get", index: stringsLocal });
      if (paramType0 && paramType0.kind === "externref") {
        // Need to convert GC ref to externref
        fctx.body.push({ op: "extern.convert_any" });
      }

      // Push substitution expressions as remaining arguments
      // Only push up to the number of declared params (minus 1 for self, minus 1 for strings)
      const closureMaxSubs = Math.min(substitutions.length, closureInfo.paramTypes.length - 1);
      for (let i = 0; i < closureMaxSubs; i++) {
        const expectedParamType = closureInfo.paramTypes[i + 1];
        compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
      }

      // Push funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({
        op: "struct.get",
        typeIdx: closureInfo.structTypeIdx,
        fieldIdx: 0,
      });
      emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return closureInfo.returnType ?? null;
    }

    // Case 2: tag is a known function
    const funcIdx = ctx.funcMap.get(tagName);
    if (funcIdx !== undefined) {
      // Prepend captured values for nested functions with captures. The lifted
      // signature is [valueCap_0..N-1, tdzFlagBox_0..K-1, strings, ...userParams]
      // (mirrors nested-declarations.ts + call-identifier.ts). BOTH the value
      // captures AND the TDZ-flag boxes are real leading params, so the capture
      // count that offsets `strings`/substitutions below is value + tdz-flag
      // count — not just the value count (#3576).
      const nestedCaptures = ctx.nestedFuncCaptures.get(tagName);
      const tdzFlaggedNested = nestedCaptures ? nestedCaptures.filter((c) => c.hasTdzFlag) : [];
      if (nestedCaptures) {
        for (const cap of nestedCaptures) {
          // A recursive tagged-template call is emitted inside the lifted
          // function, where `outerLocalIdx` belongs to the declaring fctx and
          // is therefore out of range. Thread the lifted function's current
          // capture parameter/cell instead. Calls from the declaring scope keep
          // the established outer-slot path.
          const captureLocalIdx =
            fctx.name === tagName ? (fctx.localMap.get(cap.name) ?? cap.outerLocalIdx) : cap.outerLocalIdx;
          fctx.body.push({ op: "local.get", index: captureLocalIdx });
        }
        // #1205 Stage 3: after all value captures, push the boxed TDZ-flag refs.
        // Minimal replication of call-identifier.ts's cap-prepend (kept gated so
        // the common no-TDZ tag stays byte-inert): share an existing box, else
        // box the live i32 flag, else treat as initialized (`i32.const 1`).
        if (tdzFlaggedNested.length > 0) {
          const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
          for (const cap of tdzFlaggedNested) {
            const existing = fctx.boxedTdzFlags?.get(cap.name);
            if (existing) {
              fctx.body.push({ op: "local.get", index: existing.localIdx });
              continue;
            }
            const liveFlagIdx = fctx.tdzFlagLocals?.get(cap.name);
            const liveType = liveFlagIdx !== undefined ? getLocalType(fctx, liveFlagIdx) : undefined;
            const liveOk = liveType?.kind === "i32";
            if (liveOk && liveFlagIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: liveFlagIdx });
            } else {
              fctx.body.push({ op: "i32.const", value: 1 });
            }
            fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
            const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
              kind: "ref",
              typeIdx: i32RefCellTypeIdx,
            });
            fctx.body.push({ op: "local.tee", index: flagBoxLocal });
            if (liveOk) {
              if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
              fctx.boxedTdzFlags.set(cap.name, { refCellTypeIdx: i32RefCellTypeIdx, localIdx: flagBoxLocal });
              if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
              fctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
            }
          }
        }
      }
      // Total leading capture params (value captures + TDZ-flag boxes).
      const captureCount = nestedCaptures ? nestedCaptures.length + tdzFlaggedNested.length : 0;

      const restInfo = ctx.funcRestParams.get(tagName);
      const paramTypes = getFuncParamTypes(ctx, funcIdx);

      // Push the strings array as the first USER param (wasm index captureCount).
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if the callee expects externref for the strings param.
      if (paramTypes?.[captureCount] && paramTypes[captureCount]!.kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      if (restInfo) {
        // Tag function has rest param: push positional user substitutions before
        // the rest param, then pack the remainder into the rest vec. `restIndex`
        // is in USER-param space (strings is user param 0), so the number of
        // positional subs between strings and the rest is `restIndex - 1`.
        const positionalSubs = Math.max(0, restInfo.restIndex - 1);
        for (let i = 0; i < Math.min(substitutions.length, positionalSubs); i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[captureCount + 1 + i]);
        }
        // Pack remaining substitutions into a vec for the rest param
        const restSubs = substitutions.slice(positionalSubs);
        const restArgCount = restSubs.length;
        fctx.body.push({ op: "i32.const", value: restArgCount });
        for (const sub of restSubs) {
          compileExpression(ctx, fctx, sub, restInfo.elemType);
        }
        fctx.body.push({
          op: "array.new_fixed",
          typeIdx: restInfo.arrayTypeIdx,
          length: restArgCount,
        });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      } else {
        // No rest param — push substitutions as positional args
        // Only push up to the number of declared params (excluding captures and strings array)
        const maxSubs = paramTypes
          ? Math.min(substitutions.length, paramTypes.length - 1 - captureCount)
          : substitutions.length;
        for (let i = 0; i < maxSubs; i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[captureCount + 1 + i]);
        }

        // Supply defaults for missing optional params
        const optInfo = ctx.funcOptionalParams.get(tagName);
        if (optInfo) {
          const numProvided = maxSubs + 1 + captureCount; // +1 for strings array + captures
          for (const opt of optInfo) {
            if (opt.index >= numProvided) {
              pushParamSentinel(fctx, opt.type, ctx, opt);
            }
          }
        }
      }

      // Re-lookup funcIdx in case imports shifted during compilation
      const finalFuncIdx = ctx.funcMap.get(tagName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

      // Determine return type
      const sig = ctx.checker.getResolvedSignature(expr);
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isVoidType(retType)) return null;
        return resolveWasmType(ctx, retType);
      }
      return { kind: "externref" };
    }
  }

  // Fallback: general expression tag (call expressions, IIFE, parenthesized, etc.)
  // Use the TypeScript type checker to resolve the tag expression's callable type,
  // then find a matching registered closure by signature. This handles cases like
  // getTag()`hello`, (function(s){ return s; })`hello`, etc.
  {
    // First, try to resolve the tag expression's type and find a matching closure
    const tagTsType = ctx.checker.getTypeAtLocation(expr.tag);
    const callSigs = tagTsType.getCallSignatures?.();

    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;
      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the tag expression to get the closure on the stack
      const tagResult = compileExpression(ctx, fctx, expr.tag);
      const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, matchedClosureInfo.funcTypeIdx) ?? matchedStructTypeIdx;
      const closureRefType: ValType = { kind: "ref_null", typeIdx: selfTypeIdx };

      // Normalize erased shared closures to the canonical root. Private/named
      // funcs retain their concrete self carrier.
      const closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, closureRefType);
      if (tagResult?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, selfTypeIdx);
      } else if (
        tagResult &&
        (tagResult.kind === "ref" || tagResult.kind === "ref_null") &&
        tagResult.typeIdx !== selfTypeIdx
      ) {
        emitGuardedRefCast(fctx, selfTypeIdx);
      }
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as self param (first arg of lifted function)
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" });

      // Push strings array as first argument
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if the closure expects externref for the first param
      if (matchedClosureInfo.paramTypes[0] && matchedClosureInfo.paramTypes[0].kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      // Push substitution expressions as remaining arguments
      const closureMaxSubs = Math.min(substitutions.length, matchedClosureInfo.paramTypes.length - 1);
      for (let i = 0; i < closureMaxSubs; i++) {
        const expectedParamType = matchedClosureInfo.paramTypes[i + 1];
        compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
      }

      // Pad missing arguments with defaults
      for (let i = substitutions.length + 1; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // Push funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({
        op: "struct.get",
        typeIdx: selfTypeIdx,
        fieldIdx: 0,
      });
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? null;
    }

    // No matching closure found — try compiling the tag as a general expression
    // and checking if the result is a recognizable closure ref type
    {
      const tagResult = compileExpression(ctx, fctx, expr.tag);
      if (tagResult && (tagResult.kind === "ref" || tagResult.kind === "ref_null")) {
        const closureTypeIdx = (tagResult as { typeIdx: number }).typeIdx;
        const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (closureInfo) {
          const closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, tagResult);
          fctx.body.push({ op: "local.set", index: closureLocal });

          fctx.body.push({ op: "local.get", index: closureLocal });

          fctx.body.push({ op: "local.get", index: stringsLocal });
          if (closureInfo.paramTypes[0] && closureInfo.paramTypes[0].kind === "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          }

          const closureMaxSubs = Math.min(substitutions.length, closureInfo.paramTypes.length - 1);
          for (let i = 0; i < closureMaxSubs; i++) {
            const expectedParamType = closureInfo.paramTypes[i + 1];
            compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
          }

          for (let i = substitutions.length + 1; i < closureInfo.paramTypes.length; i++) {
            pushDefaultValue(fctx, closureInfo.paramTypes[i]!, ctx);
          }

          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: closureInfo.structTypeIdx,
            fieldIdx: 0,
          });
          emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

          return closureInfo.returnType ?? null;
        }
      }

      // If the tag expression compiled but didn't return a recognizable closure,
      // use __tagged_template host import to call it dynamically.
      // Signature: __tagged_template(tag: externref, strings: externref, subs: externref) -> externref
      if (tagResult) {
        // Coerce tag to externref if needed
        if (tagResult.kind !== "externref") {
          coerceType(ctx, fctx, tagResult, { kind: "externref" });
        }
        const tagLocal = allocLocal(fctx, `__tt_dyn_tag_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tagLocal });

        // Ensure __tagged_template, __js_array_new, __js_array_push imports exist
        const ext: ValType = { kind: "externref" };
        ensureLateImport(ctx, "__tagged_template", [ext, ext, ext], [ext]);
        ensureLateImport(ctx, "__js_array_new", [], [ext]);
        ensureLateImport(ctx, "__js_array_push", [ext, ext], []);
        flushLateImportShifts(ctx, fctx);

        const ttIdx = ctx.funcMap.get("__tagged_template")!;
        const arrNewIdx = ctx.funcMap.get("__js_array_new")!;
        const arrPushIdx = ctx.funcMap.get("__js_array_push")!;

        // Build JS array of substitutions
        fctx.body.push({ op: "call", funcIdx: arrNewIdx }); // -> externref (empty array)
        const subsArrLocal = allocLocal(fctx, `__tt_subs_arr_${fctx.locals.length}`, ext);
        fctx.body.push({ op: "local.set", index: subsArrLocal });

        for (const sub of substitutions) {
          fctx.body.push({ op: "local.get", index: subsArrLocal });
          const subResult = compileExpression(ctx, fctx, sub);
          if (subResult && subResult.kind !== "externref") {
            coerceType(ctx, fctx, subResult, ext);
          }
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
        }

        // Call __tagged_template(tag, strings, subs)
        fctx.body.push({ op: "local.get", index: tagLocal });
        fctx.body.push({ op: "local.get", index: stringsLocal });
        fctx.body.push({ op: "extern.convert_any" }); // template vec struct -> externref
        fctx.body.push({ op: "local.get", index: subsArrLocal });
        fctx.body.push({ op: "call", funcIdx: ttIdx });

        return { kind: "externref" };
      }
    }
  }

  reportError(ctx, expr, `Tagged template: unsupported tag expression kind ${ts.SyntaxKind[expr.tag.kind]}`);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
/**
 * Emit wasm code to convert a boolean (i32) on the stack to a string.
 * Produces "true" or "false" string constant (externref) via if/else.
 */
export function emitBoolToString(ctx: CodegenContext, fctx: FunctionContext): ValType {
  // Native-strings / standalone (#1470): JS-host string-constant globals are
  // never registered (their global index resolves to the -1 sentinel and the
  // module fails validation with "Invalid global index: 4294967295"). Select
  // a NativeString GC struct in each arm instead, built inline by
  // `compileNativeStringLiteral`.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const trueInstrs = nativeStringLiteralInstrs(ctx, "true");
    const falseInstrs = nativeStringLiteralInstrs(ctx, "false");
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: trueInstrs,
      else: falseInstrs,
    });
    return nativeStringType(ctx);
  }

  // JS-host mode: "true" / "false" are externref string-constant globals.
  addStringConstantGlobal(ctx, "true");
  addStringConstantGlobal(ctx, "false");

  const trueIdx = ctx.stringGlobalMap.get("true")!;
  const falseIdx = ctx.stringGlobalMap.get("false")!;

  // i32 boolean value is on the stack → select "true" or "false" string constant
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "global.get", index: trueIdx }],
    else: [{ op: "global.get", index: falseIdx }],
  } as any);
  return { kind: "externref" };
}

// ── Batched string concat chains ─────────────────────────────────────

/**
 * Fold runs of adjacent compile-time-constant operands in a concat chain
 * into single synthetic string literals. E.g. [var, "a", "b", "c", var2]
 * becomes [var, "abc", var2] — reducing 4 concat ops to 2.
 */
function foldAdjacentConstantOperands(ctx: CodegenContext, operands: ts.Expression[]): ts.Expression[] {
  if (operands.length <= 1) return operands;
  const result: ts.Expression[] = [];
  let pendingConst = "";
  let hasPending = false;
  let lastConstNode: ts.Expression | undefined;

  for (const op of operands) {
    const val = resolveStrictConstant(ctx, op);
    if (typeof val === "string") {
      pendingConst += val;
      hasPending = true;
      lastConstNode = op;
    } else if (typeof val === "number") {
      pendingConst += String(val);
      hasPending = true;
      lastConstNode = op;
    } else {
      if (hasPending) {
        // Synthesize a string literal node for the folded constant
        result.push(createSyntheticStringLiteral(pendingConst, lastConstNode!));
        pendingConst = "";
        hasPending = false;
      }
      result.push(op);
    }
  }

  if (hasPending) {
    result.push(createSyntheticStringLiteral(pendingConst, lastConstNode!));
  }

  return result;
}

/** Emit the branch-free ConsString construction licensed by a >=64 RHS proof. */
function emitProvenRopeConcat(ctx: CodegenContext, fctx: FunctionContext, rhsLength: number): void {
  const rhs = allocLocal(fctx, `__rope_rhs_${fctx.locals.length}`, nativeStringType(ctx));
  const lhs = allocLocal(fctx, `__rope_lhs_${fctx.locals.length}`, nativeStringType(ctx));
  fctx.body.push({ op: "local.set", index: rhs });
  fctx.body.push({ op: "local.set", index: lhs });
  fctx.body.push({ op: "local.get", index: lhs });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: rhsLength });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: lhs });
  fctx.body.push({ op: "local.get", index: rhs });
  fctx.body.push({ op: "struct.new", typeIdx: ctx.consStrTypeIdx });
}

/** Compile native string `+`, including the statically-proven rope arm. */
function compileNativeStringConcat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  const constVal = resolveStrictConstant(ctx, expr);
  if (typeof constVal === "string") return compileStringLiteral(ctx, fctx, constVal, expr);

  if (noJsHost(ctx) && process.env.JS2WASM_NATIVE_BATCHED_CONCAT !== "0") {
    const operands = collectConcatOperands(ctx, expr);
    const folded = foldAdjacentConstantOperands(ctx, operands);
    const batchedIdx = ensureNativeBatchedConcat(ctx, folded.length);
    if (batchedIdx !== undefined) {
      for (const operand of folded) {
        // A flattened nested Symbol must throw before operands to its right.
        if (tryThrowOnSymbolStringCoercion(ctx, fctx, operand)) return nativeStringType(ctx);
        compileNativeConcatOperand(ctx, fctx, operand);
      }
      fctx.body.push({ op: "call", funcIdx: batchedIdx });
      return nativeStringType(ctx);
    }
  }

  // #1470 — `__str_concat` takes two native strings. Standalone/WASI must
  // coerce mixed operands in Wasm; the legacy JS-host native-string mode keeps
  // its established raw operand path.
  if (noJsHost(ctx)) {
    compileNativeConcatOperand(ctx, fctx, expr.left);
    compileNativeConcatOperand(ctx, fctx, expr.right);
  } else {
    compileExpression(ctx, fctx, expr.left);
    compileExpression(ctx, fctx, expr.right);
  }

  const staticRhsLength = staticStringLength(ctx, expr.right);
  if (process.env.JS2WASM_NATIVE_PROVEN_ROPE_CONCAT !== "0" && (staticRhsLength ?? 0) >= 64) {
    emitProvenRopeConcat(ctx, fctx, staticRhsLength!);
    return nativeStringType(ctx);
  }

  const funcIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (funcIdx === undefined) {
    reportError(ctx, expr, `Unsupported string operator: ${ts.SyntaxKind[ts.SyntaxKind.PlusToken]}`);
    return null;
  }
  fctx.body.push({ op: "call", funcIdx });
  return nativeStringType(ctx);
}

/** Create a synthetic TS string literal node for use in codegen. */
function createSyntheticStringLiteral(value: string, positionSource: ts.Node): ts.StringLiteral {
  const node = ts.factory.createStringLiteral(value);
  // Copy position info so error reporting works
  (node as any).pos = positionSource.pos;
  (node as any).end = positionSource.end;
  (node as any).parent = positionSource.parent;
  return node;
}

/**
 * Compile a single operand and coerce it to externref (string) for concat.
 * Handles: void → "undefined", number → number_toString, boolean → "true"/"false",
 * null/undefined externref → string constant, struct ref → extern.convert_any.
 */
function compileAndCoerceConcatOperand(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): void {
  // §7.1.17 ToString(Symbol) throws — `"x" + sym` must throw TypeError. The
  // throw must short-circuit operand evaluation, so it stays before the engine.
  if (tryThrowOnSymbolStringCoercion(ctx, fctx, operand)) return;
  const tsType = valueExprTsType(ctx, operand); // #2176 ambient-shadow safe
  // #1917 — the per-operand ToString cascade is now the single coercion engine.
  // `+` applies ToPrimitive with the DEFAULT hint (valueOf-first, #2022) on a
  // struct/ref operand, so pass hint "default" (the engine routes the ref arm
  // through `__extern_to_string_default`, the externref/number/bool/null arms
  // unchanged).
  compileAndEmitToString(ctx, fctx, operand, tsType, "default");
}

/**
 * Emit a batched concat call: compile all operands, register __concat_N
 * host import on demand, and emit a single call that concatenates N strings.
 */
function compileBatchedConcat(ctx: CodegenContext, fctx: FunctionContext, operands: ts.Expression[]): ValType {
  const arity = operands.length;

  // Compile and coerce each operand — pushes N externref values onto the stack
  for (const operand of operands) {
    compileAndCoerceConcatOperand(ctx, fctx, operand);
  }

  // Register __concat_N import on demand (all params are externref, result is externref)
  const importName = `__concat_${arity}`;
  const paramTypes: ValType[] = Array.from({ length: arity }, () => ({ kind: "externref" }) as ValType);
  const funcIdx = ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  } else {
    // Fallback: pairwise concat (shouldn't happen in js-string mode)
    const concatIdx = ctx.jsStringImports.get("concat");
    if (concatIdx !== undefined) {
      for (let i = 1; i < arity; i++) {
        fctx.body.push({ op: "call", funcIdx: concatIdx });
      }
    }
  }

  return { kind: "externref" };
}

function coerceCompiledValueToNumber(ctx: CodegenContext, fctx: FunctionContext, valueType: ValType | null): void {
  if (!valueType) {
    fctx.body.push({ op: "f64.const", value: NaN });
    return;
  }
  if (valueType.kind === "f64") return;
  if (valueType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  coerceType(ctx, fctx, valueType, { kind: "f64" }, "number");
}

/**
 * (#1961) Null-tolerant native string content equality. A `string | undefined`
 * operand lowers to a NULLABLE `$AnyString` ref where a null ref IS the
 * `undefined` value. `__str_flatten`/`__str_equals` deref their operands and
 * trap on null, so guard first: both-null → equal (1), exactly-one-null →
 * unequal (0), else flatten both and compare content. Leaves an i32 (1/0) on
 * the stack representing `left == right` (the caller negates for `!=`/`!==`).
 */
function emitNullableStringEquals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  flattenIdx: number,
  equalsIdx: number,
): void {
  const nullableStr = nativeStringTypeNullable(ctx);
  const leftLocal = allocLocal(fctx, `__streq_l_${fctx.locals.length}`, nullableStr);
  const rightLocal = allocLocal(fctx, `__streq_r_${fctx.locals.length}`, nullableStr);
  compileExpression(ctx, fctx, expr.left, nullableStr);
  fctx.body.push({ op: "local.set", index: leftLocal });
  compileExpression(ctx, fctx, expr.right, nullableStr);
  fctx.body.push({ op: "local.set", index: rightLocal });

  // if (left is null) { result = right is null ? 1 : 0 }
  // else if (right is null) { result = 0 }
  // else { result = __str_equals(flatten(left), flatten(right)) }
  // (#4157) `__str_equals` flattens its own params — see `lazy-str-flatten.ts`.
  const flattenOperand = redundantFlattenCall(flattenIdx);
  const compareBody: Instr[] = [
    { op: "local.get", index: leftLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    ...flattenOperand,
    { op: "local.get", index: rightLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    ...flattenOperand,
    { op: "call", funcIdx: equalsIdx },
  ];
  const rightNullCheck: Instr[] = [
    { op: "local.get", index: rightLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: compareBody,
    },
  ];
  fctx.body.push({ op: "local.get", index: leftLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: rightLocal }, { op: "ref.is_null" }],
    else: rightNullCheck,
  });
}

export function compileStringBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // §7.1.17 ToString(Symbol) throws — `str + sym` / `sym + str` must throw
  // TypeError before any concat lowering (native, batched, or host) runs.
  if (op === ts.SyntaxKind.PlusToken) {
    if (tryThrowOnSymbolStringCoercion(ctx, fctx, expr.left)) {
      return ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (tryThrowOnSymbolStringCoercion(ctx, fctx, expr.right)) {
      return ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 ? nativeStringType(ctx) : { kind: "externref" };
    }
  }
  // Fast mode: native string operations
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return compileNativeStringConcat(ctx, fctx, expr);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken: {
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          emitNullableStringEquals(ctx, fctx, expr, strFlattenIdx, funcIdx);
          return { kind: "i32" };
        }
        break;
      }
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken: {
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          emitNullableStringEquals(ctx, fctx, expr, strFlattenIdx, funcIdx);
          fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        break;
      }
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken: {
        // Lexicographic comparison via __str_compare (returns -1, 0, 1).
        // `__str_compare` takes `(ref $AnyString, ref $AnyString)`. A non-native
        // string operand — e.g. a `String` wrapper object (`new String("1")`),
        // a boxed/dynamic externref, or a number — must be lowered to a native
        // `ref $AnyString` first or the module is invalid (#2873: standalone
        // `new String("1") < "1"` pushed the raw struct/externref and tripped
        // `__str_compare`'s param type → CompileError). The `+` concat case
        // already does this via `compileNativeConcatOperand`; relational did
        // not. Mirror it under `noJsHost` (standalone / WASI), where every
        // operand lowers to a native `ref $AnyString` in pure Wasm via
        // ToString (String wrapper → `tryStructToString`/`$__any_to_string`,
        // dynamic externref → `__extern_toString`, number → `number_toString`).
        // The legacy JS-host `nativeStrings` path keeps its original raw push.
        if (noJsHost(ctx)) {
          compileNativeConcatOperand(ctx, fctx, expr.left);
          compileNativeConcatOperand(ctx, fctx, expr.right);
        } else {
          compileExpression(ctx, fctx, expr.left);
          compileExpression(ctx, fctx, expr.right);
        }
        const funcIdx = ctx.nativeStrHelpers.get("__str_compare");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          fctx.body.push({ op: "i32.const", value: 0 });
          const cmpOp =
            op === ts.SyntaxKind.LessThanToken
              ? "i32.lt_s"
              : op === ts.SyntaxKind.LessThanEqualsToken
                ? "i32.le_s"
                : op === ts.SyntaxKind.GreaterThanToken
                  ? "i32.gt_s"
                  : "i32.ge_s";
          fctx.body.push({ op: cmpOp as any });
          return { kind: "i32" };
        }
        break;
      }
      default: {
        // Arithmetic/bitwise operators on strings: coerce both operands to f64 via ToNumber
        // This matches JS semantics: "5" - "2" === 3, "6" * "7" === 42
        const leftType = compileExpression(ctx, fctx, expr.left);
        coerceCompiledValueToNumber(ctx, fctx, leftType);
        const rightType = compileExpression(ctx, fctx, expr.right);
        coerceCompiledValueToNumber(ctx, fctx, rightType);
        return compileNumericBinaryOp(ctx, fctx, op, expr);
      }
    }

    reportError(ctx, expr, `Unsupported string operator: ${ts.SyntaxKind[op]}`);
    return null;
  }

  // Ensure string imports are registered (may not be if no string literals in source)
  addStringImports(ctx);

  // Constant-fold entire concat expression if all operands are compile-time constants (#1004)
  if (op === ts.SyntaxKind.PlusToken) {
    const constVal = resolveStrictConstant(ctx, expr);
    if (typeof constVal === "string") {
      return compileStringLiteral(ctx, fctx, constVal, expr);
    }
  }

  // Batch N-operand string concat chains into a single multi-arg host call (#958)
  if (op === ts.SyntaxKind.PlusToken) {
    const operands = collectConcatOperands(ctx, expr);
    // Fold adjacent constant operands to reduce concat count (#1004)
    const folded = foldAdjacentConstantOperands(ctx, operands);
    if (folded.length >= 3) {
      return compileBatchedConcat(ctx, fctx, folded);
    }
    if (folded.length === 1 && folded.length < operands.length) {
      // Everything folded into one constant string
      return compileStringLiteral(ctx, fctx, (folded[0] as ts.StringLiteral).text, expr);
    }
    if (folded.length === 2 && folded.length < operands.length) {
      // Folding reduced a multi-op chain to 2 operands — emit as pair concat
      // using the folded operands (not the original expression tree)
      return compileBatchedConcat(ctx, fctx, folded);
    }
  }

  // Arithmetic/bitwise operators on strings: coerce both operands to f64 via ToNumber
  // This matches JS semantics: "5" - "2" === 3, "6" * "7" === 42
  const isArithmeticOrBitwise =
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  if (isArithmeticOrBitwise) {
    // Compile left operand and convert to f64
    const leftArithType = compileExpression(ctx, fctx, expr.left);
    coerceCompiledValueToNumber(ctx, fctx, leftArithType);
    // Compile right operand and convert to f64
    const rightArithType = compileExpression(ctx, fctx, expr.right);
    coerceCompiledValueToNumber(ctx, fctx, rightArithType);
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Compile operands with coercion: if one side is a number/bool in a string
  // context, inject appropriate toString conversion.
  // Booleans → "true"/"false" string constants (not number_toString which gives "1"/"0")
  // Numbers → number_toString
  const leftTsType = valueExprTsType(ctx, expr.left); // #2176 ambient-shadow safe
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (op === ts.SyntaxKind.PlusToken && !leftType) {
    // Void function return used in string concat → push "undefined"
    pushStringConstant(ctx, fctx, "undefined");
  } else if (
    op === ts.SyntaxKind.PlusToken &&
    leftType &&
    (leftType.kind === "f64" || leftType.kind === "i32" || leftType.kind === "i64")
  ) {
    if (leftType.kind === "i32" && (isBooleanType(leftTsType) || (leftType as { boolean?: true }).boolean)) {
      // Boolean → "true"/"false" via conditional select of string constants
      emitBoolToString(ctx, fctx);
    } else {
      if (leftType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      else if (leftType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  } else if (op === ts.SyntaxKind.PlusToken && leftType && leftType.kind === "externref") {
    // null/undefined externref in string concat → coerce to "null"/"undefined" string
    const leftIsNull = (leftTsType.flags & ts.TypeFlags.Null) !== 0;
    const leftIsUndef = (leftTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (leftIsNull) {
      fctx.body.push({ op: "drop" });
      pushStringConstant(ctx, fctx, "null");
    } else if (leftIsUndef) {
      fctx.body.push({ op: "drop" });
      pushStringConstant(ctx, fctx, "undefined");
    } else if (!isStringType(leftTsType)) {
      // #2022 — `+` applies ToPrimitive with the DEFAULT hint (valueOf before
      // toString), not the string hint, even when the other operand is a
      // string. Route opaque externref operands through
      // `__extern_to_string_default` so wasmGC structs run valueOf-first
      // before `wasm:js-string concat`. (Previously `__extern_toString`'s
      // string hint made `objWithValueOf + ""` use toString — wrong.)
      const toStrIdx = ensureLateImport(
        ctx,
        "__extern_to_string_default",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalIdx = ctx.funcMap.get("__extern_to_string_default") ?? toStrIdx;
      if (finalIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalIdx });
      }
    }
  } else if (op === ts.SyntaxKind.PlusToken && leftType && (leftType.kind === "ref" || leftType.kind === "ref_null")) {
    // #2022 — `+` is a ToPrimitive(default) site. Delegate to the coercion
    // engine's default-hint ToString: it routes opaque structs through the
    // valueOf-first host helper `__extern_to_string_default`, EXCEPT a nominal
    // struct whose only ToPrimitive method is `toString` (no valueOf /
    // @@toPrimitive), which it dispatches IN-WASM so it also works during the
    // module START function (#2795 — `"" + new C()` at top level previously
    // printed "[object Object]" because the host helper couldn't reach
    // `__call_toString` before `setExports`).
    emitToString(ctx, fctx, leftType, leftTsType, "default");
  }
  // For equality/inequality ops: String wrapper objects (new String("x")) are externrefs
  // but NOT wasm:js-string strings — the `equals` builtin would throw a WebAssembly trap.
  // Unwrap to primitive string via __unbox_string before comparison.
  const isEqOrNeq =
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLeftStringWrapper =
    (leftTsType.flags & ts.TypeFlags.Object) !== 0 && leftTsType.getSymbol()?.name === "String";
  if (isEqOrNeq && isLeftStringWrapper && leftType?.kind === "externref") {
    const unboxIdx = ensureLateImport(ctx, "__unbox_string", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalUnboxIdx = ctx.funcMap.get("__unbox_string") ?? unboxIdx;
    if (finalUnboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalUnboxIdx });
  }
  const rightTsType = valueExprTsType(ctx, expr.right); // #2176 ambient-shadow safe
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (op === ts.SyntaxKind.PlusToken && !rightType) {
    // Void function return used in string concat → push "undefined"
    pushStringConstant(ctx, fctx, "undefined");
  } else if (
    op === ts.SyntaxKind.PlusToken &&
    rightType &&
    (rightType.kind === "f64" || rightType.kind === "i32" || rightType.kind === "i64")
  ) {
    if (rightType.kind === "i32" && (isBooleanType(rightTsType) || (rightType as { boolean?: true }).boolean)) {
      emitBoolToString(ctx, fctx);
    } else {
      if (rightType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      else if (rightType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  } else if (op === ts.SyntaxKind.PlusToken && rightType && rightType.kind === "externref") {
    // null/undefined externref in string concat → coerce to "null"/"undefined" string
    const rightIsNull = (rightTsType.flags & ts.TypeFlags.Null) !== 0;
    const rightIsUndef = (rightTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (rightIsNull) {
      fctx.body.push({ op: "drop" });
      pushStringConstant(ctx, fctx, "null");
    } else if (rightIsUndef) {
      fctx.body.push({ op: "drop" });
      pushStringConstant(ctx, fctx, "undefined");
    } else if (!isStringType(rightTsType)) {
      // #2022 — see left-operand branch above. `+` uses ToPrimitive(default),
      // so route opaque externref operands through `__extern_to_string_default`
      // (valueOf-first) before `wasm:js-string concat`.
      const toStrIdx = ensureLateImport(
        ctx,
        "__extern_to_string_default",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalIdx = ctx.funcMap.get("__extern_to_string_default") ?? toStrIdx;
      if (finalIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalIdx });
      }
    }
  } else if (
    op === ts.SyntaxKind.PlusToken &&
    rightType &&
    (rightType.kind === "ref" || rightType.kind === "ref_null")
  ) {
    // #2022 / #2795 — see the symmetric left-operand branch above. Delegate to
    // the coercion engine's default-hint ToString so a toString-only nominal
    // struct dispatches in-wasm (START-safe) while valueOf/@@toPrimitive classes
    // keep the host valueOf-first helper.
    emitToString(ctx, fctx, rightType, rightTsType, "default");
  }
  // Unwrap right-side String wrapper for equality/inequality (same as left above)
  const isRightStringWrapper =
    (rightTsType.flags & ts.TypeFlags.Object) !== 0 && rightTsType.getSymbol()?.name === "String";
  if (isEqOrNeq && isRightStringWrapper && rightType?.kind === "externref") {
    const unboxIdx2 = ensureLateImport(ctx, "__unbox_string", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalUnboxIdx2 = ctx.funcMap.get("__unbox_string") ?? unboxIdx2;
    if (finalUnboxIdx2 !== undefined) fctx.body.push({ op: "call", funcIdx: finalUnboxIdx2 });
  }

  switch (op) {
    case ts.SyntaxKind.PlusToken: {
      // String concatenation
      const funcIdx = ctx.jsStringImports.get("concat");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      break;
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken: {
      const funcIdx = ctx.jsStringImports.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: {
      const funcIdx = ctx.jsStringImports.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.eqz" }); // negate
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken: {
      const funcIdx = ctx.funcMap.get("string_compare");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.const", value: 0 });
        const cmpOp =
          op === ts.SyntaxKind.LessThanToken
            ? "i32.lt_s"
            : op === ts.SyntaxKind.LessThanEqualsToken
              ? "i32.le_s"
              : op === ts.SyntaxKind.GreaterThanToken
                ? "i32.gt_s"
                : "i32.ge_s";
        fctx.body.push({ op: cmpOp as any });
        return { kind: "i32" };
      }
      break;
    }
  }

  reportError(ctx, expr, `Unsupported string operator: ${ts.SyntaxKind[op]}`);
  return null;
}

// ── Native string method calls (fast mode) ──────────────────────────

/**
 * Per ECMA-262 §7.1.4 ToNumber: invoking ToNumber on a BigInt or Symbol
 * throws TypeError. String.prototype methods that take numeric arguments
 * (charAt, indexOf, slice, padStart, repeat, …) feed those args through
 * ToInteger/ToLength, which both call ToNumber. So when an arg has the
 * static type `bigint` or `symbol`, we must emit a TypeError throw
 * instead of silently converting (#1445).
 *
 * Returns true when a throw was emitted (caller should NOT consume the
 * arg further — the throw was placed instead of the arg expression).
 */
function emitTypeErrorThrow(ctx: CodegenContext, fctx: FunctionContext, msg: string): void {
  // Materialize the error message string. In nativeStrings mode the string
  // lives as a GC struct (no host global), so build it inline + bridge
  // to externref. In JS-host mode pull it from the imported string-constants
  // global so JS sees the same intern as `String.raw`-style literals.
  addStringConstantGlobal(ctx, msg);
  // #1473 — no JS host: throw a TypeError INSTANCE via the in-module
  // constructor (no `__throw_type_error` host import).
  if (usesNativeJsErrors(ctx)) {
    emitThrowTypeError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" });
    return;
  }
  const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    compileNativeStringLiteral(ctx, fctx, msg);
    if (throwIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      // GC-ref → externref bridge so the host import receives a JS string.
      fctx.body.push({ op: "extern.convert_any" });
      const funcIdx = ctx.funcMap.get("__throw_type_error")!;
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "unreachable" });
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "throw", tagIdx });
    }
    return;
  }
  const strIdx = ctx.stringGlobalMap.get(msg)!;
  if (throwIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    const funcIdx = ctx.funcMap.get("__throw_type_error")!;
    fctx.body.push({ op: "global.get", index: strIdx });
    fctx.body.push({ op: "call", funcIdx });
    fctx.body.push({ op: "unreachable" });
  } else {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "global.get", index: strIdx });
    fctx.body.push({ op: "throw", tagIdx });
  }
}

/**
 * §13.5.3 / §7.1.17 ToString(Symbol) throws a TypeError. An implicit
 * string coercion of a statically Symbol-typed expression (template-literal
 * substitution, `+` concatenation) must therefore throw rather than silently
 * stringify the internal symbol id. Returns true when a throw was emitted (the
 * caller must NOT compile the operand — the throw replaces it).
 */
function tryThrowOnSymbolStringCoercion(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): boolean {
  let argTsType: ts.Type | undefined;
  try {
    argTsType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return false;
  }
  if (!argTsType || !isSymbolType(argTsType)) return false;
  emitTypeErrorThrow(ctx, fctx, "TypeError: Cannot convert a Symbol value to a string");
  return true;
}

function tryThrowOnBigIntOrSymbolArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): boolean {
  let argTsType: ts.Type | undefined;
  try {
    argTsType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return false;
  }
  if (!argTsType) return false;
  const isBig = isBigIntType(argTsType);
  const isSym = isSymbolType(argTsType);
  if (!isBig && !isSym) return false;

  const msg = isBig
    ? "TypeError: Cannot convert a BigInt value to a number"
    : "TypeError: Cannot convert a Symbol value to a number";
  emitTypeErrorThrow(ctx, fctx, msg);
  return true;
}

/**
 * Compile a numeric arg (index/length) for a String.prototype method,
 * routing it through ToInteger semantics. Throws TypeError on BigInt
 * or Symbol per §7.1.4 ToNumber. Otherwise leaves an i32 on the stack.
 * Returns true when emission succeeded (caller continues building the
 * arg list); false when an unreachable throw was emitted instead.
 */
export function compileStringIntegerArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  nanFallback = 0,
): void {
  if (tryThrowOnBigIntOrSymbolArg(ctx, fctx, arg)) {
    // After unreachable, the wasm stack is polymorphic — but we still
    // push a sentinel i32 so the (unreached) call site reads cleanly.
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  // Range-proven integer positions avoid the f64 ToInteger lowering.
  if (tryEmitStaticI32Expression(ctx, fctx, arg)) return;
  // #2600 — the index/position is `ToIntegerOrInfinity(arg)` = truncate-toward-zero of `ToNumber(arg)` (§7.1.5), NOT a direct i32 coercion. In standalone
  // a fast i32 coercion of a fractional / non-numeric-typed position (`"1.9"`, `{valueOf(){…}}`, `true`) resolves to a wrong index. Route the
  // arg through the existing numeric coercion engine to f64 (string →
  // `__str_to_number`, object → ToPrimitive("number") — both already present
  // for `+str` / `Number(x)`), then apply ToIntegerOrInfinity (NaN → 0, then
  // `i32.trunc_sat_f64_s`, which truncates toward zero and saturates ±∞ to the
  // i32 bounds — the method's subsequent <0 / >=len range checks clamp it).
  // No new #2108 coercion site (reuses the engine). The legacy direct-i32 path
  // is kept for the JS-host nativeStrings mode (these slices are standalone).
  if (noJsHost(ctx)) {
    const argType = compileExpression(ctx, fctx, arg);
    if (!argType) {
      // void → undefined → ToNumber NaN. Most integer-indexed methods map
      // NaN to 0; lastIndexOf supplies its spec-specific +∞ sentinel so the
      // reverse search starts from the end.
      fctx.body.push({ op: "i32.const", value: nanFallback });
      return;
    }
    if (argType.kind === "i64") {
      // BigInt fell through static detection (e.g. `any` widened to bigint).
      fctx.body.push({ op: "drop" });
      emitTypeErrorThrow(ctx, fctx, "TypeError: Cannot convert a BigInt value to a number");
      fctx.body.push({ op: "i32.const", value: 0 });
      return;
    }
    if (argType.kind === "i32") {
      // Already an integer (boolean / int-typed position) — no ToNumber needed;
      // an i32 is already integral and within range for the helper.
      return;
    }
    // Coerce ToNumber → f64 via the engine, then ToIntegerOrInfinity.
    coerceType(ctx, fctx, argType, { kind: "f64" }, "number");
    const fTmp = allocLocal(fctx, `__strint_f_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: fTmp });
    // ToIntegerOrInfinity: NaN → the caller's method-specific fallback, else
    // trunc toward zero (±∞ saturates).
    fctx.body.push({ op: "local.get", index: fTmp });
    fctx.body.push({ op: "local.get", index: fTmp });
    fctx.body.push({ op: "f64.ne" }); // self != self ⇒ NaN
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: nanFallback }],
      else: [{ op: "local.get", index: fTmp }, { op: "i32.trunc_sat_f64_s" }],
    });
    return;
  }
  const argType = compileExpression(ctx, fctx, arg, { kind: "i32" });
  if (!argType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else if (argType.kind === "i64") {
    // BigInt fell through static detection (e.g. `any` widened to bigint).
    // Drop the i64 and throw TypeError per §7.1.4.
    fctx.body.push({ op: "drop" });
    emitTypeErrorThrow(ctx, fctx, "TypeError: Cannot convert a BigInt value to a number");
    fctx.body.push({ op: "i32.const", value: 0 });
  }
}

/**
 * #2682: if `expr` is `recv.charCodeAt(i)` where `recv` is the loop-invariant
 * receiver and `i` the in-bounds-proven induction variable of an active
 * canonical string-read loop, return that loop's hoisted-descriptor proof.
 * Otherwise return null. Both the i32-pure-leaf path (binary-ops.ts) and the
 * f64 charCodeAt lowering below consult this. The match is deliberately exact —
 * the argument must be the SAME induction identifier (not `i+1`, not a literal)
 * so the dropped OOB branch stays sound.
 */
export function matchHoistedCharRead(fctx: FunctionContext, expr: ts.Expression): HoistedCharRead | null {
  const reads = fctx.hoistedCharReads;
  if (!reads || reads.size === 0) return null;
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "charCodeAt") return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  const entry = reads.get(callee.expression.text);
  if (!entry) return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0]!;
  if (!ts.isIdentifier(arg) || arg.text !== entry.indexName) return null;
  return entry;
}

/**
 * #2682: emit the hoisted-descriptor charCodeAt read, leaving an i32 char code
 * on the stack. The receiver was flattened once before the loop and `i` is
 * proven `0 <= i < len`, so this is a bare `array.get_u(dataLocal, offLocal + i)`
 * — no `__str_flatten`, no `.data`/`.off` struct.get reload, no OOB/NaN branch.
 * Caller must have matched via {@link matchHoistedCharRead}.
 */
export function emitHoistedCharCodeAtRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  entry: HoistedCharRead,
  idxArg: ts.Expression,
): void {
  fctx.body.push({ op: "local.get", index: entry.dataLocal });
  fctx.body.push({ op: "local.get", index: entry.offLocal });
  // The argument is the proven induction var (an i32 local) — emits `local.get`.
  compileExpression(ctx, fctx, idxArg, { kind: "i32" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx });
}

/**
 * Compile a method call on a native string in fast mode.
 * Handles: charCodeAt (inline), charAt, substring, slice (native helpers),
 * and delegates other methods to host via marshal.
 */
export function compileNativeStringMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
  /**
   * (#2576, extends #2187) Optional receiver emitter. When provided, the method
   * arms push the receiver via this callback instead of re-compiling
   * `propAccess.expression`. Used by {@link compileGuardedNativeStringMethodCall}
   * to feed a pre-evaluated, guard-cast `$AnyString` receiver (so an `any`-typed
   * receiver is evaluated exactly once and only after a runtime `ref.test
   * $AnyString` succeeds). The callback must push one value (a native-string ref
   * / `$AnyString`) and return its ValType, mirroring `compileExpression`.
   */
  receiverOverride?: () => ValType | null,
): ValType | null {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

  // (#2576) Single indirection for emitting the receiver. Default re-compiles
  // `propAccess.expression`; the guarded `any`-receiver path overrides it.
  // (#2934 2b) A statically-string-typed receiver can still COMPILE to
  // externref — e.g. `String(42).concat(x)`: `number_toString` returns the
  // native string EXTERNALIZED via `extern.convert_any`. Every method arm
  // below feeds the receiver to a native helper expecting `(ref null
  // $AnyString)`, so an uncoerced externref receiver is invalid Wasm
  // (`call[0] expected (ref null $AnyString), found call of externref`).
  // Cast it back with the established inverse
  // (`emitNativeStringRefFromExternref`): in the native-strings world every
  // string-typed externref wraps a native string struct (there are no host
  // strings), so `any.convert_extern` + `ref.cast $AnyString` is exact.
  const emitReceiver = (): ValType | null => {
    const t = receiverOverride ? receiverOverride() : compileExpression(ctx, fctx, propAccess.expression);
    if (t && (t.kind === "externref" || t.kind === "ref_extern") && ctx.anyStrTypeIdx >= 0) {
      emitNativeStringRefFromExternref(ctx, fctx);
      return nativeStringType(ctx);
    }
    // (#2934 slice 3) A reflective `String.prototype.X.call(obj, …)` receiver
    // can compile to a concrete OBJECT struct ref — §22.1.3.x requires
    // ToString(this) first (dispatching the object's own toString, which may
    // throw — S15.5.4.6_A4_T2 expects exactly that). Feeding the raw struct
    // ref to a native string helper is invalid Wasm (`call[0] expected (ref
    // null $AnyString), found global.get of (ref null N)`). `tryStructToString`
    // performs that dispatch and normalises to `ref $AnyString`; string-typed
    // refs are untouched (excluded here, and not in the struct-name map).
    if (
      t &&
      (t.kind === "ref" || t.kind === "ref_null") &&
      (t as { typeIdx: number }).typeIdx !== ctx.anyStrTypeIdx &&
      (t as { typeIdx: number }).typeIdx !== ctx.nativeStrTypeIdx &&
      tryStructToString(ctx, fctx, t)
    ) {
      return nativeStringType(ctx);
    }
    return t;
  };

  // Helper: emit a flatten call to convert ref $AnyString → ref $NativeString
  const emitFlatten = () => fctx.body.push({ op: "call", funcIdx: flattenIdx });
  // (#4157) Use at a site whose IMMEDIATE callee self-flattens that param —
  // see `redundantFlattenCall` in `lazy-str-flatten.ts` for which do, which
  // do not, and why the call-site copy is redundant.
  const emitFlattenRedundant = () => fctx.body.push(...redundantFlattenCall(flattenIdx));
  const compileStringValueToLocal = (value: ts.Expression | undefined, fallback: string, name: string): number => {
    const local = allocLocal(fctx, `${name}_${fctx.locals.length}`, nativeStringType(ctx));
    if (value) {
      // #2598 — coerce a non-string search argument via ToString (§7.1.17)
      // instead of feeding a mistyped ref to `__str_flatten` (null-deref).
      emitArgAsNativeString(ctx, fctx, value);
    } else {
      compileStringLiteral(ctx, fctx, fallback);
    }
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };
  // Store two-string method receivers once and honor the wrapper-method
  // override; recompiling the raw receiver would lose `new String(x)`'s slot.
  const compileReceiverToLocal = (name: string): number => {
    const local = allocLocal(fctx, `${name}_${fctx.locals.length}`, nativeStringType(ctx));
    emitReceiver();
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };

  if (!receiverOverride && method === "includes" && expr.arguments.length === 1) {
    const receiverValues = staticConstStringValues(ctx, propAccess.expression);
    const searchValues = staticConstStringValues(ctx, expr.arguments[0]!);
    if (receiverValues && searchValues && new Set(searchValues).size === 1) {
      const search = searchValues[0]!;
      const results = new Set(receiverValues.map((value) => value.includes(search)));
      if (results.size === 1) {
        emitReceiver();
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: results.values().next().value ? 1 : 0 });
        return { kind: "i32", boolean: true };
      }
    }
  }

  // Fold an immutable literal table only when every entry has the same result;
  // mutations, aliases, and dynamic search/position values keep the helper.
  if (
    !receiverOverride &&
    (method === "startsWith" || method === "endsWith") &&
    expr.arguments.length >= 1 &&
    expr.arguments.length <= 2 &&
    ts.isStringLiteralLike(expr.arguments[0]!) &&
    (expr.arguments.length === 1 || ts.isNumericLiteral(expr.arguments[1]!))
  ) {
    const receiverValues = staticConstStringValues(ctx, propAccess.expression);
    if (receiverValues) {
      const search = expr.arguments[0]!.text;
      const position = expr.arguments.length === 2 ? Number((expr.arguments[1]! as ts.NumericLiteral).text) : undefined;
      const results = new Set(
        receiverValues.map((value) =>
          method === "startsWith" ? value.startsWith(search, position) : value.endsWith(search, position),
        ),
      );
      if (results.size === 1) {
        emitReceiver();
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: results.values().next().value ? 1 : 0 });
        return { kind: "i32", boolean: true };
      }
    }
  }
  const compileIntegerValueToLocal = (
    value: ts.Expression | undefined,
    fallback: number,
    name: string,
    nanFallback = 0,
  ): number => {
    const local = allocLocal(fctx, `${name}_${fctx.locals.length}`, {
      kind: "i32",
    });
    // Explicit `undefined` is spec-equivalent to an absent arg → use the
    // method's default sentinel rather than coercing undefined → 0 (#2124).
    if (value && !isStaticUndefinedArg(value)) {
      compileStringIntegerArg(ctx, fctx, value, nanFallback);
    } else {
      fctx.body.push({ op: "i32.const", value: fallback });
    }
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };

  // charCodeAt: inline array.get_u with offset (must flatten first).
  // ECMA-262 §22.1.3.3: ToIntegerOrInfinity(pos), then return NaN when
  // the resulting position is outside [0, string length).
  if (method === "charCodeAt") {
    if (!receiverOverride && ts.isIdentifier(propAccess.expression)) {
      const declaration = ctx.oracle.valueDeclarationOf(propAccess.expression);
      const substring = declaration ? fctx.derivedSubstringReads?.get(declaration) : undefined;
      if (substring && substring.kind !== "host") {
        const idxLocal = allocLocal(fctx, `__substring_char_idx_${fctx.locals.length}`, { kind: "i32" });
        const arg = expr.arguments[0];
        const isLengthMinusOne =
          arg !== undefined &&
          ts.isBinaryExpression(arg) &&
          arg.operatorToken.kind === ts.SyntaxKind.MinusToken &&
          ts.isPropertyAccessExpression(arg.left) &&
          arg.left.name.text === "length" &&
          ts.isIdentifier(arg.left.expression) &&
          ctx.oracle.valueDeclarationOf(arg.left.expression) === declaration &&
          ts.isNumericLiteral(arg.right) &&
          Number(arg.right.text) === 1;
        if (isLengthMinusOne) {
          fctx.body.push({ op: "local.get", index: substring.lenLocal });
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "i32.sub" });
        } else if (arg && tryEmitStaticI32Expression(ctx, fctx, arg)) {
          // already emitted as i32
        } else if (arg) {
          compileStringIntegerArg(ctx, fctx, arg);
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        fctx.body.push({ op: "local.set", index: idxLocal });
        const range = arg ? staticIntegerRange(ctx, arg) : { min: 0, max: 0 };
        const provenInBounds =
          (range !== undefined && range.min >= 0 && range.max < substring.minLen) ||
          (isLengthMinusOne && substring.minLen > 0);
        const read = emitDerivedNativeCharCodeRead(ctx, fctx, substring, idxLocal);
        if (provenInBounds) {
          fctx.body.push(...read);
        } else {
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "local.get", index: substring.lenLocal });
          fctx.body.push({ op: "i32.ge_s" });
          fctx.body.push({ op: "i32.or" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [{ op: "f64.const", value: NaN }],
            else: read,
          });
        }
        return { kind: "f64" };
      }
    }
    // #2682 fast path: inside a recognised canonical read loop the receiver was
    // flattened once and the index is proven in-bounds — read directly from the
    // hoisted descriptor (no flatten / struct.get / NaN branch). This arm is the
    // f64-consumption case (the i32-pure chain reads it via emitI32PureExpr in
    // binary-ops.ts). Result is byte-identical to the guarded read on the
    // in-bounds path, which is the only path the proof admits.
    if (!receiverOverride) {
      const hoisted = matchHoistedCharRead(fctx, expr);
      if (hoisted) {
        emitHoistedCharCodeAtRead(ctx, fctx, hoisted, expr.arguments[0]!);
        fctx.body.push({ op: "f64.convert_i32_u" });
        return { kind: "f64" };
      }
    }
    emitReceiver();
    if (!receiverOverride && isKnownFlatSubstringResult(ctx, propAccess.expression)) {
      // `__str_substring` returns a FlatString view into its already-flattened
      // receiver. A const binding cannot later become a rope, so the two
      // charCodeAt calls in a typical slice consumer can use that descriptor
      // directly instead of re-running the flatten discriminator each time.
      fctx.body.push({ op: "ref.cast", typeIdx: strTypeIdx });
    } else {
      // (#4174) Inline already-flat fast path: `charCodeAt` is the scanner
      // hot-loop primitive (acorn calls it once per scanned character); test
      // flatness at the call site and only enter `__str_flatten` on the
      // rope arm instead of paying a cross-function call per character.
      emitFlattenWithInlineFlatFastPath(ctx, fctx, ctx.nativeStrHelpers.get("__str_flatten")!);
    }
    // Store flat string ref in a temp local to access both data and off
    const tmpLocal = allocLocal(fctx, "__charCodeAt_tmp", flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: tmpLocal });
    const idxLocal = allocLocal(fctx, "__charCodeAt_idx", { kind: "i32" });
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: idxLocal });

    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // .len
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [
        { op: "local.get", index: tmpLocal },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
        { op: "local.get", index: tmpLocal },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
        { op: "local.get", index: idxLocal },
        { op: "i32.add" }, // off + idx
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "f64.convert_i32_u" },
      ],
    });
    return { kind: "f64" };
  }

  // charAt: native helper
  if (method === "charAt") {
    emitReceiver();
    emitFlattenRedundant();
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // at: like charAt but supports negative indices
  if (method === "at") {
    emitReceiver();
    emitFlatten();
    const strTmp = allocLocal(fctx, `__str_at_tmp_${fctx.locals.length}`, flatStringType(ctx));
    fctx.body.push({ op: "local.tee", index: strTmp });
    // Get string length for negative index support (len is field 0)
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // .len
    const lenTmp = allocLocal(fctx, `__str_at_len_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: lenTmp });
    // Compile index
    const idxTmp = allocLocal(fctx, `__str_at_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: idxTmp });
    // If index < 0, add length
    fctx.body.push({ op: "local.get", index: idxTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: idxTmp },
        { op: "local.get", index: lenTmp },
        { op: "i32.add" },
        { op: "local.set", index: idxTmp },
      ],
    });
    // ECMA-262 §22.1.3.1 String.prototype.at: after resolving a relative
    // index, an out-of-range position (idx < 0 || idx >= len) yields
    // `undefined`, NOT the empty string that `charAt` returns. Represent that
    // `undefined` as a null native-string ref; the strict-equality path treats
    // a null AnyString-typed ref as undefined-equal (binary-ops.ts).
    const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "local.get", index: idxTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: idxTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringTypeNullable(ctx) },
      then: [
        // Out of range → undefined (null AnyString ref).
        { op: "ref.null", typeIdx: ctx.anyStrTypeIdx },
      ],
      else: [
        { op: "local.get", index: strTmp },
        { op: "local.get", index: idxTmp },
        { op: "call", funcIdx: charAtIdx },
      ],
    });
    return nativeStringTypeNullable(ctx);
  }

  // concat: native helper. ECMA-262 §22.1.3.4 — coerce each argument with
  // ToString and append, left to right, to the receiver. `__str_concat(a, b)`
  // joins two AnyString refs; chain it across the (possibly variadic) argument
  // list so standalone mode never reaches the host `string_concat` import.
  if (method === "concat") {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    // Receiver is the running accumulator.
    emitReceiver();
    if (expr.arguments.length === 0) {
      // `"x".concat()` returns the receiver unchanged.
      return nativeStringType(ctx);
    }
    for (const arg of expr.arguments) {
      // Accumulator is already on the stack; ToString-coerce the next operand
      // (§22.1.3.4 / §7.1.17) so a number/boolean/null/undefined/object arg
      // becomes a native string instead of null-dereffing in `__str_concat`
      // (#2599). Left-to-right fold order is preserved (each arg is evaluated
      // in source order before its join).
      emitArgAsNativeString(ctx, fctx, arg);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
    return nativeStringType(ctx);
  }

  // (#3069) Annex B §B.2.2 legacy HTML string-wrapper methods (CreateHTML,
  // §B.2.2.2.1). Pure UTF-16 concatenation: wrap the receiver `S` in an HTML
  // tag, e.g. `"x".bold()` → `"<b>x</b>"`, `"x".anchor(n)` → `'<a name="…">x</a>'`.
  // In JS-host mode these dispatch through `__extern_method_call`; the
  // standalone/WASI (nativeStrings) lane has no host, so lower them natively via
  // `__str_concat` + literals. Methods carrying an attribute (anchor/fontcolor/
  // fontsize/link) run the value through `__str_html_escape_quot` (CreateHTML
  // step-4.b `"`→`&quot;` escaping). Do NOT add these to STRING_METHODS — that
  // would register a host `string_<m>` import and regress host-mode boxing.
  {
    const htmlWrapper = htmlWrapperFor(method);
    if (htmlWrapper) {
      const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
      const { tag, attribute } = htmlWrapper;
      // §B.2.2.2.1 evaluates ToString(this) (step 2) before ToString(value)
      // (step 4.b). The receiver EXPRESSION is also evaluated before the argument
      // in normal call order — so materialize the receiver into a local first.
      const sLocal = compileReceiverToLocal("__html_recv");
      // Build the prefix (everything before S).
      if (attribute) {
        // prefix = `<tag attribute="` + escapeQuot(ToString(value)) + `">`
        compileNativeStringLiteral(ctx, fctx, `<${tag} ${attribute}="`);
        if (expr.arguments.length > 0) {
          emitArgAsNativeString(ctx, fctx, expr.arguments[0]!);
        } else {
          // Absent argument → value is `undefined` → ToString → "undefined".
          compileNativeStringLiteral(ctx, fctx, "undefined");
        }
        const escIdx = ctx.nativeStrHelpers.get("__str_html_escape_quot")!;
        fctx.body.push({ op: "call", funcIdx: escIdx });
        fctx.body.push({ op: "call", funcIdx: concatIdx }); // `<tag attr="` + escapedV
        compileNativeStringLiteral(ctx, fctx, `">`);
        fctx.body.push({ op: "call", funcIdx: concatIdx }); // … + `">`
      } else {
        compileNativeStringLiteral(ctx, fctx, `<${tag}>`);
      }
      // prefix + S
      fctx.body.push({ op: "local.get", index: sLocal });
      fctx.body.push({ op: "call", funcIdx: concatIdx });
      // … + `</tag>`
      compileNativeStringLiteral(ctx, fctx, `</${tag}>`);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
      return nativeStringType(ctx);
    }
  }

  // substring: native helper
  if (method === "substring") {
    emitReceiver();
    emitFlattenRedundant();
    // start
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end — explicit `undefined` defaults to length (§22.1.3.24), same as absent (#2124)
    if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[1]!);
    } else {
      // Default end = string length
      // We need to get the receiver again — use a temp local
      // Actually, push len from the string on stack — but receiver is consumed.
      // Simpler: push i32.const MAX_INT as sentinel and let helper clamp
      fctx.body.push({ op: "i32.const", value: 0x7fffffff });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // slice: native helper (handles negative indices)
  if (method === "slice") {
    emitReceiver();
    emitFlattenRedundant();
    // start
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end — explicit `undefined` defaults to length (§22.1.3.22), same as absent (#2124)
    if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[1]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7fffffff });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_slice")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // substr: native helper (Annex B §B.2.2.1). Second arg is a *count*, not an
  // end index; an absent length means "to the end" → pass 0x7fffffff sentinel
  // and let __str_substr clamp to `len - start`.
  if (method === "substr") {
    emitReceiver();
    emitFlattenRedundant();
    // start
    if (expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      // §B.2.2.1 step 3: ToIntegerOrInfinity(start ?? undefined) → 0.
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // length — absent or explicit `undefined` means "to the end" (§B.2.2.1
    // step 4 sets length = +∞ when the arg is undefined).
    if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[1]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7fffffff });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_substr")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }
  if (method === "indexOf") {
    if (
      tryEmitStaticNeedleIndexOf({
        ctx,
        fctx,
        expr,
        receiverOverridePresent: receiverOverride !== undefined,
        emit: [compileReceiverToLocal, compileStringValueToLocal, compileIntegerValueToLocal],
      })
    ) {
      return { kind: "i32" };
    }
    const receiverLocal = compileReceiverToLocal("__str_indexOf_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_indexOf_search");
    const fromLocal = compileIntegerValueToLocal(expr.arguments[1], 0, "__str_indexOf_from");
    const funcIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: fromLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // lastIndexOf: native helper
  if (method === "lastIndexOf") {
    const receiverLocal = compileReceiverToLocal("__str_lastIndexOf_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_lastIndexOf_search");
    // §22.1.3.9 step 5: ToIntegerOrInfinity(position) with NaN → +∞, so an
    // explicit `NaN` (or `undefined`) position searches from the end — the same
    // 0x7fffffff sentinel as an absent arg. `compileIntegerValueToLocal` already
    // maps explicit `undefined`; map explicit `NaN` here too (#2124).
    const fromArg = expr.arguments[1];
    const fromIsNaN = fromArg !== undefined && ts.isIdentifier(fromArg) && fromArg.text === "NaN";
    const fromLocal = compileIntegerValueToLocal(
      fromIsNaN ? undefined : fromArg,
      0x7fffffff,
      "__str_lastIndexOf_from",
      0x7fffffff,
    );
    const funcIdx = ctx.nativeStrHelpers.get("__str_lastIndexOf")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: fromLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // includes: native helper
  if (method === "includes") {
    // §22.1.3.7 step 3 — IsRegExp(searchString) ⇒ throw TypeError. Static fold
    // for a RegExp-literal / `new RegExp(...)` / RegExp-typed arg (#2598). The
    // throw replaces the whole call (no receiver/arg emitted).
    if (expr.arguments.length > 0 && argIsStaticRegExp(ctx, expr.arguments[0]!)) {
      emitTypeErrorThrow(
        ctx,
        fctx,
        "TypeError: First argument to String.prototype.includes must not be a regular expression",
      );
      return { kind: "i32" };
    }
    const receiverLocal = compileReceiverToLocal("__str_includes_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_includes_search");
    const fromLocal = compileIntegerValueToLocal(expr.arguments[1], 0, "__str_includes_from");
    const funcIdx = ctx.nativeStrHelpers.get("__str_includes")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: fromLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // startsWith: native helper
  if (method === "startsWith") {
    // §22.1.3.23 step 3 — IsRegExp(searchString) ⇒ throw TypeError (#2598).
    if (expr.arguments.length > 0 && argIsStaticRegExp(ctx, expr.arguments[0]!)) {
      emitTypeErrorThrow(
        ctx,
        fctx,
        "TypeError: First argument to String.prototype.startsWith must not be a regular expression",
      );
      return { kind: "i32" };
    }
    const receiverLocal = compileReceiverToLocal("__str_startsWith_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_startsWith_search");
    const posLocal = compileIntegerValueToLocal(expr.arguments[1], 0, "__str_startsWith_pos");
    const funcIdx = ctx.nativeStrHelpers.get("__str_startsWith")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: posLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // endsWith: native helper
  if (method === "endsWith") {
    // §22.1.3.6 step 3 — IsRegExp(searchString) ⇒ throw TypeError (#2598).
    if (expr.arguments.length > 0 && argIsStaticRegExp(ctx, expr.arguments[0]!)) {
      emitTypeErrorThrow(
        ctx,
        fctx,
        "TypeError: First argument to String.prototype.endsWith must not be a regular expression",
      );
      return { kind: "i32" };
    }
    const receiverLocal = compileReceiverToLocal("__str_endsWith_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_endsWith_search");
    const endLocal = compileIntegerValueToLocal(expr.arguments[1], 0x7fffffff, "__str_endsWith_end");
    const funcIdx = ctx.nativeStrHelpers.get("__str_endsWith")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: endLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // trim, trimStart, trimEnd: native helpers
  if (method === "trim" || method === "trimStart" || method === "trimEnd") {
    emitReceiver();
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // (#3068) isWellFormed / toWellFormed (ES2024 §22.1.3.8/.34) — pure UTF-16
  // code-unit scans over the flattened receiver. `__str_isWellFormed` returns an
  // i32 boolean; `__str_toWellFormed` returns a fresh NativeString with each lone
  // surrogate replaced by U+FFFD. Both helpers take the flattened receiver
  // (`ref $NativeString`), emitted in ensureNativeStringHelpers.
  if (method === "isWellFormed") {
    emitReceiver();
    emitFlatten();
    const funcIdx = ctx.nativeStrHelpers.get("__str_isWellFormed")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }
  if (method === "toWellFormed") {
    emitReceiver();
    emitFlatten();
    const funcIdx = ctx.nativeStrHelpers.get("__str_toWellFormed")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // repeat: native helper with RangeError validation
  if (method === "repeat") {
    emitReceiver();
    emitFlatten();
    if (expr.arguments.length > 0) {
      // BigInt / Symbol args → TypeError per ToNumber spec (#1445)
      if (tryThrowOnBigIntOrSymbolArg(ctx, fctx, expr.arguments[0]!)) {
        fctx.body.push({ op: "i32.const", value: 0 });
        const funcIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
        fctx.body.push({ op: "call", funcIdx });
        return nativeStringType(ctx);
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, {
        kind: "f64",
      });
      // RangeError: count must be non-negative, finite, and not too large.
      // §22.1.3.18: n = ToIntegerOrInfinity(count) (truncates toward zero),
      // THEN throw if n < 0 or n is +∞. The `< 0` test must run on the
      // truncated value, else `repeat(-0.5)` — whose ToIntegerOrInfinity is
      // `-0`, NOT negative — wrongly throws (#2124). `f64.trunc(-0.5) = -0.0`,
      // and `-0.0 < 0` is false, so truncating first gives the spec result.
      // The +∞ check stays on the raw f64 (trunc_sat would clamp it).
      if (argType && argType.kind === "f64") {
        const countLocal = allocLocal(fctx, `__repeat_count_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: countLocal });
        // Check ToIntegerOrInfinity(count) < 0 — truncate toward zero first.
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check count is Infinity (count != count is NaN, but we also need +Inf)
        // Use: count == +Infinity
        fctx.body.push({ op: "local.get", index: countLocal });
        fctx.body.push({ op: "f64.const", value: Infinity });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Invalid count value";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: countLocal });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padStart: native helper
  if (method === "padStart") {
    emitReceiver();
    emitFlatten();
    // targetLength (ToLength per spec — throws TypeError on BigInt/Symbol)
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " "). §22.1.4.1 StringPad step 2: an `undefined`
    // fillString (explicit `padStart(n, undefined)` / `padStart(n, void 0)`)
    // is spec-equivalent to omission and defaults to a single space — emitting
    // it through `compileExpression(undefined) + emitFlatten()` flattens a null
    // ref and traps in `__str_flatten` (#2160 standalone residual).
    if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // Create a single-space native string (len=1, off=0, [32])
      fctx.body.push({ op: "i32.const", value: 1 }); // len
      fctx.body.push({ op: "i32.const", value: 0 }); // off
      fctx.body.push({ op: "i32.const", value: 32 }); // space
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctx.nativeStrDataTypeIdx,
        length: 1,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padStart")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padEnd: native helper
  if (method === "padEnd") {
    emitReceiver();
    emitFlatten();
    // targetLength (ToLength per spec — throws TypeError on BigInt/Symbol)
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " "). §22.1.4.1 StringPad step 2: an `undefined`
    // fillString (explicit `padEnd(n, undefined)` / `padEnd(n, void 0)`) is
    // spec-equivalent to omission and defaults to a single space — emitting it
    // through `compileExpression(undefined) + emitFlatten()` flattens a null
    // ref and traps in `__str_flatten` (#2160 standalone residual).
    if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "i32.const", value: 1 }); // len
      fctx.body.push({ op: "i32.const", value: 0 }); // off
      fctx.body.push({ op: "i32.const", value: 32 });
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctx.nativeStrDataTypeIdx,
        length: 1,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padEnd")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // toLowerCase, toUpperCase: native helpers
  if (
    method === "toLowerCase" ||
    method === "toUpperCase" ||
    method === "toLocaleLowerCase" ||
    method === "toLocaleUpperCase"
  ) {
    // (#1470) toLocale{Lower,Upper}Case without ECMA-402 falls back to the
    // default case conversion (§22.1.3.27/§22.1.3.29 note this is the same as
    // toLowerCase/toUpperCase except for locale-sensitive mappings, which a
    // standalone module has no ICU tables for). Previously these fell through
    // to "Unknown string method" and got demoted to a numeric-zero stub.
    emitReceiver();
    emitFlatten();
    // Locale arguments are still evaluated, in order, for side effects.
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) fctx.body.push({ op: "drop" });
    }
    const helperName = `__str_${method.replace("Locale", "")}`;
    const selectedHelper = selectProvenAsciiCaseHelper(ctx, propAccess.expression, helperName, !receiverOverride);
    const funcIdx = ctx.nativeStrHelpers.get(selectedHelper)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // (#1470) localeCompare — §22.1.3.12 only requires an implementation-
  // defined CONSISTENT total order when ECMA-402 is absent; we use UTF-16
  // code-unit order via the native __str_compare helper (the same order the
  // relational operators use). Previously this fell through to "Unknown
  // string method" and got demoted to an always-0 stub, which violates the
  // consistency requirement (every pair compared "equal"). The locales /
  // options arguments are evaluated for side effects and ignored.
  if (method === "localeCompare") {
    emitReceiver();
    const thatLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__lc_that");
    for (let ai = 1; ai < expr.arguments.length; ai++) {
      const argType = compileExpression(ctx, fctx, expr.arguments[ai]!);
      if (argType) fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "local.get", index: thatLocal });
    const funcIdx = ctx.nativeStrHelpers.get("__str_compare")!;
    fctx.body.push({ op: "call", funcIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  // For replace/replaceAll/split with non-string args (RegExp or custom objects
  // implementing Symbol.replace/replaceAll/split), skip the native helpers and
  // fall through to the host import path. The host import dispatches via JS's
  // String.prototype.* which honours @@replace / @@split / @@match
  // (#1443). Native helpers are only safe when the search arg is statically a
  // string-like type — otherwise we'd silently ignore custom Symbol.* methods.
  const firstArgIsStringLike =
    (method === "replace" || method === "replaceAll" || method === "split") &&
    expr.arguments.length > 0 &&
    (() => {
      const argType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      if ((argType.flags & ts.TypeFlags.String) !== 0) return true;
      if ((argType.flags & ts.TypeFlags.StringLiteral) !== 0) return true;
      if ((argType.flags & ts.TypeFlags.Object) !== 0 && argType.getSymbol()?.getName() === "String") {
        return true;
      }
      // Union of string-like types
      if ((argType.flags & ts.TypeFlags.Union) !== 0) {
        const union = argType as ts.UnionType;
        return union.types.every(
          (t) =>
            (t.flags & ts.TypeFlags.String) !== 0 ||
            (t.flags & ts.TypeFlags.StringLiteral) !== 0 ||
            ((t.flags & ts.TypeFlags.Object) !== 0 && t.getSymbol()?.getName() === "String"),
        );
      }
      return false;
    })();

  // (#4224) §22.1.3.19 steps 3-5 for the STRING search lane, standalone. The
  // arms below assume BOTH operands are already native strings and compile them
  // straight into `ref $AnyString` slots — a silent wrong answer for anything
  // else. `string-search-value.ts` owns the decision and the coercions.
  if (method === "replace" || method === "replaceAll") {
    const rv = tryCompileStandaloneStringValueReplace(ctx, fctx, expr, method, emitReceiver, firstArgIsStringLike);
    if (rv !== undefined) return rv;
  }

  // replace(search, replacement): native helper
  if (method === "replace" && firstArgIsStringLike) {
    emitReceiver();
    emitFlattenRedundant();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlattenRedundant();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlattenRedundant();
    } else {
      // default: empty string (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 }); // len
      fctx.body.push({ op: "i32.const", value: 0 }); // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({
        op: "array.new_default",
        typeIdx: ctx.nativeStrDataTypeIdx,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_replace")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // replaceAll(search, replacement): native helper
  if (method === "replaceAll" && firstArgIsStringLike) {
    emitReceiver();
    emitFlattenRedundant();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlattenRedundant();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlattenRedundant();
    } else {
      // default: empty string (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 }); // len
      fctx.body.push({ op: "i32.const", value: 0 }); // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({
        op: "array.new_default",
        typeIdx: ctx.nativeStrDataTypeIdx,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_replaceAll")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // (#2161 B2 / #4016) The two split-separator arms the native lane owns — an
  // UNDEFINED separator (never splits: `[S]`) and a plain-`ToString` one
  // (`s.split(123)`) — both live in `string-search-value.ts`, which is where the
  // §22.1.3.23 step-2 decision belongs. It declines for a string-like separator
  // so the byte-identical arm below still handles that case.
  if (method === "split") {
    const sep = tryCompileStandaloneSplitSeparator(ctx, fctx, expr, emitReceiver, firstArgIsStringLike);
    if (sep !== undefined) return sep;
  }

  // split: native helper, returns native string array
  if (method === "split" && firstArgIsStringLike) {
    // (#3901) Deliberately NO `emitFlatten()`: `__str_split` takes `ref
    // $AnyString` and its preamble already flattens both params (#3673).
    emitReceiver();
    // separator arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
    } else {
      // default: empty string separator (split each char) (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 }); // len
      fctx.body.push({ op: "i32.const", value: 0 }); // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({
        op: "array.new_default",
        typeIdx: ctx.nativeStrDataTypeIdx,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    // #2125: limit arg → i32 (ToUint32). Default (absent/undefined) is no limit,
    // encoded as 0xFFFFFFFF (= -1 as i32) which the helper treats as unbounded.
    // (#2161 B2) A statically-`undefined` limit takes the unbounded branch too
    // (§22.1.3.23 step 12) — compiling it lowered to f64 NaN, and ToUint32(NaN)
    // = 0 truncated `"a b".split(" ", undefined)` to `[]`.
    if (expr.arguments.length > 1 && !isStaticallyUndefinedExpr(expr.arguments[1]!)) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[1]!);
    } else {
      fctx.body.push({ op: "i32.const", value: -1 });
    }
    const splitIdx = ctx.nativeStrHelpers.get("__str_split")!;
    fctx.body.push({ op: "call", funcIdx: splitIdx });
    // Return type is ref $vec_nstr — use same key as resolveWasmType for string[]
    const nstrVecTypeIdx = ctx.vecTypeMap.get(`ref_${ctx.anyStrTypeIdx}`)!;
    return { kind: "ref", typeIdx: nstrVecTypeIdx };
  }

  // codePointAt: like charCodeAt but returns f64 (code point value)
  // ECMA-262 §22.1.3.4 delegates to CodePointAt: out-of-range produces
  // undefined in JS. This numeric lowering uses NaN as the existing f64
  // sentinel, and combines a valid UTF-16 surrogate pair when one starts at
  // position.
  if (method === "codePointAt") {
    emitReceiver();
    emitFlatten();
    const tmpLocal = allocLocal(fctx, "__codePointAt_tmp", flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: tmpLocal });
    const idxLocal = allocLocal(fctx, `__codePointAt_idx_${fctx.locals.length}`, { kind: "i32" });
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: idxLocal });
    const firstLocal = allocLocal(fctx, `__codePointAt_first_${fctx.locals.length}`, { kind: "i32" });
    const secondLocal = allocLocal(fctx, `__codePointAt_second_${fctx.locals.length}`, { kind: "i32" });

    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [
        { op: "local.get", index: tmpLocal },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: tmpLocal },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: idxLocal },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "local.tee", index: firstLocal },
        { op: "i32.const", value: 0xd800 },
        { op: "i32.ge_u" },
        { op: "local.get", index: firstLocal },
        { op: "i32.const", value: 0xdbff },
        { op: "i32.le_u" },
        { op: "i32.and" },
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: tmpLocal },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: tmpLocal },
            { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
            { op: "local.get", index: tmpLocal },
            { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: idxLocal },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.tee", index: secondLocal },
            { op: "i32.const", value: 0xdc00 },
            { op: "i32.ge_u" },
            { op: "local.get", index: secondLocal },
            { op: "i32.const", value: 0xdfff },
            { op: "i32.le_u" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [
                { op: "local.get", index: firstLocal },
                { op: "i32.const", value: 0xd800 },
                { op: "i32.sub" },
                { op: "i32.const", value: 10 },
                { op: "i32.shl" },
                { op: "local.get", index: secondLocal },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.sub" },
                { op: "i32.add" },
                { op: "i32.const", value: 0x10000 },
                { op: "i32.add" },
                { op: "f64.convert_i32_u" },
              ],
              else: [{ op: "local.get", index: firstLocal }, { op: "f64.convert_i32_u" }],
            },
          ],
          else: [{ op: "local.get", index: firstLocal }, { op: "f64.convert_i32_u" }],
        },
      ],
    });
    return { kind: "f64" };
  }

  // normalize: return string unchanged (identity — correct for already-normalized strings)
  // RangeError: if form argument is provided, must be one of "NFC", "NFD", "NFKC", "NFKD"
  if (method === "normalize") {
    if (expr.arguments.length > 0) {
      // Check at compile time if the form argument is a string literal
      const formArg = expr.arguments[0]!;
      if (ts.isStringLiteral(formArg)) {
        const form = formArg.text;
        if (form !== "NFC" && form !== "NFD" && form !== "NFKC" && form !== "NFKD") {
          // Static RangeError — emit unconditional throw
          const rangeErrMsg = "RangeError: The normalization form should be one of NFC, NFD, NFKC, NFKD";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push(...stringConstantExternrefInstrs(ctx, rangeErrMsg));
          fctx.body.push({ op: "throw", tagIdx });
          return null;
        }
      }
      // #1823 — evaluation order: the receiver (`this`) is evaluated BEFORE the
      // argument per §13.3 / §22.1.3.13. Compile the receiver into a temp first
      // (preserving its side effects in order), then compile + drop the form
      // argument (still evaluated for its side effects, after the receiver),
      // then read the receiver temp back as the (identity) result.
      const recvType = emitReceiver();
      const recvValType = (recvType ?? nativeStringType(ctx)) as ValType;
      const recvLocal = allocLocal(fctx, `__normalize_recv_${fctx.locals.length}`, recvValType);
      fctx.body.push({ op: "local.set", index: recvLocal });
      const argType = compileExpression(ctx, fctx, formArg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "local.get", index: recvLocal });
      return recvType;
    }
    return emitReceiver();
  }

  // #1474/#1539 — These host-routed string methods build/consume a JS RegExp
  // under the hood. In --target standalone, route the supported static RegExp
  // slices through the pure-WasmGC matcher first, then refuse the remaining
  // host/symbol-protocol forms with a clean diagnostic.
  //   - match / matchAll / search: the spec coerces the (string) argument to a
  //     RegExp, so they always route through the host regex engine.
  //   - replace / replaceAll / split: only when the first argument needs
  //     RegExp/symbol-protocol dispatch (string-arg forms use the native helpers
  //     above and never reach this fall-through).
  // #1539 Phase 2b — `String.prototype.match(/re/)` for non-global
  // backend-created static RegExp materializes the same native capture vec as
  // `.exec`. Global/all-match semantics stay refused below.
  if (ctx.standalone && method === "match") {
    const matchResult = tryCompileStandaloneStringMatch(ctx, fctx, expr, propAccess, receiverOverride);
    if (matchResult !== undefined) return matchResult;
  }

  // #2161 — `String.prototype.matchAll(/re/g)` against a global static RegExp
  // routes to the native engine, returning an iterable vec of capture-arrays
  // (for-of / spread consume it via the #2169 native-vec path). Non-global,
  // string-arg, and dynamic-flags forms fall through to the refusal below.
  if (ctx.standalone && method === "matchAll") {
    const matchAllResult = tryCompileStandaloneStringMatchAll(ctx, fctx, expr, propAccess, receiverOverride);
    if (matchAllResult !== undefined) return matchAllResult;
  }

  // #1539 Phase 2b — `String.prototype.search(/re/)` against a backend-created
  // static RegExp routes to the pure-WasmGC matcher (returns the match index or
  // -1) instead of the host regex engine. The string-coercion form (string
  // argument) is not a RegExp value and falls through to the refusal below.
  if (ctx.standalone && method === "search") {
    const searchResult = tryCompileStandaloneStringSearch(ctx, fctx, expr, propAccess, receiverOverride);
    if (searchResult !== undefined) return searchResult;
  }

  // #1539 Phase 2c — `String.prototype.replace(/re/, "str")` / `replaceAll`
  // against a backend-created static RegExp with a literal replacement routes
  // to the pure-WasmGC matcher (returns the rebuilt NativeString). `$`-pattern /
  // function replacers and the string-coercion form fall through to the refusal.
  if ((ctx.standalone || ctx.wasi) && (method === "replace" || method === "replaceAll")) {
    const replaceResult = tryCompileStandaloneStringReplace(ctx, fctx, expr, propAccess, receiverOverride);
    if (replaceResult !== undefined) return replaceResult;
  }

  // #1539 Phase 2c — `String.prototype.split(/re/)` against a backend-created
  // static, non-capturing, non-nullable RegExp routes through the pure-WasmGC
  // matcher and returns the same native string vec shape as string split.
  if ((ctx.standalone || ctx.wasi || ctx.targetProfile.semanticProviders === "native-first") && method === "split") {
    const splitResult = tryCompileStandaloneStringSplit(ctx, fctx, expr, propAccess, receiverOverride);
    if (splitResult !== undefined) return splitResult;
  }

  if (ctx.standalone) {
    // (#2161) `matchAll` is no longer blanket-refused: the global `/re/g` slice
    // routes through tryCompileStandaloneStringMatchAll above. Only the
    // non-global / string-arg / dynamic-flags forms reach this refusal.
    const alwaysRegExp = method === "match" || method === "matchAll" || method === "search";
    const symbolProtocolArgForm =
      (method === "replace" || method === "replaceAll" || method === "split") &&
      expr.arguments.length > 0 &&
      !firstArgIsStringLike;
    if (alwaysRegExp || symbolProtocolArgForm) {
      reportError(
        ctx,
        expr,
        `Codegen error: String.prototype.${method}(...) with a RegExp or symbol-protocol search value is not supported in ` +
          "--target standalone (#1474). Use a supported backend-created static RegExp or native string-only overload, or " +
          "recompile without --target standalone.",
      );
      // Commit the diagnostic through compileExpression's #1919 transaction:
      // a null result is treated as a speculative miss and rolls errors back.
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
  }

  // Other methods: marshal native->extern, call host, marshal extern->native
  const importName = `string_${method}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx !== undefined) {
    ensureNativeStringExternBridge(ctx);
    flushLateImportShifts(ctx, fctx);
    // Marshal receiver: flatten + native string -> externref
    emitReceiver();
    emitFlatten();
    const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern")!;
    fctx.body.push({ op: "call", funcIdx: toExternIdx });

    // Compile arguments — string args need flattening + marshaling
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (
        argType &&
        argType.kind === "ref" &&
        (argType.typeIdx === strTypeIdx || argType.typeIdx === ctx.anyStrTypeIdx)
      ) {
        // String arg → flatten + marshal to externref
        emitFlatten();
        fctx.body.push({ op: "call", funcIdx: toExternIdx });
      }
    }

    fctx.body.push({ op: "call", funcIdx });

    // Determine return type and marshal back if needed
    const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
    const returnsNum = method === "indexOf" || method === "lastIndexOf" || method === "search";
    const returnsExternRef = method === "match";
    if (returnsBool) {
      return { kind: "i32" };
    } else if (returnsNum) {
      return { kind: "f64" };
    } else if (returnsExternRef) {
      // Returns externref (e.g. match result array or null) — no marshal needed
      return { kind: "externref" };
    } else {
      // Returns externref string → marshal to native
      const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern")!;
      fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      return nativeStringType(ctx);
    }
  }

  reportError(ctx, expr, `Unknown string method: ${method}`);
  return null;
}

/**
 * (#2576, extends #2187) Runtime-guarded native string method dispatch for an
 * `any`/unknown receiver whose value MAY be a native `$AnyString` at runtime
 * (object property values, generator yield reads, catch bindings, indexed
 * element reads — see `receiverMayBeNativeStringAtRuntime`). The static
 * `isStringType` / `receiverIsNativeStringValType` gates miss these (the value
 * is an opaque externref), so without this the call fell to the host/dynamic
 * path (null/0 standalone).
 *
 * Evaluates the receiver EXACTLY ONCE into an externref temp (preserving side
 * effects and ordering), then `ref.test $AnyString`:
 *   - hit  → cast the saved externref to `$AnyString` and run the normal native
 *            method lowering against it (via `compileNativeStringMethodCall`'s
 *            receiver override — the receiver is NOT re-compiled),
 *   - miss → the method's spec default for its result type (so a non-string
 *            `any` — array, number, null — does not trap and yields a benign
 *            default rather than a wrong value).
 *
 * Standalone/WASI native-string mode only; the caller gates on
 * `ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`.
 */
export function compileGuardedNativeStringMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
): ValType | null {
  // Evaluate the receiver once → externref temp (side effects happen here only).
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (!recvType) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const recvExt = allocLocal(fctx, `__strm_ext_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: recvExt });

  // Build the then-arm (native method on the cast $AnyString receiver) into a
  // separate body so we can learn its result ValType before shaping the else.
  const savedBody = pushBody(fctx);
  const resultType = compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method, () => {
    fctx.body.push({ op: "local.get", index: recvExt });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  });
  const thenInstrs = fctx.body;
  popBody(fctx, savedBody);

  if (resultType === null) return null;

  // else-arm (non-string receiver at runtime). Default: the spec sentinel for
  // the result ValType.
  //
  // (#2583) For the callback-free array search/predicate methods
  // (indexOf/lastIndexOf/includes), a genuinely-`any` receiver may be an ARRAY
  // (or an object literal with a `<Struct>_<method>`), not a string. Route the
  // else-arm through the closed-method dispatcher `__call_m_<method>_<arity>`,
  // whose native `$__vec_base` brand arm services the array case and whose
  // open-`$Object` arm services object literals. For any OTHER non-string
  // receiver (number, null, plain object), the dispatcher's terminal
  // `ref.null.extern` is unboxed back to the same benign sentinel as before — so
  // no regression. Gated to standalone/wasi + arity≥1, matching the dispatcher's
  // own brand-arm gate; otherwise the plain sentinel is kept.
  const VEC_SEARCH = method === "indexOf" || method === "lastIndexOf" || method === "includes";
  let elseInstrs: Instr[] | undefined;
  if (
    VEC_SEARCH &&
    (ctx.standalone || ctx.wasi) &&
    (resultType.kind === "i32" || resultType.kind === "f64") &&
    expr.arguments.length >= 1 &&
    !expr.arguments.some((a) => ts.isSpreadElement(a))
  ) {
    const arity = expr.arguments.length;
    const dispatchIdx = reserveClosedMethodDispatch(ctx, method, arity);
    flushLateImportShifts(ctx, fctx);
    const unboxNumIdx = ctx.funcMap.get("__unbox_number");
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean");
    const haveUnbox = method === "includes" ? unboxBoolIdx !== undefined : unboxNumIdx !== undefined;
    if (haveUnbox) {
      const saved = pushBody(fctx);
      // recv (the already-evaluated externref temp) + each arg boxed to externref.
      fctx.body.push({ op: "local.get", index: recvExt });
      for (const arg of expr.arguments) {
        const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
        else if (at === null) fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: dispatchIdx });
      // Dispatcher returns a boxed externref. Unbox to the string method's
      // result kind: includes → boolean(i32); indexOf/lastIndexOf → number(f64),
      // truncated to i32 when the string arm's result is i32.
      if (method === "includes") {
        fctx.body.push({ op: "call", funcIdx: unboxBoolIdx! });
        if (resultType.kind === "f64") fctx.body.push({ op: "f64.convert_i32_s" });
      } else {
        fctx.body.push({ op: "call", funcIdx: unboxNumIdx! }); // externref → f64
        if (resultType.kind === "i32") fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      elseInstrs = fctx.body;
      popBody(fctx, saved);
    }
  }
  // (#3673) USER-METHOD COLLISION arm. The sentinel else-arm above assumes a
  // `ref.test $AnyString` miss means "array / number / null", for which a
  // benign default is honest. It is a SILENT WRONG ANSWER when the receiver is
  // an object that defines a method of the same name — and that is not
  // hypothetical: compiled acorn's `RegExpValidationState.prototype.at`
  // collides with `String.prototype.at`, so `state.at(i)` missed the test and
  // yielded `ref.null $AnyString`, read back as `0` instead of the `-1`
  // end-of-input sentinel. `regexp_eatPatternCharacters`'s
  // `while ((ch = state.current()) !== -1 && …)` then spun forever, hanging the
  // standalone parser on EVERY `u`-flag regex literal.
  //
  // When the program itself defines a method of this name, route the miss
  // through the closed-method dispatcher `__call_m_<method>_<arity>` (the same
  // machinery #2583 uses for the array search trio: closed-struct arms, then
  // the open-`$Object` arm that reaches a prototype-assigned user method), and
  // WIDEN the whole construct to `externref` — the dispatcher hands back a
  // boxed `any`, and a user method's return type is unrelated to the string
  // method's. The then-arm's native result is boxed to match.
  //
  // Scoped to names the source actually defines, so the unboxed native result
  // type survives for every other name — notably acorn's `charCodeAt`/`slice`/
  // `substr` tokenizer hot set, whose whole point (#3673) is to avoid boxing.
  if (
    elseInstrs === undefined &&
    ctx.userMethodNames?.has(method) === true &&
    (ctx.standalone || ctx.wasi) &&
    !expr.arguments.some((a) => ts.isSpreadElement(a))
  ) {
    const arity = expr.arguments.length;
    const dispatchIdx = reserveClosedMethodDispatch(ctx, method, arity);
    flushLateImportShifts(ctx, fctx);
    const boxNumIdx = ctx.funcMap.get("__box_number");
    const boxBoolIdx = ctx.funcMap.get("__box_boolean");
    // Box the then-arm's native result to `externref` so both arms agree.
    const boolResult = method === "includes" || method === "startsWith" || method === "endsWith";
    const boxThen = ((): Instr[] | null => {
      if (resultType.kind === "externref") return [];
      if (resultType.kind === "ref" || resultType.kind === "ref_null") return [{ op: "extern.convert_any" }];
      if (resultType.kind === "f64") {
        return boxNumIdx === undefined ? null : [{ op: "call", funcIdx: boxNumIdx }];
      }
      if (resultType.kind === "i32") {
        if (boolResult) return boxBoolIdx === undefined ? null : [{ op: "call", funcIdx: boxBoolIdx }];
        return boxNumIdx === undefined ? null : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
      }
      return null;
    })();
    if (boxThen !== null) {
      const saved = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: recvExt });
      for (const arg of expr.arguments) {
        const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
        else if (at === null) fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: dispatchIdx });
      const dispatchElse = fctx.body;
      popBody(fctx, saved);

      thenInstrs.push(...boxThen);
      const widened: ValType = { kind: "externref" };
      fctx.body.push({ op: "local.get", index: recvExt });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: widened },
        then: thenInstrs,
        else: dispatchElse,
      });
      return widened;
    }
  }

  if (elseInstrs === undefined) {
    elseInstrs = [];
    if (resultType.kind === "f64") {
      elseInstrs.push({ op: "f64.const", value: NaN });
    } else if (resultType.kind === "i32") {
      elseInstrs.push({ op: "i32.const", value: 0 });
    } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
      elseInstrs.push({
        op: "ref.null",
        typeIdx: (resultType as { typeIdx: number }).typeIdx,
      });
    } else {
      elseInstrs.push({ op: "ref.null.extern" });
    }
  }

  fctx.body.push({ op: "local.get", index: recvExt });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

// Register the compileStringLiteral delegate so property-access.ts can emit
// string constants without importing string-ops.ts directly (cycle prevention).
registerCompileStringLiteral(compileStringLiteral);

// #1917 Step 1 / #3324 — bind the leaf string emitters (defined here, not
// exported) into the import-free registry: safe while the engine is mid-init.
registerStringHelperEmitters({
  boolToString: emitBoolToString,
  nativeStringRefFromExternref: emitNativeStringRefFromExternref,
});
