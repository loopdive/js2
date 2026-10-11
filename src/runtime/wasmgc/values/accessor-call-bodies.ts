// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Captured at the legacy lookup site, before later reservations can change it. */
export type AccessorDispatchBinding =
  | {
      readonly kind: "resolved";
      readonly target: FuncHandle;
      /** An explicit undefined entry retains the disabled-singleton fallback. */
      readonly undefinedArguments: ReadonlyMap<number, readonly Instr[] | undefined>;
    }
  | { readonly kind: "legacy-missing" };

/**
 * Data for body construction, not an issued resource or native admission proof.
 * A future native owner must authenticate complete bindings; the explicit legacy
 * missing-dispatch/arity cases preserve existing compiler behavior only.
 */
export interface AccessorCallBindings {
  readonly closureArity: FuncHandle | undefined;
  readonly argcGlobal: number;
  readonly dispatches: ReadonlyMap<number, AccessorDispatchBinding>;
  readonly withoutArity: AccessorDispatchBinding | undefined;
}

export function buildAccessorCallBody(
  actualArity: 0 | 1,
  receiverLocal: number,
  callableLocal: number,
  argumentLocals: readonly number[],
  bindings: AccessorCallBindings,
): { body: Instr[]; locals: LocalDef[] } {
  const declaredLocal = actualArity + 2;
  const callAtArity = (dispatchArity: number, binding: AccessorDispatchBinding | undefined): Instr[] => {
    if (!binding) throw new Error("accessor call body: missing prepared dispatch binding");
    if (binding.kind === "legacy-missing") return [{ op: "ref.null.extern" }];
    const call: Instr[] = [
      { op: "local.get", index: receiverLocal },
      { op: "local.get", index: callableLocal },
    ];
    for (let arg = 0; arg < dispatchArity; arg++) {
      const local = argumentLocals[arg];
      if (local !== undefined) call.push({ op: "local.get", index: local });
      else {
        if (!binding.undefinedArguments.has(arg))
          throw new Error("accessor call body: missing prepared undefined argument");
        call.push(
          ...(binding.undefinedArguments.get(arg)?.map((instr) => ({ ...instr })) ?? [{ op: "ref.null.extern" }]),
        );
      }
    }
    call.push({ op: "call", funcIdx: binding.target });
    return call;
  };

  // Non-closure callables report -1; retain the actual-arity front guard.
  let dispatch = callAtArity(actualArity, bindings.dispatches.get(actualArity));
  for (let declared = 8; declared > actualArity; declared--) {
    dispatch = [
      { op: "local.get", index: declaredLocal },
      { op: "i32.const", value: declared },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callAtArity(declared, bindings.dispatches.get(declared)),
        else: dispatch,
      },
    ];
  }
  if (bindings.closureArity === undefined) {
    return { body: callAtArity(actualArity, bindings.withoutArity), locals: [] };
  }
  return {
    locals: [{ name: "__declared_arity", type: { kind: "i32" } }],
    body: [
      { op: "i32.const", value: actualArity },
      { op: "global.set", index: bindings.argcGlobal },
      { op: "local.get", index: callableLocal },
      { op: "call", funcIdx: bindings.closureArity },
      { op: "local.set", index: declaredLocal },
      ...dispatch,
    ],
  };
}
