// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The call form of a built-in the realm serves: `Object.<name>(…)` with `Object` the unshadowed global and
 * `%Object.<name>%` native in the catalog (`NATIVE_OBJECT_STATICS`), on the lane where the realm holds the program's
 * objects (closures are function objects there). Every argument is lowered as a carrier in source order, an extra one
 * is evaluated and dropped, a missing one is `undefined`; the call is one front-end helper, which the dynamic-value
 * legalization expands (`program/dynamic-object-statics.ts`).
 *
 * The receiver must be the unchanged global `Object` (`builtin-global-binding.ts`: lib-declared only, never assigned);
 * (#7580) A program may replace a static it reaches through `Object` as a value; the legalization then calls the member
 * `Object` holds instead of the fold (the escape rule of `source-plain-objects.ts`).
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
import {
  identityOnlyKeyRefusal,
  nativeConstantStatic,
  nativeObjectStatic,
  realmConstructorId,
  WRAPPER_CONVERSIONS,
} from "./program/builtin-prototype-keys.js";

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
 * (#7574) The `Object` identifier of `Object.prototype.toString.call(v)` (one argument, no spread): the call from-ast
 * lowers as the object tag (`dyn.object_tag`), which reads no value of `Object`.
 */
export function objectTagCallReceiver(call: ts.CallExpression): ts.Identifier | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
  const method = callee.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== "toString") return undefined;
  const prototype = method.expression;
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return undefined;
  const receiver = prototype.expression;
  return ts.isIdentifier(receiver) &&
    receiver.text === "Object" &&
    call.arguments.length === 1 &&
    !ts.isSpreadElement(call.arguments[0]!)
    ? receiver
    : undefined;
}

/**
 * (#7350 B3a, #7574) What `receiver`, the unchanged global of a realm constructor, reads: nothing where it is the
 * receiver of a form the front end folds (`folded`): a constant it holds (`realmConstantRead`), or in callee position,
 * a native `Object` static's call (`nativeObjectStaticCall`) or the object tag (`objectTagCallReceiver`). Any other
 * position (an argument, an operand, `Object.prototype` passed anywhere) is a read of the value; (#7580) where it is
 * the object of a member access, `member` names the key (`Object.defineProperty` read as a value, `X.prototype`).
 */
export function realmReceiverRead(
  receiver: ts.Identifier,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): { readonly folded: boolean; readonly member?: string } {
  const access = receiver.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver) return { folded: false };
  const read = { folded: true, member: access.name.text };
  if (realmConstantRead(access, isPristineGlobal) !== undefined) return read;
  // The member chain `receiver` heads, and the call it is the callee of.
  let callee: ts.Expression = access;
  while (ts.isPropertyAccessExpression(callee.parent) && callee.parent.expression === callee) callee = callee.parent;
  const call = callee.parent;
  const folded =
    ts.isCallExpression(call) &&
    call.expression === callee &&
    (callee === access
      ? nativeObjectStaticCall(call, isPristineGlobal) !== undefined
      : objectTagCallReceiver(call) === receiver);
  return { ...read, folded };
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
 * through the legalization (the lane binds no `js.number.from-value`). Without an argument: `absent`, by default the
 * wrapper's own (`WRAPPER_CONVERSIONS`; `isNaN()` converts `undefined`, NaN).
 */
export function lowerRealmConversionCall(
  call: ts.CallExpression,
  host: FunctionObjectLoweringHost,
  wrapper: "Number" | "Boolean",
  absent: number | boolean = WRAPPER_CONVERSIONS[wrapper].absent,
): IrValueId {
  const [operand, ...extras] = call.arguments;
  const b = host.builder;
  const { to } = WRAPPER_CONVERSIONS[wrapper];
  if (operand === undefined)
    return typeof absent === "number"
      ? b.emitConst({ kind: "f64", value: absent }, irVal({ kind: "f64" }))
      : b.emitConst({ kind: "bool", value: absent }, irVal({ kind: "i32", boolean: true }));
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

/**
 * The own keys of its first argument `Object.<name>` names as constants in `keys`, its second: a string literal key,
 * the names of a literal descriptor map; `create`'s first argument is a prototype, whose own keys it names none of.
 */
function constantOwnKeys(name: NativeObjectStatic, keys: ts.Expression): readonly string[] {
  switch (name) {
    case "create":
      return [];
    case "defineProperties":
      return ts.isObjectLiteralExpression(keys)
        ? keys.properties.flatMap(({ name }) =>
            name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? [name.text] : [],
          )
        : [];
    default:
      return ts.isStringLiteralLike(keys) ? [keys.text] : [];
  }
}

/**
 * (#7350 B3a) The refusal of `Object.<name>(X, …)` where `X` is the pristine global of a realm constructor whose
 * identity row lacks a key the call names as a constant (`identityOnlyKeyRefusal`); a key known only at run time
 * reaches the kernel, which aborts.
 */
function identityOnlyTargetRefusal(
  call: ts.CallExpression,
  name: NativeObjectStatic,
  host: FunctionObjectLoweringHost,
): string | undefined {
  const [target, keys] = call.arguments;
  const ctor =
    target !== undefined && ts.isIdentifier(target) && host.isPristineGlobal(target)
      ? realmConstructorId(target.text)
      : undefined;
  if (ctor === undefined || keys === undefined) return undefined;
  return constantOwnKeys(name, keys)
    .map((key) => identityOnlyKeyRefusal(ctor, key))
    .find((refusal) => refusal !== undefined);
}

/** The lowered call, or `null` when `call` is not such a static here. */
export function tryLowerRealmStaticCall(call: ts.CallExpression, host: FunctionObjectLoweringHost): IrValueId | null {
  if (!createsFunctionObjects(host)) return null;
  const native = nativeObjectStaticCall(call, host.isPristineGlobal);
  if (!native) return null;
  const { name, length } = native;
  const refused = call.arguments.some(ts.isSpreadElement)
    ? `Object.${name} with a spread argument`
    : identityOnlyTargetRefusal(call, name, host);
  if (refused !== undefined)
    throw new IrUnsupportedError("call-resolution-unsupported", "build", `ir/from-ast: ${refused} (${host.funcName})`);
  const values = call.arguments.map((argument) =>
    dynamicStoreOperand(host.lowerExpression(argument), argument, host, "Object static argument"),
  );
  const args = Array.from(
    { length },
    (_, index) => values[index] ?? host.builder.emitDynUndefined(JS_TAG_IDS.Undefined),
  );
  return host.builder.emitCall(irRuntimeFuncRef(objectStaticHelper(name)), args, irDynamic());
}
