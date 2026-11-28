// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 P1, G1) The dynamic-value legalization of a call of a prototype method the realm holds (an Object.prototype
 * method of `NATIVE_OBJECT_PROTOTYPE_METHODS`, and the conversion methods of `conversionMethodTests`:
 * `Error.prototype.toString` where the program holds the Error family, (#7561) a wrapper's `valueOf` / `toString`):
 * `o.m(v)` is F2's [[Get]] of `m` on the once-evaluated receiver, then the
 * dispatcher's call with the receiver as `this`. Where the callee is that [[Get]], the call is the method's own
 * algorithm when the value read is the realm's built-in (an own property, a user prototype's method or a write to `m`
 * is any other value, and takes the dispatcher), because the algorithm's first step, ToPropertyKey, can call the key's
 * `toString`, which only the program can run (`stringOf`). Called through any other value the built-in is the
 * dispatcher's run-time abort.
 *
 * Only the method-call shape `o.m(v)` is such a call: its receiver is the receiver of the [[Get]] that read the callee,
 * so it is never `undefined` or `null` (that [[Get]] threw). A detached call (`var h = o.m; h(v)`) has another
 * receiver and takes the dispatcher.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { closureMethodArity } from "../core/closure-invocation-callables.js";
import { nativeObjectPrototypeMethod, objectPrototypeMethodId } from "./builtin-prototype-keys.js";
import {
  builtinMethodChain,
  conversionMethodTests,
  identityTest,
  unlessStringObject,
} from "./dynamic-builtin-methods.js";
import { constantArgumentOf, constantKeyOf } from "./dynamic-member-access.js";
import { realmCall } from "./dynamic-realm-calls.js";
import { CARRIER, carried } from "./dynamic-value-chains.js";
import { MEMBER_ACCESS_ARM, isOrdinaryObject, type CarrierKind } from "./dynamic-value-kinds.js";
import { toPropertyKey, type ObjectStaticBuilders } from "./dynamic-object-statics.js";
import { functionChainAnswer } from "./dynamic-error-constructors.js";

type Call = Extract<IrInstr, { kind: "call" }>;
const isObjectCoercible = (kind: CarrierKind): boolean => MEMBER_ACCESS_ARM[kind] !== "type-error";

/** The Boolean the realm's tests answer, boxed into the call's carrier. */
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The name `call` calls, when it is `o.m(…)`: the dispatcher's call of a [[Get]] of a constant key on its receiver. */
function methodNameOfCall(call: Call, definitions: ReadonlyMap<IrValueId, IrInstr>): string | undefined {
  if (closureMethodArity(call.target.name) === undefined) return undefined;
  const uncoerced = (value: IrValueId): IrValueId => {
    const definition = definitions.get(value);
    return definition?.kind === "coerce.to_externref" ? definition.value : value;
  };
  const callee = definitions.get(uncoerced(call.args[1]!));
  if (callee?.kind !== "dyn.member_get" || callee.recv !== uncoerced(call.args[0]!)) return undefined;
  return constantKeyOf(definitions, callee.key);
}

/** `value`, the realm's Boolean of `test`, boxed into the carrier `result`. */
function boxed(b: ObjectStaticBuilders, instr: Call, test: (value: IrValueId) => IrInstr[], result: IrValueId) {
  const value = b.fresh();
  return [...test(value), b.intrinsic(instr, "js.boolean.box", [value], result)];
}
const constant =
  (answer: boolean) =>
  (result: IrValueId): IrInstr[] => [
    { kind: "const", value: { kind: "bool", value: answer }, result, resultType: BOOLEAN },
  ];

/**
 * §20.1.3.2 / §20.1.3.4: ToPropertyKey(V) first, then ToObject(this value) and its own property `P` (enumerable too
 * for `propertyIsEnumerable`). An ordinary object's or a function's own properties are the kernel's; a number's or a
 * Boolean's wrapper owns none; a string's own `length` and indices need the String exotic the realm lacks: the run-time
 * abort.
 */
function ownProperty(
  b: ObjectStaticBuilders,
  instr: Call,
  method: "hasOwnProperty" | "propertyIsEnumerable",
  result: IrValueId,
): IrInstr[] {
  const [receiver, , argument] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  const [text, key] = [b.fresh(), b.fresh()];
  const enumerable = method === "propertyIsEnumerable";
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "object":
      case "function": {
        const own = (s: IrValueId) =>
          boxed(b, instr, (t) => b.selectorCall("js.object.has-own", [receiver, key], Number(enumerable), t), s);
        const known = argument === undefined ? "undefined" : constantArgumentOf(b.definitions, argument);
        return unlessStringObject(b, instr, b.program, receiver, known, own)(r);
      }
      default:
        return kind === "number" || kind === "boolean"
          ? boxed(b, instr, constant(false), r)
          : b.abort(instr, `Object.prototype.${method} on a string: needs its own length and index properties`, r);
    }
  };
  return [
    // A missing argument is `undefined`, whose ToString is "undefined".
    ...(argument === undefined ? [b.text("undefined", text)] : toPropertyKey(b, instr, argument, text)),
    carried(text, key),
    // The receiver is no `undefined` or `null` (the module doc), so the chain runs over its other kinds.
    ...b.kindChain(instr, receiver, result, arm, b.kinds.kindsOf(receiver).filter(isObjectCoercible), CARRIER),
  ];
}

/**
 * §20.1.3.3: a V that is not an object answers false before ToObject(this value); else V's [[Prototype]] chain is
 * walked for `this`. Only an ordinary object's chain can hold a value the program has (an error's included); a
 * function's holds the realm's built-in prototypes alone, which no program obtains (M1), but (#7354 G1) %Error%
 * (`functionChainAnswer`).
 */
function prototypeOf(b: ObjectStaticBuilders, instr: Call, result: IrValueId): IrInstr[] {
  const [receiver, , argument] = instr.args as [IrValueId, IrValueId, IrValueId | undefined];
  if (argument === undefined) return boxed(b, instr, constant(false), result);
  const walk = (kind: CarrierKind) =>
    isOrdinaryObject(kind)
      ? (s: IrValueId) => [realmCall("js.object.inherits", [argument, receiver], s)]
      : kind === "function"
        ? (s: IrValueId) => functionChainAnswer(b, instr, b.errors, receiver, constant(false), s, BOOLEAN)
        : constant(false);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => boxed(b, instr, walk(kind), r);
  return b.kindChain(instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/**
 * The legalized `o.m(…)`, where `m` may be a method the realm holds: each such method's algorithm where the callee is
 * it (`builtinMethodChain`), else the call as it was; `undefined` for any other call.
 */
export function dynamicPrototypeMethodCall(
  b: ObjectStaticBuilders,
  instr: Call,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): IrInstr[] | undefined {
  const name = methodNameOfCall(instr, definitions);
  if (name === undefined) return undefined;
  const [receiver, callee] = instr.args as [IrValueId, IrValueId];
  const method = nativeObjectPrototypeMethod(name);
  const algorithm =
    (held: NonNullable<typeof method>) =>
    (r: IrValueId): IrInstr[] =>
      held === "isPrototypeOf" ? prototypeOf(b, instr, r) : ownProperty(b, instr, held, r);
  const tests = [
    ...(method === undefined
      ? []
      : [() => identityTest(b, instr, objectPrototypeMethodId(method), callee, algorithm(method))]),
    ...conversionMethodTests(b, instr, b.program, name, callee, receiver, instr.args.length > 2),
  ];
  if (tests.length === 0) return undefined;
  const call = (r: IrValueId): IrInstr[] => [{ ...instr, result: r, resultType: CARRIER }];
  return builtinMethodChain(b, tests, call, CARRIER)(instr.result!);
}
