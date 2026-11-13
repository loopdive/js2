// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { buildCompiledAdapterImports, type BuildImportsOptions } from "../runtime.js";
import { requiredPreparedFinalArtifactObservation } from "./test262-prepared-entry.js";
import type { CompileResult } from "../index.js";

// Capture the actual engine seam once. No caller can supply constructors,
// adapters, emission observations or a replacement instance to this transaction.
const EngineModule = WebAssembly.Module;
const EngineInstance = WebAssembly.Instance;
const engineImportDeclarations = WebAssembly.Module.imports.bind(WebAssembly.Module);

type AdapterImports = WebAssembly.Imports;
type FinalArtifact = NonNullable<ReturnType<typeof requiredPreparedFinalArtifactObservation>>;
interface ImportOperand {
  readonly namespace: string;
  readonly name: string;
  readonly container: object;
  readonly containerPrototype: object | null;
  readonly namespaceDescriptor: PropertyDescriptor;
  readonly valueDescriptor: PropertyDescriptor;
}
export interface PreparedTest262Execution {
  readonly instance: WebAssembly.Instance;
  readonly imports: AdapterImports;
}
interface ExecutionRecord {
  readonly result: CompileResult;
  readonly artifact: FinalArtifact;
  readonly engineBytes: Uint8Array;
  readonly originalBinary: Uint8Array;
  readonly imports: AdapterImports;
  readonly importsPrototype: object | null;
  readonly operands: readonly ImportOperand[];
  readonly instance: WebAssembly.Instance;
}

const executions = new WeakMap<object, ExecutionRecord>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

function ownData(object: object, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`Prepared execution requires an own DATA import operand: ${key}`);
  }
  return descriptor;
}

function sameDescriptor(left: PropertyDescriptor, right: PropertyDescriptor | undefined): boolean {
  return (
    right !== undefined &&
    "value" in right &&
    left.value === right.value &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

function captureImports(module: WebAssembly.Module, imports: AdapterImports): readonly ImportOperand[] {
  return Object.freeze(
    engineImportDeclarations(module).map(({ module: namespace, name }) => {
      const namespaceDescriptor = ownData(imports, namespace);
      const container = namespaceDescriptor.value;
      if ((typeof container !== "object" && typeof container !== "function") || container === null) {
        throw new Error(`Prepared execution has no import namespace: ${namespace}`);
      }
      return Object.freeze({
        namespace,
        name,
        container,
        containerPrototype: Object.getPrototypeOf(container),
        namespaceDescriptor,
        valueDescriptor: ownData(container, name),
      });
    }),
  );
}

/** Expose only the actual engine namespaces, never the binder's lifecycle setters. */
function engineImportsOnly(
  module: WebAssembly.Module,
  adapter: ReturnType<typeof buildCompiledAdapterImports>,
): AdapterImports {
  const imports: WebAssembly.Imports = Object.create(null);
  for (const { module: namespace, name } of engineImportDeclarations(module)) {
    const container = ownData(adapter, namespace).value;
    if ((typeof container !== "object" && typeof container !== "function") || container === null) {
      throw new Error(`Prepared execution has no import namespace: ${namespace}`);
    }
    if (!Object.hasOwn(imports, namespace)) imports[namespace] = Object.create(null);
    Object.defineProperty(imports[namespace], name, ownData(container, name));
  }
  for (const namespace of Object.values(imports)) Object.freeze(namespace);
  return Object.freeze(imports);
}

function refuseDynamicDescendants(module: WebAssembly.Module): void {
  for (const { module: namespace, name } of engineImportDeclarations(module)) {
    if (
      namespace === "js2wasm:runtime-eval" ||
      namespace === "js2wasm:qjs" ||
      (namespace === "env" && ["__extern_eval", "__extern_direct_eval", "__extern_new_function"].includes(name))
    ) {
      throw new Error(`Prepared dynamic-code demand has no genuine recursive IR route: ${namespace}.${name}`);
    }
  }
}

function importsCurrent(record: ExecutionRecord): boolean {
  if (Object.getPrototypeOf(record.imports) !== record.importsPrototype) return false;
  return record.operands.every(
    (operand) =>
      sameDescriptor(operand.namespaceDescriptor, Object.getOwnPropertyDescriptor(record.imports, operand.namespace)) &&
      Object.getPrototypeOf(operand.container) === operand.containerPrototype &&
      sameDescriptor(operand.valueDescriptor, Object.getOwnPropertyDescriptor(operand.container, operand.name)),
  );
}

/**
 * Construct from the same authenticated final artifact that owns the complete
 * prepared graph. A compile refusal, cloned result, stale binary, fabricated
 * report or legacy module cannot enter this constructor.
 *
 * A failed constructor propagates its original error. It does not mint an
 * execution object or turn an unsupported compile into a runtime-negative pass.
 */
export function instantiatePreparedArtifact(
  result: CompileResult,
  deps?: Record<string, unknown>,
  options: BuildImportsOptions = {},
): PreparedTest262Execution {
  const artifact = requiredPreparedFinalArtifactObservation(result);
  if (!artifact) throw new Error("Prepared execution requires the current genuine final compiler artifact");
  const engineBytes = artifact.binary.slice();
  const module = new EngineModule(engineBytes);
  // Refuse the demand before binding a provider. A synthetic EvalError thrown
  // during a test could otherwise incorrectly satisfy a runtime-negative case.
  refuseDynamicDescendants(module);
  const adapter = buildCompiledAdapterImports(artifact.adapterManifest, deps, { ...options, dynamicCode: "deny" });
  // Adapter construction may execute caller hooks. Authenticate again before
  // supplying any bytes to the engine, preserving their exact association.
  const current = requiredPreparedFinalArtifactObservation(result);
  if (!current || current.base !== artifact.base || !sameBytes(current.binary, engineBytes)) {
    throw new Error("Prepared artifact changed while constructing its runtime imports");
  }
  const imports = engineImportsOnly(module, adapter);
  const operands = captureImports(module, imports);
  const importsPrototype = Object.getPrototypeOf(imports);
  const instance = new EngineInstance(module, imports);
  // Retain the genuine lifecycle binder privately. Returning it would let a
  // caller rebind import closures to a foreign instance without changing any
  // engine import descriptor.
  adapter.setInstance?.(instance);
  const record: ExecutionRecord = {
    result,
    artifact,
    engineBytes,
    originalBinary: result.binary,
    imports,
    importsPrototype,
    operands,
    instance,
  };
  if (!importsCurrent(record)) throw new Error("Prepared engine import operands changed during construction");
  const final = requiredPreparedFinalArtifactObservation(result);
  if (!final || final.base !== artifact.base || !sameBytes(final.binary, engineBytes)) {
    throw new Error("Prepared final artifact changed during engine construction");
  }
  const execution = Object.freeze({ instance, imports });
  executions.set(execution, record);
  return execution;
}

/** Read-only same-process observation; serialized/cloned packets carry no authority. */
export function preparedRuntimeExecutionObservation(execution: unknown, binary?: Uint8Array, imports?: AdapterImports) {
  if (execution === null || typeof execution !== "object") return undefined;
  const record = executions.get(execution);
  if (!record) return undefined;
  // Reject foreign operands by identity before reading any caller getters.
  if (binary !== undefined && binary !== record.originalBinary) return undefined;
  if (imports !== undefined && imports !== record.imports) return undefined;
  if (!importsCurrent(record)) return undefined;
  const current = requiredPreparedFinalArtifactObservation(record.result);
  if (!current || current.base !== record.artifact.base || !sameBytes(current.binary, record.engineBytes)) {
    return undefined;
  }
  if (binary !== undefined && !sameBytes(record.originalBinary, record.engineBytes)) {
    return undefined;
  }
  return Object.freeze({
    base: record.artifact.base,
    actualRuntimeContext: "GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE" as const,
    actualBinary: binary === undefined ? "NOT_CHECKED" : ("MATCHED_ACTUAL_ENGINE_OPERAND" as const),
    actualImports: imports === undefined ? "NOT_CHECKED" : ("MATCHED_ACTUAL_ENGINE_OPERAND" as const),
  });
}
