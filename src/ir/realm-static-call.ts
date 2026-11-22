// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The call form of a built-in the realm serves: `Object.<name>(…)` with `Object` the unshadowed global and
 * `%Object.<name>%` native in the catalog (`NATIVE_OBJECT_STATICS`), on the lane where the realm holds the program's
 * objects (closures are function objects there). Every argument is lowered as a carrier in source order, an extra one
 * is evaluated and dropped, a missing one is `undefined`; the call is one front-end helper, which the dynamic-value
 * legalization expands (`program/dynamic-object-statics.ts`).
 *
 * Sound without a proof that the static is pristine: `Object` is no value on this path (a read or a write of it
 * refuses), so no program can replace `Object.defineProperty`.
 */
import { ts } from "../ts-api.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irDynamic, type IrValueId } from "./nodes.js";
import {
  createsFunctionObjects,
  dynamicStoreOperand,
  type FunctionObjectLoweringHost,
} from "./function-object-lowering.js";
import { IrUnsupportedError } from "./outcomes.js";
import { JS_TAG_IDS } from "./runtime/js-tag-domain.js";
import { NATIVE_REALM_CATALOG, type NativeObjectStatic } from "../runtime/contracts/native-realm-catalog.js";
import { objectStaticHelper } from "./program/dynamic-object-statics.js";

/** The catalog's native `Object` static `call` names (by syntax alone), with its `length`. */
function nativeObjectStatic(call: ts.CallExpression): { name: NativeObjectStatic; length: number } | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  if (callee.expression.text !== "Object" || callee.questionDotToken || call.questionDotToken) return undefined;
  const row = NATIVE_REALM_CATALOG.intrinsics.find((intrinsic) => intrinsic.id === `%Object.${callee.name.text}%`);
  return row?.callable?.implementation === "native"
    ? { name: callee.name.text as NativeObjectStatic, length: row.callable.length }
    : undefined;
}

/** The catalog's native `Object` static `call` names, by syntax alone. */
export const nativeObjectStaticOf = (call: ts.CallExpression): NativeObjectStatic | undefined =>
  nativeObjectStatic(call)?.name;

/** The lowered call, or `null` when `call` is not such a static here. */
export function tryLowerRealmStaticCall(call: ts.CallExpression, host: FunctionObjectLoweringHost): IrValueId | null {
  const native = nativeObjectStatic(call);
  if (!native || !createsFunctionObjects(host)) return null;
  const { name, length } = native;
  if (!host.isUnshadowedGlobal((call.expression as ts.PropertyAccessExpression).expression, "Object")) return null;
  if (call.arguments.some(ts.isSpreadElement))
    throw new IrUnsupportedError(
      "call-resolution-unsupported",
      "build",
      `ir/from-ast: Object.${name} with a spread argument (${host.funcName})`,
    );
  const values = call.arguments.map((argument) =>
    dynamicStoreOperand(host.lowerExpression(argument), argument, host, "Object static argument"),
  );
  const args = Array.from(
    { length },
    (_, index) => values[index] ?? host.builder.emitDynUndefined(JS_TAG_IDS.Undefined),
  );
  return host.builder.emitCall(irRuntimeFuncRef(objectStaticHelper(name)), args, irDynamic());
}
