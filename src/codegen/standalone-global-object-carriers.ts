// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isSupportedBuiltinNamespace,
} from "./builtin-static-globals.js";
import { emitStandaloneFunctionIntrinsicValue } from "./function-intrinsic-carrier.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** Seed the existing namespace carriers on the same native realm object. */
export function appendStandaloneGlobalNamespaceSeeds(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objectLocal: number,
): void {
  for (const name of ["Array", "Object", "JSON", "Math", "Proxy", "Reflect"] as const) {
    fctx.body.push({ op: "local.get", index: objectLocal });
    addStringConstantGlobal(ctx, name);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, name));
    if (emitBuiltinNamespaceObject(ctx, fctx, name) === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const defineIdx = ctx.funcMap.get("__defineProperty_value");
    if (defineIdx === undefined) {
      fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" });
      continue;
    }
    fctx.body.push({ op: "f64.const", value: 0x05 }, { op: "call", funcIdx: defineIdx }, { op: "drop" });
  }
}

/** ES5 global constructors not already covered by the namespace seed below. */
const STANDALONE_GLOBAL_CONSTRUCTOR_NAMES = [
  "Function",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

export function appendStandaloneGlobalConstructorSeeds(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objectLocal: number,
): void {
  if (!ctx.standalone && !ctx.wasi) return;
  for (const name of STANDALONE_GLOBAL_CONSTRUCTOR_NAMES) {
    fctx.body.push({ op: "local.get", index: objectLocal });
    addStringConstantGlobal(ctx, name);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, name));

    const valueType =
      name === "Function"
        ? (emitStandaloneFunctionIntrinsicValue(ctx, fctx) ?? emitBuiltinConstructorIdentity(ctx, fctx, name))
        : isSupportedBuiltinNamespace(name)
          ? emitBuiltinNamespaceObject(ctx, fctx, name)
          : emitBuiltinConstructorIdentity(ctx, fctx, name);

    if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (valueType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    const liveDefineIdx = ctx.funcMap.get("__defineProperty_value");
    if (liveDefineIdx === undefined) {
      fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" });
      continue;
    }
    fctx.body.push({ op: "f64.const", value: 0x05 }, { op: "call", funcIdx: liveDefineIdx }, { op: "drop" });
  }
}

export function appendStandaloneGlobalEvalSeed(ctx: CodegenContext, fctx: FunctionContext, objectLocal: number): void {
  // The key must exist for ES5 reflection. A demand-gated runtime-eval wrapper
  // may replace this undefined value when a callable eval property is needed.
  if (!ctx.standalone && !ctx.wasi) return;
  fctx.body.push({ op: "local.get", index: objectLocal });
  addStringConstantGlobal(ctx, "eval");
  fctx.body.push(
    ...stringConstantExternrefInstrs(ctx, "eval"),
    ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]),
  );
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" });
    return;
  }
  fctx.body.push({ op: "f64.const", value: 0x05 }, { op: "call", funcIdx: defineIdx }, { op: "drop" });
}

export function appendStandaloneGlobalObjectCarrierSeeds(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objectLocal: number,
): void {
  appendStandaloneGlobalConstructorSeeds(ctx, fctx, objectLocal);
}

/** Build eval's seed separately so a demand-gated callable can overwrite it. */
export function standaloneGlobalEvalSeedInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objectLocal: number,
): Instr[] {
  const body: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = body;
  ctx.liveBodies.add(body);
  try {
    appendStandaloneGlobalEvalSeed(ctx, fctx, objectLocal);
  } finally {
    fctx.body = savedBody;
  }
  return body;
}
