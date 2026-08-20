// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native first-class values for the ES5 global function properties.
 *
 * Direct calls already have pure-Wasm lowerings, but a value read (`parseInt`
 * or `globalThis.parseInt`) used to be `undefined` in standalone mode. The
 * realm `$Object` therefore had no own property for descriptor reflection.
 * This module reifies the same native entries as identity-stable builtin
 * closure values and seeds them onto the native global object with the spec
 * attributes `{ writable:true, enumerable:false, configurable:true }`.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ensureBuiltinFnMetaType, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getExternrefToStringProvider } from "./coercion-engine.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { addStringConstantGlobal, addUnionImports } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitNativeEscape, emitNativeUnescape } from "./escape-native.js"; // (#4556) Annex B §B.2.1/§B.2.2
import { emitNativeUriDecode, emitNativeUriEncode, URI_DECODE_MASK, URI_ENCODE_MASK } from "./uri-encoding-native.js";

export const STANDALONE_ES5_GLOBAL_FUNCTION_NAMES = [
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  // (#4485) `encodeURI` was the ONE §19.2 global function missing from this
  // list — its direct CALL had a native lowering all along, so only the VALUE
  // read was broken, and it read as `null` while its three siblings read as
  // functions (measured: `built-ins/encodeURI/{name,not-a-constructor,prop-desc}`
  // failed while every `decodeURI*`/`encodeURIComponent` twin passed).
  "encodeURI",
  "encodeURIComponent",
  // (#4556) Annex B §B.2.1 / §B.2.2. `escape` / `unescape` are ordinary global
  // FUNCTION PROPERTIES of the realm object with the same
  // `{writable:true, enumerable:false, configurable:true}` attributes as the
  // §19.2 set above — the only reason they were absent is that their direct
  // CALL had a native lowering from the start, so nothing forced the value +
  // own-property half. Measured: `typeof this.escape` already answered
  // "function" (the identifier read works), while
  // `Object.prototype.hasOwnProperty.call(this, "escape")` answered false and
  // `getOwnPropertyDescriptor` answered undefined — so `verifyProperty` failed
  // with "escape should be an own property"
  // (annexB/built-ins/{escape,unescape}/prop-desc.js).
  "escape",
  "unescape",
] as const;

export type StandaloneEs5GlobalFunctionName = (typeof STANDALONE_ES5_GLOBAL_FUNCTION_NAMES)[number];

const GLOBAL_FUNCTION_ARITY: Readonly<Record<StandaloneEs5GlobalFunctionName, number>> = Object.freeze({
  parseInt: 2,
  parseFloat: 1,
  isNaN: 1,
  isFinite: 1,
  decodeURI: 1,
  decodeURIComponent: 1,
  encodeURI: 1,
  encodeURIComponent: 1,
  escape: 1,
  unescape: 1,
});

const GLOBAL_FUNCTION_SET: ReadonlySet<string> = new Set(STANDALONE_ES5_GLOBAL_FUNCTION_NAMES);

export function isStandaloneEs5GlobalFunctionName(name: string): name is StandaloneEs5GlobalFunctionName {
  return GLOBAL_FUNCTION_SET.has(name);
}

function makeClosureFctx(name: string, selfType: ValType, paramTypes: ValType[], returnType: ValType): FunctionContext {
  const fctx: FunctionContext = {
    name,
    params: [{ name: "__self", type: selfType }, ...paramTypes.map((type, i) => ({ name: `arg${i}`, type }))],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  for (let i = 0; i < fctx.params.length; i++) fctx.localMap.set(fctx.params[i]!.name, i);
  return fctx;
}

/** Resolve the ambient parse helper without letting a same-named user binding
 * in `funcMap` replace the realm builtin. Mirrors import-collector's
 * shadow-save protocol. */
function ensureAmbientParseHelper(
  ctx: CodegenContext,
  name: "parseInt" | "parseFloat" | "__str_to_number",
): number | undefined {
  const ambient = ctx.ambientBuiltinFuncMap.get(name);
  if (ambient !== undefined) return ambient;

  const shadowed = ctx.funcMap.get(name);
  if (shadowed !== undefined) ctx.funcMap.delete(name);
  emitNativeParseNumber(ctx, new Set([name]));
  const builtin = ctx.funcMap.get(name);
  if (builtin !== undefined) ctx.ambientBuiltinFuncMap.set(name, builtin);
  if (shadowed !== undefined) ctx.funcMap.set(name, shadowed);
  return builtin;
}

export interface StandaloneGlobalFunctionClosure {
  readonly type: { kind: "ref"; typeIdx: number };
  readonly funcIdx: number;
}

/** Build the genuine callable used by both a bare global-function value read
 * and the corresponding property on the native realm object. */
export function ensureStandaloneGlobalFunctionClosure(
  ctx: CodegenContext,
  name: StandaloneEs5GlobalFunctionName,
): StandaloneGlobalFunctionClosure | null {
  if (!ctx.standalone && !ctx.wasi) return null;

  const arity = GLOBAL_FUNCTION_ARITY[name];
  const paramTypes = Array.from({ length: arity }, () => ({ kind: "externref" }) as ValType);
  const returnsBoolean = name === "isNaN" || name === "isFinite";
  const returnType: ValType =
    name === "parseInt" || name === "parseFloat"
      ? { kind: "f64" }
      : returnsBoolean
        ? { kind: "i32", boolean: true }
        : { kind: "externref" };

  // Settle body dependencies before wrapper/function indices are captured.
  let nativeIdx: number | undefined;
  if (name === "parseInt" || name === "parseFloat") {
    nativeIdx = ensureAmbientParseHelper(ctx, name);
    addUnionImports(ctx);
  } else if (returnsBoolean) {
    // Native __unbox_number performs the shared ToNumber conversion, including
    // native strings when __str_to_number exists before union-helper emission.
    ensureAmbientParseHelper(ctx, "__str_to_number");
    addUnionImports(ctx);
  } else if (name === "decodeURI" || name === "decodeURIComponent") {
    emitNativeUriDecode(ctx);
    nativeIdx = ctx.funcMap.get("__uri_decode");
  } else if (name === "escape") {
    emitNativeEscape(ctx);
    nativeIdx = ctx.funcMap.get("__escape");
  } else if (name === "unescape") {
    emitNativeUnescape(ctx);
    nativeIdx = ctx.funcMap.get("__unescape");
  } else {
    emitNativeUriEncode(ctx);
    nativeIdx = ctx.funcMap.get("__uri_encode");
  }

  const wrappers = getOrCreateFuncRefWrapperTypes(ctx, paramTypes, [returnType]);
  if (!wrappers) return null;

  const helperName = `__standalone_global_function_${name}`;
  let funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) {
    const selfType: ValType = { kind: "ref", typeIdx: wrappers.liftedSelfTypeIdx };
    const closureFctx = makeClosureFctx(helperName, selfType, paramTypes, returnType);

    if (name === "parseFloat" && nativeIdx !== undefined) {
      closureFctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: nativeIdx });
    } else if (name === "parseInt" && nativeIdx !== undefined) {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx === undefined) return null;
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: unboxIdx },
        { op: "call", funcIdx: nativeIdx },
      );
    } else if (returnsBoolean) {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx === undefined) return null;
      const valueLocal = allocLocal(closureFctx, "value", { kind: "f64" });
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxIdx },
        { op: "local.set", index: valueLocal },
        { op: "local.get", index: valueLocal },
        { op: "local.get", index: valueLocal },
        { op: name === "isNaN" ? "f64.ne" : "f64.sub" },
      );
      if (name === "isFinite") {
        closureFctx.body.push({ op: "f64.const", value: 0 }, { op: "f64.eq" });
      }
    } else if ((name === "escape" || name === "unescape") && nativeIdx !== undefined) {
      // (#4556) §B.2.1.1 step 1 is `ToString(string)`; `__escape`/`__unescape`
      // then take the same native-string carrier as the direct-call lowering in
      // annexb-escape-call.ts. No mask argument — unlike the URI family these
      // are 1-arg helpers.
      const toStringIdx = getExternrefToStringProvider(ctx);
      if (toStringIdx === undefined) return null;
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toStringIdx },
        { op: "call", funcIdx: nativeIdx },
      );
    } else if (nativeIdx !== undefined) {
      // __extern_toString is the shared standalone ToString boundary. The URI
      // helpers then receive the same native-string carrier as direct calls.
      const toStringIdx = getExternrefToStringProvider(ctx);
      if (toStringIdx === undefined) return null;
      // (#4485) Pick the mask TABLE by helper family, not by a single name —
      // with `encodeURI` added, a `name === "encodeURIComponent"` test would
      // silently look `encodeURI` up in the DECODE table and get `undefined`.
      const isEncode = name === "encodeURI" || name === "encodeURIComponent";
      const mask = isEncode ? URI_ENCODE_MASK[name] : URI_DECODE_MASK[name];
      closureFctx.body.push(
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toStringIdx },
        { op: "i32.const", value: mask },
        { op: "call", funcIdx: nativeIdx },
      );
    } else {
      return null;
    }

    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: helperName,
      typeIdx: wrappers.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(helperName, funcIdx);
  }

  const metaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrappers.structTypeIdx,
    wrappers.closureInfo,
    `global:${name}`,
    name,
    arity,
  );
  return { type: { kind: "ref", typeIdx: metaTypeIdx }, funcIdx };
}

export function emitStandaloneGlobalFunctionValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: StandaloneEs5GlobalFunctionName,
): ValType | null {
  const closure = ensureStandaloneGlobalFunctionClosure(ctx, name);
  if (!closure) return null;
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
  return closure.type;
}

export function tryEmitStandaloneGlobalFunctionIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  node: Parameters<CodegenContext["oracle"]["valueDeclarationOf"]>[0],
): ValType | null {
  if (!ctx.standalone || !isStandaloneEs5GlobalFunctionName(name)) return null;
  const declaration = ctx.oracle.valueDeclarationOf(node);
  if (declaration !== undefined && !declaration.getSourceFile().isDeclarationFile) return null;
  return emitStandaloneGlobalFunctionValue(ctx, fctx, name);
}

/** Build the one-time seeds for the native realm object in `objectLocal`. */
export function standaloneGlobalFunctionSeedInstrs(ctx: CodegenContext, objectLocal: number): Instr[] | null {
  if (!ctx.standalone && !ctx.wasi) return [];

  // Settle every possible late import before capturing any function index in
  // the detached initialization body returned below.
  for (const name of STANDALONE_ES5_GLOBAL_FUNCTION_NAMES) {
    if (!ensureStandaloneGlobalFunctionClosure(ctx, name)) return null;
  }
  const closures = new Map<StandaloneEs5GlobalFunctionName, StandaloneGlobalFunctionClosure>();
  for (const name of STANDALONE_ES5_GLOBAL_FUNCTION_NAMES) {
    const closure = ensureStandaloneGlobalFunctionClosure(ctx, name);
    if (!closure) return null;
    closures.set(name, closure);
  }

  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return null;
  const body: Instr[] = [];

  for (const name of STANDALONE_ES5_GLOBAL_FUNCTION_NAMES) {
    const closure = closures.get(name)!;
    body.push({ op: "local.get", index: objectLocal });
    addStringConstantGlobal(ctx, name);
    body.push(...stringConstantExternrefInstrs(ctx, name));
    body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" });
    // Host flag bits: writable=1, enumerable=2, configurable=4.
    body.push({ op: "f64.const", value: 0x05 }, { op: "call", funcIdx: defineIdx }, { op: "drop" });
  }
  return body;
}
