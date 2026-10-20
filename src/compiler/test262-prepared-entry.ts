// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import * as legacy from "../index.js";
import type { CompileError, CompileOptions, CompileResult } from "../index.js";
import { analyzeMultiSource } from "../checker/index.js";
import { normalizeMultiFileName } from "../checker/multi-file-paths.js";
import { runPreparedIrPipelinePresentation, preparedFrontendRejectionObservation } from "../compiler.js";
import type { PreparedIrPipelinePresentationResult } from "./ir-program-presentation.js";
import type { JavaScriptAdapterManifestV1 } from "../adapter-manifest.js";
import { emittedPhysicalSetupPlan } from "../ir/program-consumer.js";
import { freezePreparedIrValue } from "../ir/program.js";
import { failResult } from "./output.js";
import { resolveCompileTargetProfile } from "../target-profile.js";

export interface RequiredPreparedRequest {
  readonly kind: "prepared-program-required";
  readonly version: 1;
}
export interface Test262CompileOptions extends CompileOptions {
  readonly wholeProgram?: RequiredPreparedRequest;
  readonly backend?: "wasmgc" | "linear";
}
export interface RequiredPreparedEmissionObservation {
  readonly schema: "test262-required-prepared-emission-v1";
  readonly backend: "wasmgc" | "linear";
  readonly target: "host" | "standalone" | "wasi";
  readonly requestedTarget: "gc" | "linear" | "standalone" | "wasi";
  readonly units: {
    readonly sources: readonly { readonly id: string; readonly file: string }[];
    readonly original: readonly string[];
    readonly emitted: readonly string[];
    readonly physical: readonly string[];
    readonly abi: readonly string[];
  };
}
export interface RequiredPreparedFrontendFailure {
  readonly schema: "test262-required-prepared-frontend-failure-v1";
  readonly phase: "syntax" | "early";
  readonly backend: "wasmgc" | "linear";
  readonly target: "gc" | "linear" | "standalone" | "wasi";
  readonly diagnostics: readonly CompileError[];
  readonly sources: readonly { readonly file: string; readonly text: string }[];
}
type PipelineFailure =
  | Exclude<PreparedIrPipelinePresentationResult, { kind: "artifacts" }>
  | { readonly kind: "adapter-unsupported"; readonly detail: string };
type UnsupportedFailure = Extract<PipelineFailure, { kind: "unsupported" }>;
/** Detached diagnostic DATA, never a raw output artifact or opaque thrown cause. */
export type RequiredPreparedFailure =
  | { readonly kind: "output-failed"; readonly errors: readonly CompileError[] }
  | {
      readonly kind: "unsupported";
      readonly phase: UnsupportedFailure["phase"];
      readonly failure: Omit<UnsupportedFailure["failure"], "cause">;
    }
  | Extract<PipelineFailure, { kind: "presentation-unsupported" | "adapter-unsupported" }>;

function invalidRequest(detail: string): never {
  throw new TypeError(`test262 prepared entry: ${detail}`);
}
function ownData(value: object, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidRequest(`own DATA field required: ${String(key)}`);
  return descriptor;
}
/** This check runs before any options merge, spread, getter or legacy delegate. */
function selected(options: Test262CompileOptions | undefined): boolean {
  if (options === undefined) return false;
  if (options === null || typeof options !== "object") invalidRequest("options must be an object");
  const descriptor = Object.getOwnPropertyDescriptor(options, "wholeProgram");
  if (!descriptor) {
    if (Reflect.has(options, "wholeProgram")) invalidRequest("inherited wholeProgram request");
    return false;
  }
  if (!Object.hasOwn(descriptor, "value")) invalidRequest("wholeProgram accessor");
  const request: unknown = descriptor.value;
  if (request === null || typeof request !== "object") invalidRequest("malformed wholeProgram request");
  if (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)
    invalidRequest("request must be a plain DATA record");
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("version"))
    invalidRequest("closed request fields required");
  if (ownData(request, "kind").value !== "prepared-program-required" || ownData(request, "version").value !== 1)
    invalidRequest("unsupported wholeProgram request");
  return true;
}
/** Selected options are DATA-only; the omitted route retains the public API. */
function strictOptions(defaults?: Test262CompileOptions, options?: Test262CompileOptions): Test262CompileOptions {
  const copy: Record<string, unknown> = Object.create(null);
  for (const input of [defaults, options]) {
    if (input === undefined) continue;
    const wasSelected = selected(input);
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      invalidRequest("selected options require a plain DATA record");
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = ownData(input, key);
      if (key === "wholeProgram") continue;
      if (typeof key !== "string") invalidRequest("symbol option");
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (selected(input) !== wasSelected) invalidRequest("request changed during option capture");
  }
  // These are explicit strict-wrapper defaults, never a waiver for true.
  if (copy.sourceMap === undefined) copy.sourceMap = false;
  if (copy.optimize === undefined) copy.optimize = false;
  return freezePreparedIrValue(copy) as Test262CompileOptions;
}
function sourceGraph(files: Record<string, string>, entryFile: string): Record<string, string> {
  if (files === null || typeof files !== "object" || typeof entryFile !== "string")
    invalidRequest("invalid source graph");
  if (Object.getPrototypeOf(files) !== Object.prototype && Object.getPrototypeOf(files) !== null)
    invalidRequest("source graph requires a plain DATA record");
  const copy: Record<string, string> = Object.create(null);
  const names = new Set<string>();
  for (const key of Reflect.ownKeys(files)) {
    if (typeof key !== "string") invalidRequest("symbol source name");
    const value: unknown = ownData(files, key).value;
    if (typeof value !== "string") invalidRequest(`source must be a string: ${key}`);
    const normalized = normalizeMultiFileName(key);
    if (names.has(normalized)) invalidRequest("duplicate normalized source name");
    names.add(normalized);
    Object.defineProperty(copy, key, { value, enumerable: true });
  }
  if (!names.has(normalizeMultiFileName(entryFile))) invalidRequest("entry absent from source graph");
  return copy;
}

/** The frontend must retain EVERY supplied root, including unreachable fixtures. */
function completeAnalyzedGraph(
  files: Record<string, string>,
  entryFile: string,
  ast: ReturnType<typeof analyzeMultiSource>,
): boolean {
  const expected = new Map(Object.entries(files).map(([file, text]) => [normalizeMultiFileName(file), text]));
  if (
    ast.sourceFiles.length !== expected.size ||
    !ast.entryFile ||
    !ast.sourceFiles.includes(ast.entryFile) ||
    normalizeMultiFileName(ast.entryFile.fileName) !== normalizeMultiFileName(entryFile)
  )
    return false;
  for (const source of ast.sourceFiles) {
    const file = normalizeMultiFileName(source.fileName);
    if (!expected.has(file) || expected.get(file) !== source.text) return false;
    expected.delete(file);
  }
  return expected.size === 0;
}

interface DataRow {
  readonly object: object;
  readonly prototype: object | null;
  readonly extensible: boolean;
  readonly fields: readonly (readonly [PropertyKey, PropertyDescriptor])[];
  readonly bytes?: Uint8Array;
  readonly buffer?: ArrayBufferLike;
  readonly byteOffset?: number;
  readonly indexFlags?: Uint8Array;
}
/** Result metadata only, never frontend/Program/provider certification. */
function observeResult(value: object): readonly DataRow[] {
  const rows: DataRow[] = [];
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") {
      if (typeof item === "function" || typeof item === "symbol") invalidRequest("non-DATA result metadata");
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (item instanceof Uint8Array) {
      if (prototype !== Uint8Array.prototype) invalidRequest("unsupported binary prototype");
      const bytes = new Uint8Array(item);
      const fields: (readonly [PropertyKey, PropertyDescriptor])[] = [];
      const indexFlags = new Uint8Array(bytes.length);
      let index = 0;
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = ownData(item, key);
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
          if (Number(key) !== index || index >= bytes.length || !Object.is(descriptor.value, bytes[index]))
            invalidRequest("binary index population differs");
          indexFlags[index++] = descriptorFlags(descriptor);
        } else fields.push([key, descriptor]);
      }
      if (index !== bytes.length) invalidRequest("binary index population incomplete");
      rows.push({
        object: item,
        prototype,
        extensible: Object.isExtensible(item),
        fields,
        bytes,
        buffer: item.buffer,
        byteOffset: item.byteOffset,
        indexFlags,
      });
      return;
    }
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      invalidRequest("unsupported result metadata prototype");
    const fields = Reflect.ownKeys(item).map((key) => [key, ownData(item, key)] as const);
    rows.push({ object: item, prototype, extensible: Object.isExtensible(item), fields });
    for (const [, descriptor] of fields) visit(descriptor.value);
  };
  visit(value);
  return rows;
}
function descriptorFlags(descriptor: PropertyDescriptor): number {
  return (
    (descriptor.writable === true ? 1 : 0) |
    (descriptor.enumerable === true ? 2 : 0) |
    (descriptor.configurable === true ? 4 : 0)
  );
}
function unchanged(rows: readonly DataRow[]): boolean {
  for (const row of rows) {
    if (Object.getPrototypeOf(row.object) !== row.prototype || Object.isExtensible(row.object) !== row.extensible)
      return false;
    const keys: PropertyKey[] = [];
    let index = 0;
    for (const key of Reflect.ownKeys(row.object)) {
      if (row.bytes && typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(row.object, key);
        if (
          Number(key) !== index ||
          index >= row.bytes.length ||
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !Object.is(descriptor.value, row.bytes[index]) ||
          descriptorFlags(descriptor) !== row.indexFlags![index]
        )
          return false;
        index++;
      } else keys.push(key);
    }
    if ((row.bytes && index !== row.bytes.length) || keys.length !== row.fields.length) return false;
    for (let index = 0; index < keys.length; index++) {
      const [key, previous] = row.fields[index]!;
      if (keys[index] !== key) return false;
      const current = Object.getOwnPropertyDescriptor(row.object, key);
      if (
        !current ||
        !Object.hasOwn(current, "value") ||
        !Object.is(current.value, previous.value) ||
        current.enumerable !== previous.enumerable ||
        current.configurable !== previous.configurable ||
        current.writable !== previous.writable
      )
        return false;
    }
    if (row.bytes) {
      const bytes = row.object as Uint8Array;
      if (bytes.buffer !== row.buffer || bytes.byteOffset !== row.byteOffset || bytes.length !== row.bytes.length)
        return false;
      for (let index = 0; index < row.bytes.length; index++) if (bytes[index] !== row.bytes[index]) return false;
    }
  }
  return true;
}

type Artifacts = Extract<PreparedIrPipelinePresentationResult, { kind: "artifacts" }>;
interface ResultRecord {
  readonly rows: readonly DataRow[];
  readonly outcome?: RequiredPreparedFailure;
  readonly frontendFailure?: RequiredPreparedFrontendFailure;
  readonly emission?: Artifacts["emission"];
  readonly base?: RequiredPreparedEmissionObservation;
  readonly binary?: Uint8Array;
  readonly adapterManifest?: JavaScriptAdapterManifestV1;
  readonly hostImportInventory?: NonNullable<CompileResult["hostImportInventory"]>;
}
const results = new WeakMap<CompileResult, ResultRecord>();
function current(result: CompileResult): ResultRecord | undefined {
  const record = results.get(result);
  if (!record) return undefined;
  try {
    if (!unchanged(record.rows)) throw new Error("result changed");
    if (record.emission) emittedPhysicalSetupPlan(record.emission);
    return record;
  } catch {
    results.delete(result); // Restoring changed result fields cannot reissue evidence.
    return undefined;
  }
}
/** Compiler emission observation only; never an execution or native-target receipt. */
export function requiredPreparedEmission(result: CompileResult): RequiredPreparedEmissionObservation | undefined {
  return current(result)?.base;
}
/** No registration API: only this adapter's genuine finalized result can report. */
export function requiredPreparedFinalArtifactObservation(result: CompileResult):
  | {
      readonly base: RequiredPreparedEmissionObservation;
      readonly binary: Uint8Array;
      readonly adapterManifest: JavaScriptAdapterManifestV1;
      readonly hostImportInventory: NonNullable<CompileResult["hostImportInventory"]>;
    }
  | undefined {
  const record = current(result);
  if (!record?.base || !record.binary || !record.adapterManifest || !record.hostImportInventory) return undefined;
  return Object.freeze({
    base: record.base,
    binary: new Uint8Array(record.binary),
    adapterManifest: record.adapterManifest,
    hostImportInventory: record.hostImportInventory,
  });
}
/** Located refusal stays separate from frontend diagnostics and execution proof. */
export function requiredPreparedFailure(result: CompileResult): RequiredPreparedFailure | undefined {
  return current(result)?.outcome;
}
/** Only the shared compiler's real syntax/early branch can supply this observation. */
export function requiredPreparedFrontendFailure(result: CompileResult): RequiredPreparedFrontendFailure | undefined {
  return current(result)?.frontendFailure;
}
function detachedFailure(outcome: PipelineFailure): RequiredPreparedFailure {
  if (outcome.kind === "output-failed")
    return freezePreparedIrValue({ kind: outcome.kind, errors: outcome.errors }) as RequiredPreparedFailure;
  if (outcome.kind === "unsupported") {
    const diagnostic: Record<string, unknown> = Object.create(null);
    // Opaque exceptions remain internal; located diagnostic DATA is preserved.
    for (const key of Reflect.ownKeys(outcome.failure)) {
      if (key === "cause") continue;
      if (typeof key !== "string") invalidRequest("symbol refusal field");
      Object.defineProperty(diagnostic, key, { value: ownData(outcome.failure, key).value, enumerable: true });
    }
    return freezePreparedIrValue({
      kind: outcome.kind,
      phase: outcome.phase,
      failure: diagnostic,
    }) as RequiredPreparedFailure;
  }
  return freezePreparedIrValue(outcome) as RequiredPreparedFailure;
}
function failed(
  outcome: PipelineFailure,
  errors: CompileError[],
  frontendFailure?: RequiredPreparedFrontendFailure,
): CompileResult {
  const result = outcome.kind === "output-failed" ? outcome.artifacts : failResult(errors);
  const diagnostic = detachedFailure(outcome);
  results.set(result, { rows: observeResult(result), outcome: diagnostic, frontendFailure });
  return result;
}
function present(
  files: Record<string, string>,
  entryFile: string,
  options: Test262CompileOptions,
  singleSource = false,
): CompileResult {
  const exactFiles = sourceGraph(files, entryFile);
  const profile = resolveCompileTargetProfile(options);
  if (options.backend !== undefined && options.backend !== profile.backend)
    return failed({ kind: "adapter-unsupported", detail: "explicit backend contradicts resolved target" }, [
      {
        severity: "error",
        code: "prepared-backend-target-mismatch",
        message: "explicit backend contradicts resolved target",
        file: entryFile,
        line: 1,
        column: 1,
      },
    ]);
  if (options.runtimeEvalProvider === false)
    return failed(
      { kind: "adapter-unsupported", detail: "strict compilation cannot disable demanded runtime eval providers" },
      [
        {
          severity: "error",
          code: "prepared-runtime-eval-option-unsupported",
          message: "runtimeEvalProvider:false cannot certify a strict prepared compile",
          file: entryFile,
          line: 1,
          column: 1,
        },
      ],
    );
  if (options.define !== undefined)
    return failed(
      { kind: "adapter-unsupported", detail: "strict compilation does not rewrite source with define substitutions" },
      [
        {
          severity: "error",
          code: "prepared-input-transform-unsupported",
          message: "strict compilation preserves exact source text",
          file: entryFile,
          line: 1,
          column: 1,
        },
      ],
    );
  const ast = analyzeMultiSource(exactFiles, entryFile, undefined, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  if (!completeAnalyzedGraph(exactFiles, entryFile, ast))
    return failed(
      { kind: "adapter-unsupported", detail: "frontend did not retain the complete supplied name/text graph" },
      [
        {
          severity: "error",
          code: "prepared-source-graph-incomplete",
          message: "frontend did not retain the complete supplied name/text graph",
          file: entryFile,
          line: 1,
          column: 1,
        },
      ],
    );
  // The public single-source compiler always applies its parser-syntax gate,
  // including allowJs. Multi-source calls retain their captured option policy.
  const pipelineOptions = singleSource
    ? (freezePreparedIrValue({ ...options, strictJsSyntax: true }) as Test262CompileOptions)
    : options;
  const errors: CompileError[] = [];
  const outcome = runPreparedIrPipelinePresentation({
    userSourceFiles: ast.sourceFiles,
    entryAst: {
      sourceFile: ast.entryFile,
      checker: ast.checker,
      program: ast.program,
      diagnostics: ast.diagnostics,
      syntacticDiagnostics: ast.syntacticDiagnostics,
    },
    multiAst: ast,
    errors,
    codegenOptions: { link: options.link ?? [], sourceMap: options.sourceMap === true },
    sourcesContent: new Map(ast.sourceFiles.map((source) => [source.fileName, source.text])),
    diagnosticAnchor: ast.entryFile,
    runEarlyErrorsOnAllowJs: singleSource || options.enforceJsEarlyErrors === true,
    options: pipelineOptions,
  });
  if (outcome.kind === "output-failed") {
    // Query immediately for this call's actual outcome. No duplicate early-error
    // detection, text/name inference, registration API or decoded certificate.
    const observed = preparedFrontendRejectionObservation(outcome);
    const frontendFailure = observed
      ? (freezePreparedIrValue({
          schema: "test262-required-prepared-frontend-failure-v1",
          phase: observed.phase,
          backend: profile.backend,
          target: profile.target,
          diagnostics: observed.diagnostics,
          sources: ast.sourceFiles.map((source) => ({ file: source.fileName, text: source.text })),
        }) as RequiredPreparedFrontendFailure)
      : undefined;
    return failed(outcome, outcome.errors, frontendFailure);
  }
  if (outcome.kind === "unsupported") {
    const failure = outcome.failure;
    return failed(outcome, [
      ...errors,
      {
        severity: "error",
        code: failure.code,
        message: failure.detail,
        file: failure.sourceFile,
        line: failure.location.line,
        column: failure.location.column,
      },
    ]);
  }
  if (outcome.kind === "presentation-unsupported")
    return failed(outcome, [
      ...errors,
      ...outcome.gaps.map(
        (gap): CompileError => ({
          severity: "error",
          code: gap.code,
          message: gap.detail,
          file: gap.sourceFile ?? ast.entryFile.fileName,
          line: 1,
          column: 1,
        }),
      ),
    ]);
  const result: CompileResult = outcome.artifacts;
  if (!result.success || !result.adapterManifest || !result.targetProfile || !result.hostImportInventory)
    throw new Error("prepared artifacts lack finalized adapter/target metadata");
  const plan = emittedPhysicalSetupPlan(outcome.emission);
  const requestedTarget = options.target ?? "gc";
  const preparedTarget = requestedTarget === "gc" || requestedTarget === "linear" ? "host" : requestedTarget;
  if (
    plan.target !== preparedTarget ||
    plan.backend !== profile.backend ||
    plan.backend !== result.targetProfile.backend ||
    result.targetProfile.target !== requestedTarget
  )
    throw new Error("prepared final target association differs");
  const base: RequiredPreparedEmissionObservation = freezePreparedIrValue({
    schema: "test262-required-prepared-emission-v1",
    backend: plan.backend,
    target: plan.target,
    requestedTarget,
    units: {
      sources: outcome.program.inventory.sources.map((source) => ({ id: source.id, file: source.originalFileName })),
      original: outcome.program.inventory.terminalUnits.map((unit) => unit.id),
      emitted: [...outcome.emission.emittedUnitIds],
      physical: plan.functions.map((fn) => fn.unitId),
      abi: outcome.program.abi.entries.map((entry) => entry.plan.id),
    },
  }) as RequiredPreparedEmissionObservation;
  results.set(result, {
    rows: observeResult(result),
    emission: outcome.emission,
    base,
    binary: new Uint8Array(result.binary),
    adapterManifest: freezePreparedIrValue(result.adapterManifest) as JavaScriptAdapterManifestV1,
    hostImportInventory: freezePreparedIrValue(result.hostImportInventory) as NonNullable<
      CompileResult["hostImportInventory"]
    >,
  });
  return result;
}

export async function compile(source: string, options?: Test262CompileOptions): Promise<CompileResult> {
  if (!selected(options)) return legacy.compile(source, options);
  const captured = strictOptions(undefined, options);
  if (captured.fileName !== undefined && typeof captured.fileName !== "string")
    invalidRequest("fileName must be a string");
  return present({ [captured.fileName ?? "input.ts"]: source }, captured.fileName ?? "input.ts", captured, true);
}
export async function compileMulti(
  files: Record<string, string>,
  entryFile: string,
  options?: Test262CompileOptions,
): Promise<CompileResult> {
  if (!selected(options)) return legacy.compileMulti(files, entryFile, options);
  return present(files, entryFile, strictOptions(undefined, options));
}
/** Strict calls reanalyze the complete graph; no stale per-unit preparation is reused. */
export function createIncrementalCompiler(defaultOptions?: Test262CompileOptions): {
  compile(source: string, options?: Test262CompileOptions): Promise<CompileResult>;
  compileMulti(
    files: Record<string, string>,
    entryFile: string,
    options?: Test262CompileOptions,
  ): Promise<CompileResult>;
  dispose(): void;
} {
  const strictDefault = selected(defaultOptions);
  const strictDefaults = strictDefault ? strictOptions(undefined, defaultOptions) : undefined;
  let delegate = strictDefault ? undefined : legacy.createIncrementalCompiler(defaultOptions);
  let disposed = false;
  const legacyCompiler = () => (delegate ??= legacy.createIncrementalCompiler(defaultOptions));
  return {
    async compile(source, options) {
      if (disposed) throw new Error("test262 prepared compiler is disposed");
      const strict = strictDefault || selected(options);
      if (!strict) return legacyCompiler().compile(source, options);
      const captured = strictOptions(strictDefault ? strictDefaults : defaultOptions, options);
      if (captured.fileName !== undefined && typeof captured.fileName !== "string")
        invalidRequest("fileName must be a string");
      return present({ [captured.fileName ?? "input.ts"]: source }, captured.fileName ?? "input.ts", captured, true);
    },
    async compileMulti(files, entryFile, options) {
      if (disposed) throw new Error("test262 prepared compiler is disposed");
      const strict = strictDefault || selected(options);
      if (!strict) return legacyCompiler().compileMulti(files, entryFile, options);
      return present(files, entryFile, strictOptions(strictDefault ? strictDefaults : defaultOptions, options));
    },
    dispose() {
      disposed = true;
      delegate?.dispose();
    },
  };
}
