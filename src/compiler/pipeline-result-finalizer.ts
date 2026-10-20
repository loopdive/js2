import type { CompileOptions } from "../index.js";
import type { PreparedIrPresentationArtifacts } from "./ir-program-presentation.js";
import { completedNativeNumberUndefinedPresentation } from "./ir-native-number-undefined-presentation.js";
import { readIrCompileRoute } from "./ir-cutover-invocation.js";
import {
  assertPreparedIrData,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../shared/contracts/prepared-ir-data.js";
import { optimizeBinaryAsync } from "../optimize.js";
import { inspectNativeNumberUndefinedBinary } from "../wasm/physical/native-number-undefined-binary.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PipelineOutputContext } from "./pipeline-output-context.js";
import type { CompileResult } from "../index.js";
import type { WasmModule } from "../ir/types.js";
import {
  assertPreparedPipelinePresentation,
  beginPreparedPresentationFinalization,
  completePreparedPresentationFinalization,
  preparedPresentationWitView,
  preparedPresentationNativeDts,
  type PreparedPresentationFinalization,
  type PreparedPresentationFinalizationReceipt,
  type IrProgramPresentationResult,
  type IrProgramPresentationGap,
  type PreparedIrPipelinePresentationResult,
} from "./ir-program-presentation.js";
import { PreparedIrProgramInvariantError } from "../ir/program.js";
import { isNativeIrCompileProfile } from "../ir/runtime/target-admission.js";
import { buildHostImportInventory, summarizeHostImportInventory } from "../host-import-policy.js";
import { buildCapabilityRequirements, validatePlatformCapabilityRequirements } from "../capability-registry.js";
import { createJavaScriptAdapterManifest } from "../adapter-manifest.js";
import { buildExportBoundaryPolicies } from "../boundary-policy.js";
import { buildCompileExplanation } from "../compile-explain.js";
import { buildImportManifest } from "./import-manifest.js";
import {
  applyCabiTransform,
  failResult,
  generateDts,
  generateImportsHelper,
  widenNonDefaultableTypes,
  type FailureTelemetry,
} from "./output.js";
import { stampAllocationOwners } from "../wasm/physical/allocation-owner.js";
import { gateEmittedModule, pushSourceAnchoredDiagnostic, withEngineRejectedIrOutcomes } from "./validation.js";
import { emitBinary, emitBinaryWithSourceMap, emitSourceMappingURLSection } from "../emit/binary.js";
import {
  extractRuntimeGroup,
  fingerprintRuntimeGroup,
  RUNTIME_RECGROUP_TYPE_NAMES,
  verifyRuntimeRecGroupBinary,
  type RuntimeGroupFingerprint,
} from "../emit/canonical-recgroup.js";
import { WasmEncoder } from "../emit/encoder.js";
import { generateSourceMap } from "../emit/sourcemap.js";
import { emitWat } from "../emit/wat.js";
import { profilePhase } from "../compile-profile.js";
import { resolveCompileTargetProfile } from "../target-profile.js";
import { generateWit, renderPreparedWit } from "../wit-generator.js";

type NativeOptimizationPresentation = Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>;
const nativeOptimizationFinalizations = new WeakMap<
  object,
  {
    presentation: NativeOptimizationPresentation;
    module: WasmModule;
    binary: Uint8Array;
    detached?: PreparedPresentationFinalizationReceipt;
    construction: ArtifactConstruction;
    expected: ArtifactExpectedState;
  }
>();
interface ConstructionNode {
  readonly value: object;
  readonly prototype: object | null;
  readonly descriptors: readonly (readonly [PropertyKey, Readonly<PropertyDescriptor>])[];
}
interface ArtifactConstruction {
  readonly artifact: object;
  readonly prototype: object | null;
  readonly descriptors: readonly (readonly [PropertyKey, Readonly<PropertyDescriptor>])[];
  readonly staticNodes: readonly ConstructionNode[];
  readonly originalDiagnostics: readonly ConstructionNode[];
  readonly originalBinary: Uint8Array;
  readonly originalBytes: readonly number[];
}
interface ArtifactExpectedState {
  binary: Uint8Array;
  bytes: readonly number[];
  diagnostics: readonly ConstructionNode[];
}
function constructionFailure(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native finalized construction: ${detail}`);
}
function observeConstructionData(value: unknown): readonly ConstructionNode[] {
  assertPreparedIrData(value);
  const visited = new Set<object>(),
    rows: ConstructionNode[] = [];
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object" || visited.has(item)) return;
    visited.add(item);
    const descriptors = Reflect.ownKeys(item).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, "value")) constructionFailure("non-DATA graph");
      visit(descriptor.value);
      return Object.freeze([key, Object.freeze({ ...descriptor })] as const);
    });
    rows.push(
      Object.freeze({ value: item, prototype: Object.getPrototypeOf(item), descriptors: Object.freeze(descriptors) }),
    );
  };
  visit(value);
  return Object.freeze(rows);
}
function verifyConstructionData(rows: readonly ConstructionNode[]): void {
  for (const row of rows) {
    if (Object.getPrototypeOf(row.value) !== row.prototype) constructionFailure("graph prototype changed");
    const keys = Reflect.ownKeys(row.value);
    if (keys.length !== row.descriptors.length) constructionFailure("graph shape changed");
    for (let index = 0; index < keys.length; index++) {
      const [key, before] = row.descriptors[index]!;
      const after = Object.getOwnPropertyDescriptor(row.value, key);
      if (
        keys[index] !== key ||
        !after ||
        !Object.hasOwn(after, "value") ||
        before.writable !== after.writable ||
        before.configurable !== after.configurable ||
        before.enumerable !== after.enumerable ||
        !Object.is(before.value, after.value)
      )
        constructionFailure("graph descriptor/value/alias changed");
    }
  }
}
function constructionBytes(binary: Uint8Array): readonly number[] {
  if (!ArrayBuffer.isView(binary) || Object.getPrototypeOf(binary) !== Uint8Array.prototype)
    constructionFailure("binary prototype/brand changed");
  const keys = Reflect.ownKeys(binary),
    result: number[] = [];
  for (let index = 0; index < keys.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(binary, keys[index]!)!;
    if (
      keys[index] !== String(index) ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "number" ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    )
      constructionFailure("binary non-DATA/shadow");
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}
function captureArtifactConstruction(artifact: PreparedIrPresentationArtifacts): ArtifactConstruction {
  const descriptors = Reflect.ownKeys(artifact).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(artifact, key)!;
    if (!Object.hasOwn(descriptor, "value")) constructionFailure("artifact non-DATA");
    return Object.freeze([key, Object.freeze({ ...descriptor })] as const);
  });
  const statics: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of descriptors) {
    if (typeof key !== "string") constructionFailure("artifact symbol");
    if (key !== "errors" && key !== "binary") statics[key] = descriptor.value;
  }
  return Object.freeze({
    artifact,
    prototype: Object.getPrototypeOf(artifact),
    descriptors: Object.freeze(descriptors),
    staticNodes: observeConstructionData(statics),
    originalDiagnostics: observeConstructionData(artifact.errors),
    originalBinary: artifact.binary,
    originalBytes: constructionBytes(artifact.binary),
  });
}
function captureArtifactExpectedState(artifact: PreparedIrPresentationArtifacts): ArtifactExpectedState {
  return {
    binary: artifact.binary,
    bytes: constructionBytes(artifact.binary),
    diagnostics: observeConstructionData(artifact.errors),
  };
}
function assertArtifactConstruction(
  record: { construction: ArtifactConstruction; expected: ArtifactExpectedState },
  artifact: object,
): void {
  const { construction, expected } = record;
  if (artifact !== construction.artifact || Object.getPrototypeOf(artifact) !== construction.prototype)
    constructionFailure("artifact identity/prototype changed");
  const produced = new Set(construction.descriptors.map(([key]) => key));
  for (const key of Reflect.ownKeys(artifact)) {
    if (produced.has(key)) continue;
    // These source telemetry / SDK additions are never interpreted as authority.
    if (!inputs.has(artifact) || (key !== "irOutcomes" && key !== "irBodyRouteAudit" && key !== "importObject"))
      constructionFailure("foreign artifact shape");
  }
  for (const [key, before] of construction.descriptors) {
    const after = Object.getOwnPropertyDescriptor(artifact, key);
    if (
      !after ||
      !Object.hasOwn(after, "value") ||
      before.writable !== after.writable ||
      before.configurable !== after.configurable ||
      before.enumerable !== after.enumerable ||
      !Object.is(after.value, key === "binary" ? expected.binary : before.value)
    )
      constructionFailure("artifact descriptor/value/alias changed");
  }
  const diagnostics = Object.getOwnPropertyDescriptor(artifact, "errors")!.value as CompileResult["errors"];
  if (!Object.isExtensible(diagnostics) || !Object.getOwnPropertyDescriptor(diagnostics, "length")?.writable)
    constructionFailure("diagnostic array changed");
  verifyConstructionData(construction.staticNodes);
  verifyConstructionData(expected.diagnostics);
  const originalBytes = constructionBytes(construction.originalBinary);
  if (
    originalBytes.length !== construction.originalBytes.length ||
    originalBytes.some((value, index) => value !== construction.originalBytes[index])
  )
    constructionFailure("original constructed binary bytes changed");
  const currentBytes = constructionBytes(expected.binary);
  if (
    currentBytes.length !== expected.bytes.length ||
    currentBytes.some((value, index) => value !== expected.bytes[index])
  )
    constructionFailure("constructed binary bytes changed");
}
function commitArtifactBinary(artifact: object, binary: Uint8Array): void {
  const record = nativeOptimizationFinalizations.get(artifact);
  if (!record) constructionFailure("unissued binary transition");
  record.expected.binary = binary;
  record.expected.bytes = constructionBytes(binary);
}
function commitArtifactDiagnostics(artifact: PreparedIrPresentationArtifacts): void {
  const record = nativeOptimizationFinalizations.get(artifact);
  if (!record) constructionFailure("unissued diagnostic transition");
  record.expected.diagnostics = observeConstructionData(artifact.errors);
}

/** A constructor flag is own DATA; inherited state cannot alter the transaction. */
function ownDetachedFinalization(presentation: NativeOptimizationPresentation): boolean {
  const key = "requiresDetachedFinalization";
  const descriptor = Object.getOwnPropertyDescriptor(presentation, key);
  if (!descriptor) {
    for (
      let prototype = Object.getPrototypeOf(presentation);
      prototype !== null;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      if (Object.getOwnPropertyDescriptor(prototype, key))
        throw new PreparedIrProgramInvariantError(
          "invalid-transaction-capability",
          "prepared pipeline finalization refuses inherited detached flag",
        );
    }
    return false;
  }
  if (!Object.hasOwn(descriptor, "value") || descriptor.value !== true)
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "prepared pipeline finalization requires own DATA detached flag",
    );
  return true;
}
/** Read-only compiler lifecycle witness: caller data cannot register an artifact. */
export function assertCompilerNativeNumberUndefinedFinalization(
  presentation: NativeOptimizationPresentation,
  module: WasmModule,
  artifacts: object,
  originalBinary: Uint8Array,
): void {
  const record = nativeOptimizationFinalizations.get(artifacts);
  if (
    !record ||
    record.presentation !== presentation ||
    record.module !== module ||
    record.binary !== originalBinary ||
    (ownDetachedFinalization(presentation) && !record.detached)
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "native Number/Undefined optimization requires actual completed compiler artifacts",
    );
  assertArtifactConstruction(record, artifacts);
}

function getRuntimeRecGroupFingerprint(mod: WasmModule): RuntimeGroupFingerprint | undefined {
  const range = mod.canonicalRuntimeRecGroup;
  if (!range) return undefined;
  const expectedCount = range.end - range.start + 1;
  const members = extractRuntimeGroup(mod);
  const fingerprint = fingerprintRuntimeGroup(mod);
  const namesMatch =
    fingerprint.count === RUNTIME_RECGROUP_TYPE_NAMES.length &&
    fingerprint.members.every((name, index) => name === RUNTIME_RECGROUP_TYPE_NAMES[index]);
  const rangeMatches =
    members.length === expectedCount && members.every((member, index) => member.absIndex === range.start + index);
  if (
    range.start < 0 ||
    range.end < range.start ||
    fingerprint.count !== expectedCount ||
    !namesMatch ||
    !rangeMatches
  ) {
    throw new Error(
      `canonical runtime rec-group metadata disagrees with the type table ` +
        `(range ${range.start}..${range.end}, named members ${fingerprint.members.join(", ")})`,
    );
  }
  if (fingerprint.abiVersion !== range.abiVersion) {
    throw new Error(
      `canonical runtime rec-group ABI mismatch (metadata v${range.abiVersion}, ` +
        `fingerprint v${fingerprint.abiVersion})`,
    );
  }
  return fingerprint;
}

/** Return a concise drift reason, or undefined when the binary is link-safe. */
export function runtimeRecGroupDrift(binary: Uint8Array, expected?: RuntimeGroupFingerprint): string | undefined {
  if (!expected) return undefined;
  const verification = verifyRuntimeRecGroupBinary(binary, expected);
  return verification.valid ? undefined : (verification.detail ?? "the canonical runtime rec-group was not found");
}

/** Private holder; only genuine mixed presentation creates a finalization token. */
interface PreparedMixedFinalization {
  readonly token: PreparedPresentationFinalization;
  receipt?: PreparedPresentationFinalizationReceipt;
}

/** Only the private prepared entry supplies a genuine presentation here. */
interface PreparedWitFinalization {
  readonly presentation: Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>;
  text?: string;
  gaps?: readonly IrProgramPresentationGap[];
}

/** Shared output contract; generation and its diagnostics finish before entry. */
export function finalizePipelineModule(
  input: PipelineOutputContext,
  mod: WasmModule,
  telemetry: Partial<FailureTelemetry> | undefined,
  output: {
    targetProfile: ReturnType<typeof resolveCompileTargetProfile>;
    emitWatOutput: boolean;
    emitSourceMap: boolean;
  },
  finalization?: PreparedMixedFinalization,
  wit?: PreparedWitFinalization,
  nativeDts?: Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>,
): CompileResult {
  const { errors, options, entryAst, diagnosticAnchor } = input;
  const { targetProfile, emitWatOutput, emitSourceMap } = output;
  const targetEnvironment = targetProfile.environment;

  // Step 2b: Apply C ABI transformations if requested (linear target only).
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module", entryAst);
    cHeader = cabiResult.cHeader;
  }

  // Step 2c: Widen non-defaultable ref types to ref_null in locals, params, and
  // results. Avoids "uninitialized non-defaultable local" and struct.get/set
  // type errors.
  if (options.standaloneAllocationOwnerExport !== undefined) {
    try {
      stampAllocationOwners(mod, options.standaloneAllocationOwnerExport);
    } catch (error) {
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `Allocation provenance: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return failResult(errors, telemetry);
    }
  }
  widenNonDefaultableTypes(mod);
  if (finalization) finalization.receipt = completePreparedPresentationFinalization(finalization.token);

  // #4401 — An explicitly selected native-first profile is a
  // semantic-provider contract, not a best-effort hint. Never publish a module
  // that silently recovered an implicit JS semantic fallback (or an
  // unclassified import) after a native lowering declined. Value adapters,
  // lifecycle hooks, explicit platform capabilities, and named accelerators
  // remain valid imports; only the two policy classes that cannot justify
  // publication are rejected here.
  //
  // Run this before binary/WAT/helper emission so an unsupported construct
  // fails as a compile diagnostic rather than becoming a valid-looking module
  // that depends on the compatibility runtime. Target-derived standalone/WASI
  // profiles keep their established fallback/refusal behavior: standalone's
  // warning-first compatibility lanes (#2961/#2980/#3164) are not an explicit
  // native-first opt-in, while WASI's strict import gate remains authoritative.
  const imports = buildImportManifest(mod);
  // (#6978) Selected host-accelerator families classify as `host-accelerator`.
  const hostImportInventory = buildHostImportInventory(
    mod,
    imports,
    input.codegenOptions.link,
    targetEnvironment,
    targetProfile.accelerators,
  );
  if (options.semanticProviders === "native-first") {
    const forbidden = hostImportInventory.filter(
      (entry) => entry.classification === "legacy-semantic" || entry.classification === "unknown",
    );
    if (forbidden.length > 0) {
      const details = forbidden
        .map((entry) => `${entry.module}::${entry.name} (${entry.classification}, owner #${entry.ownerIssue})`)
        .join(", ");
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `Native-first semantic-provider policy rejected implicit or unclassified host imports: ${details}. ` +
          `Use the host-assisted compatibility profile for this source until its native provider is implemented.`,
        "error",
      );
      return failResult(errors, telemetry);
    }
  }

  // Requested prepared WIT must be complete before any final artifacts are emitted.
  let preparedCapabilities: ReturnType<typeof buildCapabilityRequirements> | undefined;
  if (wit) {
    const view = preparedPresentationWitView(wit.presentation, mod);
    preparedCapabilities = buildCapabilityRequirements(mod, hostImportInventory, targetEnvironment);
    const rendered = renderPreparedWit(view, {
      ...(typeof options.wit === "object" ? options.wit : {}),
      imports: mod.imports,
      types: mod.types,
      capabilities: preparedCapabilities,
    });
    if (rendered.kind === "unsupported") {
      wit.gaps = rendered.gaps;
      return failResult(errors, telemetry);
    }
    wit.text = rendered.text;
  }

  // Native declarations are preflighted against the completed immutable handoff
  // and authentic current physical output before any final artifact is emitted.
  const preparedDts = nativeDts ? preparedPresentationNativeDts(nativeDts, mod) : undefined;

  // Step 3: Emit binary (with source map collection if enabled).
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = profilePhase("emit-binary-source-map", () => emitBinaryWithSourceMap(mod));
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, input.sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);
      // Append sourceMappingURL custom section to the binary.
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = profilePhase("emit-binary", () => emitBinary(mod));
    }
  } catch (e) {
    if (isWasmException(e)) throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      diagnosticAnchor,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return failResult(errors, telemetry);
  }

  // #2527 — retain a link-time proof for the frozen GC type ABI. This check
  // runs on the raw bytes produced by the compiler, before optional Binaryen
  // optimization, so a bad emitter or an accidental DCE/layout change cannot
  // be mistaken for a link-compatible artifact.
  let runtimeRecGroupFingerprint: RuntimeGroupFingerprint | undefined;
  try {
    runtimeRecGroupFingerprint = getRuntimeRecGroupFingerprint(mod);
    const drift = runtimeRecGroupDrift(binary, runtimeRecGroupFingerprint);
    if (drift) {
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `emitted WebAssembly does not contain the canonical runtime rec-group — ${drift}`,
        "error",
      );
      return failResult(errors, telemetry);
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      diagnosticAnchor,
      `runtime rec-group ABI verification failed: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return failResult(errors, telemetry);
  }

  // Step 3b: Optimize — applied by the async entry adapters via applyOptimize,
  // not here. This synchronous core ignores options.optimize.

  // Step 4: Emit WAT (optional, non-fatal on failure).
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = profilePhase("emit-wat", () =>
        emitWat(
          mod,
          options.emitWatOnlyFunctions ? { onlyFunctions: new Set(options.emitWatOnlyFunctions) } : undefined,
        ),
      );
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  // Step 5: Generate .d.ts.
  const dts = profilePhase("emit-dts", () => preparedDts ?? generateDts(entryAst, mod));

  const hostImportSummary = summarizeHostImportInventory(hostImportInventory);
  const capabilityRequirements =
    preparedCapabilities ?? buildCapabilityRequirements(mod, hostImportInventory, targetEnvironment);
  const capabilityProviderDiagnostics = validatePlatformCapabilityRequirements(
    capabilityRequirements,
    targetEnvironment,
  );
  const exportBoundaryPolicies = buildExportBoundaryPolicies(mod.exportSignatures, targetProfile);
  // Step 6: Generate WIT from the same frozen capability requirements used by
  // explain output and adapter validation, never from a parallel authority map.
  let witOutput: string | undefined;
  if (wit) {
    if (wit.text === undefined)
      throw new PreparedIrProgramInvariantError(
        "invalid-transaction-capability",
        "prepared WIT lacks preflighted text",
      );
    witOutput = wit.text;
  } else if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(entryAst, {
      ...witOpts,
      imports: mod.imports,
      types: mod.types,
      capabilities: capabilityRequirements,
    });
  }
  const adapterManifest = createJavaScriptAdapterManifest({
    targetProfile,
    imports,
    stringPool: mod.stringPool,
    capabilities: capabilityRequirements,
    exportSignatures: mod.exportSignatures,
    exportBoundaries: exportBoundaryPolicies,
  });
  // Step 7: Generate the helper from the same frozen adapter plan returned to
  // API callers. The serialized helper therefore cannot silently recover the
  // low-level buildImports compatibility defaults.
  const importsHelper = generateImportsHelper(adapterManifest);

  // Step 8 (#4420, #6776): engine validation, ON unless `validate: false`.
  // Wired HERE, at the one exit every driver funnels through (compileSourceSync
  // / compileSource / compileMultiSource / compileFilesSource all return
  // runPipeline's result), so no caller can be validated while another is not.
  // Runs BEFORE the async wasm-opt pass, which validates its own output
  // (#1941), so this gate answers for what CODEGEN produced. The binary is
  // still returned on failure — a caller that just learned its module is
  // invalid needs the bytes to dump or diff.
  const emittedBinaryAccepted = gateEmittedModule(binary, options, errors, diagnosticAnchor);

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: emittedBinaryAccepted,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports,
    runtimeRecGroupFingerprint,
    targetProfile,
    hostImportInventory,
    hostImportSummary,
    capabilityRequirements,
    capabilityProviderDiagnostics,
    cHeader,
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: input.preparedStartup?.hasTopLevelStatements ?? mod.hasTopLevelStatements === true,
    exportSignatures: mod.exportSignatures,
    exportBoundaryPolicies,
    adapterManifest,
    explanation: buildCompileExplanation({
      target: targetProfile,
      hostImports: hostImportSummary,
      capabilities: capabilityRequirements,
      capabilityDiagnostics: capabilityProviderDiagnostics,
      exportBoundaries: exportBoundaryPolicies,
    }),
    ...withEngineRejectedIrOutcomes(telemetry, emittedBinaryAccepted, errors), // (#7001)
  };
}
/** Preserve produced artifact fields without inventing legacy route telemetry. */
export function preparedPipelineArtifacts(
  result: CompileResult,
): Extract<PreparedIrPipelinePresentationResult, { kind: "artifacts" }>["artifacts"] {
  return {
    binary: result.binary,
    wat: result.wat,
    dts: result.dts,
    importsHelper: result.importsHelper,
    success: result.success,
    errors: result.errors,
    stringPool: result.stringPool,
    sourceMap: result.sourceMap,
    imports: result.imports,
    runtimeRecGroupFingerprint: result.runtimeRecGroupFingerprint,
    targetProfile: result.targetProfile,
    hostImportInventory: result.hostImportInventory,
    hostImportSummary: result.hostImportSummary,
    capabilityRequirements: result.capabilityRequirements,
    capabilityProviderDiagnostics: result.capabilityProviderDiagnostics,
    cHeader: result.cHeader,
    wit: result.wit,
    hasMain: result.hasMain,
    hasTopLevelStatements: result.hasTopLevelStatements,
    exportSignatures: result.exportSignatures,
    exportBoundaryPolicies: result.exportBoundaryPolicies,
    adapterManifest: result.adapterManifest,
    explanation: result.explanation,
  };
}

/** Productive owner: artifacts and their witness originate in real finalization. */
export function finalizePreparedPipelinePresentation(presentation: NativeOptimizationPresentation) {
  assertPreparedPipelinePresentation(presentation);
  const detached = ownDetachedFinalization(presentation);
  const { output: input } = presentation;
  const { options } = input;
  const targetProfile = resolveCompileTargetProfile(options);
  const native = isNativeIrCompileProfile(targetProfile);
  if (native) preparedPresentationNativeDts(presentation, presentation.emission.module);
  const finalization: PreparedMixedFinalization | undefined = detached
    ? { token: beginPreparedPresentationFinalization(presentation) }
    : undefined;
  const wit: PreparedWitFinalization | undefined = options.wit ? { presentation } : undefined;
  const module = finalization?.token.outputModule ?? presentation.emission.module;
  const finalized = finalizePipelineModule(
    { ...input, preparedStartup: presentation.startup },
    module,
    undefined,
    { targetProfile, emitWatOutput: options.emitWat !== false, emitSourceMap: options.sourceMap === true },
    finalization,
    wit,
    native ? presentation : undefined,
  );
  if (wit?.gaps) return { kind: "presentation-unsupported" as const, gaps: wit.gaps };
  if (finalized.success && finalization && !finalization.receipt)
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "mixed prepared output lacks completed finalization evidence",
    );
  const artifacts = preparedPipelineArtifacts(finalized);
  if (
    finalized.success &&
    native &&
    completedNativeNumberUndefinedPresentation(
      presentation.program,
      presentation.emission,
      resolveBackend(presentation),
    )
  ) {
    nativeOptimizationFinalizations.set(
      artifacts,
      Object.freeze({
        presentation,
        module,
        binary: artifacts.binary,
        detached: finalization?.receipt,
        construction: captureArtifactConstruction(artifacts),
        expected: captureArtifactExpectedState(artifacts),
      }),
    );
  }
  return { kind: "completed-finalization" as const, finalized, artifacts, module, finalization: finalization?.receipt };
}

function isWasmException(e: unknown): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    !!(WebAssembly as unknown as { Exception?: Function }).Exception &&
    e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
  );
}

type Presentation = Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>;
export interface NativeNumberUndefinedOptimizationObservation {
  readonly level: 1 | 2 | 3 | 4;
  readonly attempted: boolean;
  readonly optimized: boolean | undefined;
  readonly accepted: boolean;
  readonly disposition: "sync-pending" | "attempting" | "failed" | "unavailable" | "rejected" | "accepted";
}
function observation(
  level: 1 | 2 | 3 | 4,
  disposition: NativeNumberUndefinedOptimizationObservation["disposition"],
  optimized: boolean | undefined,
  accepted: boolean,
): NativeNumberUndefinedOptimizationObservation {
  return Object.freeze({ level, attempted: disposition !== "sync-pending", optimized, accepted, disposition });
}
interface Input {
  presentation: Presentation;
  module: WasmModule;
  original: Uint8Array;
  originalBuffer: Uint8Array;
  expected: Uint8Array;
  buffer: Uint8Array;
  options: CompileOptions;
  fields: unknown;
  observation: NativeNumberUndefinedOptimizationObservation;
  consumed: boolean;
  optimizer?: { result: object; binary: Uint8Array; bytes: Uint8Array; fields: unknown };
  returnedOptimizerResult?: object;
}
const inputs = new WeakMap<object, Input>(),
  issued = new WeakSet<object>();
const fields = [
  "success",
  "errors",
  "wat",
  "dts",
  "importsHelper",
  "stringPool",
  "sourceMap",
  "imports",
  "runtimeRecGroupFingerprint",
  "targetProfile",
  "hostImportInventory",
  "hostImportSummary",
  "capabilityRequirements",
  "capabilityProviderDiagnostics",
  "cHeader",
  "wit",
  "hasMain",
  "hasTopLevelStatements",
  "exportSignatures",
  "exportBoundaryPolicies",
  "adapterManifest",
  "explanation",
] as const;
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Number/Undefined optimization: ${detail}`);
}
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) invalid(`non-DATA ${String(key)}`);
  return descriptor.value;
}
function optionsData(options: CompileOptions): CompileOptions {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(options))) invalid("options prototype");
  const copy: Record<string, unknown> = Object.create(null);
  let routeKeys = 0;
  for (const key of Reflect.ownKeys(options)) {
    const value = own(options, key);
    if (typeof key === "symbol") {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
      if (
        ++routeKeys !== 1 ||
        descriptor.enumerable ||
        readIrCompileRoute(options) === undefined ||
        value !== readIrCompileRoute(options)
      )
        invalid("unknown option symbol");
    } else copy[key] = value;
  }
  assertPreparedIrData(copy);
  return freezePreparedIrValue(copy) as CompileOptions;
}
/** Request validation conveys no emission or optimization authority. */
export function nativeNumberUndefinedOptimizationLevel(value: unknown): 1 | 2 | 3 | 4 | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return 3;
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  return invalid("invalid optimization request");
}
function semanticFields(result: PreparedIrPresentationArtifacts): unknown {
  const copy: Record<string, unknown> = Object.create(null);
  if (Object.getPrototypeOf(result) !== Object.prototype) invalid("artifact prototype");
  for (const key of [...fields, "binary"]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.writable ||
      !descriptor.configurable ||
      !descriptor.enumerable
    )
      invalid("artifact descriptor changed");
    if (key !== "binary") copy[key] = descriptor.value;
  }
  assertPreparedIrData(copy);
  return freezePreparedIrValue(copy);
}
function equal(before: unknown, after: unknown, detail: string): void {
  if (preparedIrDataMismatch(before, after) !== undefined) invalid(detail);
}
function bytes(binary: Uint8Array): Uint8Array {
  inspectNativeNumberUndefinedBinary(binary);
  return Uint8Array.from(binary);
}
function equalBytes(a: Uint8Array, b: Uint8Array, detail: string): void {
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) invalid(detail);
}
function current(result: PreparedIrPresentationArtifacts, input: Input): void {
  const p = input.presentation;
  assertCompilerNativeNumberUndefinedFinalization(p, input.module, result, input.originalBuffer);
  equalBytes(input.original, bytes(input.originalBuffer), "original compiler binary changed");
  if (!completedNativeNumberUndefinedPresentation(p.program, p.emission, resolveBackend(p)))
    invalid("lost singleton authority");
  if (preparedPresentationNativeDts(p, input.module) !== own(result, "dts")) invalid("DTS/finalization drift");
  equal(input.options, optionsData(p.output.options), "captured options changed");
  equal(input.fields, semanticFields(result), "semantic artifact fields changed");
  const diagnostics = own(result, "errors") as CompileResult["errors"];
  if (!Object.isExtensible(diagnostics) || !Object.getOwnPropertyDescriptor(diagnostics, "length")?.writable)
    invalid("diagnostic array changed");
  const binary = own(result, "binary") as Uint8Array;
  if (binary !== input.buffer) invalid("binary identity changed");
  equalBytes(input.expected, bytes(binary), "binary bytes changed");
  equalBytes(input.original, bytes(emitBinary(input.module)), "finalized module bytes changed");
  if (input.optimizer) {
    optimizerData(input.optimizer.result);
    equal(input.optimizer.fields, optimizerFields(input.optimizer.result), "optimizer result changed");
    if (own(input.optimizer.result, "binary") !== input.optimizer.binary) invalid("optimizer binary identity changed");
    equalBytes(input.optimizer.bytes, bytes(input.optimizer.binary), "optimizer candidate changed");
  }
}
function resolveBackend(p: Presentation) {
  const o = p.output.options,
    profile = resolveCompileTargetProfile(o);
  if (profile.target !== "standalone" && profile.target !== "wasi") invalid("non-native optimization target");
  return {
    backend: profile.backend,
    target: profile.target,
    moduleName: o.moduleName ?? "module",
    sharedExceptionTag: o.sharedExceptionTag === true,
    utf8Storage: o.utf8Storage === true,
    sourceMap: o.sourceMap === true,
  };
}
/** The exact NEW artifacts object is issued only after completed ordinary finalization. */
export function issueNativeNumberUndefinedOptimizationInput(
  p: Presentation,
  module: WasmModule,
  result: PreparedIrPresentationArtifacts,
): void {
  const output = own(p, "output") as Presentation["output"],
    options = optionsData(own(output, "options") as CompileOptions);
  if (!options.optimize) return; // Preserve the ordinary nonissued falsey-option path.
  const level = nativeNumberUndefinedOptimizationLevel(options.optimize);
  if (level === undefined) return;
  assertCompilerNativeNumberUndefinedFinalization(p, module, result, own(result, "binary") as Uint8Array);
  const dts = preparedPresentationNativeDts(p, module);
  const backend = resolveBackend(p);
  if (!completedNativeNumberUndefinedPresentation(p.program, p.emission, backend)) invalid("unproved request");
  if (issued.has(p)) invalid("presentation already issued");
  if (!own(result, "success") || options.sourceMap || options.abi === "c") invalid("unqualified finalization");
  if (dts !== own(result, "dts")) invalid("DTS association");
  equal(resolveCompileTargetProfile(options), own(result, "targetProfile"), "target association");
  if (own(result, "exportSignatures") !== module.exportSignatures) invalid("export signature identity");
  const binary = own(result, "binary") as Uint8Array,
    original = bytes(binary);
  equalBytes(original, bytes(emitBinary(module)), "binary/final module association");
  const input: Input = {
    presentation: p,
    module,
    original,
    originalBuffer: binary,
    expected: original,
    buffer: binary,
    options,
    fields: semanticFields(result),
    consumed: false,
    observation: observation(level, "sync-pending", false, false),
  };
  current(result, input);
  issued.add(p);
  inputs.set(result, input);
}
function optimizerData(value: object): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid("optimizer result prototype");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !["binary", "optimized", "warning", "timedOut"].includes(key))
      invalid("optimizer result fields");
    if (key !== "binary") assertPreparedIrData(own(value, key));
    else own(value, key);
  }
  if (typeof own(value, "optimized") !== "boolean") invalid("optimizer verdict");
  if (
    Object.hasOwn(value, "warning") &&
    own(value, "warning") !== undefined &&
    typeof own(value, "warning") !== "string"
  )
    invalid("optimizer warning DATA");
  if (
    Object.hasOwn(value, "timedOut") &&
    own(value, "timedOut") !== undefined &&
    typeof own(value, "timedOut") !== "boolean"
  )
    invalid("optimizer timedOut DATA");
  if (Object.hasOwn(value, "timedOut") && own(value, "timedOut") === true && own(value, "optimized") === true)
    invalid("optimizer contradictory completion");
}
function optimizerFields(value: object): unknown {
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) if (key !== "binary") copy[key] = own(value, key);
  return freezePreparedIrValue(copy);
}
/** None means ordinary unrelated compilation; callers retain their byte-exact generic optimizer branch. */
export async function applyIssuedNativeNumberUndefinedOptimization(
  result: CompileResult,
  options: CompileOptions,
): Promise<CompileResult | undefined> {
  const input = inputs.get(result);
  if (!input) return undefined;
  if (input.consumed) invalid("input already consumed");
  current(result, input);
  const actualOptions = optionsData(options);
  equal(input.options, actualOptions, "async option association");
  input.consumed = true;
  const level = input.observation.level;
  input.observation = observation(level, "attempting", undefined, false);
  let optimized: Awaited<ReturnType<typeof optimizeBinaryAsync>>;
  try {
    optimized = await optimizeBinaryAsync(Uint8Array.from(input.original), {
      level,
      preserveNames: actualOptions.preserveDebugNames,
    });
  } catch (error) {
    input.observation = observation(level, "failed", undefined, false);
    current(result, input);
    equal(actualOptions, optionsData(options), "async caller options changed");
    throw error;
  }
  current(result, input);
  equal(actualOptions, optionsData(options), "async caller options changed");
  input.returnedOptimizerResult = optimized;
  let accepted = false,
    rejected = false,
    wasOptimized: boolean | undefined,
    candidateToAccept: Uint8Array | undefined,
    warning: string | undefined;
  try {
    const verdict = Object.getOwnPropertyDescriptor(optimized, "optimized");
    wasOptimized = verdict && "value" in verdict && typeof verdict.value === "boolean" ? verdict.value : undefined;
    optimizerData(optimized);
    const candidateBuffer = own(optimized, "binary") as Uint8Array,
      candidate = bytes(candidateBuffer);
    input.optimizer = {
      result: optimized,
      binary: candidateBuffer,
      bytes: Uint8Array.from(candidate),
      fields: optimizerFields(optimized),
    };
    if (optimized.optimized) {
      equal(
        inspectNativeNumberUndefinedBinary(input.original),
        inspectNativeNumberUndefinedBinary(candidate),
        "optimizer public boundary drift",
      );
      const fingerprint = result.runtimeRecGroupFingerprint;
      if (fingerprint && !verifyRuntimeRecGroupBinary(candidate, fingerprint).valid)
        invalid("optimizer canonical rec-group drift");
      candidateToAccept = candidate;
    } else equalBytes(input.original, candidate, "unavailable optimizer changed binary");
    warning = optimized.warning;
  } catch (error) {
    rejected = true;
    warning = `native Number/Undefined optimizer output rejected: ${error instanceof Error ? error.message : String(error)}; using the unoptimized module`;
  }
  current(result, input);
  equal(actualOptions, optionsData(options), "async caller options changed");
  if (!rejected && candidateToAccept) {
    result.binary = candidateToAccept;
    commitArtifactBinary(result, candidateToAccept);
    input.buffer = candidateToAccept;
    input.expected = Uint8Array.from(candidateToAccept);
    accepted = true;
  }
  if (!accepted && !warning)
    warning = "native Number/Undefined optimizer supplied no accepted output; using the unoptimized module";
  if (warning) {
    result.errors.push({ message: warning, line: 0, column: 0, severity: "warning" });
    commitArtifactDiagnostics(result);
  }
  input.fields = semanticFields(result);
  input.observation = observation(
    level,
    accepted ? "accepted" : rejected ? "rejected" : "unavailable",
    wasOptimized,
    accepted,
  );
  current(result, input);
  return result;
}
/** Read-only observation, never a capability accepted by another API. */
export function nativeNumberUndefinedOptimizationObservation(
  result: CompileResult,
): NativeNumberUndefinedOptimizationObservation | undefined {
  const input = inputs.get(result);
  if (!input) return undefined;
  current(result, input);
  return input.observation;
}
