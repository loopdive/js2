// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Identifier-callee call dispatch extracted from the ~13k-line
// compileCallExpression (#742, Wave B mega-function decomposition). The single
// exported entry `compileIdentifierCall` handles calls whose target is a bare
// identifier — node:fs global functions, the inline global builtins
// (parseInt/parseFloat/isNaN/isFinite/Array), and direct named-function calls
// via funcMap. It returns `undefined` when the callee is not one of these
// identifier cases, so the caller in calls.ts continues its dispatch chain.
// Moved verbatim: the emitted Wasm is byte-identical.
import { ts } from "../../ts-api.js";
import { captureSourceSlot, pushBoxedTdzFlagRef } from "../closures/capture-source-slot.js";
import { materializeHoistedFunctionValueBinding } from "../closures/funcref-as-closure.js";
import { isBooleanType, isPromiseType, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { resolveArrayInfo } from "../array-methods.js";
import { ensureAnyHelpers, ensureAnyToExternHelper } from "../any-helpers.js";
import { compileArrowAsClosure, getClosureFuncSelfTypeIdx, getOrCreateFuncRefWrapperTypes } from "../closures.js";
import { emitToNumber, emitToString } from "../coercion-engine.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  getOrRegisterRefCellType,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import {
  getLinearU8Buffer,
  getLinearU8ParamIndicesForCall,
  sourceParamCountFromExpanded,
  wasmParamIndexForSourceParam,
} from "../linear-uint8-signatures.js";
import { compileArrayConstructorCall, compileSymbolCall } from "../literals.js";
import { tryCompileNodeFsCall } from "../node-fs-api.js";
import {
  boundFunctionTargetIsDefinitelyCompiled,
  calleeIsBoundFunctionVar,
  resolveApplyBindAlias,
  resolveUncurryThisAlias,
} from "../object-builtin-effects.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { emitNullCheckThrow, typeErrorThrowInstrs } from "../property-access.js";
import { emitRuntimeEvalInterpretedCallableAdapter } from "../runtime-eval-callable.js";
import { emitStandaloneRegExpToStringFromExpr } from "../regexp-standalone.js";
import type { InnerResult } from "../shared.js";
import { brandExternMethodResult, coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import {
  emitSetExtrasArgv,
  ensureExtrasArgvGlobal,
  maybeSetArgcForKnownCall,
} from "../statements/nested-declarations.js";
import { emitStringExternResultFlatten, emitStringRefResultFlatten } from "../string-materialize.js";
import { compileStringLiteral, emitBoolToString, emitNativeStringToHostExternref } from "../string-ops.js";
import { usesNativeNumberFormat } from "../number-format-native.js";
import { emitSymbolToString } from "../symbol-native.js";
import { resolveGlobalParseBuiltin } from "../global-builtin-resolution.js";
import { resolveBuiltinStaticBindingAlias } from "../builtin-static-globals.js";
import { ensureStandaloneBuiltinStaticMethodClosure } from "../builtin-value-read.js";
import { localBindingShadowsCapturingFunction } from "../function-declaration-observation.js";
import { isUnaliasedNodeFsImportBinding } from "../node-fs-binding-identity.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
} from "../type-coercion.js";
import { compileAnnexBEscapeCall } from "../annexb-escape-call.js"; // (#3064 / #4556)
import { URI_DECODE_MASK, URI_ENCODE_MASK } from "../uri-encoding-native.js";
import { ensureWasiWriteFileStringsHelper } from "../wasi.js";
import { wasiAllocStringData } from "./builtins.js";
import { compileClosureCall, runtimeSignatureParameters } from "./calls-closures.js";
import { tryCompileStoredObjectBuiltinCall } from "./call-object-builtins.js";
import { compileSpreadCallArgs } from "./extern.js";
import {
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { analyzeTdzAccessByPos, emitLocalTdzCheck, emitStaticTdzThrow } from "./identifiers.js";
import { buildThrowJsErrorInstrs, emitThrowReferenceError } from "../js-errors.js"; // undeclared-identifier call → ReferenceError
import { compileInternalCallArgument } from "./internal-call-argument.js";
import { isSloppyImplicitGlobalBinding } from "./implicit-global-binding.js"; // (#3966) callee stored on the realm global
import { isForeignEvalNode } from "./eval-source.js";
import { resolvesToGlobalFunctionAlias } from "./eval-inline.js";
import { prepareStandaloneEvalAliasCall } from "./eval-alias.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import {
  calleeIsCapabilityCtorParam,
  calleeIsPromiseExecutorParam,
  calleeMayBeHostCallable,
  compileCallExpression,
  ensureFuncValueWrappersRegistered,
  emitBoundFunctionCall,
  PATH_BASED_FS_FNS,
  resolveClosureInfoFromLocal,
  tryEmitArrayToStringNative,
  tryEmitInlineDynamicCall,
  usesNativeFunctionBindProvider,
} from "./calls.js";
import {
  appendArgcSetupFromExtras,
  appendDynamicCandidateArgcSetup as setCandidateArgc,
  buildArgcExtrasReset,
  buildArgcResetNoLazyExtras,
  saveArgumentLocalAsExtern,
} from "./argc-extras.js";

/**
 * (#3912) Report the representation of `String(<number>)`'s result truthfully.
 *
 * `number_toString` is declared `(f64) -> externref`, but under native strings
 * that externref is a `$AnyString` widened by `extern.convert_any`, NOT a JS
 * string. Reporting it as a bare `externref` pushed the question downstream,
 * where consumers had to re-discover the representation with a dynamic
 * `ref.test $AnyString` — and a consumer that cannot do that (a JS-host import
 * argument such as `parseFloat`/`Number`) silently received an opaque WasmGC
 * struct instead of a string.
 *
 * This mirrors the `unwrapToNative` unwrap already done on the
 * `(n).toString()` path in `call-receiver-method.ts`, so the two spellings of
 * the same operation now agree on their result type.
 */
function emitStringBuiltinNumberResult(ctx: CodegenContext, fctx: FunctionContext): ValType {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && ctx.anyStrTypeIdx >= 0 && usesNativeNumberFormat(ctx)) {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }
  return { kind: "externref" };
}

function hasLiveFunctionBinding(ctx: CodegenContext, fctx: FunctionContext, name: string): boolean {
  if (fctx.annexBRepeatedOuterBindings?.has(name)) return true;
  if (fctx.annexBExistingDirectFunctionBindings?.has(name)) return true;
  const hasModuleBinding =
    ctx.runtimeEvalGlobalFunctionBindings ||
    (ctx.annexBModuleBindings?.has(name) === true && fctx.localMap.get(name) === undefined);
  return hasModuleBinding && ctx.liveFuncBindingGlobals?.has(name) === true;
}

/**
 * Dispatch standalone carriers whose runtime representation must win over the
 * checker-inferred call signature. A `.bind(...)` initializer stores the
 * canonical `$__bound_fn`, not an ordinary funcref-wrapper struct. Casting it
 * through the typed path can therefore null the value—or trap while coercing
 * an argument—before the existing bound arm of the native callable ladder can
 * reach `__apply_closure`.
 */
function tryCompileStoredStandaloneCarrierCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  isKnownVariable: boolean,
): InnerResult | undefined {
  if (!isKnownVariable || (!ctx.standalone && !noJsHost(ctx))) return undefined;
  const storedObjectCall = tryCompileStoredObjectBuiltinCall(ctx, fctx, expr);
  if (storedObjectCall !== undefined) return storedObjectCall;
  if (!calleeIsBoundFunctionVar(ctx.oracle, expr.expression)) return undefined;
  return tryEmitInlineDynamicCall(ctx, fctx, expr, true) ?? undefined;
}

interface WasiWriteFileCarrier {
  local: number | null;
}

/** True only for the ambient binding generated from an unaliased node:fs import. */
function isDirectNodeFsImportBinding(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  if (fctx.localMap.has(id.text) || (fctx.boxedCaptures?.has(id.text) ?? false)) return false;
  return isUnaliasedNodeFsImportBinding(ctx, id);
}

/**
 * Evaluate one WASI writeFileSync argument and preserve its natural reference
 * carrier without validating it yet. JavaScript evaluates the complete
 * ArgumentList before the callee validates parameters, so path/data errors must
 * not suppress later data/options side effects.
 */
function compileWasiWriteFileCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  role: "path" | "data",
): WasiWriteFileCarrier {
  const valueType = compileExpression(ctx, fctx, expr);
  flushLateImportShifts(ctx, fctx);

  const isAnyHierarchyRef =
    valueType?.kind === "ref" ||
    valueType?.kind === "ref_null" ||
    valueType?.kind === "eqref" ||
    valueType?.kind === "anyref";
  const isExternRef = valueType?.kind === "externref" || valueType?.kind === "ref_extern";
  if (!valueType || (!isAnyHierarchyRef && !isExternRef)) {
    if (valueType) fctx.body.push({ op: "drop" });
    return { local: null };
  }

  const carrierLocal = allocLocal(fctx, `__wasi_write_${role}_carrier_${fctx.locals.length}`, { kind: "anyref" });
  if (isExternRef) fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: carrierLocal });
  return { local: carrierLocal };
}

/**
 * Validate a previously evaluated carrier as a strict primitive AnyString.
 * `$AnyValue`/externref boundaries are unwrapped, while every non-string throws
 * a catchable TypeError instead of reaching a raw Wasm cast trap.
 */
function normalizeWasiWriteFileStringRef(
  ctx: CodegenContext,
  fctx: FunctionContext,
  carrier: WasiWriteFileCarrier,
  role: "path" | "data",
): number {
  const anyStringRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const resultLocal = allocLocal(fctx, `__wasi_write_${role}_${fctx.locals.length}`, anyStringRef);

  if (carrier.local === null) {
    fctx.body.push(
      ...buildThrowJsErrorInstrs(ctx, "TypeError", `WASI writeFileSync ${role} must be a string`, {
        flush: fctx,
      }),
    );
    // Unreachable filler keeps the compiler's local typing explicit.
    fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "local.set", index: resultLocal });
    return resultLocal;
  }

  // A union/`any` value may be the compiler's tagged `$AnyValue`. Use the
  // canonical boundary helper so tag-5 native strings are exposed while all
  // other tags remain non-strings and fail the runtime guard below.
  if (ctx.anyValueTypeIdx >= 0) {
    addUnionImports(ctx);
    ensureAnyHelpers(ctx);
    ensureAnyToExternHelper(ctx);
    flushLateImportShifts(ctx, fctx);
    const anyToExternIdx = ctx.funcMap.get("__any_to_extern");
    if (anyToExternIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: carrier.local });
      fctx.body.push({ op: "ref.test", typeIdx: ctx.anyValueTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: carrier.local },
          { op: "ref.cast", typeIdx: ctx.anyValueTypeIdx },
          { op: "call", funcIdx: anyToExternIdx },
          { op: "any.convert_extern" },
          { op: "local.set", index: carrier.local },
        ],
      });
    }
  }

  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", `WASI writeFileSync ${role} must be a string`, {
    flush: fctx,
  });
  fctx.body.push({ op: "local.get", index: carrier.local });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });
  fctx.body.push({ op: "local.get", index: carrier.local });
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });
  return resultLocal;
}

/**
 * (#742) Identifier-callee call dispatch — extracted verbatim from
 * compileCallExpression. Handles the cases where the call target is a bare
 * identifier: node:fs global functions (readFileSync / writeFileSync, both the
 * WASI and JS-host lowerings), the inline global builtins (parseInt /
 * parseFloat / isNaN / isFinite / Array(...)), and direct named-function calls
 * resolved through funcMap.
 *
 * Returns an InnerResult when it handled the call, or `undefined` when the
 * callee is not one of these identifier cases — the caller then continues its
 * dispatch chain (IIFE, super, element-access, conditional, …). The block was
 * moved unchanged so the emitted Wasm is byte-identical.
 */
export function compileIdentifierCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult | undefined {
  // #1491 — non-WASI fs.readFileSync / writeFileSync as JS-host imports.
  // Gated behind `--allow-fs` (CompileOptions.allowFs) to prevent accidental
  // capability leakage. The corresponding host imports are bound at runtime via
  // the `node_builtin_fn` ImportIntent. Initial scope: 2-arg shapes only —
  // readFileSync(path, "utf-8") returns string, writeFileSync(path, data)
  // returns void. Buffer-shaped reads are deferred to a follow-up.
  if (
    !ctx.wasi &&
    ts.isIdentifier(expr.expression) &&
    isDirectNodeFsImportBinding(ctx, fctx, expr.expression) &&
    (expr.expression.text === "readFileSync" || expr.expression.text === "writeFileSync")
  ) {
    const fnName = expr.expression.text;
    if (!ctx.allowFs) {
      const { line, character } = expr.getSourceFile().getLineAndCharacterOfPosition(expr.getStart());
      ctx.errors.push({
        message:
          `'node:fs' call to '${fnName}' requires the --allow-fs flag (or { allowFs: true } ` +
          `in CompileOptions) for non-WASI targets (#1491). Refusing to emit the host import ` +
          `to prevent accidental capability leakage.`,
        line: line + 1,
        column: character + 1,
        severity: "error",
      });
      // Drop args, emit a safe placeholder so codegen can continue.
      for (const arg of expr.arguments) {
        const t = compileExpression(ctx, fctx, arg);
        if (t) fctx.body.push({ op: "drop" });
      }
      if (fnName === "writeFileSync") return VOID_RESULT;
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Lazily register the host import. Both fns are (externref, externref) -> externref|void.
    // Use ensureLateImport so late additions correctly shift existing function
    // indices (export tables, call instructions, etc.) — calling raw addImport
    // here would otherwise misalign the exported function indices.
    const importName = `__node_fs_${fnName}`;
    const params: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
    const results: ValType[] = fnName === "writeFileSync" ? [] : [{ kind: "externref" }];
    const funcIdx = ensureLateImport(ctx, importName, params, results);
    if (funcIdx === undefined) {
      // Should be unreachable — emit a defensive placeholder.
      for (const arg of expr.arguments) {
        const t = compileExpression(ctx, fctx, arg);
        if (t) fctx.body.push({ op: "drop" });
      }
      if (fnName === "writeFileSync") return VOID_RESULT;
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    flushLateImportShifts(ctx, fctx);

    // Compile 2 args as externref (pad missing with ref.null.extern so the call
    // typechecks even when the user under-supplied args).
    const argCount = Math.min(2, expr.arguments.length);
    for (let i = 0; i < argCount; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    }
    for (let i = argCount; i < 2; i++) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Drop extra args (e.g. callback overload) without emitting them — Initial
    // scope is sync 2-arg shapes only.
    for (let i = 2; i < expr.arguments.length; i++) {
      const t = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (t) fctx.body.push({ op: "drop" });
    }

    fctx.body.push({ op: "call", funcIdx });
    if (fnName === "writeFileSync") return VOID_RESULT;
    return { kind: "externref" };
  }

  // WASI mode: writeFileSync(path, data) → __wasi_write_file_sync(pathPtr, pathLen, dataPtr, dataLen)
  if (
    ctx.wasi &&
    ts.isIdentifier(expr.expression) &&
    isDirectNodeFsImportBinding(ctx, fctx, expr.expression) &&
    expr.expression.text === "writeFileSync"
  ) {
    if (expr.arguments.length < 2) {
      // The module-level node:fs gate exempts writeFileSync because this path
      // owns it. Do not let an under-supplied call fall through and disappear:
      // evaluate the supplied arguments, then preserve Node's catchable
      // argument-validation failure.
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) fctx.body.push({ op: "drop" });
      }
      fctx.body.push(
        ...buildThrowJsErrorInstrs(ctx, "TypeError", "WASI writeFileSync requires path and data arguments", {
          flush: fctx,
        }),
      );
      return VOID_RESULT;
    }
    if (ctx.funcMap.has("__wasi_write_file_sync")) {
      const pathArg = expr.arguments[0]!;
      const dataArg = expr.arguments[1]!;
      const isLiteralString = (arg: ts.Expression): arg is ts.StringLiteralLike =>
        ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);

      // Keep the allocation-free data-segment path when both values are literal.
      if (isLiteralString(pathArg) && isLiteralString(dataArg)) {
        const pathData = wasiAllocStringData(ctx, pathArg.text);
        fctx.body.push({ op: "i32.const", value: pathData.offset });
        fctx.body.push({ op: "i32.const", value: pathData.length });
        const dataData = wasiAllocStringData(ctx, dataArg.text);
        fctx.body.push({ op: "i32.const", value: dataData.offset });
        fctx.body.push({ op: "i32.const", value: dataData.length });
        for (let i = 2; i < expr.arguments.length; i++) {
          const optionType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (optionType) fctx.body.push({ op: "drop" });
        }
        flushLateImportShifts(ctx, fctx);
        const finalStaticIdx = ctx.funcMap.get("__wasi_write_file_sync");
        if (finalStaticIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: finalStaticIdx });
          return VOID_RESULT;
        }
        fctx.body.push({ op: "unreachable" });
        return VOID_RESULT;
      }

      // Dynamic/mixed arguments are evaluated left-to-right into GC locals.
      // The helper opens the encoded path before reusing scratch for the data,
      // avoiding both aliasing and an unbounded linear-memory bump allocation.
      if (ensureWasiWriteFileStringsHelper(ctx) < 0 || ctx.anyStrTypeIdx < 0) {
        reportError(ctx, expr, "WASI writeFileSync dynamic-string helper is unavailable");
        return VOID_RESULT;
      }
      const pathCarrier = compileWasiWriteFileCarrier(ctx, fctx, pathArg, "path");
      const dataCarrier = compileWasiWriteFileCarrier(ctx, fctx, dataArg, "data");
      for (let i = 2; i < expr.arguments.length; i++) {
        const optionType = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (optionType) fctx.body.push({ op: "drop" });
      }
      flushLateImportShifts(ctx, fctx);

      // All ArgumentList expressions have now run. Validate in Node's parameter
      // order only after those side effects are complete.
      const pathLocal = normalizeWasiWriteFileStringRef(ctx, fctx, pathCarrier, "path");
      const dataLocal = normalizeWasiWriteFileStringRef(ctx, fctx, dataCarrier, "data");
      flushLateImportShifts(ctx, fctx);

      // A compiled operand may have added a late import; funcMap is the
      // shift-maintained source of truth, so never reuse the earlier index.
      const finalDynamicIdx = ctx.funcMap.get("__wasi_write_file_strings");
      if (finalDynamicIdx === undefined) {
        fctx.body.push({ op: "unreachable" });
        return VOID_RESULT;
      }
      fctx.body.push({ op: "local.get", index: pathLocal });
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "call", funcIdx: finalDynamicIdx });
      return VOID_RESULT;
    }
  }

  // #2631 — path-based node:fs functions (readFileSync, readFile, …) are NOT
  // the fd-based readSync/writeSync handled by the node:fs shim: they need a
  // filesystem (path_open / preopens). They are gated behind --allow-fs and are
  // rejected outright under --target wasi (standalone has no filesystem). The
  // fd-based readSync/writeSync (no path) were already lowered above via
  // tryCompileNodeFsCall, so anything reaching here named like a path-based fs
  // reader is unsupported in WASI.
  if (
    ctx.wasi &&
    ts.isIdentifier(expr.expression) &&
    isDirectNodeFsImportBinding(ctx, fctx, expr.expression) &&
    PATH_BASED_FS_FNS.has(expr.expression.text)
  ) {
    const fnName = expr.expression.text;
    const { line, character } = expr.getSourceFile().getLineAndCharacterOfPosition(expr.getStart());
    ctx.errors.push({
      message:
        `'node:fs' path-based call to '${fnName}' is not available under --target wasi (#2631): ` +
        `standalone WASI has no filesystem (no path_open / preopens). Only the fd-based synchronous ` +
        `primitives readSync(fd, …) / writeSync(fd, …) are supported (they map to fd_read / fd_write ` +
        `via the node:fs shim). For host file access, target a JS host with --allow-fs instead.`,
      line: line + 1,
      column: character + 1,
      severity: "error",
    });
    // Drop args, emit a safe placeholder so codegen can continue.
    for (const arg of expr.arguments) {
      const t = compileExpression(ctx, fctx, arg);
      if (t) fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle global isNaN(n) / isFinite(n) / parseInt / parseFloat — inline wasm
  if (ts.isIdentifier(expr.expression)) {
    // Preserve source identity for parseInt/parseFloat aliases. A package can
    // legitimately export a different function with the same spelling.
    const globalParseBuiltin = resolveGlobalParseBuiltin(expr.expression, ctx.oracle);
    const funcName = globalParseBuiltin ?? expr.expression.text;

    if (funcName === "isNaN" && expr.arguments.length >= 1) {
      // isNaN(n) → n !== n
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    }

    if (funcName === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0  (Infinity - Infinity = NaN, NaN - NaN = NaN, finite - finite = 0)
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.sub" });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    }

    // parseInt(s, radix?) and parseFloat(s) — host imports
    if (globalParseBuiltin !== undefined && expr.arguments.length >= 1) {
      const importFuncIdx = ctx.ambientBuiltinFuncMap.get(globalParseBuiltin) ?? ctx.funcMap.get(globalParseBuiltin);
      if (importFuncIdx !== undefined) {
        const arg0 = expr.arguments[0]!;
        // (#2652) §19.2.5 step 1 / §19.2.4 step 1: ToString(argument) BEFORE
        // parsing. In standalone / WASI the native `parseInt` / `parseFloat`
        // helpers take a string ref and immediately do `any.convert_extern;
        // ref.cast $AnyString` on it — a NON-string primitive argument
        // (`parseInt(true)`, `parseInt(-1)`) boxed as boolean/number tripped
        // that cast ("illegal cast in parseInt()"). The JS-host imports do the
        // `String(arg)` themselves, so host mode keeps its existing boxing path
        // byte-for-byte. Here we run the SAME native ToString engine the `+` /
        // template sites use (`emitToString`: boolean → "true"/"false", numeric
        // → `number_toString`, void → "undefined") and hand the resulting
        // native string ref to the helper as an externref. Only scalar
        // (i32/f64/i64), void, and statically-`null`/`undefined` args take this
        // path; a real string (externref / native ref) keeps the existing
        // passthrough, and a dynamic externref wrapper object is left to the
        // (separate, deferred) wrapper substrate.
        const nativeParse = ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone || ctx.wasi;
        const arg0TsType = ctx.checker.getTypeAtLocation(arg0);
        const arg0Type = compileExpression(ctx, fctx, arg0);
        // A statically-typed `null`/`undefined`/`void` arg lowers to an externref
        // but its ToString is the literal "null"/"undefined" — emitToString's
        // externref arm handles it (it drops the ref and pushes the literal).
        const isStaticNullish =
          arg0Type?.kind === "externref" &&
          !isStringType(arg0TsType) &&
          (arg0TsType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
          (arg0TsType.flags & ts.TypeFlags.Any) === 0;
        const isScalarArg = !arg0Type || arg0Type.kind === "i32" || arg0Type.kind === "f64" || arg0Type.kind === "i64";
        if (nativeParse && (isScalarArg || isStaticNullish)) {
          const strType = emitToString(ctx, fctx, arg0Type, arg0TsType, "string");
          // emitToString returns a native `ref $AnyString` (native modes) — the
          // helper wants an externref, so convert via `extern.convert_any`.
          if (strType.kind !== "externref") {
            coerceType(ctx, fctx, strType, { kind: "externref" });
          }
        } else if (
          // (#3912) NATIVE STRING → HOST IMPORT. `fast` is the one config with a
          // JS host AND native strings, so `nativeParse` is false (the host
          // `env.parseInt` is used) while the argument is a `ref $AnyString`.
          // The generic `coerceType(..., externref)` below only widens the GC
          // ref (`extern.convert_any`), handing the host an opaque WasmGC struct
          // — V8 throws `Cannot convert object to primitive value`. Marshal the
          // code units out instead, exactly as console.log's string arm does.
          //
          // This cell is broken on `main` TODAY for every native string:
          // `parseInt("42")` with a plain LITERAL traps under `fast`. #3912 only
          // makes it reachable from one more producer, because `n.toString()`
          // stops accidentally returning a host string. Fixing it here keeps
          // #3912 a strict improvement; the general native→host argument
          // boundary (`Number(s)`, `JSON.stringify(s)`) is tracked separately.
          !nativeParse &&
          ctx.nativeStrings &&
          arg0Type !== null &&
          (arg0Type.kind === "ref" || arg0Type.kind === "ref_null") &&
          isStringType(arg0TsType) &&
          emitNativeStringToHostExternref(ctx, fctx)
        ) {
          // marshalled in the condition — nothing further to emit
        } else if (arg0Type && arg0Type.kind !== "externref") {
          // Host mode (or a native-string ref) — preserve the original boxing,
          // which keeps boolean identity so the host `String(true)` → "true".
          if (
            arg0Type.kind === "i32" &&
            (arg0.kind === ts.SyntaxKind.TrueKeyword || arg0.kind === ts.SyntaxKind.FalseKeyword)
          ) {
            // Boolean literal: box as boolean so String(true) → "true"
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else {
            coerceType(ctx, fctx, arg0Type, { kind: "externref" });
          }
        }
        if (funcName === "parseInt") {
          if (expr.arguments.length >= 2) {
            compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
          } else {
            // No radix supplied — push NaN sentinel so runtime treats it as undefined
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "f64" };
      }
    }

    // decodeURI, decodeURIComponent, encodeURI, encodeURIComponent.
    // Host mode: per-name `env.*` import. Standalone/wasi (#2500): the encode
    // names route to `__uri_encode(s, preservedMask)` and the decode names to
    // `__uri_decode(s, reservedMask)` (both emitted in declarations.ts), passing
    // the per-function mask (encode: uriUnescaped vs + uriReserved ∪ #; decode:
    // reservedURISet kept-escaped for decodeURI, empty for decodeURIComponent).
    if (
      (funcName === "decodeURI" ||
        funcName === "decodeURIComponent" ||
        funcName === "encodeURI" ||
        funcName === "encodeURIComponent") &&
      expr.arguments.length >= 1
    ) {
      const isEncode = funcName === "encodeURI" || funcName === "encodeURIComponent";
      const nativeHelperIdx = isEncode ? ctx.funcMap.get("__uri_encode") : ctx.funcMap.get("__uri_decode");
      if (nativeHelperIdx !== undefined) {
        const mask = isEncode ? URI_ENCODE_MASK[funcName]! : URI_DECODE_MASK[funcName]!;
        const arg0Type = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (arg0Type && arg0Type.kind !== "externref") {
          coerceType(ctx, fctx, arg0Type, { kind: "externref" });
        }
        fctx.body.push({ op: "i32.const", value: mask });
        fctx.body.push({ op: "call", funcIdx: nativeHelperIdx });
        return { kind: "externref" };
      }
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0Type = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (arg0Type && arg0Type.kind !== "externref") {
          coerceType(ctx, fctx, arg0Type, { kind: "externref" });
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "externref" };
      }
    }

    // (#3064 / #4556) Legacy `escape` / `unescape` — see annexb-escape-call.ts.
    {
      const esc = compileAnnexBEscapeCall(ctx, fctx, expr, funcName, {
        compileExpr: (e) => compileExpression(ctx, fctx, e),
        compileStringLit: (text, node) => compileStringLiteral(ctx, fctx, text, node as ts.Expression),
        toString: (t, tsType, hint) => emitToString(ctx, fctx, t, tsType as never, hint),
      });
      if (esc !== undefined) return esc;
    }

    // Number(x) — ToNumber coercion
    if (funcName === "Number" && expr.arguments.length >= 1) {
      // ToNumber(Symbol) must throw TypeError (§7.1.4). Symbols are lowered to
      // i32 ids, so a numeric pass-through would silently leak the id; detect
      // the symbol TS type and throw instead.
      if (ctx.oracle.staticJsTypeOf(expr.arguments[0]!) === "symbol") {
        const t = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (t !== null) fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
        return { kind: "f64" };
      }

      // §7.1.4.1 StringToNumber via the existing pure-Wasm `__str_to_number`
      // engine helper. Sole call site for this Number() block — both the
      // native-string-ref arm and the #2160 array arm below route through it, so
      // the #2108 coercion-drift gate sees no NEW hand-rolled coercion vocabulary
      // (a single helper lookup, as before). `alreadyExternref` is
      // true when the value on the stack is an externref (no convert needed);
      // false for a `$AnyString`/`$NativeString` ref (convert via
      // `extern.convert_any` first). Returns true when it emitted the call.
      const emitStrRefToNumber = (alreadyExternref: boolean): boolean => {
        const s2nIdx = ctx.funcMap.get("__str_to_number");
        if (s2nIdx === undefined) return false;
        if (!alreadyExternref) fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "call", funcIdx: s2nIdx });
        return true;
      };

      // #2160 — Number(arr) array→primitive coercion (§7.1.4 ToNumber →
      // §7.1.1.1 ToPrimitive(no hint) on an Array, whose OrdinaryToPrimitive
      // falls to `arr.toString()`, then §7.1.4.1 StringToNumber). Standalone
      // has no host `__unbox_number`, and the generic struct-ToPrimitive path
      // below has no array case, so `Number([5])` silently yielded NaN.
      //
      // Fix WITHOUT a new ad-hoc coercion site: reuse the SAME two existing,
      // already-sanctioned lowerings — `tryEmitArrayToStringNative` (the
      // String(arr) array→string half, PR #1640) to get the native-string ref,
      // then the shared `emitStrRefToNumber` above (the very `__str_to_number`
      // engine call the string-ref arm uses). Standalone / nativeStrings only;
      // host mode keeps `__unbox_number`.
      {
        const arg0 = expr.arguments[0]!;
        const arg0TsType = ctx.checker.getTypeAtLocation(arg0);
        // A bare `Number([])` literal infers `never[]` (element type `never`);
        // the native array-join path mishandles that exactly like the
        // pre-existing `String([])` / `[].toString()` bare-literal case (a
        // `never`-element join emits an externref-shaped value that fails
        // `(ref null $AnyString)` validation). Skip the native route when the
        // element type is absent OR `never` so we don't crash — `Number([])`
        // then falls through to the generic path (matching main's NaN behaviour,
        // not a regression). A typed empty array (`const a: number[] = []`) has a
        // concrete element type and lowers correctly (→ "" → 0).
        const elemType = arg0TsType.getNumberIndexType();
        const elemIsNever = elemType !== undefined && (elemType.flags & ts.TypeFlags.Never) !== 0;
        if (ctx.nativeStrings && elemType !== undefined && !elemIsNever && resolveArrayInfo(ctx, arg0TsType)) {
          const strRes = tryEmitArrayToStringNative(ctx, fctx, arg0, arg0TsType);
          // Only handle a genuine native-string ref result. (A null/undefined
          // strRes falls through to the generic path.)
          if (strRes !== undefined && strRes !== null) {
            const isExternref = strRes.kind === "externref";
            if (emitStrRefToNumber(isExternref)) return { kind: "f64" };
          }
        }
      }

      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      // Native-string ref (WasmGC AnyString/NativeString) → §7.1.4.1
      // StringToNumber. The generic ToNumber engine (coerceType "number") has no
      // string-struct case and silently yields 0 in standalone (#1688), so this
      // typeIdx-keyed string-ref pre-check stays in the caller and routes to the
      // pure-Wasm __str_to_number BEFORE the engine's generic object-ref arm.
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        const refTypeIdx = (argType as { typeIdx?: number }).typeIdx;
        if (
          ctx.nativeStrings &&
          refTypeIdx !== undefined &&
          (refTypeIdx === ctx.anyStrTypeIdx || refTypeIdx === ctx.nativeStrTypeIdx)
        ) {
          // Emitted upfront during the parseNeeded finalize (declarations.ts)
          // when `Number` is referenced under native strings, so no mid-body
          // function registration (which would shift func indices) happens here.
          // Single `__str_to_number` call site for this block; the ref needs
          // `extern.convert_any` first (alreadyExternref = false).
          if (emitStrRefToNumber(false)) return { kind: "f64" };
        }
      }
      // #1917 — the remaining ToNumber cascade (i64→f64, externref→__unbox_number
      // host / coerceType("number") standalone, object ref→coerceType("number"),
      // i32→f64, f64 no-op) is now the single coercion engine.
      return emitToNumber(ctx, fctx, argType);
    }

    // BigInt(x) — §21.2.1.1 constructor. (#1644 Slice A+B) The result is
    // brand-bigint so it boxes as a JS bigint at the externref frontier.
    //
    // - i32 / native-i64: already an integer Number representation, no
    //   RangeError possible — extend/identity directly (avoids a host call).
    // - f64: may be a non-safe-integer / NaN / ±Infinity → must throw
    //   RangeError (NumberToBigInt). Box to externref, then __bigint_ctor.
    // - string / object / boolean (externref): StringToBigInt (SyntaxError on
    //   malformed syntax), ToPrimitive on objects, boolean → 0n/1n →
    //   __bigint_ctor.
    if (funcName === "BigInt" && expr.arguments.length >= 1) {
      // Compile-time numeric literal: fold to an i64.const when it is a safe
      // integer (NumberToBigInt with no RangeError), avoiding a host call.
      // A negative literal parses as a unary-minus on a NumericLiteral.
      const litArg = expr.arguments[0]!;
      let litNum: number | undefined;
      if (ts.isNumericLiteral(litArg)) {
        litNum = Number(litArg.text);
      } else if (
        ts.isPrefixUnaryExpression(litArg) &&
        litArg.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(litArg.operand)
      ) {
        litNum = -Number(litArg.operand.text);
      }
      if (litNum !== undefined && Number.isSafeInteger(litNum)) {
        fctx.body.push({ op: "i64.const", value: BigInt(litNum) });
        return { kind: "i64", bigint: true };
      }
      if (ts.isStringLiteral(litArg) || ts.isNoSubstitutionTemplateLiteral(litArg)) {
        try {
          const litBig = BigInt(litArg.text);
          const minI64 = -(1n << 63n);
          const maxI64 = (1n << 63n) - 1n;
          if (litBig >= minI64 && litBig <= maxI64) {
            fctx.body.push({ op: "i64.const", value: litBig });
            return { kind: "i64", bigint: true };
          }
        } catch {
          // Keep malformed strings on the runtime path so JS-host mode throws
          // the native SyntaxError and no-JS-host mode uses its native throw.
        }
      }

      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
        return { kind: "i64", bigint: true };
      }
      // Already i64 — tag as bigint-branded (native integer, no RangeError).
      if (argType?.kind === "i64") {
        return { kind: "i64", bigint: true };
      }
      addUnionImports(ctx);
      // Coerce the argument to externref so the §21.2.1.1 host helper can run
      // ToPrimitive + NumberToBigInt / StringToBigInt with the correct
      // RangeError / SyntaxError / TypeError semantics.
      if (argType && argType.kind !== "externref") {
        coerceType(ctx, fctx, argType, { kind: "externref" }, "default");
      }
      if (!ctx.standalone && expectedType?.kind === "externref") {
        const ctorRefIdx = ctx.funcMap.get("__bigint_ctor_ref");
        if (ctorRefIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: ctorRefIdx });
          return { kind: "externref" };
        }
      }
      const ctorIdx = ctx.funcMap.get("__bigint_ctor");
      if (ctorIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: ctorIdx });
        return { kind: "i64", bigint: true };
      }
      return { kind: "i64", bigint: true };
    }

    // Number() with 0 args → 0
    if (funcName === "Number" && expr.arguments.length === 0) {
      fctx.body.push({
        op: ctx.fast ? "i32.const" : "f64.const",
        value: 0,
      });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }

    // Symbol() / Symbol('description') — create unique i32 symbol ID
    if (funcName === "Symbol") {
      return compileSymbolCall(ctx, fctx, expr.arguments);
    }

    // String(x) — ToString coercion
    if (funcName === "String") {
      // #1470: route every literal-string emission through compileStringLiteral
      // so native-strings / standalone (`--target standalone` / WASI) materializes
      // a NativeString GC struct inline. The old `addStringConstantGlobal` +
      // `global.get` path reaches a JS-host string-constant global that is never
      // registered in native-strings mode, so its index resolves to the -1
      // sentinel and the module fails validation ("Invalid global index:
      // 4294967295"). In JS-host mode compileStringLiteral keeps the existing
      // global.get behaviour, so this is a no-op there.
      if (expr.arguments.length === 0) {
        // String() with no args → ""
        return compileStringLiteral(ctx, fctx, "", expr) ?? { kind: "externref" };
      }

      // Check if argument is a null/undefined literal before compiling
      const strArg0 = expr.arguments[0]!;
      const strArg0IsNull = strArg0.kind === ts.SyntaxKind.NullKeyword;
      const strArg0IsUndefined =
        strArg0.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(strArg0) && strArg0.text === "undefined") ||
        ts.isVoidExpression(strArg0);

      if (strArg0IsNull) {
        // String(null) → "null"
        return compileStringLiteral(ctx, fctx, "null", strArg0) ?? { kind: "externref" };
      }

      if (strArg0IsUndefined) {
        // String(undefined) → "undefined"
        return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
      }

      // (#2163) String(symbol) is the ONE ToString form that does NOT throw on a
      // Symbol — §22.1.1.1 step 1 short-circuits to SymbolDescriptiveString
      // ("Symbol(" + (desc ?? "") + ")"). Implicit coercions (template literals,
      // `+`) still throw via tryThrowOnSymbolStringCoercion. In native-strings
      // mode build the descriptive string natively (zero host imports).
      if (ctx.nativeStrings && ctx.oracle.staticJsTypeOf(strArg0) === "symbol") {
        const recvType = compileExpression(ctx, fctx, strArg0, { kind: "i32" });
        if (recvType && recvType.kind !== "i32") {
          coerceType(ctx, fctx, recvType, { kind: "i32" });
        }
        emitSymbolToString(ctx, fctx);
        return nativeStringType(ctx);
      }
      // (#3085) Host-mode counterpart: box the symbol id and route through the
      // host SymbolDescriptiveString. Without this `String(sym)` falls through to
      // the i32→number path and stringifies the raw symbol id (e.g. "101").
      if (!ctx.nativeStrings && ctx.oracle.staticJsTypeOf(strArg0) === "symbol") {
        const symToStrIdx = ensureLateImport(
          ctx,
          "__symbol_to_string",
          [{ kind: "externref" }],
          [{ kind: "externref" }],
        );
        if (symToStrIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, strArg0, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") {
            coerceType(ctx, fctx, recvType, { kind: "externref" });
          }
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: symToStrIdx });
          return { kind: "externref" };
        }
      }

      // #2160 — String(arr) in standalone: route an array argument through its
      // native Array.prototype.toString (§23.1.3.36) instead of the generic
      // ref→string coercion, which null-derefs on WasmGC array structs in
      // native-strings mode. Must run BEFORE compileExpression so the
      // array-join lowering compiles the receiver itself. Additive: falls
      // through unchanged when the arg is not a resolvable array.
      {
        const strArg0TsType = ctx.checker.getTypeAtLocation(strArg0);
        const arrToStr = tryEmitArrayToStringNative(ctx, fctx, strArg0, strArg0TsType);
        if (arrToStr !== undefined) return arrToStr;
      }

      // #2161 — String(re) in standalone: a static / backend-created RegExp
      // argument routes through its native RegExp.prototype.toString
      // (§22.2.6.14 → "/" + source + "/" + flags) instead of the generic
      // ref→string coercion, which null-derefs on the $NativeRegExp struct in
      // native-strings mode (re.toString() already works; the String() builtin
      // lowering did not detect it). Must run BEFORE compileExpression so the
      // RegExp receiver is compiled by the toString core. Additive: returns
      // undefined (falls through) for any non-static / dynamic RegExp.
      {
        const reToStr = emitStandaloneRegExpToStringFromExpr(ctx, fctx, strArg0);
        if (reToStr !== undefined && reToStr !== null) return reToStr;
      }

      const argType = compileExpression(ctx, fctx, strArg0);

      if (argType === null) {
        // String(void-expr) → "undefined"
        return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
      }

      if (argType?.kind === "i32") {
        // (#4414) `|| .boolean` — a devirtualized call is `any` statically but returns a BRANDED boolean i32
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isBooleanType(argTsType) || argType.boolean === true) {
          return emitBoolToString(ctx, fctx);
        }
        // number (i32) → string via f64 conversion
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return emitStringBuiltinNumberResult(ctx, fctx);
        }
      }

      if (argType?.kind === "f64") {
        // number → string
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return emitStringBuiltinNumberResult(ctx, fctx);
        }
      }

      if (argType?.kind === "externref") {
        // Check TS type to determine what this externref actually is
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (argTsType.flags & ts.TypeFlags.Null) {
          // Drop the ref.null.extern, push "null" constant (#1470: native-aware)
          fctx.body.push({ op: "drop" });
          return compileStringLiteral(ctx, fctx, "null", strArg0) ?? { kind: "externref" };
        }
        if (argTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          fctx.body.push({ op: "drop" });
          return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
        }
        if (isStringType(argTsType)) {
          // Already a string — (#4174) flatten once at this materialization point.
          emitStringExternResultFlatten(ctx, fctx);
          return { kind: "externref" };
        }
        // Other externref — coerce via __extern_toString, which routes
        // through the runtime's `_toPrimitive` walker (valueOf/toString
        // per §7.1.1.1 with hint "string"). Pre-#1525 this looked up
        // "extern_toString" — missing the leading underscores that the
        // runtime actually exposes — so the call was silently dropped
        // and `String(obj)` returned the unchanged externref. The
        // explicit hint also keeps the dispatch table in
        // `__extern_method_call` honest for wasmGC structs that V8
        // can't introspect natively.
        const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          // (#4174) `__extern_toString`'s string arm is identity — a rope comes
          // back unchanged; flatten it here (acorn's `this.input = String(input)`).
          emitStringExternResultFlatten(ctx, fctx);
        }
        return { kind: "externref" };
      }

      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        // Check if it's a native string type
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isStringType(argTsType)) {
          // Already a native string — (#4174) flatten a possible `$AnyString`
          // rope once here; ValType preserved exactly, identity if inapplicable.
          return emitStringRefResultFlatten(ctx, fctx, argType) ?? argType;
        }
        // Native/standalone object ToString needs a real `$AnyString` result.
        // The coercion engine dispatches a statically-known toString/valueOf
        // method in Wasm and normalizes every primitive result, including a
        // void-returning method's legitimate `undefined`.
        if (ctx.nativeStrings) {
          return emitToString(ctx, fctx, argType, argTsType, "string");
        }
        // Object ref → coerce via @@toPrimitive("string") or toString(), else "[object Object]"
        coerceType(ctx, fctx, argType, { kind: "externref" }, "string");
        return { kind: "externref" };
      }

      return argType ?? { kind: "externref" };
    }

    // Boolean(x) — ToBoolean coercion → returns i32 (0 or 1)
    if (funcName === "Boolean") {
      if (expr.arguments.length === 0) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      // void / undefined → always false
      if (argType === null) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      if (argType?.kind === "f64") {
        // f64: truthy if != 0 and != NaN
        const tmp = allocLocal(fctx, `__bool_${fctx.locals.length}`, {
          kind: "f64",
        });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.eq" }); // NaN check: x == x
        fctx.body.push({ op: "i32.and" });
        return { kind: "i32" };
      }
      if (argType?.kind === "i32") {
        // i32: truthy if != 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" });
        return { kind: "i32" };
      }
      if (argType?.kind === "i64") {
        // BigInt (§7.1.2 ToBoolean): 0n → false, any other BigInt → true.
        // i64.eqz yields 1 for 0n; invert with i32.eqz so nonzero → 1.
        // Must NOT route through f64.convert_i64_s — that loses precision
        // for |x| > 2^53 and would misreport large BigInts.
        fctx.body.push({ op: "i64.eqz" });
        fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // String: truthy if length > 0
      if (
        (argType?.kind === "ref" || argType?.kind === "ref_null") &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        isStringType(ctx.checker.getTypeAtLocation(expr.arguments[0]!))
      ) {
        // Get length (field 0 of $AnyString) and check != 0
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.anyStrTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" });
        return { kind: "i32" };
      }
      if (argType?.kind === "externref") {
        // Check if this is a primitive string type — use string length > 0 for truthiness.
        // (#1343) Restrict to PRIMITIVE strings only; `new String("")` is a wrapper
        // object (always truthy, even when empty per spec) and would be incorrectly
        // reported as falsy by a length check. Same caveat for any other JS wrapper.
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        const isPrimString =
          (argTsType.flags & ts.TypeFlags.String) !== 0 || (argTsType.flags & ts.TypeFlags.StringLiteral) !== 0;
        if (isPrimString) {
          addStringImports(ctx);
          const lenIdx = ctx.jsStringImports.get("length");
          if (lenIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: lenIdx });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.ne" });
            return { kind: "i32" };
          }
        }
        // (#1343) Use the host `__to_boolean` helper for full ECMA-262
        // §7.1.2 semantics. Previously we only checked `ref.is_null`,
        // which returned 1 for JS `undefined` (defined externref, not
        // a null reference) and broke `Boolean(undefined) === false` plus
        // every other ToBoolean edge case (NaN, +/-0, "", 0n, wrapper
        // objects which must always be truthy).
        // (#2915) In standalone mode use the NATIVE `__is_truthy` union helper
        // instead — it applies the identical ES §7.1.2 lowering over the boxed
        // value structs (number/boolean/bigint/string, wrapper objects → truthy,
        // null → false) but has a real Wasm body, so `Boolean(x)` no longer
        // leaks the bodyless `env::__to_boolean` host import. Gated on
        // `ctx.standalone` so the GC/host lane stays byte-identical.
        const useNativeTruthy = ctx.standalone;
        if (useNativeTruthy) addUnionImports(ctx);
        const toBoolIdx = ensureLateImport(
          ctx,
          useNativeTruthy ? "__is_truthy" : "__to_boolean",
          [{ kind: "externref" }],
          [{ kind: "i32" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (toBoolIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toBoolIdx });
          return { kind: "i32" };
        }
        // Fallback: the legacy null-only check (preserves prior behaviour
        // when the host import couldn't be registered).
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.xor" });
        return { kind: "i32" };
      }
      // Ref types (objects, arrays): always truthy — drop the ref, push 1
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      // fallback: treat as truthy (non-null ref)
      return { kind: "i32" };
    }

    // Array(n) — create array of length n, or Array(a,b,c) → [a,b,c]
    // Treat Array() the same as new Array() — they have identical semantics in JS.
    if (funcName === "Array") {
      return compileArrayConstructorCall(ctx, fctx, expr);
    }
  }

  // Regular function call
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    // Linked runtime eval can replace a script function binding with an
    // interpreted closure. Such a binding must call its live externref global
    // through the generic apply bridge; a direct call to the declaration's
    // immutable funcIdx would ignore the replacement entirely.
    // (#4182/#2552) Annex B block-fn bindings are live the same way: the value
    // a call must invoke is whatever declaration most recently evaluated. At
    // module scope that value lives in a global; inside a function it lives in
    // the flag-gated outer-binding local. A direct funcMap call would instead
    // pin whichever declaration happened to compile last, even when its branch
    // did not execute. Locally-shadowed names keep their local resolution.
    if (hasLiveFunctionBinding(ctx, fctx, funcName)) {
      const liveCall = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
      if (liveCall !== null) return liveCall;
    }

    // (#1301) Param/local that shadows an outer function with nested captures:
    // the funcMap path emits a direct call AND prepends the outer's nested
    // captures using `cap.outerLocalIdx` indices. Inside a lifted closure
    // body those indices map to unrelated locals in the lifted fctx, which
    // produces struct.new validation errors:
    //   "struct.new[0] expected type f64, found local.get of type anyref".
    //
    // Narrow trigger: only redirect when ALL of:
    //   1. The current fctx has a local/param with this name (real shadow)
    //   2. The funcMap entry has nestedFuncCaptures (the broken path)
    //   3. The local has a callable TS type, OR the checker resolves the
    //      called identifier to a parameter. The latter covers shipped JS
    //      without declarations/JSDoc: call syntax proves the value is being
    //      invoked, while its `any` type has no call signatures.
    //
    // Other shadow cases stay on the funcMap path — direct calls that don't
    // emit cap-prepend logic are already correct, even if a coincidental
    // local with the same name exists in the current scope.
    // (#4133/#4134) The same hazard, one scope out: `funcMap` is keyed by BARE
    // name, so a NESTED function declaration's binding is visible to every
    // later module. When an unrelated module calls its own `equal` — an import,
    // a `require`d function value, its own top-level function — the funcMap
    // path retargets it to that nested function AND prepends the nested
    // function's captures, read from the declaring frame. On the ESLint graph
    // that is how `assertASTDidntChange` (eslint's rule-tester, calling
    // fast-deep-equal's `equal`) ended up carrying uri-js's UMD factory locals
    // and emitting `local.get 51` into a 4-slot frame.
    //
    // A nested declaration is only in scope inside its enclosing body, so skip
    // the funcMap path when the call site is not lexically inside it. Names
    // owned by top-level declarations, imports and synthesized helpers have no
    // owner record and are unaffected.
    const nestedOwnerDecl = ctx.funcMapOwnerDecl.get(funcName);
    let isOutOfScopeNestedBinding = false;
    if (nestedOwnerDecl !== undefined) {
      // The scope is the owner's enclosing FUNCTION, not its immediate parent.
      // A declaration inside a nested block is hoisted to function scope
      // (Annex B §B.3.3), so it is callable from anywhere in the enclosing
      // function — including before and outside that block. Using the parent
      // block here made `function hoisted from inside if-block` unresolvable
      // (#165) and broke lodash's `_createWrap` (#1303/#1305).
      let ownerScope: ts.Node = nestedOwnerDecl.parent;
      while (
        !ts.isSourceFile(ownerScope) &&
        !ts.isFunctionDeclaration(ownerScope) &&
        !ts.isFunctionExpression(ownerScope) &&
        !ts.isArrowFunction(ownerScope) &&
        !ts.isMethodDeclaration(ownerScope) &&
        !ts.isConstructorDeclaration(ownerScope) &&
        !ts.isGetAccessorDeclaration(ownerScope) &&
        !ts.isSetAccessorDeclaration(ownerScope)
      ) {
        if (!ownerScope.parent) break;
        ownerScope = ownerScope.parent;
      }
      let visible = false;
      for (let n: ts.Node | undefined = expr; n !== undefined; n = n.parent) {
        if (n === ownerScope) {
          visible = true;
          break;
        }
      }
      isOutOfScopeNestedBinding = !visible;
    }

    const isLocallyShadowed = localBindingShadowsCapturingFunction(ctx, fctx, expr.expression);

    // (#4133/#4134) `ctx.closureMap` is a THIRD bare-name namespace and it is
    // consulted BEFORE `funcMap`. A visible nested declaration lexically
    // shadows any outer closure or function-valued variable of the same name,
    // so it must win here too — otherwise a nested `function equal()` calling
    // itself from a sibling reached another module's `const equal = function
    // equal(...)` instead, and the enclosing function silently returned 0.
    // (#4133/#4134) `ctx.closureMap` is a THIRD bare-name namespace, consulted
    // BEFORE `funcMap`. A visible nested declaration lexically shadows any
    // outer closure or function-valued variable of the same name, so it must
    // win here too — otherwise a nested `function equal()` called from a
    // sibling reached another module's `const equal = function equal(...)` and
    // the enclosing function silently returned 0.
    const nestedBindingVisible = nestedOwnerDecl !== undefined && !isOutOfScopeNestedBinding;
    const hasVisibleClosureStorage =
      fctx.localMap.has(funcName) || ctx.moduleGlobals.has(funcName) || ctx.capturedGlobals.has(funcName);
    // `closureMap` is keyed by a bare identifier across the complete linked
    // source graph. A local arrow in an importer can therefore reuse the name
    // of a dependency's function and overwrite this metadata even though its
    // value slot is not visible in the dependency. Prefer the real direct
    // function binding whenever there is no lexical/module storage from which
    // this closure could actually be loaded. uuid exposed this as its local
    // test callback `rng` replacing the imported package `rng()` inside v1.
    // (#3571 / #4394) Exact-shape uncurried-builtin aliases (propertyHelper's
    // `__push`/`__join` = `Function.prototype.call.bind(Builtin.prototype.m)`)
    // must be claimed BEFORE any stored-carrier dispatch: #4395's native-first
    // bind provider otherwise routes the `$__bound_fn` through the stored
    // `Function.prototype.call` VALUE, whose standalone body is the #2984
    // degrade throw. The resolver only matches the immutable harness idiom.
    if (!isLocallyShadowed && (ctx.standalone || noJsHost(ctx))) {
      // Deno's `uncurryThis = bind.bind(call)` has the exact native spelling
      // `call.bind(...args)`. Construct that bound-function carrier directly;
      // invoking the generic Function.prototype.bind method-value body would
      // otherwise refuse dynamically discovered builtin method closures.
      const callValue = resolveUncurryThisAlias(ctx.oracle, expr.expression);
      if (callValue) {
        const bindAccess = ts.factory.createPropertyAccessExpression(callValue, "bind");
        ts.setTextRange(bindAccess, expr.expression);
        const bindCall = ts.factory.createCallExpression(bindAccess, undefined, expr.arguments);
        ts.setTextRange(bindCall, expr);
        (bindAccess as { parent: ts.Node }).parent = bindCall;
        (bindCall as { parent: ts.Node }).parent = expr.parent;
        const compiledUncurryThis = compileCallExpression(ctx, fctx, bindCall);
        if (compiledUncurryThis !== null) return compiledUncurryThis;
      }
      // Deno's `applyBind = bind.bind(apply)` is a bound invocation of the
      // Function.prototype.bind METHOD VALUE. The generic method-value body is
      // intentionally a catchable refusal, but the immutable alias has an
      // exact equivalent native spelling: `apply.bind(...args)`. Compile that
      // spelling so the result is the ordinary `$__bound_fn` carrier.
      const applyValue = resolveApplyBindAlias(ctx.oracle, expr.expression);
      if (applyValue) {
        const bindAccess = ts.factory.createPropertyAccessExpression(applyValue, "bind");
        ts.setTextRange(bindAccess, expr.expression);
        const bindCall = ts.factory.createCallExpression(bindAccess, undefined, expr.arguments);
        ts.setTextRange(bindCall, expr);
        (bindAccess as { parent: ts.Node }).parent = bindCall;
        (bindCall as { parent: ts.Node }).parent = expr.parent;
        const compiledApplyBind = compileCallExpression(ctx, fctx, bindCall);
        if (compiledApplyBind !== null) return compiledApplyBind;
      }
      const uncurriedCall = tryCompileStoredObjectBuiltinCall(ctx, fctx, expr);
      if (uncurriedCall !== undefined) return uncurriedCall;
    }

    let closureInfo =
      isLocallyShadowed || nestedBindingVisible || (!hasVisibleClosureStorage && ctx.funcMap.has(funcName))
        ? undefined
        : ctx.closureMap.get(funcName);

    if (!closureInfo && !nestedBindingVisible) {
      closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
    }
    // (#4133) An out-of-scope nested binding lets the closure/local paths above
    // run FIRST — that is how the correctly-scoped callee is found (eslint's
    // rule-tester reaching fast-deep-equal's `equal` rather than uri-js's
    // factory-nested one). But if neither resolves it, fall through to the
    // historical `funcMap` path rather than suppressing it.
    //
    // Suppressing unconditionally is what the first cut did, and it is unsound
    // in the other direction: with nothing left to resolve, the call reaches
    // the graceful `ref.null.extern` fallback below, so a call that used to
    // reach SOME function now yields null and the next use traps. The
    // merge_group caught exactly that — `null_deref` 156 -> 1357 across the
    // Temporal suite. Reaching the wrong same-named function is a wrong answer;
    // turning a resolvable call into an uncatchable trap is worse, and neither
    // is a licence for the other, so this only ever PREFERS a better binding.
    if (closureInfo) {
      return compileClosureCall(ctx, fctx, expr, funcName, closureInfo);
    }

    // #1177: funcIdx must be re-fetched from funcMap whenever a late-import
    // shift may have run. Late imports added during argument/cap compilation
    // (e.g. emitLocalTdzCheck → ensureLateImport(__throw_reference_error))
    // shift `ctx.numImportFuncs` and update `ctx.funcMap` entries, but a
    // local `const funcIdx` would hold the pre-shift value.
    // (#1301) Skip funcMap when locally shadowed; the local-callable fallback
    // below handles dispatch via call_ref through the param/local.
    let funcIdx = isLocallyShadowed ? undefined : ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      // Before giving up, check if this identifier is a local/param with callable TS type
      // (e.g. function parameter `fn: (x: number) => number` stored as externref).
      // If so, create or find a matching closure wrapper type and dispatch via call_ref.
      // Only attempt this for actual locals/params — not for unknown imported functions.
      const calleeLocalIdx = fctx.localMap.get(funcName);
      const calleeModGlobal = calleeLocalIdx === undefined ? ctx.moduleGlobals.get(funcName) : undefined;
      const calleeCapturedGlobal =
        calleeLocalIdx === undefined && calleeModGlobal === undefined ? ctx.capturedGlobals.get(funcName) : undefined;
      const isKnownVariable =
        calleeLocalIdx !== undefined || calleeModGlobal !== undefined || calleeCapturedGlobal !== undefined;
      const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
      let callSigs = isKnownVariable ? calleeTsType.getCallSignatures?.() : undefined;
      if (isKnownVariable && (!callSigs || callSigs.length === 0)) {
        // (#1298) `Fn | null | undefined` callees: strip nullable members
        // before reading call signatures. Storage is externref either way.
        const nonNull = ctx.checker.getNonNullableType(calleeTsType);
        callSigs = nonNull.getCallSignatures?.();
      }
      // A bound result is always an externref carrier, but the carrier owner is
      // provider-specific. Native-first/standalone dispatch `$__bound_fn`
      // through the Wasm closure bridge; compatibility invokes the real JS
      // bound-function exotic. If the native carrier targets a caller-owned JS
      // function, the dynamic dispatch's miss uses the admitted callback
      // boundary rather than a semantic host fallback.
      if (isKnownVariable && calleeIsBoundFunctionVar(ctx.oracle, expr.expression)) {
        if (usesNativeFunctionBindProvider(ctx)) {
          const nativeCall = tryEmitInlineDynamicCall(
            ctx,
            fctx,
            expr,
            true,
            !boundFunctionTargetIsDefinitelyCompiled(ctx.oracle, expr.expression),
          );
          if (nativeCall !== null) return nativeCall;
        } else {
          const hostCall = emitBoundFunctionCall(ctx, fctx, expr);
          if (hostCall !== null) return hostCall;
        }
      }
      const storedCarrierCall = tryCompileStoredStandaloneCarrierCall(ctx, fctx, expr, isKnownVariable);
      if (storedCarrierCall !== undefined) return storedCarrierCall;
      if (prepareStandaloneEvalAliasCall(ctx, fctx, expr.expression, isKnownVariable)) {
        const evalAliasCall = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
        if (evalAliasCall !== null) return evalAliasCall;
      }
      // Provider-owned `%Function%` aliases need generic externref dispatch;
      // the live binding and arguments are still evaluated exactly once.
      if (
        isKnownVariable &&
        ctx.standalone &&
        ctx.runtimeEvalCallableBoundaryEnabled === true &&
        resolvesToGlobalFunctionAlias(expr.expression, ctx.oracle)
      ) {
        const runtimeFunctionCall = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
        if (runtimeFunctionCall !== null) {
          // `%Function%` always returns a callable. Give that provider marker
          // the same caller-owned property/call trampoline as direct
          // `Function(...)`, so reflective Function metadata remains visible.
          return emitRuntimeEvalInterpretedCallableAdapter(ctx, fctx);
        }
      }
      // (#1528/#56) Promise-combinator executor params are host functions, so
      // their narrow capability-constructor lane also routes via Reflect.apply.
      if (isKnownVariable && !ctx.standalone && !noJsHost(ctx) && calleeIsCapabilityCtorParam(ctx, expr.expression)) {
        const hostCall = emitBoundFunctionCall(ctx, fctx, expr);
        if (hostCall !== null) return hostCall;
      }
      if (callSigs && callSigs.length > 0) {
        // Populate runtime callback candidates before compiling this HOF body.
        // Without the pre-scan, Test262's one-formal function expression is
        // compiled only after its two-formal JSDoc callback consumer, leaving
        // the shorter (but JS-compatible) funcref signature out of the dispatch.
        ensureFuncValueWrappersRegistered(ctx, expr.getSourceFile());
        const sig = callSigs[0]!;
        const builtinAlias =
          ctx.standalone || ctx.wasi ? resolveBuiltinStaticBindingAlias(ctx, expr.expression) : undefined;
        const builtinAliasClosure = builtinAlias
          ? ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinAlias.builtinName, builtinAlias.propName)
          : null;
        const builtinAliasInfo = builtinAliasClosure
          ? ctx.closureInfoByTypeIdx.get(builtinAliasClosure.type.typeIdx)
          : undefined;
        // (#4491) `runtimeSignatureParameters` drops the `(...args: any[])` the
        // checker SYNTHESIZES for a JS function that reads `arguments`
        // (`function __GUNC(){ return arguments[0]; }`). That symbol has no
        // formal slot in the compiled callee — the real values travel through
        // `__argc`/`__extras_argv` — so treating it as a formal both coerces
        // actual argument 0 to the rest ARRAY type (a string is not a vec, so
        // the guarded cast NULLS it) and reports `__argc = 1`. `arguments.length`
        // stayed right while `arguments[0]` read back `null` (S13.2_A2_T1).
        const runtimeSigParams = runtimeSignatureParameters(sig);
        const sigParamCount = builtinAliasInfo?.paramTypes.length ?? runtimeSigParams.length;
        const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
        const sigRetWasm =
          builtinAliasInfo?.returnType ?? (isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType));
        const sigParamWasmTypes: ValType[] = builtinAliasInfo ? [...builtinAliasInfo.paramTypes] : [];
        for (let i = 0; !builtinAliasInfo && i < sigParamCount; i++) {
          // (#820d) Destructuring-pattern parameters (e.g. `method({ x = 5 } = {})`)
          // are compiled by the callee as a single `externref` slot — the binding
          // pattern is destructured inside the body from that externref, and the
          // param-default check uses `__extern_is_undefined`. Resolving the TS
          // type of such a param to a concrete struct ref (which `resolveWasmType`
          // does once the anonymous object type gets a registered struct) produces
          // a funcref wrapper type that mismatches the actual method/trampoline
          // signature. The closure call then casts the trampoline funcref to the
          // wrong (struct-param) type and traps with `illegal cast` — and for an
          // unresolvable default the spec-correct ReferenceError never gets a
          // chance to throw. Force `externref` for binding-pattern params so the
          // call site agrees with the compiled callee.
          const paramDecl = sig.parameters[i]!.valueDeclaration;
          // (#4038) `ParameterDeclaration.name` is typed as non-optional, but it
          // is genuinely ABSENT for a parameter declared through JSDoc
          // function-type syntax — `@param {function(string): void} cb` models
          // its own parameters as nameless `ParameterDeclaration` nodes. Passing
          // that `undefined` into `ts.isObjectBindingPattern` threw
          // `Cannot read properties of undefined (reading 'kind')`, which the
          // speculative wrapper reported as an opaque "Internal error compiling
          // expression" and which blocked the ESLint graph.
          //
          // Treating a nameless parameter as "not a binding pattern" is correct
          // on the merits, not a defensive shrug: a binding pattern IS a name
          // node (`{a}` / `[a]`), so a parameter without one cannot be one. It
          // then takes the ordinary `resolveWasmType` path every other named
          // non-pattern parameter takes.
          const paramName =
            paramDecl && ts.isParameter(paramDecl) ? (paramDecl.name as ts.BindingName | undefined) : undefined;
          if (paramName && (ts.isObjectBindingPattern(paramName) || ts.isArrayBindingPattern(paramName))) {
            sigParamWasmTypes.push({ kind: "externref" });
            continue;
          }
          const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
          sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
        }

        // Eagerly create the closure wrapper types for this signature so the
        // lookup succeeds even when no actual closure with this signature has
        // been compiled yet (compilation order issue).
        // All callers must wrap their closures into this wrapper type before
        // passing them (see coercion in compileExpression and compileAssignment).
        const resultTypes = sigRetWasm ? [sigRetWasm] : [];
        const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);

        if (wrapperTypes) {
          const matchedClosureInfo = wrapperTypes.closureInfo;
          // (#2174) When the callee's signature returns `Promise<T>`,
          // `resolveWasmType` strips the Promise wrapper and yields the awaited
          // value's wasm type (e.g. f64 for `() => Promise<number>`). But an
          // *internal* call to an async closure leaves the **Promise object**
          // (externref) on the stack — the async closure's real funcref type
          // returns externref, which is registered as a separate dispatch
          // candidate below (`tryAltFuncType([externref])`). If the dispatch
          // block were typed `(result f64)`, the async candidate's `call_ref`
          // (externref) would mismatch the block result → invalid Wasm
          // (`__closure_N fallthru expected f64/i32, got externref`). Worse, a
          // type-only externref→f64 coercion would unbox the Promise to NaN and
          // corrupt the value. So when the callee is async, widen the dispatch
          // result to externref: the Promise flows through intact and the
          // surrounding `wrapAsyncReturn` (expressions.ts) consumes it as the
          // call expression's value. Surfaced by the test262 cluster
          // `async-function/returns-async-function-returns-arguments-*`.
          const calleeIsAsync = isPromiseType(sigRetType);
          const expectedReturn: ValType | null = calleeIsAsync ? { kind: "externref" } : matchedClosureInfo.returnType; // null for void

          // (#1131) Preemptively create alternative closure wrapper types.
          // TypeScript allows covariant return types in callbacks, e.g.
          // () => string is assignable to () => void. The actual closure may
          // use a different funcref type than the declared signature expects.
          // V8's isorecursive canonicalization merges struct types with the same
          // layout, so struct-level casts succeed. But funcref types remain
          // distinct per return type — we must dispatch on funcref type.
          // Create common return-type variants now so closures compiled later
          // reuse the same funcref types and the dispatch chain finds them.
          type FuncCandidate = {
            funcTypeIdx: number;
            structTypeIdx: number;
            returnType: ValType | null;
            paramTypes: ValType[];
          };
          const funcCandidates: FuncCandidate[] = [
            {
              funcTypeIdx: matchedClosureInfo.funcTypeIdx,
              structTypeIdx: matchedClosureInfo.structTypeIdx,
              returnType: matchedClosureInfo.returnType,
              paramTypes: matchedClosureInfo.paramTypes,
            },
          ];
          const seenFuncTypeIdx = new Set<number>([matchedClosureInfo.funcTypeIdx]);

          const tryAltFuncType = (retTypes: ValType[]) => {
            const alt = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, retTypes);
            if (alt && !seenFuncTypeIdx.has(alt.closureInfo.funcTypeIdx)) {
              seenFuncTypeIdx.add(alt.closureInfo.funcTypeIdx);
              funcCandidates.push({
                funcTypeIdx: alt.closureInfo.funcTypeIdx,
                structTypeIdx: alt.closureInfo.structTypeIdx,
                returnType: alt.closureInfo.returnType,
                paramTypes: alt.closureInfo.paramTypes,
              });
            }
          };
          // Create externref-return variant if not already expected
          if (!expectedReturn || expectedReturn.kind !== "externref") {
            tryAltFuncType([{ kind: "externref" }]);
          }
          // Create void-return variant if not already expected
          if (expectedReturn !== null) {
            tryAltFuncType([]);
          }
          // Also scan closureInfoByTypeIdx for other matching-arity func types
          for (const [, info] of ctx.closureInfoByTypeIdx) {
            // JS ignores surplus call-site arguments. A JSDoc callback typedef
            // can declare two parameters while the actual function expression
            // declares one (Test262's typed-array harness does exactly this),
            // so retain shorter runtime signatures and marshal only their
            // formal prefix in the dispatch arm below.
            if (info.paramTypes.length > sigParamCount) continue;
            if (seenFuncTypeIdx.has(info.funcTypeIdx)) continue;
            let paramsMatch = true;
            for (let pi = 0; pi < info.paramTypes.length; pi++) {
              if (!valTypesMatch(info.paramTypes[pi]!, sigParamWasmTypes[pi]!)) {
                paramsMatch = false;
                break;
              }
            }
            if (paramsMatch) {
              seenFuncTypeIdx.add(info.funcTypeIdx);
              funcCandidates.push({
                funcTypeIdx: info.funcTypeIdx,
                structTypeIdx: info.structTypeIdx,
                returnType: info.returnType,
                paramTypes: info.paramTypes,
              });
            }
          }

          // Compile the callee to get the value on the stack
          const innerResultType = compileExpression(ctx, fctx, expr.expression);

          // Save closure ref to a local
          let closureLocal: number;
          let rawCalleeLocal: number | undefined;
          // (#2873 park fix) Struct type the externref callee is cast to. A
          // declared-signature allocation wrapper only accepts
          // values whose ACTUAL signature wrapper is the same type — but the
          // wrapper family is a star of distinct children under the FIRST,
          // permanently-open wrapper root, so a value allocated under a different signature's
          // wrapper (an activated ASYNC closure whose result was rewritten to
          // externref/Promise while the param says `() => void`; a covariant
          // sync closure like `() => string` passed as `() => void`) nulls the
          // guarded cast and the funcref fetch below traps "dereferencing a
          // null pointer" (the 32-file asyncTest() merge_group cluster on PR
          // #2873 — creation ORDER decided which modules survived). Cast/read
          // and pass self through the wrapper ROOT — the guaranteed supertype
          // of every wrapper. The per-candidate funcref `ref.test`/cast encodes
          // the exact signature; narrowing the struct after that would still
          // be wrong across modules because their same-signature allocation
          // wrappers can occupy different places in the local hierarchy.
          const closureCastStructIdx = wrapperTypes.liftedSelfTypeIdx;
          if (innerResultType?.kind === "externref") {
            const closureRefType: ValType = {
              kind: "ref_null",
              typeIdx: closureCastStructIdx,
            };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            // (#1712) Keep the raw externref callee around for the host-callable
            // fallback below. When the guarded struct cast nulls out (the callee
            // is a host builtin like `Object.hasOwn`, a bound function, or a
            // closure of a foreign struct shape), the call must dispatch through
            // `__call_function` instead of trapping on `struct.get` of null.
            rawCalleeLocal = allocLocal(fctx, `__callable_raw_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.tee", index: rawCalleeLocal });
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, closureCastStructIdx);
            fctx.body.push({ op: "local.set", index: closureLocal });
          } else {
            const closureRefType: ValType = {
              kind: innerResultType?.kind === "ref_null" ? "ref_null" : "ref",
              typeIdx: closureCastStructIdx,
            };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            fctx.body.push({ op: "local.set", index: closureLocal });
          }

          // Compile call arguments with type coercion (only up to declared param count)
          // Save them to locals so they can be re-pushed in each dispatch branch.
          const argLocals: number[] = [];
          // Keep an externref view of every real call-site argument. A linked
          // value can have a declaration signature that differs from the
          // closure body selected at runtime (Moment's declaration accepts
          // arguments while its exported `hooks` body declares none and reads
          // `arguments`). Per-candidate dispatch below needs the complete
          // values in order to classify that candidate's overflow arguments.
          const actualArgExternLocals: number[] = [];
          const cpParamCnt = matchedClosureInfo.paramTypes.length;
          // (#1511) Save overflow args to externref locals so we can pack them
          // into __extras_argv right before the call (whichever dispatch arm
          // wins). The lifted callee may read `arguments` and needs the full
          // call-site arg list.
          const cpExtrasLocals: number[] = [];
          // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
          {
            for (let i = 0; i < Math.min(expr.arguments.length, cpParamCnt); i++) {
              compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
              const argLocal = allocLocal(fctx, `__carg_${fctx.locals.length}`, matchedClosureInfo.paramTypes[i]!);
              fctx.body.push({ op: "local.set", index: argLocal });
              argLocals.push(argLocal);
              saveArgumentLocalAsExtern(ctx, fctx, argLocal, matchedClosureInfo.paramTypes[i]!, actualArgExternLocals);
            }
            for (let i = cpParamCnt; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
              if (extraType === null) {
                fctx.body.push({ op: "ref.null.extern" });
              } else if (extraType.kind === "f64") {
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (extraType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (extraType.kind === "ref" || extraType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              const extraLocal = allocLocal(fctx, `__cextra_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: extraLocal });
              cpExtrasLocals.push(extraLocal);
              actualArgExternLocals.push(extraLocal);
            }
          }

          // Pad missing arguments with defaults and save to locals.
          // For non-nullable ref params, widen the padding slot to nullable so
          // pushDefaultValue emits a plain ref.null (without ref.as_non_null,
          // which would trap at runtime). The callee wrapper signature accepts
          // nullable refs, so this is assignment-compatible. (#1131)
          for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
            const paramType = matchedClosureInfo.paramTypes[i]!;
            const padType: ValType =
              paramType.kind === "ref" ? { kind: "ref_null", typeIdx: paramType.typeIdx } : paramType;
            pushDefaultValue(fctx, padType, ctx);
            const argLocal = allocLocal(fctx, `__carg_${fctx.locals.length}`, padType);
            fctx.body.push({ op: "local.set", index: argLocal });
            argLocals.push(argLocal);
          }

          // (#1712/#2928) Foreign-callable fallback: when the callee arrived as externref
          // and the guarded cast to the wrapper struct failed (closureLocal is
          // null) while the raw value is non-null, the callee is callable but
          // not a closure of the matched shape — a host builtin held in a JS
          // variable (acorn's `var hasOwn = Object.hasOwn || function(…){…}`),
          // a bound function, a closure with a foreign struct layout, or the
          // standalone runtime-eval callback marker (`var alias = eval`). The
          // struct.get below would trap "dereferencing a null pointer". Host
          // mode routes through `__call_function`; standalone/WASI routes
          // through the native `__apply_closure` classifier, which owns the
          // structurally canonical runtime-eval callback arm.
          // Eligibility excludes i64/v128-typed params/returns (no boxing rule).
          const boxableKind = (t: ValType | null): boolean =>
            t === null ||
            t.kind === "externref" ||
            t.kind === "f64" ||
            t.kind === "i32" ||
            t.kind === "ref" ||
            t.kind === "ref_null";
          const hostCallFallback =
            rawCalleeLocal !== undefined &&
            !ctx.standalone &&
            !ctx.wasi &&
            boxableKind(expectedReturn) &&
            matchedClosureInfo.paramTypes.every((t) => boxableKind(t)) &&
            // (#1941) Only emit the host-call arm for callees that can actually
            // be a foreign (non-wasm-closure) callable — a JS variable holding a
            // host builtin (`Object.hasOwn || fn`). Pure local closures /
            // function params are always wrapped into the closure struct, so the
            // arm would be dead code and only serve to pull host imports
            // (__js_array_new/…) into otherwise self-contained modules.
            // (#2028) ALSO emit it for a Promise-executor `resolve`/`reject`
            // parameter — those arrive as host JS functions and must dispatch
            // through __call_function, not the closure-struct call_ref path
            // (which traps on the null cast). Narrowly gated to Promise-executor
            // params so the #1941 dual-mode guarantee for ordinary callable
            // params is preserved.
            (calleeMayBeHostCallable(ctx, expr.expression) || calleeIsPromiseExecutorParam(ctx, expr.expression));
          const runtimeApplyFallback =
            rawCalleeLocal !== undefined &&
            (ctx.standalone || ctx.wasi) &&
            ctx.runtimeEvalCallableBoundaryEnabled === true &&
            boxableKind(expectedReturn) &&
            matchedClosureInfo.paramTypes.every((t) => boxableKind(t));
          // NB: capability-ctor `executor` params (#1528/#56 class-ctor arm) are
          // UNTYPED (`any`, no call signatures) so they never reach this
          // callable-param dispatch — they are routed earlier through the
          // `__call_function` host helper (see the calleeIsCapabilityCtorParam
          // early-return alongside the bound-function path above).

          let fallbackInstrs: Instr[] | null = null;
          let dispatchOuterBody: Instr[] | null = null;
          if (hostCallFallback || runtimeApplyFallback) {
            // Ensure all fallback imports BEFORE detaching buffers so the index
            // shifts land while every buffer is reachable by the shifters.
            let arrNew: number | undefined;
            let arrPush: number | undefined;
            let callFn: number | undefined;
            if (hostCallFallback) {
              const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
              const arrPushIdx = ensureLateImport(
                ctx,
                "__js_array_push",
                [{ kind: "externref" }, { kind: "externref" }],
                [],
              );
              const callFnIdx = ensureLateImport(
                ctx,
                "__call_function",
                [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
                [{ kind: "externref" }],
              );
              flushLateImportShifts(ctx, fctx);
              arrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
              arrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
              callFn = ctx.funcMap.get("__call_function") ?? callFnIdx;
            } else {
              const builders = ensureObjVecBuilders(ctx);
              arrNew = builders.newIdx;
              arrPush = builders.pushIdx;
              callFn = reserveApplyClosure(ctx);
            }
            if (arrNew !== undefined && arrPush !== undefined && callFn !== undefined) {
              // Build the fallback arm in a detached buffer parked in savedBodies
              // (late-import/global shifters walk savedBodies — #1712 blocker 1).
              const mainBuf = fctx.body;
              fctx.savedBodies.push(mainBuf);
              fctx.body = [];
              fctx.body.push({ op: "call", funcIdx: arrNew });
              const argsArrLocal = allocLocal(fctx, `__callable_hargs_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: argsArrLocal });
              for (let ai = 0; ai < argLocals.length; ai++) {
                // Only pass the call-site arg count — padded defaults must stay
                // invisible to the host callee (fn.length / arguments.length).
                if (ai >= expr.arguments.length) break;
                fctx.body.push({ op: "local.get", index: argsArrLocal });
                fctx.body.push({ op: "local.get", index: argLocals[ai]! });
                const at = matchedClosureInfo.paramTypes[ai]!;
                if (at.kind !== "externref") {
                  coerceType(ctx, fctx, at, { kind: "externref" });
                }
                fctx.body.push({ op: "call", funcIdx: arrPush });
              }
              for (const exLocal of cpExtrasLocals) {
                fctx.body.push({ op: "local.get", index: argsArrLocal });
                fctx.body.push({ op: "local.get", index: exLocal });
                fctx.body.push({ op: "call", funcIdx: arrPush });
              }
              fctx.body.push({ op: "local.get", index: rawCalleeLocal! });
              fctx.body.push({ op: "ref.null.extern" });
              fctx.body.push({ op: "local.get", index: argsArrLocal });
              fctx.body.push({ op: "call", funcIdx: callFn });
              if (expectedReturn === null) {
                fctx.body.push({ op: "drop" });
              } else if (expectedReturn.kind !== "externref") {
                coerceType(ctx, fctx, { kind: "externref" }, expectedReturn);
              }
              fallbackInstrs = fctx.body;
              // Redirect the existing dispatch emission below into a second
              // detached buffer; both stay parked until the if-assembly.
              fctx.savedBodies.push(fallbackInstrs);
              fctx.body = [];
              dispatchOuterBody = mainBuf;
            }
          }

          // Extract funcref from the closure struct (field 0) — null-check → TypeError (#728)
          // (#2873) Fetched via the CAST struct type (the wrapper root on the
          // externref path) — field 0 (funcref) is the root's own field, so the
          // read is valid for a closure of ANY wrapper subtype.
          fctx.body.push({ op: "local.get", index: closureLocal });
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureCastStructIdx });
          fctx.body.push({
            op: "struct.get",
            typeIdx: closureCastStructIdx,
            fieldIdx: 0,
          });

          // (#2933) Variadic builtin value-closure arm. Only when a variadic
          // builtin static method (`Math.max`/`Math.min`) was reified in this
          // module (ctx flag set at value-read time — all of its types/helpers
          // are then already registered, so the arm emits NO first-registrations
          // mid-body, #2704) AND the callee arrived as externref (closureLocal
          // is root-cast). Modules without such a value read are byte-identical.
          const variadic =
            (ctx.standalone || ctx.wasi) && innerResultType?.kind === "externref"
              ? ctx.variadicBuiltinClosure
              : undefined;

          if (funcCandidates.length <= 1 && variadic === undefined) {
            // Single func type — push self+args back onto stack then call
            // Stack before: [funcref]
            // Need: [self, ...args, funcref] for call_ref
            // Re-push self and args under the funcref by saving funcref first
            const funcrefLocal = allocLocal(fctx, `__frd_${fctx.locals.length}`, { kind: "funcref" } as ValType);
            fctx.body.push({ op: "local.set", index: funcrefLocal });
            // Push self (null-check)
            fctx.body.push({ op: "local.get", index: closureLocal });
            emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureCastStructIdx });
            // Shared funcs use root self; private funcs retain a concrete self
            // type. The matched wrapper candidate is shared, but derive rather
            // than assume so the invariant stays local to the func type.
            const matchedSelfTypeIdx =
              getClosureFuncSelfTypeIdx(ctx, matchedClosureInfo.funcTypeIdx) ?? closureCastStructIdx;
            if (matchedSelfTypeIdx !== closureCastStructIdx) {
              fctx.body.push({ op: "ref.cast", typeIdx: matchedSelfTypeIdx });
            }
            // Push args
            for (const al of argLocals) {
              fctx.body.push({ op: "local.get", index: al });
            }
            // (#1511) Set __extras_argv from saved overflow locals + __argc
            appendArgcSetupFromExtras(ctx, fctx, fctx.body, cpParamCnt, cpExtrasLocals, expr.arguments.length);
            // Push funcref back, guarded cast, call
            fctx.body.push({ op: "local.get", index: funcrefLocal });
            emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
            emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
            fctx.body.push({
              op: "call_ref",
              typeIdx: matchedClosureInfo.funcTypeIdx,
            });
            // (#1511) Reset globals (callee may not have consumed them).
            // Return value already on stack — save, reset, restore.
            if (expectedReturn !== null) {
              const _retL = allocLocal(fctx, `__cp_ret_${fctx.locals.length}`, expectedReturn);
              fctx.body.push({ op: "local.set", index: _retL });
              for (const ins of buildArgcExtrasReset(ctx)) fctx.body.push(ins);
              fctx.body.push({ op: "local.get", index: _retL });
            } else {
              for (const ins of buildArgcExtrasReset(ctx)) fctx.body.push(ins);
            }
          } else {
            // (#1131) Multi-funcref-type dispatch: the closure may have a different
            // return type than declared (e.g. () => string passed as () => void).
            // Save funcref, then dispatch on funcref type. Each branch re-pushes
            // self + args + typed funcref for call_ref.
            const funcrefLocal = allocLocal(fctx, `__frd_${fctx.locals.length}`, { kind: "funcref" } as ValType);
            fctx.body.push({ op: "local.set", index: funcrefLocal });

            const retBlockType =
              expectedReturn === null ? ({ kind: "empty" } as const) : ({ kind: "val", type: expectedReturn } as const);

            // Build dispatch chain bottom-up (innermost = throw TypeError)
            let funcDispatch: Instr[] = typeErrorThrowInstrs(ctx);

            // (#2933) Innermost fallback BEFORE the TypeError: the variadic
            // builtin value-closure arm. Its lifted func type has ONE
            // `(ref null $vec_externref)` args param, so no fixed-arity
            // candidate above can ever match it — this arm packs ALL true
            // call-site args (declared-slot locals + overflow extras; padded
            // defaults stay invisible) into a fresh vec and `call_ref`s the
            // closure. Every op here is either pure or a call to an
            // ALREADY-registered func (registered at value-read time), so the
            // arm is dead-arm-safe (#2174 — no late-import index shifts).
            if (variadic !== undefined) {
              const armBody: Instr[] = [];
              // self (canonical root for shared variadic wrappers; concrete
              // self only if this ever becomes a private func type).
              armBody.push({ op: "local.get", index: closureLocal });
              const variadicSelfTypeIdx = getClosureFuncSelfTypeIdx(ctx, variadic.funcTypeIdx) ?? closureCastStructIdx;
              if (variadicSelfTypeIdx !== closureCastStructIdx) {
                armBody.push({ op: "ref.cast", typeIdx: variadicSelfTypeIdx });
              }
              // Pack args: declared-slot locals up to the TRUE call-site count
              // (argLocals beyond expr.arguments.length are synthesized padding),
              // then the overflow extras (already externref).
              let packed = 0;
              for (let ai = 0; ai < Math.min(expr.arguments.length, argLocals.length); ai++) {
                armBody.push({ op: "local.get", index: argLocals[ai]! });
                const at = matchedClosureInfo.paramTypes[ai]!;
                if (at.kind === "f64" || at.kind === "i32") {
                  if (at.kind === "i32") armBody.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ctx.funcMap.get("__box_number");
                  if (boxIdx !== undefined) {
                    armBody.push({ op: "call", funcIdx: boxIdx });
                  } else {
                    armBody.push({ op: "drop" }, { op: "ref.null.extern" });
                  }
                } else if (at.kind === "ref" || at.kind === "ref_null") {
                  armBody.push({ op: "extern.convert_any" });
                }
                packed++;
              }
              for (const exLocal of cpExtrasLocals) {
                armBody.push({ op: "local.get", index: exLocal });
                packed++;
              }
              armBody.push({ op: "array.new_fixed", typeIdx: variadic.arrTypeIdx, length: packed });
              const varArrTmp = allocLocal(fctx, `__vararg_arr_${fctx.locals.length}`, {
                kind: "ref",
                typeIdx: variadic.arrTypeIdx,
              });
              armBody.push({ op: "local.set", index: varArrTmp });
              armBody.push({ op: "i32.const", value: packed });
              armBody.push({ op: "local.get", index: varArrTmp });
              armBody.push({ op: "struct.new", typeIdx: variadic.vecTypeIdx });
              // typed funcref + call
              armBody.push({ op: "local.get", index: funcrefLocal });
              armBody.push({ op: "ref.cast", typeIdx: variadic.funcTypeIdx });
              armBody.push({ op: "call_ref", typeIdx: variadic.funcTypeIdx });
              // Coerce the externref result to the block's expected type using
              // only already-registered engine helpers (pure on dead arms).
              if (expectedReturn === null) {
                armBody.push({ op: "drop" });
              } else if (expectedReturn.kind === "f64" || expectedReturn.kind === "i32") {
                const feIdx = ctx.funcMap.get("__any_from_extern");
                const tfIdx = ctx.funcMap.get("__any_to_f64");
                if (feIdx !== undefined && tfIdx !== undefined) {
                  armBody.push({ op: "call", funcIdx: feIdx }, { op: "call", funcIdx: tfIdx });
                  if (expectedReturn.kind === "i32") {
                    armBody.push({ op: "i32.trunc_sat_f64_s" });
                  }
                } else {
                  armBody.push({ op: "drop" });
                  armBody.push(...defaultValueInstrs(expectedReturn));
                }
              } else if (expectedReturn.kind !== "externref") {
                armBody.push({ op: "drop" });
                armBody.push(...defaultValueInstrs(expectedReturn));
              }
              funcDispatch = [
                { op: "local.get", index: funcrefLocal },
                { op: "ref.test", typeIdx: variadic.funcTypeIdx },
                {
                  op: "if",
                  blockType: retBlockType,
                  then: armBody,
                  else: funcDispatch,
                },
              ];
            }

            for (const fc of [...funcCandidates].reverse()) {
              // Each candidate needs root self, args, typed funcref, call_ref.
              // Exactness belongs solely to the funcref type; wrapper subtypes
              // are module-local allocation identities.
              const fcCallBody: Instr[] = [];
              setCandidateArgc(
                ctx,
                fctx,
                fcCallBody,
                fc.paramTypes.length,
                actualArgExternLocals,
                expr.arguments.length,
              );
              // Shared func types use canonical-root self. A private/named
              // closure func type still names its concrete self, so its arm
              // needs a concrete cast to remain statically call_ref-valid.
              // An unrelated private carrier cannot pass the wrapper-root gate;
              // that candidate arm may therefore be runtime-unreachable.
              fcCallBody.push({ op: "local.get", index: closureLocal });
              const candidateSelfTypeIdx = getClosureFuncSelfTypeIdx(ctx, fc.funcTypeIdx) ?? closureCastStructIdx;
              if (candidateSelfTypeIdx !== closureCastStructIdx) {
                fcCallBody.push({ op: "ref.cast", typeIdx: candidateSelfTypeIdx });
              }
              // Push args
              for (let ai = 0; ai < fc.paramTypes.length; ai++) {
                fcCallBody.push({ op: "local.get", index: argLocals[ai]! });
              }
              // Push typed funcref and call
              fcCallBody.push({ op: "local.get", index: funcrefLocal });
              fcCallBody.push({ op: "ref.cast", typeIdx: fc.funcTypeIdx });
              fcCallBody.push({ op: "call_ref", typeIdx: fc.funcTypeIdx });

              // Coerce return to expected type.
              //
              // The `if`-block declares `(result <expectedReturn>)`, so EVERY
              // arm must leave a value of that exact type. But only the arm
              // whose `funcTypeIdx` matches `retFn`'s runtime funcref actually
              // executes — the rest are synthesized type-validity padding that
              // never runs. So the coercion MUST be side-effect-free for those
              // dead arms: pulling a late host import (e.g. `__unbox_number`)
              // from a never-matching candidate shifts function indices mid-body
              // and desyncs an already-baked `ref.func` operand → the closure
              // ends up wrapping the wrong function (#2174 regression: a plain
              // `var fn = makeAdder(10); fn(32)` had its adder `ref.func`
              // rewritten to a freshly-imported `__typeof_boolean`, throwing at
              // runtime). The live arm always matches `expectedReturn` exactly
              // (so `valTypesMatch` is true and this block is skipped for it).
              const matchedDispatch = expectedReturn !== null && fc.returnType !== null;
              const numericKind = (t: ValType): boolean => t.kind === "i32" || t.kind === "f64" || t.kind === "i64";
              if (expectedReturn === null && fc.returnType !== null) {
                fcCallBody.push({ op: "drop" });
              } else if (expectedReturn !== null && fc.returnType === null) {
                fcCallBody.push(...defaultValueInstrs(expectedReturn));
              } else if (
                matchedDispatch &&
                !valTypesMatch(fc.returnType!, expectedReturn!) &&
                numericKind(expectedReturn!) &&
                numericKind(fc.returnType!)
              ) {
                // (#1693) Numeric-primitive divergence between a real matching
                // candidate and the declared block type (e.g. expected i32,
                // candidate returns f64). `coerceType` between numeric kinds
                // emits ONLY pure ops (`f64.convert_i32_s` / `i32.trunc_sat_f64_s`
                // / …) — no late imports, no index shift — so it is safe even on
                // a dead arm. Surfaces at full-module scale in axios/lib/utils.js
                // where ~30 same-arity arrow predicates with diverging numeric
                // returns populate ctx.closureInfoByTypeIdx.
                const savedBody = fctx.body;
                fctx.body = fcCallBody;
                coerceType(ctx, fctx, fc.returnType!, expectedReturn!);
                fctx.body = savedBody;
              } else if (matchedDispatch && !valTypesMatch(fc.returnType!, expectedReturn!)) {
                // (#2174) Any remaining mismatch is externref/ref ↔ primitive on
                // a candidate that does NOT match the runtime funcref (the live
                // arm matched `expectedReturn` and skipped this block). Bridging
                // these via `coerceType` would pull `__box_number`/`__unbox_number`
                // — a late import that shifts indices and corrupts earlier
                // `ref.func`s. Since this arm never executes, drop its value and
                // push a type-valid default for the block result instead — no
                // import, no shift. (The async case from #2174 is handled by
                // widening `expectedReturn` to externref above, which makes the
                // live async/Promise arm `valTypesMatch` and pass through; the
                // dead f64 candidates land here and get a null-extern default.)
                fcCallBody.push({ op: "drop" });
                fcCallBody.push(...defaultValueInstrs(expectedReturn!));
              }

              funcDispatch = [
                { op: "local.get", index: funcrefLocal },
                { op: "ref.test", typeIdx: fc.funcTypeIdx },
                {
                  op: "if",
                  blockType: retBlockType,
                  then: fcCallBody,
                  else: funcDispatch,
                },
              ];
            }

            // Each arm derives `arguments` from its own formal count (#2704).
            fctx.body.push(...funcDispatch);
            // (#2704) Reset __argc to its sentinel after the dispatch so a stale
            // count can't leak into a subsequent callee that reads `arguments`
            // (#1511). Use the no-lazy-register variant: the dispatch chain's
            // type operands are already baked above, and calling
            // ensureExtrasArgvGlobal here for a 0-extras callback would register
            // the __extras_argv vec type for the FIRST time mid-body and desync
            // codegen — that miscompiled `new Map/WeakMap/WeakSet(iterable)`
            // inside an assert.throws callback so it stopped throwing (the
            // 4-test merge_group regression that parked PR #2149).
            if (expectedReturn !== null) {
              const retL = allocLocal(fctx, `__mfd_ret_${fctx.locals.length}`, expectedReturn);
              fctx.body.push({ op: "local.set", index: retL });
              for (const ins of buildArgcResetNoLazyExtras(ctx)) fctx.body.push(ins);
              fctx.body.push({ op: "local.get", index: retL });
            } else {
              for (const ins of buildArgcResetNoLazyExtras(ctx)) fctx.body.push(ins);
            }
          }

          // (#1712/#2928) Assemble the foreign-callable fallback split: the funcref
          // dispatch emitted above went into a detached buffer; wrap both arms
          // in an `if` on "cast failed but raw callee non-null".
          if ((hostCallFallback || runtimeApplyFallback) && fallbackInstrs && dispatchOuterBody) {
            const dispatchInstrs = fctx.body;
            fctx.body = dispatchOuterBody;
            fctx.savedBodies.pop(); // fallbackInstrs
            fctx.savedBodies.pop(); // mainBuf (now fctx.body again)
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.get", index: rawCalleeLocal! });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "i32.eqz" });
            fctx.body.push({ op: "i32.and" });
            fctx.body.push({
              op: "if",
              blockType:
                expectedReturn === null
                  ? ({ kind: "empty" } as const)
                  : ({ kind: "val", type: expectedReturn } as const),
              then: fallbackInstrs,
              else: dispatchInstrs,
            });
          }

          return expectedReturn ?? VOID_RESULT;
        }
      }

      // #1063 Part B: try inline dynamic-dispatch through closure-struct
      // candidates when the callee is a known variable of externref/any type
      // that may wrap a closure at runtime.
      const declaration = ctx.oracle.valueDeclarationOf(expr.expression);
      const isRuntimeEvalGlobal =
        (ctx.standalone || ctx.wasi) && ctx.runtimeEvalGlobalFunctionBindings === true && declaration === undefined;
      // (#3966) A callee whose only binding is a realm-global property the
      // program created (`this.beep = fn` / bare `getRight = fn`) is legitimate —
      // see implicit-global-binding.ts for why the two arms below got it wrong.
      const implicitCallee = isSloppyImplicitGlobalBinding(ctx, fctx, funcName);
      const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, isKnownVariable || isRuntimeEvalGlobal || implicitCallee);
      if (dyn !== null) return dyn;

      // §6.2.5.5 GetValue on an unresolvable Reference: calling a TRULY
      // undeclared identifier (`$DETACHBUFFER(ab)` with no `includes:` that
      // would define it — test262 harness/detachArrayBuffer.js) must throw
      // ReferenceError, and the arguments must NOT be evaluated (the callee
      // reference is resolved first, §13.3.6.1 step 1). The identifier READ
      // path already throws for symbol-less names (#1380); this is the same
      // rule at the call site, where the graceful undefined fallback below
      // used to swallow it. Standalone/wasi only, and NOT under
      // runtime-eval global bindings (an eval-defined global function has no
      // static symbol yet is legitimately callable there).
      if (
        (ctx.standalone || ctx.wasi) &&
        !isRuntimeEvalGlobal &&
        !implicitCallee &&
        declaration === undefined &&
        noJsHost(ctx)
      ) {
        emitThrowReferenceError(ctx, fctx, `${funcName} is not defined`);
        fctx.body.push({ op: "unreachable" });
        return { kind: "externref" };
      }

      // Graceful fallback for unknown functions — compile arguments (for side effects)
      // then emit ref.null extern (undefined) as the return value.
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Check if this function is eligible for call-site inlining
    const inlineInfo = ctx.inlinableFunctions.get(funcName);
    if (inlineInfo && !expr.arguments.some((a: any) => ts.isSpreadElement(a))) {
      // Inline the function body: compile arguments into temp locals, then emit body
      const inlineOptInfo = ctx.funcOptionalParams.get(funcName);
      const argLocals: number[] = [];
      for (let i = 0; i < inlineInfo.paramCount; i++) {
        if (i < expr.arguments.length) {
          compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, inlineInfo.paramTypes[i]);
        } else {
          // #1658: a missing optional param must receive its default — either the
          // inlined constant (callee prologue is skipped for constant defaults) or
          // the sNaN sentinel that the inlined prologue checks for expression
          // defaults. pushDefaultValue alone emits 0/ref.null and silently drops
          // the default.
          const opt = inlineOptInfo?.find((o) => o.index === i);
          if (opt) {
            pushParamSentinel(fctx, inlineInfo.paramTypes[i]!, ctx, opt);
          } else {
            pushDefaultValue(fctx, inlineInfo.paramTypes[i]!, ctx);
          }
        }
        const tmpLocal = allocLocal(
          fctx,
          `__inline_${funcName}_p${i}_${fctx.locals.length}`,
          inlineInfo.paramTypes[i]!,
        );
        fctx.body.push({ op: "local.set", index: tmpLocal });
        argLocals.push(tmpLocal);
      }
      // Drop extra arguments (evaluate for side effects)
      for (let i = inlineInfo.paramCount; i < expr.arguments.length; i++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extraType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Emit the inlined body, remapping local.get indices to the temp locals.
      // Shallow-clone each instr so later remap passes (dead-elim, late-import
      // shift) do not mutate indices through shared references between the
      // original function body and the inlined copy (#1063).
      for (const instr of inlineInfo.body) {
        if (instr.op === "local.get") {
          const mapped = argLocals[(instr as any).index];
          if (mapped !== undefined) {
            fctx.body.push({ op: "local.get", index: mapped });
          } else {
            if (process.env?.JS2WASM_FRAME_OPS) {
              process.stderr.write(
                `[js2:inline-unmapped] inlining '${funcName}' into ${fctx.name}: local.get ${(instr as any).index} ` +
                  `has no arg mapping (paramCount=${inlineInfo.paramCount}, argLocals=${argLocals.join(",")}), ` +
                  `callerFrame=${fctx.params.length + fctx.locals.length}\n`,
              );
            }
            fctx.body.push({ ...instr });
          }
        } else {
          fctx.body.push({ ...instr });
        }
      }
      return inlineInfo.returnType ?? VOID_RESULT;
    }

    // Prepend captured values for nested functions with captures
    const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
    if (nestedCaptures) {
      // #1177: Get param types early so we can coerce captures to expected types.
      // Re-fetch funcIdx in case a prior compileExpression triggered a late-import
      // shift (which updated funcMap but not our local `funcIdx`).
      funcIdx = ctx.funcMap.get(funcName) ?? funcIdx;
      const captureParamTypes = getFuncParamTypes(ctx, funcIdx);
      for (let capIdx = 0; capIdx < nestedCaptures.length; capIdx++) {
        const cap = nestedCaptures[capIdx]!;
        // Direct calls prepend a nested declaration's captures without going
        // through closure construction. If that capture is another hoisted
        // Function value in a recursive dependency cycle, its preallocated
        // live cell still contains null until the lazy materializer fills it.
        // Publish the value before passing the cell to the callee, matching
        // emitClosureConstruction's capture path.
        materializeHoistedFunctionValueBinding(ctx, fctx, cap.name);
        // #1177: TDZ check for captured let/const/using variables — fires
        // BEFORE the cap-prepend so we throw ReferenceError before the callee
        // observes an uninitialized value. Apply to BOTH the mutable and
        // non-mutable branches: a callee with a mutable capture (ref cell)
        // can still be called while the outer let-decl is in TDZ if a
        // closure that captured the flag invokes the callee transitively.
        const capTdzIdx = fctx.tdzFlagLocals?.get(cap.name);
        if (capTdzIdx !== undefined) {
          const capTdzResult = analyzeTdzAccessByPos(ctx, cap.name, expr);
          if (capTdzResult === "check") {
            emitLocalTdzCheck(ctx, fctx, cap.name, capTdzIdx);
          } else if (capTdzResult === "throw") {
            emitStaticTdzThrow(ctx, fctx, cap.name);
          }
          // "skip" — call site is after declaration, no check needed
        }
        if (cap.mutable && cap.valType) {
          // Mutable capture: wrap in a ref cell so writes propagate back
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
          // Check if this local is already boxed (from a previous call to the same or another closure)
          //
          // #1259: detect double-wrap when `localMap[cap.name]` was
          // re-aimed at a boxed-cap local *deliberately* by a different
          // codegen site (compileArrowAsClosure, emitFuncRefAsClosure,
          // object-ops, etc.). All such sites use the `__boxed_<name>`
          // local-naming convention AND set `boxedCaptures[cap.name]`
          // in lockstep. The narrow guard here checks for both signals:
          //   1. the slot's type matches `cap.valType`'s ref cell type, AND
          //   2. the slot's name starts with `__boxed_`.
          // If both hold, we're confident this slot is a deliberately
          // boxed cap (not a coincidental same-typed local) and we can
          // pass it through without re-boxing. The narrower guard avoids
          // the regressions seen on the wider type-only guard (PR#166
          // CI: net -25, 33 wasm-change regressions).
          //
          // Without this check, none of the existing call sites would
          // hit the `localMap`-already-boxed-but-`boxedCaptures`-empty
          // path on main today (they pair the two writes). The guard
          // is defensive prep for #1177 Stage 1 — when Stage 1 re-aims
          // `localMap` to an outer-fctx boxed local whose `__boxed_` name
          // we can recognize, we'll treat it as already-boxed.
          const candidateLocalIdx = fctx.localMap.get(cap.name);
          let candidateIsBoxed = false;
          if (candidateLocalIdx !== undefined) {
            const candidateType = getLocalType(fctx, candidateLocalIdx);
            const isRefCellTyped =
              candidateType !== undefined &&
              (candidateType.kind === "ref" || candidateType.kind === "ref_null") &&
              (candidateType as { typeIdx: number }).typeIdx === refCellTypeIdx;
            // Also require the name signal — only deliberately-boxed locals
            // use the `__boxed_` convention.
            const localSlot =
              candidateLocalIdx >= fctx.params.length ? fctx.locals[candidateLocalIdx - fctx.params.length] : undefined;
            const hasBoxedName = localSlot?.name?.startsWith(`__boxed_`) ?? false;
            candidateIsBoxed = isRefCellTyped && hasBoxedName;
          }
          // (#3024) Method/accessor capture promotion (#2029/#3039/#3121,
          // closures.ts) moves a boxed capture's cell into a module global and
          // DELETES the localMap binding so post-promotion code in the
          // enclosing function routes through the global. `boxedCaptures`
          // still has the name, so without this arm the branch below resolved
          // `localMap.get(name) ?? cap.outerLocalIdx` → the STALE pre-boxing
          // raw slot (an f64/i32 local) and baked `local.get <raw>` where the
          // callee expects the ref cell → invalid Wasm (`call[0] expected
          // (ref null N), found local.get of type f64`; the test262
          // object/dstr meth-ary-ptrn-elision family). Source the SAME shared
          // cell from the promotion global instead (live write-through — the
          // method body and the enclosing function read/write this cell too).
          const promotedBoxGlobal =
            fctx.localMap.get(cap.name) === undefined ? ctx.capturedBoxGlobals?.get(cap.name) : undefined;
          if (promotedBoxGlobal !== undefined && fctx.boxedCaptures?.has(cap.name)) {
            fctx.body.push({ op: "global.get", index: promotedBoxGlobal.globalIdx });
            fctx.body.push({ op: "ref.as_non_null" });
          } else if (fctx.boxedCaptures?.has(cap.name) || candidateIsBoxed) {
            // Already a ref cell — pass the ref cell reference directly
            // A nested function can capture a module binding whose name is
            // shadowed by a local `var` in the current function (for example,
            // React's `forceStoreRerender` has a local `root` while a sibling
            // function still captures the module-level `root`).  The leading
            // capture parameter is the cell we must forward; the name-based
            // localMap entry is the shadow value and has the wrong ABI type.
            const currentLocalIdx = fctx.liftedCaptureSlots?.has(cap.name)
              ? captureSourceSlot(fctx, cap)
              : (fctx.localMap.get(cap.name) ?? cap.outerLocalIdx);
            const refCellType: ValType = { kind: "ref", typeIdx: refCellTypeIdx };
            const sourceType = getLocalType(fctx, currentLocalIdx);
            const sourceIsSameCell =
              sourceType !== undefined &&
              (sourceType.kind === "ref" || sourceType.kind === "ref_null") &&
              sourceType.typeIdx === refCellTypeIdx;
            if (sourceIsSameCell) {
              fctx.body.push({ op: "local.get", index: currentLocalIdx });
              if (sourceType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
            } else if (sourceType !== undefined) {
              // The source frame may expose the capture as its raw value
              // (usually a leading i32/f64/externref parameter) even though
              // this callee needs the shared mutable cell.  Materialize the
              // cell at this forwarding boundary and re-aim the current
              // binding so later reads/writes use the same storage.
              fctx.body.push({ op: "local.get", index: currentLocalIdx });
              if (!valTypesMatch(sourceType, cap.valType)) coerceType(ctx, fctx, sourceType, cap.valType);
              const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, refCellType);
              fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
              fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
              fctx.localMap.set(cap.name, boxedLocalIdx);
              if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
              fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
            } else {
              fctx.body.push({ op: "local.get", index: currentLocalIdx });
            }
            // Backfill boxedCaptures only when we hit the new candidateIsBoxed
            // branch — preserves invariants for downstream helpers that key on
            // boxedCaptures membership.
            if (candidateIsBoxed && !fctx.boxedCaptures?.has(cap.name)) {
              if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
              fctx.boxedCaptures.set(cap.name, {
                refCellTypeIdx,
                valType: cap.valType,
              });
            }
          } else if (fctx.localMap.get(cap.name) === undefined && ctx.capturedBoxGlobals?.has(cap.name)) {
            // (#2029 family A) Cross-fctx capture: calling a nested fn from an
            // object-literal accessor body. The declaring function's local
            // slot (`cap.outerLocalIdx`) is unreachable here; the accessor-
            // capture pass promoted the shared ref-cell box to a module
            // global — source it from there (live write-through semantics).
            // Guarded on localMap-absence so owner-fctx behavior is unchanged
            // (see the #1177 revert note below).
            fctx.body.push({ op: "global.get", index: ctx.capturedBoxGlobals.get(cap.name)!.globalIdx });
            fctx.body.push({ op: "ref.as_non_null" });
          } else if (fctx.localMap.get(cap.name) === undefined && ctx.capturedGlobals.has(cap.name)) {
            // (#2029 family A) Value-global-promoted capture — box a copy.
            // Best-effort (writes through the closure don't propagate back);
            // the previous behavior was an out-of-scope local read.
            fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
            if (ctx.capturedGlobalsWidened.has(cap.name)) {
              fctx.body.push({ op: "ref.as_non_null" });
            }
            fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
          } else {
            // Create a ref cell, store the current value, keep ref on stack.
            // `cap.outerLocalIdx` belongs to the callee's declaring frame. A
            // lifted transitive caller carries the same binding in one of its
            // own leading capture params, so reading the declaring-frame slot
            // here can point far beyond the caller's frame (Deno 01_core's
            // runImmediateCallbacks -> runImmediates hit slots 1240/1254 in a
            // 47-slot function). Use the deliberately narrow resolver: it
            // preserves the historical declaring-frame slot unless this frame
            // explicitly recorded a lifted capture slot or can prove the old
            // slot is stale. This is not #1177's reverted blanket localMap-first
            // substitution.
            const capSourceIdx = captureSourceSlot(fctx, cap);
            fctx.body.push({ op: "local.get", index: capSourceIdx });
            fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
            // Also box the outer local so subsequent reads/writes go through the ref cell
            const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
              kind: "ref",
              typeIdx: refCellTypeIdx,
            });
            // Duplicate: need the ref cell for the call AND for the outer local
            fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
            // Re-register the original name to point to the boxed local
            fctx.localMap.set(cap.name, boxedLocalIdx);
            if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
            fctx.boxedCaptures.set(cap.name, {
              refCellTypeIdx,
              valType: cap.valType,
            });
          }
          // Coerce mutable capture (ref cell) to expected param type if they differ
          const expectedMutCapType = captureParamTypes?.[capIdx];
          if (expectedMutCapType) {
            const refCellType: ValType = { kind: "ref", typeIdx: refCellTypeIdx };
            if (!valTypesMatch(refCellType, expectedMutCapType)) {
              coerceType(ctx, fctx, refCellType, expectedMutCapType);
            }
          }
        } else if (fctx.localMap.get(cap.name) === undefined && ctx.capturedGlobals.has(cap.name)) {
          // (#2029 family A) Immutable capture promoted to a value global by
          // the accessor-capture pass (cross-fctx call of a nested fn from an
          // accessor body, or owner-fctx call after promotion) — read the
          // global instead of the out-of-scope / stale local slot. The
          // global's type matches the lifted param by construction (both
          // derive from the same declaring-function local), so no coercion.
          fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
          if (ctx.capturedGlobalsWidened.has(cap.name)) {
            fctx.body.push({ op: "ref.as_non_null" });
          }
        } else {
          // (#1177: TDZ check moved above the mutable/non-mutable branch.
          // Stage 1's blanket localMap-first lookup remains reverted. The one
          // sound cross-frame case is a name explicitly recorded as THIS
          // lifted function's leading capture parameter.)
          const capSourceIdx = captureSourceSlot(fctx, cap);
          const actualType = getLocalType(fctx, capSourceIdx);
          const boxed = fctx.boxedCaptures?.get(cap.name);
          const expectedCapType = captureParamTypes?.[capIdx];
          const liveBoxLocalIdx = fctx.localMap.get(cap.name);
          const liveBoxType = liveBoxLocalIdx !== undefined ? getLocalType(fctx, liveBoxLocalIdx) : undefined;
          const liveBoxIsCanonical =
            !cap.mutable &&
            boxed !== undefined &&
            liveBoxLocalIdx !== undefined &&
            liveBoxType !== undefined &&
            (liveBoxType.kind === "ref" || liveBoxType.kind === "ref_null") &&
            liveBoxType.typeIdx === boxed.refCellTypeIdx &&
            expectedCapType !== undefined &&
            expectedCapType.kind !== "ref" &&
            expectedCapType.kind !== "ref_null";
          // A read-only nested function can still cross a frame whose copy of
          // the binding is boxed because a sibling/earlier function required a
          // shared cell.  `captureSourceSlot` quite correctly selects that
          // live leading capture, but the callee's ABI is still the raw value
          // (`externref`, f64, ...).  Passing the cell itself is especially
          // harmful for constructors: `new C()` receives a Wasm struct instead
          // of the host constructor.  Unwrap exactly the current canonical
          // cell before forwarding the immutable capture.
          const sourceIsCanonicalBox =
            !cap.mutable &&
            boxed !== undefined &&
            actualType !== undefined &&
            (actualType.kind === "ref" || actualType.kind === "ref_null") &&
            actualType.typeIdx === boxed.refCellTypeIdx &&
            expectedCapType !== undefined &&
            expectedCapType.kind !== "ref" &&
            expectedCapType.kind !== "ref_null";
          const sourceIdx = liveBoxIsCanonical ? liveBoxLocalIdx! : capSourceIdx;
          const sourceIsBox = liveBoxIsCanonical || sourceIsCanonicalBox;
          fctx.body.push({ op: "local.get", index: sourceIdx });
          if (sourceIsBox) {
            fctx.body.push({ op: "struct.get", typeIdx: boxed!.refCellTypeIdx, fieldIdx: 0 });
          }
          // Coerce capture value to expected param type if they differ
          if (expectedCapType) {
            const forwardedType = sourceIsBox ? boxed!.valType : actualType;
            if (forwardedType && !valTypesMatch(forwardedType, expectedCapType)) {
              coerceType(ctx, fctx, forwardedType, expectedCapType);
            }
          }
        }
      }

      // #1205 Stage 3: After all value captures, push boxed TDZ flag refs.
      // Mirrors compileArrowAsClosure's construct-time logic at
      // closures.ts:2085-2118. Layout invariant: lifted-fn signature is
      // [valueCap_0, ..., valueCap_N-1, tdzFlagBox_0, ..., tdzFlagBox_K-1, ...userParams].
      const tdzFlaggedNested = nestedCaptures.filter((c) => c.hasTdzFlag);
      if (tdzFlaggedNested.length > 0) {
        const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
        for (const cap of tdzFlaggedNested) {
          const existing = fctx.boxedTdzFlags?.get(cap.name);
          if (existing) {
            // Already boxed by an enclosing closure construction or a prior
            // call-site cap-prepend — share the box reference. (#4394)
            // Null-guarded: the teeing site may not dominate this one.
            pushBoxedTdzFlagRef(fctx, existing);
          } else {
            // Fresh box: read the current i32 flag, struct.new an i32 ref cell,
            // tee into a new outer-fctx local, and re-aim
            // `fctx.tdzFlagLocals` + `fctx.boxedTdzFlags` so subsequent
            // emitLocalTdzInit / emitLocalTdzCheck in the outer scope route
            // through the same box.
            //
            // #1205 sourcing rules — the i32 flag must come from a location
            // we can verify is an i32 in the *current* fctx. Two cases:
            //
            //   1. Live `fctx.tdzFlagLocals.get(name)` returns an idx whose
            //      local type is i32 in the current fctx — use it directly.
            //      This is the common case (fn-decl hoisted in same fctx
            //      as the let-decl, no block shadowing in between).
            //
            //   2. Live lookup is missing or points to a non-i32 local.
            //      This covers two sub-cases that we treat the same way:
            //
            //      a. Block-scope shadow cleared the live entry. The
            //         stored `cap.outerTdzFlagIdx` still points to an i32
            //         local — but its RUNTIME VALUE is stale, because the
            //         inner let-decl's `emitLocalTdzInit` was a no-op
            //         (the live entry was deleted by `saveBlockScopedShadows`)
            //         so the flag was never set to 1 inside the block.
            //
            //      b. Cross-function transitive (fn A calls fn B and B
            //         captures a TDZ-flagged var that A does NOT capture).
            //         A's fctx has no source for B's flag. The stored idx
            //         points to a slot in B's hoist fctx, NOT in A's.
            //
            //      In both sub-cases, we cannot trust any runtime i32
            //      slot in the current fctx to give us the right flag
            //      value. Push `i32.const 1` (treat as initialized).
            //      This matches the pre-#1205 behavior, where the lifted
            //      body had no flag check at all — the call site's
            //      static TDZ analysis (calls.ts:4968-4977 above this
            //      block) is the authoritative pre-call check; if it
            //      didn't fire, the variable is past its TDZ.
            const liveFlagIdx = fctx.tdzFlagLocals?.get(cap.name);
            const liveType = liveFlagIdx !== undefined ? getLocalType(fctx, liveFlagIdx) : undefined;
            const liveOk = liveType?.kind === "i32";
            if (liveOk && liveFlagIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: liveFlagIdx });
              fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
            } else {
              fctx.body.push({ op: "i32.const", value: 1 });
              fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
            }
            const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
              kind: "ref",
              typeIdx: i32RefCellTypeIdx,
            });
            fctx.body.push({ op: "local.tee", index: flagBoxLocal });
            // Only re-aim outer fctx's flag maps when we sourced from a
            // verified i32 in THIS fctx — otherwise we'd corrupt the maps
            // with a synthetic box that has no relationship to any actual
            // outer flag, which would in turn break later TDZ checks /
            // initializations in the outer scope.
            if (liveOk) {
              if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
              fctx.boxedTdzFlags.set(cap.name, {
                refCellTypeIdx: i32RefCellTypeIdx,
                localIdx: flagBoxLocal,
                // (#4394) Record the raw i32 source so non-dominated reuse
                // sites can lazily re-init the box from the true flag.
                srcFlagIdx: liveFlagIdx,
              });
              if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
              fctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
            }
          }
        }
      }
    }

    // #1177: Re-fetch funcIdx in case the cap-prepend loop above (or any
    // earlier compileExpression in this function) triggered a late-import
    // shift via emitLocalTdzCheck/emitStaticTdzThrow. #1205: also covers
    // late-import shifts triggered by the TDZ-flag prepend block (which
    // calls getOrRegisterRefCellType — typically pre-registered, but still).
    funcIdx = ctx.funcMap.get(funcName) ?? funcIdx;

    // Check for rest parameters on the callee
    const restInfo = ctx.funcRestParams.get(funcName);

    // Check if any argument uses spread syntax
    const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
    const linearParamsForCall = getLinearU8ParamIndicesForCall(ctx, expr);
    const hasLinearParamsForCall = !!linearParamsForCall && linearParamsForCall.size > 0;

    // (#2202) User-visible param count, computed up-front so the spread-call
    // dispatch below can detect the "callee reads `arguments`, every arg is an
    // extra" shape (the named generator/free-function trailing-comma+spread
    // cluster) and route it through the `__argc`/`__extras_argv` protocol
    // instead of `compileSpreadCallArgs` (which only fills positional param
    // slots and never materialises the runtime-length extras vec — so a
    // 0-param `arguments`-reading callee saw `arguments.length === 0` and a
    // stray positional operand was left on the stack → null-deref trap). The
    // capture-count math mirrors the normal-call path below.
    const paramTypesEarly = getFuncParamTypes(ctx, funcIdx);
    const captureCountEarly = nestedCaptures
      ? nestedCaptures.length + nestedCaptures.filter((c) => c.hasTdzFlag).length
      : 0;
    const paramCountEarly =
      hasLinearParamsForCall && paramTypesEarly
        ? sourceParamCountFromExpanded(paramTypesEarly.length, linearParamsForCall, captureCountEarly)
        : paramTypesEarly
          ? paramTypesEarly.length - captureCountEarly
          : expr.arguments.length;
    const calleeReadsArgsEarly = ctx.funcUsesArguments.has(funcName);

    if (hasLinearParamsForCall && hasSpreadArg) {
      reportError(ctx, expr, "Cannot spread arguments into a linear Uint8Array helper call (#1886)");
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      for (const arg of expr.arguments) {
        const argExpr = ts.isSpreadElement(arg) ? arg.expression : arg;
        const argType = compileExpression(ctx, fctx, argExpr);
        if (argType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      if (paramTypes) {
        for (const paramType of paramTypes) {
          pushDefaultValue(fctx, paramType, ctx);
        }
      }
    } else if (restInfo && !hasSpreadArg && !hasLinearParamsForCall) {
      // Calling a rest-param function: pack trailing args into a GC array
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // Compile non-rest arguments
      for (let i = 0; i < restInfo.restIndex; i++) {
        if (i < expr.arguments.length) {
          compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, expr.arguments.length - restInfo.restIndex);
      // Push length first (for struct.new order: length, data)
      fctx.body.push({ op: "i32.const", value: restArgCount });
      // Push elements, then array.new_fixed
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: restInfo.arrayTypeIdx,
        length: restArgCount,
      });
      // Wrap in vec struct: { length, data }
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    } else if (hasSpreadArg && calleeReadsArgsEarly && !restInfo && !hasLinearParamsForCall && paramCountEarly <= 0) {
      // (#2202) Direct call to an `arguments`-reading function where the callee
      // has zero user params, so EVERY argument (spread or not) is an "extra".
      // `compileSpreadCallArgs` would only fill positional param slots (none
      // here), dropping the runtime extras and leaving `arguments.length === 0`
      // plus a stray operand on the stack. Route the whole list through the
      // `__extras_argv` builder (runtime spread expansion, stack-neutral) and
      // set `__argc` from the extras count — mirroring every method dispatch
      // path. `paramCount` is 0, so no JS positional operands precede the call.
      //
      // Capture/env operands (for a lifted nested fn) are ALREADY on the stack
      // from the `nestedCaptures` prepend loop above — `emitSetExtrasArgv` is
      // stack-neutral (everything lands in locals), so it does not disturb
      // them. We therefore pad only the param slots AFTER the capture region
      // (the same accounting as the normal-call path: providedCount = 0 user
      // args + captureCount captures already pushed). Over-padding the captures
      // was the null-deref: a phantom default landed on top of the real env.
      emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], 0);
      if (paramTypesEarly) {
        for (let i = captureCountEarly; i < paramTypesEarly.length; i++) {
          pushDefaultValue(fctx, paramTypesEarly[i]!, ctx);
        }
      }
      // __argc = 0 (no formal-region args); `arguments.length` then derives
      // entirely from the runtime extras-vec length built above.
      maybeSetArgcForKnownCall(ctx, fctx, funcName, 0, 0);
    } else if (hasSpreadArg) {
      // Spread in function call: fn(...arr) — unpack array elements as positional args
      compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo);
    } else {
      // Normal call — compile provided arguments with type hints from function signature
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // #1205: Each TDZ-flagged value capture also has a flag-box param
      // prepended to the lifted fn signature (see FNDECL-A2 in
      // statements/nested-declarations.ts). Account for those flag params
      // when computing user-visible arity — otherwise the padding loop
      // below pushes a phantom default value for each flag, producing an
      // arity-mismatch trap at the call site.
      const captureCount = nestedCaptures
        ? nestedCaptures.length + nestedCaptures.filter((c) => c.hasTdzFlag).length
        : 0;
      // User-visible param count excludes capture params (which are prepended internally)
      const paramCount =
        hasLinearParamsForCall && paramTypes
          ? sourceParamCountFromExpanded(paramTypes.length, linearParamsForCall, captureCount)
          : paramTypes
            ? paramTypes.length - captureCount
            : expr.arguments.length;
      const calleeReadsArgsDirect = ctx.funcUsesArguments.has(funcName);
      for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
        if (hasLinearParamsForCall && linearParamsForCall.has(i)) {
          const arg = expr.arguments[i]!;
          const buf = getLinearU8Buffer(ctx, fctx, arg);
          if (!buf) {
            reportError(
              ctx,
              arg,
              "Codegen error: linear Uint8Array helper argument is not backed by linear memory (#1886)",
            );
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.const", value: 0 });
          } else {
            fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx });
            fctx.body.push({ op: "local.get", index: buf.lenLocalIdx });
          }
          continue;
        }
        const wasmParamIndex =
          hasLinearParamsForCall && paramTypes
            ? wasmParamIndexForSourceParam(i, linearParamsForCall, captureCount)
            : i + captureCount;
        compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[wasmParamIndex]);
      }
      if (expr.arguments.length > paramCount) {
        if (calleeReadsArgsDirect) {
          emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], paramCount);
        } else {
          for (let i = paramCount; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
      }

      const optInfo = ctx.funcOptionalParams.get(funcName);
      if (paramTypes) {
        // Missing arguments must be emitted in formal-parameter order. The old
        // two-pass lowering emitted every optional/defaulted parameter first,
        // then filled ordinary gaps by count. For `f(a, b, c, d, e = [])`,
        // `f(x)` therefore put e's vec sentinel in b's externref slot and
        // produced invalid Wasm (#3999, styled-components Rt -> Ye).
        const firstMissingSourceParam = Math.min(expr.arguments.length, paramCount);
        for (let sourceIndex = firstMissingSourceParam; sourceIndex < paramCount; sourceIndex++) {
          const firstWasmIndex =
            hasLinearParamsForCall && linearParamsForCall
              ? wasmParamIndexForSourceParam(sourceIndex, linearParamsForCall, captureCount)
              : sourceIndex + captureCount;
          const nextWasmIndex =
            hasLinearParamsForCall && linearParamsForCall
              ? sourceIndex + 1 < paramCount
                ? wasmParamIndexForSourceParam(sourceIndex + 1, linearParamsForCall, captureCount)
                : paramTypes.length
              : firstWasmIndex + 1;
          const opt = optInfo?.find((candidate) => candidate.index === sourceIndex);
          for (let wasmIndex = firstWasmIndex; wasmIndex < nextWasmIndex; wasmIndex++) {
            if (wasmIndex === firstWasmIndex && opt) {
              pushParamSentinel(fctx, paramTypes[wasmIndex]!, ctx, opt);
            } else {
              pushDefaultValue(fctx, paramTypes[wasmIndex]!, ctx);
            }
          }
        }
      }
      // Set __argc before the call so the callee knows the actual arg count
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramCount);
    }

    // Argument compilation may shift defined-function indices.
    const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
    // Foreign eval calls lack checker signatures; the resolved Wasm signature is authoritative.
    if (isForeignEvalNode(expr) && wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
    const sig = isForeignEvalNode(expr) ? undefined : ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
      // Safety check: if the Wasm function actually has void return (e.g. async
      // functions with Promise<void>), the TS type may be misleading
      if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
      // Use actual Wasm return type to avoid TS 'any' → externref mismatch
      return brandExternMethodResult(
        ctx,
        retType,
        getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType),
      );
    }
    return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
  }
  return undefined;
}
