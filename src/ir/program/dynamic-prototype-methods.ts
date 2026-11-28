// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 P1, G1) The dynamic-value legalization of a call whose callee may be a built-in the realm holds, answered by
 * the callee's identity with the realm's function object: the Object.prototype methods held by name, the conversion
 * methods of `conversionMethodTests` (`Error.prototype.toString`, (#7561) a wrapper's `valueOf` / `toString`, (#7574)
 * Object.prototype's), (#7352) `Array.isArray`, (#7580) the `Object` statics the program reads as values and (#7557)
 * `Function.prototype` itself. Each answers the built-in's own algorithm, because its steps (ToPropertyKey, ToString)
 * can call the program's code, which only the program can run (`stringOf`).
 *
 * (#7557) {@link heldBuiltinRungs} is the one list of those tests over a {@link BuiltinCall}. A method call `o.m(v)`
 * tests the rungs named `m` at its site, a detached call (`var d = Object.defineProperty; d(o, k, v)`) the rungs that
 * read no `this`; any other built-in reached through a value is the dispatcher's built-in arm, which calls the realm's
 * built-in caller, whose body tests every rung (`dynamic-builtin-call.ts`). Where the program creates no source
 * function no dispatcher exists: the site tests those rungs first, then the others, and any other callee is the
 * run-time abort.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { closureMethodArity } from "../core/closure-invocation-callables.js";
import {
  FUNCTION_PROTOTYPE_ID,
  IS_ARRAY_ID,
  NATIVE_OBJECT_PROTOTYPE_METHODS,
  REALM_BRAND,
  nativeObjectStatic,
  objectPrototypeMethodId,
} from "./builtin-prototype-keys.js";
import {
  builtinMethodChain,
  conversionMethodTests,
  identityTest,
  unlessUnheldOwnKey,
  type BuiltinMethodTest,
} from "./dynamic-builtin-methods.js";
import { constantArgumentOf, constantKeyOf } from "./dynamic-member-access.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import { BOOLEAN, CARRIER, carried } from "./dynamic-value-types.js";
import { MEMBER_ACCESS_ARM, holdsFamily, isOrdinaryObject, type CarrierKind } from "./dynamic-value-kinds.js";
import { objectStaticTest, toPropertyKey, type ObjectStaticBuilders } from "./dynamic-object-statics.js";
import { functionChainAnswer } from "./dynamic-function-operations.js";

export type Call = Extract<IrInstr, { kind: "call" }>;
type Arm = (result: IrValueId) => IrInstr[];

/**
 * (#7557) A call of a built-in: its `this` and its arguments (`args[i]`, absent where the call passes none). A method
 * call's receiver is never `undefined` or `null` (the [[Get]] that read the callee threw); a `detached` one, the
 * caller's `this`, may be any value.
 */
export interface BuiltinCall {
  readonly instr: Call;
  readonly receiver: IrValueId;
  readonly args: readonly IrValueId[];
  readonly detached: boolean;
}
/**
 * A built-in a callee may be: its name (`hasOwnProperty`, `toString`, …) and its identity test. `thisless`: it reads no
 * `this`, so a detached call may be it at the call's own site, whose constant arguments (the key a query of the root
 * pins, `unlessUnheldOwnKey`) the caller's vector does not carry.
 */
interface BuiltinRung {
  readonly name: string;
  readonly thisless?: boolean;
  readonly test: () => BuiltinMethodTest;
}

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

/** The kinds the call's receiver may hold that ToObject(this value) admits: all of them for a detached call. */
const receiverKinds = (b: ObjectStaticBuilders, call: BuiltinCall): readonly CarrierKind[] =>
  b.kinds.kindsOf(call.receiver).filter((kind) => call.detached || MEMBER_ACCESS_ARM[kind] !== "type-error");

/** ToObject(this value)'s TypeError for an `undefined` or `null` receiver, into the arm's unread answer. */
const toObjectTypeError = (b: ObjectStaticBuilders, call: BuiltinCall, r: IrValueId): IrInstr[] =>
  typeErrorThen(
    { ...b, carrier: CARRIER },
    "Cannot convert undefined or null to object",
    b.intrinsic(call.instr, "js.value.undefined", [], r),
  );

/**
 * §20.1.3.2 / §20.1.3.4: ToPropertyKey(V) first, then ToObject(this value) and its own property `P` (enumerable too
 * for `propertyIsEnumerable`). An ordinary object's or a function's own properties are the kernel's; a number's or a
 * Boolean's wrapper owns none; a string's own `length` and indices need the String exotic the realm lacks: the run-time
 * abort.
 */
function ownProperty(b: ObjectStaticBuilders, call: BuiltinCall, enumerable: boolean, result: IrValueId): IrInstr[] {
  const { instr, receiver } = call;
  const argument = call.args[0];
  const [text, key] = [b.fresh(), b.fresh()];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "object":
      case "function": {
        const own = (s: IrValueId) =>
          boxed(b, instr, (t) => b.selectorCall("js.object.has-own", [receiver, key], Number(enumerable), t), s);
        const known = argument === undefined ? "undefined" : constantArgumentOf(b.definitions, argument);
        return unlessUnheldOwnKey(b, instr, b.program, receiver, known, own)(r);
      }
      case "type-error":
        return toObjectTypeError(b, call, r);
      default:
        return kind === "number" || kind === "boolean" ? boxed(b, instr, constant(false), r) : b.abort(instr, r);
    }
  };
  return [
    // A missing argument is `undefined`, whose ToString is "undefined".
    ...(argument === undefined ? [b.text("undefined", text)] : toPropertyKey(b, instr, argument, text)),
    carried(text, key),
    ...b.kindChain(instr, receiver, result, arm, receiverKinds(b, call), CARRIER),
  ];
}

/**
 * §20.1.3.3: a V that is not an object answers false before ToObject(this value); else V's [[Prototype]] chain is
 * walked for `this`. Only an ordinary object's chain can hold a value the program has (an error's included); a
 * function's holds the realm's built-in prototypes alone (`functionChainAnswer`).
 */
function prototypeOf(b: ObjectStaticBuilders, call: BuiltinCall, result: IrValueId): IrInstr[] {
  const { instr, receiver } = call;
  const argument = call.args[0];
  if (argument === undefined) return boxed(b, instr, constant(false), result);
  const walk = (kind: CarrierKind) =>
    isOrdinaryObject(kind)
      ? (s: IrValueId) => [realmCall("js.object.inherits", [argument, receiver], s)]
      : kind === "function"
        ? (s: IrValueId) => functionChainAnswer(b, instr, b.program, argument, receiver, constant(false), s, BOOLEAN)
        : constant(false);
  const onObject = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    b.kindChain(
      instr,
      receiver,
      r,
      (thisKind, s) =>
        MEMBER_ACCESS_ARM[thisKind] === "type-error" ? toObjectTypeError(b, call, s) : boxed(b, instr, walk(kind), s),
      receiverKinds(b, call),
      CARRIER,
    );
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    kind === "function" || isOrdinaryObject(kind) ? onObject(kind, r) : boxed(b, instr, constant(false), r);
  return b.kindChain(instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/** (#7352) §23.1.2.2 IsArray of the call's first argument: the realm's array brand of an object, else `false`. */
function isArray(b: ObjectStaticBuilders, call: BuiltinCall, result: IrValueId): IrInstr[] {
  const argument = call.args[0];
  if (argument === undefined) return boxed(b, call.instr, constant(false), result);
  const brand = (s: IrValueId) => b.selectorCall("js.object.has-brand", [argument], REALM_BRAND.array, s);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] =>
    boxed(b, call.instr, isOrdinaryObject(kind) ? brand : constant(false), r);
  return b.kindChain(call.instr, argument, result, arm, b.kinds.kindsOf(argument), CARRIER);
}

/**
 * (#7557) Every built-in the realm may hold that a call through `callee` can answer, in the order a call tests them:
 * the Object.prototype methods whose names the source spells, the conversion methods, `Array.isArray` where the program
 * holds the Array family, the statics it reads as values, and `Function.prototype` (whose call answers `undefined`)
 * where it holds the Function family. `radix`: Number.prototype.toString may meet an argument (`conversionMethodTests`).
 */
export function heldBuiltinRungs(
  b: ObjectStaticBuilders,
  call: BuiltinCall,
  callee: IrValueId,
  radix: boolean,
): BuiltinRung[] {
  const { instr, receiver } = call;
  const { objects } = b.program;
  const conversion = (name: "toString" | "valueOf") =>
    conversionMethodTests(b, instr, b.program, name, callee, receiver, radix, call.detached).map((test) => ({
      name,
      test,
    }));
  return [
    ...NATIVE_OBJECT_PROTOTYPE_METHODS.filter((name) => objects.prototypeMethodNames.has(name)).map((name) => ({
      name,
      test: () =>
        identityTest(b, instr, objectPrototypeMethodId(name), callee, (r) =>
          name === "isPrototypeOf" ? prototypeOf(b, call, r) : ownProperty(b, call, name === "propertyIsEnumerable", r),
        ),
    })),
    ...conversion("toString"),
    ...conversion("valueOf"),
    ...(holdsFamily(b.program, "array")
      ? [
          {
            name: "isArray",
            thisless: true,
            test: () => identityTest(b, instr, IS_ARRAY_ID, callee, (r) => isArray(b, call, r)),
          },
        ]
      : []),
    ...[...objects.staticValues].flatMap((value) => {
      const native = nativeObjectStatic(value)?.name;
      return native === undefined
        ? []
        : [
            {
              name: native,
              thisless: true,
              test: () => objectStaticTest(b, instr, native, callee, call.args),
            },
          ];
    }),
    ...(holdsFamily(b.program, "function")
      ? [
          {
            name: "",
            test: () =>
              identityTest(b, instr, FUNCTION_PROTOTYPE_ID, callee, (r) => [
                b.intrinsic(instr, "js.value.undefined", [], r),
              ]),
          },
        ]
      : []),
  ];
}

/**
 * The legalized dispatcher call, where its callee may be a built-in the realm holds: the site's rungs (the module doc;
 * without a dispatcher, every rung), each answering where the callee is it (`builtinMethodChain`),
 * else the call as it was (or, without a dispatcher, the run-time abort); `undefined` for any other call.
 */
export function dynamicPrototypeMethodCall(
  b: ObjectStaticBuilders,
  instr: Call,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): IrInstr[] | undefined {
  if (closureMethodArity(instr.target.name) === undefined) return undefined;
  const name = methodNameOfCall(instr, definitions);
  const [receiver, callee, ...args] = instr.args as [IrValueId, IrValueId, ...IrValueId[]];
  const call: BuiltinCall = { instr, receiver, args, detached: name === undefined };
  const rungs = heldBuiltinRungs(b, call, callee, args.length > 0);
  const atSite = (rung: BuiltinRung): boolean => rung.name === name || (call.detached && rung.thisless === true);
  const dispatcher = b.program.objects.functions;
  const tests = (dispatcher ? rungs.filter(atSite) : [...rungs.filter(atSite), ...rungs.filter((r) => !atSite(r))]).map(
    (rung) => rung.test,
  );
  if (tests.length === 0) return undefined;
  const otherwise = (r: IrValueId): IrInstr[] =>
    dispatcher ? [{ ...instr, result: r, resultType: CARRIER }] : b.abort(instr, r);
  return builtinMethodChain(b, tests, otherwise, CARRIER)(instr.result!);
}
