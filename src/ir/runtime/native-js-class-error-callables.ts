// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irRuntimeFuncRef } from "../core/callable-bindings.js";
import { forEachNestedBuffer, forEachInstrDeep, type IrFunction, type IrInstr, type IrBlockId } from "../core/nodes.js";
import type { IntrinsicSignature } from "../core/intrinsic-contracts.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";
import { REFERENCE_ERROR_DECLARATION } from "./reference-error-callable.js";
import {
  nativeJsClassEffects,
  type NativeJsClassImplicitError,
} from "../analysis/allocation-evidence/native-js-class-effects.js";
import {
  assertPreparedIrData,
  preparedIrDataMismatch,
  freezePreparedIrValue,
} from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";

const external: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
/** Internal exception payload ABI, without a JavaScript-host capability. */
export const TYPE_ERROR_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "error.type.construct",
  ref: irRuntimeFuncRef("__new_TypeError"),
  params: Object.freeze([external]),
  results: Object.freeze([external]),
});
export const TYPE_ERROR_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: 1,
  params: TYPE_ERROR_DECLARATION.params,
  result: external,
});
export const TYPE_ERROR_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "native.error.type.construct",
    feature: TYPE_ERROR_DECLARATION.feature,
    signature: TYPE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    supportedBackends: Object.freeze(["linear", "wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: "__new_TypeError" } as const),
  }),
]);

export function nativeJsClassTypeErrorDeclaration(
  ref: IrRuntimeCallableDeclaration["ref"],
): IrRuntimeCallableDeclaration | undefined {
  assertPreparedIrData(ref);
  return ref.binding.kind === "runtime" && ref.binding.symbol === "__new_TypeError"
    ? TYPE_ERROR_DECLARATION
    : undefined;
}
export function nativeJsClassTypeErrorProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  assertPreparedIrData(provider);
  if (provider.feature !== TYPE_ERROR_DECLARATION.feature && provider.id !== "native.error.type.construct")
    return undefined;
  return preparedIrDataMismatch(provider, TYPE_ERROR_RUNTIME_PROVIDERS[0]) === undefined
    ? undefined
    : "native TypeError provider contradicts its complete canonical descriptor";
}

export interface NativeJsClassErrorDemand extends NativeJsClassImplicitError {
  readonly unitId: IrUnitId;
  readonly blockId: IrBlockId;
  readonly root: number;
  readonly arms: readonly { readonly arm: "then" | "else"; readonly index: number }[];
  readonly instruction: IrInstr;
  readonly declaration: IrRuntimeCallableDeclaration;
  /** Semantic aggregate, distinct from every definition/instance/cell/frame source allocation. */
  readonly allocation: {
    readonly kind: "fresh-provider-error";
    readonly lifetime: "exception-escaped";
    readonly aliases: readonly [];
    readonly message: "undefined";
  };
}

// Issuance pins a replay observation, not physical or allocation authority.
const observations = new WeakMap<
  readonly NativeJsClassErrorDemand[],
  { readonly functions: readonly IrFunction[]; readonly snapshot: unknown }
>();

/** Fresh complete occurrence census. Nothing is added to the IR or allocation registry. */
export function collectNativeJsClassErrorDemands(
  functions: readonly IrFunction[],
): readonly NativeJsClassErrorDemand[] {
  assertPreparedIrData(functions);
  const demands: NativeJsClassErrorDemand[] = [];
  for (const fn of functions) {
    let selected = false;
    for (const block of fn.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (item) => {
          selected ||= item.kind.startsWith("js.class.");
        });
    if (!selected) continue;
    for (const block of fn.blocks) {
      const walk = (instruction: IrInstr, root: number, arms: NativeJsClassErrorDemand["arms"]): void => {
        const effect = nativeJsClassEffects(instruction);
        for (const partition of effect?.implicitErrors ?? [])
          demands.push(
            Object.freeze({
              ...partition,
              unitId: fn.unitId,
              blockId: block.id,
              root,
              arms,
              instruction,
              declaration: partition.error === "ReferenceError" ? REFERENCE_ERROR_DECLARATION : TYPE_ERROR_DECLARATION,
              allocation: Object.freeze({
                kind: "fresh-provider-error" as const,
                lifetime: "exception-escaped" as const,
                aliases: Object.freeze([]) as readonly [],
                message: "undefined" as const,
              }),
            }),
          );
        let bufferIndex = 0;
        forEachNestedBuffer(instruction, (buffer) => {
          const arm = bufferIndex++ === 0 ? "then" : "else";
          if (instruction.kind !== "if" && instruction.kind !== "if.stmt") {
            // The class logical subset has only these structured scopes. Other
            // operations must be admitted independently, not assigned fake paths.
            if (buffer.length)
              throw new PreparedIrProgramInvariantError(
                "invalid-prepared-data",
                "class error census has an unsupported nested scope",
              );
            return;
          }
          for (const [index, child] of buffer.entries())
            walk(child, root, Object.freeze([...arms, Object.freeze({ arm, index })]));
        });
      };
      for (const [root, instruction] of block.instrs.entries()) walk(instruction, root, Object.freeze([]));
    }
  }
  const result = Object.freeze(demands);
  observations.set(result, { functions: [...functions], snapshot: freezePreparedIrValue(functions) });
  return result;
}

/** Occurrence identity and complete ordered DATA are replayed, never trusted as a report. */
export function assertNativeJsClassErrorDemandsCurrent(
  functions: readonly IrFunction[],
  demands: readonly NativeJsClassErrorDemand[],
): void {
  assertPreparedIrData(demands);
  assertPreparedIrData(functions);
  const owner = observations.get(demands);
  if (
    !owner ||
    owner.functions.length !== functions.length ||
    owner.functions.some((fn, index) => fn !== functions[index]) ||
    preparedIrDataMismatch(owner.snapshot, functions) !== undefined
  )
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "foreign or stale class error census");
  const actual = collectNativeJsClassErrorDemands(functions);
  if (
    actual.length !== demands.length ||
    actual.some(
      (row, index) =>
        row.instruction !== demands[index]!.instruction || preparedIrDataMismatch(row, demands[index]) !== undefined,
    )
  )
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "class implicit error demand census changed");
}

/** Actual definitions need callable realm roots, but create no error instance at bootstrap. */
export function nativeJsClassRealmErrorDeclarations(
  functions: readonly IrFunction[],
): readonly IrRuntimeCallableDeclaration[] {
  assertPreparedIrData(functions);
  let definitions = false;
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "js.class.define") {
            nativeJsClassEffects(instruction);
            definitions = true;
          }
        });
  return definitions ? Object.freeze([REFERENCE_ERROR_DECLARATION, TYPE_ERROR_DECLARATION]) : Object.freeze([]);
}
