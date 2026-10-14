// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { assertCompilerNativeNumberUndefinedFinalization } from "../compiler.js";
import type { CompileOptions, CompileResult } from "../index.js";
import type { WasmModule } from "../ir/types.js";
import type { IrProgramPresentationResult, PreparedIrPresentationArtifacts } from "./ir-program-presentation.js";
import { preparedPresentationNativeDts } from "./ir-program-presentation.js";
import { completedNativeNumberUndefinedPresentation } from "./ir-native-number-undefined-presentation.js";
import { readIrCompileRoute } from "./ir-cutover-invocation.js";
import {
  assertPreparedIrData,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../shared/contracts/prepared-ir-invariant-error.js";
import { emitBinary } from "../emit/binary.js";
import { verifyRuntimeRecGroupBinary } from "../emit/canonical-recgroup.js";
import { resolveCompileTargetProfile } from "../target-profile.js";
import { optimizeBinaryAsync } from "../optimize.js";
import { inspectNativeNumberUndefinedBinary } from "../wasm/physical/native-number-undefined-binary.js";

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
    input.buffer = candidateToAccept;
    input.expected = Uint8Array.from(candidateToAccept);
    accepted = true;
  }
  if (!accepted && !warning)
    warning = "native Number/Undefined optimizer supplied no accepted output; using the unoptimized module";
  if (warning) result.errors.push({ message: warning, line: 0, column: 0, severity: "warning" });
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
