// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  IR_NATIVE_PROMISE_DELAY_FN,
  IR_ASYNC_PROMISE_ALL_NATIVE_FN,
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "../core/async-callables.js";
import { irCallableBindingKey, irIntrinsicFuncRef, irRuntimeFuncRef } from "../core/callable-bindings.js";
import { forEachInstrDeep, type IrFunction, type IrInstr, type IrInstrCall, type IrValueId } from "../core/nodes.js";
import { irTypeEquals, type IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import {
  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_NATIVE_ARITY,
  type RuntimeFeature,
  type RuntimeProviderDefinition,
} from "./contracts/manifest.js";
import type { PreparedIrFunction } from "./contracts/prepared.js";

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const EXTERNREF: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const PROMISE: IrType = Object.freeze({ kind: "extern", className: "Promise" });
const STRING: IrType = Object.freeze({ kind: "string" });
const PROMISE_VECTOR: IrType = Object.freeze({ kind: "vec", elementType: EXTERNREF, nullable: true });

function declaration(
  feature: RuntimeFeature,
  ref: IrFuncRef,
  params: readonly IrType[],
  results: readonly IrType[],
): IrRuntimeCallableDeclaration {
  return Object.freeze({ feature, ref, params: Object.freeze(params), results: Object.freeze(results) });
}

/** Six closed contracts; console has zero results, concat uses the existing family. */
export const NATIVE_ASYNC_CALLABLE_DECLARATIONS: readonly IrRuntimeCallableDeclaration[] = Object.freeze([
  declaration("async.native.delay", irRuntimeFuncRef(IR_NATIVE_PROMISE_DELAY_FN), [F64, F64], [PROMISE]),
  declaration("async.native.all", irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN), [PROMISE_VECTOR], [EXTERNREF]),
  declaration("async.native.clock-zero", irIntrinsicFuncRef(IR_ASYNC_CLOCK_SNAPSHOT_FN), [], [F64]),
  declaration("async.native.number-to-string", irIntrinsicFuncRef(IR_ASYNC_NUMBER_TO_STRING_FN), [F64], [STRING]),
  declaration("async.native.console-append", irIntrinsicFuncRef(IR_ASYNC_CONSOLE_LOG_STRING_FN), [STRING], []),
  declaration("js.string.concat.many", irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN), Array(5).fill(STRING), [
    STRING,
  ]),
]);

/** Never consult display names, operand guesses or a prefix registry. */
export function irNativeAsyncCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return NATIVE_ASYNC_CALLABLE_DECLARATIONS.find(
    (entry) => irCallableBindingKey(entry.ref.binding) === irCallableBindingKey(ref.binding),
  );
}

export function irRuntimeCallableHasNoSlot(ref: IrFuncRef): boolean {
  return irNativeAsyncCallableDeclaration(ref)?.feature === "async.native.clock-zero";
}

const PROMISE_DEPENDENCIES = Object.freeze([
  "promise.capability.create",
  "promise.number.bridge",
  "promise.react",
  "promise.resolve",
  "promise.settle.fulfill",
  "promise.settle.reject",
  "scheduler.drain",
  "scheduler.enqueue",
] as const);

/** Symbolic resources only. In particular, delay still requires the separate timer-service plan. */
export const NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  (
    [
      ["native.async.delay", "async.native.delay", IR_NATIVE_PROMISE_DELAY_FN, PROMISE_DEPENDENCIES],
      ["native.async.all", "async.native.all", IR_ASYNC_PROMISE_ALL_NATIVE_FN, PROMISE_DEPENDENCIES],
      ["native.async.clock-zero", "async.native.clock-zero", null, []],
      ["native.async.number-to-string", "async.native.number-to-string", "__ir_number_toString_native", []],
      ["native.async.console-append", "async.native.console-append", "__stdout_append", []],
    ] as const
  ).map(([id, feature, symbol, dependencies]) =>
    Object.freeze({
      id,
      feature,
      dependencies: Object.freeze(dependencies),
      hostCapabilities: Object.freeze([]),
      supportedTargets: Object.freeze(["standalone"] as const),
      supportedBackends: Object.freeze(["wasmgc"] as const),
      implementation: Object.freeze(
        symbol === null ? { kind: "standalone-clock-zero" as const } : { kind: "runtime-callable" as const, symbol },
      ),
    }),
  ),
);

/** A selected row must implement the entire canonical contract, not merely reuse its id. */
export function nativeAsyncProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  const canonical = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find(
    (entry) => entry.id === provider.id || entry.feature === provider.feature,
  );
  if (!canonical)
    return provider.implementation.kind === "standalone-clock-zero" ? "foreign clock projection" : undefined;
  for (const field of ["id", "feature", "signature", "implementation"] as const)
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `native callable provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `native callable provider ${field} mismatch`;
  return undefined;
}

/** Native strings are an explicit resolved storage policy, never a target/default inference. */
export function nativeAsyncCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  if (!NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature) && feature !== "js.string.concat.many")
    return undefined;
  if (policy.backend !== "wasmgc" || policy.target !== "standalone") return `${feature} requires standalone WasmGC`;
  if (policy.stringConst?.storage !== "native") return `${feature} requires explicit native string storage`;
  if (feature === "js.string.concat.many" && policy.stringConcat?.concat !== "native")
    return `${feature} requires explicit native concatenation`;
  return undefined;
}

export class IrNativeAsyncCallableError extends Error {
  constructor(
    readonly unitId: IrUnitId,
    detail: string,
  ) {
    super(detail);
    this.name = "IrNativeAsyncCallableError";
  }
}

/** The denominator includes empty owners and every nested/state occurrence, not just a feature set. */
export interface IrNativeAsyncCallableDemand {
  readonly unitId: IrUnitId;
  readonly uses: readonly {
    readonly region: string;
    readonly ordinal: number;
    readonly bindingKey: string;
    readonly feature: RuntimeFeature;
  }[];
}

function buffers(fn: IrFunction): readonly { readonly region: string; readonly body: readonly IrInstr[] }[] {
  return [
    ...fn.blocks.map((block, index) => ({ region: `block:${index}`, body: block.instrs })),
    ...(fn.asyncPlan?.states.map((state) => ({ region: `state:${state.id}`, body: state.body })) ?? []),
  ];
}

/** SSA types come from definitions, including semantic resume values and nested state bodies. */
export function nativeAsyncCallableValueTypes(fn: IrFunction): ReadonlyMap<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  const note = (id: IrValueId, type: IrType): void => {
    const previous = types.get(id);
    if (previous && !irTypeEquals(previous, type))
      throw new IrNativeAsyncCallableError(fn.unitId, `conflicting SSA type for ${id}`);
    types.set(id, type);
  };
  fn.params.forEach((param) => note(param.value, param.type));
  fn.asyncPlan?.values.forEach((value) => note(value.value, value.type));
  for (const block of fn.blocks)
    block.blockArgs.forEach((value, index) => {
      if (block.blockArgTypes[index]) note(value, block.blockArgTypes[index]!);
    });
  for (const { body } of buffers(fn))
    for (const root of body)
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType) note(instr.result, instr.resultType);
      });
  return types;
}

export function nativeAsyncCallMismatch(
  call: IrInstrCall,
  contract: IrRuntimeCallableDeclaration,
  types: ReadonlyMap<IrValueId, IrType>,
): string | undefined {
  if (call.args.length !== contract.params.length) return "argument count differs from canonical declaration";
  for (const [index, value] of call.args.entries()) {
    const actual = types.get(value);
    const expected = contract.params[index]!;
    // A non-null vector can satisfy a nullable parameter, never the reverse.
    // Keep its element/carrier contract exact; this is not an externref cast.
    const nonNullVector =
      actual?.kind === "vec" &&
      actual.nullable === false &&
      expected.kind === "vec" &&
      expected.nullable === true &&
      irTypeEquals({ ...actual, nullable: true }, expected);
    if (!actual || (!irTypeEquals(actual, expected) && !nonNullVector))
      return `argument ${index} differs from canonical declaration`;
  }
  if (contract.results.length === 0) {
    if (call.result !== null || call.resultType != null) return "void callable has a result";
  } else if (call.result === null || !call.resultType || !irTypeEquals(call.resultType, contract.results[0]!))
    return "result differs from canonical declaration";
  if (
    contract.feature === "js.string.concat.many" &&
    (call.args.length < STRING_CONCAT_MANY_NATIVE_ARITY.min || call.args.length > STRING_CONCAT_MANY_NATIVE_ARITY.max)
  )
    return "concat lies outside canonical family arity";
  return undefined;
}

export function collectNativeAsyncCallableDemands(
  functions: readonly IrFunction[],
): readonly IrNativeAsyncCallableDemand[] {
  const owners = new Set<IrUnitId>();
  return Object.freeze(
    functions.map((fn) => {
      if (owners.has(fn.unitId))
        throw new IrNativeAsyncCallableError(fn.unitId, "duplicate native callable demand owner");
      owners.add(fn.unitId);
      const uses: IrNativeAsyncCallableDemand["uses"][number][] = [];
      // Untouched legacy bodies do not acquire a new SSA validation path merely by being scanned.
      let types: ReadonlyMap<IrValueId, IrType> | undefined;
      for (const { region, body } of buffers(fn)) {
        let ordinal = 0;
        for (const root of body)
          forEachInstrDeep(root, (instr) => {
            const position = ordinal++;
            const ref =
              instr.kind === "call" ? instr.target : instr.kind === "closure.new" ? instr.liftedFunc : undefined;
            const contract = ref && irNativeAsyncCallableDeclaration(ref);
            if (!contract) return;
            if (instr.kind !== "call")
              throw new IrNativeAsyncCallableError(fn.unitId, "native builtin is not a lifted closure body");
            const mismatch = nativeAsyncCallMismatch(instr, contract, (types ??= nativeAsyncCallableValueTypes(fn)));
            if (mismatch)
              throw new IrNativeAsyncCallableError(fn.unitId, `${irCallableBindingKey(ref!.binding)}: ${mismatch}`);
            uses.push(
              Object.freeze({
                region,
                ordinal: position,
                bindingKey: irCallableBindingKey(ref!.binding),
                feature: contract.feature,
              }),
            );
          });
      }
      return Object.freeze({ unitId: fn.unitId, uses: Object.freeze(uses) });
    }),
  );
}

/** Recompute from the selected complete semantic graph, including absent/empty owners. */
export function assertNativeAsyncCallableDemands(
  functions: readonly IrFunction[],
  demands: readonly IrNativeAsyncCallableDemand[],
): void {
  const actual = collectNativeAsyncCallableDemands(functions);
  if (actual.length !== demands.length) throw new Error("native callable demand owner population differs");
  for (const [index, entry] of actual.entries())
    if (JSON.stringify(entry) !== JSON.stringify(demands[index]))
      throw new IrNativeAsyncCallableError(
        entry.unitId,
        "native callable demand vector differs from semantic population",
      );
}

/** Runtime states may project the clock, but may neither drop nor fabricate other builtin calls. */
export function assertNativeAsyncRuntimeCallables(fn: PreparedIrFunction): void {
  if (!fn.asyncRuntime) return;
  const semantic = fn.asyncPlan?.states;
  if (!semantic || semantic.length !== fn.asyncRuntime.states.length)
    throw new IrNativeAsyncCallableError(fn.unitId, "native callable runtime state population differs");
  const flatten = (body: readonly IrInstr[]): readonly IrInstr[] => {
    const result: IrInstr[] = [];
    for (const root of body) forEachInstrDeep(root, (instr) => result.push(instr));
    return result;
  };
  for (const [index, state] of semantic.entries()) {
    const projected = fn.asyncRuntime.states[index]!;
    const before = flatten(state.body),
      after = flatten(projected.body);
    if (state.id !== projected.id)
      throw new IrNativeAsyncCallableError(fn.unitId, "native callable runtime state identity differs");
    for (let position = 0; position < Math.max(before.length, after.length); position++) {
      const original = before[position],
        current = after[position];
      const contract = original?.kind === "call" ? irNativeAsyncCallableDeclaration(original.target) : undefined;
      const currentContract = current?.kind === "call" ? irNativeAsyncCallableDeclaration(current.target) : undefined;
      if (!contract && !currentContract) continue;
      if (contract?.feature === "async.native.clock-zero") {
        if (
          fn.asyncRuntime.kind !== "standalone-native-wasmgc" ||
          !original ||
          !current ||
          current.kind !== "const" ||
          current.value.kind !== "f64" ||
          !Object.is(current.value.value, 0) ||
          current.result !== original.result ||
          JSON.stringify(current.resultType) !== JSON.stringify(original.resultType) ||
          JSON.stringify(current.site) !== JSON.stringify(original.site)
        )
          throw new IrNativeAsyncCallableError(fn.unitId, "native clock lacks its exact zero projection");
      } else if (!contract || !currentContract || JSON.stringify(original) !== JSON.stringify(current))
        throw new IrNativeAsyncCallableError(
          fn.unitId,
          "native callable runtime occurrence differs from semantic state",
        );
    }
  }
}
