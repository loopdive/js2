import { isBigIntType, isBooleanType, isStringType, isSymbolType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * String operations extracted from expressions.ts.
 * Handles string literals, templates, tagged templates, string binary ops,
 * and native string method calls.
 */
import { ts } from "../ts-api.js";
import { compileNumericBinaryOp } from "./binary-ops.js";
import { pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError, getFuncParamTypes, noJsHost } from "./expressions/helpers.js";
import { addStringImports, flatStringType, nativeStringType, resolveIdentifierType, resolveWasmType } from "./index.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringExternBridge,
  nativeStringLiteralInstrs,
  nativeStringTypeNullable,
  stringConstantExternrefInstrs,
  tryCompileNativeVecConcatOperand,
} from "./native-strings.js";
import {
  tryCompileStandaloneStringMatch,
  tryCompileStandaloneStringMatchAll,
  tryCompileStandaloneStringReplace,
  tryCompileStandaloneStringSearch,
  tryCompileStandaloneStringSplit,
} from "./regexp-standalone.js";
import { addStringConstantGlobal, ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterTemplateVecType, getOrRegisterVecType } from "./registry/types.js";
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

/**
 * (#2124) An explicit `undefined` (or `void 0`) passed for an optional string
 * index arg is spec-equivalent to omitting it — the method applies its own
 * default (substring/slice/endsWith end → length, lastIndexOf from → length).
 * But compiling it through the i32 arg path coerces NaN/undefined → 0, which is
 * wrong. Detect the statically-undefined forms so callers can treat the arg as
 * absent. Unwraps paren/as/!-assertion wrappers.
 */
function isStaticUndefinedArg(arg: ts.Expression | undefined): boolean {
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
  } as Instr);
}

function emitNativeStringRefFromExternref(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
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

  // Already a native string operand (string-typed ref) — pass straight through.
  if ((opType.kind === "ref" || opType.kind === "ref_null") && isStringType(tsType)) {
    return true;
  }

  const toStrIdx = ctx.funcMap.get("number_toString");

  if (opType.kind === "i32" && isBooleanType(tsType)) {
    // Boolean → "true"/"false" native literal selected at runtime.
    const trueInstrs = nativeStringLiteralInstrs(ctx, "true");
    const falseInstrs = nativeStringLiteralInstrs(ctx, "false");
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: trueInstrs,
      else: falseInstrs,
    } as Instr);
    return true;
  }

  if ((opType.kind === "f64" || opType.kind === "i32" || opType.kind === "i64") && toStrIdx !== undefined) {
    if (opType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (opType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
    fctx.body.push({ op: "call", funcIdx: toStrIdx });
    emitNativeStringRefFromExternref(ctx, fctx);
    return true;
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
    const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
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
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // Push len (i32) — field 0
  fctx.body.push({ op: "i32.const", value: value.length });

  // Push off (i32) = 0 — field 1
  fctx.body.push({ op: "i32.const", value: 0 });

  // Push each code unit (i16) and create array with array.new_fixed
  for (let i = 0; i < value.length; i++) {
    fctx.body.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  fctx.body.push({
    op: "array.new_fixed",
    typeIdx: strDataTypeIdx,
    length: value.length,
  });

  // struct.new $NativeString(len, off, data)
  fctx.body.push({ op: "struct.new", typeIdx: strTypeIdx });

  return nativeStringType(ctx);
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
      // matching string constant (#2005 undefined, #2006 null).
      fctx.body.push({ op: "drop" });
      const word = spanIsNullType ? "null" : "undefined";
      addStringConstantGlobal(ctx, word);
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get(word)! });
    } else if (
      spanType &&
      spanType.kind === "i32" &&
      (isBooleanType(spanTsType) || (spanType as { boolean?: true }).boolean)
    ) {
      // boolean i32 → "true"/"false" (#2005). #2016/#2030: also covers branded
      // i32 predicates (`.boolean`), which render "true"/"false", not "1"/"0".
      // emitBoolToString returns an externref the following concat accepts.
      emitBoolToString(ctx, fctx);
    } else if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "i64" && toStrIdx !== undefined) {
      // BigInt → f64 → string
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "externref") {
      // null/undefined externref spans must become "null"/"undefined" strings;
      // a raw ref.null extern trips the js-string concat cast (#2006). Opaque
      // externrefs route through __extern_toString so wasmGC structs run their
      // ToPrimitive walker before reaching concat.
      const spanIsNull = (spanTsType.flags & ts.TypeFlags.Null) !== 0;
      const spanIsUndef = (spanTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
      if (spanIsNull) {
        fctx.body.push({ op: "drop" });
        addStringConstantGlobal(ctx, "null");
        fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("null")! });
      } else if (spanIsUndef) {
        fctx.body.push({ op: "drop" });
        addStringConstantGlobal(ctx, "undefined");
        fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("undefined")! });
      } else if (!isStringType(spanTsType)) {
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
      // otherwise a real string externref — already concat-ready
    } else if (spanType && (spanType.kind === "ref" || spanType.kind === "ref_null")) {
      // Struct ref → externref: use coerceType which checks @@toPrimitive("string") first
      coerceType(ctx, fctx, spanType, { kind: "externref" }, "string");
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
    const spanType = compileExpression(ctx, fctx, span.expression);
    const spanIsScalarNullish = (spanNativeIsUndef || spanNativeIsNull) && spanType && spanType.kind !== "externref";
    const spanIsBool = spanType && spanType.kind === "i32" && isBooleanType(spanNativeTsType);
    if (spanIsScalarNullish) {
      // Scalar-lowered null/undefined → drop the placeholder, build the native
      // string constant inline (#2005/#2006). Leaves the native string ref on
      // the stack for the shared concat tail below.
      fctx.body.push({ op: "drop" } as Instr);
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
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (standaloneNativeStrings) {
        emitNativeStringRefFromExternref(ctx, fctx);
      } else if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (standaloneNativeStrings) {
        emitNativeStringRefFromExternref(ctx, fctx);
      } else if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && spanType.kind === "i64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (standaloneNativeStrings) {
        emitNativeStringRefFromExternref(ctx, fctx);
      } else if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && (spanType.kind === "f64" || spanType.kind === "i32" || spanType.kind === "i64")) {
      reportError(ctx, span.expression, "Template literal numeric substitution requires number_toString");
      fctx.body.push({ op: "drop" } as Instr);
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
      addStringConstantGlobal(ctx, word);
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get(word)! });
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
        addStringConstantGlobal(ctx, "null");
        fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("null")! });
      } else if (subIsUndef) {
        fctx.body.push({ op: "drop" });
        addStringConstantGlobal(ctx, "undefined");
        fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("undefined")! });
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

  // First: build the raw strings array as a regular vec
  for (const raw of rawParts) {
    compileStringLiteral(ctx, fctx, raw, expr);
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
    compileStringLiteral(ctx, fctx, str, expr);
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
  } as Instr);

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
      // Prepend captured values for nested functions with captures.
      const nestedCaptures = ctx.nestedFuncCaptures.get(tagName);
      if (nestedCaptures) {
        for (const cap of nestedCaptures) {
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        }
      }

      const restInfo = ctx.funcRestParams.get(tagName);
      const paramTypes = getFuncParamTypes(ctx, funcIdx);

      // Push the strings array as argument 0
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if needed (e.g. ref_null vec → externref)
      if (paramTypes?.[0] && paramTypes[0].kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      if (restInfo) {
        // Tag function has rest param: push positional args before rest, then pack rest
        const captureCount = nestedCaptures ? nestedCaptures.length : 0;
        const restIdx = restInfo.restIndex - captureCount; // restIndex in user params (0-based after captures)
        // Push positional substitutions before the rest param
        for (let i = 0; i < Math.min(substitutions.length, restIdx - 1); i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[i + 1 + captureCount]);
        }
        // Pack remaining substitutions into a vec for the rest param
        const restStart = Math.max(0, restIdx - 1);
        const restSubs = substitutions.slice(restStart);
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
        const captureCount = nestedCaptures ? nestedCaptures.length : 0;
        const maxSubs = paramTypes
          ? Math.min(substitutions.length, paramTypes.length - 1 - captureCount)
          : substitutions.length;
        for (let i = 0; i < maxSubs; i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[i + 1 + captureCount]);
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

      // Save closure ref to a local
      let closureLocal: number;
      if (tagResult?.kind === "externref") {
        // Need to convert externref back to the closure struct ref (guarded)
        const closureRefType: ValType = {
          kind: "ref_null",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = tagResult ?? {
          kind: "ref",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as self param (first arg of lifted function)
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);

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
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
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
    } as Instr);
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
 * Walk a left-associative (or right-associative) tree of `+` BinaryExpressions
 * whose result type is string, collecting all leaf operands in order.
 * Returns the flat list of operands for the concat chain.
 */
function collectConcatOperands(ctx: CodegenContext, expr: ts.Expression): ts.Expression[] {
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isStringType(ctx.checker.getTypeAtLocation(expr))
  ) {
    return [...collectConcatOperands(ctx, expr.left), ...collectConcatOperands(ctx, expr.right)];
  }
  return [expr];
}

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

/**
 * Resolve a compile-time constant, but only for truly immutable values.
 * Unlike resolveConstantExpression, this does NOT resolve let/var declarations —
 * only string/numeric literals, const variables, and expressions composed of those.
 * This prevents incorrect folding of mutable variables in loops.
 */
function resolveStrictConstant(ctx: CodegenContext, expr: ts.Expression): string | number | undefined {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isParenthesizedExpression(expr)) return resolveStrictConstant(ctx, expr.expression);

  // Only resolve const variable references
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return resolveStrictConstant(ctx, decl.initializer);
        }
      }
    }
    return undefined;
  }

  // Binary expressions (recurse strictly)
  if (ts.isBinaryExpression(expr)) {
    const left = resolveStrictConstant(ctx, expr.left);
    const right = resolveStrictConstant(ctx, expr.right);
    if (left === undefined || right === undefined) return undefined;
    if (typeof left === "string" || typeof right === "string") {
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return String(left) + String(right);
      }
      return undefined;
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    return undefined;
  }

  // Template literals
  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const val = resolveStrictConstant(ctx, span.expression);
      if (val === undefined) return undefined;
      result += String(val) + span.literal.text;
    }
    return result;
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;

  return undefined;
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
  // §7.1.17 ToString(Symbol) throws — `"x" + sym` must throw TypeError.
  if (tryThrowOnSymbolStringCoercion(ctx, fctx, operand)) return;
  const tsType = valueExprTsType(ctx, operand); // #2176 ambient-shadow safe
  const valType = compileExpression(ctx, fctx, operand);

  if (!valType) {
    // Void function return → push "undefined"
    addStringConstantGlobal(ctx, "undefined");
    fctx.body.push({
      op: "global.get",
      index: ctx.stringGlobalMap.get("undefined")!,
    });
  } else if (valType.kind === "f64" || valType.kind === "i32" || valType.kind === "i64") {
    // #2016/#2030: honour the boolean brand on the ValType, not just the TS type.
    // i32-returning predicates (hasOwnProperty, IteratorResult.done, …) carry
    // `boolean: true` so their string form is "true"/"false", not "1"/"0".
    if (valType.kind === "i32" && (isBooleanType(tsType) || (valType as { boolean?: true }).boolean)) {
      emitBoolToString(ctx, fctx);
    } else {
      if (valType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      else if (valType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  } else if (valType.kind === "externref") {
    const isNull = (tsType.flags & ts.TypeFlags.Null) !== 0;
    const isUndef = (tsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (isNull) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "null");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("null")!,
      });
    } else if (isUndef) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("undefined")!,
      });
    }
  } else if (valType.kind === "ref" || valType.kind === "ref_null") {
    // #2022 — `+` applies ToPrimitive with the DEFAULT hint (valueOf-first),
    // not the string hint. Convert the struct to externref and route through
    // `__extern_to_string_default`. (Was `coerceType(..., "string")`, which
    // walked @@toPrimitive("string")/toString — the wrong hint for `+`; e.g.
    // `objWithValueOf + ""` must use valueOf.) The bare extern.convert_any
    // alone would also let the wasm:js-string concat polyfill throw on the
    // opaque struct, so the host stringify call is still required.
    coerceType(ctx, fctx, valType, { kind: "externref" });
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
  const compareBody: Instr[] = [
    { op: "local.get", index: leftLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx },
    { op: "local.get", index: rightLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx },
    { op: "call", funcIdx: equalsIdx },
  ];
  const rightNullCheck: Instr[] = [
    { op: "local.get", index: rightLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 } as Instr],
      else: compareBody,
    } as Instr,
  ];
  fctx.body.push({ op: "local.get", index: leftLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: rightLocal } as Instr, { op: "ref.is_null" } as Instr],
    else: rightNullCheck,
  } as Instr);
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
      case ts.SyntaxKind.PlusToken: {
        // Constant-fold if both sides are compile-time constants (#1004)
        const constVal = resolveStrictConstant(ctx, expr);
        if (typeof constVal === "string") {
          return compileStringLiteral(ctx, fctx, constVal, expr);
        }
        // #1470 — `__str_concat` takes `(ref $AnyString, ref $AnyString)`. A
        // non-string operand (number, boolean, object, `any`) must be coerced
        // to a native string first or the module is invalid (the previous code
        // pushed the raw f64/i32/struct ref and `__str_concat` rejected it).
        //
        // This issue targets the standalone / WASI surface (`noJsHost`), where
        // there is no JS runtime to fall back on. There, every operand is
        // lowered to a native `ref $AnyString` in pure Wasm via
        // `compileNativeConcatOperand` (numbers → native `number_toString`,
        // booleans/null/undefined → native literals, dynamic refs → the
        // `$__any_to_string` dispatcher). The legacy JS-host `nativeStrings`
        // path (explicit `nativeStrings: true` / `fast`) is left unchanged here:
        // its mixed-operand handling has separate, pre-existing limitations and
        // bridging through `__str_from_extern` mid-body corrupts function
        // indices, so it stays on the original raw-push behavior.
        if (noJsHost(ctx)) {
          compileNativeConcatOperand(ctx, fctx, expr.left);
          compileNativeConcatOperand(ctx, fctx, expr.right);
        } else {
          // concat accepts ref $AnyString — no flatten needed
          compileExpression(ctx, fctx, expr.left);
          compileExpression(ctx, fctx, expr.right);
        }
        const funcIdx = ctx.nativeStrHelpers.get("__str_concat");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return nativeStringType(ctx);
        }
        break;
      }
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
        // Lexicographic comparison via __str_compare (returns -1, 0, 1)
        compileExpression(ctx, fctx, expr.left);
        compileExpression(ctx, fctx, expr.right);
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
    addStringConstantGlobal(ctx, "undefined");
    const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
    fctx.body.push({ op: "global.get", index: undefGIdx });
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
      addStringConstantGlobal(ctx, "null");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("null")!,
      });
    } else if (leftIsUndef) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("undefined")!,
      });
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
    // #2022 — `+` is a ToPrimitive(default) site. Convert the struct ref to an
    // externref (bare extern.convert_any) and route it through
    // `__extern_to_string_default`, which runs valueOf-first ToPrimitive on the
    // wasmGC struct. (Was `coerceType(..., "string")`, which walks
    // @@toPrimitive("string")/toString — the wrong hint for `+`.)
    coerceType(ctx, fctx, leftType, { kind: "externref" });
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
    addStringConstantGlobal(ctx, "undefined");
    const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
    fctx.body.push({ op: "global.get", index: undefGIdx });
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
      addStringConstantGlobal(ctx, "null");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("null")!,
      });
    } else if (rightIsUndef) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push({
        op: "global.get",
        index: ctx.stringGlobalMap.get("undefined")!,
      });
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
    // #2022 — `+` is a ToPrimitive(default) site. Convert the struct ref to an
    // externref and route through `__extern_to_string_default` (valueOf-first)
    // rather than `coerceType(..., "string")` (toString-first, wrong for `+`).
    coerceType(ctx, fctx, rightType, { kind: "externref" });
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
  if (noJsHost(ctx)) {
    emitThrowTypeError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" } as Instr);
    return;
  }
  const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    compileNativeStringLiteral(ctx, fctx, msg);
    if (throwIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      // GC-ref → externref bridge so the host import receives a JS string.
      fctx.body.push({ op: "extern.convert_any" } as Instr);
      const funcIdx = ctx.funcMap.get("__throw_type_error")!;
      fctx.body.push({ op: "call", funcIdx } as Instr);
      fctx.body.push({ op: "unreachable" } as Instr);
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "extern.convert_any" } as Instr);
      fctx.body.push({ op: "throw", tagIdx } as Instr);
    }
    return;
  }
  const strIdx = ctx.stringGlobalMap.get(msg)!;
  if (throwIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    const funcIdx = ctx.funcMap.get("__throw_type_error")!;
    fctx.body.push({ op: "global.get", index: strIdx } as Instr);
    fctx.body.push({ op: "call", funcIdx } as Instr);
    fctx.body.push({ op: "unreachable" } as Instr);
  } else {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "global.get", index: strIdx } as Instr);
    fctx.body.push({ op: "throw", tagIdx } as Instr);
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
function compileStringIntegerArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (tryThrowOnBigIntOrSymbolArg(ctx, fctx, arg)) {
    // After unreachable, the wasm stack is polymorphic — but we still
    // push a sentinel i32 so the (unreached) call site reads cleanly.
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  const argType = compileExpression(ctx, fctx, arg, { kind: "i32" });
  if (!argType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else if (argType.kind === "i64") {
    // BigInt fell through static detection (e.g. `any` widened to bigint).
    // Drop the i64 and throw TypeError per §7.1.4.
    fctx.body.push({ op: "drop" } as Instr);
    emitTypeErrorThrow(ctx, fctx, "TypeError: Cannot convert a BigInt value to a number");
    fctx.body.push({ op: "i32.const", value: 0 });
  }
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
): ValType | null {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

  // Helper: emit a flatten call to convert ref $AnyString → ref $NativeString
  const emitFlatten = () => fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const compileStringValueToLocal = (value: ts.Expression | undefined, fallback: string, name: string): number => {
    const local = allocLocal(fctx, `${name}_${fctx.locals.length}`, nativeStringType(ctx));
    if (value) {
      compileExpression(ctx, fctx, value, nativeStringType(ctx));
    } else {
      compileStringLiteral(ctx, fctx, fallback);
    }
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };
  const compileIntegerValueToLocal = (value: ts.Expression | undefined, fallback: number, name: string): number => {
    const local = allocLocal(fctx, `${name}_${fctx.locals.length}`, {
      kind: "i32",
    });
    // Explicit `undefined` is spec-equivalent to an absent arg → use the
    // method's default sentinel rather than coercing undefined → 0 (#2124).
    if (value && !isStaticUndefinedArg(value)) {
      compileStringIntegerArg(ctx, fctx, value);
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
    compileExpression(ctx, fctx, propAccess.expression);
    // Flatten to FlatString (handles ConsString → FlatString)
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
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
    } as Instr);
    return { kind: "f64" };
  }

  // charAt: native helper
  if (method === "charAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
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
    compileExpression(ctx, fctx, propAccess.expression);
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
    } as Instr);
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
    } as Instr);
    return nativeStringTypeNullable(ctx);
  }

  // concat: native helper. ECMA-262 §22.1.3.4 — coerce each argument with
  // ToString and append, left to right, to the receiver. `__str_concat(a, b)`
  // joins two AnyString refs; chain it across the (possibly variadic) argument
  // list so standalone mode never reaches the host `string_concat` import.
  if (method === "concat") {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    // Receiver is the running accumulator.
    compileExpression(ctx, fctx, propAccess.expression);
    if (expr.arguments.length === 0) {
      // `"x".concat()` returns the receiver unchanged.
      return nativeStringType(ctx);
    }
    for (const arg of expr.arguments) {
      // Accumulator is already on the stack; push the next operand and join.
      compileExpression(ctx, fctx, arg, nativeStringType(ctx));
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
    return nativeStringType(ctx);
  }

  // substring: native helper
  if (method === "substring") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
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

  // indexOf: native helper
  if (method === "indexOf") {
    const receiverLocal = compileStringValueToLocal(propAccess.expression, "", "__str_indexOf_recv");
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
    const receiverLocal = compileStringValueToLocal(propAccess.expression, "", "__str_lastIndexOf_recv");
    const searchLocal = compileStringValueToLocal(expr.arguments[0], "undefined", "__str_lastIndexOf_search");
    // §22.1.3.9 step 5: ToIntegerOrInfinity(position) with NaN → +∞, so an
    // explicit `NaN` (or `undefined`) position searches from the end — the same
    // 0x7fffffff sentinel as an absent arg. `compileIntegerValueToLocal` already
    // maps explicit `undefined`; map explicit `NaN` here too (#2124).
    const fromArg = expr.arguments[1];
    const fromIsNaN = fromArg !== undefined && ts.isIdentifier(fromArg) && fromArg.text === "NaN";
    const fromLocal = compileIntegerValueToLocal(fromIsNaN ? undefined : fromArg, 0x7fffffff, "__str_lastIndexOf_from");
    const funcIdx = ctx.nativeStrHelpers.get("__str_lastIndexOf")!;
    fctx.body.push({ op: "local.get", index: receiverLocal });
    fctx.body.push({ op: "local.get", index: searchLocal });
    fctx.body.push({ op: "local.get", index: fromLocal });
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // includes: native helper
  if (method === "includes") {
    const receiverLocal = compileStringValueToLocal(propAccess.expression, "", "__str_includes_recv");
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
    const receiverLocal = compileStringValueToLocal(propAccess.expression, "", "__str_startsWith_recv");
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
    const receiverLocal = compileStringValueToLocal(propAccess.expression, "", "__str_endsWith_recv");
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // repeat: native helper with RangeError validation
  if (method === "repeat") {
    compileExpression(ctx, fctx, propAccess.expression);
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
        fctx.body.push({ op: "f64.trunc" } as Instr);
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
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength (ToLength per spec — throws TypeError on BigInt/Symbol)
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength (ToLength per spec — throws TypeError on BigInt/Symbol)
    if (expr.arguments.length > 0) {
      compileStringIntegerArg(ctx, fctx, expr.arguments[0]!);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // Locale arguments are still evaluated, in order, for side effects.
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) fctx.body.push({ op: "drop" });
    }
    const helperName = `__str_${method.replace("Locale", "")}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
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
    compileExpression(ctx, fctx, propAccess.expression);
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

  // replace(search, replacement): native helper
  if (method === "replace" && firstArgIsStringLike) {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
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
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
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

  // split: native helper, returns native string array
  if (method === "split" && firstArgIsStringLike) {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // separator arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
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
    if (expr.arguments.length > 1) {
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
    compileExpression(ctx, fctx, propAccess.expression);
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
    } as Instr);
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
          fctx.body.push({ op: "throw", tagIdx } as Instr);
          return null;
        }
      }
      // #1823 — evaluation order: the receiver (`this`) is evaluated BEFORE the
      // argument per §13.3 / §22.1.3.13. Compile the receiver into a temp first
      // (preserving its side effects in order), then compile + drop the form
      // argument (still evaluated for its side effects, after the receiver),
      // then read the receiver temp back as the (identity) result.
      const recvType = compileExpression(ctx, fctx, propAccess.expression);
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
    return compileExpression(ctx, fctx, propAccess.expression);
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
    const matchResult = tryCompileStandaloneStringMatch(ctx, fctx, expr, propAccess);
    if (matchResult !== undefined) return matchResult;
  }

  // #2161 — `String.prototype.matchAll(/re/g)` against a global static RegExp
  // routes to the native engine, returning an iterable vec of capture-arrays
  // (for-of / spread consume it via the #2169 native-vec path). Non-global,
  // string-arg, and dynamic-flags forms fall through to the refusal below.
  if (ctx.standalone && method === "matchAll") {
    const matchAllResult = tryCompileStandaloneStringMatchAll(ctx, fctx, expr, propAccess);
    if (matchAllResult !== undefined) return matchAllResult;
  }

  // #1539 Phase 2b — `String.prototype.search(/re/)` against a backend-created
  // static RegExp routes to the pure-WasmGC matcher (returns the match index or
  // -1) instead of the host regex engine. The string-coercion form (string
  // argument) is not a RegExp value and falls through to the refusal below.
  if (ctx.standalone && method === "search") {
    const searchResult = tryCompileStandaloneStringSearch(ctx, fctx, expr, propAccess);
    if (searchResult !== undefined) return searchResult;
  }

  // #1539 Phase 2c — `String.prototype.replace(/re/, "str")` / `replaceAll`
  // against a backend-created static RegExp with a literal replacement routes
  // to the pure-WasmGC matcher (returns the rebuilt NativeString). `$`-pattern /
  // function replacers and the string-coercion form fall through to the refusal.
  if (ctx.standalone && (method === "replace" || method === "replaceAll")) {
    const replaceResult = tryCompileStandaloneStringReplace(ctx, fctx, expr, propAccess);
    if (replaceResult !== undefined) return replaceResult;
  }

  // #1539 Phase 2c — `String.prototype.split(/re/)` against a backend-created
  // static, non-capturing, non-nullable RegExp routes through the pure-WasmGC
  // matcher and returns the same native string vec shape as string split.
  if (ctx.standalone && method === "split") {
    const splitResult = tryCompileStandaloneStringSplit(ctx, fctx, expr, propAccess);
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
          "--target standalone (#1474). Pass a string pattern instead, or " +
          "recompile without --target standalone.",
      );
      return null;
    }
  }

  // Other methods: marshal native->extern, call host, marshal extern->native
  const importName = `string_${method}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx !== undefined) {
    ensureNativeStringExternBridge(ctx);
    flushLateImportShifts(ctx, fctx);
    // Marshal receiver: flatten + native string -> externref
    compileExpression(ctx, fctx, propAccess.expression);
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

// Register the compileStringLiteral delegate so property-access.ts can emit
// string constants without importing string-ops.ts directly (cycle prevention).
registerCompileStringLiteral(compileStringLiteral);
