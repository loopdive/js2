// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 C2) The dynamic-value legalization of the three operations a plain function takes part in as an object:
 * `this` (`dyn.current_this`), `new` (`dyn.construct`) and `instanceof` (`dyn.instanceof`), and (#7562) the count of
 * its arguments (`dyn.arguments_length`, `dyn.publish_argc`). Each is a chain over the
 * kinds its operands may hold (`dynamic-value-kinds.ts`) around the realm's function objects (`js.object.*`) and the
 * native dispatcher (`js.closure.*`): the dispatcher installs a call's receiver in `__current_this`, pads and drops
 * arguments and throws its TypeError for a value that is no source closure, so [[Construct]] is its call with the new
 * object as the receiver.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import {
  IR_CLOSURE_ARGUMENTS_LENGTH,
  IR_CLOSURE_PUBLISH_ARGC,
  IR_CLOSURE_RECEIVER,
  irClosureMethodReference,
} from "../core/closure-invocation-callables.js";
import { realmCall, typeErrorThen } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";
import { BOOLEAN, CARRIER, I32, booleanConst, carried, type ChainBuilders } from "./dynamic-value-chains.js";
import {
  IS_OBJECT,
  article,
  holdsFamily,
  isOrdinaryObject,
  type CarrierKind,
  type LegalizationProgram,
} from "./dynamic-value-kinds.js";
import { functionChainAnswer } from "./dynamic-error-constructors.js";

type CurrentThis = Extract<IrInstr, { kind: "dyn.current_this" }>;
type Construct = Extract<IrInstr, { kind: "dyn.construct" }>;
type InstanceOf = Extract<IrInstr, { kind: "dyn.instanceof" }>;
type ArgumentsCount = Extract<IrInstr, { kind: "dyn.arguments_length" | "dyn.publish_argc" }>;

/**
 * The one legalization's builders, beside the program it answers for and the admitted kinds whose values are objects
 * (`IS_OBJECT`).
 */
type Builders = ChainBuilders & { readonly program: LegalizationProgram; readonly objects: readonly CarrierKind[] };

/** A TypeError with `message`, then the arm's unread `answer` into `result`. */
const throwing = (b: Builders, message: string, answer: (result: IrValueId) => IrInstr) => (result: IrValueId) =>
  typeErrorThen({ ...b, carrier: CARRIER }, message, answer(result));

/** Get(C, "prototype") of the once-evaluated function value `callee` into `prototype` (its own data property). */
function getPrototype(b: Builders, callee: IrValueId, prototype: IrValueId): IrInstr[] {
  const [name, key] = [b.fresh(), b.fresh()];
  return [b.text("prototype", name), carried(name, key), realmCall("js.object.get", [callee, key, callee], prototype)];
}

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
  b.kinds.learn(instr.result!, b.objects);
  const { instrs, cond } = b.holds(instr, receiver, b.objects);
  return [
    read,
    ...instrs,
    b.branch(
      cond,
      (r) => [carried(receiver, r)],
      (r) => b.abort(instr, "a sloppy-mode this that is not an object: needs the global object or a wrapper", r),
      instr.result!,
      CARRIER,
    ),
  ];
}

/**
 * (#7562) The dispatcher's count protocol (`__argc`, `__extra_args`) outside it. A function that reads its own
 * `arguments.length` takes the count at entry; a direct call to one publishes its count, and no extras, first: from-ast
 * emits that publication at every such call on this path, because a caller the dispatcher entered still has its own
 * count installed.
 */
export function argumentsCount(b: Builders, instr: ArgumentsCount): IrInstr[] {
  if (instr.kind === "dyn.arguments_length")
    return [
      {
        kind: "call",
        target: irIntrinsicFuncRef(IR_CLOSURE_ARGUMENTS_LENGTH),
        args: [],
        result: instr.result,
        resultType: instr.resultType,
      },
    ];
  const count = b.fresh();
  return [
    { kind: "const", value: { kind: "i32", value: instr.count }, result: count, resultType: I32 },
    {
      kind: "call",
      target: irIntrinsicFuncRef(IR_CLOSURE_PUBLISH_ARGC),
      args: [count],
      result: null,
      resultType: null,
    },
  ];
}

/**
 * `new C(…args)` (§13.3.5.1.1 EvaluateNew, after its operands): IsConstructor(C), else a TypeError; then [[Construct]]
 * (§10.2.2): OrdinaryCreateFromConstructor reads C's `prototype` once and links the new object to it if it is an
 * ordinary object (`isOrdinaryObject`; another object kind is the run-time abort) or else to the realm's
 * Object.prototype; the body runs with the new object as `this` (the dispatcher); an object result (`IS_OBJECT`)
 * replaces the new object.
 *
 * IsConstructor is the function-kind test, then (#7354 O2) the function object's own answer
 * (`js.object.is-constructor`, the bit `init-function` sets from `isConstructorFunction`: an accessor has no
 * [[Construct]]).
 */
export function dynamicConstruct(b: Builders, instr: Construct): IrInstr[] {
  const { callee, args } = instr;
  const result = instr.result!;
  b.kinds.learn(result, b.objects);
  const notConstructor = throwing(b, "Value is not a constructor", (r) =>
    b.intrinsic(instr, "js.value.undefined", [], r),
  );
  // A callee that holds no function value is always the TypeError, and needs no dispatcher.
  if (!b.kinds.kindsOf(callee).includes("function")) return notConstructor(result);
  const isFunction = b.holds(instr, callee, ["function"]);
  // (#7354 G1) Without a source function no dispatcher exists, and a function value is a built-in the realm holds,
  // whose [[Construct]] through a value is the run-time abort (the dispatcher's own answer for a built-in).
  const builtin = (r: IrValueId): IrInstr[] => b.abort(instr, "new on a built-in function the realm holds", r);
  const construct = (r: IrValueId): IrInstr[] => {
    const [prototype, object, answer] = [b.fresh(), b.fresh(), b.fresh()];
    const link = (kind: CarrierKind, s: IrValueId): IrInstr[] =>
      isOrdinaryObject(kind)
        ? [realmCall("js.object.create-with-prototype", [prototype], s)]
        : IS_OBJECT[kind]
          ? b.abort(instr, `new with a 'prototype' that is ${article(kind)}, not an ordinary object`, s)
          : [realmCall("js.object.create-default", [], s)];
    const isObject = b.holds(instr, answer, b.objects);
    return [
      ...getPrototype(b, callee, prototype),
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
  const source = (r: IrValueId): IrInstr[] => {
    const test = b.fresh();
    return [
      realmCall("js.object.is-constructor", [callee], test),
      b.branch(test, construct, notConstructor, r, CARRIER),
    ];
  };
  return [
    ...isFunction.instrs,
    b.branch(isFunction.cond, b.program.objects.functions ? source : builtin, notConstructor, result, CARRIER),
  ];
}

/**
 * `v instanceof C` (§13.10.2 InstanceofOperator) without `@@hasInstance`, which only a program that names `Symbol`
 * can reach: IsCallable(C), else a TypeError; then OrdinaryHasInstance (§7.3.21): a non-object `v` is not an
 * instance (before `prototype` is read); C's `prototype` must be an object, else a TypeError; and an ordinary
 * object's chain is walked (`isOrdinaryObject`, (#7354 G1) an error's included): a function's holds built-in
 * prototypes alone, which no Prepared program obtains (M1, C1; tests/issue-7354-m-prototype-premise.test.ts), so no
 * `prototype` is on it, but (G1) %Error% (`functionChainAnswer`).
 */
export function dynamicInstanceOf(b: Builders, instr: InstanceOf): IrInstr[] {
  if (b.program.objects.namesSymbol) gap("instanceof in a program that names 'Symbol'");
  const { value, target } = instr;
  const result = instr.result!;
  const unread = (r: IrValueId) => booleanConst(false, r);
  const hasInstance = (r: IrValueId): IrInstr[] => {
    const valueObjects = b.kinds.kindsOf(value).filter((kind) => IS_OBJECT[kind]);
    const prototype = b.fresh();
    const objectValue = b.holds(instr, value, b.objects);
    const prototypeObject = b.holds(instr, prototype, b.objects);
    const walk = (kind: CarrierKind, s: IrValueId): IrInstr[] =>
      isOrdinaryObject(kind)
        ? [realmCall("js.object.inherits", [value, prototype], s)]
        : functionChainAnswer(b, instr, holdsFamily(b.program, "error"), prototype, (t) => [unread(t)], s, BOOLEAN);
    const ordinary = (s: IrValueId): IrInstr[] => [
      ...getPrototype(b, target, prototype),
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
  const callable = b.holds(instr, target, ["function"]);
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
