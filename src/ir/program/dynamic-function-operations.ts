// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 C2) The dynamic-value legalization of the three operations a plain function takes part in as an object:
 * `this` (`dyn.current_this`), `new` (`dyn.construct`) and `instanceof` (`dyn.instanceof`). Each is a chain over the
 * kinds its operands may hold (`dynamic-value-kinds.ts`) around the realm's function objects (`js.object.*`) and the
 * native dispatcher (`js.closure.*`): the dispatcher installs a call's receiver in `__current_this`, pads and drops
 * arguments and throws its TypeError for a value that is no source closure, so [[Construct]] is its call with the new
 * object as the receiver.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { IR_CLOSURE_RECEIVER, irClosureMethodReference } from "../core/closure-invocation-callables.js";
import { realmCall, typeError } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";
import { CARRIER, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import { IS_OBJECT, ORDINARY_CHAIN, type CarrierKind, type LegalizationProgram } from "./dynamic-value-kinds.js";

type CurrentThis = Extract<IrInstr, { kind: "dyn.current_this" }>;
type Construct = Extract<IrInstr, { kind: "dyn.construct" }>;
type InstanceOf = Extract<IrInstr, { kind: "dyn.instanceof" }>;

const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The one legalization's builders, beside the kinds it proves and the program it answers for. */
type Builders = ChainBuilders & { readonly program: LegalizationProgram };

const boolean = (value: boolean, result: IrValueId): IrInstr => ({
  kind: "const",
  value: { kind: "bool", value },
  result,
  resultType: BOOLEAN,
});

/**
 * Whether the once-evaluated `value` is one of `of`, into a fresh value: the kind tests of those `value` may hold, or
 * constant where it may hold all of them or none.
 */
function holds(b: Builders, instr: IrInstr, value: IrValueId, of: readonly CarrierKind[]) {
  const held = b.kinds.kindsOf(value);
  const cond = b.fresh();
  const tested = held.filter((kind) => of.includes(kind));
  const instrs =
    tested.length === held.length || tested.length === 0
      ? [boolean(tested.length !== 0, cond)]
      : b.anyKind(instr, tested, value, cond);
  return { instrs, cond };
}

/** A TypeError with `message`, then the arm's unread `answer` into `result`. */
const throwing = (b: Builders, message: string, answer: (result: IrValueId) => IrInstr) => (result: IrValueId) => [
  ...typeError({ ...b, carrier: CARRIER }, message),
  answer(result),
];

/**
 * OrdinaryCallBindThis (§10.2.1.2) over the receiver the dispatcher installed: strict code takes it as is, sloppy
 * code takes an object as is (ToObject of an object). (C2-D3) Sloppy code with `undefined`, `null` or a primitive
 * would take the global object or a wrapper, which the realm does not have: the run-time abort, never a stand-in (a
 * stand-in global object would let `this.x = 1` miss the global `x`).
 */
export function dynamicCurrentThis(b: Builders, instr: CurrentThis): IrInstr[] {
  const receiver = instr.strict ? instr.result! : b.fresh();
  const read: IrInstr = {
    kind: "call",
    target: irIntrinsicFuncRef(IR_CLOSURE_RECEIVER),
    args: [],
    result: receiver,
    resultType: CARRIER,
  };
  if (instr.strict) return [read];
  const objects = b.admitted.filter((kind) => IS_OBJECT[kind]);
  b.kinds.learn(instr.result!, objects);
  const { instrs, cond } = holds(b, instr, receiver, objects);
  return [
    read,
    ...instrs,
    b.branch(
      cond,
      (r) => [carried(receiver, r)],
      (r) => b.abort(instr, r),
      instr.result!,
      CARRIER,
    ),
  ];
}

/**
 * `new C(…args)` (§13.3.5.1.1 EvaluateNew, after its operands): IsConstructor(C), else a TypeError; then [[Construct]]
 * (§10.2.2): OrdinaryCreateFromConstructor reads C's `prototype` once and links the new object to it if it is an
 * object (`ORDINARY_CHAIN`; another object kind is the run-time abort) or else to the realm's Object.prototype; the
 * body runs with the new object as `this` (the dispatcher); an object result (`IS_OBJECT`) replaces the new object.
 */
export function dynamicConstruct(b: Builders, instr: Construct): IrInstr[] {
  const { callee, args } = instr;
  const result = instr.result!;
  const objects = b.admitted.filter((kind) => IS_OBJECT[kind]);
  b.kinds.learn(result, objects);
  const notConstructor = throwing(b, "Value is not a constructor", (r) =>
    b.intrinsic(instr, "js.value.undefined", [], r),
  );
  // Only a function value may be a constructor: a callee that holds none is always the TypeError.
  if (!b.kinds.kindsOf(callee).includes("function")) return notConstructor(result);
  const callable = holds(b, instr, callee, ["function"]);
  const isConstructor = b.fresh();
  const construct = (r: IrValueId): IrInstr[] => {
    const [name, key, prototype, object, answer] = Array.from({ length: 5 }, b.fresh);
    const link = (kind: CarrierKind, s: IrValueId): IrInstr[] =>
      ORDINARY_CHAIN[kind]
        ? [realmCall("js.object.create-with-prototype", [prototype], s)]
        : IS_OBJECT[kind]
          ? b.abort(instr, s)
          : [realmCall("js.object.create-default", [], s)];
    const isObject = holds(b, instr, answer, objects);
    return [
      b.text("prototype", name),
      carried(name, key),
      realmCall("js.object.get", [callee, key, callee], prototype),
      ...b.kindChain(instr, prototype, object, link, b.admitted, CARRIER),
      {
        kind: "call",
        target: irClosureMethodReference(args.length),
        args: [object, callee, ...args],
        result: answer,
        resultType: CARRIER,
      },
      ...isObject.instrs,
      b.branch(
        isObject.cond,
        (s) => [carried(answer, s)],
        (s) => [carried(object, s)],
        r,
        CARRIER,
      ),
    ];
  };
  return [
    ...callable.instrs,
    b.branch(
      callable.cond,
      (r) => [realmCall("js.object.is-constructor", [callee], r)],
      (r) => [boolean(false, r)],
      isConstructor,
      BOOLEAN,
    ),
    b.branch(isConstructor, construct, notConstructor, result, CARRIER),
  ];
}

/**
 * `v instanceof C` (§13.10.2 InstanceofOperator) without `@@hasInstance`, which only a program that names `Symbol`
 * can reach: IsCallable(C), else a TypeError; then OrdinaryHasInstance (§7.3.21): a non-object `v` is not an
 * instance (before `prototype` is read); C's `prototype` must be an object, else a TypeError; and `v`'s chain is
 * walked (`ORDINARY_CHAIN`).
 */
export function dynamicInstanceOf(b: Builders, instr: InstanceOf): IrInstr[] {
  if (b.program.objects.namesSymbol) gap("instanceof in a program that names 'Symbol'");
  const { value, target } = instr;
  const result = instr.result!;
  const objects = b.admitted.filter((kind) => IS_OBJECT[kind]);
  const unread = (r: IrValueId) => boolean(false, r);
  const hasInstance = (r: IrValueId): IrInstr[] => {
    const valueObjects = b.kinds.kindsOf(value).filter((kind) => IS_OBJECT[kind]);
    if (valueObjects.length === 0) return [unread(r)];
    const [name, key, prototype] = Array.from({ length: 3 }, b.fresh);
    const objectValue = holds(b, instr, value, objects);
    const prototypeObject = holds(b, instr, prototype, objects);
    const walk = (kind: CarrierKind, s: IrValueId): IrInstr[] =>
      ORDINARY_CHAIN[kind] ? [realmCall("js.object.inherits", [value, prototype], s)] : [unread(s)];
    const ordinary = (s: IrValueId): IrInstr[] => [
      b.text("prototype", name),
      carried(name, key),
      realmCall("js.object.get", [target, key, target], prototype),
      ...prototypeObject.instrs,
      b.branch(
        prototypeObject.cond,
        (t) => b.kindChain(instr, value, t, walk, valueObjects, BOOLEAN),
        throwing(b, "Function has non-object prototype in instanceof check", unread),
        s,
        BOOLEAN,
      ),
    ];
    return [...objectValue.instrs, b.branch(objectValue.cond, ordinary, (s) => [unread(s)], r, BOOLEAN)];
  };
  const callable = holds(b, instr, target, ["function"]);
  return [
    ...callable.instrs,
    b.branch(
      callable.cond,
      hasInstance,
      throwing(b, "Right-hand side of 'instanceof' is not callable", unread),
      result,
      BOOLEAN,
    ),
  ];
}
