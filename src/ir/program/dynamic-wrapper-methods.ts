// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The wrapper prototypes' `valueOf` and `toString` (§22.1.3.35 / §22.1.3.29, §21.1.3.7 / §21.1.3.6,
 * §20.3.3.3 / §20.3.3.2): built-ins the dispatcher cannot call, so the legalization writes their algorithm where it
 * proves a call reaches one, by identity (OrdinaryToPrimitive, `ordinary-to-primitive.ts`; a method call,
 * `dynamic-prototype-methods.ts`).
 *
 * Each is thisXValue(this) (§22.1.3.35.1 thisStringValue and its siblings): a primitive of the kind is itself, a
 * wrapper's slot is read (`js.object.primitive-data`, `undefined` for no wrapper), anything else is a TypeError; then
 * `toString` is ToString of that primitive (Number.prototype.toString's radix is the caller's to refuse).
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { NATIVE_WRAPPER_CONSTRUCTORS, realmMethodId } from "../../runtime/contracts/native-realm-catalog.js";
import { realmCall, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";

/** The legalization's builders these methods are written with. */
export interface WrapperMethodBuilders extends TypeErrorBuilders {
  readonly intrinsic: (
    instr: IrInstr,
    id: IntrinsicId,
    args: readonly IrValueId[],
    result?: IrValueId | null,
  ) => IrInstr;
  readonly kinds: {
    readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
    readonly learn: (value: IrValueId, kinds: readonly CarrierKind[]) => void;
  };
  readonly anyKind: (instr: IrInstr, of: readonly CarrierKind[], value: IrValueId, result: IrValueId) => IrInstr[];
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType?: IrType,
  ) => IrInstr;
  readonly kindChain: (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[],
    resultType: IrType,
  ) => IrInstr[];
  readonly stringOf: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
}

/** The primitive kind of each wrapper. */
const KIND = { String: "string", Number: "number", Boolean: "boolean" } as const;
type Wrapper = keyof typeof KIND;
const METHODS = ["valueOf", "toString"] as const;

/** The method ids of the wrapper families `held` (catalog ids of their constructors). */
export function wrapperMethods(held: ReadonlySet<string>): string[] {
  return NATIVE_WRAPPER_CONSTRUCTORS.filter((name) => held.has(`%${name}%`)).flatMap((name) =>
    METHODS.map((method) => realmMethodId(name + ".prototype", method)),
  );
}

/** The wrapper and method an id of {@link wrapperMethods} names. */
const parse = (id: string): { readonly wrapper: Wrapper; readonly method: (typeof METHODS)[number] } => {
  const [wrapper, , method] = id.slice(1, -1).split(".") as [Wrapper, string, (typeof METHODS)[number]];
  return { wrapper, method };
};

/** thisXValue(`receiver`) of `wrapper` into `result`: the primitive, or a TypeError. */
function thisPrimitiveValue(
  b: WrapperMethodBuilders,
  instr: IrInstr,
  id: string,
  receiver: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const { wrapper, method } = parse(id);
  const kind = KIND[wrapper];
  const unread = (r: IrValueId) => b.intrinsic(instr, "js.value.undefined", [], r);
  const fails = (r: IrValueId) =>
    typeErrorThen(b, `${wrapper}.prototype.${method} requires that 'this' be a ${wrapper}`, unread(r));
  const itself =
    (value: IrValueId) =>
    (r: IrValueId): IrInstr[] => [{ kind: "coerce.to_externref", value, result: r, resultType: b.carrier }];
  const arm = (held: CarrierKind, r: IrValueId): IrInstr[] => {
    if (held === kind) return itself(receiver)(r);
    if (held !== "object") return fails(r);
    const [data, same] = [b.fresh(), b.fresh()];
    return [
      realmCall("js.object.primitive-data", [receiver], data),
      ...b.anyKind(instr, [kind], data, same),
      b.branch(same, itself(data), fails, r, b.carrier),
    ];
  };
  return b.kindChain(instr, receiver, result, arm, b.kinds.kindsOf(receiver), b.carrier);
}

/** The method `id` of {@link wrapperMethods} with `receiver` as `this`, into `result` (a carrier value). */
export function wrapperMethodAnswer(
  b: WrapperMethodBuilders,
  instr: IrInstr,
  id: string,
  receiver: IrValueId,
  result: IrValueId,
): IrInstr[] {
  if (parse(id).method === "valueOf") return thisPrimitiveValue(b, instr, id, receiver, result);
  const [value, text] = [b.fresh(), b.fresh()];
  const primitive = thisPrimitiveValue(b, instr, id, receiver, value);
  b.kinds.learn(value, [KIND[parse(id).wrapper]]);
  return [
    ...primitive,
    ...b.stringOf(instr, value, text),
    { kind: "coerce.to_externref", value: text, result, resultType: b.carrier },
  ];
}
