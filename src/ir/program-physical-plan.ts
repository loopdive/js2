// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — the source-free PHYSICAL SETUP PLAN for one accepted
// backend/target projection of a `PreparedIrProgram`.
//
// Acceptance derives this plan from the program's authoritative ABI entries,
// startup plans and the selected runtime projection — nothing else. It names
// every physical resource emission will reserve (imports, globals, function
// slots, exports with their index space, start adapter, exception tag) and,
// just as importantly, every resource this increment cannot yet materialize.
// A gap is a located, typed `unsupported` at ACCEPTANCE time; it is never a
// smaller module. The returned plan is deep-frozen data over A's types; this
// Native string declarations are borrowed from the canonical backend recipe;
// no resource allocation, codegen context or frontend code enters this plan.

import { irGlobalBindingKey, irTypeBindingKey, irSupportGlobalRef, irSourceTypeRef } from "./abi-bindings.js";
import {
  irCallableBindingKey,
  irUnitCallableBindingId,
  irSupportFuncRef,
  irRuntimeFuncRef,
} from "./callable-bindings.js";
import type { IrFuncRef, IrGlobalRef } from "./core/value-references.js";
import type { IrTypeRef } from "./core/types.js";
import { INTRINSIC_DEFINITIONS } from "./core/intrinsics.js";
import { NUMBER_BOUNDARY_RUNTIME_PROVIDERS } from "./runtime/manifest.js";
import { ProgramAbiMap, type ProgramAbiPlanEntry } from "./program/abi.js";
import { preparedIrCallableSignature, preparedIrTypeKey, preparedIrDataKey } from "./program-abi-contracts.js";
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "./program-runtime-abi.js";
import { preparedIrDataMismatch } from "./program/data.js";
import {
  planNativeStringValuePhysical,
  type NativeStringValuePhysicalPlan,
  type NativeStringValueReservationInput,
} from "../backend/wasmgc/program/native-string-values.js";
import type { NativeStringValueDeclaration } from "../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import { forEachInstrDeep, type IrFunction, type IrType } from "./nodes.js";
import type { IrPreparationFailure } from "./outcomes.js";
import {
  freezePreparedIrValue,
  preparedIrProgramOwner,
  PreparedIrProgramInvariantError,
  type PreparedIrAbiEntry,
  type PreparedIrBackendOptions,
  type PreparedIrProgram,
  type PreparedIrProgramFailure,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
import type { ValType } from "./types.js";
import { deriveNativeVectorResourcePlan, type NativeVectorResourcePlan } from "./program/native-vector-resources.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  deriveNativeValueResourcePlan,
  assertNativeValueResourcePlanFor,
  type NativeValueResourcePlan,
  type NativeValueStringRepresentation,
} from "./program/native-value-resources.js";
import {
  deriveNativePromiseResourcePlan,
  type NativePromiseConfiguration,
  type NativePromiseResourcePlan,
} from "./program/native-promise-resources.js";

/** Vector/string carriers stay logical until the consumer reserves their shared types. */
export type PhysicalSignatureType = ValType | Extract<IrType, { kind: "vec" | "string" }>;

export interface NativeStringValueAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef | IrGlobalRef | IrTypeRef;
}

export interface PhysicalNativeStringSetup {
  readonly resources: NativeStringValuePhysicalPlan;
  readonly bindings: readonly NativeStringValueAbiBinding[];
}

export interface PhysicalFunctionSlot {
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly name: string;
  readonly params: readonly PhysicalSignatureType[];
  readonly results: readonly PhysicalSignatureType[];
}

export interface PhysicalImportedFunction {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly module: string;
  readonly field: string;
  readonly params: readonly PhysicalSignatureType[];
  readonly results: readonly PhysicalSignatureType[];
}

export interface PhysicalDefinedGlobal {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly name: string;
  readonly type: ValType;
  readonly mutable: boolean;
}

export interface PhysicalImportedGlobal extends PhysicalDefinedGlobal {
  readonly module: string;
  readonly field: string;
}

export interface PhysicalExport {
  readonly externalName: string;
  readonly targetBindingId: IrBindingId;
  /** Index space of the canonical target, decided at planning. */
  readonly space: "function" | "global";
}

export interface PhysicalStartup {
  /** Executable startup bodies in semantic module-evaluation order. */
  readonly units: readonly IrUnitId[];
  readonly adapter: "none" | "wasm-start" | "deferred-export";
}

export interface PhysicalExceptionTag {
  /** Some body throws or catches, so a `__exn` tag must exist. */
  readonly required: boolean;
  /** Requested by the options: import `env.__exn` instead of defining a local tag. */
  readonly shared: boolean;
}

/** Everything emission will reserve, in the order it will reserve it. Deep-frozen. */
export interface PhysicalSetupPlan {
  readonly backend: PreparedIrBackendOptions["backend"];
  readonly target: PreparedIrBackendOptions["target"];
  readonly exceptionTag: PhysicalExceptionTag;
  readonly vectors: NativeVectorResourcePlan;
  /** Descriptive only: the issued reservation input stays in the consumer's private record. */
  readonly nativeStrings?: PhysicalNativeStringSetup;
  readonly importedFunctions: readonly PhysicalImportedFunction[];
  readonly importedGlobals: readonly PhysicalImportedGlobal[];
  readonly definedGlobals: readonly PhysicalDefinedGlobal[];
  /** Projection order; every physical body gets exactly one slot. */
  readonly functions: readonly PhysicalFunctionSlot[];
  readonly exports: readonly PhysicalExport[];
  readonly startup: PhysicalStartup;
}

export type PhysicalSetupOutcome =
  | { readonly kind: "planned"; readonly plan: PhysicalSetupPlan }
  | PreparedIrProgramFailure;

/** Checked program entry; the canonical calculation has no acceptance authority. */
export function planNativeVectorResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
): NativeVectorResourcePlan {
  assertPreparedIrProgram(program);
  if (
    !program.runtime.includes(projection) ||
    projection.backend !== options.backend ||
    projection.target !== options.target
  ) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native vector resources: selected projection does not belong to the requested program/backend/target",
    );
  }
  const entry = program.inventory.sources.find((source) => source.kind === "entry");
  if (!entry) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native vector resources: missing entry-source anchor",
    );
  }
  return deriveNativeVectorResourcePlan({
    anchor: entry.id,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: options.backend,
    target: options.target,
  });
}

/** Authenticate the program and projection; runtime configuration remains an explicit caller choice. */
export function planNativePromiseResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
): NativePromiseResourcePlan {
  assertPreparedIrProgram(program);
  if (
    !program.runtime.includes(projection) ||
    projection.backend !== options.backend ||
    projection.target !== options.target
  ) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native Promise resources: selected projection does not belong to the requested program/backend/target",
    );
  }
  const entry = program.inventory.sources.find((source) => source.kind === "entry");
  if (!entry) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native Promise resources: missing entry-source anchor",
    );
  }
  return deriveNativePromiseResourcePlan({
    anchor: entry.id,
    functions: program.ir.functions,
    selectedFunctions: projection.prepared.functions,
    derivedUnits: program.derivedUnits,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: options.backend,
    target: options.target,
    configuration,
  });
}

/** Authenticate the complete program and current projection before deriving value requirements. */
export function planNativeValueResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  strings: NativeValueStringRepresentation,
): NativeValueResourcePlan {
  assertPreparedIrProgram(program);
  if (
    !program.runtime.includes(projection) ||
    projection.backend !== options.backend ||
    projection.target !== options.target
  ) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native value resources: selected projection does not belong to the requested program/backend/target",
    );
  }
  return deriveNativeValueResourcePlan(program, projection, strings);
}

function scalar(type: IrType): ValType | undefined {
  return type.kind === "val" ? type.val : undefined;
}

function numeric(type: ValType): boolean {
  return type.kind === "i32" || type.kind === "i64" || type.kind === "f32" || type.kind === "f64";
}

function typeLabel(type: IrType): string {
  return type.kind === "val" ? type.val.kind : type.kind;
}

class Gaps {
  readonly rows: { readonly unitId: IrUnitId | undefined; readonly detail: string }[] = [];
  add(detail: string, unitId?: IrUnitId): void {
    this.rows.push({ unitId, detail });
  }
}

/** Follow export aliases to the canonical required entry. */
function canonicalEntry(
  entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>,
  id: IrBindingId,
): PreparedIrAbiEntry | undefined {
  const seen = new Set<IrBindingId>();
  let current = entries.get(id);
  while (current && current.plan.slotPolicy === "alias" && !seen.has(current.plan.id)) {
    seen.add(current.plan.id);
    current = entries.get(current.plan.aliasOf);
  }
  return current;
}

function nativeInvalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native string ABI: ${detail}`);
}

function nativeSame(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) nativeInvalid(detail);
}

function nativeRole(declaration: NativeStringValueDeclaration): string {
  return "native-string-values:v1:" + JSON.stringify(declaration.role);
}

/** Opaque keys retain the complete versioned declaration, not eventual indices. */
function nativeDeclarationKey(declaration: NativeStringValueDeclaration, part: unknown): string {
  return "native-string-values:abi:v1:" + preparedIrDataKey({ declaration, part });
}

function nativeReferenceKey(ref: NativeStringValueAbiBinding["reference"]): string {
  if (ref.kind === "func") return irCallableBindingKey(ref.binding);
  return ref.kind === "global" ? irGlobalBindingKey(ref.binding) : irTypeBindingKey(ref.binding);
}

function declarationForRole(
  resources: NativeStringValuePhysicalPlan,
  role: readonly string[],
): NativeStringValueDeclaration {
  const rows = resources.declarations.filter((row) => preparedIrDataMismatch(row.role, role) === undefined);
  if (rows.length !== 1) nativeInvalid(`missing/duplicate declaration role ${JSON.stringify(role)}`);
  return rows[0]!;
}

function internalNativeBinding(
  program: PreparedIrProgram,
  declaration: NativeStringValueDeclaration,
  declarationOrder: number,
): NativeStringValueAbiBinding {
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  const role = nativeRole(declaration);
  const name = declaration.space === "type" ? role : declaration.name;
  const reference =
    declaration.space === "function"
      ? irSupportFuncRef(anchor.id, role, name)
      : declaration.space === "global"
        ? irSupportGlobalRef(anchor.id, role, name)
        : irSourceTypeRef(anchor.id, role, name);
  if (!("bindingId" in reference.binding)) nativeInvalid("internal declaration lacks a structural binding ID");
  const intent: ProgramAbiPlanEntry["intent"] =
    declaration.space === "function"
      ? {
          kind: "callable",
          origin: "support",
          sourceId: anchor.id,
          signature: {
            params: declaration.signature.params.map((value) => nativeDeclarationKey(declaration, value)),
            results: declaration.signature.results.map((value) => nativeDeclarationKey(declaration, value)),
          },
        }
      : declaration.space === "global"
        ? {
            kind: "global",
            origin: "support",
            valueType: nativeDeclarationKey(declaration, declaration.valueType),
            mutable: declaration.mutable,
          }
        : { kind: "type", shapeKey: nativeDeclarationKey(declaration, declaration.shape) };
  return {
    resourceKey: declaration.key,
    reference,
    entry: {
      id: reference.binding.bindingId,
      order: { sourceOrder: anchor.order, declarationOrder },
      displayName: name,
      structuralReferenceKey: nativeReferenceKey(reference),
      slotPolicy: "required",
      slotSpace: declaration.space,
      intent,
    },
  };
}

interface NativeAbiContext {
  readonly program: PreparedIrProgram;
  readonly resources: NativeStringValuePhysicalPlan;
  readonly entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>;
  readonly abi: ProgramAbiMap;
}

/** An attached carrier must name this recipe's AnyString declaration structurally. */
function nativeStringCarrier(type: IrType, context: NativeAbiContext): Extract<IrType, { kind: "string" }> {
  const ref = type.kind === "string" ? type.carrierRef : type.kind === "val" ? type.typeRef : undefined;
  if (type.kind !== "string" && !(type.kind === "val" && ref && type.val.kind === "ref"))
    nativeInvalid("literal/signature is not a semantic string or explicitly joined string carrier");
  if (ref) {
    const declaration = declarationForRole(context.resources, ["string-type", "any"]);
    const expected = internalNativeBinding(context.program, declaration, 0).reference;
    if (ref.kind !== "type" || expected.kind !== "type" || nativeReferenceKey(ref) !== nativeReferenceKey(expected))
      nativeInvalid("string carrier reference is not the accepted AnyString structural declaration");
    const entry = context.entries.get(context.abi.canonicalId(ref.binding.bindingId));
    if (
      entry?.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "type" ||
      entry.contract.kind !== "type" ||
      entry.plan.intent.kind !== "type" ||
      nativeReferenceKey(entry.contract.ref) !== nativeReferenceKey(expected) ||
      entry.contract.type.kind !== "string" ||
      Object.hasOwn(entry.contract.type, "carrierRef")
    )
      nativeInvalid("string carrier reference has no explicit required semantic AnyString type join");
    nativeSame(
      entry.plan.intent.shapeKey,
      preparedIrTypeKey(entry.contract.type),
      "AnyString semantic shape contradicts its intent",
    );
  } else if (type.kind !== "string" || Object.hasOwn(type, "carrierRef")) {
    nativeInvalid("missing explicit string carrier reference");
  }
  return type.kind === "string" ? type : { kind: "string", carrierRef: ref! };
}

function literalNativeBinding(
  context: NativeAbiContext,
  declaration: NativeStringValueDeclaration,
  reference: IrGlobalRef | IrFuncRef,
): NativeStringValueAbiBinding {
  if (reference.binding.kind !== "support") nativeInvalid("literal reference is not support-owned");
  const declared = context.entries.get(reference.binding.bindingId);
  if (!declared || declared.plan.structuralReferenceKey !== nativeReferenceKey(reference))
    nativeInvalid("existing literal reference lacks its exact ABI entry");
  const entry = context.entries.get(context.abi.canonicalId(declared.plan.id));
  if (!entry || entry.plan.slotPolicy !== "required" || entry.plan.slotSpace !== declaration.space)
    nativeInvalid("existing literal reference resolves to missing, slotless or wrong-space storage");
  const { contract, plan } = entry;
  if (
    reference.kind === "global" &&
    declaration.space === "global" &&
    contract.kind === "global" &&
    plan.intent.kind === "global"
  ) {
    if (
      contract.ref.binding.kind !== "support" ||
      plan.intent.origin !== "support" ||
      contract.mutable ||
      plan.intent.mutable ||
      declaration.mutable
    )
      nativeInvalid("literal global must be immutable support storage");
    nativeStringCarrier(contract.type, context);
    nativeSame(plan.intent.valueType, preparedIrTypeKey(contract.type), "literal global semantic intent differs");
  } else if (
    reference.kind === "func" &&
    declaration.space === "function" &&
    contract.kind === "callable" &&
    plan.intent.kind === "callable"
  ) {
    if (
      contract.ref.binding.kind !== "support" ||
      plan.intent.origin !== "support" ||
      contract.params.length !== 0 ||
      contract.results.length !== 1 ||
      Object.hasOwn(contract, "promise")
    )
      nativeInvalid("literal materializer is not zero-argument, one-string, non-Promise support");
    nativeStringCarrier(contract.results[0]!, context);
    nativeSame(
      plan.intent.signature,
      preparedIrCallableSignature(contract.params, contract.results),
      "materializer semantic intent differs",
    );
  } else nativeInvalid("literal reference contract does not match its selected realization");
  if (plan.structuralReferenceKey !== nativeReferenceKey(contract.ref))
    nativeInvalid("canonical literal reference payload differs");
  return { resourceKey: declaration.key, entry: plan, reference };
}

function nativeUnboxBinding(
  context: NativeAbiContext,
  input: NativeStringValueReservationInput,
  declarationOrder: number,
): NativeStringValueAbiBinding | undefined {
  const { projection } = input.demands;
  const demands = input.demands.intrinsics.filter(
    (row) =>
      row.instruction.id === "js.number.unbox" &&
      input.demands.buffers[input.demands.occurrences[row.occurrence]!.bufferIndex]!.view === "projection",
  );
  if (!demands.length) {
    if (input.plan.mode !== "literals") nativeInvalid("number-boundary plan has no actual unbox demand");
    return undefined;
  }
  const canonical = NUMBER_BOUNDARY_RUNTIME_PROVIDERS.filter((row) => row.id === "native.js.number.unbox");
  if (canonical.length !== 1) nativeInvalid("canonical unbox provider is not unique");
  const provider = canonical[0]!;
  if (provider.implementation.kind !== "runtime-callable" || !provider.signature)
    nativeInvalid("canonical unbox contract is not callable");
  const manifest = projection.prepared.manifest;
  const selected = manifest.providers.filter((row) => row.id === provider.id || row.feature === provider.feature);
  if (
    input.plan.mode !== "number-boundary" ||
    manifest.policy.numberBoundary.unbox !== "native" ||
    selected.length !== 1
  )
    nativeInvalid("unbox requires the unique selected native number-boundary policy/provider");
  nativeSame(selected[0], provider, "manifest unbox provider differs from complete canonical definition");
  nativeSame(
    projection.prepared.providers.get("js.number.unbox"),
    provider,
    "selected unbox lookup differs from canonical provider",
  );
  nativeSame(
    provider.signature,
    INTRINSIC_DEFINITIONS["js.number.unbox"].signature,
    "canonical intrinsic/unbox signatures differ",
  );
  const reference = irRuntimeFuncRef(provider.implementation.symbol);
  for (const { instruction } of demands) {
    if (instruction.provider?.kind !== "callable") nativeInvalid("unbox attachment is not callable");
    nativeSame(
      instruction.provider.target.binding,
      reference.binding,
      "unbox attachment target is not the selected runtime binding",
    );
  }
  const declaration = declarationForRole(context.resources, ["values", "unbox-number"]);
  if (declaration.space !== "function") nativeInvalid("unbox declaration is not a function");
  const physical = (type: IrType): ValType => {
    if (type.kind !== "val" || Object.hasOwn(type, "typeRef"))
      nativeInvalid("canonical number-boundary signature has a non-scalar carrier");
    return type.val;
  };
  nativeSame(
    declaration.signature,
    { params: provider.signature.params.map(physical), results: [physical(provider.signature.result)] },
    "unbox recipe disagrees with canonical carriers",
  );
  const signature = preparedIrCallableSignature(provider.signature.params, [provider.signature.result]);
  const id = preparedIrRuntimeCallableBindingId(context.program.inventory, reference);
  const entry: ProgramAbiPlanEntry = {
    id,
    order: { sourceOrder: preparedIrRuntimeAbiAnchor(context.program.inventory).order, declarationOrder },
    displayName: reference.name,
    structuralReferenceKey: irCallableBindingKey(reference.binding),
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "runtime", signature },
  };
  const previous = context.entries.get(id);
  if (previous) {
    nativeSame(
      previous.plan,
      { ...entry, order: previous.plan.order, displayName: previous.plan.displayName },
      "existing runtime unbox ABI entry contradicts its canonical contract",
    );
    if (previous.contract.kind !== "callable" || Object.hasOwn(previous.contract, "promise"))
      nativeInvalid("existing unbox semantic contract is not synchronous callable");
    nativeSame(previous.contract.ref.binding, reference.binding, "existing unbox reference differs");
    nativeSame(
      preparedIrCallableSignature(previous.contract.params, previous.contract.results),
      signature,
      "existing unbox semantic signature differs",
    );
  }
  return { resourceKey: declaration.key, entry: previous?.plan ?? entry, reference };
}

/** Complete descriptive ABI join. It never reserves or clones an issued native plan. */
function nativeStringSetup(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  input: NativeStringValueReservationInput,
): PhysicalNativeStringSetup {
  if (
    options.backend !== "wasmgc" ||
    options.target !== "standalone" ||
    input.demands.program !== program ||
    input.demands.projection !== projection
  )
    nativeInvalid("native input does not belong to the selected standalone program/projection");
  const current = planNativeStringValuePhysical(input.demands, {
    representation: "native-string",
    utf8Storage: options.utf8Storage,
  });
  if (current.kind !== "planned") nativeInvalid("native input has no supported current physical recipe");
  nativeSame(input.plan, current.plan, "native declarations or selection changed");
  if (input.plan.mode === "number-boundary") {
    if (!input.valueRequirements) nativeInvalid("missing exact issued native value plan");
    assertNativeValueResourcePlanFor(input.valueRequirements, program, projection, "native-string");
  } else if (input.valueRequirements !== undefined)
    nativeInvalid("literal-only plan unexpectedly carries value requirements");
  const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const row of program.abi.entries) abi.plan(row.plan);
  abi.sealPlan();
  const context: NativeAbiContext = {
    program,
    resources: input.plan,
    abi,
    entries: new Map(program.abi.entries.map((row) => [row.plan.id, row])),
  };
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  let baseOrder = 0;
  for (const row of program.abi.entries)
    if (row.plan.order.sourceOrder === anchor.order)
      baseOrder = Math.max(baseOrder, row.plan.order.declarationOrder + 1);
  if (!Number.isSafeInteger(baseOrder) || !Number.isSafeInteger(baseOrder + input.plan.declarations.length))
    nativeInvalid("supplemental declaration order overflows safe integers");
  const bindings: NativeStringValueAbiBinding[] = [];
  const owners = new Map<string, IrBindingId>(),
    keys = new Map<IrBindingId, string>();
  const add = (binding: NativeStringValueAbiBinding) => {
    const owner = owners.get(binding.resourceKey),
      key = keys.get(binding.entry.id);
    if ((owner && owner !== binding.entry.id) || (key && key !== binding.resourceKey))
      nativeInvalid("two independent required roots cannot own one token, or one root two tokens");
    owners.set(binding.resourceKey, binding.entry.id);
    keys.set(binding.entry.id, binding.resourceKey);
    if (
      !bindings.some(
        (row) =>
          row.resourceKey === binding.resourceKey &&
          nativeReferenceKey(row.reference) === nativeReferenceKey(binding.reference),
      )
    )
      bindings.push(binding);
  };
  for (const use of input.plan.literalUses) {
    const demand = input.demands.literals[use.demandIndex]!;
    if (demand.kind !== "string.const") nativeInvalid("nonliteral in executable string binding population");
    const reference = demand.instruction.storage ?? demand.instruction.materializer;
    if (!reference) continue;
    const declaration = declarationForRole(input.plan, [
      reference.kind === "global" ? "literal-global" : "literal-materializer",
      use.cacheKey,
    ]);
    const binding = literalNativeBinding(context, declaration, reference);
    add(binding);
    const root = context.entries.get(binding.entry.id)!.contract;
    if (root.kind === "global" || root.kind === "callable") add({ ...binding, reference: root.ref });
  }
  const unboxIndex = input.plan.declarations.findIndex(
    (row) => preparedIrDataMismatch(row.role, ["values", "unbox-number"]) === undefined,
  );
  const unbox = nativeUnboxBinding(context, input, baseOrder + unboxIndex);
  if (unbox) add(unbox);
  const seen = new Set<string>();
  for (const [index, declaration] of input.plan.declarations.entries()) {
    if (seen.has(declaration.key)) nativeInvalid("duplicate resource declaration key");
    seen.add(declaration.key);
    if (owners.has(declaration.key)) continue;
    const binding = internalNativeBinding(program, declaration, baseOrder + index);
    const previous = context.entries.get(binding.entry.id);
    if (previous) {
      if (
        declaration.space === "type" &&
        declaration.role.length === 2 &&
        declaration.role[0] === "string-type" &&
        declaration.role[1] === "any"
      ) {
        if (binding.reference.kind !== "type") nativeInvalid("AnyString recipe reference is not a type");
        nativeStringCarrier({ kind: "string", carrierRef: binding.reference }, context);
      } else
        nativeSame(
          previous.plan,
          { ...binding.entry, order: previous.plan.order, displayName: previous.plan.displayName },
          "existing internal declaration contradicts canonical recipe",
        );
      add({ ...binding, entry: previous.plan });
    } else add(binding);
  }
  if (seen.size !== owners.size || bindings.some((row) => !seen.has(row.resourceKey)))
    nativeInvalid("resource binding population does not equal complete recipe");
  // Validate new IDs/orders and alias contracts using the same ABI rules as emission.
  const joined = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const row of program.abi.entries) joined.plan(row.plan);
  for (const [id] of keys)
    if (!context.entries.has(id)) joined.plan(bindings.find((row) => row.entry.id === id)!.entry);
  joined.sealPlan();
  return { resources: input.plan, bindings };
}

function physicalSignatureConverter(
  program: PreparedIrProgram,
  vectors: NativeVectorResourcePlan,
  gaps: Gaps,
  native?: PhysicalNativeStringSetup,
) {
  const abi = native ? new ProgramAbiMap(program.inventory, program.derivedUnits) : undefined;
  if (abi) {
    for (const row of program.abi.entries) abi.plan(row.plan);
    abi.sealPlan();
  }
  const context =
    native && abi
      ? {
          program,
          resources: native.resources,
          abi,
          entries: new Map(program.abi.entries.map((row) => [row.plan.id, row])),
        }
      : undefined;
  return (types: readonly IrType[], where: string, unitId?: IrUnitId): PhysicalSignatureType[] => {
    const out: PhysicalSignatureType[] = [];
    for (const type of types) {
      const value = scalar(type);
      if (
        context &&
        (type.kind === "string" || (type.kind === "val" && (type.val.kind === "ref" || type.val.kind === "ref_null")))
      ) {
        out.push(nativeStringCarrier(type, context));
        continue;
      }
      if (
        type.kind === "vec" &&
        !type.layout &&
        type.elementType.kind === "val" &&
        !type.elementType.typeRef &&
        (type.elementType.val.kind === "f64" || type.elementType.val.kind === "externref") &&
        vectors.layouts.includes(type.elementType.val.kind)
      ) {
        out.push(type);
        continue;
      }
      if (!value)
        gaps.add(
          `${where} carries non-scalar IR type ${typeLabel(type)}; physical carrier materialization is not available`,
          unitId,
        );
      else out.push(value);
    }
    return out;
  };
}

/**
 * Derive the physical setup for one projection, or the first located gap.
 * Only scalar carriers, unit/import callables, source/import globals, export
 * aliases onto functions or globals, wasm-start / deferred-export startup and
 * the `__exn` tag are materializable in this increment; every other need is
 * reported.
 */
export function planPhysicalSetup(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  native?: NativeStringValueReservationInput,
): PhysicalSetupOutcome {
  const gaps = new Gaps();
  const physical = projection.prepared.functions;
  const bodies = new Map<IrUnitId, IrFunction>(physical.map((fn) => [fn.unitId, fn] as const));
  const entries = new Map<IrBindingId, PreparedIrAbiEntry>(program.abi.entries.map((entry) => [entry.plan.id, entry]));
  const vectors = planNativeVectorResources(program, options, projection);
  const nativeStrings = native ? nativeStringSetup(program, options, projection, native) : undefined;
  const nativeIds = new Set(nativeStrings?.bindings.map((row) => row.entry.id));
  const convert = physicalSignatureConverter(program, vectors, gaps, nativeStrings);

  // 1. Function slots: one per physical body, signature from the body's own ABI contract.
  const functions: PhysicalFunctionSlot[] = [];
  for (const fn of physical) {
    const bindingId = irUnitCallableBindingId(fn.unitId);
    const own = entries.get(bindingId);
    if (own?.contract.kind !== "callable") {
      gaps.add(`body ${fn.name} has no declared callable ABI entry`, fn.unitId);
      continue;
    }
    if (fn.asyncPlan || fn.asyncRuntime) {
      gaps.add(`async body ${fn.name} needs scheduler/promise runtime materialization`, fn.unitId);
    }
    functions.push({
      unitId: fn.unitId,
      bindingId,
      name: fn.name,
      params: convert(own.contract.params, `body ${fn.name} params`, fn.unitId),
      results: convert(own.contract.results, `body ${fn.name} results`, fn.unitId),
    });
  }

  // 2. Every other required slot: imports, globals, or a gap. Exports are resolved to their space.
  const importedFunctions: PhysicalImportedFunction[] = [];
  const importedGlobals: PhysicalImportedGlobal[] = [];
  const definedGlobals: PhysicalDefinedGlobal[] = [];
  const exports: PhysicalExport[] = [];
  for (const entry of program.abi.entries) {
    const { plan, contract } = entry;
    if (contract.kind === "export") {
      const target = canonicalEntry(entries, contract.targetId);
      if (!target || target.plan.slotPolicy !== "required") {
        gaps.add(`export ${contract.externalName} does not resolve to a required binding`);
      } else if (target.plan.slotSpace === "function" || target.plan.slotSpace === "global") {
        exports.push({
          externalName: contract.externalName,
          targetBindingId: contract.targetId,
          space: target.plan.slotSpace,
        });
      } else {
        gaps.add(
          `export ${contract.externalName} targets the ${target.plan.slotSpace} index space, which is not exportable`,
        );
      }
      continue;
    }
    if (plan.slotPolicy !== "required") continue;
    if (nativeIds.has(plan.id)) continue;
    if (contract.kind === "callable") {
      const binding = contract.ref.binding;
      if (binding.kind === "unit") {
        if (!bodies.has(binding.unitId)) {
          gaps.add(
            `callable ${contract.ref.name} has no physical body in the ${options.backend}:${options.target} projection`,
            binding.unitId,
          );
        }
        continue;
      }
      if (binding.kind === "import") {
        importedFunctions.push({
          bindingId: plan.id,
          referenceKey: irCallableBindingKey(binding),
          module: binding.module,
          field: binding.field,
          params: convert(contract.params, `import ${binding.module}.${binding.field} params`),
          results: convert(contract.results, `import ${binding.module}.${binding.field} results`),
        });
        continue;
      }
      if (vectors.helper?.bindingId === plan.id && vectors.helper.referenceKey === irCallableBindingKey(binding)) {
        continue;
      }
      gaps.add(`${binding.kind} callable ${contract.ref.name} needs runtime function materialization`);
      continue;
    }
    if (contract.kind === "global") {
      const binding = contract.ref.binding;
      const type = scalar(contract.type);
      if (!type) {
        gaps.add(`global ${contract.ref.name} carries non-scalar IR type ${typeLabel(contract.type)}`);
        continue;
      }
      const base = {
        bindingId: plan.id,
        referenceKey: irGlobalBindingKey(binding),
        name: contract.ref.name,
        type,
        mutable: contract.mutable,
      };
      if (binding.kind === "import") {
        importedGlobals.push({ ...base, module: binding.module, field: binding.field });
      } else if (binding.kind === "source") {
        if (!numeric(type)) gaps.add(`source global ${contract.ref.name} needs a reference-typed default initializer`);
        else definedGlobals.push(base);
      } else {
        gaps.add(`${binding.kind} global ${contract.ref.name} needs runtime storage materialization`);
      }
      continue;
    }
    if (contract.kind === "type" || contract.kind === "class") {
      gaps.add(`${contract.kind} layout ${contract.ref.name} needs type materialization`);
      continue;
    }
    gaps.add(`support binding ${plan.id} (${contract.role}) needs runtime materialization`);
  }
  const exportNames = new Set<string>();
  for (const exported of exports) {
    if (exportNames.has(exported.externalName)) gaps.add(`export ${exported.externalName} is declared twice`);
    exportNames.add(exported.externalName);
  }

  // 3. Bodies may only reference what the plan reserves; exception use is a reserved resource too.
  const reserved = new Set<string>([
    ...functions.map((slot) => irCallableBindingKey({ kind: "unit", unitId: slot.unitId })),
    ...importedFunctions.map((fn) => fn.referenceKey),
    ...(vectors.helper ? [vectors.helper.referenceKey] : []),
    ...(nativeStrings?.bindings
      .filter((row) => row.reference.kind === "func")
      .map((row) => nativeReferenceKey(row.reference)) ?? []),
  ]);
  const reservedGlobals = new Set<string>([
    ...[...importedGlobals, ...definedGlobals].map((global) => global.referenceKey),
    ...(nativeStrings?.bindings
      .filter((row) => row.reference.kind === "global")
      .map((row) => nativeReferenceKey(row.reference)) ?? []),
  ]);
  let exceptionRequired = vectors.exceptionRequired;
  for (const fn of physical) {
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((s) => s.body) ?? []),
    ]) {
      for (const root of buffer) {
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call" || instruction.kind === "closure.new") {
            const ref = instruction.kind === "call" ? instruction.target : instruction.liftedFunc;
            if (!reserved.has(irCallableBindingKey(ref.binding))) {
              gaps.add(
                `body ${fn.name} references ${ref.binding.kind} callable ${ref.name} that the plan cannot reserve`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "global.get" || instruction.kind === "global.set") {
            if (!reservedGlobals.has(irGlobalBindingKey(instruction.target.binding))) {
              gaps.add(
                `body ${fn.name} references global ${instruction.target.name} that the plan cannot reserve`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "intrinsic") {
            const provider = instruction.provider;
            if (!provider) gaps.add(`body ${fn.name} intrinsic ${instruction.id} has no physical provider`, fn.unitId);
            else if (
              !(
                nativeStrings &&
                instruction.id === "js.number.unbox" &&
                provider.kind === "callable" &&
                reserved.has(irCallableBindingKey(provider.target.binding))
              ) &&
              provider.kind !== "backend-op" &&
              provider.kind !== "backend-sequence" &&
              provider.kind !== "backend-composite"
            ) {
              gaps.add(
                `body ${fn.name} intrinsic ${instruction.id} needs ${provider.kind} provider materialization`,
                fn.unitId,
              );
            }
          } else if (instruction.kind === "throw" || instruction.kind === "try") {
            exceptionRequired = true;
          }
        });
      }
    }
  }

  // 4. Startup: executable units in semantic order, one adapter.
  const startupUnits: IrUnitId[] = [];
  let adapter: PhysicalStartup["adapter"] = "none";
  for (const plan of program.startup) {
    if (!plan.executable || plan.unitId === null) continue;
    if (!bodies.has(plan.unitId))
      gaps.add(`startup source ${plan.sourceId} has no physical initializer body`, plan.unitId);
    startupUnits.push(plan.unitId);
    const kind = plan.invocation.kind;
    if (kind === "wasm-start" || kind === "deferred-export") {
      if (adapter !== "none" && adapter !== kind) {
        gaps.add(`startup sources disagree on the invocation adapter (${adapter} vs ${kind})`, plan.unitId);
      }
      adapter = kind;
    } else {
      gaps.add(`startup adapter ${kind} is not materializable (only wasm-start and deferred-export)`, plan.unitId);
    }
  }
  if (adapter === "deferred-export" && exportNames.has("__module_init")) {
    gaps.add("deferred startup export __module_init collides with a program export of the same name");
  }

  // 5. Linear physical needs beyond scalar bodies.
  if (options.backend === "linear" && program.allocations.size > 0) {
    gaps.add(`linear memory plan for ${program.allocations.size} allocation site(s) is not materializable`);
  }

  if (gaps.rows.length > 0) {
    const first = gaps.rows[0]!;
    const unitId = first.unitId ?? physical[0]?.unitId ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) {
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan: ${first.detail}`);
    }
    const failure: IrPreparationFailure = {
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: `${options.backend}:${options.target} physical setup cannot be materialized (${gaps.rows.length} gap${
        gaps.rows.length === 1 ? "" : "s"
      }): ${gaps.rows.map((row) => row.detail).join("; ")}`,
    };
    const owner = preparedIrProgramOwner(program, unitId);
    if (!owner)
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan cannot locate ${unitId}`);
    return Object.freeze({ ...failure, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
  }

  const plan: PhysicalSetupPlan = {
    backend: options.backend,
    target: options.target,
    exceptionTag: { required: exceptionRequired || options.sharedExceptionTag, shared: options.sharedExceptionTag },
    vectors,
    ...(nativeStrings ? { nativeStrings } : {}),
    importedFunctions,
    importedGlobals,
    definedGlobals,
    functions,
    exports,
    startup: { units: startupUnits, adapter },
  };
  // Deep-frozen, null-prototype copy: nested records and arrays included.
  return { kind: "planned", plan: freezePreparedIrValue(plan) as PhysicalSetupPlan };
}
