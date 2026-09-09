// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { forEachInstrDeep, type IrFunction, type IrValueId, type IrInstr } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import { irVecElemSetSymbol } from "../core/vector-runtime.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeFeature, RuntimeProviderDefinition } from "./contracts/manifest.js";
import {
  nativeAsyncCallMismatch,
  nativeAsyncCallableValueTypes,
  type IrNativeAsyncCallableDemand,
} from "./native-async-callables.js";

const EXTERNREF: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const SYMBOL = irVecElemSetSymbol(EXTERNREF);

/** The existing grow/copy/store helper, not a general vector or allocation catalog. */
export const VECTOR_CALLABLE_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "js.vector.elem-set.externref",
  ref: irIntrinsicFuncRef(SYMBOL),
  params: Object.freeze([
    Object.freeze({ kind: "vec", elementType: EXTERNREF, nullable: true } as const),
    Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" } as const) } as const),
    EXTERNREF,
  ]),
  results: Object.freeze([]),
});

export function irVectorCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "intrinsic" && ref.binding.symbol === SYMBOL ? VECTOR_CALLABLE_DECLARATION : undefined;
}

/** Symbolic resolver obligation only; physical vector/growth resources remain backend-owned. */
export const VECTOR_CALLABLE_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "native.js.vector.elem-set.externref",
    feature: VECTOR_CALLABLE_DECLARATION.feature,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: SYMBOL } as const),
  }),
]);

export function vectorProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  const canonical = VECTOR_CALLABLE_RUNTIME_PROVIDERS[0]!;
  if (provider.id !== canonical.id && provider.feature !== canonical.feature) return undefined;
  for (const field of ["id", "feature", "signature", "implementation"] as const)
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `vector callable provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `vector callable provider ${field} mismatch`;
  return undefined;
}

/** Vector admission is independent of string storage and async frame intents. */
export function vectorCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  if (feature !== VECTOR_CALLABLE_DECLARATION.feature) return undefined;
  return policy.backend === "wasmgc" && policy.target === "standalone"
    ? undefined
    : `${feature} requires standalone WasmGC`;
}

export class IrVectorCallableError extends Error {
  constructor(
    readonly unitId: IrUnitId,
    detail: string,
  ) {
    super(detail);
    this.name = "IrVectorCallableError";
  }
}

/** Same occurrence schema, separate population: never enlarge the six async bindings. */
export type IrVectorCallableDemand = IrNativeAsyncCallableDemand;

function buffers(fn: IrFunction): readonly { readonly region: string; readonly body: readonly IrInstr[] }[] {
  return [
    ...fn.blocks.map((block, index) => ({ region: `block:${index}`, body: block.instrs })),
    ...(fn.asyncPlan?.states.map((state) => ({ region: `state:${state.id}`, body: state.body })) ?? []),
  ];
}

/** Complete owner population, including zero-call owners and every nested/state occurrence. */
export function collectVectorCallableDemands(functions: readonly IrFunction[]): readonly IrVectorCallableDemand[] {
  const owners = new Set<IrUnitId>();
  return Object.freeze(
    functions.map((fn) => {
      if (owners.has(fn.unitId)) throw new IrVectorCallableError(fn.unitId, "duplicate vector callable demand owner");
      owners.add(fn.unitId);
      const uses: IrVectorCallableDemand["uses"][number][] = [];
      let types: ReadonlyMap<IrValueId, IrType> | undefined;
      for (const { region, body } of buffers(fn)) {
        let ordinal = 0;
        for (const root of body)
          forEachInstrDeep(root, (instr) => {
            const position = ordinal++;
            const ref =
              instr.kind === "call" ? instr.target : instr.kind === "closure.new" ? instr.liftedFunc : undefined;
            if (!ref) return;
            if (ref.binding.kind === "runtime" && ref.binding.symbol === SYMBOL)
              throw new IrVectorCallableError(fn.unitId, "vector callable requires its exact intrinsic binding");
            const contract = irVectorCallableDeclaration(ref);
            if (!contract) return;
            if (instr.kind !== "call")
              throw new IrVectorCallableError(fn.unitId, "vector builtin is not a lifted closure body");
            const mismatch = nativeAsyncCallMismatch(instr, contract, (types ??= nativeAsyncCallableValueTypes(fn)));
            if (mismatch)
              throw new IrVectorCallableError(fn.unitId, `${irCallableBindingKey(ref.binding)}: ${mismatch}`);
            uses.push(
              Object.freeze({
                region,
                ordinal: position,
                bindingKey: irCallableBindingKey(ref.binding),
                feature: contract.feature,
              }),
            );
          });
      }
      return Object.freeze({ unitId: fn.unitId, uses: Object.freeze(uses) });
    }),
  );
}

/** Recompute independently from the current complete semantic graph before provider selection. */
export function assertVectorCallableDemands(
  functions: readonly IrFunction[],
  demands: readonly IrVectorCallableDemand[],
): void {
  const actual = collectVectorCallableDemands(functions);
  if (actual.length !== demands.length) throw new Error("vector callable demand owner population differs");
  for (const [index, entry] of actual.entries())
    if (JSON.stringify(entry) !== JSON.stringify(demands[index]))
      throw new IrVectorCallableError(entry.unitId, "vector callable demand vector differs from semantic population");
}
