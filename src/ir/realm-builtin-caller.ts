// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7557) The realm's built-in caller, made by the module-init prologue where the realm may hold built-ins a program
 * calls through values. It is one derived function of the initializer, `(callee, this, args) -> value`, whose body is
 * one helper call the dynamic-value legalization writes as the built-ins' algorithms (`dynamic-builtin-call.ts`), so
 * each built-in's algorithm can convert with the program's own ToString / ToNumber. Its closure is installed into the
 * realm (`js.closure.install-builtin-caller`); the dispatcher's built-in arm calls it with the built-in the call
 * reached, the call's `this` and a vector of its arguments.
 */
import { IrFunctionBuilder } from "./builder.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef, irUnitFuncRef } from "./callable-bindings.js";
import { IR_CLOSURE_INSTALL_BUILTIN_CALLER } from "./core/closure-invocation-callables.js";
import { allocateLiftedFunctionArtifact, recordLiftedUnitProvenance } from "./identity.js";
import { irDynamic, type IrClosureSignature } from "./nodes.js";
import type { FunctionValueHost } from "./function-declaration-values.js";
import { REALM_BUILTIN_CALL_HELPER } from "./program/dynamic-realm-calls.js";

const DYNAMIC = irDynamic();
const PARAMETERS = ["callee", "receiver", "args"] as const;

/** The caller's closure, installed into the realm. */
export function emitRealmBuiltinCaller(cx: FunctionValueHost): void {
  const signature: IrClosureSignature = { params: PARAMETERS.map(() => DYNAMIC), returnType: DYNAMIC };
  const closure = cx.builder.emitClosureNew(liftCaller(cx, signature), signature, [], []);
  const callable = cx.builder.emitCoerceToExternref(cx.builder.emitCallablePack(closure, signature));
  cx.builder.emitCall(irIntrinsicFuncRef(IR_CLOSURE_INSTALL_BUILTIN_CALLER), [callable], null);
}

function liftCaller(cx: FunctionValueHost, signature: IrClosureSignature) {
  const identity = allocateLiftedFunctionArtifact(cx, () => "__realm_builtin_caller");
  recordLiftedUnitProvenance(identity, cx);
  const builder = new IrFunctionBuilder(identity, [DYNAMIC], false, cx.allocRegistry);
  builder.addParam("__self", { kind: "closure", signature });
  const args = PARAMETERS.map((name) => builder.addParam(name, DYNAMIC));
  builder.openBlock();
  const result = builder.emitCall(irRuntimeFuncRef(REALM_BUILTIN_CALL_HELPER), args, DYNAMIC);
  builder.terminate({ kind: "return", values: [result!] });
  const count = PARAMETERS.length;
  cx.lifted.push(
    builder.finish({ signature, captureFieldTypes: [], parameters: { kind: "fixed", count, publicLength: count } }),
  );
  return irUnitFuncRef(identity);
}
