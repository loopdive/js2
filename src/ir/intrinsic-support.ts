// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irImportFuncRef, irIntrinsicFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import { createIrAsyncPlan, type IrAsyncPlan, type PreparedIrAsyncRuntime } from "./async-plan.js";
import { ALL_ASYNC_HOST_ADAPTERS, type AsyncHostCapabilityId } from "./async-runtime-providers.js";
import { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "./async-semantic-runtime.js";
import { intrinsicEffectEvidence, INTRINSIC_DEFINITIONS } from "./intrinsics.js";
import {
  forEachInstrDeep,
  irTypeEquals,
  mapNestedBuffers,
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
  type IrIntrinsicProvider,
  type IrType,
  type IrValueId,
} from "./nodes.js";
import {
  RuntimeManifestBuilder,
  type FrozenRuntimeManifest,
  type RuntimeManifestPolicy,
  type RuntimeProviderPlan,
} from "./runtime-manifest.js";

export interface PreparedIrRuntimeManifest {
  readonly functions: readonly IrFunction[];
  readonly manifest: FrozenRuntimeManifest;
  /** Lookup-only handle retained after freeze for verifier/lowering adapters. */
  readonly providers: ReadonlyMap<IrInstrIntrinsic["id"], RuntimeProviderPlan>;
}

/** Project the semantic standalone clock intent without adding a helper call. */
function projectStandaloneAsyncStateInstr(instr: IrInstr): IrInstr {
  const nested = mapNestedBuffers(instr, (buffer) => buffer.map(projectStandaloneAsyncStateInstr));
  if (
    nested.kind !== "call" ||
    nested.target.binding.kind !== "intrinsic" ||
    nested.target.binding.symbol !== IR_ASYNC_CLOCK_SNAPSHOT_FN
  ) {
    return nested;
  }
  if (
    nested.args.length !== 0 ||
    nested.result === null ||
    nested.resultType?.kind !== "val" ||
    nested.resultType.val.kind !== "f64"
  ) {
    throw new Error("standalone async clock snapshot has a malformed semantic call");
  }
  return {
    kind: "const",
    value: { kind: "f64", value: 0 },
    result: nested.result,
    resultType: nested.resultType,
    ...(nested.site ? { site: nested.site } : {}),
  };
}

/** Verify the closed semantic signature and any post-freeze provider binding. */
export function verifyIrIntrinsicInstruction(
  instr: IrInstrIntrinsic,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[] {
  const errors: string[] = [];
  const definition = INTRINSIC_DEFINITIONS[instr.id];
  if (instr.version !== definition.signature.version) {
    errors.push(`${instr.id} uses signature v${instr.version}; expected v${definition.signature.version}`);
  }
  if (instr.args.length !== definition.signature.params.length) {
    errors.push(`${instr.id} expects ${definition.signature.params.length} argument(s), got ${instr.args.length}`);
  }
  for (let index = 0; index < instr.args.length && index < definition.signature.params.length; index++) {
    const actual = typeOf.get(instr.args[index]!);
    const expected = definition.signature.params[index]!;
    if (actual && !irTypeEquals(actual, expected)) {
      errors.push(`${instr.id} argument ${index} does not match its v${instr.version} signature`);
    }
  }
  if (!instr.resultType || !irTypeEquals(instr.resultType, definition.signature.result)) {
    errors.push(`${instr.id} result does not match its v${instr.version} signature`);
  }
  if (
    instr.provider?.kind === "callable" &&
    (instr.provider.target.binding.kind !== "intrinsic" || instr.provider.target.binding.symbol !== instr.id)
  ) {
    errors.push(`${instr.id} callable provider must retain the semantic intrinsic binding`);
  }
  return errors;
}

function mapArray<T>(values: readonly T[], map: (value: T) => T): readonly T[] {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

function valueTypesOf(fn: IrFunction): ReadonlyMap<IrValueId, IrType> {
  const result = new Map<IrValueId, IrType>();
  for (const param of fn.params) result.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) result.set(value.value, value.type);
  for (const block of fn.blocks) {
    for (let index = 0; index < block.blockArgs.length; index++) {
      const type = block.blockArgTypes[index];
      if (type) result.set(block.blockArgs[index]!, type);
    }
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType) result.set(instr.result, instr.resultType);
      });
    }
  }
  return result;
}

function providerAttachment(id: IrInstrIntrinsic["id"], provider: RuntimeProviderPlan): IrIntrinsicProvider {
  if (provider.implementation.kind === "backend-op") {
    return Object.freeze({ kind: "backend-op", opcode: provider.implementation.opcode });
  }
  return Object.freeze({
    kind: "callable",
    // Structural identity remains the semantic ID. The compatibility name is
    // the selected concrete provider spelling used by the existing registry.
    target: irIntrinsicFuncRef(id, provider.implementation.symbol),
  });
}

function sameProvider(left: IrIntrinsicProvider, right: IrIntrinsicProvider): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "backend-op" && right.kind === "backend-op") return left.opcode === right.opcode;
  return (
    left.kind === "callable" &&
    right.kind === "callable" &&
    sameIrCallableBinding(left.target.binding, right.target.binding) &&
    left.target.name === right.target.name
  );
}

function attachProvidersToBuffer(
  buffer: readonly IrInstr[],
  providers: ReadonlyMap<IrInstrIntrinsic["id"], RuntimeProviderPlan>,
): readonly IrInstr[] {
  const mapBuffer = (nestedBuffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(nestedBuffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (nested.kind !== "intrinsic") return nested;
    const provider = providers.get(nested.id);
    if (!provider) throw new Error(`IR intrinsic ${nested.id} is absent from the frozen runtime manifest`);
    const attachment = providerAttachment(nested.id, provider);
    if (nested.provider) {
      if (!sameProvider(nested.provider, attachment)) {
        throw new Error(`IR intrinsic ${nested.id} already carries a different prepared provider`);
      }
      return nested;
    }
    return { ...nested, provider: attachment };
  };
  return mapBuffer(buffer);
}

function attachProviders(
  fn: IrFunction,
  providers: ReadonlyMap<IrInstrIntrinsic["id"], RuntimeProviderPlan>,
): IrFunction {
  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = attachProvidersToBuffer(block.instrs, providers);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  return blocks === fn.blocks ? fn : { ...fn, blocks };
}

/**
 * Collect semantic intrinsic uses, freeze their complete provider graph, and
 * attach lookup-only provider choices to final IR. This is deliberately after
 * inference and middle-end transforms and before Program-ABI component seal.
 */
export function prepareIrRuntimeManifest(input: {
  readonly functions: readonly IrFunction[];
  readonly sourceFile: string;
  readonly policy: RuntimeManifestPolicy;
}): PreparedIrRuntimeManifest | undefined {
  const uses: Array<{ readonly instr: IrInstrIntrinsic; readonly argumentTypes: readonly IrType[] }> = [];
  const asyncPlans = new Map<IrFunction["unitId"], IrAsyncPlan>();
  for (const fn of input.functions) {
    if (fn.asyncPlan) {
      if (fn.funcKind !== "async") {
        throw new Error(`IR async plan owner ${fn.name} is not marked funcKind=async`);
      }
      if (fn.asyncPlan.ownerUnitId !== fn.unitId) {
        throw new Error(`IR async plan owner mismatch for ${fn.name}: ${fn.asyncPlan.ownerUnitId} != ${fn.unitId}`);
      }
      asyncPlans.set(fn.unitId, createIrAsyncPlan(fn.asyncPlan));
    } else if (fn.asyncRuntime) {
      throw new Error(`IR async runtime attachment for ${fn.name} has no semantic async plan`);
    }
    const valueTypes = valueTypesOf(fn);
    const collectBuffer = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "intrinsic") return;
          const argumentTypes = instr.args.map((arg) => {
            const type = valueTypes.get(arg);
            if (!type) throw new Error(`IR intrinsic ${instr.id} references an untyped SSA value ${arg}`);
            return type;
          });
          uses.push({ instr, argumentTypes });
        });
      }
    };
    for (const block of fn.blocks) collectBuffer(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) collectBuffer(state.body);
  }
  if (uses.length === 0 && asyncPlans.size === 0) return undefined;

  const builder = new RuntimeManifestBuilder(input.policy);
  for (const plan of asyncPlans.values()) {
    for (const intent of plan.runtimeIntents) builder.requestFeature(intent);
  }
  for (const { instr, argumentTypes } of uses) {
    const definition = INTRINSIC_DEFINITIONS[instr.id];
    if (!instr.resultType || !irTypeEquals(instr.resultType, definition.signature.result)) {
      throw new Error(`IR intrinsic ${instr.id} has a result outside its semantic signature`);
    }
    builder.addIntrinsicUse(
      {
        id: instr.id,
        version: instr.version,
        argumentTypes,
        resultType: instr.resultType,
        location: {
          file: input.sourceFile,
          line: instr.site?.line ?? 1,
          column: instr.site?.column ?? 0,
        },
      },
      intrinsicEffectEvidence(instr),
    );
  }
  const manifest = builder.freeze();
  const providers = new Map<IrInstrIntrinsic["id"], RuntimeProviderPlan>();
  for (const use of manifest.intrinsicUses) {
    providers.set(use.id, builder.resolveProvider(INTRINSIC_DEFINITIONS[use.id].feature));
  }
  const attachAsyncRuntime = (fn: IrFunction): IrFunction => {
    const plan = asyncPlans.get(fn.unitId);
    if (!plan) return fn;
    const selectedProviders = plan.runtimeIntents.map((intent) => builder.resolveProvider(intent));
    const nativeProjection = selectedProviders.every((provider) => provider.implementation.kind === "native-managed");
    const hostProjection = selectedProviders.every(
      (provider) =>
        provider.implementation.kind === "host-capability" || provider.implementation.kind === "host-managed",
    );
    if (!nativeProjection && !hostProjection) {
      throw new Error(`IR async runtime attachment for ${fn.name} mixes host and native providers`);
    }
    const capabilities = new Set<AsyncHostCapabilityId>();
    for (const provider of selectedProviders) {
      for (const capability of provider.hostCapabilities) capabilities.add(capability);
    }
    const states = Object.freeze(
      plan.states.map((state) => {
        const attached = attachProvidersToBuffer(state.body, providers);
        const body = nativeProjection ? attached.map(projectStandaloneAsyncStateInstr) : attached;
        return body === state.body ? state : Object.freeze({ ...state, body });
      }),
    );
    const runtime: PreparedIrAsyncRuntime = nativeProjection
      ? Object.freeze({ kind: "standalone-native-wasmgc", adapters: Object.freeze([] as const), states })
      : Object.freeze({
          kind: "host-wasmgc",
          adapters: Object.freeze(
            ALL_ASYNC_HOST_ADAPTERS.filter((adapter) => capabilities.has(adapter.capability)).map((adapter) =>
              Object.freeze({
                capability: adapter.capability,
                target: irImportFuncRef(adapter.module, adapter.field, adapter.field),
              }),
            ),
          ),
          states,
        });
    if (fn.asyncRuntime && JSON.stringify(fn.asyncRuntime) !== JSON.stringify(runtime)) {
      throw new Error(`IR async runtime attachment for ${fn.name} differs from the frozen manifest`);
    }
    return { ...fn, asyncPlan: plan, asyncRuntime: runtime };
  };
  return Object.freeze({
    functions: Object.freeze(input.functions.map((fn) => attachAsyncRuntime(attachProviders(fn, providers)))),
    manifest,
    providers,
  });
}
