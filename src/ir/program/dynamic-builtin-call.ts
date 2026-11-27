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
import { IR_CLOSURE_ARGUMENT } from "../core/closure-invocation-callables.js";
import { NATIVE_OBJECT_PROTOTYPE_METHODS } from "./builtin-prototype-keys.js";
import { builtinMethodChain } from "./dynamic-builtin-methods.js";
import {
  realmMethodTests,
  realmMethodsNamed,
  type BuiltinCall,
  type Call,
  type RealmMethods,
} from "./dynamic-prototype-methods.js";
import type { ConvertingBuilders } from "./dynamic-value-chains.js";
import { CARRIER, F64 } from "./dynamic-value-types.js";

/** The names a realm method the program may hold is read under, but the Object.prototype methods'. */
const METHOD_NAMES = ["toString", "valueOf", "isArray"];
/** The most arguments a held method reads. */
const READ_ARGUMENTS = 1;

/** The legalized body `__ir_realm_builtin_call(callee, this, args)`, into the call's result. */
export function dynamicBuiltinCall(b: ConvertingBuilders, instr: Call): IrInstr[] {
  const [callee, receiver, vector] = instr.args as [IrValueId, IrValueId, IrValueId];
  const reads = Array.from({ length: READ_ARGUMENTS }, (_, index) => {
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
  const tests = heldMethods(b).flatMap((methods) => realmMethodTests(b, call, callee, methods));
  return [
    ...reads.flatMap((read) => read.instrs),
    ...builtinMethodChain(b, tests, (r) => b.abort(instr, r), CARRIER)(instr.result!),
  ];
}

/**
 * The realm methods the program may hold: each id once, and each held wrapper method by its name. The Object.prototype
 * methods only where the source spells one (`families.objectMethods`); elsewhere a detached call of one is the
 * run-time abort, as it was before the caller existed.
 */
function heldMethods(b: ConvertingBuilders): RealmMethods[] {
  const names = [...(b.families.objectMethods ? NATIVE_OBJECT_PROTOTYPE_METHODS : []), ...METHOD_NAMES];
  const named = names.flatMap((name) => realmMethodsNamed(name, b.families) ?? []);
  const ids = [...new Set(named.flatMap((methods) => methods.ids))];
  return [{ ids }, ...named.flatMap((methods) => (methods.wrapper ? [{ ids: [], wrapper: methods.wrapper }] : []))];
}
