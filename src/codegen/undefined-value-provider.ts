// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { canonicalUndefinedExternInstrs, ensureAnyValueType } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { localGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { IR_UNDEFINED_VALUE_FN } from "../ir/undefined-value-provider.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncTypeDef, GlobalDef, Import, Instr, TypeDef, WasmFunction } from "../ir/types.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../runtime/wasmgc/values/primitive-layouts.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityFuncRecord,
} from "../ir/runtime/host-capabilities.js";
import { canonicalProgramAbiTypeDef } from "./program-abi-signatures.js";

export interface UndefinedValueProviderReservation {
  readonly func: WasmFunction;
  readonly resource:
    | { readonly kind: "native"; readonly global: GlobalDef; readonly type: TypeDef }
    | { readonly kind: "host"; readonly imported: Import };
}

function fail(detail: string): never {
  throw new ProgramAbiInvariantError("callable-provider-mismatch", detail);
}

function exactSignature(signature: FuncTypeDef | undefined): void {
  if (
    !signature ||
    signature.kind !== "func" ||
    signature.params.length !== 0 ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref"
  )
    fail("undefined provider requires exact () -> externref ABI");
}

function sameInstructions(actual: readonly Instr[], expected: readonly Instr[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((instruction, index) => {
      const target = expected[index]!;
      return (
        Object.keys(instruction).length === Object.keys(target).length &&
        Object.entries(target).every(([key, value]) =>
          Object.is((instruction as unknown as Record<string, unknown>)[key], value),
        )
      );
    })
  );
}

function nativeSingleton(ctx: CodegenContext): GlobalDef {
  const index = ctx.undefinedGlobalIdx;
  const global = index === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, index)];
  const type = ctx.mod.types[ctx.anyValueTypeIdx];
  if (
    !global ||
    !type ||
    global.mutable ||
    global.type.kind !== "ref" ||
    global.type.typeIdx !== ctx.anyValueTypeIdx ||
    canonicalProgramAbiTypeDef(type) !== canonicalProgramAbiTypeDef(buildAnyValueType()) ||
    !sameInstructions(global.init, buildUndefinedInitializer(ctx.anyValueTypeIdx))
  )
    fail("undefined provider requires its exact native singleton");
  return global;
}

function hostCapability(ctx: CodegenContext): Import {
  if (ctx.targetProfile.environment !== "javascript" || ctx.targetProfile.strictEnvImportGate)
    fail("undefined provider host capability is unavailable");
  const record = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "async.value.undefined");
  const imports = ctx.mod.imports.filter((entry) => entry.module === record.module && entry.name === record.field);
  if (imports.length !== 1 || imports[0]!.desc.kind !== "func")
    fail("undefined provider requires its existing host capability");
  const imported = imports[0]!;
  if (imported.desc.kind !== "func") fail("undefined provider host capability is not callable");
  exactSignature(ctx.mod.types[imported.desc.typeIdx] as FuncTypeDef | undefined);
  const current = ctx.mod.imports.filter((entry) => entry.desc.kind === "func").indexOf(imported);
  if (ctx.funcMap.get(record.field) !== current) fail("undefined provider host capability has a foreign allocator");
  return imported;
}

/** Reserve the existing provider before body lowering, retaining exact resource authority. */
export function reserveUndefinedValueProvider(ctx: CodegenContext): UndefinedValueProviderReservation {
  if (ctx.funcMap.has(IR_UNDEFINED_VALUE_FN)) fail("undefined provider name collides with an unowned allocator");
  const native = ctx.standalone || ctx.nativeStrings;
  if (native) ensureAnyValueType(ctx);
  else {
    if (ctx.targetProfile.environment !== "javascript" || ctx.targetProfile.strictEnvImportGate)
      fail("undefined provider host capability is unavailable");
    const capability = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "async.value.undefined");
    // Existing imports must authenticate before the idempotent allocator can reuse them.
    if (
      ctx.funcMap.has(capability.field) ||
      ctx.mod.imports.some((entry) => entry.module === capability.module && entry.name === capability.field)
    )
      hostCapability(ctx);
    ensureLateImport(
      ctx,
      capability.field,
      capability.params.map((kind) => ({ kind })),
      capability.results.map((kind) => ({ kind })),
      capability.module,
    );
  }
  flushLateImportShifts(ctx, null);
  const resource: UndefinedValueProviderReservation["resource"] = native
    ? { kind: "native", global: nativeSingleton(ctx), type: ctx.mod.types[ctx.anyValueTypeIdx]! }
    : { kind: "host", imported: hostCapability(ctx) };
  const body = canonicalUndefinedExternInstrs(ctx);
  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
  const index = mintDefinedFunc(ctx);
  const func: WasmFunction = { name: IR_UNDEFINED_VALUE_FN, typeIdx, locals: [], body, exported: false };
  pushDefinedFunc(ctx, index, func);
  ctx.funcMap.set(IR_UNDEFINED_VALUE_FN, index);
  return Object.freeze({ func, resource: Object.freeze(resource) });
}

export function assertUndefinedValueProvider(
  ctx: CodegenContext,
  reservation: UndefinedValueProviderReservation,
): void {
  const index = ctx.funcMap.get(IR_UNDEFINED_VALUE_FN);
  if (index === undefined || definedFuncAt(ctx, index) !== reservation.func)
    fail("undefined provider lost its exact allocator");
  exactSignature(ctx.mod.types[reservation.func.typeIdx] as FuncTypeDef | undefined);
  if (reservation.resource.kind === "native") {
    if (
      !(ctx.standalone || ctx.nativeStrings) ||
      nativeSingleton(ctx) !== reservation.resource.global ||
      ctx.mod.types[ctx.anyValueTypeIdx] !== reservation.resource.type
    )
      fail("undefined provider changed native singleton identity");
  } else if (ctx.standalone || ctx.nativeStrings || hostCapability(ctx) !== reservation.resource.imported) {
    fail("undefined provider changed host capability identity");
  }
  if (!sameInstructions(reservation.func.body, canonicalUndefinedExternInstrs(ctx)))
    fail("undefined provider body no longer uses its exact resource");
}
