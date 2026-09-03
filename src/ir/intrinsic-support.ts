// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import { createIrAsyncPlan, createPreparedIrAsyncRuntime, type IrAsyncPlan } from "./async-plan.js";
import { asAsyncHostAdapter, isAsyncHostCapabilityId, type AsyncHostCapabilityId } from "./async-runtime-providers.js";
import {
  resolveRuntimeHostCapabilityFuncFamilyRecord,
  resolveRuntimeHostCapabilityFuncRecord,
  resolveRuntimeHostCapabilityGlobalRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityFieldScheme,
  type RuntimeHostCapabilityRecord,
  type RuntimeHostCapabilityValueType,
} from "./runtime-host-capabilities.js";
import { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "./async-semantic-runtime.js";
import type { IrStringConcatMode } from "./string-runtime.js";
import { intrinsicEffectEvidence, INTRINSIC_DEFINITIONS } from "./intrinsics.js";
import {
  forEachInstrDeep,
  irTypeEquals,
  mapNestedBuffers,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
  type IrIntrinsicBackendComposite,
  type IrIntrinsicProvider,
  type IrType,
  type IrValueId,
} from "./nodes.js";
import {
  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  STRING_COMPARE_RUNTIME_FEATURES,
  STRING_EQ_RUNTIME_FEATURES,
  STRING_LEN_RUNTIME_FEATURES,
  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  STRING_CONCAT_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_RUNTIME_FEATURES,
  STRING_CONST_RUNTIME_FEATURES,
  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  RuntimeManifestBuilder,
  projectRuntimeBackendRequirements,
  RUNTIME_PROVIDERS,
  type FrozenRuntimeManifest,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
  type RuntimeProviderPlan,
  type StringConstRuntimeFeature,
} from "./runtime-manifest.js";

export interface PreparedIrRuntimeManifest {
  readonly functions: readonly IrFunction[];
  readonly manifest: FrozenRuntimeManifest;
  /** Lookup-only handle retained after freeze for verifier/lowering adapters. */
  readonly providers: ReadonlyMap<IrInstrIntrinsic["id"], RuntimeProviderPlan>;
}

const BACKEND_COMPOSITE_BY_INTRINSIC: Readonly<Partial<Record<IrInstrIntrinsic["id"], IrIntrinsicBackendComposite>>> =
  Object.freeze({
    "js.to_uint32": "to-uint32",
    "math.clz32": "math.clz32",
    "math.imul": "math.imul",
    "math.max": "math.max",
    "math.min": "math.min",
  });

/**
 * (#3526 F1-S1) Closed set of PHYSICAL callable targets each intrinsic admits,
 * derived from the provider catalogue and the central capability records — not
 * from an emitted import spelling. The semantic identity of the instruction is
 * always the versioned `IntrinsicId`; these keys authenticate the exact
 * physical target a frozen provider is allowed to attach, so a crosswire, a
 * wrong capability, or a wrong runtime symbol rejects before materialization.
 */
function callableBindingKey(binding: IrFuncRef["binding"]): string {
  switch (binding.kind) {
    case "import":
      return `import:${binding.module}:${binding.field}`;
    case "runtime":
      return `runtime:${binding.symbol}`;
    case "intrinsic":
      return `intrinsic:${binding.symbol}`;
    default:
      return `other:${binding.kind}`;
  }
}

const ADMITTED_CALLABLE_TARGETS: ReadonlyMap<IrInstrIntrinsic["id"], ReadonlySet<string>> = (() => {
  const table = new Map<IrInstrIntrinsic["id"], Set<string>>();
  for (const provider of RUNTIME_PROVIDERS) {
    const implementation = provider.implementation;
    if (implementation.kind !== "host-callable" && implementation.kind !== "runtime-callable") continue;
    for (const [id, definition] of Object.entries(INTRINSIC_DEFINITIONS)) {
      if (definition.feature !== provider.feature) continue;
      const key =
        implementation.kind === "host-callable"
          ? callableBindingKey(
              irImportFuncRef(
                // (#3526 F2-S2) `resolveRuntimeHostCapabilityFuncRecord` is the
                // fail-closed kind guard: a global capability has no callable
                // spelling, so admitting one here would mint a nonsense target.
                ...((record) => [record.module, record.field] as const)(
                  resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, implementation.capability),
                ),
              ).binding,
            )
          : callableBindingKey(irRuntimeFuncRef(implementation.symbol).binding);
      const admitted = table.get(id as IrInstrIntrinsic["id"]) ?? new Set<string>();
      admitted.add(key);
      table.set(id as IrInstrIntrinsic["id"], admitted);
    }
  }
  return table;
})();

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
  if (instr.provider?.kind === "callable") {
    const binding = instr.provider.target.binding;
    if (binding.kind === "intrinsic") {
      if (binding.symbol !== instr.id) {
        errors.push(`${instr.id} callable provider must retain the semantic intrinsic binding`);
      }
    } else {
      // (#3526 F1-S1) A physical import/runtime target is admitted only when
      // the closed provider catalogue names it for THIS intrinsic. Keeping the
      // physical identity (rather than a capability-only one) is deliberate:
      // the union import is shared with raw consumers and its ABI/order must
      // not drift.
      const admitted = ADMITTED_CALLABLE_TARGETS.get(instr.id);
      if (!admitted || !admitted.has(callableBindingKey(binding))) {
        errors.push(
          `${instr.id} callable provider target ${callableBindingKey(binding)} is not an admitted physical provider`,
        );
      }
    }
  }
  if (instr.provider?.kind === "backend-composite") {
    const expected = BACKEND_COMPOSITE_BY_INTRINSIC[instr.id];
    if (instr.provider.operation !== expected) {
      errors.push(
        expected === undefined
          ? `${instr.id} does not admit a backend composite provider`
          : `${instr.id} backend composite provider must use ${expected}, got ${instr.provider.operation}`,
      );
    }
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

function providerAttachment(
  id: IrInstrIntrinsic["id"],
  provider: RuntimeProviderPlan,
  capabilityRecords: readonly RuntimeHostCapabilityRecord[],
): IrIntrinsicProvider {
  if (provider.implementation.kind === "backend-op") {
    return Object.freeze({ kind: "backend-op", opcode: provider.implementation.opcode });
  }
  if (provider.implementation.kind === "backend-sequence") {
    return Object.freeze({ kind: "backend-sequence", sequence: provider.implementation.sequence });
  }
  if (provider.implementation.kind === "backend-composite") {
    return Object.freeze({ kind: "backend-composite", operation: provider.implementation.operation });
  }
  if (provider.implementation.kind === "host-callable") {
    // The canonical record IS the manifest authority for this ABI; the emitted
    // target stays the exact physical union import so raw consumers and import
    // order are untouched.
    const record = resolveRuntimeHostCapabilityFuncRecord(capabilityRecords, provider.implementation.capability);
    return Object.freeze({ kind: "callable", target: irImportFuncRef(record.module, record.field, record.field) });
  }
  if (provider.implementation.kind === "runtime-callable") {
    return Object.freeze({ kind: "callable", target: irRuntimeFuncRef(provider.implementation.symbol) });
  }
  return Object.freeze({
    kind: "callable",
    // Structural identity remains the semantic ID. The compatibility name is
    // the selected concrete provider spelling used by the existing registry.
    target: irIntrinsicFuncRef(id, provider.implementation.symbol),
  });
}

/** The one generator-boxing feature row; named once so no caller spells it. */
const GENERATOR_NUMBER_BOX_RUNTIME_FEATURE = GENERATOR_NUMBER_BOX_RUNTIME_FEATURES[0];

/**
 * (#3526 F1-S3) The callable the frozen manifest selected for the numeric
 * `gen.setReturn` arm, as the generator seam must bind it.
 *
 * The binding kind is `runtime`, not `import`, and that is a MEASURED
 * constraint rather than a preference: `attachIrGeneratorSupport`'s providers
 * are observed through `resolveAndObserveCallableProvider`, which admits only
 * `runtime` and `intrinsic` references by design. Attaching the host arm's
 * canonical `env.__box_number` import reference instead fails every generator
 * owner with `unexpected-internal-throw` on both host lanes (measured on the
 * grounded tree before this change). So the manifest decides WHICH physical
 * symbol answers the seam — through the central capability record on the host
 * arm, through the union-native runtime symbol on the native arm — and the
 * seam binds that symbol the only way its observation path accepts. The
 * physical target is identical either way, which is why the migration is
 * byte-neutral.
 */
export function preparedGeneratorNumberBoxProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
): IrFuncRef | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === GENERATOR_NUMBER_BOX_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable") {
    return irRuntimeFuncRef(provider.implementation.symbol);
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return irRuntimeFuncRef(record.field);
  }
  throw new Error(`IR generator number-box provider ${provider.id} is not a callable implementation`);
}

/** The one string-compare feature row; named once so no caller spells it. */
const STRING_COMPARE_RUNTIME_FEATURE = STRING_COMPARE_RUNTIME_FEATURES[0];

/**
 * (#3526 F2-S1) Which arm of the string relational compare seam the frozen
 * manifest selected, or `undefined` when no manifest carries the row.
 *
 * This returns the CLASSIFICATION plus the exact physical spelling the selected
 * authority names — not an `IrFuncRef`. The seam's two arms are materialized by
 * different existing routines (`ctx.funcMap` lookup of the base import on the
 * host arm; `ensureNativeStringHelpers` + `nativeStrHelperHandle` on the native
 * one), so a single callable reference could not carry the decision without
 * moving a registration — and moving one would move import indices, which is
 * exactly what this slice must not do.
 */
export function preparedStringCompareProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
): { readonly arm: "host"; readonly field: string } | { readonly arm: "native"; readonly symbol: string } | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === STRING_COMPARE_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable") {
    return { arm: "native", symbol: provider.implementation.symbol };
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", field: record.field };
  }
  throw new Error(`IR string-compare provider ${provider.id} is not a callable implementation`);
}

/** The one string-eq feature row; named once so no caller spells it. */
const STRING_EQ_RUNTIME_FEATURE = STRING_EQ_RUNTIME_FEATURES[0];

/**
 * (#3526 F2-S3) Which arm of the string equality seam the frozen manifest
 * selected, or `undefined` when no manifest carries the row.
 *
 * Like {@link preparedStringCompareProvider} this returns the CLASSIFICATION
 * plus the physical spelling, not an `IrFuncRef` — the two arms are materialized
 * by different existing routines and a single callable reference could not carry
 * the decision without moving a registration.
 *
 * It differs from the compare's twin in ONE way, and the difference is the whole
 * reason F2-S2 had to land first: the host arm returns the record's MODULE as
 * well as its field. `wasm:js-string.equals` is a builtin import, not an `env`
 * one, so `ctx.funcMap` cannot name it unambiguously (it is keyed on the bare
 * field `equals`, which a user function shadows — #1072). The consumer looks it
 * up by import-section position instead, which needs both halves of the name.
 */
export function preparedStringEqProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
):
  | { readonly arm: "host"; readonly module: string; readonly field: string }
  | { readonly arm: "native"; readonly symbol: string }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === STRING_EQ_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable") {
    return { arm: "native", symbol: provider.implementation.symbol };
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", module: record.module, field: record.field };
  }
  throw new Error(`IR string-eq provider ${provider.id} is not a callable implementation`);
}

/** The one string-len feature row; named once so no caller spells it. */
const STRING_LEN_RUNTIME_FEATURE = STRING_LEN_RUNTIME_FEATURES[0];

/**
 * (#3526 F2-S4) Which arm of the string length seam the frozen manifest
 * selected, or `undefined` when no manifest carries the row.
 *
 * Third in the family-2 series and the first whose native arm is not a callable
 * at all: it returns the ABI **role** and field index the `carrier-field`
 * provider names, and the consumer resolves the role to the Program-ABI string
 * carrier's type ref. It deliberately does NOT return a physical type index —
 * the manifest is frozen before the carrier's layout is planned.
 *
 * The host arm carries the record's MODULE as well as its field, for the same
 * reason {@link preparedStringEqProvider} does: `wasm:js-string.length` is a
 * builtin, so locating it needs both halves of the name.
 */
export function preparedStringLenProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
):
  | { readonly arm: "host"; readonly module: string; readonly field: string }
  | { readonly arm: "native"; readonly carrier: "string"; readonly fieldIndex: number }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === STRING_LEN_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "carrier-field") {
    return { arm: "native", carrier: provider.implementation.carrier, fieldIndex: provider.implementation.fieldIndex };
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", module: record.module, field: record.field };
  }
  throw new Error(`IR string-len provider ${provider.id} is not a length implementation`);
}

/** The two string-concat feature rows, one per mode; named once so no caller spells them. */
const STRING_CONCAT_RUNTIME_FEATURE = STRING_CONCAT_RUNTIME_FEATURES[0];
const STRING_CONCAT_OWNED_RUNTIME_FEATURE = STRING_CONCAT_RUNTIME_FEATURES[1];

/** The frozen feature row a concat instruction of `mode` answers to. */
function stringConcatFeatureFor(mode: IrStringConcatMode): string {
  return mode === "owned-append" ? STRING_CONCAT_OWNED_RUNTIME_FEATURE : STRING_CONCAT_RUNTIME_FEATURE;
}

/**
 * (#3526 F2-S5) Which arm of the string concatenation seam the frozen manifest
 * selected for `mode`, or `undefined` when no manifest carries that row.
 *
 * The family's fourth twin, and the first that takes a second argument: the
 * policy chose the AUTHORITY, and the instruction's `concatMode` chooses which
 * of the two helpers on that authority answers. On the host lane both modes
 * resolve to the SAME `wasm:js-string.concat` record — `wasm:js-string` has no
 * owned append builtin — and the two feature rows say so explicitly rather than
 * leaving the collapse implicit at the call site.
 *
 * Like {@link preparedStringEqProvider} the host arm returns the record's
 * MODULE as well as its field: `concat` is a builtin import, so `ctx.funcMap`
 * cannot name it unambiguously (it is keyed on the bare field, which a
 * same-named user function shadows — #1072), and the consumer locates it by
 * import-section position instead.
 */
export function preparedStringConcatProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
  mode: IrStringConcatMode,
):
  | { readonly arm: "host"; readonly module: string; readonly field: string }
  | { readonly arm: "native"; readonly symbol: string }
  | undefined {
  const feature = stringConcatFeatureFor(mode);
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === feature,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable") {
    return { arm: "native", symbol: provider.implementation.symbol };
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", module: record.module, field: record.field };
  }
  throw new Error(`IR string-concat provider ${provider.id} is not a callable implementation`);
}

/** The one string-charCodeAt feature row; named once so no caller spells it. */
const STRING_CHAR_CODE_AT_RUNTIME_FEATURE = STRING_CHAR_CODE_AT_RUNTIME_FEATURES[0];

/**
 * (#3526 F2-S7) Which arm of the guarded `charCodeAt` seam the frozen manifest
 * selected, or `undefined` when no manifest carries the row.
 *
 * The family's fifth twin, and the first whose two arms share ONE
 * implementation kind: both rows are `runtime-callable`, so the discriminator
 * is the provider **ID**, not the kind. That is not an accident of spelling —
 * neither arm is an import. Both are DEFINED helpers minted on demand
 * (`ensureHostCharCodeAtGuarded` / `ensureNativeCharCodeAtHelper`), which is
 * why this twin returns no module: there is no import-section position to
 * locate, and the host arm's `capabilities` are what its helper needs
 * REGISTERED (`wasm:js-string.charCodeAt` and `.length`), not what it is.
 */
export function preparedStringCharCodeAtProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
):
  | { readonly arm: "host"; readonly symbol: string; readonly capabilities: readonly string[] }
  | { readonly arm: "native"; readonly symbol: string }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === STRING_CHAR_CODE_AT_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind !== "runtime-callable") {
    throw new Error(`IR string-char-code-at provider ${provider.id} is not a charCodeAt implementation`);
  }
  return provider.id === "host.js.string.char_code_at"
    ? { arm: "host", symbol: provider.implementation.symbol, capabilities: provider.hostCapabilities }
    : { arm: "native", symbol: provider.implementation.symbol };
}

/** The one batched many-arity feature row; named once so no caller spells it. */
const STRING_CONCAT_MANY_RUNTIME_FEATURE = STRING_CONCAT_MANY_RUNTIME_FEATURES[0];

/**
 * (#3526 F2-S6) Which arm of the BATCHED many-arity concat seam the frozen
 * manifest selected, at one concrete `arity`, or `undefined` when no manifest
 * carries the row.
 *
 * The family's distinguishing move: one frozen row answers every arity, and
 * the CONCRETE import or symbol is derived here rather than stored. The host
 * arm returns the derived module/field AND the derived params, because the
 * caller mints the import itself (`ensureLateImport`) and the record is the
 * only authority for its shape; the native arm returns the derived symbol,
 * range-checked against the row.
 *
 * Late minting is deliberate and is the contract, not an accident: the host
 * import's POSITION in the import section is what the emitted bytes depend on
 * (the census measured `__concat_5` landing at import index 21 of 27 on the
 * async fixture), and a freeze-time registration would move every batching
 * cell by design.
 */
export function preparedStringConcatManyProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
  arity: number,
):
  | {
      readonly arm: "host";
      readonly module: string;
      readonly field: string;
      readonly params: readonly RuntimeHostCapabilityValueType[];
      readonly results: readonly RuntimeHostCapabilityValueType[];
    }
  | { readonly arm: "native"; readonly symbol: string }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === STRING_CONCAT_MANY_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable-family") {
    const { symbolPrefix, arity: range } = provider.implementation;
    if (arity < range.min || arity > range.max) {
      throw new Error(`IR string-concat-many provider ${provider.id} does not cover arity ${arity}`);
    }
    return { arm: "native", symbol: `${symbolPrefix}${arity}` };
  }
  if (provider.implementation.kind === "host-callable-family") {
    const row = resolveRuntimeHostCapabilityFuncFamilyRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
      arity,
    );
    return { arm: "host", module: row.module, field: row.field, params: row.params, results: row.results };
  }
  throw new Error(`IR string-concat-many provider ${provider.id} is not a callable family implementation`);
}

/** The two string-const feature rows, one per import namespace; named once so no caller spells them. */
const STRING_CONST_RUNTIME_FEATURE = STRING_CONST_RUNTIME_FEATURES[0];
const STRING_CONST_UTF16_RUNTIME_FEATURE = STRING_CONST_RUNTIME_FEATURES[1];

/** The frozen feature row a literal answers to, by the ONE derivation. */
export function stringConstFeatureFor(utf16: boolean): StringConstRuntimeFeature {
  return utf16 ? STRING_CONST_UTF16_RUNTIME_FEATURE : STRING_CONST_RUNTIME_FEATURE;
}

/**
 * (#3526 F2-S8) Which arm of the string LITERAL STORAGE seam the frozen
 * manifest selected for `feature`, or `undefined` when no manifest carries that
 * row.
 *
 * The family's last twin, and the first whose arms are not callables at all.
 * The host arm returns the import MODULE and the field SCHEME — never a field,
 * because there is one field per literal and the scheme is what derives it. The
 * native arm returns the Program-ABI global ROLE, which the consumer resolves
 * to the interned literal's global; it can never return an index, because the
 * manifest freezes before `internNativeStringLiteral` allocates one.
 *
 * `resolveRuntimeHostCapabilityGlobalRecord` is the fail-closed kind guard, the
 * mirror of the func one every sibling takes: a callable capability has no
 * global spelling, so admitting one here would build a nonsense binding.
 */
export function preparedStringConstProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
  feature: StringConstRuntimeFeature,
):
  | { readonly arm: "host"; readonly module: string; readonly scheme: RuntimeHostCapabilityFieldScheme }
  | { readonly arm: "native"; readonly role: "native-string-literal" }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === feature,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "native-global") {
    return { arm: "native", role: provider.implementation.role };
  }
  if (provider.implementation.kind === "host-global") {
    const record = resolveRuntimeHostCapabilityGlobalRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", module: record.module, scheme: record.field.scheme };
  }
  throw new Error(`IR string-const provider ${provider.id} is not a literal-storage implementation`);
}

/** The one host-callback-wrap feature row; named once so no caller spells it. */
const HOST_CALLBACK_WRAP_RUNTIME_FEATURE = HOST_CALLBACK_WRAP_RUNTIME_FEATURES[0];

/**
 * (#3526 F3-S1) Which arm of the HOST CALLBACK MAKER seam the frozen manifest
 * selected, or `undefined` when no manifest carries the row.
 *
 * Family 3's first twin, and the first in the issue whose two arms are not two
 * spellings of one crossing. The host arm returns the maker's exact import
 * MODULE, FIELD and ABI, read off the reused `async.callback.wrap` record — the
 * caller binds the pre-pass's existing funcMap index by that key and registers
 * nothing. The native arm returns the dispatcher ROLE and no spelling at all,
 * because the exact standalone-DOM lane emits no maker: the row is the licence
 * for an emission that does not happen, so returning a target would be a lie
 * rather than a shortcut.
 *
 * Read post-freeze only — `preregisterDynamicSupport` and the resolve arms.
 * from-ast runs in Phase 1, before `freeze()`, and reads the STATIC catalogue
 * record instead.
 */
export function preparedHostCallbackWrapProvider(prepared: PreparedIrRuntimeManifest | undefined):
  | {
      readonly arm: "host";
      readonly module: string;
      readonly field: string;
      readonly params: readonly string[];
      readonly results: readonly string[];
    }
  | { readonly arm: "native-dispatch"; readonly service: "standalone-dom-callback-dispatch" }
  | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === HOST_CALLBACK_WRAP_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "native-dispatch") {
    return { arm: "native-dispatch", service: provider.implementation.service };
  }
  if (provider.implementation.kind === "host-callable") {
    const record = resolveRuntimeHostCapabilityFuncRecord(
      prepared!.manifest.hostCapabilityRecords,
      provider.implementation.capability,
    );
    return { arm: "host", module: record.module, field: record.field, params: record.params, results: record.results };
  }
  throw new Error(`IR host-callback-wrap provider ${provider.id} is not a callback-boundary implementation`);
}

/** The one `%Function.prototype%` feature row; named once so no caller spells it. */
const FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE = FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES[0];

/**
 * (#3526 F3-S3) Which arm of the `%Function.prototype%.[[Call]]` seam the
 * frozen manifest selected, or `undefined` when no manifest carries the row.
 *
 * The arm is returned as a `runtime` reference, not an `import` one, and that
 * is F1-S3's MEASURED constraint rather than a preference: the callable
 * observation path (`resolveAndObserveCallableProvider`) admits only `runtime`
 * and `intrinsic` references. The symbol names a real, compiler-defined Wasm
 * function on the only lane that has one, so there is nothing an import
 * reference could point at.
 *
 * Read POST-FREEZE only — `preregisterDynamicSupport`'s admission. from-ast
 * runs in Phase 1, before `freeze()`, and projects the resolved POLICY value
 * instead (see `integrationFunctionPrototypeCallPolicy`).
 *
 * **The row is requested on BOTH the demand and the resolved policy, and the
 * policy half is load-bearing rather than redundant.** In-tree the two are
 * inseparable — the resolver arm mints the call only under `call: "native"`, so
 * a demand always arrives with an admitting policy. What the conjunction
 * decides is WHERE a hand-built `unsupported` policy fed a program that already
 * contains the call is refused. Requesting the feature on the demand alone
 * would refuse it inside `freeze()` with `provider-target-unavailable`, which
 * escapes as a GLOBAL preparation failure (`runGlobalPreparation`'s
 * `failEveryOwner`); leaving the row out instead routes that case to the
 * resolve-time admission, which names the seam and the arm. That admission is
 * the backstop this slice was specified to provide.
 */
export function preparedFunctionPrototypeCallProvider(
  prepared: PreparedIrRuntimeManifest | undefined,
): { readonly arm: "native"; readonly target: IrFuncRef } | undefined {
  const provider: RuntimeProviderDefinition | undefined = prepared?.manifest.providers.find(
    (candidate) => candidate.feature === FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE,
  );
  if (!provider) return undefined;
  if (provider.implementation.kind === "runtime-callable") {
    return { arm: "native", target: irRuntimeFuncRef(provider.implementation.symbol) };
  }
  throw new Error(`IR function-prototype-call provider ${provider.id} is not a runtime callable implementation`);
}

function sameProvider(left: IrIntrinsicProvider, right: IrIntrinsicProvider): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "backend-op" && right.kind === "backend-op") return left.opcode === right.opcode;
  if (left.kind === "backend-sequence" && right.kind === "backend-sequence") {
    return left.sequence === right.sequence;
  }
  if (left.kind === "backend-composite" && right.kind === "backend-composite") {
    return left.operation === right.operation;
  }
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
  capabilityRecords: readonly RuntimeHostCapabilityRecord[],
): readonly IrInstr[] {
  const mapBuffer = (nestedBuffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(nestedBuffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (nested.kind !== "intrinsic") return nested;
    const provider = providers.get(nested.id);
    if (!provider) throw new Error(`IR intrinsic ${nested.id} is absent from the frozen runtime manifest`);
    const attachment = providerAttachment(nested.id, provider, capabilityRecords);
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
  capabilityRecords: readonly RuntimeHostCapabilityRecord[],
): IrFunction {
  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = attachProvidersToBuffer(block.instrs, providers, capabilityRecords);
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
  /**
   * (#3526 F1-S3) True when some generator in `functions` stashes a numeric
   * return value. The manifest walk below collects `intrinsic` uses only, so a
   * generator-only module would otherwise freeze NO manifest at all and the
   * seam would have no provider row to answer to. The demand is requested as a
   * feature exactly the way an async plan requests its runtime intents.
   */
  readonly generatorNumberBoxDemand?: boolean;
  /**
   * (#3526 F2-S1) True when some function in `functions` performs a string
   * relational compare. Same shape and same reason as
   * `generatorNumberBoxDemand`: the seam is a plain `call` through the
   * `__ir_str_compare` sentinel func-ref, not an `intrinsic` the walk below
   * collects, so a compare-only module would otherwise freeze no manifest at
   * all and the resolve arm would have no provider row to read.
   */
  readonly stringCompareDemand?: boolean;
  /**
   * (#3526 F2-S3) True when some function in `functions` compares two strings
   * for equality. Same shape and same reason as `stringCompareDemand`, read off
   * the `string.eq` instruction population: the instruction exists, but it is
   * not an `intrinsic`, so the walk below never collects it and an eq-only
   * module would otherwise freeze no manifest at all.
   */
  readonly stringEqDemand?: boolean;
  /**
   * (#3526 F2-S4) True when some function in `functions` reads a string's
   * `.length`. Same shape and same reason as `stringEqDemand`, read off the
   * `string.len` instruction population. It matters MORE here than for either
   * predecessor: `string.len` resolves through no callable symbol at all, so
   * the frozen row is the only place the physical choice can live, and a
   * length-only module that froze no manifest would leave the attachment pass
   * with nothing to read.
   */
  readonly stringLenDemand?: boolean;
  /**
   * (#3526 F2-S5) Which concat MODES some function in `functions` performs.
   * Same shape and same reason as `stringLenDemand`, read off the
   * `string.concat` instruction population — but a PAIR rather than a flag,
   * because the seam has two feature rows and a module with no builder loop
   * must not freeze an `owned-append` provider it will never call.
   */
  readonly stringConcatDemand?: { readonly immutable: boolean; readonly owned: boolean };
  /**
   * (#3526 F2-S7) True when some function in `functions` performs a guarded
   * `charCodeAt` read. Same shape and same reason as `stringLenDemand`, but the
   * scan behind it counts TWO producers: the `string.char_code_at` instruction
   * AND the plan-path `intrinsic` calls whose symbol already names the lane. An
   * instr-only demand would freeze a row for a handful of cells and leave every
   * plan-path call with no row to be verified against.
   */
  readonly stringCharCodeAtDemand?: boolean;
  /**
   * (#3526 F2-S6) Which ARITIES some function in `functions` concatenates in
   * one batched call, sorted and unique.
   *
   * Unlike every sibling demand this is scanned AFTER the producing pass, not
   * before it: `batchStringConcat` CREATES the demand, so there is nothing to
   * scan until it has run. An empty list is a module with no fused root, and it
   * freezes no family row at all — the same "no row when nothing concatenates"
   * rule the pair arm follows.
   *
   * The arities are carried rather than a bare flag because they are the
   * checkable part: a frozen row that does not cover a demanded arity is a
   * contract violation the resolve arm can name.
   */
  readonly stringConcatManyDemand?: { readonly arities: readonly number[] };
  /**
   * (#3526 F2-S8) Which literal-storage NAMESPACES some function in
   * `functions` needs. Same shape and same reason as `stringConcatDemand` — a
   * pair, because the seam has two feature rows — but it is load-bearing in a
   * way no sibling demand is.
   *
   * `string.const` has no callable symbol AND no resolve arm: after this slice
   * the frozen row is the only physical authority, and the attachment runs
   * INSIDE the freeze. A module carrying literals that froze no manifest would
   * therefore leave every literal without `storage` and fall silently back to
   * the raw `stringGlobalMap` lookup — byte-identical on the host lane, and so
   * invisible to a byte matrix. That is why `literal` is in the "freeze nothing
   * at all" conjunction below: a module with any `string.const` (or any
   * `extern.regex`, which occupies host globals too) always freezes.
   */
  readonly stringConstDemand?: { readonly literal: boolean; readonly utf16: boolean };
  /**
   * (#3526 F3-S1) Which host callback MAKER arms some function in `functions`
   * crosses, read off the `closure.new` population.
   *
   * A PAIR rather than a flag, and the two halves are not interchangeable: a
   * `hostOneShot` closure is a maker crossing that WILL emit a call, a
   * `domCallbackAuthority` one is a crossing the reserved standalone DOM
   * dispatcher answers with no call at all. Either is demand for the one
   * feature row, because the policy — not the closure — decides which authority
   * may answer; carrying both is what lets the freeze REFUSE a manifest whose
   * selected arm disagrees with the population it was frozen for.
   */
  readonly hostCallbackWrapDemand?: { readonly host: boolean; readonly nativeDispatch: boolean };
  /**
   * (#3526 F3-S3) True when some function in `functions` calls the
   * `%Function.prototype%` entry point, read off the emitted-call population —
   * the SAME predicate `preregisterDynamicSupport`'s admission scans, and
   * deliberately a superset of it (this one also walks async state bodies), so
   * a call the admission can see can never be one the freeze did not cover.
   */
  readonly functionPrototypeCallDemand?: boolean;
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
  // (#3526 F3-S3) Demand AND policy — see `preparedFunctionPrototypeCallProvider`
  // for why the policy half is load-bearing rather than redundant.
  const functionPrototypeCallRow =
    input.functionPrototypeCallDemand === true && input.policy.functionPrototypeCall?.call === "native";
  if (
    uses.length === 0 &&
    asyncPlans.size === 0 &&
    !functionPrototypeCallRow &&
    !input.generatorNumberBoxDemand &&
    !input.stringCompareDemand &&
    !input.stringEqDemand &&
    !input.stringLenDemand &&
    !input.stringConcatDemand?.immutable &&
    !input.stringConcatDemand?.owned &&
    !input.stringCharCodeAtDemand &&
    (input.stringConcatManyDemand?.arities.length ?? 0) === 0 &&
    !input.stringConstDemand?.literal &&
    !input.stringConstDemand?.utf16 &&
    !input.hostCallbackWrapDemand?.host &&
    !input.hostCallbackWrapDemand?.nativeDispatch
  ) {
    return undefined;
  }

  const builder = new RuntimeManifestBuilder(input.policy);
  for (const plan of asyncPlans.values()) {
    for (const intent of plan.runtimeIntents) builder.requestFeature(intent);
  }
  if (input.generatorNumberBoxDemand) builder.requestFeature(GENERATOR_NUMBER_BOX_RUNTIME_FEATURE);
  if (input.stringCompareDemand) builder.requestFeature(STRING_COMPARE_RUNTIME_FEATURE);
  if (input.stringEqDemand) builder.requestFeature(STRING_EQ_RUNTIME_FEATURE);
  if (input.stringLenDemand) builder.requestFeature(STRING_LEN_RUNTIME_FEATURE);
  if (input.stringConcatDemand?.immutable) builder.requestFeature(STRING_CONCAT_RUNTIME_FEATURE);
  if (input.stringConcatDemand?.owned) builder.requestFeature(STRING_CONCAT_OWNED_RUNTIME_FEATURE);
  if (input.stringCharCodeAtDemand) builder.requestFeature(STRING_CHAR_CODE_AT_RUNTIME_FEATURE);
  if ((input.stringConcatManyDemand?.arities.length ?? 0) > 0) {
    builder.requestFeature(STRING_CONCAT_MANY_RUNTIME_FEATURE);
  }
  if (input.stringConstDemand?.literal) builder.requestFeature(STRING_CONST_RUNTIME_FEATURE);
  if (input.stringConstDemand?.utf16) builder.requestFeature(STRING_CONST_UTF16_RUNTIME_FEATURE);
  if (input.hostCallbackWrapDemand?.host || input.hostCallbackWrapDemand?.nativeDispatch) {
    builder.requestFeature(HOST_CALLBACK_WRAP_RUNTIME_FEATURE);
  }
  if (functionPrototypeCallRow) builder.requestFeature(FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE);
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
    const intents = new Set<string>(plan.runtimeIntents);
    const selectedProviders = Object.freeze(manifest.providers.filter((provider) => intents.has(provider.feature)));
    if (selectedProviders.length !== intents.size) {
      throw new Error(`IR async runtime attachment for ${fn.name} is missing an exact provider`);
    }
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
      for (const capability of provider.hostCapabilities) {
        // Async providers only ever declare async capabilities; the narrowing
        // is checked, never cast, so a widened central row can never reach the
        // async adapter materializer (which would mislower f64 as externref).
        if (!isAsyncHostCapabilityId(capability)) {
          throw new Error(`IR async runtime attachment for ${fn.name} requested non-async capability ${capability}`);
        }
        capabilities.add(capability);
      }
    }
    const records = manifest.hostCapabilityRecords
      .filter((record) => isAsyncHostCapabilityId(record.capability) && capabilities.has(record.capability))
      .map(asAsyncHostAdapter);
    if (records.length !== capabilities.size) {
      throw new Error(`IR async runtime attachment for ${fn.name} is missing a frozen capability record`);
    }
    const states = Object.freeze(
      plan.states.map((state) => {
        const attached = attachProvidersToBuffer(state.body, providers, manifest.hostCapabilityRecords);
        const body = nativeProjection ? attached.map(projectStandaloneAsyncStateInstr) : attached;
        return body === state.body ? state : Object.freeze({ ...state, body });
      }),
    );
    const backendRequirements = projectRuntimeBackendRequirements(selectedProviders);
    const runtime = nativeProjection
      ? createPreparedIrAsyncRuntime({
          kind: "standalone-native-wasmgc",
          plan,
          manifest,
          providers: selectedProviders,
          backendRequirements,
          adapters: Object.freeze([] as const),
          states,
        })
      : createPreparedIrAsyncRuntime({
          kind: "host-wasmgc",
          plan,
          manifest,
          providers: selectedProviders,
          backendRequirements,
          adapters: Object.freeze(
            records.map((record) =>
              Object.freeze({
                capability: record.capability,
                target: irImportFuncRef(record.module, record.field, record.field),
                record,
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
    functions: Object.freeze(
      input.functions.map((fn) => attachAsyncRuntime(attachProviders(fn, providers, manifest.hostCapabilityRecords))),
    ),
    manifest,
    providers,
  });
}
