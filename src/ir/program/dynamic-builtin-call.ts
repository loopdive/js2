// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7557) The body of the realm's built-in caller (`src/ir/realm-builtin-caller.ts`): the dispatcher's built-in arm
 * calls it with a built-in, the call's `this` (any value: a detached call's) and the call's argument vector. The body
 * is an identity ladder over the realm's methods the program may hold (`realmMethodsNamed`), each answering the same
 * algorithm a method call `o.m(…)` writes at its site (`dynamic-prototype-methods.ts`); any other built-in is the
 * run-time abort, as it was before the caller existed.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import {
  IR_CLOSURE_ARGUMENT,
  IR_CLOSURE_ARGUMENT_COUNT,
  irClosureMethodReference,
} from "../core/closure-invocation-callables.js";
import { FUNCTION_CALL_ID, NATIVE_OBJECT_PROTOTYPE_METHODS } from "./builtin-prototype-keys.js";
import { builtinMethodChain, identityTest, type BuiltinMethodTest } from "./dynamic-builtin-methods.js";
import {
  realmMethodTests,
  realmMethodsNamed,
  type BuiltinCall,
  type Call,
  type RealmMethods,
} from "./dynamic-prototype-methods.js";
import type { ConvertingBuilders } from "./dynamic-value-chains.js";
import { BOOLEAN, CARRIER, F64 } from "./dynamic-value-types.js";

/** The names a realm method the program may hold is read under, but the Object.prototype methods'. */
const METHOD_NAMES = ["toString", "valueOf", "isArray"];
/** The most arguments a held method reads. */
const METHOD_ARGUMENTS = 1;
/** The most arguments after `thisArg` a `call` through a value passes on; a call with more is the run-time abort. */
const CALL_ARGUMENTS = 3;

/** The legalized body `__ir_realm_builtin_call(callee, this, args)`, into the call's result. */
export function dynamicBuiltinCall(b: ConvertingBuilders, instr: Call): IrInstr[] {
  const [callee, receiver, vector] = instr.args as [IrValueId, IrValueId, IrValueId];
  const calls = b.families.methodNames.has("call");
  const reads = Array.from({ length: calls ? 1 + CALL_ARGUMENTS : METHOD_ARGUMENTS }, (_, index) => {
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
  const call: BuiltinCall = {
    instr,
    receiver,
    receiverKinds: b.kinds.kindsOf(receiver),
    detached: true,
    argument: (index) => reads[index]?.value,
  };
  const tests = [
    ...(calls ? [() => callTest(b, instr, call, vector)] : []),
    ...heldMethods(b).flatMap((methods) => realmMethodTests(b, call, callee, methods)),
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
function callTest(b: ConvertingBuilders, instr: Call, call: BuiltinCall, vector: IrValueId): BuiltinMethodTest {
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
          args: [
            call.argument(0)!,
            call.receiver,
            ...Array.from({ length: passed }, (_, index) => call.argument(1 + index)!),
          ],
          result: r,
          resultType: CARRIER,
        },
      ],
    };
  });
  return identityTest(b, FUNCTION_CALL_ID, instr.args[0]!, (r) => [
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

/**
 * The realm methods the program may hold: each id once, and each held wrapper method by its name. An Object.prototype
 * method only where the source spells its name (`families.methodNames`); elsewhere a detached call of one is the
 * run-time abort, as it was before the caller existed.
 */
function heldMethods(b: ConvertingBuilders): RealmMethods[] {
  const spelled = NATIVE_OBJECT_PROTOTYPE_METHODS.filter((name) => b.families.methodNames.has(name));
  const named = [...spelled, ...METHOD_NAMES].flatMap((name) => realmMethodsNamed(name, b.families) ?? []);
  const ids = [...new Set(named.flatMap((methods) => methods.ids))];
  return [{ ids }, ...named.flatMap((methods) => (methods.wrapper ? [{ ids: [], wrapper: methods.wrapper }] : []))];
}
