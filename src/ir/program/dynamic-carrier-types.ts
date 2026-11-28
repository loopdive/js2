// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 D1, Fa) The carrier form of the types a legalized function names. The dynamic value is the carrier (an
 * externref), and so is every dynamic parameter or result of a function value's signature: a closure created on the
 * Prepared path with the all-dynamic contract is called with, and returns, carrier values. The allocation registry
 * recorded each closure site with its logical signature when from-ast allocated it, so the legalized sites are
 * re-typed with it.
 */
import type { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../core/nodes.js";
import type { IrClosureSignature, IrType } from "../core/types.js";
import { CARRIER } from "./dynamic-value-chains.js";

/** Walk the data structurally: IR constants may hold bigints, which JSON cannot. */
export function containsDynamic(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { kind?: unknown }).kind === "dynamic") return true;
  return Object.values(value).some(containsDynamic);
}

export function carrierOf(type: IrType): IrType {
  if (type.kind === "dynamic") return CARRIER;
  // (#7354 L0c) A mutable capture's cell of the dynamic value holds the carrier.
  if (type.kind === "boxed") return containsDynamic(type) ? { kind: "boxed", inner: carrierOf(type.inner) } : type;
  if (type.kind !== "closure" && type.kind !== "callable") return type;
  return containsDynamic(type) ? { kind: type.kind, signature: carrierSignature(type.signature) } : type;
}

function carrierSignature(signature: IrClosureSignature): IrClosureSignature {
  return {
    ...signature,
    params: signature.params.map(carrierOf),
    returnType: signature.returnType && carrierOf(signature.returnType),
  };
}

/** `instr` with its result type, and a closure allocation's signature and captures, in carrier form. */
export function inCarrierForm(instr: IrInstr): IrInstr {
  const typed =
    instr.kind === "closure.new" && containsDynamic(instr.signature)
      ? {
          ...instr,
          signature: carrierSignature(instr.signature),
          captureFieldTypes: instr.captureFieldTypes.map(carrierOf),
        }
      : instr;
  const resultType = typed.resultType && carrierOf(typed.resultType);
  return resultType === typed.resultType ? typed : ({ ...typed, resultType } as IrInstr);
}

/** A lifted closure body's own subtype (its `__self`), in carrier form. */
export function carrierClosureSubtype(fn: IrFunction): Pick<IrFunction, "closureSubtype"> {
  if (!fn.closureSubtype) return {};
  const { signature, captureFieldTypes } = fn.closureSubtype;
  return {
    closureSubtype: {
      ...fn.closureSubtype,
      signature: carrierSignature(signature),
      captureFieldTypes: captureFieldTypes.map(carrierOf),
    },
  };
}

/** Re-type the allocation sites of the legalized closures and (#7354 L0c) ref cells with their carrier form. */
export function legalizeDynamicAllocations(functions: readonly IrFunction[], allocations: AllocSiteRegistry): void {
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "closure.new" && instr.alloc !== undefined && instr.resultType?.kind === "closure")
            allocations.retypeToCarrierForm(instr.alloc, instr.resultType);
          if (instr.kind === "refcell.new" && instr.alloc !== undefined && instr.resultType?.kind === "boxed")
            allocations.retypeToCarrierForm(instr.alloc, instr.resultType);
        });
}
