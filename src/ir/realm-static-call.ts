// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The call form of a built-in the realm serves: `Object.<name>(…)` with `Object` the unshadowed global and
 * `%Object.<name>%` native in the catalog (`NATIVE_OBJECT_STATICS`), on the lane where the realm holds the program's
 * objects (closures are function objects there). Every argument is lowered as a carrier in source order, an extra one
 * is evaluated and dropped, a missing one is `undefined`; the call is one front-end helper, which the dynamic-value
 * legalization expands (`program/dynamic-object-statics.ts`).
 *
 * The receiver must be the unchanged global `Object` (`builtin-global-binding.ts`: lib-declared only, never assigned);
 * `Object` is no value on this path (a read refuses), so no program can replace `Object.defineProperty` itself.
 * (#7350 B3a) Beside it, a constant a realm constructor holds (`Number.MAX_VALUE`) and the conversion calls of the
 * wrapper constructors' source-bound plans (`Number(v)`, `Boolean(v)`).
 */
import { ts } from "../ts-api.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { asVal, irDynamic, irVal, type IrValueId } from "./nodes.js";
import {
  createsFunctionObjects,
  dynamicStoreOperand,
  type FunctionObjectLoweringHost,
} from "./function-object-lowering.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { IrFromAstResolver } from "./from-ast.js";
import { JS_TAG_IDS } from "./runtime/js-tag-domain.js";
import type { NativeObjectStatic } from "../runtime/contracts/native-realm-catalog.js";
import { objectStaticHelper } from "./program/dynamic-object-statics.js";
import { nativeConstantStatic, nativeObjectStatic, realmConstructorId } from "./program/builtin-prototype-keys.js";

/**
 * The catalog's native `Object` static `call` names, with its `length`, when the receiver is the unchanged global
 * `Object` (`isPristineGlobal`, `builtin-global-binding.ts`).
 */
export function nativeObjectStaticCall(
  call: ts.CallExpression,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): ReturnType<typeof nativeObjectStatic> {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  if (callee.expression.text !== "Object" || callee.questionDotToken || call.questionDotToken) return undefined;
  return isPristineGlobal(callee.expression) ? nativeObjectStatic(callee.name.text) : undefined;
}

/**
 * (#7350 B3a) `X.<key>` with `X` the unchanged global of a realm constructor and `key` one of its constant value
 * properties (`nativeConstantStatic`: `Number.MAX_VALUE`, …): that number. The fold reads nothing, so the realm holds
 * nothing for it.
 */
export function realmConstantRead(
  access: ts.PropertyAccessExpression,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): number | undefined {
  const receiver = access.expression;
  return ts.isIdentifier(receiver) && isPristineGlobal(receiver)
    ? nativeConstantStatic(receiver.text, access.name.text)
    : undefined;
}

/**
 * `Number.<CONST>` / `Math.<CONST>` as a constant: (#7106 module-init lever A) off the unshadowed ambient namespace,
 * legacy's own (`ambientNamespaceConstant`); (#7350 B3a) else, on the lane where the realm holds the program's objects,
 * one a realm constructor holds ({@link realmConstantRead}).
 */
export function constantMemberRead(
  access: ts.PropertyAccessExpression,
  inScope: (name: string) => boolean,
  resolver: Pick<IrFromAstResolver, "isAmbientBinding" | "ambientNamespaceConstant"> | undefined,
  host: FunctionObjectLoweringHost,
): number | undefined {
  const receiver = access.expression;
  if (ts.isIdentifier(receiver) && !inScope(receiver.text) && resolver?.isAmbientBinding?.(receiver) === true)
    return resolver.ambientNamespaceConstant?.(access);
  return createsFunctionObjects(host) ? realmConstantRead(access, host.isPristineGlobal) : undefined;
}

/**
 * (#7350 B3a) A source-bound conversion call on that lane (`prepare-number-conversion.ts`): `Number(v)`'s or (#7354 T)
 * `isNaN(v)`'s ToNumber, or `Boolean(v)`'s ToBoolean, of the first argument; every extra one is evaluated and dropped,
 * in source order, before the conversion. A number or a Boolean converts inline, any other operand as a carrier
 * through the legalization (the lane binds no `js.number.from-value`). Without an argument: `absent`, or false.
 */
export function lowerRealmConversionCall(
  call: ts.CallExpression,
  host: FunctionObjectLoweringHost,
  to: "number" | "boolean",
  absent = 0,
): IrValueId {
  const [operand, ...extras] = call.arguments;
  const b = host.builder;
  if (operand === undefined)
    return to === "number"
      ? b.emitConst({ kind: "f64", value: absent }, irVal({ kind: "f64" }))
      : b.emitConst({ kind: "bool", value: false }, irVal({ kind: "i32", boolean: true }));
  const value = host.lowerExpression(operand);
  extras.forEach((extra) => host.lowerExpression(extra));
  const scalar = asVal(b.typeOf(value));
  if (scalar?.kind === "f64" && to === "number") return value;
  if (scalar?.kind === "i32" && scalar.boolean === true)
    return to === "boolean" ? value : b.emitUnary("f64.convert_i32_s", value, irVal({ kind: "f64" }));
  const carried = dynamicStoreOperand(value, operand, host, "conversion operand");
  if (to === "number") return b.emitDynToNumber(carried);
  // ToBoolean is `!!v`: `dyn.truthy` answers an i32, which each negation makes a JS Boolean.
  const not = (v: IrValueId) => b.emitUnary("i32.eqz", v, irVal({ kind: "i32", boolean: true }));
  return not(not(b.emitDynTruthy(carried)));
}

/**
 * How deep an argument's object literals hold descriptor fields: a descriptor (`defineProperty`'s third argument) one
 * level, a map of descriptors (`defineProperties`' and `create`'s second) two; any other argument none.
 */
const DESCRIPTOR_DEPTH: Readonly<Record<NativeObjectStatic, readonly number[]>> = {
  defineProperty: [0, 0, 1],
  defineProperties: [0, 2],
  create: [0, 2],
  getOwnPropertyDescriptor: [0, 0],
};

/**
 * (#7354 O1) The flow rule's exemption: an argument of a native `Object` static, or a descriptor field (name or value)
 * of a literal descriptor or descriptor map passed as one, is taken as a carrier whatever the lib's signature types it
 * (`PropertyDescriptor`'s `enumerable: boolean` does not bind a test262 `enumerable: 1`); (#7354 G1) so is an argument
 * of a call or `new` of an Error constructor the realm holds, or a field of a literal passed as one (the lib's
 * `message?: string` does not bind a message object, which ToString reads through the program).
 */
export function realmBuiltinOperand(
  node: ts.Expression,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): boolean {
  let operand: ts.Expression = node;
  let depth = 0;
  for (; ts.isPropertyAssignment(operand.parent); depth++) operand = operand.parent.parent;
  const call = operand.parent;
  if (
    (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
    call.arguments?.includes(operand) === true &&
    ts.isIdentifier(call.expression) &&
    realmConstructorId(call.expression.text)?.family === "error" &&
    isPristineGlobal(call.expression)
  )
    return true;
  if (!ts.isCallExpression(call)) return false;
  const name = nativeObjectStaticCall(call, isPristineGlobal)?.name;
  const index = call.arguments.indexOf(operand);
  return name !== undefined && index >= 0 && depth <= (DESCRIPTOR_DEPTH[name][index] ?? 0);
}

/** The lowered call, or `null` when `call` is not such a static here. */
export function tryLowerRealmStaticCall(call: ts.CallExpression, host: FunctionObjectLoweringHost): IrValueId | null {
  if (!createsFunctionObjects(host)) return null;
  const native = nativeObjectStaticCall(call, host.isPristineGlobal);
  if (!native) return null;
  const { name, length } = native;
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
