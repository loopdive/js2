// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7557) The body of the realm's built-in caller (`src/ir/realm-builtin-caller.ts`): the dispatcher's built-in arm
 * calls it with a built-in, the call's `this` (any value) and the call's argument vector. The body is one identity
 * ladder: §20.2.3.3 `Function.prototype.call` where the source spells `call`, then every built-in the realm may hold
 * (`heldBuiltinRungs`, the same algorithms a method call writes at its site); any other built-in is the run-time abort,
 * as it was before the caller existed.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import {
  IR_CLOSURE_ARGUMENT,
  IR_CLOSURE_ARGUMENT_COUNT,
  irClosureMethodReference,
} from "../core/closure-invocation-callables.js";
import { FUNCTION_CALL_ID } from "./builtin-prototype-keys.js";
import { builtinMethodChain, identityTest, type BuiltinMethodTest } from "./dynamic-builtin-methods.js";
import { heldBuiltinRungs, type BuiltinCall, type Call } from "./dynamic-prototype-methods.js";
import type { ObjectStaticBuilders } from "./dynamic-object-statics.js";
import { BOOLEAN, CARRIER, F64 } from "./dynamic-value-types.js";

/** The most arguments a held built-in reads (`Object.defineProperty`'s three). */
const BUILTIN_ARGUMENTS = 3;
/** The most arguments after `thisArg` a `call` passes on; a call with more is the run-time abort. */
const CALL_ARGUMENTS = 3;

/** The legalized body `__ir_realm_builtin_call(callee, this, args)`, into the call's result. */
export function dynamicBuiltinCall(b: ObjectStaticBuilders, instr: Call): IrInstr[] {
  const [callee, receiver, vector] = instr.args as [IrValueId, IrValueId, IrValueId];
  const calls = b.program.objects.prototypeMethodNames.has("call");
  const reads = Array.from({ length: calls ? 1 + CALL_ARGUMENTS : BUILTIN_ARGUMENTS }, (_, index) => {
    const [position, value] = [b.fresh(), b.fresh()];
    return {
      value,
      instrs: [
        { kind: "const", value: { kind: "f64", value: index }, result: position, resultType: F64 },
        {
          kind: "call",
          target: irIntrinsicFuncRef(IR_CLOSURE_ARGUMENT),
          args: [vector, position],
          result: value,
          resultType: CARRIER,
        },
      ] satisfies IrInstr[],
    };
  });
  const values = reads.map((read) => read.value);
  const call: BuiltinCall = { instr, receiver, args: values.slice(0, BUILTIN_ARGUMENTS), detached: true };
  const tests = [
    ...(calls ? [() => callTest(b, instr, receiver, values, vector)] : []),
    ...heldBuiltinRungs(b, call, callee, true).map((rung) => rung.test),
  ];
  return [
    ...reads.flatMap((read) => read.instrs),
    ...builtinMethodChain(b, tests, (r) => b.abort(instr, r), CARRIER)(instr.result!),
  ];
}

/**
 * §20.2.3.3 Function.prototype.call(thisArg, ...args): Call(`this`, thisArg, args), the dispatcher's call of `this`
 * with as many arguments as the vector holds after `thisArg` (a built-in `this` reaches this caller again; a value that
 * is not callable is the dispatcher's TypeError).
 */
function callTest(
  b: ObjectStaticBuilders,
  instr: Call,
  receiver: IrValueId,
  values: readonly IrValueId[],
  vector: IrValueId,
): BuiltinMethodTest {
  const count = b.fresh();
  const passing = Array.from({ length: CALL_ARGUMENTS + 1 }, (_, passed) => (): BuiltinMethodTest => {
    const [bound, cond] = [b.fresh(), b.fresh()];
    return {
      instrs: [
        { kind: "const", value: { kind: "f64", value: passed + 1 }, result: bound, resultType: F64 },
        { kind: "binary", op: "f64.le", lhs: count, rhs: bound, result: cond, resultType: BOOLEAN },
      ],
      cond,
      answer: (r) => [
        {
          kind: "call",
          target: irClosureMethodReference(passed),
          args: [values[0]!, receiver, ...values.slice(1, 1 + passed)],
          result: r,
          resultType: CARRIER,
        },
      ],
    };
  });
  return identityTest(b, instr, FUNCTION_CALL_ID, instr.args[0]!, (r) => [
    {
      kind: "call",
      target: irIntrinsicFuncRef(IR_CLOSURE_ARGUMENT_COUNT),
      args: [vector],
      result: count,
      resultType: F64,
    },
    ...builtinMethodChain(b, passing, (s) => b.abort(instr, s), CARRIER)(r),
  ]);
}
