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

/**
 * Global constructors not already covered by the namespace seed below.
 *
 * (#5151) The four ES2015 keyed collections are seeded here too: without an own
 * property on the realm object, `verifyProperty(this, 'Map')` reports no own
 * property at all (`built-ins/Map/map.js` and its three siblings).
 */
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
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
] as const;

export function appendStandaloneGlobalConstructorSeeds(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objectLocal: number,
): void {
  if (!ctx.standalone && !ctx.wasi) return;
  // Runtime-eval modules already construct callable constructor carriers at
  // the eval boundary. Re-entering the full constructor emitter while the
  // native global object is itself being built recursively expands Function
  // parity modules and can exhaust codegen's stack. The ES5 reflection row is
  // eval-free, so its concrete constructor-name carriers still take this path.
  if ((ctx.runtimeEvalBoundaryPlan?.sites.length ?? 0) > 0) return;
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
  // A direct/indirect eval boundary already owns `%eval%`'s callable identity
  // and live-environment plumbing. Installing an undefined reflective stub in
  // those modules makes the runtime evaluator observe that stub as the global
  // binding and breaks direct eval before any later realm-property overwrite
  // can help. Eval-free reflection modules still need the key below; modules
  // with an eval boundary either seed the callable global-property wrapper or
  // keep the direct intrinsic path authoritative.
  if ((ctx.runtimeEvalBoundaryPlan?.sites.length ?? 0) > 0) return;
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
